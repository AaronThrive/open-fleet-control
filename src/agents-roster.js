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
 * Fleet aggregation: when a mesh module is supplied, every ONLINE registered
 * node is queried best-effort for GET <node-base>/api/agents (the same
 * local-only endpoint this dashboard exposes) and merged with node
 * attribution. Older nodes that 404 the endpoint are silently skipped. The
 * aggregated result is cached for FLEET_CACHE_MS.
 *
 * Routes (handler shape mirrors src/docker.js: the handler writes the full
 * JSON response itself):
 *   GET /api/agents       — local-only roster (what remote dashboards call)
 *   GET /api/agents/fleet — fleet-wide aggregation (+ assignees for kanban)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

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
 * Create the agents roster module with injectable dependencies.
 *
 * @param {object} options
 * @param {string} options.openclawConfigPath - path to openclaw.json
 * @param {string} options.agentsDir - path to the agents directory (~/.openclaw/agents)
 * @param {object} [options.mesh] - mesh module ({getState}) for fleet aggregation
 * @param {function} [options.fetchFn] - fetch-compatible transport (injectable)
 * @param {function} [options.nowFn] - clock (default Date.now)
 * @param {string} [options.hostname] - this node's name (default os.hostname())
 * @param {number} [options.fleetCacheMs] - aggregation cache TTL (default 60s)
 * @param {number} [options.remoteTimeoutMs] - per-node request timeout (default 5s)
 * @returns {{getLocalRoster, getRoster, getAssignees, routes}}
 */
function createAgentsRoster(options = {}) {
  const {
    openclawConfigPath,
    agentsDir,
    mesh = null,
    fetchFn = (...args) => globalThis.fetch(...args),
    nowFn = Date.now,
    hostname = os.hostname(),
    fleetCacheMs = FLEET_CACHE_MS,
    remoteTimeoutMs = REMOTE_TIMEOUT_MS,
  } = options;

  if (!openclawConfigPath || typeof openclawConfigPath !== "string") {
    throw new Error("createAgentsRoster requires an openclawConfigPath string");
  }
  if (!agentsDir || typeof agentsDir !== "string") {
    throw new Error("createAgentsRoster requires an agentsDir string");
  }

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

  /**
   * Local roster: config agents enriched with session activity.
   * @returns {{hostname: string, agents: Array, counts: {total: number, active: number}, timestamp: number}}
   */
  function getLocalRoster() {
    const now = nowFn();
    const agents = readConfigAgents().map((agent) => {
      const { sessionCount, lastActiveAt } = scanSessionsDir(
        path.join(agentsDir, agent.id, "sessions"),
      );
      return {
        ...agent,
        sessionCount,
        lastActiveAt,
        active: lastActiveAt !== null && now - lastActiveAt < ACTIVE_THRESHOLD_MS,
      };
    });
    return {
      hostname,
      agents,
      counts: { total: agents.length, active: agents.filter((a) => a.active).length },
      timestamp: now,
    };
  }

  /**
   * Best-effort GET <node-base>/api/agents for one mesh node.
   * Returns the remote agents array or null (404 from older nodes, timeouts,
   * malformed bodies — all tolerated).
   */
  async function fetchNodeAgents(node) {
    const base = nodeBaseUrl(node.url);
    if (!base) return null;
    try {
      const res = await fetchFn(`${base}/api/agents`, { signal: timeoutSignal(remoteTimeoutMs) });
      if (!res || res.ok !== true) return null; // includes 404 from older nodes
      const body = await res.json();
      return body && Array.isArray(body.agents) ? body.agents : null;
    } catch (err) {
      return null;
    }
  }

  /** Sanitize one remote agent record and attribute it to its node. */
  function attributeRemoteAgent(agent, nodeName) {
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
      node: nodeName,
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
      online.map(async (node) => ({ node, agents: await fetchNodeAgents(node) })),
    );

    const remote = [];
    for (const { node, agents } of results) {
      if (!agents) continue;
      for (const agent of agents) {
        const attributed = attributeRemoteAgent(agent, node.hostname);
        if (attributed) remote.push(attributed);
      }
    }
    return remote;
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

    const remoteAgents = await collectRemoteAgents();
    const roster = buildRoster(getLocalRoster().agents, remoteAgents);
    fleetCache = { at: now, roster };
    return roster;
  }

  /**
   * Flat sorted assignee suggestions for the kanban dropdown: plain agent ids
   * (deduped across nodes) plus "agent-id@node" qualified forms.
   * @returns {Promise<string[]>}
   */
  async function getAssignees() {
    const roster = await getRoster();
    const values = new Set();
    for (const agent of roster.agents) {
      values.add(agent.id);
      values.add(`${agent.id}@${agent.node}`);
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
