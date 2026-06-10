/**
 * Mesh networking backend for Open Fleet Control.
 *
 * Maintains a registry of fleet nodes (persisted atomically to
 * state/mesh-nodes.json), polls each registered node's health endpoint over
 * the tailnet, tracks latency history for sparklines, and aggregates
 * best-effort cost rollups from remote command-center /api/state endpoints.
 *
 * Node URLs are composed at runtime from the MagicDNS suffix reported by the
 * tailscale adapter — no tailnet name is ever hardcoded, and no tokens are
 * stored in this module.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createTailscaleAdapter } = require("./tailscale");

const REGISTRY_FILENAME = "mesh-nodes.json";
const DEFAULT_INTERVAL_MS = 15000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5000;
const LATENCY_SAMPLE_LIMIT = 60; // ring buffer size for sparklines
const VALID_PLATFORMS = ["linux", "windows-wsl", "macos", "unknown"];
const HOSTNAME_PATTERN = /^[a-z0-9-]+$/;
const MAX_LABEL_LENGTH = 120;

/**
 * Compose a node URL at runtime: https://<hostname>.<magicDnsSuffix>[:port]<path>
 * The port is omitted when it is 443 (https default).
 *
 * @param {object} node - node record ({hostname, port, protocol, healthPath})
 * @param {string} magicDnsSuffix - suffix from tailscale ("" for bare hostname)
 * @param {string} [pathOverride] - path to use instead of node.healthPath
 * @returns {string}
 */
function composeNodeUrl(node, magicDnsSuffix, pathOverride) {
  const host = magicDnsSuffix ? `${node.hostname}.${magicDnsSuffix}` : node.hostname;
  const portPart = node.port === 443 ? "" : `:${node.port}`;
  const urlPath = pathOverride !== undefined ? pathOverride : node.healthPath;
  return `${node.protocol}://${host}${portPart}${urlPath}`;
}

/**
 * Validate raw registerNode() input and return a normalized node shape
 * (without id / registeredAt — those are added by registerNode).
 * Throws an Error with a clear message on any invalid field.
 *
 * @param {object} input
 * @returns {{hostname: string, port: number, protocol: "https", healthPath: string, platform: string, label: string, registeredBy: string}}
 */
function validateNodeInput(input) {
  if (!input || typeof input !== "object") {
    throw new Error("registerNode requires an options object");
  }

  const { hostname, port = 443, healthPath = "/health", platform = "unknown" } = input;

  if (typeof hostname !== "string" || !HOSTNAME_PATTERN.test(hostname)) {
    throw new Error(
      `Invalid hostname: must be lowercase letters, digits, and hyphens only (got ${JSON.stringify(hostname)})`,
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: must be an integer between 1 and 65535 (got ${port})`);
  }
  if (typeof healthPath !== "string" || !healthPath.startsWith("/")) {
    throw new Error(`Invalid healthPath: must be a string starting with "/" (got ${healthPath})`);
  }
  if (!VALID_PLATFORMS.includes(platform)) {
    throw new Error(
      `Invalid platform: must be one of ${VALID_PLATFORMS.join(", ")} (got ${platform})`,
    );
  }
  if (input.label !== undefined && typeof input.label !== "string") {
    throw new Error("Invalid label: must be a string");
  }
  if (input.label && input.label.length > MAX_LABEL_LENGTH) {
    throw new Error(`Invalid label: must be at most ${MAX_LABEL_LENGTH} characters`);
  }
  if (input.registeredBy !== undefined && typeof input.registeredBy !== "string") {
    throw new Error("Invalid registeredBy: must be a string");
  }

  return {
    hostname,
    port,
    protocol: "https",
    healthPath,
    platform,
    label: input.label || hostname,
    registeredBy: input.registeredBy || "unknown",
  };
}

/**
 * First finite number among the candidates, or null.
 */
function pickNumber(...candidates) {
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Best-effort extraction of llm-usage / cost totals from a remote
 * command-center /api/state payload. Tolerates any shape mismatch (nulls).
 *
 * @param {object|null} state - remote /api/state response body
 * @returns {{cost24h: number|null, cost7d: number|null, totalTokens: number|null, version: string|null}|null}
 */
function extractNodeCosts(state) {
  if (!state || typeof state !== "object") return null;
  const llmUsage = state.llmUsage && typeof state.llmUsage === "object" ? state.llmUsage : {};
  const tokenStats =
    state.tokenStats && typeof state.tokenStats === "object" ? state.tokenStats : {};
  return {
    cost24h: pickNumber(llmUsage.usage24h?.cost, llmUsage.cost24h, tokenStats.cost24h),
    cost7d: pickNumber(llmUsage.usage7d?.cost, llmUsage.cost7d, tokenStats.cost7d),
    totalTokens: pickNumber(tokenStats.totalTokens, tokenStats.total, llmUsage.totalTokens),
    version: typeof state.version === "string" ? state.version : null,
  };
}

function createInitialHealth() {
  return {
    status: "unknown",
    latencyMs: null,
    lastChecked: null,
    lastOnline: null,
    consecutiveFailures: 0,
    latencySamples: [],
    version: null,
  };
}

/**
 * Create the mesh module with injectable dependencies.
 *
 * @param {object} options
 * @param {string} options.stateDir - directory for mesh-nodes.json persistence
 * @param {string} [options.configDir] - reserved for future config (unused)
 * @param {number} [options.intervalMs] - health poll interval (default 15s)
 * @param {number} [options.healthTimeoutMs] - per-request timeout (default 5s)
 * @param {function} [options.fetchFn] - fetch-compatible function (injectable)
 * @param {object} [options.tailscale] - tailscale adapter ({getStatus})
 * @param {function} [options.onChange] - callback({node, previousStatus, status, health}) fired when a node's status changes
 * @param {function} [options.nowFn] - clock function (default Date.now)
 * @returns {{start, stop, getState, registerNode, unregisterNode, discoverPeers, getFleetCosts, collectNodeStats, _pollOnce}}
 */
function createMesh(options = {}) {
  const {
    stateDir,
    intervalMs = DEFAULT_INTERVAL_MS,
    healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
    fetchFn = (...args) => globalThis.fetch(...args),
    tailscale = createTailscaleAdapter(),
    onChange = null,
    nowFn = Date.now,
  } = options;

  if (!stateDir || typeof stateDir !== "string") {
    throw new Error("createMesh requires a stateDir string");
  }

  const registryFile = path.join(stateDir, REGISTRY_FILENAME);

  // Module-level state
  let nodes = loadRegistry();
  const health = {}; // nodeId -> health record (records replaced immutably)
  let pollTimer = null;

  // ---------------------------------------------------------------------
  // Registry persistence (atomic: temp file + rename)
  // ---------------------------------------------------------------------

  function loadRegistry() {
    try {
      if (!fs.existsSync(registryFile)) return [];
      const raw = JSON.parse(fs.readFileSync(registryFile, "utf8"));
      const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.nodes) ? raw.nodes : [];
      return list.filter((n) => n && typeof n === "object" && typeof n.hostname === "string");
    } catch (e) {
      console.error(`[Mesh] Failed to load registry from ${registryFile}:`, e.message);
      return [];
    }
  }

  function saveRegistry() {
    fs.mkdirSync(stateDir, { recursive: true });
    const tmpFile = `${registryFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmpFile, JSON.stringify({ nodes }, null, 2));
    fs.renameSync(tmpFile, registryFile);
  }

  // ---------------------------------------------------------------------
  // Registry CRUD
  // ---------------------------------------------------------------------

  /**
   * Register a fleet node. Validates all inputs; throws on invalid input
   * or duplicate hostname. Returns the persisted node record.
   */
  function registerNode(input) {
    const validated = validateNodeInput(input);
    if (nodes.some((n) => n.hostname === validated.hostname)) {
      throw new Error(`Node already registered: ${validated.hostname}`);
    }
    const record = {
      id: crypto.randomUUID(),
      ...validated,
      registeredAt: new Date(nowFn()).toISOString(),
    };
    nodes = [...nodes, record];
    saveRegistry();
    return record;
  }

  /**
   * Unregister a node by id or hostname. Throws when not found.
   * Returns the removed record.
   */
  function unregisterNode(idOrHostname) {
    const target = nodes.find((n) => n.id === idOrHostname || n.hostname === idOrHostname);
    if (!target) {
      throw new Error(`Unknown node: ${idOrHostname}`);
    }
    nodes = nodes.filter((n) => n.id !== target.id);
    delete health[target.id];
    saveRegistry();
    return target;
  }

  // ---------------------------------------------------------------------
  // Health polling
  // ---------------------------------------------------------------------

  function timeoutSignal(ms) {
    if (globalThis.AbortSignal && typeof globalThis.AbortSignal.timeout === "function") {
      return globalThis.AbortSignal.timeout(ms);
    }
    return undefined;
  }

  function emitChange(node, previousStatus, nextHealth) {
    if (typeof onChange !== "function") return;
    try {
      onChange({ node, previousStatus, status: nextHealth.status, health: nextHealth });
    } catch (e) {
      console.error("[Mesh] onChange callback failed:", e.message);
    }
  }

  /**
   * Best-effort GET of a node's /api/state. Returns parsed body or null.
   */
  async function fetchNodeState(node, magicDnsSuffix) {
    try {
      const url = composeNodeUrl(node, magicDnsSuffix, "/api/state");
      const res = await fetchFn(url, { signal: timeoutSignal(healthTimeoutMs) });
      if (!res || res.ok !== true) return null;
      return await res.json();
    } catch (e) {
      // Best-effort only — version/cost fetch failures never fail health
      return null;
    }
  }

  function failureHealth(prev, peer, checkedAt) {
    // Connection refused / timeout while the tailscale peer reports
    // Online=true means the host is up but the service is not exposed
    // (likely missing serve config) => "unreachable".
    // Peer Online=false => the host itself is "offline".
    const status = peer && peer.online === false ? "offline" : "unreachable";
    return {
      status,
      latencyMs: null,
      lastChecked: checkedAt,
      lastOnline: prev.lastOnline,
      consecutiveFailures: prev.consecutiveFailures + 1,
      latencySamples: prev.latencySamples,
      version: prev.version,
    };
  }

  async function pollNode(node, tsStatus) {
    const suffix = tsStatus.available && tsStatus.self ? tsStatus.self.magicDnsSuffix : "";
    const peer =
      tsStatus.available && Array.isArray(tsStatus.peers)
        ? tsStatus.peers.find((p) => p.hostname === node.hostname)
        : null;
    const prev = health[node.id] || createInitialHealth();
    const startedAt = nowFn();
    let next;

    try {
      const url = composeNodeUrl(node, suffix);
      const res = await fetchFn(url, { signal: timeoutSignal(healthTimeoutMs) });
      const latencyMs = nowFn() - startedAt;

      if (res && res.ok === true) {
        let version = prev.version;
        let body = null;
        try {
          body = await res.json();
        } catch (e) {
          // Health endpoint may not return JSON — that's fine
        }
        if (body && typeof body.version === "string") {
          version = body.version;
        } else if (version === null) {
          // Cheap one-time version probe via /api/state (never fails health)
          const remoteState = await fetchNodeState(node, suffix);
          if (remoteState && typeof remoteState.version === "string") {
            version = remoteState.version;
          }
        }
        next = {
          status: "online",
          latencyMs,
          lastChecked: startedAt,
          lastOnline: startedAt,
          consecutiveFailures: 0,
          latencySamples: [...prev.latencySamples, latencyMs].slice(-LATENCY_SAMPLE_LIMIT),
          version,
        };
      } else {
        next = failureHealth(prev, peer, startedAt);
      }
    } catch (e) {
      next = failureHealth(prev, peer, startedAt);
    }

    health[node.id] = next;
    if (prev.status !== next.status) {
      emitChange(node, prev.status, next);
    }
  }

  /**
   * Run one full poll cycle across all registered nodes.
   * Exposed for testing (matches the repo's _resetForTesting convention).
   */
  async function _pollOnce() {
    const tsStatus = await tailscale.getStatus();
    await Promise.all(nodes.map((node) => pollNode(node, tsStatus)));
  }

  function start() {
    if (pollTimer) return;
    _pollOnce().catch((e) => console.error("[Mesh] Poll failed:", e.message));
    pollTimer = setInterval(() => {
      _pollOnce().catch((e) => console.error("[Mesh] Poll failed:", e.message));
    }, intervalMs);
    if (typeof pollTimer.unref === "function") pollTimer.unref();
    console.log(`[Mesh] Health poller started (${intervalMs}ms interval)`);
  }

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      console.log("[Mesh] Health poller stopped");
    }
  }

  // ---------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------

  /**
   * Merge tailscale peers with the registry into a candidates list,
   * each flagged registered/unregistered.
   */
  async function discoverPeers() {
    const tsStatus = await tailscale.getStatus();
    if (!tsStatus.available) {
      return {
        available: false,
        error: tsStatus.error || "tailscale unavailable",
        candidates: nodes.map((n) => ({
          hostname: n.hostname,
          fqdn: null,
          ips: [],
          online: null,
          os: n.platform,
          lastSeen: null,
          registered: true,
          nodeId: n.id,
        })),
      };
    }

    const candidates = tsStatus.peers.map((peer) => {
      const registeredNode = nodes.find((n) => n.hostname === peer.hostname);
      return {
        hostname: peer.hostname,
        fqdn: peer.fqdn,
        ips: peer.ips,
        online: peer.online,
        os: peer.os,
        lastSeen: peer.lastSeen,
        registered: !!registeredNode,
        nodeId: registeredNode ? registeredNode.id : null,
      };
    });

    // Registered nodes that have no matching tailscale peer
    const peerHostnames = new Set(tsStatus.peers.map((p) => p.hostname));
    const orphans = nodes
      .filter((n) => !peerHostnames.has(n.hostname))
      .map((n) => ({
        hostname: n.hostname,
        fqdn: null,
        ips: [],
        online: null,
        os: n.platform,
        lastSeen: null,
        registered: true,
        nodeId: n.id,
      }));

    return { available: true, candidates: [...candidates, ...orphans] };
  }

  // ---------------------------------------------------------------------
  // Cost rollup
  // ---------------------------------------------------------------------

  /**
   * Best-effort collection of one node's command-center stats
   * (llm-usage / cost totals from its /api/state). Returns nulls on any
   * shape mismatch; never throws.
   */
  async function collectNodeStats(node) {
    const tsStatus = await tailscale.getStatus();
    const suffix = tsStatus.available && tsStatus.self ? tsStatus.self.magicDnsSuffix : "";
    const remoteState = await fetchNodeState(node, suffix);
    return extractNodeCosts(remoteState);
  }

  /**
   * Aggregate cost stats across all registered nodes.
   * @returns {Promise<{byNode: object, totals: {cost24h: number, cost7d: number, nodesReporting: number}}>}
   */
  async function getFleetCosts() {
    const results = await Promise.all(
      nodes.map(async (node) => ({ node, stats: await collectNodeStats(node) })),
    );

    const byNode = {};
    let cost24h = 0;
    let cost7d = 0;
    let nodesReporting = 0;

    for (const { node, stats } of results) {
      byNode[node.id] = { hostname: node.hostname, label: node.label, stats };
      if (stats && (stats.cost24h !== null || stats.cost7d !== null)) {
        nodesReporting++;
        if (stats.cost24h !== null) cost24h += stats.cost24h;
        if (stats.cost7d !== null) cost7d += stats.cost7d;
      }
    }

    return { byNode, totals: { cost24h, cost7d, nodesReporting } };
  }

  // ---------------------------------------------------------------------
  // State snapshot for the UI
  // ---------------------------------------------------------------------

  /**
   * Everything the UI needs: self identity, registered nodes with health +
   * sparkline data + version, and discovery candidates.
   */
  async function getState() {
    const [tsStatus, discovery] = await Promise.all([tailscale.getStatus(), discoverPeers()]);
    const suffix = tsStatus.available && tsStatus.self ? tsStatus.self.magicDnsSuffix : "";

    return {
      self: tsStatus.available ? tsStatus.self : null,
      tailscale: {
        available: tsStatus.available,
        error: tsStatus.available ? null : tsStatus.error,
      },
      nodes: nodes.map((node) => ({
        ...node,
        url: composeNodeUrl(node, suffix),
        health: health[node.id] || createInitialHealth(),
      })),
      candidates: discovery.candidates,
      intervalMs,
      timestamp: nowFn(),
    };
  }

  return {
    start,
    stop,
    getState,
    registerNode,
    unregisterNode,
    discoverPeers,
    getFleetCosts,
    collectNodeStats,
    _pollOnce,
  };
}

module.exports = {
  createMesh,
  composeNodeUrl,
  validateNodeInput,
  extractNodeCosts,
  LATENCY_SAMPLE_LIMIT,
  VALID_PLATFORMS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_HEALTH_TIMEOUT_MS,
};
