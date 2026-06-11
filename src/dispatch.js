/**
 * Kanban → agent dispatch — assigning a card can actually START the work.
 *
 * Spawn mechanism (discovered + verified on this host):
 *   openclaw agent --agent <id> --session-key agent:<id>:kanban-<task>-<ts> \
 *     --message <kickoff> --json --timeout <sec>
 * The CLI runs one agent turn via the local OpenClaw Gateway and blocks until
 * the turn ends, so the invocation is fired asynchronously (never awaited by
 * the dispatch call). The session key is chosen by US, which gives the
 * dashboard a stable handle immediately; the concrete session id (a UUID,
 * visible in the sessions view) is parsed from the CLI's JSON output when the
 * turn completes and recorded on the card's attempt.
 *
 * Dispatch flow (all side effects via the injected kanban engine, so the
 * fleet runtime's onChange → SSE fleet.kanban fan-out happens for free):
 *   1. validations (available / task / agent / local node / 409 / capacity)
 *   2. fire the CLI asynchronously
 *   3. addAttempt {agent, note:"dispatched"} — the OPEN attempt is the lock
 *   4. move inbox → assigned (only when the card is still in inbox)
 *   5. comment "Dispatched to <agent> by <actor>"
 *   6. onEvent({type:"task.dispatched", ...})
 *   7. when the CLI exits, close the attempt (success/failure + session id)
 *
 * Safety rails:
 *   - max concurrent dispatches (default 3): cards with an open dispatched
 *     attempt count against the cap; refusal is a 429 with a clear message
 *   - double dispatch of the same card while an attempt is open → 409
 *   - an attempt only counts as "open" while it is younger than
 *     timeoutSec + 15 min; a crashed server can therefore never wedge a card
 *     into an undispatachable state forever
 *   - remote nodes are v-next: node != self → clean error
 *
 * Follow-through (the watcher — closes the dispatch loop when the CLI exits):
 *   - the CLI's --json output is parsed (parseRunResult): session id,
 *     CLI-reported error, and the agent's output text
 *   - the outcome + a truncated output snippet are recorded on the attempt
 *   - the card auto-moves: assigned/inprogress → review on success,
 *     → failed on CLI error or timeout (operator moves are never overridden:
 *     cards already in inbox/review/done/failed are left where they are)
 *   - a killed/overdue process is classified as a timeout (note "timeout: …")
 *   - the optional injected fireAlert hook fires a `dispatchComplete` alert
 *     (info on success, warn on failure) — delivery and the default-OFF
 *     gating live in the alerts engine (fleet.alerts.rules.dispatchComplete)
 *   - every board mutation goes through the kanban engine, so the runtime's
 *     onChange → fleet.kanban SSE fan-out updates UIs for free
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { getSafeEnv } = require("./openclaw");

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_BASE_URL = "http://127.0.0.1:3333";
const OPEN_ATTEMPT_GRACE_MS = 15 * 60 * 1000;
const DISPATCH_NOTE = "dispatched";
const PROTOCOL_BRIEF = "agent-task-protocol";
const EXEC_MAX_BUFFER = 16 * 1024 * 1024;
const RESULT_SNIPPET_MAX = 300;
// Statuses the watcher may auto-move FROM; operator-final columns are immune.
const AUTO_MOVE_SOURCES = Object.freeze(["assigned", "inprogress"]);
const WATCHER_ACTOR = "dispatch";

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/**
 * Locate an executable on PATH (no shell). Used for the availability probe
 * when no custom execFn is injected.
 * @param {string} name - binary name
 * @param {string} [pathEnv] - PATH override (tests)
 * @returns {string|null} absolute path or null
 */
function resolveBinary(name, pathEnv = process.env.PATH || "") {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (e) {
      // not here — keep walking PATH
    }
  }
  return null;
}

/** True when the attempt is an open dispatch lock (see header). */
function isOpenDispatchAttempt(attempt, nowMs, openTtlMs) {
  if (!attempt || attempt.ended_at !== null) return false;
  if (typeof attempt.note !== "string" || !attempt.note.startsWith(DISPATCH_NOTE)) return false;
  const startedMs = Date.parse(attempt.started_at);
  if (Number.isNaN(startedMs)) return false;
  return nowMs - startedMs <= openTtlMs;
}

/**
 * Compose the kick-off message for an agent from a kanban card plus the
 * standing fleet-control instructions.
 * @param {object} task - kanban task
 * @param {object} options - {agent, baseUrl, briefsDir}
 * @returns {string}
 */
function composeKickoffMessage(task, { agent, baseUrl, briefsDir }) {
  const protocolPath = briefsDir ? path.join(briefsDir, `${PROTOCOL_BRIEF}.md`) : null;
  const lines = [
    `You have been dispatched a task from the Open Fleet Control kanban board.`,
    ``,
    `Task ${task.id}: ${task.title}`,
    `Priority: P${task.priority}`,
    `Due: ${task.due ? task.due : "none"}`,
    `Description:`,
    task.description && task.description.trim().length > 0 ? task.description : "(none)",
    ``,
    `Dashboard base URL for all API calls: ${baseUrl}`,
    `Identify yourself with the header "Tailscale-User-Login: ${agent}" on every request.`,
    ``,
    `Standing instructions — follow the fleet-control bindings:`,
    `1. FIRST read the agent task protocol brief and follow it exactly:`,
    `   GET ${baseUrl}/api/fleet/briefs/${PROTOCOL_BRIEF}` +
      (protocolPath ? ` (local file: ${protocolPath})` : ""),
    `2. Comment on the task when you START, the moment you hit a BLOCKER, and on HANDOFF:`,
    `   POST ${baseUrl}/api/fleet/kanban/tasks/${task.id}/comments {"author":"${agent}","text":"[${agent}] ..."}`,
    `3. Move the card through the lifecycle as you work (inprogress when you begin, review when done):`,
    `   POST ${baseUrl}/api/fleet/kanban/tasks/${task.id}/move {"status":"inprogress"}`,
    `4. Publish your handoff summary to fleet chat:`,
    `   POST ${baseUrl}/api/fleet/chat/publish {"sender":"${agent}","payload":{"text":"..."}}`,
    `5. Submit a lesson learned:`,
    `   POST ${baseUrl}/api/fleet/evolution/lessons {"title":"...","body":"...","author":"${agent}"}`,
  ];
  return lines.join("\n");
}

/** First line of an error message, capped for attempt notes / comments. */
function shortReason(message, fallback = "failed") {
  return String(message || fallback)
    .split("\n")[0]
    .slice(0, 300);
}

/** Collapse whitespace and cap the agent output for the attempt note. */
function snippet(text) {
  const collapsed = String(text).replace(/\s+/g, " ").trim();
  if (collapsed.length <= RESULT_SNIPPET_MAX) return collapsed;
  return `${collapsed.slice(0, RESULT_SNIPPET_MAX)}…`;
}

/** Best-effort extraction of the agent's output text from the parsed JSON. */
function extractOutputText(parsed) {
  const result = parsed.result && typeof parsed.result === "object" ? parsed.result : {};
  if (Array.isArray(result.payloads)) {
    const joined = result.payloads
      .map((p) => (p && typeof p.text === "string" ? p.text : ""))
      .filter((text) => text.length > 0)
      .join("\n");
    if (joined.length > 0) return joined;
  }
  for (const candidate of [result.text, result.output, parsed.output, parsed.text]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return null;
}

/** CLI-reported error inside an otherwise clean exit, or null. */
function extractCliError(parsed) {
  if (typeof parsed.error === "string" && parsed.error.length > 0) return parsed.error;
  if (parsed.error && typeof parsed.error === "object" && parsed.error.message) {
    return String(parsed.error.message);
  }
  if (parsed.success === false || parsed.ok === false) return "agent run reported failure";
  return null;
}

/**
 * Parse the `openclaw agent --json` stdout into the fields the watcher
 * records on the card. Never throws — unparseable output yields all-nulls
 * (the run still counts as success when the process exited cleanly).
 *
 * @param {string} stdout - raw CLI stdout
 * @returns {{sessionId: string|null, outputText: string|null, error: string|null}}
 */
function parseRunResult(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    return { sessionId: null, outputText: null, error: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { sessionId: null, outputText: null, error: null };
  }
  return {
    sessionId:
      parsed?.result?.meta?.agentMeta?.sessionId ||
      parsed?.result?.meta?.systemPromptReport?.sessionId ||
      null,
    outputText: extractOutputText(parsed),
    error: extractCliError(parsed),
  };
}

/**
 * Create the dispatch module.
 *
 * @param {object} options
 * @param {object} options.kanban - kanban engine from createKanban()
 * @param {string} [options.briefsDir] - briefs directory (referenced in the kickoff message)
 * @param {function} [options.onEvent] - (event) => void, fired after a successful dispatch
 * @param {function} [options.execFn] - (args: string[], {timeoutMs}) => Promise<{stdout}>;
 *   defaults to a real `openclaw` execFile runner. Inject a mock in tests.
 * @param {object} [options.config] - fleet.dispatch config section:
 *   {enabled=true, baseUrl, maxConcurrent=3, timeoutSec=600, node=os.hostname()}
 * @param {function} [options.nowFn] - clock (epoch ms), injectable for tests
 * @param {function} [options.fireAlert] - (event) => void|Promise; fired with a
 *   `dispatchComplete` alert when a run settles. Gating (rule default OFF) and
 *   sink delivery (ntfy/Slack/webhooks) belong to the alerts engine.
 * @returns {object} dispatch API
 */
function createDispatch(options = {}) {
  const {
    kanban,
    briefsDir = null,
    onEvent,
    execFn = null,
    config = {},
    nowFn = Date.now,
    fireAlert = null,
  } = options;
  if (!kanban) throw new Error("createDispatch: kanban is required");

  const enabled = config.enabled !== false;
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const maxConcurrent = Number.isInteger(config.maxConcurrent)
    ? config.maxConcurrent
    : DEFAULT_MAX_CONCURRENT;
  const timeoutSec = Number.isInteger(config.timeoutSec) ? config.timeoutSec : DEFAULT_TIMEOUT_SEC;
  const selfNode = config.node || os.hostname();
  const openTtlMs = timeoutSec * 1000 + OPEN_ATTEMPT_GRACE_MS;

  // Availability of the spawn mechanism: a custom execFn is trusted as-is;
  // the default runner needs the openclaw binary on PATH (probed lazily,
  // cached — PATH does not change while the server runs).
  let binaryProbe = null; // null = not probed yet, otherwise string|false
  function mechanismAvailable() {
    if (typeof execFn === "function") return true;
    if (binaryProbe === null) binaryProbe = resolveBinary("openclaw") || false;
    return binaryProbe !== false;
  }

  /** Default runner: openclaw via execFile (no shell — injection-safe). */
  function defaultExecFn(args, { timeoutMs }) {
    return new Promise((resolve, reject) => {
      execFile(
        "openclaw",
        args,
        { encoding: "utf8", timeout: timeoutMs, env: getSafeEnv(), maxBuffer: EXEC_MAX_BUFFER },
        (err, stdout) => {
          if (err) reject(err);
          else resolve({ stdout });
        },
      );
    });
  }

  function emit(event) {
    if (typeof onEvent === "function") {
      try {
        onEvent(event);
      } catch (e) {
        console.error("[Dispatch] onEvent handler failed:", e.message);
      }
    }
  }

  function requireTask(id) {
    const board = kanban.getBoard();
    const task = board.tasks.find((t) => t.id === id);
    if (!task) throw httpError(404, `Unknown task: ${id}`);
    return { board, task };
  }

  function requireAgent(agent) {
    if (typeof agent !== "string" || agent.trim().length === 0) {
      throw httpError(400, "Body must include a non-empty 'agent' field");
    }
    return agent.trim();
  }

  function ensureAvailable() {
    if (!enabled) throw httpError(503, "Dispatch is disabled (fleet.dispatch.enabled=false)");
    if (!mechanismAvailable()) {
      throw httpError(503, "Dispatch mechanism unavailable: openclaw CLI not found on PATH");
    }
  }

  function ensureLocalNode(node) {
    if (node && node !== selfNode) {
      throw httpError(400, `remote dispatch not yet supported (this node is '${selfNode}')`);
    }
  }

  /** Count board cards holding an open dispatched attempt. */
  function countOpenDispatches(board) {
    const nowMs = nowFn();
    return board.tasks.filter((t) =>
      t.attempts.some((a) => isOpenDispatchAttempt(a, nowMs, openTtlMs)),
    ).length;
  }

  function hasOpenDispatch(task) {
    const nowMs = nowFn();
    return task.attempts.some((a) => isOpenDispatchAttempt(a, nowMs, openTtlMs));
  }

  /**
   * Close the dispatch attempt when the CLI run settles. Best-effort: the
   * card may have been deleted or hand-edited meanwhile — never throws.
   */
  function closeAttempt(taskId, attemptIndex, { result, note }) {
    try {
      kanban.updateAttempt(taskId, attemptIndex, {
        ended_at: new Date(nowFn()).toISOString(),
        result,
        note,
      });
    } catch (e) {
      console.error(`[Dispatch] Could not close attempt on ${taskId}:`, e.message);
    }
  }

  /**
   * Auto-move the card when a run settles: review on success, failed on
   * error/timeout. Only assigned/inprogress cards move — a card the operator
   * (or agent) already placed in a final column is never overridden.
   * Best-effort: never throws.
   */
  function autoMoveOnSettle(taskId, toStatus) {
    try {
      const task = kanban.getBoard().tasks.find((t) => t.id === taskId);
      if (!task || !AUTO_MOVE_SOURCES.includes(task.status)) return;
      kanban.moveTask(taskId, toStatus, task.order, WATCHER_ACTOR);
    } catch (e) {
      console.error(`[Dispatch] Could not auto-move ${taskId} to ${toStatus}:`, e.message);
    }
  }

  /**
   * Fire the dispatchComplete alert through the injected hook. The alerts
   * engine owns gating (rule defaults to OFF) and sink delivery; here we only
   * make sure a broken hook can never break the watcher.
   */
  function notifyCompletion({ taskId, agent, ok, detail }) {
    if (typeof fireAlert !== "function") return;
    const message =
      `Dispatch ${ok ? "completed" : "failed"} for task ${taskId} (agent ${agent})` +
      (detail ? `: ${detail}` : "");
    try {
      Promise.resolve(
        fireAlert({
          type: "dispatchComplete",
          severity: ok ? "info" : "warn",
          task: taskId,
          message,
        }),
      ).catch((e) => {
        console.error("[Dispatch] dispatchComplete alert failed:", e.message);
      });
    } catch (e) {
      console.error("[Dispatch] dispatchComplete alert failed:", e.message);
    }
  }

  /** Record a failed/timed-out run on the card and move it to failed. */
  function settleFailure(taskId, attemptIndex, agent, { reason, timedOut }) {
    const label = timedOut ? "timeout" : "failed";
    closeAttempt(taskId, attemptIndex, {
      result: "failure",
      note: `${DISPATCH_NOTE} · ${label}: ${reason}`,
    });
    try {
      kanban.addComment(taskId, {
        author: WATCHER_ACTOR,
        text: `[Dispatch] Agent run for ${agent} ${timedOut ? "timed out" : "failed"}: ${reason}`,
      });
    } catch (e) {
      console.error(`[Dispatch] Could not record failure comment on ${taskId}:`, e.message);
    }
    autoMoveOnSettle(taskId, "failed");
    emit({ type: "task.dispatch_failed", taskId, agent, error: reason, timedOut });
    notifyCompletion({ taskId, agent, ok: false, detail: reason });
  }

  function handleRunSettled(taskId, attemptIndex, agent, settled, startedMs) {
    if (settled.ok) {
      const run = parseRunResult(settled.stdout);
      if (run.error) {
        settleFailure(taskId, attemptIndex, agent, {
          reason: shortReason(run.error),
          timedOut: false,
        });
        return;
      }
      const noteParts = [
        DISPATCH_NOTE,
        run.sessionId ? `session ${run.sessionId}` : "completed",
        ...(run.outputText ? [`result: ${snippet(run.outputText)}`] : []),
      ];
      closeAttempt(taskId, attemptIndex, { result: "success", note: noteParts.join(" · ") });
      autoMoveOnSettle(taskId, "review");
      emit({ type: "task.dispatch_completed", taskId, agent, sessionId: run.sessionId });
      notifyCompletion({ taskId, agent, ok: true, detail: null });
      return;
    }
    const err = settled.error || {};
    const timedOut =
      err.killed === true || Boolean(err.signal) || nowFn() - startedMs >= timeoutSec * 1000;
    settleFailure(taskId, attemptIndex, agent, {
      reason: shortReason(err.message, timedOut ? `no exit within ${timeoutSec}s` : "failed"),
      timedOut,
    });
  }

  /**
   * Module status — feeds GET /api/fleet/kanban/dispatch and the UI gate.
   * @returns {object}
   */
  function getStatus() {
    let openCount = 0;
    try {
      openCount = countOpenDispatches(kanban.getBoard());
    } catch (e) {
      console.error("[Dispatch] Status board read failed:", e.message);
    }
    return {
      available: enabled && mechanismAvailable(),
      enabled,
      node: selfNode,
      maxConcurrent,
      openCount,
    };
  }

  /**
   * Preview the kick-off message without side effects.
   * @param {string} taskId
   * @param {{agent: string, node?: string}} opts
   * @returns {{taskId, agent, node, message}}
   */
  function previewDispatch(taskId, opts = {}) {
    ensureAvailable();
    const agent = requireAgent(opts.agent);
    ensureLocalNode(opts.node);
    const { task } = requireTask(taskId);
    return {
      taskId: task.id,
      agent,
      node: selfNode,
      message: composeKickoffMessage(task, { agent, baseUrl, briefsDir }),
    };
  }

  /**
   * Dispatch a card to an agent on THIS node. Resolves as soon as the agent
   * run has been started and the card bookkeeping is recorded — it never
   * waits for the agent turn itself.
   *
   * @param {string} taskId
   * @param {{agent: string, node?: string, actor?: string}} opts
   * @returns {{task, sessionKey, agent, attemptIndex, completion: Promise}}
   */
  function dispatchTask(taskId, opts = {}) {
    ensureAvailable();
    const agent = requireAgent(opts.agent);
    ensureLocalNode(opts.node);
    const actor = typeof opts.actor === "string" && opts.actor ? opts.actor : "operator";
    const { board, task } = requireTask(taskId);

    if (hasOpenDispatch(task)) {
      throw httpError(409, `Task ${taskId} already has an open dispatched attempt`);
    }
    if (countOpenDispatches(board) >= maxConcurrent) {
      throw httpError(
        429,
        `Max concurrent dispatches (${maxConcurrent}) reached — wait for a running dispatch to finish`,
      );
    }

    const startedMs = nowFn();
    const sessionKey = `agent:${agent}:kanban-${taskId}-${startedMs}`;
    const message = composeKickoffMessage(task, { agent, baseUrl, briefsDir });
    const args = [
      "agent",
      "--agent",
      agent,
      "--session-key",
      sessionKey,
      "--message",
      message,
      "--json",
      "--timeout",
      String(timeoutSec),
    ];

    // Fire the agent run NOW (async, never awaited here). Spawn-time
    // failures surface through the same settled handler as run failures.
    const run = typeof execFn === "function" ? execFn : defaultExecFn;
    let settledPromise;
    try {
      settledPromise = Promise.resolve(run(args, { timeoutMs: timeoutSec * 1000 + 5000 })).then(
        ({ stdout }) => ({ ok: true, stdout }),
        (error) => ({ ok: false, error }),
      );
    } catch (e) {
      throw httpError(503, `Dispatch invocation failed: ${e.message}`);
    }

    // Bookkeeping on the card. The attempt index is stable: agents only ever
    // APPEND attempts, so the one we just added keeps its position.
    const afterAttempt = kanban.addAttempt(taskId, { agent, note: DISPATCH_NOTE });
    const attemptIndex = afterAttempt.attempts.length - 1;
    if (task.status === "inbox") {
      kanban.moveTask(taskId, "assigned", task.order, actor);
    }
    kanban.addComment(taskId, {
      author: actor,
      text: `[Dispatch] Dispatched to ${agent} by ${actor} (session key: ${sessionKey})`,
    });
    emit({ type: "task.dispatched", taskId, agent, actor, sessionKey });

    const completion = settledPromise.then((settled) =>
      handleRunSettled(taskId, attemptIndex, agent, settled, startedMs),
    );

    const { task: latest } = requireTask(taskId);
    return { task: latest, sessionKey, agent, attemptIndex, completion };
  }

  return { dispatchTask, previewDispatch, getStatus, composeKickoffMessage };
}

module.exports = {
  createDispatch,
  composeKickoffMessage,
  resolveBinary,
  isOpenDispatchAttempt,
  parseRunResult,
  DISPATCH_NOTE,
};
