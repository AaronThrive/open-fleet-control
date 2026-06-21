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
const { isLoopbackAddr } = require("./auth");

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
 * @param {object} [options.orchestrate] - module from createOrchestrate(); when
 *   omitted POST /api/fleet/orchestrate responds 503 (clean "not configured")
 * @param {object} [options.bulk] - module from createBulk(); when omitted
 *   POST /api/fleet/bulk responds 503 (clean "not configured")
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
  orchestrate = null,
  bulk = null,
  rosterFn = null,
  secretsStatusFn = () => defaultSecrets.getStatus(),
  exitFn = (code) => process.exit(code),
  restartDelayMs = 300,
  // AC-11 / AC-22: optional spawn-store accessor for dedup at the orchestrate
  // entry. Accepts either a spawnStore object directly OR a spawnStoreFn getter
  // (lazy, for wiring after construction). When absent or unavailable, dedup
  // degrades to no-op — never crashes the route.
  spawnStore = null,
  spawnStoreFn = null,
}) {
  // Resolve the live store: prefer spawnStoreFn() (lazy) over the static ref.
  function resolveSpawnStore() {
    if (typeof spawnStoreFn === "function") {
      try {
        return spawnStoreFn();
      } catch (e) {
        return null;
      }
    }
    return spawnStore || null;
  }
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

  /**
   * M-5 — whether a request is an internal/localhost call. Genuine internal
   * paths (the controller, a local CLI) arrive over loopback and are allowed to
   * write without a Tailscale identity. An external request that reached us over
   * loopback only because a Tailscale Serve proxy fronts us is distinguishable
   * by the proxy-injected x-forwarded-for header — such a request is NOT treated
   * as internal (it must carry a real identity).
   */
  function isInternalCall(req) {
    const remoteAddr = req.socket?.remoteAddress || "";
    if (!isLoopbackAddr(remoteAddr)) return false;
    // A Serve-proxied external request is loopback-but-forwarded; require identity.
    if (req.headers["x-forwarded-for"]) return false;
    return true;
  }

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
      // M-5 — reserve registeredBy:"spawn" for the internal controller. An HTTP
      // caller may not claim it (it would forge a pool-trust marker the spawn
      // reconcile loop keys off). Reject it outright rather than silently
      // overriding, so the caller learns the field is privileged.
      if (typeof body.registeredBy === "string" && body.registeredBy.trim() === "spawn") {
        json(res, 403, { error: 'registeredBy "spawn" is reserved for the internal controller' });
        return true;
      }
      // M-5 — refuse a mutating mesh write from an anonymous EXTERNAL identity.
      // Internal/localhost calls (no Tailscale header behind no Serve proxy)
      // still work, so the controller and local tooling are unaffected.
      if (user === "anonymous" && !isInternalCall(req)) {
        json(res, 403, { error: "Mesh registration requires an authenticated identity" });
        return true;
      }
      // registeredBy is always the verified caller identity, never body input.
      const node = fleet.mesh.registerNode({ ...body, registeredBy: user });
      recordAudit(user, "node.register", node.hostname, { id: node.id });
      json(res, 200, { success: true, node });
      return true;
    }
    if (segments[1] === "nodes" && segments.length === 3 && method === "DELETE") {
      const user = guardMutation(req, res);
      if (!user) return true;
      // M-5 — same anonymous-external-write refusal for unregister (a mutating
      // mesh route); internal/localhost callers still pass.
      if (user === "anonymous" && !isInternalCall(req)) {
        json(res, 403, { error: "Mesh unregistration requires an authenticated identity" });
        return true;
      }
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
   * Validate the dispatch target agent against the FLEET roster (when a
   * rosterFn is wired). The reference may carry an "@node" qualifier
   * (e.g. "main@hermes-agent-1"); we strip it, validate the bare id, and —
   * when a node was given — require a roster entry matching BOTH id and node
   * so a remote-only agent (or an explicit node pin) passes validation and
   * survives through to the node-aware resolver (src/agent-locator.js).
   * Throws 400 on unknown agents; tolerates a roster read failure by failing
   * CLOSED (we never start work for a typo).
   */
  async function requireRosterAgent(agent) {
    if (typeof rosterFn !== "function") return;
    if (typeof agent !== "string" || agent.trim().length === 0) {
      throw httpError(400, "Body must include a non-empty 'agent' field");
    }
    const [id, node] = String(agent).trim().split("@");
    let roster;
    try {
      roster = await rosterFn();
    } catch (e) {
      throw httpError(503, `Agent roster unavailable: ${e.message}`);
    }
    const agents = Array.isArray(roster && roster.agents) ? roster.agents : [];
    if (!agents.some((a) => a && a.id === id && (!node || a.node === node))) {
      throw httpError(400, `Unknown agent '${agent.trim()}' — not in the fleet roster`);
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

  // -------------------------------------------------------------------
  // Orchestration (multi-agent fan-in / chain over the dispatch primitive)
  // -------------------------------------------------------------------

  /**
   * Orchestration mode gate. Composes the two budget guards (response already
   * sent on refusal). Refuses when:
   *   - the fleet daily/weekly window is over-limit (reuses checkDispatchBlock
   *     via refuseWhenOverBudget — 429, ack-able), OR
   *   - OPEN mode is requested but allowOpen is off (403 policy refusal), OR
   *   - CLOSED projected spend already reaches the per-task ceiling (429).
   * Returns true when blocked.
   *
   * @param {object} res
   * @param {string|null} taskId - anchor card for the alert (null pre-dispatch)
   * @param {{mode, ceiling?, spentUSD?, projectedUSD?}} args
   */
  function refuseOrchestration(res, taskId, { mode, ceiling, spentUSD, projectedUSD }) {
    // (a) fleet-wide window block first — same hard stop as kanban dispatch.
    if (refuseWhenOverBudget(res, taskId)) return true;

    // (b) per-orchestration mode/ceiling gate.
    const block =
      fleet.budgets && typeof fleet.budgets.checkOrchestrationBlock === "function"
        ? fleet.budgets.checkOrchestrationBlock({ mode, ceiling, spentUSD, projectedUSD })
        : null;
    if (!block) return false;

    // Clean refusal. OPEN-disabled is a 403 (policy), ceiling is a 429 (budget).
    const status = block.reason === "open-mode-disabled" ? 403 : 429;
    fleet.fireAlert({
      type: "budgetBreach",
      severity: "warn",
      task: taskId,
      message: `Orchestration refused (${block.reason}): ${block.message}`,
    });
    json(res, status, { error: block.message, ...block });
    return true;
  }

  /**
   * POST /api/fleet/orchestrate { mode:"single|board|chain", ... }
   *
   * One rate-limit token + one budget gate (OPEN policy + CLOSED pre-check +
   * the fleet daily/weekly window block) + one audit entry per call. The budget
   * gate runs BEFORE any card is created. board/chain START the run and return
   * 202 {runId, status:"running"} IMMEDIATELY — the council/pipeline runs in the
   * background (registry-tracked); the Chief polls GET :runId until terminal and
   * synthesizes from results[]. A {wait:true} / ?wait=true escape hatch (capped
   * at SYNC_WAIT_CAP_MS) keeps the old synchronous 200 for short runs / tests.
   *
   *   POST single: { mode, taskId, agent }              -> 200 dispatchTask wrapper
   *   POST board:  { mode, title, question, agents[] }   -> 202 {runId} (or 200 on wait)
   *   POST chain:  { mode, title, steps[] }              -> 202 {runId} (or 200 on wait)
   *   GET  :runId                                        -> 200 run snapshot | 404
   *
   * `budgetMode` ("closed"|"open", default CLOSED) + `ceilingUSD` (optional
   * CLOSED override) drive the gate; board/chain also re-check the CLOSED
   * ceiling mid-run via the injected budgetCheck closure.
   *
   * board/chain agents are validated against the local roster (same fail-closed
   * requireRosterAgent guard the dispatch route uses) before any card is created.
   */
  async function handleOrchestrate(req, res, method, segments = [], query = null) {
    if (!orchestrate) {
      json(res, 503, { error: "Orchestration is not configured on this node" });
      return true;
    }

    // GET /api/fleet/orchestrate/:runId → poll a run's status + collected
    // results. A read, so no guardMutation / rate-limit token (matches how
    // GET /api/fleet/kanban/dispatch is an open read). A 404 lets the Chief
    // distinguish "unknown/expired run" from "still running".
    if (method === "GET" && segments.length === 2) {
      const runId = segments[1];
      const snapshot = orchestrate.getRun(runId);
      if (!snapshot) {
        json(res, 404, { error: `Unknown runId: ${runId}` });
        return true;
      }
      json(res, 200, { success: true, ...snapshot });
      return true;
    }

    if (method !== "POST") return false;

    const user = guardMutation(req, res);
    if (!user) return true;

    const body = await readJsonBody(req);
    const mode = typeof body.mode === "string" ? body.mode.trim() : "";
    // Opt-in synchronous wait (capped server-side): body.wait===true OR
    // ?wait=true. Backward-compat for short runs / tests; default is async 202.
    const wantWait =
      body.wait === true ||
      (query && typeof query.get === "function" && query.get("wait") === "true");
    const budgetMode = body.budgetMode === "open" ? "open" : "closed"; // default CLOSED
    const ceiling = body.ceilingUSD;

    // AC-11 / AC-22 — Exactly-once Slack event handling via event_id dedup.
    //
    // SCOPE BOUNDARY (PRD §10 RESOLVED): OFC never talks to Slack directly.
    // openclaw's Bolt provider already acks ≤3s and posts/updates messages.
    // OFC's obligation is ONLY the DATA+CONTROL side:
    //   - Accept an OPTIONAL event_id (alias dedup_key) from the request body.
    //   - BEFORE starting any run/spawn, insert into the durable dedup table.
    //   - If the insert reports duplicate (changes===0 / isDuplicate), return
    //     a deterministic "deduped" response immediately — never start a second
    //     run. This is what prevents openclaw's Slack retries from spawning
    //     multiple workers.
    //   - If event_id is absent, behave exactly as today (no dedup check).
    //   - If spawnStore is unavailable (spawn disabled), degrade to no-op.
    //
    // AC-22 note: a dedup rejection is a TYPED TERMINAL result to the caller
    // (deduped:true, status:"deduped") — never a hang. The caller (openclaw's
    // Chief) reads this and suppresses the second dispatch without any Slack
    // thread being left unresolved.
    const eventId =
      (typeof body.event_id === "string" && body.event_id.trim()) ||
      (typeof body.dedup_key === "string" && body.dedup_key.trim()) ||
      null;
    // M-3 — bound the dedup key length at the route boundary (before SQLite).
    // An unbounded event_id is an attacker-controlled write into the durable
    // dedup table; reject anything over 256 chars with a clean 400.
    if (eventId !== null && eventId.length > 256) {
      throw httpError(400, "event_id/dedup_key must be at most 256 characters");
    }
    const activeStore = resolveSpawnStore();
    if (eventId && activeStore && typeof activeStore.insertDedup === "function") {
      let dedupResult;
      try {
        dedupResult = activeStore.insertDedup(eventId);
      } catch (e) {
        // insertDedup can only throw on bad input (empty string). Since we
        // already trimmed and checked above, this is a programming error —
        // log and fall through (no dedup, safe degradation per AC-22).
        console.warn("[Orchestrate] insertDedup failed:", e.message);
        dedupResult = null;
      }
      if (dedupResult && dedupResult.isDuplicate) {
        // AC-22: typed terminal result to the caller — never a hang.
        json(res, 200, {
          success: true,
          deduped: true,
          event_id: eventId,
          status: "deduped",
          reason: "duplicate_event_id",
        });
        return true;
      }
    }

    // PRE-DISPATCH budget gate — before any card is created. task=null because
    // there is no single anchor card for board/chain yet.
    const anchorTask = mode === "single" && typeof body.taskId === "string" ? body.taskId : null;
    if (refuseOrchestration(res, anchorTask, { mode: budgetMode, ceiling })) return true;

    // Mid-run CLOSED ceiling re-check, handed to runBoard/runChain. spentUSD is
    // the per-unit-of-work accrual the runner passes; the guard halts the run
    // when the per-task ceiling is reached. OPEN runs never halt here (the gate
    // returns null once allowOpen is satisfied above).
    const budgetCheck =
      fleet.budgets && typeof fleet.budgets.checkOrchestrationBlock === "function"
        ? ({ spentUSD }) =>
            fleet.budgets.checkOrchestrationBlock({ mode: budgetMode, ceiling, spentUSD })
        : null;

    if (mode === "single") {
      await requireRosterAgent(body.agent);
      const result = orchestrate.runSingle(body.taskId, { agent: body.agent, actor: user });
      recordAudit(user, "task.update", body.taskId, {
        op: "orchestrate:single",
        agent: result.agent,
      });
      json(res, 200, {
        success: true,
        mode,
        task: result.task,
        agent: result.agent,
        sessionKey: result.sessionKey,
      });
      return true;
    }

    if (mode === "board") {
      if (!Array.isArray(body.agents) || body.agents.length === 0) {
        throw httpError(400, "board mode requires a non-empty 'agents' array");
      }
      for (const agent of body.agents) await requireRosterAgent(agent);

      // M-2 — when the worker pool is active, a board fans K seats IN PARALLEL
      // before the mid-run CLOSED re-check can halt later seats. So the
      // pre-dispatch gate must account for the WHOLE fan-out width up front:
      // refuse if projected (perSeatCost × seatCount) already reaches the CLOSED
      // ceiling. Guarded by routeToPool + a configured perSeatCostUSD, so when
      // spawn is disabled (or no estimate is set) this is a no-op and the gate
      // behaves byte-identically to before.
      const ostatus =
        orchestrate && typeof orchestrate.getStatus === "function" ? orchestrate.getStatus() : null;
      const wantsParallel = typeof body.sequential === "boolean" ? body.sequential === false : true;
      if (
        ostatus &&
        ostatus.routeToPool === true &&
        wantsParallel &&
        Number(ostatus.perSeatCostUSD) > 0
      ) {
        const projectedUSD = Number(ostatus.perSeatCostUSD) * body.agents.length;
        if (
          refuseOrchestration(res, anchorTask, {
            mode: budgetMode,
            ceiling,
            projectedUSD,
          })
        ) {
          return true;
        }
      }

      // START (sync work only) — returns immediately with a runId. The council
      // runs in the background; the Chief polls GET :runId until done.
      const run = orchestrate.runBoard({
        title: body.title,
        question: body.question,
        agents: body.agents,
        actor: user,
        timeoutSec: body.timeoutSec,
        // Sequential council: advisors run one-at-a-time (single-box reliability)
        // instead of fanning out in parallel. Pass the boolean through verbatim;
        // OMITTED (undefined) lets the server default (fleet.orchestrate
        // .sequentialBoard) decide. Do NOT coerce absent->false, or the default
        // never fires for the normal case where the caller omits the field.
        sequential: typeof body.sequential === "boolean" ? body.sequential : undefined,
        budgetCheck,
      });
      recordAudit(user, "task.create", run.runId, {
        op: "orchestrate:board",
        agents: body.agents.length,
        async: !wantWait,
      });
      if (!wantWait) {
        json(res, 202, {
          success: true,
          mode,
          runId: run.runId,
          agents: run.agents,
          status: "running",
          startedAt: run.startedAt,
        });
        return true;
      }
      // Backward-compat sync path (short runs / tests), server-side capped.
      const snapshot = await orchestrate.waitForRun(run.runId);
      json(res, 200, { success: true, mode, ...snapshot });
      return true;
    }

    if (mode === "chain") {
      if (!Array.isArray(body.steps) || body.steps.length === 0) {
        throw httpError(400, "chain mode requires a non-empty 'steps' array");
      }
      for (const step of body.steps) await requireRosterAgent(step && step.agent);
      // START (sync work only) — returns immediately with a runId. The pipeline
      // runs in the background; the Chief polls GET :runId until done.
      const run = orchestrate.runChain({
        title: body.title,
        steps: body.steps,
        actor: user,
        timeoutSec: body.timeoutSec,
        budgetCheck,
      });
      recordAudit(user, "task.create", run.runId, {
        op: "orchestrate:chain",
        steps: body.steps.length,
        async: !wantWait,
      });
      if (!wantWait) {
        json(res, 202, {
          success: true,
          mode,
          runId: run.runId,
          agents: run.agents,
          status: "running",
          startedAt: run.startedAt,
        });
        return true;
      }
      // Backward-compat sync path (short runs / tests), server-side capped.
      const snapshot = await orchestrate.waitForRun(run.runId);
      json(res, 200, { success: true, mode, ...snapshot });
      return true;
    }

    throw httpError(400, "Body 'mode' must be one of: single, board, chain");
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
  // Digests (read-only browser over persisted *.md fleet digests)
  // -------------------------------------------------------------------

  /**
   * GET /api/fleet/digests           → { digests: [...] } (newest-first list)
   * GET /api/fleet/digests/<name>    → { name, title, content, generatedAt }
   *
   * Read-only — digests are written by the digest scheduler (src/digest.js).
   * The store applies the same defense-in-depth name validation + path
   * containment as briefs, so a missing/foreign name maps to 404 via
   * statusForError. Mirrors handleBriefs for style + path-safety.
   */
  async function handleDigests(req, res, method, segments) {
    if (segments.length === 1 && method === "GET") {
      json(res, 200, { digests: fleet.digests.list() });
      return true;
    }
    if (segments.length !== 2) return false;
    const name = segments[1];

    if (method === "GET") {
      json(res, 200, fleet.digests.read(name));
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
   * are 404, validation messages are 400, everything else (CLI/store
   * unavailable or failing) is 503.
   */
  function memoryErrorStatus(message) {
    if (/not found/i.test(message)) return 404;
    if (/must be|must include|requires at least one/i.test(message)) return 400;
    return 503;
  }

  // The Cortex memory browser is READ-ONLY: it reflects gbrain (the system of
  // record), which is written out-of-band by a nightly sync. No store/update/
  // delete endpoints and no knowledge-graph viz are exposed here.
  async function handleCortex(req, res, method, segments, query) {
    if (segments.length === 1 && method === "GET") {
      json(res, 200, await fleet.cortex.getState());
      return true;
    }
    if (segments[1] === "memory" && segments.length === 2 && method === "GET") {
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
    if (segments[1] === "memory" && segments.length === 3 && method === "GET") {
      const memoryId = segments[2];
      const result = await fleet.cortex.getMemory(memoryId);
      if (result && result.error) {
        json(res, memoryErrorStatus(result.error), { error: result.error });
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
   * GET /api/fleet/alerts?limit&type&node&severity&since&until[&history=1]
   * Default: in-memory ring buffer (newest first). history=1 reads the
   * persistent JSONL history from disk instead (limit capped at 500).
   * `until` is an inclusive upper bound on ts (epoch ms or ISO string).
   *
   * GET /api/fleet/alerts/analytics[?days=14]
   * Read-only rollup of the persistent history (per-day counts, flap
   * cycles, top nodes/rules). days is clamped to 1..90.
   *
   * POST /api/fleet/alerts/clear → empty the ring + archive history.
   * DELETE /api/fleet/alerts/<id> → dismiss one alert from the ring.
   */
  async function handleAlerts(req, res, method, segments, query) {
    if (segments.length === 2 && segments[1] === "analytics" && method === "GET") {
      const days = parseIntParam(query, "days", 14);
      if (days < 1 || days > 90) throw httpError(400, "days must be between 1 and 90");
      json(res, 200, fleet.alerts.analytics({ days }));
      return true;
    }
    if (segments.length === 2 && segments[1] === "clear" && method === "POST") {
      const user = guardMutation(req, res);
      if (!user) return true;
      const result = fleet.alerts.clear();
      recordAudit(user, "alert.test", null, { op: "clear", cleared: result.cleared });
      json(res, 200, { success: true, cleared: result.cleared });
      return true;
    }
    if (segments.length === 2 && method === "DELETE") {
      const user = guardMutation(req, res);
      if (!user) return true;
      const result = fleet.alerts.dismiss(segments[1]);
      recordAudit(user, "alert.test", segments[1], { op: "dismiss", dismissed: result.dismissed });
      json(res, 200, { success: true, dismissed: result.dismissed });
      return true;
    }
    if (segments.length !== 1 || method !== "GET") return false;
    const limit = parseIntParam(query, "limit", 50);
    const filters = {};
    if (query.get("type")) filters.type = query.get("type");
    if (query.get("node")) filters.node = query.get("node");
    if (query.get("severity")) filters.severity = query.get("severity");
    if (query.get("since")) filters.since = query.get("since");
    if (query.get("until")) filters.until = query.get("until");
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
  // Bulk operations (src/bulk.js)
  // -------------------------------------------------------------------

  /**
   * POST /api/fleet/bulk { action, targets, params } — fan one operation
   * across N fleet targets. One rate-limit token and ONE audit entry per
   * call (action.execute, detail.kind="bulk" carries the targets list —
   * AUDIT_ACTIONS is a closed enum we deliberately do not extend); the
   * response carries per-target { target, ok, detail } results and partial
   * failures never abort the rest (src/bulk.js contract).
   */
  async function handleBulk(req, res, method, segments) {
    if (segments.length !== 1 || method !== "POST") return false;
    if (!bulk) {
      json(res, 503, { error: "Bulk operations are not configured on this node" });
      return true;
    }
    const user = guardMutation(req, res);
    if (!user) return true;
    const body = await readJsonBody(req);
    const report = await bulk.execute({
      action: body.action,
      targets: body.targets,
      params: body.params,
      actor: user,
    });
    recordAudit(user, "action.execute", report.action, {
      kind: "bulk",
      targets: report.targets,
      okCount: report.okCount,
      failCount: report.failCount,
    });
    json(res, 200, {
      success: true,
      action: report.action,
      targets: report.targets,
      okCount: report.okCount,
      failCount: report.failCount,
      results: report.results,
    });
    return true;
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
      case "orchestrate":
        return handleOrchestrate(req, res, method, segments, query);
      case "briefs":
        return handleBriefs(req, res, method, segments);
      case "digests":
        return handleDigests(req, res, method, segments);
      case "evolution":
        return handleEvolution(req, res, method, segments);
      case "cortex":
        return handleCortex(req, res, method, segments, query);
      case "audit":
        return handleAudit(res, method, segments, query);
      case "alerts":
        return handleAlerts(req, res, method, segments, query);
      case "settings":
        return handleSettings(req, res, method, segments);
      case "bulk":
        return handleBulk(req, res, method, segments);
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
