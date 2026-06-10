/**
 * Federation — read-only fleet-of-fleets monitoring.
 *
 * Maintains a registry of REMOTE Open Fleet Control dashboards (persisted
 * atomically to state/federation.json) and polls each remote's /api/state
 * over the shared tailnet(s), extracting the compact `fleet` summary block
 * (mesh / kanban / evolution / alerts) plus the remote hostname.
 *
 * READ-ONLY v1: this module never issues anything but GET requests against
 * remotes. There are no write operations against a federated dashboard, ever.
 *
 * Secrets: each remote may carry an optional bearer token. The token is
 * persisted server-side only and is REDACTED from every value this module
 * returns (getState / addRemote / removeRemote expose `hasToken` instead).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const REGISTRY_FILENAME = "federation.json";
const DEFAULT_INTERVAL_MS = 30000;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_LABEL_LENGTH = 120;
const MAX_TOKEN_LENGTH = 512;

/**
 * Validate a remote dashboard base URL.
 * Rules: https only, no embedded credentials, no hash/search clutter.
 * Returns the normalized URL string (no trailing slash). Throws on invalid.
 *
 * @param {string} baseUrl
 * @returns {string} normalized base URL
 */
function validateBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
    throw new Error("Invalid baseUrl: must be a non-empty string");
  }
  let parsed;
  try {
    parsed = new URL(baseUrl.trim());
  } catch (e) {
    throw new Error(`Invalid baseUrl: not a parseable URL (${baseUrl})`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Invalid baseUrl: only https:// URLs are allowed (got ${parsed.protocol}//)`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Invalid baseUrl: credentials in the URL are not allowed");
  }
  // Normalize: origin + path without trailing slash, drop search/hash.
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${pathname}`;
}

/**
 * Validate raw addRemote() input. Returns a normalized shape (without
 * id/addedAt — those are added by addRemote). Throws on any invalid field.
 *
 * @param {object} input
 * @returns {{label: string, baseUrl: string, token: string|null, addedBy: string}}
 */
function validateRemoteInput(input) {
  if (!input || typeof input !== "object") {
    throw new Error("addRemote requires an options object");
  }
  if (typeof input.label !== "string" || input.label.trim().length === 0) {
    throw new Error("Invalid label: must be a non-empty string");
  }
  if (input.label.length > MAX_LABEL_LENGTH) {
    throw new Error(`Invalid label: must be at most ${MAX_LABEL_LENGTH} characters`);
  }
  const baseUrl = validateBaseUrl(input.baseUrl);
  if (input.token !== undefined && input.token !== null && typeof input.token !== "string") {
    throw new Error("Invalid token: must be a string when provided");
  }
  if (input.token && input.token.length > MAX_TOKEN_LENGTH) {
    throw new Error(`Invalid token: must be at most ${MAX_TOKEN_LENGTH} characters`);
  }
  if (input.addedBy !== undefined && typeof input.addedBy !== "string") {
    throw new Error("Invalid addedBy: must be a string");
  }
  return {
    label: input.label.trim(),
    baseUrl,
    token: input.token && input.token.length > 0 ? input.token : null,
    addedBy: input.addedBy || "unknown",
  };
}

/** First finite number among the candidates, or null. */
function pickNumber(...candidates) {
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Best-effort extraction of the fleet summary from a remote /api/state
 * payload. Tolerates any shape mismatch — missing blocks become nulls.
 *
 * @param {object|null} state - remote /api/state response body
 * @returns {{hostname: string|null, mesh: object|null, kanban: object|null,
 *            evolution: object|null, alerts: object|null}|null}
 */
function extractRemoteSummary(state) {
  if (!state || typeof state !== "object") return null;
  const fleet = state.fleet && typeof state.fleet === "object" ? state.fleet : {};
  const vitals = state.vitals && typeof state.vitals === "object" ? state.vitals : {};

  const mesh =
    fleet.mesh && typeof fleet.mesh === "object"
      ? { nodes: pickNumber(fleet.mesh.nodes), online: pickNumber(fleet.mesh.online) }
      : null;
  const kanban =
    fleet.kanban && typeof fleet.kanban === "object"
      ? {
          counts:
            fleet.kanban.counts && typeof fleet.kanban.counts === "object"
              ? fleet.kanban.counts
              : {},
          staleCount: pickNumber(fleet.kanban.staleCount),
        }
      : null;
  const evolution =
    fleet.evolution && typeof fleet.evolution === "object"
      ? {
          gate: typeof fleet.evolution.gate === "boolean" ? fleet.evolution.gate : null,
          pendingCount: pickNumber(fleet.evolution.pendingCount),
        }
      : null;
  const alerts =
    fleet.alerts && typeof fleet.alerts === "object"
      ? { recent: pickNumber(fleet.alerts.recent) }
      : null;

  return {
    hostname: typeof vitals.hostname === "string" && vitals.hostname ? vitals.hostname : null,
    mesh,
    kanban,
    evolution,
    alerts,
  };
}

function createInitialStatus() {
  return {
    reachable: null, // null = never checked yet
    lastChecked: null,
    lastError: null,
    latencyMs: null,
    summary: null, // last-known summary survives outages
  };
}

/** Public (redacted) view of a remote record — the token NEVER leaves. */
function redactRemote(remote) {
  const { token, ...rest } = remote;
  return { ...rest, hasToken: !!token };
}

/**
 * Create the federation module with injectable dependencies.
 *
 * @param {object} options
 * @param {string} options.stateDir - directory for federation.json persistence
 * @param {number} [options.intervalMs] - poll interval (default 30s)
 * @param {number} [options.timeoutMs] - per-request timeout (default 5s)
 * @param {function} [options.fetchFn] - fetch-compatible function (injectable)
 * @param {function} [options.onChange] - callback({remote, previousReachable, reachable, status}) fired on reachability transitions
 * @param {function} [options.nowFn] - clock function (default Date.now)
 * @returns {{start, stop, getState, addRemote, removeRemote, _pollOnce}}
 */
function createFederation(options = {}) {
  const {
    stateDir,
    intervalMs = DEFAULT_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchFn = (...args) => globalThis.fetch(...args),
    onChange = null,
    nowFn = Date.now,
  } = options;

  if (!stateDir || typeof stateDir !== "string") {
    throw new Error("createFederation requires a stateDir string");
  }

  const registryFile = path.join(stateDir, REGISTRY_FILENAME);

  let remotes = loadRegistry();
  const statuses = {}; // remoteId -> status record (records replaced immutably)
  let pollTimer = null;

  // ---------------------------------------------------------------------
  // Registry persistence (atomic: temp file + rename)
  // ---------------------------------------------------------------------

  function loadRegistry() {
    try {
      if (!fs.existsSync(registryFile)) return [];
      const raw = JSON.parse(fs.readFileSync(registryFile, "utf8"));
      const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.remotes) ? raw.remotes : [];
      return list.filter(
        (r) =>
          r && typeof r === "object" && typeof r.baseUrl === "string" && typeof r.id === "string",
      );
    } catch (e) {
      console.error(`[Federation] Failed to load registry from ${registryFile}:`, e.message);
      return [];
    }
  }

  function saveRegistry() {
    fs.mkdirSync(stateDir, { recursive: true });
    const tmpFile = `${registryFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmpFile, JSON.stringify({ remotes }, null, 2));
    fs.renameSync(tmpFile, registryFile);
  }

  // ---------------------------------------------------------------------
  // Registry CRUD
  // ---------------------------------------------------------------------

  /**
   * Register a remote dashboard. Validates all inputs; throws on invalid
   * input or duplicate baseUrl. Returns the REDACTED record (no token).
   */
  function addRemote(input) {
    const validated = validateRemoteInput(input);
    if (remotes.some((r) => r.baseUrl === validated.baseUrl)) {
      throw new Error(`Remote already registered: ${validated.baseUrl}`);
    }
    const record = {
      id: crypto.randomUUID(),
      label: validated.label,
      baseUrl: validated.baseUrl,
      token: validated.token,
      addedAt: new Date(nowFn()).toISOString(),
      addedBy: validated.addedBy,
    };
    remotes = [...remotes, record];
    saveRegistry();
    // Probe the new remote immediately (fire-and-forget, READ-ONLY GET).
    pollRemote(record).catch((e) => {
      console.error("[Federation] Initial probe failed:", e.message);
    });
    return redactRemote(record);
  }

  /**
   * Remove a remote by id. Throws when not found.
   * Returns the REDACTED removed record.
   */
  function removeRemote(id) {
    const target = remotes.find((r) => r.id === id);
    if (!target) {
      throw new Error(`Unknown remote: ${id}`);
    }
    remotes = remotes.filter((r) => r.id !== target.id);
    delete statuses[target.id];
    saveRegistry();
    return redactRemote(target);
  }

  // ---------------------------------------------------------------------
  // Polling (READ-ONLY: GET <baseUrl>/api/state, nothing else)
  // ---------------------------------------------------------------------

  function timeoutSignal(ms) {
    if (globalThis.AbortSignal && typeof globalThis.AbortSignal.timeout === "function") {
      return globalThis.AbortSignal.timeout(ms);
    }
    return undefined;
  }

  function emitChange(remote, previousReachable, status) {
    if (typeof onChange !== "function") return;
    try {
      onChange({
        remote: redactRemote(remote),
        previousReachable,
        reachable: status.reachable,
        status,
      });
    } catch (e) {
      console.error("[Federation] onChange callback failed:", e.message);
    }
  }

  async function pollRemote(remote) {
    const prev = statuses[remote.id] || createInitialStatus();
    const startedAt = nowFn();
    let next;

    try {
      const headers = {};
      if (remote.token) headers.Authorization = `Bearer ${remote.token}`;
      const res = await fetchFn(`${remote.baseUrl}/api/state`, {
        headers,
        signal: timeoutSignal(timeoutMs),
      });
      const latencyMs = nowFn() - startedAt;

      if (res && res.ok === true) {
        let summary = prev.summary;
        try {
          summary = extractRemoteSummary(await res.json());
        } catch (e) {
          // Non-JSON body — keep the last-known summary.
        }
        next = {
          reachable: true,
          lastChecked: startedAt,
          lastError: null,
          latencyMs,
          summary,
        };
      } else {
        next = {
          reachable: false,
          lastChecked: startedAt,
          lastError: res ? `HTTP ${res.status}` : "No response",
          latencyMs: null,
          summary: prev.summary,
        };
      }
    } catch (e) {
      next = {
        reachable: false,
        lastChecked: startedAt,
        lastError: e && e.message ? e.message : "Request failed",
        latencyMs: null,
        summary: prev.summary,
      };
    }

    // The remote may have been removed while the request was in flight.
    if (!remotes.some((r) => r.id === remote.id)) return;

    statuses[remote.id] = next;
    if (prev.reachable !== next.reachable) {
      emitChange(remote, prev.reachable, next);
    }
  }

  /**
   * Run one full poll cycle across all registered remotes.
   * Exposed for testing (matches the mesh module's convention).
   */
  async function _pollOnce() {
    await Promise.all(remotes.map((remote) => pollRemote(remote)));
  }

  function start() {
    if (pollTimer) return;
    _pollOnce().catch((e) => console.error("[Federation] Poll failed:", e.message));
    pollTimer = setInterval(() => {
      _pollOnce().catch((e) => console.error("[Federation] Poll failed:", e.message));
    }, intervalMs);
    if (typeof pollTimer.unref === "function") pollTimer.unref();
    console.log(`[Federation] Remote dashboard poller started (${intervalMs}ms interval)`);
  }

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      console.log("[Federation] Remote dashboard poller stopped");
    }
  }

  // ---------------------------------------------------------------------
  // State snapshot for the UI (tokens redacted)
  // ---------------------------------------------------------------------

  function getState() {
    return {
      remotes: remotes.map((remote) => ({
        ...redactRemote(remote),
        status: statuses[remote.id] || createInitialStatus(),
      })),
      counts: {
        remotes: remotes.length,
        reachable: remotes.filter((r) => statuses[r.id] && statuses[r.id].reachable === true)
          .length,
      },
      intervalMs,
      timestamp: nowFn(),
    };
  }

  return { start, stop, getState, addRemote, removeRemote, _pollOnce };
}

module.exports = {
  createFederation,
  validateBaseUrl,
  validateRemoteInput,
  extractRemoteSummary,
  DEFAULT_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
};
