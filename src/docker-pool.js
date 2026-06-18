/**
 * docker-pool.js — real Docker adapter for the Phase 3 spawn controller.
 *
 * The existing src/docker.js is intentionally read-only (GET-only transport,
 * enforced by construction — it is the poller/cache layer for the UI). The
 * spawn controller (src/agent-spawn.js) needs write operations (start, stop)
 * and a streaming events subscription, which are out of scope for the poller.
 *
 * This module provides EXACTLY the interface the controller expects:
 *   { ps, start, stop, inspect, subscribeEvents }
 *
 * It uses the same access mechanism as docker.js: Node's built-in `http`
 * module over the Unix Docker socket — no new npm dependencies.
 *
 * Endpoints used:
 *   GET  /v1.41/containers/json?all=true&filters=... → ps
 *   POST /v1.41/containers/<name>/start              → start
 *   POST /v1.41/containers/<name>/stop?t=<grace>     → stop
 *   GET  /v1.41/containers/<name>/json               → inspect
 *   GET  /v1.41/events?filters=...                   → subscribeEvents (streaming)
 *
 * All pool containers carry the label com.ofc.pool=worker.  ps() filters to
 * only those containers so the spawn controller never sees unrelated ones.
 *
 * Dependencies are injected for unit-testability:
 *   requestFn  — http.request-compatible function (injectable for tests)
 *   socketPath — Docker Unix socket path
 *
 * @module docker-pool
 */

const http = require("http");

const DOCKER_API_VERSION = "v1.41";
const DEFAULT_SOCKET_PATH = "/var/run/docker.sock";
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
// Grace period (seconds) passed to `docker stop` as ?t=<n>.
const DEFAULT_STOP_GRACE_SECONDS = 10;
// Reconnect delay for the events stream on transient errors.
const EVENTS_RECONNECT_DELAY_MS = 2000;

// ---------------------------------------------------------------------------
// Low-level helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Encode a Docker API filter object as a URL-safe JSON string for ?filters=.
 * Docker expects: {"label":["com.ofc.pool=worker"]}
 *
 * @param {object} filters
 * @returns {string}
 */
function encodeFilters(filters) {
  return encodeURIComponent(JSON.stringify(filters));
}

/**
 * Parse the ndjson (newline-delimited JSON) event stream from `docker events`.
 * Each non-empty line should be a JSON object; broken lines are silently skipped.
 *
 * @param {string} chunk - raw text chunk from the stream
 * @param {string} remainder - leftover from the previous chunk
 * @returns {{ events: object[], remainder: string }}
 */
function parseNdjsonChunk(chunk, remainder) {
  const combined = remainder + chunk;
  const lines = combined.split("\n");
  const remainder2 = lines.pop(); // last element may be a partial line
  const events = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch (_) {
      // malformed line — skip
    }
  }
  return { events, remainder: remainder2 };
}

// ---------------------------------------------------------------------------
// Module factory
// ---------------------------------------------------------------------------

/**
 * Create the pool adapter.
 *
 * @param {object} [options]
 * @param {string}   [options.socketPath]         - Docker unix socket (default /var/run/docker.sock)
 * @param {number}   [options.requestTimeoutMs]   - per-request timeout for start/stop/inspect
 * @param {number}   [options.stopGraceSeconds]   - grace period for docker stop (default 10)
 * @param {function} [options.requestFn]          - injectable http.request-compatible fn for tests
 * @returns {{ ps, start, stop, inspect, subscribeEvents }}
 */
function createDockerPool(options = {}) {
  const {
    socketPath = DEFAULT_SOCKET_PATH,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    stopGraceSeconds = DEFAULT_STOP_GRACE_SECONDS,
    requestFn = http.request,
  } = options;

  // -------------------------------------------------------------------------
  // Internal: issue a one-shot HTTP request over the Docker socket.
  //
  // @param {string} method   - HTTP method (GET, POST, DELETE…)
  // @param {string} apiPath  - API path (e.g. "/v1.41/containers/mybox/start")
  // @param {number} [timeoutMs]
  // @returns {Promise<{ ok: boolean, status: number, body: string, json: () => any }>}
  // -------------------------------------------------------------------------
  function socketRequest(method, apiPath, timeoutMs = requestTimeoutMs) {
    return new Promise((resolve, reject) => {
      const req = requestFn(
        {
          socketPath,
          path: apiPath,
          method,
          headers: { Host: "docker", "Content-Length": 0 },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              body,
              json: () => JSON.parse(body),
            });
          });
          res.on("error", reject);
        },
      );
      req.setTimeout(timeoutMs, () => {
        req.destroy(
          new Error(`[DockerPool] Request timeout after ${timeoutMs}ms: ${method} ${apiPath}`),
        );
      });
      req.on("error", reject);
      req.end();
    });
  }

  // -------------------------------------------------------------------------
  // ps(opts) — list pool containers (running + stopped).
  //
  // The spawn controller calls:
  //   docker.ps({ all: true, filters: { label: ["com.ofc.pool=worker"] } })
  //
  // Returns: Promise<Array<{ Id, Names, State, Labels, ... }>>
  //   (raw Docker containers/json items — the controller reads .State, .Names,
  //   .Labels, .running from these; we pass them through verbatim)
  // -------------------------------------------------------------------------
  async function ps(opts = {}) {
    const all = opts.all !== false; // default true
    const filters = opts.filters || {};
    // Build query string.
    const params = new URLSearchParams();
    if (all) params.set("all", "true");
    if (Object.keys(filters).length > 0) {
      params.set("filters", encodeFilters(filters));
    }
    const qs = params.toString() ? `?${params.toString()}` : "";
    // Use pre-encoded filters so URLSearchParams does not double-encode them.
    const apiPath = `/${DOCKER_API_VERSION}/containers/json${all ? "?all=true" : ""}${
      Object.keys(filters).length > 0 ? (all ? "&" : "?") + "filters=" + encodeFilters(filters) : ""
    }`;

    const res = await socketRequest("GET", apiPath);
    if (!res.ok) {
      throw new Error(`[DockerPool] ps failed (${res.status}): ${res.body}`);
    }
    const list = res.json();
    return Array.isArray(list) ? list : [];
  }

  // -------------------------------------------------------------------------
  // start(name) — docker start <name>.
  //
  // POST /v1.41/containers/<name>/start
  // Returns 204 (already running) or 204/304 on success; throws on 404/500.
  // -------------------------------------------------------------------------
  async function start(name) {
    if (!name || typeof name !== "string") throw new Error("[DockerPool] start: name is required");
    const apiPath = `/${DOCKER_API_VERSION}/containers/${encodeURIComponent(name)}/start`;
    const res = await socketRequest("POST", apiPath);
    // 204 = started, 304 = already running — both are success for us.
    if (!res.ok && res.status !== 304) {
      throw new Error(`[DockerPool] start(${name}) failed (${res.status}): ${res.body}`);
    }
  }

  // -------------------------------------------------------------------------
  // stop(name, { graceful }) — docker stop <name>.
  //
  // POST /v1.41/containers/<name>/stop?t=<grace>
  // graceful:true uses stopGraceSeconds; graceful:false uses t=0 (immediate).
  // Returns 204 on success; 304 = already stopped (treated as success).
  // -------------------------------------------------------------------------
  async function stop(name, opts = {}) {
    if (!name || typeof name !== "string") throw new Error("[DockerPool] stop: name is required");
    const grace = opts.graceful === false ? 0 : stopGraceSeconds;
    const apiPath = `/${DOCKER_API_VERSION}/containers/${encodeURIComponent(name)}/stop?t=${grace}`;
    // Stop can take up to grace seconds + a margin before the daemon responds.
    const timeoutMs = Math.max(requestTimeoutMs, (grace + 5) * 1000);
    const res = await socketRequest("POST", apiPath, timeoutMs);
    // 204 = stopped, 304 = already stopped — both are OK.
    if (!res.ok && res.status !== 304) {
      throw new Error(`[DockerPool] stop(${name}) failed (${res.status}): ${res.body}`);
    }
  }

  // -------------------------------------------------------------------------
  // inspect(name) — docker inspect <name>.
  //
  // GET /v1.41/containers/<name>/json
  //
  // The spawn controller's verifyCap() reads:
  //   inspect.HostConfig.Memory     (must === workerMemBytes)
  //   inspect.HostConfig.MemorySwap (must === Memory, i.e. swap disabled)
  //
  // registerWorker() also reads inspect.Config for labels when Config exists.
  // We pass the full Docker inspect JSON through verbatim.
  // -------------------------------------------------------------------------
  async function inspect(name) {
    if (!name || typeof name !== "string")
      throw new Error("[DockerPool] inspect: name is required");
    const apiPath = `/${DOCKER_API_VERSION}/containers/${encodeURIComponent(name)}/json`;
    const res = await socketRequest("GET", apiPath);
    if (!res.ok) {
      throw new Error(`[DockerPool] inspect(${name}) failed (${res.status}): ${res.body}`);
    }
    return res.json();
  }

  // -------------------------------------------------------------------------
  // subscribeEvents(handler) — stream docker events for pool containers.
  //
  // GET /v1.41/events?filters={"type":["container"],"label":["com.ofc.pool=worker"]}
  //
  // The Docker /events endpoint streams ndjson indefinitely.  We read it in
  // streaming mode (no body buffering) and invoke handler(event) for each
  // parsed event.  On connection error/end we reconnect after a short delay
  // (the daemon may briefly restart; the spawn controller must keep receiving
  // die/oom/stop events).
  //
  // The controller's onDockerEvent reads:
  //   evt.Action / evt.action           (die | oom | stop | kill)
  //   evt.Actor.Attributes.name         (container name)
  //   evt.name                          (fallback)
  //   evt.id                            (fallback)
  //
  // Returns an unsubscribe function.  Calling it destroys the in-flight
  // request and cancels the reconnect timer so the loop terminates cleanly.
  // -------------------------------------------------------------------------
  function subscribeEvents(handler) {
    if (typeof handler !== "function")
      throw new Error("[DockerPool] subscribeEvents: handler must be a function");

    const filters = {
      type: ["container"],
      label: ["com.ofc.pool=worker"],
    };
    const apiPath = `/${DOCKER_API_VERSION}/events?filters=` + encodeFilters(filters);

    let active = true;
    let currentReq = null;
    let reconnectTimer = null;

    function connect() {
      if (!active) return;

      let remainder = "";

      const req = requestFn(
        {
          socketPath,
          path: apiPath,
          method: "GET",
          headers: { Host: "docker" },
        },
        (res) => {
          // Docker /events returns 200 and streams indefinitely.
          if (res.statusCode !== 200) {
            // Unexpected status — drain and schedule reconnect.
            res.resume();
            scheduleReconnect();
            return;
          }
          res.on("data", (chunk) => {
            if (!active) return;
            const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
            const { events, remainder: rem } = parseNdjsonChunk(text, remainder);
            remainder = rem;
            for (const evt of events) {
              try {
                handler(evt);
              } catch (_) {
                // handler errors must never crash the stream
              }
            }
          });
          res.on("end", () => {
            // Docker daemon closed the stream — reconnect.
            scheduleReconnect();
          });
          res.on("error", () => {
            scheduleReconnect();
          });
        },
      );

      req.on("error", () => {
        scheduleReconnect();
      });
      req.end();
      currentReq = req;
    }

    function scheduleReconnect() {
      if (!active) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, EVENTS_RECONNECT_DELAY_MS);
    }

    connect();

    // Return unsubscribe.
    return function unsubscribe() {
      active = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (currentReq) {
        try {
          currentReq.destroy();
        } catch (_) {}
        currentReq = null;
      }
    };
  }

  return { ps, start, stop, inspect, subscribeEvents };
}

module.exports = {
  createDockerPool,
  encodeFilters,
  parseNdjsonChunk,
  DEFAULT_STOP_GRACE_SECONDS,
  EVENTS_RECONNECT_DELAY_MS,
};
