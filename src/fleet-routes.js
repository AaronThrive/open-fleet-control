/**
 * Fleet REST routes — HTTP layer over the fleet runtime (src/fleet.js).
 *
 * Conventions (consistent with the rest of the server):
 *   - success: 200 + JSON payload (mutations include { success: true })
 *   - errors:  { error: "<message>" } with a 4xx/5xx status
 *   - rate limiting: every mutating route consumes one token from the
 *     per-user+ip bucket; 429 responses include { retryAfterMs }
 *   - identity: Tailscale-User-Login header, falling back to "anonymous"
 *   - audit: every mutating route records an AUDIT_ACTIONS entry
 *
 * Body parsing is capped at 64KB, except briefs PUT which allows 1MB of
 * markdown (plus JSON envelope overhead).
 */

const { defaultSecrets } = require("./secrets");

const DEFAULT_BODY_LIMIT = 64 * 1024;
const BRIEF_BODY_LIMIT = Math.floor(1.25 * 1024 * 1024); // 1MB content + JSON overhead
const IDENTITY_HEADER = "tailscale-user-login";

/** @param {string} pathname @returns {boolean} */
function isFleetRoute(pathname) {
  return pathname === "/api/fleet" || pathname.startsWith("/api/fleet/");
}

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/** Map a thrown module error to an HTTP status code. */
function statusForError(err) {
  if (Number.isInteger(err.statusCode)) return err.statusCode;
  const message = err.message || "";
  if (/not found|^Unknown (node|task|remote)/i.test(message)) return 404;
  if (/expected "pending"/.test(message)) return 409;
  if (/too large/i.test(message)) return 413;
  return 400;
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload, null, 2));
}

/** Identity from the Tailscale Serve header (fallback "anonymous"). */
function getUser(req) {
  const login = req.headers[IDENTITY_HEADER];
  return typeof login === "string" && login.trim().length > 0
    ? login.trim().toLowerCase()
    : "anonymous";
}

/**
 * Read and parse a JSON request body with a byte cap.
 * @param {object} req
 * @param {number} [maxBytes]
 * @returns {Promise<object>}
 */
function readJsonBody(req, maxBytes = DEFAULT_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;

    req.on("data", (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        reject(httpError(413, `Request body too large (max ${maxBytes} bytes)`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(httpError(400, "Request body must be a JSON object"));
          return;
        }
        resolve(parsed);
      } catch (e) {
        reject(httpError(400, "Invalid JSON body"));
      }
    });
    req.on("error", (e) => {
      if (!aborted) reject(httpError(400, e.message));
    });
  });
}

function parseIntParam(query, name, fallback) {
  const raw = query.get(name);
  if (raw === null || raw === "") return fallback;
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value)) throw httpError(400, `Invalid ${name} parameter`);
  return value;
}

/**
 * Create the fleet route handler.
 *
 * @param {object} options
 * @param {object} options.fleet - runtime from createFleetRuntime()
 * @param {object} [options.settings] - service from createSettings(); when
 *   omitted the /api/fleet/settings routes respond 404
 * @param {object} [options.dispatch] - module from createDispatch(); when
 *   omitted the kanban dispatch routes respond 503 (clean "not configured")
 * @param {function} [options.rosterFn] - () => local roster ({agents:[{id}]})
 *   or a Promise of one (agents-roster getLocalRoster); when provided, the
 *   dispatch agent must exist in it. Wiring (src/index.js):
 *     createFleetRoutes({ fleet, settings, dispatch,
 *                         rosterFn: () => agentsRoster.getLocalRoster() })
 * @param {function} [options.secretsStatusFn] - () => 1Password resolution
 *   status summary for GET /api/fleet/secrets (refs + ok/failed counts,
 *   never values). Defaults to the shared process-wide resolver's
 *   getStatus(); injectable for tests.
 * @param {function} [options.exitFn] - (code) => void used by the admin
 *   restart route. Defaults to process.exit; tests MUST inject a fake.
 * @param {number} [options.restartDelayMs] - delay before exitFn fires so
 *   the restart response can flush (default 300ms).
 * @returns {{handle: function, isFleetRoute: function}}
 */
function createFleetRoutes({
  fleet,
  settings = null,
  dispatch = null,
  rosterFn = null,
  secretsStatusFn = () => defaultSecrets.getStatus(),
  exitFn = (code) => process.exit(code),
  restartDelayMs = 300,
}) {
  if (!fleet) throw new Error("createFleetRoutes requires a fleet runtime");

  /**
   * Rate-limit guard for mutating routes. Sends the 429 itself and returns
   * null when the caller should bail; returns the user otherwise.
   */
  function guardMutation(req, res) {
    const user = getUser(req);
    const ip = req.socket?.remoteAddress || "unknown";
    const verdict = fleet.rateLimiter.check(`${user}|${ip}`);
    if (!verdict.allowed) {
      json(res, 429, { error: "Rate limit exceeded", retryAfterMs: verdict.retryAfterMs });
      return null;
    }
    return user;
  }

  /** Best-effort audit record — an audit failure never fails the request. */
  function recordAudit(user, action, target, detail) {
    try {
      fleet.audit.record({ user, action, target, detail });
    } catch (e) {
      console.error("[FleetRoutes] Audit record failed:", e.message);
    }
  }

  // -------------------------------------------------------------------
  // Mesh + costs
  // -------------------------------------------------------------------

  async function handleMesh(req, res, method, segments) {
    if (segments.length === 1 && method === "GET") {
      json(res, 200, await fleet.mesh.getState());
      return true;
    }
    if (segments[1] === "discover" && segments.length === 2 && method === "GET") {
      json(res, 200, await fleet.mesh.discoverPeers());
      return true;
    }
    if (segments[1] === "nodes" && segments.length === 2 && method === "POST") {
      const user = guardMutation(req, res);
      if (!user) return true;
      const body = await readJsonBody(req);
      const node = fleet.mesh.registerNode({ ...body, registeredBy: user });
      recordAudit(user, "node.register", node.hostname, { id: node.id });
      json(res, 200, { success: true, node });
      return true;
    }
    if (segments[1] === "nodes" && segments.length === 3 && method === "DELETE") {
      const user = guardMutation(req, res);
      if (!user) return true;
      const removed = fleet.mesh.unregisterNode(segments[2]);
      recordAudit(user, "node.unregister", removed.hostname, { id: removed.id });
      json(res, 200, { success: true, node: removed });
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------
  // Federation (fleet-of-fleets monitoring + opt-in whitelisted write proxy)
  // -------------------------------------------------------------------

  // Proxied remote writes audit LOCALLY under the closest matching native
  // action (AUDIT_ACTIONS is a closed enum we deliberately do not extend);
  // detail { kind: "federation-proxy", remote } disambiguates them from
  // local mutations. The REMOTE side audits independently via the forwarded
  // Tailscale-User-Login identity.
  const FEDERATION_PROXY_AUDIT = {
    "lesson.approve": "lesson.approve",
    "lesson.reject": "lesson.reject",
    "gate.set": "gate.toggle",
    "task.move": "task.move",
  };

  // Fleet board column order — mirrors the kanban schema's status enum.
  const FLEET_BOARD_COLUMNS = ["inbox", "assigned", "inprogress", "review", "done", "failed"];

  /** Trim a LOCAL task to the same card shape remote detail tasks use. */
  function trimBoardTask(task) {
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      assignee: typeof task.assignee === "string" && task.assignee ? task.assignee : null,
      priority: Number.isFinite(task.priority) ? task.priority : null,
      order: Number.isFinite(task.order) ? task.order : 0,
      updated_at: typeof task.updated_at === "string" ? task.updated_at : null,
      stale: task.stale === true,
    };
  }

  /**
   * Build the unified fleet-wide board: local cards + every federated
   * remote's cached cards, each labeled with its origin. Remote origins are
   * writable only when the remote connection has allowWrites (the UI then
   * proxies moves through the federation write-action whitelist). A dead or
   * never-fetched remote contributes zero tasks but still appears in
   * `origins` so the UI can say "no data" instead of silently omitting it.
   */
  function buildFleetBoard() {
    const board = fleet.kanban.getBoard();
    const origins = [{ key: "local", label: "This dashboard", kind: "local", writable: true }];
    const tasks = (Array.isArray(board.tasks) ? board.tasks : []).map((task) => ({
      ...trimBoardTask(task),
      origin: "local",
    }));

    for (const source of fleet.federation.getBoardSources()) {
      origins.push({
        key: source.remote.id,
        label: source.remote.label,
        kind: "remote",
        writable: source.remote.allowWrites === true,
        reachable: source.reachable,
        baseUrl: source.remote.baseUrl,
        hasData: !!(source.detail && source.detail.kanban),
      });
      const remoteTasks =
        source.detail && source.detail.kanban && Array.isArray(source.detail.kanban.tasks)
          ? source.detail.kanban.tasks
          : [];
      for (const task of remoteTasks) {
        tasks.push({ ...task, origin: source.remote.id });
      }
    }

    return { columns: FLEET_BOARD_COLUMNS, origins, tasks };
  }

  async function handleFederation(req, res, method, segments) {
    if (segments.length === 1 && method === "GET") {
      json(res, 200, fleet.federation.getState());
      return true;
    }
    // Read-only drill-down + fleet board (no rate-limit token, no audit).
    if (segments[1] === "board" && segments.length === 2 && method === "GET") {
      json(res, 200, buildFleetBoard());
      return true;
    }
    if (
      segments[1] === "remotes" &&
      segments.length === 4 &&
      segments[3] === "detail" &&
      method === "GET"
    ) {
      json(res, 200, fleet.federation.getRemoteDetail(segments[2]));
      return true;
    }
    if (segments[1] === "remotes" && segments.length === 2 && method === "POST") {
      const user = guardMutation(req, res);
      if (!user) return true;
      const body = await readJsonBody(req);
      const remote = fleet.federation.addRemote({
        label: body.label,
        baseUrl: body.baseUrl,
        token: body.token,
        allowWrites: body.allowWrites,
        addedBy: user,
      });
      // AUDIT_ACTIONS is a closed enum — reuse node.register with a
      // detail.kind marker instead of extending it.
      recordAudit(user, "node.register", remote.baseUrl, { kind: "federation", id: remote.id });
      json(res, 200, { success: true, remote });
      return true;
    }
    if (segments[1] === "remotes" && segments.length === 3 && method === "PATCH") {
      const user = guardMutation(req, res);
      if (!user) return true;
      const body = await readJsonBody(req);
      if (typeof body.allowWrites !== "boolean") {
        throw httpError(400, "Body must include a boolean 'allowWrites' field");
      }
      const remote = fleet.federation.setRemoteWrites(segments[2], body.allowWrites);
      // Least-wrong audit action: toggling a remote's write opt-in is a
      // registry (re)configuration, so it reuses node.register (the same
      // action that recorded the registration) rather than gate.toggle
      // (which means the local evolution gate) or alerts.config (alerting
      // config). detail.change pinpoints what actually changed.
      recordAudit(user, "node.register", remote.baseUrl, {
        kind: "federation",
        change: "allowWrites",
        allowWrites: remote.allowWrites,
        id: remote.id,
      });
      json(res, 200, { success: true, remote });
      return true;
    }
    if (
      segments[1] === "remotes" &&
      segments.length === 4 &&
      segments[3] === "actions" &&
      method === "POST"
    ) {
      const user = guardMutation(req, res);
      if (!user) return true;
      const body = await readJsonBody(req);
      const params = body.params && typeof body.params === "object" ? body.params : {};
      // Whitelist + allowWrites + param validation enforced by the module;
      // unknown actions throw 400, writes-disabled remotes throw 403.
      const result = await fleet.federation.performRemoteAction(segments[2], body.action, params, {
        actor: user,
      });
      recordAudit(
        user,
        FEDERATION_PROXY_AUDIT[result.action],
        params.lessonId || params.taskId || null,
        {
          kind: "federation-proxy",
          remote: result.remoteId,
          action: result.action,
          remoteStatus: result.remoteStatus,
          ok: result.ok,
        },
      );
      json(res, 200, { success: true, result });
      return true;
    }
    if (segments[1] === "remotes" && segments.length === 3 && method === "DELETE") {
      const user = guardMutation(req, res);
      if (!user) return true;
      const removed = fleet.federation.removeRemote(segments[2]);
      recordAudit(user, "node.unregister", removed.baseUrl, {
        kind: "federation",
        id: removed.id,
      });
      json(res, 200, { success: true, remote: removed });
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------

  async function handleChat(req, res, method, segments, query) {
    if (segments.length === 1 && method === "GET") {
      const filters = {};
      if (query.get("sender")) filters.sender = query.get("sender");
      if (query.get("receiver")) filters.receiver = query.get("receiver");
      if (query.get("text")) filters.text = query.get("text");
      filters.limit = parseIntParam(query, "limit", 100);
      const before = parseIntParam(query, "before", null);
      if (before !== null) filters.before = before;
      json(res, 200, { messages: fleet.chat.query(filters) });
      return true;
    }
    if (segments[1] === "publish" && segments.length === 2 && method === "POST") {
      const user = guardMutation(req, res);
      if (!user) return true;
      const body = await readJsonBody(req);
      const message = fleet.chat.publish({
        sender: body.sender || user,
        receiver: body.receiver,
        payload: body.payload,
        toolCalls: body.toolCalls,
      });
      // fleet-chat keeps its own durable JSONL + SQLite trail; the audit
      // entry records WHO published (the HTTP actor) without the payload.
      recordAudit(user, "chat.publish", message.id || null, {
        sender: message.sender,
        receiver: message.receiver,
      });
      json(res, 200, { success: true, message });
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------
  // Kanban
  // -------------------------------------------------------------------

  /**
   * Validate the dispatch target agent against the local roster (when a
   * rosterFn is wired). Throws 400 on unknown agents; tolerates a roster
   * read failure by failing CLOSED (we never start work for a typo).
   */
  async function requireRosterAgent(agent) {
    if (typeof rosterFn !== "function") return;
    if (typeof agent !== "string" || agent.trim().length === 0) {
      throw httpError(400, "Body must include a non-empty 'agent' field");
    }
    let roster;
    try {
      roster = await rosterFn();
    } catch (e) {
      throw httpError(503, `Agent roster unavailable: ${e.message}`);
    }
    const agents = Array.isArray(roster && roster.agents) ? roster.agents : [];
    if (!agents.some((a) => a && a.id === agent.trim())) {
      throw httpError(400, `Unknown agent '${agent.trim()}' — not in the local roster`);
    }
  }

  /**
   * Budget guardrail (src/budgets.js enforce): when an enforced budget scope
   * sits at >=100% for the current window and no operator ack exists, new
   * dispatches are refused with a 429-style envelope and a budgetBreach
   * alert fires (the engine's 5-minute dedupe keeps it from spamming).
   * Returns true when the dispatch was blocked (response already sent).
   */
  function refuseWhenOverBudget(res, taskId) {
    const block =
      fleet.budgets && typeof fleet.budgets.checkDispatchBlock === "function"
        ? fleet.budgets.checkDispatchBlock()
        : null;
    if (!block) return false;
    fleet.fireAlert({
      type: "budgetBreach",
      severity: "warn",
      task: taskId,
      message:
        `Dispatch blocked: ${block.scope} ${block.period} budget exceeded ` +
        `($${block.spent.toFixed(2)} of $${block.limit.toFixed(2)}, window ${block.periodKey}). ` +
        `Acknowledge via POST /api/fleet/budgets/ack to resume dispatching.`,
    });
    json(res, 429, {
      error: "budget exceeded",
      scope: block.scope,
      spent: block.spent,
      limit: block.limit,
      period: block.period,
      periodKey: block.periodKey,
    });
    return true;
  }

  async function handleKanbanDispatch(req, res, method, taskId, query) {
    if (method !== "POST") return false;
    if (!dispatch) {
      json(res, 503, { error: "Dispatch is not configured on this node" });
      return true;
    }
    const preview = query.get("preview") === "1";
    if (preview) {
      // Read-only message preview: no rate-limit token, no audit entry.
      const body = await readJsonBody(req);
      await requireRosterAgent(body.agent);
      json(res, 200, { preview: true, ...dispatch.previewDispatch(taskId, body) });
      return true;
    }
    const user = guardMutation(req, res);
    if (!user) return true;
    if (refuseWhenOverBudget(res, taskId)) return true;
    const body = await readJsonBody(req);
    await requireRosterAgent(body.agent);
    const result = dispatch.dispatchTask(taskId, {
      agent: body.agent,
      node: body.node,
      actor: user,
    });
    recordAudit(user, "task.update", taskId, { op: "dispatch", agent: result.agent });
    json(res, 200, {
      success: true,
      task: result.task,
      agent: result.agent,
      sessionKey: result.sessionKey,
    });
    return true;
  }

  async function handleKanban(req, res, method, segments, query) {
    if (segments.length === 1 && method === "GET") {
      json(res, 200, fleet.kanban.getBoard());
      return true;
    }
    // Dispatch availability for the UI gate — 200 even when unconfigured so
    // the client can probe without special-casing errors.
    if (segments[1] === "dispatch" && segments.length === 2 && method === "GET") {
      json(
        res,
        200,
        dispatch ? dispatch.getStatus() : { available: false, enabled: false, openCount: 0 },
      );
      return true;
    }
    if (segments[1] !== "tasks") return false;

    if (segments.length === 2 && method === "POST") {
      const user = guardMutation(req, res);
      if (!user) return true;
      const body = await readJsonBody(req);
      const task = fleet.kanban.createTask(body, user);
      recordAudit(user, "task.create", task.id, { title: task.title });
      json(res, 200, { success: true, task });
      return true;
    }

    const taskId = segments[2];
    if (!taskId) return false;

    if (segments.length === 3 && method === "PATCH") {
      const user = guardMutation(req, res);
      if (!user) return true;
      const body = await readJsonBody(req);
      const task = fleet.kanban.updateTask(taskId, body, user);
      recordAudit(user, "task.update", taskId, { changes: Object.keys(body) });
      json(res, 200, { success: true, task });
      return true;
    }
    if (segments.length === 3 && method === "DELETE") {
      const user = guardMutation(req, res);
      if (!user) return true;
      const task = fleet.kanban.deleteTask(taskId, user);
      recordAudit(user, "task.delete", taskId, { title: task.title });
      json(res, 200, { success: true, task });
      return true;
    }
    if (segments.length === 4 && method === "POST") {
      const action = segments[3];
      if (action === "move") {
        const user = guardMutation(req, res);
        if (!user) return true;
        const body = await readJsonBody(req);
        const task = fleet.kanban.moveTask(taskId, body.status, body.order ?? 0, user);
        recordAudit(user, "task.move", taskId, { to: body.status });
        json(res, 200, { success: true, task });
        return true;
      }
      if (action === "comments") {
        const user = guardMutation(req, res);
        if (!user) return true;
        const body = await readJsonBody(req);
        const task = fleet.kanban.addComment(taskId, {
          author: body.author || user,
          text: body.text,
        });
        recordAudit(user, "task.comment", taskId, null);
        json(res, 200, { success: true, task });
        return true;
      }
      if (action === "attempts") {
        const user = guardMutation(req, res);
        if (!user) return true;
        const body = await readJsonBody(req);
        const task = fleet.kanban.addAttempt(taskId, body);
        recordAudit(user, "task.update", taskId, { attempt: body.agent || null });
        json(res, 200, { success: true, task });
        return true;
      }
      if (action === "dispatch") {
        return handleKanbanDispatch(req, res, method, taskId, query);
      }
    }
    return false;
  }

  // -------------------------------------------------------------------
  // Briefs
  // -------------------------------------------------------------------

  async function handleBriefs(req, res, method, segments) {
    if (segments.length === 1 && method === "GET") {
      json(res, 200, { briefs: fleet.briefs.list() });
      return true;
    }
    if (segments.length !== 2) return false;
    const name = segments[1];

    if (method === "GET") {
      json(res, 200, fleet.briefs.read(name));
      return true;
    }
    if (method === "PUT") {
      const user = guardMutation(req, res);
      if (!user) return true;
      const body = await readJsonBody(req, BRIEF_BODY_LIMIT);
      const result = fleet.briefs.write(name, body.content);
      recordAudit(user, "brief.write", name, { size: result.size });
      json(res, 200, { success: true, brief: result });
      return true;
    }
    if (method === "DELETE") {
      const user = guardMutation(req, res);
      if (!user) return true;
      const result = fleet.briefs.remove(name);
      recordAudit(user, "brief.delete", name, null);
      json(res, 200, { success: true, brief: result });
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------
  // Evolution
  // -------------------------------------------------------------------

  async function handleEvolution(req, res, method, segments) {
    if (segments.length === 1 && method === "GET") {
      const state = fleet.evolution.getState();
      json(res, 200, { ...state, lessons: fleet.evolution.listLessons() });
      return true;
    }
    if (segments[1] === "gate" && segments.length === 2) {
      if (method === "GET") {
        json(res, 200, { gate: fleet.evolution.getGate() });
        return true;
      }
      if (method === "PUT") {
        const user = guardMutation(req, res);
        if (!user) return true;
        const body = await readJsonBody(req);
        if (typeof body.gate !== "boolean") {
          throw httpError(400, "Body must include a boolean 'gate' field");
        }
        const result = fleet.evolution.setGate(body.gate, user);
        recordAudit(user, "gate.toggle", null, { gate: result.gate });
        json(res, 200, { success: true, ...result });
        return true;
      }
      return false;
    }
    if (segments[1] === "lessons" && segments.length === 2 && method === "POST") {
      const user = guardMutation(req, res);
      if (!user) return true;
      const body = await readJsonBody(req);
      const lesson = fleet.evolution.addLesson({
        title: body.title,
        body: body.body,
        author: body.author || user,
      });
      recordAudit(user, "lesson.add", lesson.id, { title: lesson.title, status: lesson.status });
      json(res, 200, { success: true, lesson });
      return true;
    }
    if (segments[1] === "lessons" && segments.length === 4 && method === "POST") {
      const lessonId = segments[2];
      const action = segments[3];
      if (action !== "approve" && action !== "reject") return false;
      const user = guardMutation(req, res);
      if (!user) return true;
      const lesson =
        action === "approve"
          ? fleet.evolution.approve(lessonId, user)
          : fleet.evolution.reject(lessonId, user);
      recordAudit(user, action === "approve" ? "lesson.approve" : "lesson.reject", lessonId, null);
      json(res, 200, { success: true, lesson });
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------
  // Cortex
  // -------------------------------------------------------------------

  /**
   * Map a cortex adapter { error } message to an HTTP status: unknown ids
   * are 404, validation messages are 400, everything else (CLI/dataset
   * unavailable or failing) is 503.
   */
  function memoryErrorStatus(message) {
    if (/not found/i.test(message)) return 404;
    if (/must be|must include|requires at least one/i.test(message)) return 400;
    return 503;
  }

  async function handleCortex(req, res, method, segments, query) {
    if (segments.length === 1 && method === "GET") {
      json(res, 200, await fleet.cortex.getState());
      return true;
    }
    if (segments[1] === "memory" && segments.length === 2) {
      if (method === "GET") {
        const searchQuery = query.get("query");
        const limit = parseIntParam(query, "limit", null);
        const opts = limit !== null ? { limit } : {};
        const result = searchQuery
          ? await fleet.cortex.searchMemory(searchQuery, opts)
          : await fleet.cortex.listMemory(opts);
        if (result && result.error) {
          json(res, 503, { error: result.error });
          return true;
        }
        json(res, 200, result);
        return true;
      }
      if (method === "POST") {
        const user = guardMutation(req, res);
        if (!user) return true;
        const body = await readJsonBody(req);
        if (typeof body.text !== "string" || body.text.trim().length === 0) {
          throw httpError(400, "Body must include a non-empty 'text' field");
        }
        const result = await fleet.cortex.storeMemory(body.text, body.options || {});
        if (result && result.error) {
          json(res, 503, { error: result.error });
          return true;
        }
        recordAudit(user, "memory.write", result.id || null, {
          op: "store",
          bytes: Buffer.byteLength(body.text, "utf8"),
        });
        json(res, 200, { success: true, result });
        return true;
      }
      return false;
    }
    if (segments[1] === "memory" && segments.length === 3) {
      const memoryId = segments[2];
      if (method === "GET") {
        const result = await fleet.cortex.getMemory(memoryId);
        if (result && result.error) {
          json(res, memoryErrorStatus(result.error), { error: result.error });
          return true;
        }
        json(res, 200, result);
        return true;
      }
      if (method === "PATCH") {
        const user = guardMutation(req, res);
        if (!user) return true;
        const body = await readJsonBody(req);
        const changes = {};
        for (const field of ["text", "category", "scope", "importance"]) {
          if (body[field] !== undefined) changes[field] = body[field];
        }
        if (Object.keys(changes).length === 0) {
          throw httpError(
            400,
            "Body must include at least one of: text, category, scope, importance",
          );
        }
        const result = await fleet.cortex.updateMemory(memoryId, changes);
        if (result && result.error) {
          json(res, memoryErrorStatus(result.error), { error: result.error });
          return true;
        }
        recordAudit(user, "memory.write", memoryId, {
          op: "update",
          fields: Object.keys(changes),
        });
        json(res, 200, { success: true, result });
        return true;
      }
      if (method === "DELETE") {
        const user = guardMutation(req, res);
        if (!user) return true;
        const result = await fleet.cortex.deleteMemory(memoryId);
        if (result && result.error) {
          json(res, memoryErrorStatus(result.error), { error: result.error });
          return true;
        }
        recordAudit(user, "memory.write", memoryId, { op: "delete" });
        json(res, 200, { success: true, result });
        return true;
      }
      return false;
    }
    if (segments[1] === "graph" && segments.length === 2 && method === "GET") {
      const result = await fleet.cortex.getGraph({});
      if (result && result.error) {
        json(res, 503, { error: result.error });
        return true;
      }
      json(res, 200, result);
      return true;
    }
    if (segments[1] === "gauges" && segments.length === 2 && method === "GET") {
      json(res, 200, { gauges: fleet.cortex.getGauges() });
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------
  // Audit + alerts
  // -------------------------------------------------------------------

  function handleAudit(res, method, segments, query) {
    if (segments.length !== 1 || method !== "GET") return false;
    const filters = { limit: parseIntParam(query, "limit", 200) };
    if (query.get("user")) filters.user = query.get("user");
    if (query.get("action")) filters.action = query.get("action");
    if (query.get("since")) filters.since = query.get("since");
    if (query.get("until")) filters.until = query.get("until");
    json(res, 200, { entries: fleet.audit.query(filters) });
    return true;
  }

  /**
   * GET /api/fleet/alerts?limit&type&node&severity&since[&history=1]
   * Default: in-memory ring buffer (newest first). history=1 reads the
   * persistent JSONL history from disk instead (limit capped at 500).
   *
   * GET /api/fleet/alerts/analytics[?days=14]
   * Read-only rollup of the persistent history (per-day counts, flap
   * cycles, top nodes/rules). days is clamped to 1..90.
   */
  function handleAlerts(res, method, segments, query) {
    if (segments.length === 2 && segments[1] === "analytics" && method === "GET") {
      const days = parseIntParam(query, "days", 14);
      if (days < 1 || days > 90) throw httpError(400, "days must be between 1 and 90");
      json(res, 200, fleet.alerts.analytics({ days }));
      return true;
    }
    if (segments.length !== 1 || method !== "GET") return false;
    const limit = parseIntParam(query, "limit", 50);
    const filters = {};
    if (query.get("type")) filters.type = query.get("type");
    if (query.get("node")) filters.node = query.get("node");
    if (query.get("severity")) filters.severity = query.get("severity");
    if (query.get("since")) filters.since = query.get("since");
    if (query.get("history") === "1") {
      json(res, 200, { alerts: fleet.alerts.query({ ...filters, limit }), source: "history" });
    } else {
      json(res, 200, { alerts: fleet.alerts.getRecent(limit, filters), source: "memory" });
    }
    return true;
  }

  // -------------------------------------------------------------------
  // Settings (editable fleet config subset, persisted to dashboard.local.json)
  // -------------------------------------------------------------------

  async function handleSettings(req, res, method, segments) {
    if (!settings) return false;

    if (segments.length === 1 && method === "GET") {
      json(res, 200, settings.get());
      return true;
    }
    if (segments.length === 1 && method === "PATCH") {
      const user = guardMutation(req, res);
      if (!user) return true;
      const body = await readJsonBody(req);
      // update() validates strictly (400 on unknown/malformed keys) and
      // hot-applies alerts changes via the createSettings onChange hook.
      const result = settings.update(body, user);
      // Record WHICH top-level sections changed (alerts, budgets, mesh, …)
      // — never the values themselves, which may contain secrets.
      recordAudit(user, "settings.update", null, {
        sections: Object.keys(body),
        restartRequired: result.restartRequired,
      });
      json(res, 200, {
        success: true,
        applied: result.applied,
        restartRequired: result.restartRequired,
      });
      return true;
    }
    if (segments[1] === "test-alert" && segments.length === 2 && method === "POST") {
      const user = guardMutation(req, res);
      if (!user) return true;
      const body = await readJsonBody(req);
      // Unique task per call bypasses the 5-minute dedupe window; fireAlert
      // also broadcasts fleet.alert over SSE when the alert actually fires.
      const result = await fleet.fireAlert({
        type: "testAlert",
        severity: "info",
        task: String(Date.now()),
        message:
          typeof body.message === "string" && body.message
            ? body.message
            : "Test alert from Settings",
      });
      recordAudit(user, "alert.test", null, { fired: result ? !!result.fired : null });
      json(res, 200, { success: true, result });
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------
  // Admin (service lifecycle)
  // -------------------------------------------------------------------

  /**
   * POST /api/fleet/admin/restart — restart the dashboard service.
   *
   * Responds { success: true, restartingInMs } immediately, then calls
   * exitFn(1) (default process.exit(1)) after restartDelayMs so the
   * response can flush first.
   *
   * DEPLOYMENT DEPENDENCY: this route relies on the systemd user unit
   * (open-fleet-control) running with Restart=on-failure and RestartSec=5 —
   * exit code 1 counts as a failure, so systemd respawns the service ~5s
   * later and the "restart" completes cleanly. In a non-systemd context
   * (plain `node lib/server.js`) the process just dies and stays down,
   * which is why the UI shows a confirm dialog before calling this route
   * and then polls /api/health until the service answers again.
   */
  async function handleAdmin(req, res, method, segments) {
    if (segments[1] === "restart" && segments.length === 2 && method === "POST") {
      const user = guardMutation(req, res);
      if (!user) return true;
      recordAudit(user, "service.restart", null, { restartingInMs: restartDelayMs });
      json(res, 200, { success: true, restartingInMs: restartDelayMs });
      const timer = setTimeout(() => exitFn(1), restartDelayMs);
      // Never let the pending exit timer keep an otherwise-finished process
      // (e.g. a test runner) alive.
      if (typeof timer.unref === "function") timer.unref();
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------
  // Request routing
  // -------------------------------------------------------------------

  async function routeRequest(req, res, pathname, query) {
    const method = req.method || "GET";
    let segments;
    try {
      segments = pathname
        .slice("/api/fleet".length)
        .split("/")
        .filter(Boolean)
        .map((s) => decodeURIComponent(s));
    } catch (e) {
      throw httpError(400, "Malformed URL encoding");
    }
    if (segments.length === 0) return false;

    switch (segments[0]) {
      case "mesh":
        return handleMesh(req, res, method, segments);
      case "federation":
        return handleFederation(req, res, method, segments);
      case "costs":
        if (segments.length === 1 && method === "GET") {
          json(res, 200, await fleet.mesh.getFleetCosts());
          return true;
        }
        return false;
      case "budgets":
        // Read-only burn-down snapshot for the LLM Usage gauges: no
        // rate-limit token, no audit entry. Returns { enabled: false }
        // when budgets are disabled or unconfigured.
        if (segments[1] === "status" && segments.length === 2 && method === "GET") {
          json(res, 200, await fleet.budgets.getStatus());
          return true;
        }
        // Operator acknowledgement of an over-budget block: clears dispatch
        // blocking for the current budget window(s). Audited + rate-limited.
        if (segments[1] === "ack" && segments.length === 2 && method === "POST") {
          const user = guardMutation(req, res);
          if (!user) return true;
          const result = fleet.budgets.ack(user);
          recordAudit(user, "budgets.ack", null, { acked: result.acked });
          json(res, 200, { success: true, ...result });
          return true;
        }
        return false;
      case "digest":
        // Compose + send the fleet digest NOW (does not advance the
        // scheduler's lastSentAt). Audited + rate-limited.
        if (segments[1] === "test" && segments.length === 2 && method === "POST") {
          const user = guardMutation(req, res);
          if (!user) return true;
          const result = await fleet.digest.sendNow();
          recordAudit(user, "digest.test", null, {
            sent: result.sent,
            dispatched: result.dispatched ?? 0,
            delivered: result.delivered ?? 0,
          });
          json(res, 200, { success: true, result });
          return true;
        }
        return false;
      case "chat":
        return handleChat(req, res, method, segments, query);
      case "kanban":
        return handleKanban(req, res, method, segments, query);
      case "briefs":
        return handleBriefs(req, res, method, segments);
      case "evolution":
        return handleEvolution(req, res, method, segments);
      case "cortex":
        return handleCortex(req, res, method, segments, query);
      case "audit":
        return handleAudit(res, method, segments, query);
      case "alerts":
        return handleAlerts(res, method, segments, query);
      case "settings":
        return handleSettings(req, res, method, segments);
      case "admin":
        return handleAdmin(req, res, method, segments);
      case "secrets":
        // Read-only 1Password resolution status: refs + ok/failed counts.
        // Never includes resolved values (see src/secrets.js getStatus()).
        if (segments.length === 1 && method === "GET") {
          json(res, 200, secretsStatusFn());
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  /**
   * Handle a fleet API request. Always sends a response (404 for unknown
   * fleet paths, mapped 4xx/5xx for module errors).
   */
  async function handle(req, res, pathname, query) {
    try {
      const handled = await routeRequest(req, res, pathname, query);
      if (!handled) {
        json(res, 404, { error: `Unknown fleet route: ${req.method} ${pathname}` });
      }
    } catch (err) {
      const statusCode = statusForError(err);
      if (statusCode >= 500) {
        console.error("[FleetRoutes] Internal error:", err);
      }
      json(res, statusCode, { error: err.message || "Internal error" });
    }
  }

  return { handle, isFleetRoute };
}

module.exports = { createFleetRoutes, isFleetRoute };
