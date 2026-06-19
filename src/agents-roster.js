/**
 * Unified Agents roster for Open Fleet Control — READ-ONLY.
 *
 * Local roster: parses the OpenClaw config (~/.openclaw/openclaw.json,
 * agents.list) into normalized agent records and enriches each one with
 * session activity from <agentsDir>/<id>/sessions/ (session count, latest
 * session mtime → lastActiveAt, active when the latest session is fresher
 * than ACTIVE_THRESHOLD_MS). Missing directories and malformed config are
 * tolerated by construction — every failure degrades to an empty roster or
 * zeroed enrichment, never a throw.
 *
 * Local source selection (config fleet.agents.source):
 *   "openclaw" (default) — openclaw.json + per-agent session dirs as above.
 *   "hermes"             — Hermes-system agents via src/hermes-agents.js
 *                          (config fleet.agents.hermesDir, default ~/.hermes).
 *   "none"               — empty local roster (pure aggregator instance).
 *
 * Fleet aggregation: when a mesh module is supplied, every ONLINE registered
 * node is queried best-effort for GET <node-base>/api/agents (the same
 * local-only endpoint this dashboard exposes) and merged with node
 * attribution. Older nodes that 404 the endpoint are silently skipped. When a
 * federationStateFn is supplied, every REACHABLE federation remote is queried
 * the same way (federation remotes live outside the mesh — e.g. another OFC
 * instance on a different tailnet) and deduped against mesh nodes by
 * hostname. The aggregated result is cached for FLEET_CACHE_MS.
 *
 * Routes (handler shape mirrors src/docker.js: the handler writes the full
 * JSON response itself):
 *   GET /api/agents       — local-only roster (what remote dashboards call)
 *   GET /api/agents/fleet — fleet-wide aggregation (+ assignees for kanban)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const { createHermesAgents } = require("./hermes-agents");

const AGENT_SOURCES = ["openclaw", "hermes", "none"];

const ACTIVE_THRESHOLD_MS = 10 * 60 * 1000; // active = session touched <10min ago
const FLEET_CACHE_MS = 60 * 1000;
const REMOTE_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Normalize a parsed openclaw.json into agent records.
 * Tolerates any malformed shape — always returns an array.
 *
 * @param {object|null|undefined} config - parsed openclaw.json body
 * @returns {Array<{id: string, name: string, model: string|null, workspace: string|null, subagentsMax: number|null}>}
 */
function parseAgentsConfig(config) {
  const agents = config && typeof config === "object" ? config.agents : null;
  if (!agents || typeof agents !== "object" || !Array.isArray(agents.list)) return [];

  const defaults = agents.defaults && typeof agents.defaults === "object" ? agents.defaults : {};
  const defaultModel =
    typeof defaults.model === "string"
      ? defaults.model
      : defaults.model && typeof defaults.model.primary === "string"
        ? defaults.model.primary
        : null;
  const defaultWorkspace = typeof defaults.workspace === "string" ? defaults.workspace : null;
  const defaultSubagentsMax = Number.isFinite(defaults.subagents?.maxConcurrent)
    ? defaults.subagents.maxConcurrent
    : null;

  const records = [];
  for (const entry of agents.list) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id) continue;
    const subagentsMax = Number.isFinite(entry.subagents?.maxConcurrent)
      ? entry.subagents.maxConcurrent
      : defaultSubagentsMax;
    records.push({
      id: entry.id,
      name: typeof entry.name === "string" && entry.name ? entry.name : entry.id,
      model: typeof entry.model === "string" && entry.model ? entry.model : defaultModel,
      workspace:
        typeof entry.workspace === "string" && entry.workspace ? entry.workspace : defaultWorkspace,
      subagentsMax,
    });
  }
  return records;
}

/** True for real session transcripts; sidecar / deleted files are excluded. */
function isSessionFile(filename) {
  return (
    filename.endsWith(".jsonl") &&
    !filename.endsWith(".trajectory.jsonl") &&
    !filename.includes(".deleted.")
  );
}

/**
 * Scan one agent's sessions directory. Missing/unreadable dirs degrade to a
 * zeroed summary — never throws.
 *
 * @param {string} sessionsDir
 * @returns {{sessionCount: number, lastActiveAt: number|null}}
 */
function scanSessionsDir(sessionsDir) {
  let files;
  try {
    files = fs.readdirSync(sessionsDir);
  } catch (err) {
    return { sessionCount: 0, lastActiveAt: null };
  }

  let sessionCount = 0;
  let lastActiveAt = null;
  for (const file of files) {
    if (!isSessionFile(file)) continue;
    sessionCount++;
    try {
      const mtimeMs = fs.statSync(path.join(sessionsDir, file)).mtimeMs;
      if (lastActiveAt === null || mtimeMs > lastActiveAt) lastActiveAt = mtimeMs;
    } catch (err) {
      // File vanished between readdir and stat — still counts as a session.
    }
  }
  return { sessionCount, lastActiveAt };
}

/**
 * Origin (protocol://host[:port]) of a node URL — strips the health path so
 * /api/agents can be composed against the node's base.
 *
 * @param {string} nodeUrl
 * @returns {string|null} null when the URL is malformed
 */
function nodeBaseUrl(nodeUrl) {
  try {
    return new URL(nodeUrl).origin;
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Module factory
// ---------------------------------------------------------------------------

/**
 * Default fleet.agents config from the singleton CONFIG. Lazy-required so
 * test suites that inject agentsConfig never load the config singleton.
 * @returns {object}
 */
function defaultAgentsConfig() {
  try {
    const { CONFIG } = require("./config");
    return (CONFIG && CONFIG.fleet && CONFIG.fleet.agents) || {};
  } catch (err) {
    return {};
  }
}

/**
 * Create the agents roster module with injectable dependencies.
 *
 * @param {object} options
 * @param {string} [options.openclawConfigPath] - path to openclaw.json (required for source "openclaw")
 * @param {string} [options.agentsDir] - path to the agents directory (~/.openclaw/agents)
 * @param {object} [options.mesh] - mesh module ({getState}) for fleet aggregation
 * @param {function} [options.federationStateFn] - async () => federation getState()
 *        shape ({remotes: [{baseUrl, label, status: {reachable}}]}); reachable
 *        remotes are queried for GET <baseUrl>/api/agents and merged
 * @param {object} [options.agentsConfig] - fleet.agents config section
 *        ({source, openclawConfigPath, agentsDir, hermesDir}); defaults to
 *        CONFIG.fleet.agents so wiring needs no index.js change
 * @param {object} [options.hermesAgents] - hermes adapter ({listAgents}) override (tests)
 * @param {function} [options.fetchFn] - fetch-compatible transport (injectable)
 * @param {function} [options.nowFn] - clock (default Date.now)
 * @param {string} [options.hostname] - this node's name (default os.hostname())
 * @param {number} [options.fleetCacheMs] - aggregation cache TTL (default 60s)
 * @param {number} [options.remoteTimeoutMs] - per-node request timeout (default 5s)
 * @returns {{getLocalRoster, getRoster, getAssignees, routes}}
 */
function createAgentsRoster(options = {}) {
  const {
    mesh = null,
    federationStateFn = null,
    fetchFn = (...args) => globalThis.fetch(...args),
    nowFn = Date.now,
    hostname = os.hostname(),
    fleetCacheMs = FLEET_CACHE_MS,
    remoteTimeoutMs = REMOTE_TIMEOUT_MS,
  } = options;

  const agentsConfig =
    options.agentsConfig && typeof options.agentsConfig === "object"
      ? options.agentsConfig
      : defaultAgentsConfig();
  const source = AGENT_SOURCES.includes(agentsConfig.source) ? agentsConfig.source : "openclaw";

  // Config paths (when set) override the wired-in constructor paths so a
  // FLEET_CONFIG_JSON override works without touching src/index.js.
  const openclawConfigPath =
    (typeof agentsConfig.openclawConfigPath === "string" && agentsConfig.openclawConfigPath) ||
    options.openclawConfigPath;
  const agentsDir =
    (typeof agentsConfig.agentsDir === "string" && agentsConfig.agentsDir) || options.agentsDir;

  if (source === "openclaw") {
    if (!openclawConfigPath || typeof openclawConfigPath !== "string") {
      throw new Error("createAgentsRoster requires an openclawConfigPath string");
    }
    if (!agentsDir || typeof agentsDir !== "string") {
      throw new Error("createAgentsRoster requires an agentsDir string");
    }
  }

  const hermesAgents =
    options.hermesAgents && typeof options.hermesAgents.listAgents === "function"
      ? options.hermesAgents
      : source === "hermes"
        ? createHermesAgents({
            hermesDir:
              (typeof agentsConfig.hermesDir === "string" && agentsConfig.hermesDir) ||
              path.join(os.homedir(), ".hermes"),
            nowFn,
          })
        : null;

  // Aggregation cache — replaced wholesale (immutably) on every refresh.
  let fleetCache = null; // { at, roster }

  function timeoutSignal(ms) {
    if (globalThis.AbortSignal && typeof globalThis.AbortSignal.timeout === "function") {
      return globalThis.AbortSignal.timeout(ms);
    }
    return undefined;
  }

  /** Parse openclaw.json from disk. Malformed/missing config → []. */
  function readConfigAgents() {
    let raw;
    try {
      raw = fs.readFileSync(openclawConfigPath, "utf8");
    } catch (err) {
      return [];
    }
    try {
      return parseAgentsConfig(JSON.parse(raw));
    } catch (err) {
      console.error(`[Agents] Malformed config at ${openclawConfigPath}:`, err.message);
      return [];
    }
  }

  /** Local agents for the configured source. Always an array. */
  function readLocalAgents(now) {
    if (source === "none") return [];
    if (source === "hermes") {
      try {
        const agents = hermesAgents.listAgents();
        return Array.isArray(agents) ? agents : [];
      } catch (err) {
        console.error("[Agents] Hermes adapter failed:", err.message);
        return [];
      }
    }
    return readConfigAgents().map((agent) => {
      const { sessionCount, lastActiveAt } = scanSessionsDir(
        path.join(agentsDir, agent.id, "sessions"),
      );
      return {
        ...agent,
        sessionCount,
        lastActiveAt,
        active: lastActiveAt !== null && now - lastActiveAt < ACTIVE_THRESHOLD_MS,
        source: "openclaw",
      };
    });
  }

  /**
   * Local roster: source agents enriched with session activity.
   * @returns {{hostname: string, agents: Array, counts: {total: number, active: number}, timestamp: number}}
   */
  function getLocalRoster() {
    const now = nowFn();
    const agents = readLocalAgents(now);
    return {
      hostname,
      agents,
      counts: { total: agents.length, active: agents.filter((a) => a.active).length },
      timestamp: now,
    };
  }

  /**
   * Best-effort GET <base>/api/agents against another OFC instance.
   * Returns {hostname, agents} or null (404 from older nodes, timeouts,
   * malformed bodies — all tolerated).
   */
  async function fetchAgentsEndpoint(base) {
    try {
      const res = await fetchFn(`${base}/api/agents`, { signal: timeoutSignal(remoteTimeoutMs) });
      if (!res || res.ok !== true) return null; // includes 404 from older nodes
      const body = await res.json();
      if (!body || !Array.isArray(body.agents)) return null;
      return {
        hostname: typeof body.hostname === "string" && body.hostname ? body.hostname : null,
        agents: body.agents,
      };
    } catch (err) {
      return null;
    }
  }

  /** Sanitize one remote agent record and attribute it to its node. */
  function attributeRemoteAgent(agent, nodeName, via) {
    if (!agent || typeof agent !== "object" || typeof agent.id !== "string" || !agent.id) {
      return null;
    }
    return {
      id: agent.id,
      name: typeof agent.name === "string" && agent.name ? agent.name : agent.id,
      model: typeof agent.model === "string" ? agent.model : null,
      workspace: typeof agent.workspace === "string" ? agent.workspace : null,
      subagentsMax: Number.isFinite(agent.subagentsMax) ? agent.subagentsMax : null,
      sessionCount: Number.isFinite(agent.sessionCount) ? agent.sessionCount : 0,
      lastActiveAt: Number.isFinite(agent.lastActiveAt) ? agent.lastActiveAt : null,
      active: agent.active === true,
      source: AGENT_SOURCES.includes(agent.source) ? agent.source : "openclaw",
      node: nodeName,
      via,
    };
  }

  /** Collect remote agents from every ONLINE registered mesh node. */
  async function collectRemoteAgents() {
    if (!mesh || typeof mesh.getState !== "function") return [];
    let meshState;
    try {
      meshState = await mesh.getState();
    } catch (err) {
      console.error("[Agents] Mesh state unavailable:", err.message);
      return [];
    }
    const nodes = Array.isArray(meshState && meshState.nodes) ? meshState.nodes : [];
    const online = nodes.filter(
      (n) =>
        n &&
        n.health &&
        n.health.status === "online" &&
        typeof n.url === "string" &&
        n.hostname !== hostname, // never double-count this host
    );

    const results = await Promise.all(
      online.map(async (node) => {
        const base = nodeBaseUrl(node.url);
        return { node, fetched: base ? await fetchAgentsEndpoint(base) : null };
      }),
    );

    const remote = [];
    for (const { node, fetched } of results) {
      if (!fetched) continue;
      for (const agent of fetched.agents) {
        const attributed = attributeRemoteAgent(agent, node.hostname, "mesh");
        if (attributed) remote.push(attributed);
      }
    }
    return remote;
  }

  /**
   * Collect agents from every REACHABLE federation remote. Remotes whose
   * reported hostname matches a mesh node are skipped so a machine reachable
   * through both transports is never double-counted. A remote reporting THIS
   * host's name is NOT skipped (a second OFC instance on the same machine —
   * e.g. a Hermes-sourced instance — is a different roster); it is grouped
   * under the remote's label instead so node groups stay distinct. Failures
   * degrade to an empty contribution — never a throw.
   *
   * @param {Set<string>} meshHostnames - hostnames already covered via mesh
   */
  async function collectFederationAgents(meshHostnames) {
    if (typeof federationStateFn !== "function") return [];
    let state;
    try {
      state = await federationStateFn();
    } catch (err) {
      console.error("[Agents] Federation state unavailable:", err.message);
      return [];
    }
    const remotes = Array.isArray(state && state.remotes) ? state.remotes : [];
    const reachable = remotes.filter(
      (r) =>
        r &&
        typeof r.baseUrl === "string" &&
        nodeBaseUrl(r.baseUrl) !== null &&
        (r.reachable === true || (r.status && r.status.reachable === true)),
    );

    const results = await Promise.all(
      reachable.map(async (remote) => ({
        remote,
        fetched: await fetchAgentsEndpoint(nodeBaseUrl(remote.baseUrl)),
      })),
    );

    const collected = [];
    for (const { remote, fetched } of results) {
      if (!fetched) continue;
      // Dedupe by hostname: skip remotes that are really a mesh node
      // reachable through both transports.
      if (fetched.hostname && meshHostnames.has(fetched.hostname)) continue;
      // Same-host second instance (or no hostname): group under the label so
      // the federation group never collides with the local node group.
      const nodeName =
        fetched.hostname && fetched.hostname !== hostname
          ? fetched.hostname
          : (typeof remote.label === "string" && remote.label) || new URL(remote.baseUrl).hostname;
      for (const agent of fetched.agents) {
        const attributed = attributeRemoteAgent(agent, nodeName, "federation");
        if (attributed) collected.push(attributed);
      }
    }
    return collected;
  }

  /** Build the unified roster (local + remote), grouped and counted. */
  function buildRoster(localAgents, remoteAgents) {
    const agents = [...localAgents.map((agent) => ({ ...agent, node: hostname })), ...remoteAgents];

    const byNode = {};
    for (const agent of agents) {
      byNode[agent.node] = [...(byNode[agent.node] || []), agent];
    }

    return {
      agents,
      byNode,
      counts: {
        total: agents.length,
        active: agents.filter((a) => a.active).length,
        nodes: Object.keys(byNode).length,
      },
      timestamp: nowFn(),
    };
  }

  /**
   * Unified roster across nodes, cached for fleetCacheMs.
   * @returns {Promise<{agents: Array, byNode: object, counts: {total, active, nodes}, timestamp: number}>}
   */
  async function getRoster() {
    const now = nowFn();
    if (fleetCache && now - fleetCache.at < fleetCacheMs) return fleetCache.roster;

    const meshAgents = await collectRemoteAgents();
    const meshHostnames = new Set(meshAgents.map((a) => a.node));
    const federationAgents = await collectFederationAgents(meshHostnames);
    const roster = buildRoster(getLocalRoster().agents, [...meshAgents, ...federationAgents]);
    fleetCache = { at: now, roster };
    return roster;
  }

  /**
   * Flat sorted assignee suggestions for the kanban dropdown: plain agent ids
   * (deduped across nodes), plus "agent-id@node" qualified forms ONLY for ids
   * that exist on MORE THAN ONE node. The "@node" form exists to disambiguate
   * remote-dispatch routing for a genuinely ambiguous id; an id unique to a
   * single node needs no qualifier and gets the bare id only — qualifying every
   * agent in a multi-node fleet would just duplicate the picker.
   * @returns {Promise<string[]>}
   */
  async function getAssignees() {
    const roster = await getRoster();

    // id -> set of nodes that host it. An id on >1 node is ambiguous.
    const nodesById = new Map();
    for (const agent of roster.agents) {
      if (!agent.node) continue;
      const nodes = nodesById.get(agent.id) || new Set();
      nodes.add(agent.node);
      nodesById.set(agent.id, nodes);
    }

    const values = new Set();
    for (const agent of roster.agents) {
      values.add(agent.id);
      const nodes = nodesById.get(agent.id);
      if (agent.node && nodes && nodes.size > 1) values.add(`${agent.id}@${agent.node}`);
    }
    return [...values].sort((a, b) => a.localeCompare(b));
  }

  // Routes map for trivial orchestrator wiring (same handler shape as
  // src/docker.js: the handler writes the full JSON response itself).
  const routes = {
    "GET /api/agents": async (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getLocalRoster(), null, 2));
    },
    "GET /api/agents/fleet": async (req, res) => {
      const roster = await getRoster();
      const assignees = await getAssignees();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...roster, assignees }, null, 2));
    },
  };

  return { getLocalRoster, getRoster, getAssignees, routes };
}

module.exports = {
  createAgentsRoster,
  parseAgentsConfig,
  scanSessionsDir,
  isSessionFile,
  nodeBaseUrl,
  ACTIVE_THRESHOLD_MS,
  FLEET_CACHE_MS,
  REMOTE_TIMEOUT_MS,
};
