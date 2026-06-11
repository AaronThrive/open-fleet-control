/**
 * Federation — fleet-of-fleets monitoring with opt-in write actions.
 *
 * Maintains a registry of REMOTE Open Fleet Control dashboards (persisted
 * atomically to state/federation.json) and polls each remote's /api/state
 * over the shared tailnet(s), extracting the compact `fleet` summary block
 * (mesh / kanban / evolution / alerts) plus the remote hostname. Reachable
 * remotes are additionally enriched (best-effort) with their pending
 * evolution lessons via GET /api/fleet/evolution.
 *
 * READ-ONLY BY DEFAULT (v1 behavior preserved): polling only ever issues
 * GET requests. Write operations against a remote exist ONLY through
 * performRemoteAction(), which:
 *   - refuses unless the remote was explicitly opted in (allowWrites: true,
 *     default false),
 *   - only executes a hardcoded whitelist of actions (WRITE_ACTIONS):
 *     lesson.approve / lesson.reject / gate.set / task.move,
 *   - strictly validates all params before any request is built,
 *   - forwards the local operator identity via Tailscale-User-Login so the
 *     remote's audit trail attributes the change correctly.
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
const DEFAULT_WRITE_TIMEOUT_MS = 10000;
const MAX_LABEL_LENGTH = 120;
const MAX_TOKEN_LENGTH = 512;
const MAX_REMOTE_BODY_CHARS = 4096; // proxied remote response bodies are truncated to 4KB
const MAX_PENDING_LESSONS = 10;
// Drill-down detail caps — every remote payload is trimmed before caching.
const MAX_DETAIL_NODES = 24;
const MAX_DETAIL_TASKS = 120;
const MAX_DETAIL_ALERTS = 10;

// Loopback hosts allowed to use plain http:// (see validateBaseUrl).
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// IDs minted by this codebase look like les_a1b2c3 / tsk_a1b2c3.
const REMOTE_ID_RE = /^[a-z]+_[0-9a-f]+$/i;
const KANBAN_STATUSES = ["inbox", "assigned", "inprogress", "review", "done", "failed"];

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function requireRemoteEntityId(value, label) {
  if (typeof value !== "string" || !REMOTE_ID_RE.test(value)) {
    throw badRequest(`Invalid ${label}: expected an id like les_a1b2c3`);
  }
  return value;
}

/**
 * The closed whitelist of write actions the federation proxy can perform.
 * Each entry validates its params (throwing a 400-style error on anything
 * unexpected) and builds the remote request. NOTHING outside this map can
 * ever be proxied to a remote.
 */
const WRITE_ACTIONS = {
  "lesson.approve": {
    validate(params) {
      return { lessonId: requireRemoteEntityId(params.lessonId, "lessonId") };
    },
    request(baseUrl, params) {
      return {
        method: "POST",
        url: `${baseUrl}/api/fleet/evolution/lessons/${encodeURIComponent(params.lessonId)}/approve`,
      };
    },
  },
  "lesson.reject": {
    validate(params) {
      return { lessonId: requireRemoteEntityId(params.lessonId, "lessonId") };
    },
    request(baseUrl, params) {
      return {
        method: "POST",
        url: `${baseUrl}/api/fleet/evolution/lessons/${encodeURIComponent(params.lessonId)}/reject`,
      };
    },
  },
  "gate.set": {
    validate(params) {
      if (typeof params.gate !== "boolean") {
        throw badRequest("Invalid gate: must be a boolean");
      }
      return { gate: params.gate };
    },
    request(baseUrl, params) {
      return {
        method: "PUT",
        url: `${baseUrl}/api/fleet/evolution/gate`,
        body: { gate: params.gate },
      };
    },
  },
  "task.move": {
    validate(params) {
      const out = {
        taskId: requireRemoteEntityId(params.taskId, "taskId"),
      };
      if (typeof params.status !== "string" || !KANBAN_STATUSES.includes(params.status)) {
        throw badRequest(`Invalid status: must be one of ${KANBAN_STATUSES.join(", ")}`);
      }
      out.status = params.status;
      if (params.order !== undefined) {
        if (typeof params.order !== "number" || !Number.isFinite(params.order)) {
          throw badRequest("Invalid order: must be a finite number");
        }
        out.order = params.order;
      }
      return out;
    },
    request(baseUrl, params) {
      const body = { status: params.status };
      if (params.order !== undefined) body.order = params.order;
      return {
        method: "POST",
        url: `${baseUrl}/api/fleet/kanban/tasks/${encodeURIComponent(params.taskId)}/move`,
        body,
      };
    },
  },
};

/**
 * Validate a remote dashboard base URL.
 * Rules: https only, no embedded credentials, no hash/search clutter.
 * EXCEPTION (test/dev escape hatch): plain http:// is allowed for loopback
 * hosts ONLY (localhost / 127.0.0.1 / [::1]) so two local instances can
 * federate without TLS — e.g. integration tests or a laptop dev setup.
 * Anything non-loopback remains strictly https.
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
  const isLoopbackHttp = parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !isLoopbackHttp) {
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
 * @returns {{label: string, baseUrl: string, token: string|null, addedBy: string,
 *            allowWrites: boolean}}
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
  if (input.allowWrites !== undefined && typeof input.allowWrites !== "boolean") {
    throw new Error("Invalid allowWrites: must be a boolean when provided");
  }
  return {
    label: input.label.trim(),
    baseUrl,
    token: input.token && input.token.length > 0 ? input.token : null,
    addedBy: input.addedBy || "unknown",
    allowWrites: input.allowWrites === true, // writes are OPT-IN, default off
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

/**
 * Best-effort extraction of pending lessons from a remote
 * GET /api/fleet/evolution payload. Tolerates any shape mismatch (older
 * remotes without the endpoint, malformed bodies) by returning null.
 * Lessons are trimmed to {id, title, author, ts} and capped at
 * MAX_PENDING_LESSONS entries.
 *
 * @param {object|null} body - remote /api/fleet/evolution response body
 * @returns {Array<{id: string, title: string, author: string, ts: string}>|null}
 */
function extractPendingLessons(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.lessons)) return null;
  return body.lessons
    .filter((l) => l && typeof l === "object" && l.status === "pending" && typeof l.id === "string")
    .slice(0, MAX_PENDING_LESSONS)
    .map((l) => ({
      id: l.id,
      title: typeof l.title === "string" ? l.title : "",
      author: typeof l.author === "string" ? l.author : "",
      ts: typeof l.ts === "string" ? l.ts : "",
    }));
}

/** Trimmed string or null — guards every remote-supplied text field. */
function pickString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Best-effort extraction of a remote GET /api/fleet/mesh payload into a
 * trimmed node list for the drill-down panel. Tolerates any shape mismatch
 * (missing blocks, malformed leaves) by returning null / nulled fields.
 * Capped at MAX_DETAIL_NODES entries.
 *
 * @param {object|null} body - remote /api/fleet/mesh response body
 * @returns {{nodes: Array<object>}|null}
 */
function extractRemoteMeshDetail(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.nodes)) return null;
  const nodes = body.nodes
    .filter((n) => n && typeof n === "object")
    .slice(0, MAX_DETAIL_NODES)
    .map((n) => {
      const health = n.health && typeof n.health === "object" ? n.health : {};
      const vitals = n.vitals && typeof n.vitals === "object" ? n.vitals : null;
      return {
        id: pickString(n.id),
        hostname: pickString(n.hostname),
        label: pickString(n.label),
        port: pickNumber(n.port),
        status: pickString(health.status) || "unknown",
        latencyMs: pickNumber(health.latencyMs),
        version: pickString(health.version),
        vitals: vitals
          ? {
              cpuPct: pickNumber(vitals.cpu?.percent),
              memPct: pickNumber(vitals.memory?.pct),
              diskPct: pickNumber(vitals.disk?.pct),
              uptime:
                typeof vitals.uptime === "string" || typeof vitals.uptime === "number"
                  ? vitals.uptime
                  : null,
            }
          : null,
      };
    });
  return { nodes };
}

/**
 * Best-effort extraction of a remote GET /api/fleet/kanban board into
 * per-column counts plus a trimmed task list (cards carry only what the
 * drill-down / fleet board render). Tasks with an unknown status or without
 * a string id/title are dropped; the list is sorted by column order then
 * task order and capped at MAX_DETAIL_TASKS.
 *
 * @param {object|null} body - remote /api/fleet/kanban response body
 * @returns {{counts: object, tasks: Array<object>}|null}
 */
function extractRemoteBoardDetail(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.tasks)) return null;
  const counts = {};
  for (const status of KANBAN_STATUSES) counts[status] = 0;

  const tasks = [];
  for (const task of body.tasks) {
    if (!task || typeof task !== "object") continue;
    if (typeof task.id !== "string" || typeof task.title !== "string") continue;
    if (!KANBAN_STATUSES.includes(task.status)) continue;
    counts[task.status] += 1;
    tasks.push({
      id: task.id,
      title: task.title,
      status: task.status,
      assignee: pickString(task.assignee),
      priority: pickNumber(task.priority),
      order: pickNumber(task.order) ?? 0,
      updated_at: pickString(task.updated_at),
      stale: task.stale === true,
    });
  }
  tasks.sort(
    (a, b) =>
      KANBAN_STATUSES.indexOf(a.status) - KANBAN_STATUSES.indexOf(b.status) || a.order - b.order,
  );
  return { counts, tasks: tasks.slice(0, MAX_DETAIL_TASKS) };
}

/**
 * Best-effort extraction of a remote GET /api/fleet/alerts payload into a
 * trimmed recent-alerts list, capped at MAX_DETAIL_ALERTS.
 *
 * @param {object|null} body - remote /api/fleet/alerts response body
 * @returns {{alerts: Array<object>}|null}
 */
function extractRemoteAlertsDetail(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.alerts)) return null;
  const alerts = body.alerts
    .filter((a) => a && typeof a === "object")
    .slice(0, MAX_DETAIL_ALERTS)
    .map((a) => ({
      ts: pickNumber(a.ts) ?? pickString(a.ts),
      type: pickString(a.type),
      severity: pickString(a.severity),
      node: pickString(a.node),
      message: pickString(a.message),
    }));
  return { alerts };
}

function createInitialStatus() {
  return {
    reachable: null, // null = never checked yet
    lastChecked: null,
    lastError: null,
    latencyMs: null,
    summary: null, // last-known summary survives outages
    pendingLessons: null, // null = unknown (enrichment unavailable)
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
 * @param {number} [options.writeTimeoutMs] - proxied write timeout (default 10s)
 * @param {function} [options.fetchFn] - fetch-compatible function (injectable)
 * @param {function} [options.onChange] - callback({remote, previousReachable, reachable, status}) fired on reachability transitions
 * @param {function} [options.nowFn] - clock function (default Date.now)
 * @returns {{start, stop, getState, getRemoteDetail, getBoardSources,
 *            addRemote, removeRemote, setRemoteWrites, performRemoteAction,
 *            _pollOnce}}
 */
function createFederation(options = {}) {
  const {
    stateDir,
    intervalMs = DEFAULT_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    writeTimeoutMs = DEFAULT_WRITE_TIMEOUT_MS,
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
  // remoteId -> cached drill-down detail ({mesh, kanban, alerts, fetchedAt}).
  // Kept OUT of the status records so getState() stays a compact summary —
  // the detail surfaces only through getRemoteDetail() / getBoardSources().
  const details = {};
  let pollTimer = null;

  // ---------------------------------------------------------------------
  // Registry persistence (atomic: temp file + rename)
  // ---------------------------------------------------------------------

  function loadRegistry() {
    try {
      if (!fs.existsSync(registryFile)) return [];
      const raw = JSON.parse(fs.readFileSync(registryFile, "utf8"));
      const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.remotes) ? raw.remotes : [];
      return (
        list
          .filter(
            (r) =>
              r &&
              typeof r === "object" &&
              typeof r.baseUrl === "string" &&
              typeof r.id === "string",
          )
          // Registries written before v1.6 have no allowWrites field — they
          // load as writes-disabled (the safe default).
          .map((r) => ({ ...r, allowWrites: r.allowWrites === true }))
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
      allowWrites: validated.allowWrites,
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
    delete details[target.id];
    saveRegistry();
    return redactRemote(target);
  }

  /**
   * Toggle the per-remote write opt-in. Throws on unknown id or non-boolean
   * value. Returns the REDACTED updated record.
   *
   * @param {string} id
   * @param {boolean} allowWrites
   */
  function setRemoteWrites(id, allowWrites) {
    if (typeof allowWrites !== "boolean") {
      throw badRequest("Invalid allowWrites: must be a boolean");
    }
    const target = remotes.find((r) => r.id === id);
    if (!target) {
      throw new Error(`Unknown remote: ${id}`);
    }
    const updated = { ...target, allowWrites };
    remotes = remotes.map((r) => (r.id === id ? updated : r));
    saveRegistry();
    return redactRemote(updated);
  }

  // ---------------------------------------------------------------------
  // Write proxy (whitelisted, per-remote opt-in)
  // ---------------------------------------------------------------------

  /**
   * Read a proxied remote response body, truncated to 4KB. Returns the
   * parsed JSON object when the body parses and fits the cap; otherwise the
   * truncated raw text. Never throws — body read failures yield null.
   */
  async function readRemoteBody(res) {
    try {
      if (res && typeof res.text === "function") {
        const text = await res.text();
        if (text.length <= MAX_REMOTE_BODY_CHARS) {
          try {
            return JSON.parse(text);
          } catch (e) {
            return text;
          }
        }
        return text.slice(0, MAX_REMOTE_BODY_CHARS);
      }
      if (res && typeof res.json === "function") {
        const body = await res.json();
        const text = JSON.stringify(body) ?? "";
        return text.length <= MAX_REMOTE_BODY_CHARS ? body : text.slice(0, MAX_REMOTE_BODY_CHARS);
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  /**
   * Execute one whitelisted write action against a remote dashboard.
   *
   * Refuses (403) unless the remote has allowWrites enabled; rejects (400)
   * any action outside WRITE_ACTIONS or any param that fails strict
   * validation. The remote's bearer token is attached when configured
   * (a token is NOT required — tailnet sharing may be sufficient), and the
   * local operator identity is ALWAYS forwarded as Tailscale-User-Login so
   * the remote audit trail attributes the change to the real actor.
   *
   * Remote 4xx/5xx responses are NOT thrown — they surface in the result as
   * { ok: false, remoteStatus, remoteBody } so callers can relay them.
   * Network-level failures throw a 502-style error.
   *
   * @param {string} remoteId
   * @param {string} action - one of Object.keys(WRITE_ACTIONS)
   * @param {object} params - action params (strictly validated)
   * @param {object} [options]
   * @param {string} [options.actor] - local operator identity to forward
   * @returns {Promise<{ok: boolean, action: string, remoteId: string,
   *                    remoteStatus: number|null, remoteBody: *}>}
   */
  async function performRemoteAction(remoteId, action, params, options = {}) {
    const remote = remotes.find((r) => r.id === remoteId);
    if (!remote) {
      throw new Error(`Unknown remote: ${remoteId}`);
    }
    const spec = Object.prototype.hasOwnProperty.call(WRITE_ACTIONS, action)
      ? WRITE_ACTIONS[action]
      : null;
    if (!spec) {
      throw badRequest(
        `Unsupported federation action "${String(action)}". Allowed: ${Object.keys(WRITE_ACTIONS).join(", ")}`,
      );
    }
    if (remote.allowWrites !== true) {
      const err = new Error(
        `Write actions are disabled for remote "${remote.label}" — enable allowWrites first`,
      );
      err.statusCode = 403;
      throw err;
    }

    const safeParams = spec.validate(params && typeof params === "object" ? params : {});
    const request = spec.request(remote.baseUrl, safeParams);

    const actor =
      typeof options.actor === "string" && options.actor.trim().length > 0
        ? options.actor.trim()
        : "anonymous";
    const headers = {
      "Content-Type": "application/json",
      // Forward the LOCAL operator so the remote audits the real human, not
      // this server's machine identity.
      "Tailscale-User-Login": actor,
    };
    if (remote.token) headers.Authorization = `Bearer ${remote.token}`;

    let res;
    try {
      res = await fetchFn(request.url, {
        method: request.method,
        headers,
        body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
        signal: timeoutSignal(writeTimeoutMs),
      });
    } catch (e) {
      const err = new Error(`Remote request failed: ${e && e.message ? e.message : "unknown"}`);
      err.statusCode = 502;
      throw err;
    }

    return {
      ok: !!(res && res.ok === true),
      action,
      remoteId: remote.id,
      remoteStatus: res && Number.isFinite(res.status) ? res.status : null,
      remoteBody: await readRemoteBody(res),
    };
  }

  // ---------------------------------------------------------------------
  // Polling (READ-ONLY: GET /api/state + GET /api/fleet/evolution plus the
  // drill-down detail GETs /api/fleet/{mesh,kanban,alerts} — nothing else)
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

  /**
   * Best-effort enrichment: fetch the remote's pending lessons so the panel
   * can act on them. Failures (older remotes without the endpoint, network
   * blips, non-JSON bodies) are tolerated SILENTLY and yield null.
   * READ-ONLY: a plain GET, same timeout as the state poll.
   */
  async function fetchPendingLessons(remote, headers) {
    try {
      const res = await fetchFn(`${remote.baseUrl}/api/fleet/evolution`, {
        headers,
        signal: timeoutSignal(timeoutMs),
      });
      if (!res || res.ok !== true) return null;
      return extractPendingLessons(await res.json());
    } catch (e) {
      return null;
    }
  }

  /**
   * Best-effort GET of one remote read-only endpoint. Returns the parsed
   * JSON body or null on ANY failure (network, non-2xx, non-JSON) —
   * drill-down enrichment must never fail the health poll.
   */
  async function fetchRemoteJson(remote, urlPath, headers) {
    try {
      const res = await fetchFn(`${remote.baseUrl}${urlPath}`, {
        headers,
        signal: timeoutSignal(timeoutMs),
      });
      if (!res || res.ok !== true) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  /**
   * Refresh the cached drill-down detail for a reachable remote: mesh nodes,
   * kanban board summary, and recent alerts — three parallel READ-ONLY GETs.
   * Each section is independently failure-tolerant: a failed/missing
   * endpoint (older remote, transient blip) keeps that section's last-known
   * value instead of wiping it. When nothing has ever been fetched the cache
   * entry simply stays absent and the UI degrades to the summary tile.
   */
  async function refreshRemoteDetail(remote, headers) {
    const [meshBody, kanbanBody, alertsBody] = await Promise.all([
      fetchRemoteJson(remote, "/api/fleet/mesh", headers),
      fetchRemoteJson(remote, "/api/fleet/kanban", headers),
      fetchRemoteJson(remote, `/api/fleet/alerts?limit=${MAX_DETAIL_ALERTS}`, headers),
    ]);
    const prev = details[remote.id] || null;
    const mesh = extractRemoteMeshDetail(meshBody) ?? (prev ? prev.mesh : null);
    const kanban = extractRemoteBoardDetail(kanbanBody) ?? (prev ? prev.kanban : null);
    const alerts = extractRemoteAlertsDetail(alertsBody) ?? (prev ? prev.alerts : null);
    if (!mesh && !kanban && !alerts) return; // nothing known yet — stay absent
    // The remote may have been removed while the requests were in flight.
    if (!remotes.some((r) => r.id === remote.id)) return;
    details[remote.id] = { mesh, kanban, alerts, fetchedAt: nowFn() };
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
        // Enrichment (pending lessons + drill-down detail) in parallel —
        // each is independently best-effort and never fails the poll.
        const [pendingLessons] = await Promise.all([
          fetchPendingLessons(remote, headers),
          refreshRemoteDetail(remote, headers),
        ]);
        next = {
          reachable: true,
          lastChecked: startedAt,
          lastError: null,
          latencyMs,
          summary,
          pendingLessons,
        };
      } else {
        next = {
          reachable: false,
          lastChecked: startedAt,
          lastError: res ? `HTTP ${res.status}` : "No response",
          latencyMs: null,
          summary: prev.summary,
          pendingLessons: prev.pendingLessons ?? null,
        };
      }
    } catch (e) {
      next = {
        reachable: false,
        lastChecked: startedAt,
        lastError: e && e.message ? e.message : "Request failed",
        latencyMs: null,
        summary: prev.summary,
        pendingLessons: prev.pendingLessons ?? null,
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

  /**
   * Drill-down snapshot for one remote: redacted record + status + cached
   * detail (null until the first successful detail fetch). Throws
   * "Unknown remote" (mapped to 404 by the routes) on a bad id.
   *
   * @param {string} remoteId
   * @returns {{remote: object, status: object, detail: object|null}}
   */
  function getRemoteDetail(remoteId) {
    const remote = remotes.find((r) => r.id === remoteId);
    if (!remote) {
      throw new Error(`Unknown remote: ${remoteId}`);
    }
    return {
      remote: redactRemote(remote),
      status: statuses[remote.id] || createInitialStatus(),
      detail: details[remote.id] || null,
    };
  }

  /**
   * Per-remote sources for the fleet-wide board: redacted record,
   * reachability, and the cached detail (whose kanban block carries the
   * remote's trimmed cards). Dead remotes appear with their last-known
   * detail (or null) — the board renders what it has, never throws.
   *
   * @returns {Array<{remote: object, reachable: boolean|null, detail: object|null}>}
   */
  function getBoardSources() {
    return remotes.map((remote) => {
      const status = statuses[remote.id];
      return {
        remote: redactRemote(remote),
        reachable: status ? status.reachable : null,
        detail: details[remote.id] || null,
      };
    });
  }

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

  return {
    start,
    stop,
    getState,
    getRemoteDetail,
    getBoardSources,
    addRemote,
    removeRemote,
    setRemoteWrites,
    performRemoteAction,
    _pollOnce,
  };
}

module.exports = {
  createFederation,
  validateBaseUrl,
  validateRemoteInput,
  extractRemoteSummary,
  extractPendingLessons,
  extractRemoteMeshDetail,
  extractRemoteBoardDetail,
  extractRemoteAlertsDetail,
  KANBAN_STATUSES,
  MAX_DETAIL_NODES,
  MAX_DETAIL_TASKS,
  MAX_DETAIL_ALERTS,
  WRITE_ACTIONS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WRITE_TIMEOUT_MS,
};
