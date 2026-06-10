/**
 * Docker containers backend for Open Fleet Control — READ-ONLY.
 *
 * Talks to the Docker Engine API over the unix socket using node's http
 * module (no npm deps). Read-only is enforced by construction: the only
 * request primitive in this module issues GET requests — there is no code
 * path through which a caller can supply an HTTP method.
 *
 * Endpoints used (all GET):
 *   /v1.41/containers/json?all=true      — container list
 *   /v1.41/containers/<id>/json          — inspect (restart count, health, startedAt)
 *   /v1.41/containers/<id>/stats?stream=false — one-shot stats (cpu/mem)
 *
 * A poller caches a snapshot every intervalMs; getState() returns the cache
 * synchronously. onChange fires whenever a container's state or health
 * transitions (for SSE "fleet.docker" + alert wiring by the orchestrator).
 *
 * Portainer deep links: the optional {portainerUrl} config option is echoed
 * in getState() only while a running portainer container is detected — the
 * UI derives per-container links from it. Nothing is ever hardcoded here;
 * when the option is unset, links are simply omitted.
 */

const http = require("http");

const DOCKER_API_VERSION = "v1.41";
const DEFAULT_SOCKET_PATH = "/var/run/docker.sock";
const DEFAULT_INTERVAL_MS = 15000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const STATS_CONCURRENCY = 3;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Health from the inspect State.Health.Status (authoritative) or the list
 * Status string, e.g. "Up 41 hours (healthy)". Returns
 * "healthy" | "unhealthy" | "starting" | null (no healthcheck configured).
 *
 * @param {string|null|undefined} statusText - containers/json Status string
 * @param {string|null|undefined} inspectHealth - inspect State.Health.Status
 * @returns {string|null}
 */
function parseHealth(statusText, inspectHealth) {
  if (typeof inspectHealth === "string") {
    const normalized = inspectHealth.toLowerCase();
    if (["healthy", "unhealthy", "starting"].includes(normalized)) return normalized;
    if (normalized === "none") return null;
  }
  if (typeof statusText === "string") {
    const match = statusText.match(/\((healthy|unhealthy|health: starting)\)/i);
    if (match) {
      const token = match[1].toLowerCase();
      return token === "health: starting" ? "starting" : token;
    }
  }
  return null;
}

/**
 * Standard docker CPU% delta formula:
 *   (cpu_delta / system_delta) * online_cpus * 100
 * Returns null when the stats payload lacks the required counters
 * (e.g. stopped container or stats fetch failure).
 *
 * @param {object|null} stats - one-shot stats payload
 * @returns {number|null}
 */
function computeCpuPct(stats) {
  const cpu = stats && stats.cpu_stats;
  const pre = stats && stats.precpu_stats;
  const cpuTotal = cpu && cpu.cpu_usage && cpu.cpu_usage.total_usage;
  const preTotal = pre && pre.cpu_usage && pre.cpu_usage.total_usage;
  const sysNow = cpu && cpu.system_cpu_usage;
  const sysPre = pre && pre.system_cpu_usage;
  if (![cpuTotal, preTotal, sysNow, sysPre].every((v) => Number.isFinite(v))) return null;

  const cpuDelta = cpuTotal - preTotal;
  const systemDelta = sysNow - sysPre;
  if (cpuDelta <= 0 || systemDelta <= 0) return 0;

  const onlineCpus =
    (Number.isFinite(cpu.online_cpus) && cpu.online_cpus > 0 && cpu.online_cpus) ||
    (Array.isArray(cpu.cpu_usage.percpu_usage) && cpu.cpu_usage.percpu_usage.length) ||
    1;
  return (cpuDelta / systemDelta) * onlineCpus * 100;
}

/**
 * Memory usage the way `docker stats` reports it: usage minus the page
 * cache (cgroup v2 exposes inactive_file, v1 exposes cache).
 *
 * @param {object|null} stats - one-shot stats payload
 * @returns {{memUsageBytes: number|null, memLimitBytes: number|null, memPct: number|null}}
 */
function computeMemStats(stats) {
  const mem = stats && stats.memory_stats;
  if (!mem || !Number.isFinite(mem.usage)) {
    return { memUsageBytes: null, memLimitBytes: null, memPct: null };
  }
  const detail = mem.stats && typeof mem.stats === "object" ? mem.stats : {};
  const cacheBytes = Number.isFinite(detail.inactive_file)
    ? detail.inactive_file
    : Number.isFinite(detail.cache)
      ? detail.cache
      : 0;
  const memUsageBytes = Math.max(0, mem.usage - cacheBytes);
  const memLimitBytes = Number.isFinite(mem.limit) && mem.limit > 0 ? mem.limit : null;
  const memPct = memLimitBytes !== null ? (memUsageBytes / memLimitBytes) * 100 : null;
  return { memUsageBytes, memLimitBytes, memPct };
}

/**
 * Human "host:public→private/proto" summaries from a containers/json Ports
 * array. Wildcard binds (0.0.0.0 / ::) drop the IP; IPv4/IPv6 duplicates of
 * the same published port collapse into one entry.
 *
 * @param {Array|null|undefined} ports
 * @returns {string[]}
 */
function summarizePorts(ports) {
  if (!Array.isArray(ports)) return [];
  const seen = new Set();
  const out = [];
  for (const port of ports) {
    if (!port || !Number.isFinite(port.PrivatePort)) continue;
    const type = port.Type || "tcp";
    let summary;
    if (Number.isFinite(port.PublicPort)) {
      const host = port.IP && port.IP !== "0.0.0.0" && port.IP !== "::" ? `${port.IP}:` : "";
      summary = `${host}${port.PublicPort}→${port.PrivatePort}/${type}`;
    } else {
      summary = `${port.PrivatePort}/${type}`;
    }
    if (!seen.has(summary)) {
      seen.add(summary);
      out.push(summary);
    }
  }
  return out;
}

/** True when the container record looks like a running Portainer instance. */
function isRunningPortainer(container) {
  if (!container || container.state !== "running") return false;
  const image = String(container.image || "").toLowerCase();
  const name = String(container.name || "").toLowerCase();
  return image.startsWith("portainer/") || image.includes("/portainer") || name === "portainer";
}

/** Run fn over items with at most `limit` in flight at once. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Map a socket-level error to a clear operator-facing diagnostic. */
function describeSocketError(err, socketPath) {
  const code = err && err.code;
  if (code === "ENOENT") return `Docker socket not found at ${socketPath}`;
  if (code === "EACCES" || code === "EPERM") {
    return `Permission denied on ${socketPath} — is this user in the docker group?`;
  }
  if (code === "ECONNREFUSED") return `Docker daemon not responding on ${socketPath}`;
  return (err && err.message) || "Docker API request failed";
}

// ---------------------------------------------------------------------------
// Module factory
// ---------------------------------------------------------------------------

/**
 * Default transport: GET over the unix socket via node http.
 * Returns a fetch-shaped response ({ok, status, json()}).
 */
function createSocketFetch(socketPath, timeoutMs) {
  return function socketFetch(apiPath) {
    return new Promise((resolve, reject) => {
      const request = http.request(
        // Method is a literal — never caller-supplied (read-only guarantee).
        { socketPath, path: apiPath, method: "GET", headers: { Host: "docker" } },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            resolve({
              ok: response.statusCode >= 200 && response.statusCode < 300,
              status: response.statusCode,
              json: async () => JSON.parse(body),
            });
          });
          response.on("error", reject);
        },
      );
      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error(`Docker API timeout after ${timeoutMs}ms (${apiPath})`));
      });
      request.on("error", reject);
      request.end();
    });
  };
}

/**
 * Create the docker module with injectable dependencies.
 *
 * @param {object} [options]
 * @param {string} [options.socketPath] - docker unix socket (default /var/run/docker.sock)
 * @param {function} [options.fetchFn] - fetch-shaped transport (apiPath, {method:"GET"}) => {ok, status, json()}
 * @param {number} [options.intervalMs] - poll interval (default 15s)
 * @param {number} [options.requestTimeoutMs] - per-request timeout for the default transport
 * @param {function} [options.onChange] - callback({container, previousState, previousHealth}) on state/health transitions
 * @param {string|null} [options.portainerUrl] - base URL of the Portainer UI for deep links (omit to disable)
 * @param {function} [options.nowFn] - clock (default Date.now)
 * @returns {{start, stop, getState, routes, _pollOnce}}
 */
function createDocker(options = {}) {
  const {
    socketPath = DEFAULT_SOCKET_PATH,
    intervalMs = DEFAULT_INTERVAL_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    onChange = null,
    portainerUrl = null,
    nowFn = Date.now,
  } = options;
  const fetchFn = options.fetchFn || createSocketFetch(socketPath, requestTimeoutMs);

  // Cached snapshot — replaced wholesale on every poll (immutably).
  let snapshot = {
    available: false,
    containers: [],
    lastChecked: null,
    error: null,
  };
  // id12 -> {state, health} from the last poll, for change detection.
  // Kept across outages so a daemon restart doesn't fire spurious events.
  let previousByid = new Map();
  let pollTimer = null;

  /**
   * The single request primitive. Always GET — the method is hardcoded at
   * both call sites (here and in the default transport), so no mutation can
   * ever be issued through this module.
   */
  async function dockerGet(apiPath) {
    const response = await fetchFn(apiPath, { method: "GET" });
    if (!response || response.ok !== true) {
      const status = response ? response.status : "no response";
      throw new Error(`Docker API ${apiPath} failed (${status})`);
    }
    return response.json();
  }

  function emitChange(container, previousState, previousHealth) {
    if (typeof onChange !== "function") return;
    try {
      onChange({ container, previousState, previousHealth });
    } catch (err) {
      console.error("[Docker] onChange callback failed:", err.message);
    }
  }

  /** Best-effort inspect — failures never drop the container from the list. */
  async function fetchInspect(id) {
    try {
      return await dockerGet(`/${DOCKER_API_VERSION}/containers/${id}/json`);
    } catch (err) {
      return null;
    }
  }

  /** Best-effort one-shot stats — per-container failures are tolerated. */
  async function fetchStats(id) {
    try {
      return await dockerGet(`/${DOCKER_API_VERSION}/containers/${id}/stats?stream=false`);
    } catch (err) {
      return null;
    }
  }

  /** Merge list + inspect + stats payloads into one cached container record. */
  function buildContainerRecord(listed, inspect, stats) {
    const id = listed.Id || "";
    const rawName = Array.isArray(listed.Names) && listed.Names[0] ? listed.Names[0] : id;
    const inspectState = inspect && inspect.State && typeof inspect.State === "object";
    const startedAtRaw = inspectState ? inspect.State.StartedAt : null;
    const startedAt =
      typeof startedAtRaw === "string" && !startedAtRaw.startsWith("0001-") ? startedAtRaw : null;
    const inspectHealth =
      inspectState && inspect.State.Health && typeof inspect.State.Health === "object"
        ? inspect.State.Health.Status
        : null;
    const { memUsageBytes, memLimitBytes, memPct } = computeMemStats(stats);

    return {
      id,
      id12: id.slice(0, 12),
      name: rawName.replace(/^\//, ""),
      image: listed.Image || "",
      state: listed.State || "unknown",
      status: listed.Status || "",
      health: parseHealth(listed.Status, inspectHealth),
      createdAt: Number.isFinite(listed.Created)
        ? new Date(listed.Created * 1000).toISOString()
        : null,
      startedAt,
      restartCount: inspect && Number.isFinite(inspect.RestartCount) ? inspect.RestartCount : null,
      ports: summarizePorts(listed.Ports),
      cpuPct: computeCpuPct(stats),
      memUsageBytes,
      memLimitBytes,
      memPct,
    };
  }

  /**
   * One full poll cycle: list, then per-container inspect + stats with a
   * concurrency cap of STATS_CONCURRENCY. Exposed for testing.
   */
  async function _pollOnce() {
    const checkedAt = nowFn();
    let listed;
    try {
      listed = await dockerGet(`/${DOCKER_API_VERSION}/containers/json?all=true`);
    } catch (err) {
      snapshot = {
        available: false,
        containers: [],
        lastChecked: checkedAt,
        error: describeSocketError(err, socketPath),
      };
      return snapshot;
    }
    const list = Array.isArray(listed) ? listed.filter((c) => c && typeof c === "object") : [];

    const containers = await mapWithConcurrency(list, STATS_CONCURRENCY, async (item) => {
      const id = item.Id || "";
      const [inspect, stats] = await Promise.all([
        fetchInspect(id),
        item.State === "running" ? fetchStats(id) : Promise.resolve(null),
      ]);
      return buildContainerRecord(item, inspect, stats);
    });

    // Change detection (state or health transitions, plus appear/disappear).
    const nextById = new Map();
    for (const container of containers) {
      nextById.set(container.id12, { state: container.state, health: container.health });
      const prev = previousByid.get(container.id12);
      if (!prev || prev.state !== container.state || prev.health !== container.health) {
        emitChange(container, prev ? prev.state : null, prev ? prev.health : null);
      }
    }
    for (const [id12, prev] of previousByid) {
      if (!nextById.has(id12)) {
        emitChange({ id12, state: "removed", health: null }, prev.state, prev.health);
      }
    }
    previousByid = nextById;

    snapshot = { available: true, containers, lastChecked: checkedAt, error: null };
    return snapshot;
  }

  /**
   * Cached snapshot for the UI. portainerUrl is only exposed while a running
   * portainer container is detected (fallback: the panel omits links).
   */
  function getState() {
    const portainerDetected = snapshot.containers.some(isRunningPortainer);
    return {
      ...snapshot,
      containers: [...snapshot.containers],
      portainerUrl: portainerUrl && portainerDetected ? portainerUrl : null,
      intervalMs,
    };
  }

  function start() {
    if (pollTimer) return;
    _pollOnce().catch((err) => console.error("[Docker] Poll failed:", err.message));
    pollTimer = setInterval(() => {
      _pollOnce().catch((err) => console.error("[Docker] Poll failed:", err.message));
    }, intervalMs);
    if (typeof pollTimer.unref === "function") pollTimer.unref();
    console.log(`[Docker] Container poller started (${intervalMs}ms interval)`);
  }

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      console.log("[Docker] Container poller stopped");
    }
  }

  // Routes map for trivial orchestrator wiring (fleet-routes handler shape:
  // the handler writes the full JSON response itself).
  const routes = {
    "GET /api/docker": async (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getState(), null, 2));
    },
  };

  return { start, stop, getState, routes, _pollOnce };
}

module.exports = {
  createDocker,
  parseHealth,
  computeCpuPct,
  computeMemStats,
  summarizePorts,
  isRunningPortainer,
  DOCKER_API_VERSION,
  DEFAULT_INTERVAL_MS,
  STATS_CONCURRENCY,
};
