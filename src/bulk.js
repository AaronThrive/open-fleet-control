/**
 * Fleet bulk operations — one POST, N targets, per-target results.
 *
 * POST /api/fleet/bulk { action, targets: [ids], params } (route lives in
 * src/fleet-routes.js, case "bulk") fans an operation across fleet targets:
 *
 *   kill-stale-sessions  targets: mesh node ids (or "local")
 *                        local  → openclaw sessions cleanup via the shared
 *                                 quick-action runner (src/actions.js)
 *                        remote → GET <node>/api/action?action=clear-stale-sessions
 *   health-check         targets: mesh node ids (or "local")
 *                        remote → GET the node's registered /health endpoint
 *   gateway-status       targets: mesh node ids (or "local")
 *                        remote → GET <node>/api/action?action=gateway-status
 *   dispatch-task        targets: agent ids; params {taskId, node?}
 *                        same payload as the single kanban dispatch, fanned
 *                        through the dispatch runtime (its rails apply: the
 *                        open-attempt lock 409s duplicate dispatches of one
 *                        card, capacity 429s past maxConcurrent)
 *   chat-broadcast       targets: receivers (default ["all"]); params {text}
 *                        one fleet-chat publish per receiver
 *
 * Guarantees: every target yields exactly one { target, ok, detail } entry;
 * a failing target NEVER aborts the rest (each is independently caught).
 * Rate limiting, identity, and the single audit entry (action.execute with
 * detail.kind="bulk" + the targets list) are enforced by the route layer.
 *
 * All side-effecting dependencies are injected (fetchFn, runAction, dispatch,
 * chat, mesh, rosterFn) so tests run with fakes — no network, no CLI.
 */

const BULK_ACTIONS = Object.freeze([
  "kill-stale-sessions",
  "health-check",
  "gateway-status",
  "dispatch-task",
  "chat-broadcast",
]);

// Node-targeted actions map to a quick action on the remote dashboard.
const REMOTE_QUICK_ACTION = {
  "kill-stale-sessions": "clear-stale-sessions",
  "gateway-status": "gateway-status",
};

const MAX_TARGETS = 50;
const REMOTE_TIMEOUT_MS = 10000;
const LOCAL_TARGETS = new Set(["local", "self"]);

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/** First line of an error, capped — keeps per-target detail readable. */
function shortMessage(message) {
  return String(message || "failed")
    .split("\n")[0]
    .slice(0, 300);
}

function timeoutSignal(ms) {
  if (globalThis.AbortSignal && typeof globalThis.AbortSignal.timeout === "function") {
    return globalThis.AbortSignal.timeout(ms);
  }
  return undefined;
}

/**
 * Base URL of a mesh node: its composed health URL minus the health path.
 * getState() composes node.url = <protocol>://<host>[:port]<healthPath>.
 */
function nodeBaseUrl(node) {
  const url = String(node.url || "");
  const healthPath = typeof node.healthPath === "string" ? node.healthPath : "/health";
  return url.endsWith(healthPath) ? url.slice(0, -healthPath.length) : url;
}

/**
 * Create the bulk operations module.
 *
 * @param {object} deps
 * @param {object} deps.mesh - mesh module ({ getState })
 * @param {object} deps.chat - fleet-chat module ({ publish })
 * @param {object} [deps.dispatch] - dispatch module ({ dispatchTask }); when
 *   absent, dispatch-task targets fail cleanly ("not configured")
 * @param {function} [deps.rosterFn] - () => local roster ({agents:[{id}]});
 *   when wired, dispatch-task agents must exist in it (fail closed per target)
 * @param {function} deps.runAction - (actionName, opts) => Promise<result>
 *   shared quick-action runner (src/actions.js executeAction, deps bound)
 * @param {function} [deps.fetchFn] - fetch-compatible (injectable for tests)
 * @returns {{execute: function, BULK_ACTIONS: string[]}}
 */
function createBulk(deps = {}) {
  const {
    mesh,
    chat,
    dispatch = null,
    rosterFn = null,
    runAction,
    fetchFn = (...args) => globalThis.fetch(...args),
  } = deps;
  if (!mesh || typeof mesh.getState !== "function") {
    throw new Error("createBulk requires a mesh module");
  }
  if (!chat || typeof chat.publish !== "function") {
    throw new Error("createBulk requires a chat module");
  }
  if (typeof runAction !== "function") {
    throw new Error("createBulk requires a runAction function");
  }

  /** Resolve a target id to a mesh node (by id, hostname, or host:port). */
  function findNode(nodes, target) {
    return (
      nodes.find(
        (n) =>
          n.id === target || n.hostname === target || `${n.hostname}:${n.port || 443}` === target,
      ) || null
    );
  }

  /** GET a JSON endpoint on a remote node, with timeout. Throws on failure. */
  async function fetchRemoteJson(url) {
    const res = await fetchFn(url, { signal: timeoutSignal(REMOTE_TIMEOUT_MS) });
    if (!res || res.ok !== true) {
      throw new Error(`HTTP ${res && res.status ? res.status : "error"} from ${url}`);
    }
    return res.json();
  }

  /** Run a node-targeted action against one target (local or mesh node). */
  async function runNodeTarget(action, target, params, meshNodes) {
    if (LOCAL_TARGETS.has(target)) {
      if (action === "health-check") {
        const result = await runAction("health-check", {});
        return { ok: result.success, detail: result.output || result.error || "" };
      }
      const result = await runAction(REMOTE_QUICK_ACTION[action], {
        staleMinutes: params.staleMinutes,
      });
      return { ok: result.success, detail: result.output || result.error || "" };
    }

    const node = findNode(meshNodes, target);
    if (!node) throw new Error(`Unknown node: ${target}`);

    if (action === "health-check") {
      const startedAt = Date.now();
      const body = await fetchRemoteJson(node.url);
      const latencyMs = Date.now() - startedAt;
      const version = body && typeof body.version === "string" ? ` v${body.version}` : "";
      return { ok: true, detail: `healthy (${latencyMs} ms)${version}` };
    }

    const quickAction = REMOTE_QUICK_ACTION[action];
    const url = `${nodeBaseUrl(node)}/api/action?action=${encodeURIComponent(quickAction)}`;
    const body = await fetchRemoteJson(url);
    const ok = !!(body && body.success === true);
    const detail = body ? body.output || body.error || "" : "";
    return { ok, detail: String(detail).slice(0, 500) };
  }

  /**
   * Validate a dispatch agent against the roster (fail closed). The reference
   * may carry an "@node" qualifier; we strip it, validate the bare id, and —
   * when a node was given — require a roster entry matching both id and node so
   * node-qualified references survive to the node-aware resolver.
   */
  async function requireRosterAgent(agent) {
    if (typeof rosterFn !== "function") return;
    const [id, node] = String(agent).split("@");
    let roster;
    try {
      roster = await rosterFn();
    } catch (e) {
      throw new Error(`Agent roster unavailable: ${e.message}`);
    }
    const agents = Array.isArray(roster && roster.agents) ? roster.agents : [];
    if (!agents.some((a) => a && a.id === id && (!node || a.node === node))) {
      throw new Error(`Unknown agent '${agent}' — not in the local roster`);
    }
  }

  async function runDispatchTarget(agent, params, actor) {
    if (!dispatch || typeof dispatch.dispatchTask !== "function") {
      throw new Error("Dispatch is not configured on this node");
    }
    await requireRosterAgent(agent);
    const result = dispatch.dispatchTask(params.taskId, {
      agent,
      node: params.node,
      actor,
    });
    return { ok: true, detail: `dispatched (session key: ${result.sessionKey})` };
  }

  function runChatTarget(receiver, params, actor) {
    const message = chat.publish({
      sender: typeof params.sender === "string" && params.sender ? params.sender : actor,
      receiver,
      payload: params.text,
    });
    return { ok: true, detail: `published (${message.id})` };
  }

  /** Validate the request envelope; returns normalized {action, targets, params}. */
  function validateRequest({ action, targets, params }) {
    if (typeof action !== "string" || !BULK_ACTIONS.includes(action)) {
      throw httpError(
        400,
        `Unknown bulk action: ${String(action)}. Allowed: ${BULK_ACTIONS.join(", ")}`,
      );
    }
    const list = targets === undefined || targets === null ? [] : targets;
    if (!Array.isArray(list) || list.some((t) => typeof t !== "string" || t.trim().length === 0)) {
      throw httpError(400, "targets must be an array of non-empty strings");
    }
    if (list.length > MAX_TARGETS) {
      throw httpError(400, `Too many targets (max ${MAX_TARGETS})`);
    }
    const normalizedParams = params && typeof params === "object" ? params : {};

    let normalizedTargets = list.map((t) => t.trim());
    if (normalizedTargets.length === 0) {
      if (action === "dispatch-task") {
        throw httpError(400, "dispatch-task requires at least one agent target");
      }
      normalizedTargets = action === "chat-broadcast" ? ["all"] : ["local"];
    }

    if (action === "dispatch-task") {
      if (typeof normalizedParams.taskId !== "string" || !normalizedParams.taskId.trim()) {
        throw httpError(400, "dispatch-task requires params.taskId");
      }
    }
    if (action === "chat-broadcast") {
      if (typeof normalizedParams.text !== "string" || normalizedParams.text.trim().length === 0) {
        throw httpError(400, "chat-broadcast requires a non-empty params.text");
      }
    }

    return { action, targets: normalizedTargets, params: normalizedParams };
  }

  /**
   * Execute a bulk operation across all targets. Per-target failures are
   * captured as { ok: false, detail } — the rest always run.
   *
   * @param {object} request - { action, targets, params, actor }
   * @returns {Promise<{action, targets, results: Array<{target, ok, detail}>, okCount, failCount}>}
   */
  async function execute(request = {}) {
    const { action, targets, params } = validateRequest(request);
    const actor = typeof request.actor === "string" && request.actor ? request.actor : "anonymous";

    // Resolve mesh state once per call for node-targeted actions.
    let meshNodes = [];
    if (action === "kill-stale-sessions" || action === "health-check" || action === "gateway-status") {
      const needsMesh = targets.some((t) => !LOCAL_TARGETS.has(t));
      if (needsMesh) {
        const state = await mesh.getState();
        meshNodes = Array.isArray(state && state.nodes) ? state.nodes : [];
      }
    }

    const results = await Promise.all(
      targets.map(async (target) => {
        try {
          let outcome;
          switch (action) {
            case "dispatch-task":
              outcome = await runDispatchTarget(target, params, actor);
              break;
            case "chat-broadcast":
              outcome = runChatTarget(target, params, actor);
              break;
            default:
              outcome = await runNodeTarget(action, target, params, meshNodes);
          }
          return { target, ok: outcome.ok, detail: outcome.detail };
        } catch (e) {
          return { target, ok: false, detail: shortMessage(e.message) };
        }
      }),
    );

    const okCount = results.filter((r) => r.ok).length;
    return { action, targets, results, okCount, failCount: results.length - okCount };
  }

  return { execute, BULK_ACTIONS };
}

module.exports = { createBulk, BULK_ACTIONS, MAX_TARGETS };
