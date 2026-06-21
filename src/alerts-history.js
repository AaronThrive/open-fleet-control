/**
 * Alert history — persistent JSONL log of every FIRED alert.
 *
 * One JSON object per line appended to `logs/alerts.jsonl` (post-dedupe,
 * post-rule, post-mute — only alerts that actually fired). Mirrors the
 * audit trail's rotation/query pattern:
 *
 *   Rotation: when alerts.jsonl reaches 20MB it is renamed to
 *   `alerts.<stamp>.jsonl` (ISO timestamp, filesystem-safe) and a fresh file
 *   is started. At most 5 rotated files are kept; older ones are deleted.
 *
 *   query() reads the active file plus rotated files newest-first, filters
 *   by type/node/severity/since, and returns newest-first entries capped at
 *   `limit` (default 200, hard max 500). Malformed lines are skipped.
 *
 * Append failures are logged and never thrown — history is best-effort and
 * must never break alert delivery.
 *
 * Analytics: analytics({now?, days?}) rolls the persisted history up into
 * per-UTC-day counts (default last 14 days), flap cycles (a nodeOffline/
 * nodeUnreachable followed by a nodeRecovered for the same node = one
 * fired→recovered cycle, attributed to the firing rule), and the noisiest
 * nodes/rules. The pure computation is exported as computeAlertAnalytics()
 * for unit testing. Empty or missing history yields a zeroed shape.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ACTIVE_LOG = "alerts.jsonl";
const ROTATED_RE = /^alerts\..+\.jsonl$/;
const DEFAULT_MAX_LOG_BYTES = 20 * 1024 * 1024; // 20MB rotation threshold
const DEFAULT_MAX_ROTATED_FILES = 5;
const DEFAULT_QUERY_LIMIT = 200;
const MAX_QUERY_LIMIT = 500;
const SEVERITIES = new Set(["info", "warn", "critical"]);

// Analytics rollup bounds (computeAlertAnalytics).
const DAY_MS = 24 * 60 * 60 * 1000;
const ANALYTICS_DEFAULT_DAYS = 14;
const ANALYTICS_MAX_DAYS = 90;
const ANALYTICS_TOP_LIMIT = 10;
const ANALYTICS_FLAP_LIMIT = 20;
const NODE_DOWN_RULES = new Set(["nodeOffline", "nodeUnreachable"]);

/**
 * Convert a since value (ISO string, Date, or epoch ms) to epoch ms.
 * @param {string|number|Date} value
 * @returns {number} epoch milliseconds
 * @throws {Error} when the value cannot be parsed
 */
function toEpochMs(value) {
  let ms;
  if (value instanceof Date) {
    ms = value.getTime();
  } else if (typeof value === "number") {
    ms = value;
  } else if (typeof value === "string") {
    // Accept both epoch-ms strings ("1717…") and ISO timestamps.
    ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  } else {
    throw new Error("Invalid since: expected ISO string, Date, or epoch milliseconds");
  }
  if (!Number.isFinite(ms)) {
    throw new Error("Invalid since: could not parse as a timestamp");
  }
  return ms;
}

/** Clamp the analytics window to a safe integer day count. */
function clampAnalyticsDays(days) {
  return Number.isInteger(days) && days >= 1 && days <= ANALYTICS_MAX_DAYS
    ? days
    : ANALYTICS_DEFAULT_DAYS;
}

/** "YYYY-MM-DD" UTC day key for an epoch-ms timestamp. */
function utcDayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Top-N [{<keyName>, count}] descending from a Map of counts. */
function topCounts(counts, keyName, limit) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit)
    .map(([key, count]) => ({ [keyName]: key, count }));
}

/**
 * Flap cycles: chronological scan per node — a nodeOffline/nodeUnreachable
 * opens a pending down-state; the next nodeRecovered for the same node
 * closes it as one cycle attributed to the rule that fired.
 *
 * @param {Array<object>} entries - window entries, any order
 * @returns {Array<{rule: string, node: string, cycles: number}>} desc by cycles
 */
function countFlapCycles(entries) {
  const ordered = [...entries].sort((a, b) => a.ts - b.ts);
  const pendingRuleByNode = new Map(); // node -> rule that fired last
  const cycles = new Map(); // "rule|node" -> count
  for (const rec of ordered) {
    if (typeof rec.node !== "string" || rec.node.length === 0) continue;
    if (NODE_DOWN_RULES.has(rec.type)) {
      pendingRuleByNode.set(rec.node, rec.type);
    } else if (rec.type === "nodeRecovered" && pendingRuleByNode.has(rec.node)) {
      const key = `${pendingRuleByNode.get(rec.node)}|${rec.node}`;
      cycles.set(key, (cycles.get(key) || 0) + 1);
      pendingRuleByNode.delete(rec.node);
    }
  }
  return [...cycles.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, ANALYTICS_FLAP_LIMIT)
    .map(([key, count]) => {
      const [rule, ...nodeParts] = key.split("|");
      return { rule, node: nodeParts.join("|"), cycles: count };
    });
}

/**
 * Pure analytics rollup over alert history entries.
 *
 * @param {Array<object>} entries - parsed history records ({type, severity, node, ts})
 * @param {object} [options]
 * @param {number} [options.now=Date.now()] - epoch ms reference point
 * @param {number} [options.days=14] - window length in UTC days (1..90)
 * @returns {{days: number, since: number, total: number,
 *            perDay: Array<{date: string, total: number, critical: number, warn: number, info: number}>,
 *            flaps: Array<{rule: string, node: string, cycles: number}>,
 *            topNodes: Array<{node: string, count: number}>,
 *            topRules: Array<{type: string, count: number}>}}
 */
function computeAlertAnalytics(entries, { now = Date.now(), days = ANALYTICS_DEFAULT_DAYS } = {}) {
  const windowDays = clampAnalyticsDays(days);
  const reference = Number.isFinite(now) ? now : Date.now();
  // Window: start of the UTC day (days-1) days ago, through "now".
  const todayStart = Math.floor(reference / DAY_MS) * DAY_MS;
  const since = todayStart - (windowDays - 1) * DAY_MS;

  const perDayByKey = new Map();
  for (let i = 0; i < windowDays; i++) {
    const dayStart = since + i * DAY_MS;
    perDayByKey.set(utcDayKey(dayStart), {
      date: utcDayKey(dayStart),
      total: 0,
      critical: 0,
      warn: 0,
      info: 0,
    });
  }

  const inWindow = [];
  const nodeCounts = new Map();
  const ruleCounts = new Map();
  for (const rec of Array.isArray(entries) ? entries : []) {
    if (!rec || typeof rec !== "object") continue;
    if (!Number.isFinite(rec.ts) || rec.ts < since || rec.ts > reference) continue;
    inWindow.push(rec);

    const bucket = perDayByKey.get(utcDayKey(rec.ts));
    if (bucket) {
      bucket.total += 1;
      const severity = SEVERITIES.has(rec.severity) ? rec.severity : "info";
      bucket[severity] += 1;
    }
    if (typeof rec.node === "string" && rec.node.length > 0) {
      nodeCounts.set(rec.node, (nodeCounts.get(rec.node) || 0) + 1);
    }
    if (typeof rec.type === "string" && rec.type.length > 0) {
      ruleCounts.set(rec.type, (ruleCounts.get(rec.type) || 0) + 1);
    }
  }

  return {
    days: windowDays,
    since,
    total: inWindow.length,
    perDay: [...perDayByKey.values()],
    flaps: countFlapCycles(inWindow),
    topNodes: topCounts(nodeCounts, "node", ANALYTICS_TOP_LIMIT),
    topRules: topCounts(ruleCounts, "type", ANALYTICS_TOP_LIMIT),
  };
}

/**
 * Create an alert history store bound to a logs directory.
 *
 * @param {object} options
 * @param {string} options.logsDir - directory holding alerts.jsonl (+ rotated files)
 * @param {number} [options.maxBytes=20MB] - rotation threshold (injectable for tests)
 * @param {number} [options.keepFiles=5] - rotated files kept
 * @returns {{append: function, query: function}}
 */
function createAlertHistory({
  logsDir,
  maxBytes = DEFAULT_MAX_LOG_BYTES,
  keepFiles = DEFAULT_MAX_ROTATED_FILES,
} = {}) {
  if (typeof logsDir !== "string" || logsDir.length === 0) {
    throw new Error("createAlertHistory requires a logsDir option");
  }

  const activePath = path.join(logsDir, ACTIVE_LOG);

  function listRotatedFiles() {
    let entries = [];
    try {
      entries = fs.readdirSync(logsDir);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    return entries.filter((name) => name !== ACTIVE_LOG && ROTATED_RE.test(name)).sort(); // lexical = chronological (ISO stamps)
  }

  function rotateIfNeeded() {
    let size = 0;
    try {
      size = fs.statSync(activePath).size;
    } catch (e) {
      return; // No active file yet — nothing to rotate.
    }
    if (size < maxBytes) return;

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let rotatedPath = path.join(logsDir, `alerts.${stamp}.jsonl`);
    if (fs.existsSync(rotatedPath)) {
      rotatedPath = path.join(
        logsDir,
        `alerts.${stamp}-${crypto.randomBytes(3).toString("hex")}.jsonl`,
      );
    }
    fs.renameSync(activePath, rotatedPath);

    const rotated = listRotatedFiles();
    const excess = rotated.length - keepFiles;
    for (let i = 0; i < excess; i++) {
      try {
        fs.unlinkSync(path.join(logsDir, rotated[i]));
      } catch (e) {
        console.error("[AlertHistory] Failed to prune rotated log:", rotated[i], e.message);
      }
    }
  }

  /**
   * Append one fired alert. Best-effort: failures are logged, never thrown.
   * @param {object} alert - normalized alert record ({id, type, severity, node, task, message, ts})
   */
  function append(alert) {
    try {
      fs.mkdirSync(logsDir, { recursive: true });
      rotateIfNeeded();
      fs.appendFileSync(activePath, JSON.stringify(alert) + "\n", "utf8");
    } catch (e) {
      console.error("[AlertHistory] Append failed:", e.message);
    }
  }

  function readEntries(filePath) {
    let content;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch (e) {
      return [];
    }
    const entries = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && parsed.type && Number.isFinite(parsed.ts)) {
          entries.push(parsed);
        }
      } catch (e) {
        // Skip malformed lines — history must stay readable.
      }
    }
    return entries;
  }

  /**
   * Query alert history, newest-first.
   *
   * @param {object} [options]
   * @param {string} [options.type] - exact alert type match
   * @param {string} [options.node] - exact node match
   * @param {string} [options.severity] - info|warn|critical
   * @param {string|number|Date} [options.since] - inclusive lower bound on ts
   * @param {number} [options.limit=200] - max entries (hard cap 500)
   * @returns {Array<object>} matching entries, newest first
   */
  function query({ type, node, severity, since, limit = DEFAULT_QUERY_LIMIT } = {}) {
    const parsedLimit = Number(limit);
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
      throw new Error("Query limit must be a positive number");
    }
    const cap = Math.min(Math.floor(parsedLimit), MAX_QUERY_LIMIT);
    const sinceMs = since === undefined || since === null || since === "" ? null : toEpochMs(since);
    if (severity !== undefined && severity !== null && !SEVERITIES.has(severity)) {
      throw new Error(`Invalid severity filter "${String(severity)}"`);
    }

    const matches = (rec) => {
      if (type && rec.type !== type) return false;
      if (node && rec.node !== node) return false;
      if (severity && rec.severity !== severity) return false;
      if (sinceMs !== null && rec.ts < sinceMs) return false;
      return true;
    };

    // Files newest-first: active log, then rotated files in reverse order.
    // Lines within each file are chronological, so iterate them in reverse.
    const files = [
      activePath,
      ...listRotatedFiles()
        .reverse()
        .map((f) => path.join(logsDir, f)),
    ];
    const results = [];
    for (const filePath of files) {
      if (results.length >= cap) break;
      const entries = readEntries(filePath);
      for (let i = entries.length - 1; i >= 0 && results.length < cap; i--) {
        if (matches(entries[i])) results.push(entries[i]);
      }
    }

    // Defensive: guarantee newest-first ordering even with odd timestamps.
    return results.sort((a, b) => b.ts - a.ts);
  }

  /**
   * Roll the full on-disk history (active + rotated files) up into the
   * analytics shape. See computeAlertAnalytics() for options and shape.
   *
   * @param {{now?: number, days?: number}} [options]
   * @returns {object} analytics rollup (zeroed when no history exists)
   */
  function analytics(options = {}) {
    const entries = [];
    for (const filePath of [activePath, ...listRotatedFiles().map((f) => path.join(logsDir, f))]) {
      entries.push(...readEntries(filePath));
    }
    return computeAlertAnalytics(entries, options);
  }

  /**
   * Archive the active history file by renaming it to a timestamped
   * `alerts.<stamp>.cleared` backup, then start fresh (the next append()
   * recreates alerts.jsonl). Best-effort: a missing active file is a no-op,
   * and failures are logged and never thrown. Rotated files are left intact.
   *
   * @returns {{archived: boolean, backup: string|null}}
   */
  function clear() {
    try {
      if (!fs.existsSync(activePath)) return { archived: false, backup: null };
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      let backupPath = path.join(logsDir, `alerts.${stamp}.cleared`);
      if (fs.existsSync(backupPath)) {
        backupPath = path.join(
          logsDir,
          `alerts.${stamp}-${crypto.randomBytes(3).toString("hex")}.cleared`,
        );
      }
      fs.renameSync(activePath, backupPath);
      return { archived: true, backup: path.basename(backupPath) };
    } catch (e) {
      console.error("[AlertHistory] Clear failed:", e.message);
      return { archived: false, backup: null };
    }
  }

  return { append, query, analytics, clear };
}

module.exports = { createAlertHistory, computeAlertAnalytics, MAX_QUERY_LIMIT };
