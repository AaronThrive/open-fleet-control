/**
 * ntfy ingest poller for Open Fleet Control.
 *
 * Pulls messages from an ntfy topic in JSON-stream poll mode
 * (`<server>/<topic>/json?poll=1&since=<sec>`), where each response line is a
 * standalone JSON object. Only `event === "message"` lines are real alerts
 * (ntfy also emits `open`/`keepalive`/`poll_request` control lines).
 *
 * Each new message is deduped by ntfy message `id`, normalized into the same
 * alert-record shape the rest of the fleet uses (mirrors src/alerts.js — see
 * the `{id,type,severity,...}` contract there), and handed to `onAlert`
 * oldest-first. The last-seen time and a window of recent ids are persisted to
 * `stateFile` so a restart never replays already-delivered messages.
 *
 * No credentials are stored: an ntfy topic's access control IS the topic name,
 * so it is treated like a secret and never logged. The poll loop never throws —
 * transient fetch/parse failures are logged and the next interval retries.
 *
 * Mirrors the poller lifecycle of src/mesh.js: module-scope timer, immediate
 * first poll, setInterval(...).unref(), and a stop() that clears the timer.
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_INTERVAL_MS = 30000;
// How many recent ntfy ids to retain for dedupe across restarts. ntfy `since`
// already bounds replay to the last-seen second; this guards the same-second
// boundary (multiple messages sharing lastSeenMs) without unbounded growth.
const RECENT_ID_LIMIT = 500;
// ntfy priority (1-5) → fleet severity. 1-2 = low/min, 3 = default → info;
// 4 = high → warn; 5 = max/urgent → critical. Anything unknown → info.
const PRIORITY_SEVERITY = { 1: "info", 2: "info", 3: "info", 4: "warn", 5: "critical" };

/** Map an ntfy priority (1-5, default 3) to a fleet severity. */
function severityForPriority(priority) {
  const p = Number.isInteger(priority) ? priority : 3;
  return PRIORITY_SEVERITY[p] || "info";
}

/**
 * Normalize one ntfy `event === "message"` object into a fleet alert record.
 * ntfy `time` is epoch SECONDS; the record `ts` is epoch MS.
 *
 * The record `type` is always the constant "ntfy" (the alert origin), NOT the
 * message title — a title like "Daily VPS" is a human label, not an alert type,
 * so it is surfaced as the `task` instead (and kept verbatim on `title`).
 *
 * @param {object} msg - parsed ntfy message line
 * @returns {{source: "ntfy", id: string, type: "ntfy", severity: string,
 *            title: string|null, message: string, ts: number,
 *            node: null, task: string|null}}
 */
function normalizeMessage(msg) {
  const title = typeof msg.title === "string" && msg.title.length > 0 ? msg.title : null;
  const timeSec = Number.isFinite(msg.time) ? msg.time : null;
  return {
    source: "ntfy",
    id: String(msg.id),
    type: "ntfy",
    severity: severityForPriority(msg.priority),
    title,
    message: typeof msg.message === "string" ? msg.message : "",
    ts: timeSec !== null ? timeSec * 1000 : Date.now(),
    node: null,
    task: title,
  };
}

/**
 * Create an ntfy ingest poller.
 *
 * @param {object} options
 * @param {string} options.server - ntfy base URL (e.g. https://ntfy.sh)
 * @param {string} options.topic - topic name (treated as a secret; never logged)
 * @param {number} [options.intervalMs=30000] - poll interval
 * @param {string} options.stateFile - JSON file for lastSeen + recent ids
 * @param {function} options.onAlert - called with each new alert record (oldest-first)
 * @param {function} [options.fetchImpl] - fetch override for tests (default global fetch)
 * @returns {{start: function, stop: function, getState: function}}
 */
function createNtfyIngest(options = {}) {
  const {
    server,
    topic,
    intervalMs = DEFAULT_INTERVAL_MS,
    stateFile,
    onAlert,
    fetchImpl = (...args) => globalThis.fetch(...args),
  } = options;

  if (!server || typeof server !== "string") {
    throw new Error("createNtfyIngest requires a server string");
  }
  if (!topic || typeof topic !== "string") {
    throw new Error("createNtfyIngest requires a topic string");
  }
  if (!stateFile || typeof stateFile !== "string") {
    throw new Error("createNtfyIngest requires a stateFile string");
  }
  if (typeof onAlert !== "function") {
    throw new Error("createNtfyIngest requires an onAlert function");
  }

  const baseUrl = server.replace(/\/+$/, "");
  // Persisted state, loaded once on start(): lastSeen second + recent id ring.
  let lastSeenMs = 0;
  let recentIds = []; // newest-last; trimmed to RECENT_ID_LIMIT
  let recentIdSet = new Set();
  // Runtime status (getState)
  let running = false;
  let lastPollAt = null;
  let lastError = null;
  let pollTimer = null;

  /** Load persisted state; a missing/corrupt file is a clean start (no throw). */
  function loadState() {
    try {
      const raw = fs.readFileSync(stateFile, "utf8");
      const data = JSON.parse(raw);
      lastSeenMs = Number.isFinite(data.lastSeenMs) ? data.lastSeenMs : 0;
      recentIds = Array.isArray(data.recentIds)
        ? data.recentIds.filter((id) => typeof id === "string").slice(-RECENT_ID_LIMIT)
        : [];
      recentIdSet = new Set(recentIds);
    } catch (e) {
      lastSeenMs = 0;
      recentIds = [];
      recentIdSet = new Set();
    }
  }

  /** Persist state atomically (temp + rename); failures are logged, not thrown. */
  function saveState() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const body = JSON.stringify({ lastSeenMs, recentIds });
      const tmp = `${stateFile}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, stateFile);
    } catch (e) {
      console.error("[NtfyIngest] Failed to persist state:", e.message);
    }
  }

  /** Record an id as seen, trimming the ring to RECENT_ID_LIMIT. */
  function rememberId(id) {
    recentIds = [...recentIds, id].slice(-RECENT_ID_LIMIT);
    recentIdSet = new Set(recentIds);
  }

  /**
   * Parse a JSON-stream body into message records, skipping blank lines,
   * non-message events, and any line that fails to parse.
   */
  function parseMessages(text) {
    const out = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch (e) {
        continue;
      }
      if (msg && msg.event === "message" && msg.id !== undefined) {
        out.push(msg);
      }
    }
    return out;
  }

  /**
   * One poll: fetch the topic since the last-seen second, normalize new
   * messages, and dispatch them oldest-first. Never throws.
   * Exposed for testing (matches the repo's _pollOnce convention).
   */
  async function _pollOnce() {
    lastPollAt = Date.now();
    try {
      const sinceSec = lastSeenMs > 0 ? Math.floor(lastSeenMs / 1000) : 0;
      const url =
        `${baseUrl}/${encodeURIComponent(topic)}/json?poll=1&since=${sinceSec}`;
      const res = await fetchImpl(url);
      if (!res || res.ok !== true) {
        lastError = res ? `HTTP ${res.status}` : "no response";
        return;
      }

      const text = await res.text();
      // Oldest-first: ntfy streams chronologically; sort by time as a guard.
      const messages = parseMessages(text).sort(
        (a, b) => (a.time || 0) - (b.time || 0),
      );

      let changed = false;
      for (const msg of messages) {
        const id = String(msg.id);
        if (recentIdSet.has(id)) continue; // already delivered
        const record = normalizeMessage(msg);
        if (record.ts > lastSeenMs) lastSeenMs = record.ts;
        rememberId(id);
        changed = true;
        try {
          onAlert(record);
        } catch (e) {
          console.error("[NtfyIngest] onAlert callback failed:", e.message);
        }
      }

      lastError = null;
      if (changed) saveState();
    } catch (e) {
      // Transient fetch/parse failure — log and let the next interval retry.
      lastError = e.message;
      console.error("[NtfyIngest] Poll failed:", e.message);
    }
  }

  function start() {
    if (pollTimer) return;
    loadState();
    running = true;
    _pollOnce().catch((e) => console.error("[NtfyIngest] Poll failed:", e.message));
    pollTimer = setInterval(() => {
      _pollOnce().catch((e) => console.error("[NtfyIngest] Poll failed:", e.message));
    }, intervalMs);
    if (typeof pollTimer.unref === "function") pollTimer.unref();
    console.log(`[NtfyIngest] Poller started (${intervalMs}ms interval)`);
  }

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      running = false;
      console.log("[NtfyIngest] Poller stopped");
    }
  }

  /** Runtime snapshot for the UI / health surface. */
  function getState() {
    return { running, lastSeenMs, lastPollAt, lastError };
  }

  return { start, stop, getState, _pollOnce };
}

module.exports = {
  createNtfyIngest,
  normalizeMessage,
  severityForPriority,
  DEFAULT_INTERVAL_MS,
  RECENT_ID_LIMIT,
};
