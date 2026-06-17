/**
 * Agent → node resolver for remote dispatch (Phase 2).
 *
 * Maps an agent id (optionally "id@node") to a routing decision the dispatch
 * module branches on. Pure resolution — no network, no CLI; the injected
 * rosterFn / meshFn own all I/O so this stays unit-testable.
 *
 * Decision kinds:
 *   { kind: "local",       agentId }                        — run on THIS node
 *   { kind: "remote",      agentId, node, baseUrl, online } — POST agent-run to <node>
 *   { kind: "unknown",     agentId }                        — agent not in the fleet roster
 *   { kind: "unreachable", agentId, node }                  — roster names a node with no mesh record
 *
 * Node selection: an explicit "@node" qualifier wins; else a local match is
 * preferred (cheapest, matches the legacy local-only behaviour); else the
 * first remote match.
 */

/**
 * Base URL of a mesh node: its composed health URL minus the health path
 * (mesh.getState composes node.url = <proto>://<host>[:port]<healthPath>).
 * Mirrors the same stripping bulk.js uses for remote node calls.
 */
function nodeBaseUrl(node) {
  const url = String(node.url || "");
  const healthPath = typeof node.healthPath === "string" ? node.healthPath : "/health";
  return url.endsWith(healthPath) ? url.slice(0, -healthPath.length) : url;
}

/**
 * The OFC dashboard's own health endpoint (src/index.js fast-path
 * `/api/health`). A gateway proxy in the same mesh typically registers the
 * generic `/health` instead — POSTing agent-run there hits the proxy, not OFC.
 */
const OFC_DASHBOARD_HEALTH_PATH = "/api/health";

/**
 * Pick the mesh record for a hostname, preferring the OFC dashboard node when a
 * hostname has multiple records. A hostname can appear twice — e.g. a gateway
 * proxy advertising `/health` AND the real OFC dashboard advertising
 * `/api/health`; the first match is non-deterministic and may be the proxy,
 * which does not serve agent-run. Selection is deterministic:
 *   1. prefer the record whose healthPath is the OFC dashboard health path
 *      (`/api/health`);
 *   2. else prefer the record whose composed base URL exposes the OFC API
 *      (path ends with `/api`, i.e. the dashboard mounted under a subpath);
 *   3. else fall back to the first matching record (legacy behaviour).
 *
 * @param {Array} meshNodes - mesh.getState().nodes
 * @param {string} hostname - target node hostname
 * @returns {object|null} the chosen mesh node, or null when none match
 */
function pickDashboardNode(meshNodes, hostname) {
  const matches = meshNodes.filter((n) => n && n.hostname === hostname);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  return (
    matches.find((n) => n.healthPath === OFC_DASHBOARD_HEALTH_PATH) ||
    matches.find((n) => nodeBaseUrl(n).endsWith("/api")) ||
    matches[0]
  );
}

/**
 * Create the agent locator.
 *
 * @param {object} options
 * @param {function} options.rosterFn - async () => fleet roster ({agents:[{id, node, ...}]})
 * @param {function} options.meshFn - async () => mesh state ({nodes:[{hostname, url, healthPath, health}]})
 * @param {string} options.selfNode - this node's hostname (local-vs-remote pivot)
 * @returns {{resolve: function}}
 */
function createAgentLocator({ rosterFn, meshFn, selfNode }) {
  if (typeof rosterFn !== "function") {
    throw new Error("createAgentLocator requires a rosterFn function");
  }
  if (typeof meshFn !== "function") {
    throw new Error("createAgentLocator requires a meshFn function");
  }

  /**
   * Resolve an agent reference (id or "id@node") to a routing decision.
   * @param {string} agentRef
   * @returns {Promise<{kind: string, agentId: string, node?: string, baseUrl?: string, online?: boolean}>}
   */
  async function resolve(agentRef) {
    const [agentId, pinnedNode] = String(agentRef).split("@");

    const roster = await rosterFn();
    const agents = Array.isArray(roster && roster.agents) ? roster.agents : [];
    const matches = agents.filter((a) => a && a.id === agentId);
    if (matches.length === 0) {
      return { kind: "unknown", agentId };
    }

    // Pick the node: explicit @node wins; else prefer local; else first remote.
    const chosen =
      (pinnedNode && matches.find((a) => a.node === pinnedNode)) ||
      matches.find((a) => a.node === selfNode) ||
      matches[0];

    if (chosen.node === selfNode) return { kind: "local", agentId };

    const mesh = await meshFn();
    const meshNodes = Array.isArray(mesh && mesh.nodes) ? mesh.nodes : [];
    const node = pickDashboardNode(meshNodes, chosen.node);
    if (!node) return { kind: "unreachable", agentId, node: chosen.node };

    return {
      kind: "remote",
      agentId,
      node: chosen.node,
      baseUrl: nodeBaseUrl(node),
      online: !!(node.health && node.health.status === "online"),
    };
  }

  return { resolve };
}

module.exports = { createAgentLocator };
