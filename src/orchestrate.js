/**
 * Fleet orchestration — multi-agent patterns on top of the dispatch primitive.
 *
 * Where dispatch.js owns the single-agent spawn + follow-through (one card,
 * one agent, one attempt, one completion Promise), this module composes that
 * primitive into the two shapes the Chief needs:
 *
 *   - FAN-IN  (runBoard): ask the SAME question to N agents in parallel, wait
 *     for all of them (with an overall timeout), and COLLECT each agent's full
 *     answer. We do NOT synthesize — the Chief reads {results} and writes the
 *     synthesis. This is the "council" pattern.
 *   - CHAIN   (runChain): a pipeline of steps where step k's answer is injected
 *     as context into step k+1. This is the "assembly line" pattern.
 *
 * Design rules (all inherited from dispatch.js — we never re-implement them):
 *   - Spawn ONLY through dispatch.dispatchTask. That keeps the attempt model,
 *     the open-attempt lock, the concurrency cap, the auto-move-on-settle, the
 *     dispatchComplete alert, and the SSE fan-out identical to a hand
 *     dispatched card. Orchestration is pure composition over that contract.
 *   - Fan-in / sequencing is done over the `completion` Promises that
 *     dispatchTask returns. completion RESOLVES when the run settles (success
 *     OR failure) and never rejects — so Promise.all over them is safe; the
 *     "did it actually succeed" signal is read back off the settled attempt.
 *   - LOCAL ONLY. dispatch.ensureLocalNode refuses remote nodes today, so
 *     board/chain are single-node for now.
 *
 * The full-result-text dependency (IMPORTANT):
 *   dispatch.js currently records only a 300-char `snippet(outputText)` into
 *   the attempt `note`. Board/chain need the FULL answer to collect a council
 *   or to feed the next chain step. We design against a sibling field
 *   `attempt.result_text` that a coordinated change to dispatch.js will set to
 *   the COMPLETE agent output when a run settles successfully. Until that
 *   lands, collection falls back to the truncated note so the module is
 *   testable end to end and degrades visibly (ok:true, truncated:true) rather
 *   than breaking. See readAttemptResultText().
 *
 * The budget-gate dependency (CLOSED ceiling, mid-run):
 *   The POST /api/fleet/orchestrate route gates the WHOLE run before any card
 *   is created (OPEN policy + CLOSED pre-check). For CLOSED runs the per-task
 *   ceiling must ALSO be re-checked mid-flight (between chain steps / before
 *   each board dispatch), because the pre-check only sees the starting state.
 *   runBoard/runChain accept an optional injected `budgetCheck({spentUSD})`
 *   guard; when it returns a block descriptor the run halts and the block is
 *   surfaced on the result. Omitting it (e.g. OPEN mode, or tests) disables the
 *   mid-run halt entirely — the safe default the route composes around.
 */

const crypto = require("crypto");

const DEFAULT_TIMEOUT_SEC = 600;
// Hard ceiling so a caller-supplied timeoutSec can never wedge a request
// thread forever; mirrors dispatch's own grace philosophy.
const MAX_TIMEOUT_SEC = 3600;
const RESULT_TEXT_NOTE_PREFIX = "result: ";

const RUN_ID_PREFIX = "orx_";
// Hard server-side cap for ?wait=true so a sync caller can never block longer
// than this regardless of timeoutSec. Mirrors dispatch's grace philosophy.
const SYNC_WAIT_CAP_MS = 90 * 1000;
// How long a settled (done/failed) entry lingers so a slow poller can still
// read it, then it is reaped to bound memory.
const RUN_TTL_MS = 30 * 60 * 1000;

/** Mint a unique, collision-resistant run id (orx_<16 hex>). */
function newRunId() {
  return RUN_ID_PREFIX + crypto.randomBytes(8).toString("hex");
}

/**
 * In-memory run registry, closed over by createOrchestrate so it shares the
 * module clock (nowFn) + the lifecycle emit. One entry per board/chain run,
 * keyed by runId. Concurrent runs are isolated by id: the background runner
 * only ever replaces its OWN entry. Entries are immutable snapshots — never
 * mutated in place; every progression is a `{...prev, ...patch}` re-set.
 *
 * @param {object} deps
 * @param {function} deps.nowFn - clock (ms since epoch)
 * @param {function} deps.emit - lifecycle emit (orchestration.completed)
 * @param {function} [deps.setTimerFn=setTimeout] - injectable reap timer
 * @returns {object} registry API
 */
function createRunRegistry({ nowFn, emit, setTimerFn = setTimeout }) {
  const runs = new Map();

  /** Start a run entry in "running" and return its snapshot. */
  function open({ runId, mode, agents }) {
    const entry = {
      runId,
      mode, // "board" | "chain"
      status: "running", // running | done | failed
      agents: agents.slice(),
      results: [], // filled when the background run settles
      missing: [], // board: timed-out / refused / budget seats
      final: null, // chain: last successful step text
      stoppedAt: null, // chain: index it halted at, else null
      budgetHalt: null, // block descriptor if cut by CLOSED ceiling
      truncatedAny: false,
      error: null, // set on an UNEXPECTED background throw (status:"failed")
      startedAt: new Date(nowFn()).toISOString(),
      endedAt: null,
    };
    runs.set(runId, entry);
    return entry;
  }

  /** Immutable patch: replace the entry, never mutate in place. */
  function patch(runId, fields) {
    const prev = runs.get(runId);
    if (!prev) return null;
    const next = { ...prev, ...fields };
    // Carry the non-enumerable background promise forward across replacements
    // so waitForRun can still await it after a patch (it is excluded from the
    // JSON snapshot a client reads).
    if (Object.prototype.hasOwnProperty.call(prev, "_completion")) {
      Object.defineProperty(next, "_completion", {
        value: prev._completion,
        enumerable: false,
        configurable: true,
      });
    }
    runs.set(runId, next);
    return next;
  }

  /**
   * Settle a run: merge the collected board/chain result object, stamp endedAt,
   * set terminal status, emit orchestration.completed once, schedule reaping.
   */
  function settle(runId, { status, result }) {
    const next = patch(runId, {
      ...result,
      status, // "done" | "failed"
      endedAt: new Date(nowFn()).toISOString(),
    });
    if (next) {
      emit({
        type: "orchestration.completed",
        runId,
        mode: next.mode,
        status: next.status,
        // counts only — keep the SSE payload light, like dispatch's events
        collected: Array.isArray(next.results)
          ? next.results.filter((r) => r && r.ok).length
          : 0,
        missing: Array.isArray(next.missing) ? next.missing.length : 0,
      });
      scheduleReap(runId);
    }
    return next;
  }

  /** Mark a run failed by an unexpected background throw (not an agent failure). */
  function fail(runId, err) {
    return settle(runId, {
      status: "failed",
      result: { error: String((err && err.message) || err) },
    });
  }

  function get(runId) {
    return runs.get(runId) || null;
  }

  function scheduleReap(runId) {
    const t = setTimerFn(() => runs.delete(runId), RUN_TTL_MS);
    if (t && typeof t.unref === "function") t.unref();
  }

  return { open, patch, settle, fail, get, _size: () => runs.size };
}

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/** Coerce + clamp a caller timeout (seconds) into a sane window. */
function normalizeTimeoutSec(value, fallback) {
  const n = Number.isFinite(value) ? Math.floor(value) : fallback;
  if (n <= 0) return fallback;
  return Math.min(n, MAX_TIMEOUT_SEC);
}

/**
 * Resolve `promise` but never wait longer than `ms`. Resolves to
 * {settled:true, value} on time, {settled:false} on timeout. The underlying
 * promise keeps running (the dispatch watcher still closes its attempt) — we
 * just stop AWAITING it. Never rejects.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms - timeout budget in milliseconds
 * @param {function} [setTimer=setTimeout] - injectable for tests
 * @returns {Promise<{settled: boolean, value?: T}>}
 */
function withTimeout(promise, ms, setTimer = setTimeout) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimer(() => {
      if (done) return;
      done = true;
      resolve({ settled: false });
    }, ms);
    if (timer && typeof timer.unref === "function") timer.unref();
    Promise.resolve(promise).then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ settled: true, value });
      },
      // dispatch.completion never rejects, but be defensive: a thrown
      // composition still counts as "settled with no usable value".
      () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ settled: true, value: undefined });
      },
    );
  });
}

/**
 * Read the FULL agent answer back off a settled attempt.
 *
 * Preference order:
 *   1. attempt.result_text — the full output (sibling dispatch change; see
 *      header). This is the field board/chain are designed around.
 *   2. attempt.note "… · result: <snippet>" — the legacy 300-char snippet, so
 *      the module works BEFORE result_text lands. Flagged truncated:true.
 *
 * @param {object|null} attempt - task.attempts[attemptIndex] after settle
 * @returns {{text: string|null, truncated: boolean}}
 */
function readAttemptResultText(attempt) {
  if (!attempt || typeof attempt !== "object") return { text: null, truncated: false };
  if (typeof attempt.result_text === "string" && attempt.result_text.length > 0) {
    return { text: attempt.result_text, truncated: false };
  }
  // Fallback: pull the snippet back out of the note ("… · result: <snippet>").
  if (typeof attempt.note === "string") {
    const idx = attempt.note.lastIndexOf(RESULT_TEXT_NOTE_PREFIX);
    if (idx !== -1) {
      const snippet = attempt.note.slice(idx + RESULT_TEXT_NOTE_PREFIX.length).trim();
      if (snippet.length > 0) return { text: snippet, truncated: true };
    }
  }
  return { text: null, truncated: false };
}

/** True when a settled attempt represents a successful run. */
function attemptSucceeded(attempt) {
  return !!attempt && attempt.result === "success";
}

/**
 * Compose the council/chain step instruction into a kanban task description.
 * Each orchestrated agent gets its own card so the existing single-card
 * open-attempt lock (one open dispatch per card) is never contended — N agents
 * on ONE card would 409 each other. The shared council `question` (or the
 * chain step `instruction` plus upstream context) becomes the card body, which
 * dispatch.composeKickoffMessage folds into the kickoff verbatim.
 */
function buildCardDescription({ question, instruction, context }) {
  const lines = [];
  if (question) {
    lines.push(question);
  }
  if (instruction) {
    lines.push(instruction);
  }
  if (context && context.trim().length > 0) {
    lines.push("");
    lines.push("--- Context from the previous step ---");
    lines.push(context);
  }
  return lines.join("\n");
}

/**
 * Create the orchestration module.
 *
 * @param {object} options
 * @param {object} options.kanban - kanban engine from createKanban() (for
 *   createTask + reading settled attempts back off the board)
 * @param {object} options.dispatch - module from createDispatch() (the spawn
 *   primitive: dispatchTask returns {..., attemptIndex, completion})
 * @param {function} [options.onEvent] - (event) => void, lifecycle hook mirrored
 *   on dispatch.onEvent (orchestrate.* events; SSE fan-out wired in index.js)
 * @param {object} [options.config] - fleet.orchestrate config section:
 *   {enabled=true, timeoutSec=600}
 * @param {function} [options.nowFn=Date.now] - clock, injectable for tests
 * @param {function} [options.setTimerFn=setTimeout] - timer, injectable for tests
 * @returns {object} orchestration API
 */
function createOrchestrate(options = {}) {
  const {
    kanban,
    dispatch,
    onEvent,
    config = {},
    nowFn = Date.now,
    setTimerFn = setTimeout,
  } = options;
  if (!kanban) throw new Error("createOrchestrate: kanban is required");
  if (!dispatch) throw new Error("createOrchestrate: dispatch is required");

  const enabled = config.enabled !== false;
  const defaultTimeoutSec = normalizeTimeoutSec(config.timeoutSec, DEFAULT_TIMEOUT_SEC);

  // In-memory registry of board/chain runs (for 202 + poll). Shares the
  // module clock + emit; reap timer uses the injected setTimerFn so tests can
  // drive the TTL deterministically.
  const registry = createRunRegistry({ nowFn, emit, setTimerFn });

  function emit(event) {
    if (typeof onEvent === "function") {
      try {
        onEvent(event);
      } catch (e) {
        console.error("[Orchestrate] onEvent handler failed:", e.message);
      }
    }
  }

  function ensureEnabled() {
    if (!enabled) {
      throw httpError(503, "Orchestration is disabled (fleet.orchestrate.enabled=false)");
    }
  }

  /** Validate a non-empty trimmed string field, or throw 400. */
  function requireString(value, field) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw httpError(400, `Body must include a non-empty '${field}' field`);
    }
    return value.trim();
  }

  /**
   * Normalize the optional mid-run budget guard. The route hands us a function
   * `({spentUSD}) => block|null`; orchestration calls it before each unit of
   * work so a CLOSED run halts the moment its per-task ceiling is reached. When
   * no guard is injected (OPEN mode / tests) the run is never halted mid-flight.
   * Defensive: a throwing guard is treated as "no block" so a broken budgets
   * module can never wedge an orchestration.
   *
   * @param {function|undefined} budgetCheck
   * @returns {function({spentUSD:number}):object|null}
   */
  function normalizeBudgetCheck(budgetCheck) {
    if (typeof budgetCheck !== "function") return () => null;
    return ({ spentUSD }) => {
      try {
        return budgetCheck({ spentUSD }) || null;
      } catch (e) {
        console.error("[Orchestrate] budgetCheck guard failed:", e.message);
        return null;
      }
    };
  }

  /**
   * Re-read a task's attempt by index off the CURRENT board. Orchestration
   * awaits dispatch.completion (which closes the attempt) BEFORE calling this,
   * so the settled attempt is already persisted. Best-effort: a hand-deleted
   * card yields null.
   */
  function readSettledAttempt(taskId, attemptIndex) {
    try {
      const task = kanban.getBoard().tasks.find((t) => t.id === taskId);
      if (!task || !Array.isArray(task.attempts)) return null;
      return task.attempts[attemptIndex] || null;
    } catch (e) {
      console.error(`[Orchestrate] Could not read attempt on ${taskId}:`, e.message);
      return null;
    }
  }

  /**
   * Collect one agent's outcome from its settled (or timed-out) attempt.
   * @param {string} taskId
   * @param {{agent, attemptIndex}} dispatched
   * @param {boolean} settled - did the completion Promise resolve in time?
   * @returns {{agent, text, ok, truncated, timedOut}}
   */
  function collectOutcome(taskId, dispatched, settled) {
    if (!settled) {
      return {
        agent: dispatched.agent,
        text: null,
        ok: false,
        truncated: false,
        timedOut: true,
      };
    }
    const attempt = readSettledAttempt(taskId, dispatched.attemptIndex);
    const ok = attemptSucceeded(attempt);
    const { text, truncated } = readAttemptResultText(attempt);
    return { agent: dispatched.agent, text, ok, truncated, timedOut: false };
  }

  /**
   * Start a background run. Mirrors dispatch's fire-and-forget: opens a
   * registry entry, kicks the `runner` un-awaited, and returns the snapshot +
   * the background `completion` promise immediately. The request thread NEVER
   * awaits `runner`; the .then/.catch watcher settles the registry entry later.
   *
   * @param {object} params
   * @param {"board"|"chain"} params.mode
   * @param {string[]} params.agents - ordered agent ids (for the 202 payload)
   * @param {function():Promise<object>} params.runner - resolves to the
   *   collected result object (same shape the old sync runBoard/runChain
   *   returned). An UNEXPECTED throw flips the run to status:"failed".
   * @returns {{runId, entry, completion}}
   */
  function startRun({ mode, agents, runner }) {
    const runId = newRunId();
    const entry = registry.open({ runId, mode, agents });
    // Fire the background work; NEVER await it here. The watcher settles later.
    const completion = Promise.resolve()
      .then(runner)
      .then((result) => registry.settle(runId, { status: "done", result }))
      .catch((err) => registry.fail(runId, err));
    // Stash the background promise on the entry (non-enumerable so it is
    // excluded from the JSON snapshot) so waitForRun / tests can await THIS run.
    Object.defineProperty(entry, "_completion", {
      value: completion,
      enumerable: false,
      configurable: true,
    });
    return { runId, entry, completion };
  }

  /** Registry snapshot for GET /api/fleet/orchestrate/:runId (or null). */
  function getRun(runId) {
    return registry.get(runId);
  }

  /**
   * Resolve when the run reaches a terminal status OR capMs elapses (whichever
   * first). Used only by ?wait=true. The background run keeps going either way
   * — we just stop awaiting. Re-reads the registry post-settle so the caller
   * gets the final (or still-running, on cap) snapshot.
   *
   * @param {string} runId
   * @param {number} [capMs=SYNC_WAIT_CAP_MS] - clamped to SYNC_WAIT_CAP_MS
   * @returns {Promise<object|null>}
   */
  async function waitForRun(runId, capMs = SYNC_WAIT_CAP_MS) {
    const entry = registry.get(runId);
    if (!entry) return null;
    if (entry.status !== "running") return entry; // already settled
    const ms = Math.min(capMs, SYNC_WAIT_CAP_MS);
    await withTimeout(entry._completion, ms, setTimerFn);
    return registry.get(runId); // re-read post-settle (or still running on cap)
  }

  /**
   * Run a single card → agent dispatch. Thin wrapper over dispatch.dispatchTask
   * included for API symmetry (so the Chief can call orchestrate for all three
   * modes through one surface). Returns the dispatch result verbatim — the
   * caller awaits `.completion` itself if it wants the settled outcome.
   *
   * @param {string} taskId - existing kanban card id
   * @param {{agent: string, actor?: string, node?: string}} opts
   * @returns {{task, sessionKey, agent, attemptIndex, completion}}
   */
  function runSingle(taskId, opts = {}) {
    ensureEnabled();
    return dispatch.dispatchTask(taskId, opts);
  }

  /**
   * FAN-IN: ask ONE question to N agents in parallel, collect every answer.
   *
   * One kanban card PER agent (justification: the dispatch open-attempt lock is
   * per-card — N agents sharing a card would 409; per-card also gives each
   * council member its own attempt history, auto-move, and SSE card the UI can
   * render independently). Cards are dispatched in roster order; for a CLOSED
   * run the injected `budgetCheck` is re-evaluated BEFORE each board dispatch so
   * the per-task ceiling halts the fan-out mid-flight. Remaining agents after a
   * halt are flagged in `missing` with reason "budget". We then race each live
   * agent's `completion` Promise against an overall timeout; an agent that does
   * not settle within the budget is flagged in `missing` (reason "timeout") and
   * its (still-running) card is left to the dispatch watcher.
   *
   * We DO NOT synthesize — the Chief reads {results} and writes the synthesis.
   *
   * CONCURRENCY: dispatch enforces maxConcurrent (default 3). If agents.length
   * exceeds it, the later dispatchTask calls throw 429. runBoard surfaces that
   * per-agent (ok:false, dispatchError) rather than aborting the whole council.
   *
   * @param {object} params
   * @param {string} params.title - card title (council question summary)
   * @param {string} params.question - the question every agent answers
   * @param {string[]} params.agents - agent ids to fan the question across
   * @param {string} [params.actor="operator"] - dispatching identity
   * @param {number} [params.timeoutSec] - overall wait budget (default config)
   * @param {function} [params.budgetCheck] - ({spentUSD}) => block|null mid-run
   *   CLOSED ceiling guard (see normalizeBudgetCheck). Omit to disable.
   * @returns {{runId, mode:"board", agents, status:"running", startedAt, completion}}
   *   Returns SYNCHRONOUSLY with a runId; the council runs in the background.
   *   The collected { taskId, question, results, missing, truncatedAny,
   *   budgetHalt } land in the registry when it settles — read them via
   *   getRun(runId) (poll), waitForRun(runId) (bounded sync), or the
   *   orchestration.completed event. `completion` is the background promise (for
   *   ?wait=true + tests); not normally awaited by the request thread.
   */
  function runBoard(params = {}) {
    ensureEnabled();
    const title = requireString(params.title, "title");
    const question = requireString(params.question, "question");
    if (!Array.isArray(params.agents) || params.agents.length === 0) {
      throw httpError(400, "Body must include a non-empty 'agents' array");
    }
    const agents = params.agents.map((a) => requireString(a, "agents[]"));
    const actor = typeof params.actor === "string" && params.actor ? params.actor : "operator";
    const timeoutSec = normalizeTimeoutSec(params.timeoutSec, defaultTimeoutSec);
    const description = buildCardDescription({ question });
    const checkBudget = normalizeBudgetCheck(params.budgetCheck);

    emit({ type: "orchestrate.board_started", title, agents, actor });

    // The fan-in body (seat dispatch + race + collection) runs in the
    // BACKGROUND. It still returns the same { taskId, question, results,
    // missing, truncatedAny, budgetHalt } object — only now the registry
    // consumes it when the council settles.
    const runner = async () => {
      // One card + one dispatch per agent. A dispatch refusal (429 over the
      // cap, 409, unknown agent) is captured per-agent so one bad seat never
      // sinks the whole council. Before each dispatch we re-check the CLOSED
      // ceiling: once it blocks, the rest of the council is flagged
      // budget-missing and never dispatched (the per-task ceiling is the
      // chokepoint).
      let budgetHalt = null;
      const seats = agents.map((agent, i) => {
        if (budgetHalt) {
          return { agent, taskId: null, dispatched: null, error: null, budgetBlocked: true };
        }
        // spentUSD here is the count of agents already dispatched — the
        // runner's accrual hook is per-unit-of-work; the route supplies the
        // real $ guard.
        const block = checkBudget({ spentUSD: i });
        if (block) {
          budgetHalt = block;
          return { agent, taskId: null, dispatched: null, error: null, budgetBlocked: true };
        }
        const card = kanban.createTask({ title: `${title} · ${agent}`, description }, actor);
        try {
          // BOARD flag: every council seat posts to #ceo-boardroom (leading
          // @Chief), NOT its own #<agent>-command channel. dispatch.resolveSlack
          // reads isBoard and derives the boardroom channel.
          const dispatched = dispatch.dispatchTask(card.id, { agent, actor, isBoard: true });
          return { agent, taskId: card.id, dispatched, error: null, budgetBlocked: false };
        } catch (e) {
          return { agent, taskId: card.id, dispatched: null, error: e, budgetBlocked: false };
        }
      });

      // Race every live completion against ONE shared deadline. Cards that
      // failed to dispatch (or were never dispatched due to a budget halt)
      // resolve immediately as not-settled.
      const budgetMs = timeoutSec * 1000;
      const outcomes = await Promise.all(
        seats.map(async (seat) => {
          if (!seat.dispatched) {
            return {
              agent: seat.agent,
              taskId: seat.taskId,
              text: null,
              ok: false,
              truncated: false,
              timedOut: false,
              budgetBlocked: !!seat.budgetBlocked,
              dispatchError: seat.error ? seat.error.message : null,
            };
          }
          const raced = await withTimeout(seat.dispatched.completion, budgetMs, setTimerFn);
          const outcome = collectOutcome(seat.taskId, seat.dispatched, raced.settled);
          return { ...outcome, taskId: seat.taskId, budgetBlocked: false, dispatchError: null };
        }),
      );

      const results = outcomes.map(({ agent, text, ok, truncated, taskId }) => ({
        agent,
        taskId,
        text,
        ok,
        truncated,
      }));
      const missing = outcomes
        .filter((o) => o.timedOut || o.dispatchError || o.budgetBlocked)
        .map((o) => ({
          agent: o.agent,
          taskId: o.taskId,
          reason: o.budgetBlocked
            ? "budget"
            : o.timedOut
              ? "timeout"
              : `dispatch refused: ${o.dispatchError}`,
        }));
      const truncatedAny = results.some((r) => r.truncated);

      emit({
        type: "orchestrate.board_completed",
        title,
        collected: results.filter((r) => r.ok).length,
        missing: missing.length,
      });

      return {
        taskId: seats.find((s) => s.taskId) ? seats.find((s) => s.taskId).taskId : null,
        question,
        results,
        missing,
        truncatedAny,
        budgetHalt,
      };
    };

    const { runId, entry, completion } = startRun({ mode: "board", agents, runner });
    return {
      runId,
      mode: "board",
      agents,
      status: "running",
      startedAt: entry.startedAt,
      completion,
    };
  }

  /**
   * CHAIN: run an ordered pipeline of {agent, instruction} steps, injecting
   * each settled step's full result as context into the next step's card body.
   *
   * One card per step (same lock + history justification as runBoard). Steps
   * run STRICTLY sequentially — step k+1 is not dispatched until step k's
   * completion settles — because k+1 needs k's answer. Before EACH step the
   * injected `budgetCheck` is re-evaluated; a CLOSED ceiling hit halts the
   * chain (remaining steps skipped, budgetHalt set). A failed or timed-out step
   * also SHORT-CIRCUITS the chain: downstream steps are marked skipped, and
   * `final` is the last step that actually produced text.
   *
   * @param {object} params
   * @param {string} params.title - chain title (prefix for each step card)
   * @param {Array<{agent: string, instruction: string}>} params.steps
   * @param {string} [params.actor="operator"]
   * @param {number} [params.timeoutSec] - PER-STEP wait budget (default config)
   * @param {function} [params.budgetCheck] - ({spentUSD}) => block|null mid-run
   *   CLOSED ceiling guard re-checked BEFORE each step. Omit to disable.
   * @returns {{runId, mode:"chain", agents, status:"running", startedAt, completion}}
   *   Returns SYNCHRONOUSLY with a runId; the pipeline runs in the background.
   *   The collected { title, steps, final, ok, stoppedAt, budgetHalt } lands in
   *   the registry when it settles — read via getRun/waitForRun/the
   *   orchestration.completed event. steps: ordered [{agent, taskId, text, ok,
   *   truncated, skipped}]; final: last successful step text; stoppedAt: failing
   *   step index or null; budgetHalt: CLOSED-ceiling block descriptor or null.
   */
  function runChain(params = {}) {
    ensureEnabled();
    const title = requireString(params.title, "title");
    if (!Array.isArray(params.steps) || params.steps.length === 0) {
      throw httpError(400, "Body must include a non-empty 'steps' array");
    }
    const steps = params.steps.map((step, i) => {
      if (!step || typeof step !== "object") {
        throw httpError(400, `steps[${i}] must be an object`);
      }
      return {
        agent: requireString(step.agent, `steps[${i}].agent`),
        instruction: requireString(step.instruction, `steps[${i}].instruction`),
      };
    });
    const actor = typeof params.actor === "string" && params.actor ? params.actor : "operator";
    const timeoutSec = normalizeTimeoutSec(params.timeoutSec, defaultTimeoutSec);
    const budgetMs = timeoutSec * 1000;
    const checkBudget = normalizeBudgetCheck(params.budgetCheck);

    emit({ type: "orchestrate.chain_started", title, steps: steps.length, actor });

    // The full sequential pipeline runs in the BACKGROUND and still returns the
    // same { title, steps, final, ok, stoppedAt, budgetHalt } object. Chain
    // steps keep their own #<agent>-command channel (NO isBoard flag) — only
    // board councils post to #ceo-boardroom.
    const runner = async () => {
      const results = [];
      let context = null; // settled full text of the previous step
      let final = null;
      let stoppedAt = null;
      let budgetHalt = null;

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];

        // Once the chain has stopped, remaining steps are recorded as skipped
        // (never dispatched) so the result array stays aligned with the input.
        if (stoppedAt !== null) {
          results.push({
            agent: step.agent,
            taskId: null,
            text: null,
            ok: false,
            truncated: false,
            skipped: true,
          });
          continue;
        }

        // CLOSED ceiling re-check BEFORE this step. spentUSD here is the index
        // of completed steps; the route supplies the real $ guard.
        const block = checkBudget({ spentUSD: i });
        if (block) {
          budgetHalt = block;
          stoppedAt = i;
          results.push({
            agent: step.agent,
            taskId: null,
            text: null,
            ok: false,
            truncated: false,
            skipped: true,
            budgetBlocked: true,
          });
          continue;
        }

        const description = buildCardDescription({ instruction: step.instruction, context });
        const card = kanban.createTask(
          { title: `${title} · step ${i + 1}/${steps.length} · ${step.agent}`, description },
          actor,
        );

        let dispatched;
        try {
          dispatched = dispatch.dispatchTask(card.id, { agent: step.agent, actor });
        } catch (e) {
          results.push({
            agent: step.agent,
            taskId: card.id,
            text: null,
            ok: false,
            truncated: false,
            skipped: false,
            error: e.message,
          });
          stoppedAt = i;
          continue;
        }

        const raced = await withTimeout(dispatched.completion, budgetMs, setTimerFn);
        const outcome = collectOutcome(card.id, dispatched, raced.settled);
        results.push({
          agent: step.agent,
          taskId: card.id,
          text: outcome.text,
          ok: outcome.ok,
          truncated: outcome.truncated,
          skipped: false,
          timedOut: outcome.timedOut,
        });

        if (!outcome.ok || !outcome.text) {
          // No usable result — the next step has nothing to build on. Stop.
          stoppedAt = i;
          continue;
        }
        // Success: feed this step's full answer forward and record it as final.
        context = outcome.text;
        final = outcome.text;
      }

      const ok = stoppedAt === null;
      emit({ type: "orchestrate.chain_completed", title, ok, stoppedAt });
      return { title, steps: results, final, ok, stoppedAt, budgetHalt };
    };

    const { runId, entry, completion } = startRun({
      mode: "chain",
      agents: steps.map((s) => s.agent),
      runner,
    });
    return {
      runId,
      mode: "chain",
      agents: steps.map((s) => s.agent),
      status: "running",
      startedAt: entry.startedAt,
      completion,
    };
  }

  /**
   * Module status — feeds the UI gate / a future GET probe, mirroring
   * dispatch.getStatus shape so the client can treat them uniformly.
   * @returns {{available: boolean, enabled: boolean, timeoutSec: number}}
   */
  function getStatus() {
    return { available: enabled, enabled, timeoutSec: defaultTimeoutSec };
  }

  return { runSingle, runBoard, runChain, getStatus, getRun, waitForRun };
}

module.exports = {
  createOrchestrate,
  createRunRegistry,
  newRunId,
  withTimeout,
  readAttemptResultText,
  normalizeTimeoutSec,
  buildCardDescription,
  SYNC_WAIT_CAP_MS,
  RUN_TTL_MS,
};
