/**
 * Unit + integration tests for src/orchestrate.js — multi-agent fan-in /
 * chain composed over the dispatch primitive.
 *
 * Injection seams (mirroring the dispatch tests' style): a FAKE kanban that
 * records created cards and serves attempts back off an in-memory board, a
 * FAKE dispatch whose dispatchTask returns controllable `completion` promises +
 * settled attempts, and an injected setTimerFn so timeouts are deterministic.
 * No real kanban store, no real agent, no real timers.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createOrchestrate,
  withTimeout,
  readAttemptResultText,
  normalizeTimeoutSec,
  buildCardDescription,
} = require("../src/orchestrate");

/**
 * Fake kanban: cards live in a flat array. Each card's attempts can be set by
 * the fake dispatch when a run "settles", so orchestrate's readSettledAttempt
 * (which re-reads off getBoard()) sees the final state.
 */
function makeKanban() {
  let counter = 0;
  const tasks = [];
  return {
    created: tasks,
    createTask(fields, actor) {
      const task = {
        id: `tsk_${++counter}`,
        title: fields.title,
        description: fields.description,
        status: "inbox",
        attempts: [],
        actor,
      };
      tasks.push(task);
      return task;
    },
    getBoard() {
      return { tasks };
    },
    // test helper: stamp a settled attempt onto a card
    _settle(taskId, attempt) {
      const task = tasks.find((t) => t.id === taskId);
      if (task) task.attempts = [attempt];
    },
  };
}

/**
 * Fake dispatch. Each call to dispatchTask consumes the next scripted outcome:
 *   { result, text, resultText, never, throwError }
 * - throwError: dispatchTask throws synchronously (e.g. 429 over cap).
 * - never: completion never resolves (drives the timeout path).
 * - otherwise: completion resolves after stamping a settled attempt with the
 *   given result ("success"|"failure"), result_text (resultText) and/or note.
 */
function makeDispatch(kanban, outcomes) {
  const calls = [];
  let i = 0;
  return {
    calls,
    dispatchTask(taskId, opts) {
      const outcome = outcomes[i++] || { result: "success", text: "ok" };
      calls.push({ taskId, agent: opts.agent, actor: opts.actor });
      if (outcome.throwError) {
        const err = new Error(outcome.throwError.message || "refused");
        err.statusCode = outcome.throwError.statusCode || 429;
        throw err;
      }
      const attemptIndex = 0;
      const completion = outcome.never
        ? new Promise(() => {}) // never settles
        : Promise.resolve().then(() => {
            const attempt = { result: outcome.result || "success" };
            if (outcome.resultText !== undefined) attempt.result_text = outcome.resultText;
            if (outcome.note !== undefined) attempt.note = outcome.note;
            if (outcome.text !== undefined && outcome.resultText === undefined) {
              attempt.result_text = outcome.text;
            }
            kanban._settle(taskId, attempt);
          });
      return {
        task: { id: taskId, status: "assigned" },
        sessionKey: `agent:${opts.agent}:kanban-${taskId}-1`,
        agent: opts.agent,
        attemptIndex,
        completion,
      };
    },
  };
}

/** Immediate fake timer (fires the timeout callback on next tick). */
function immediateTimer(fn, _ms) {
  return setTimeout(fn, 0);
}

function makeOrchestrate(kanban, dispatch, config = {}) {
  return createOrchestrate({ kanban, dispatch, config, setTimerFn: setTimeout });
}

/**
 * runBoard/runChain are now ASYNC starters: they return { runId, status:
 * "running", completion } synchronously and settle the registry in the
 * background. This helper restores the old "await the collected result"
 * ergonomics for the existing scenario tests: start the run, await its
 * background completion, and return the settled registry snapshot (which is a
 * superset of the old return — same results/missing/final/stoppedAt fields).
 */
async function settleBoard(orch, params) {
  const run = orch.runBoard(params);
  await run.completion;
  return orch.getRun(run.runId);
}
async function settleChain(orch, params) {
  const run = orch.runChain(params);
  await run.completion;
  return orch.getRun(run.runId);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("normalizeTimeoutSec", () => {
  it("clamps <= 0 and non-finite to the fallback", () => {
    assert.strictEqual(normalizeTimeoutSec(0, 600), 600);
    assert.strictEqual(normalizeTimeoutSec(-5, 600), 600);
    assert.strictEqual(normalizeTimeoutSec(NaN, 600), 600);
    assert.strictEqual(normalizeTimeoutSec("nope", 600), 600);
  });
  it("floors floats and caps at the hard max", () => {
    assert.strictEqual(normalizeTimeoutSec(12.9, 600), 12);
    assert.strictEqual(normalizeTimeoutSec(99999, 600), 3600);
  });
});

describe("readAttemptResultText", () => {
  it("prefers result_text (not truncated)", () => {
    const r = readAttemptResultText({ result_text: "full answer", note: "x · result: snip" });
    assert.strictEqual(r.text, "full answer");
    assert.strictEqual(r.truncated, false);
    assert.strictEqual(r.failureCopy, null);
  });
  // AC-19: the note fallback is intentionally REMOVED. When result_text is
  // absent/null, OFC surfaces the explicit failure copy (FAILURE_RESULT_COPY),
  // NEVER the 300-char note snippet. The old "falls back to note" test is
  // replaced with the new AC-19 contract.
  it("AC-19: null result_text → null text + FAILURE_RESULT_COPY (never the note snippet)", () => {
    const r = readAttemptResultText({ note: "dispatched · session abc · result: a snippet" });
    assert.strictEqual(r.text, null, "text must be null when result_text is absent");
    assert.strictEqual(r.truncated, false);
    assert.ok(
      typeof r.failureCopy === "string" && r.failureCopy.length > 0,
      "failureCopy must be a non-empty string (explicit failure copy)",
    );
    // Critical: the note snippet must NOT be surfaced.
    assert.notStrictEqual(r.text, "a snippet", "note snippet must never be surfaced");
  });
  it("returns null text + failureCopy for a bare/dispatched attempt", () => {
    const r1 = readAttemptResultText({ note: "dispatched" });
    assert.strictEqual(r1.text, null);
    assert.strictEqual(r1.truncated, false);
    assert.ok(typeof r1.failureCopy === "string" && r1.failureCopy.length > 0);
    const r2 = readAttemptResultText(null);
    assert.strictEqual(r2.text, null);
    assert.strictEqual(r2.truncated, false);
    assert.ok(typeof r2.failureCopy === "string" && r2.failureCopy.length > 0);
  });
});

describe("buildCardDescription", () => {
  it("injects upstream context under a header", () => {
    const d = buildCardDescription({ instruction: "do X", context: "prior answer" });
    assert.match(d, /do X/);
    assert.match(d, /Context from the previous step/);
    assert.match(d, /prior answer/);
  });
  it("omits the context block when empty", () => {
    const d = buildCardDescription({ question: "Q?" });
    assert.strictEqual(d, "Q?");
  });
});

describe("withTimeout", () => {
  it("resolves {settled:true,value} before the deadline", async () => {
    const r = await withTimeout(Promise.resolve(42), 1000, setTimeout);
    assert.deepStrictEqual(r, { settled: true, value: 42 });
  });
  it("resolves {settled:false} after the deadline (injected fast timer)", async () => {
    const r = await withTimeout(new Promise(() => {}), 5, immediateTimer);
    assert.deepStrictEqual(r, { settled: false });
  });
  it("never rejects even if the inner promise rejects", async () => {
    const r = await withTimeout(Promise.reject(new Error("boom")), 1000, setTimeout);
    assert.deepStrictEqual(r, { settled: true, value: undefined });
  });
});

// ---------------------------------------------------------------------------
// runSingle
// ---------------------------------------------------------------------------

describe("runSingle", () => {
  it("delegates to dispatch.dispatchTask and returns it verbatim", () => {
    const kanban = makeKanban();
    const dispatch = makeDispatch(kanban, [{ result: "success", text: "x" }]);
    const orch = makeOrchestrate(kanban, dispatch);
    const card = kanban.createTask({ title: "T", description: "d" }, "op");
    const result = orch.runSingle(card.id, { agent: "dev", actor: "aaron" });
    assert.strictEqual(result.agent, "dev");
    assert.strictEqual(dispatch.calls[0].taskId, card.id);
  });

  it("throws 503 when disabled", () => {
    const kanban = makeKanban();
    const dispatch = makeDispatch(kanban, []);
    const orch = makeOrchestrate(kanban, dispatch, { enabled: false });
    assert.throws(() => orch.runSingle("tsk_1", { agent: "dev" }), (e) => e.statusCode === 503);
  });
});

// ---------------------------------------------------------------------------
// runBoard (fan-in)
// ---------------------------------------------------------------------------

describe("runBoard", () => {
  it("collects every agent on success, one card per agent, no missing", async () => {
    const kanban = makeKanban();
    const dispatch = makeDispatch(kanban, [
      { result: "success", resultText: "A1" },
      { result: "success", resultText: "A2" },
      { result: "success", resultText: "A3" },
    ]);
    const orch = makeOrchestrate(kanban, dispatch);
    const out = await settleBoard(orch, {
      title: "Council",
      question: "What now?",
      agents: ["a", "b", "c"],
    });
    assert.strictEqual(out.results.length, 3);
    assert.ok(out.results.every((r) => r.ok === true));
    assert.deepStrictEqual(
      out.results.map((r) => r.text),
      ["A1", "A2", "A3"],
    );
    assert.deepStrictEqual(out.missing, []);
    assert.strictEqual(out.truncatedAny, false);
    assert.strictEqual(kanban.created.length, 3); // one card per agent
    assert.strictEqual(out.taskId, kanban.created[0].id); // first card is the anchor
  });

  it("flags a non-settling agent in missing with reason timeout; collects the rest", async () => {
    const kanban = makeKanban();
    const dispatch = makeDispatch(kanban, [
      { result: "success", resultText: "A1" },
      { never: true },
      { result: "success", resultText: "A3" },
    ]);
    // tiny per-board timeout so the never-settling seat times out fast
    const orch = createOrchestrate({ kanban, dispatch, setTimerFn: immediateTimer });
    const out = await settleBoard(orch, {
      title: "C",
      question: "Q",
      agents: ["a", "b", "c"],
      timeoutSec: 1,
    });
    const collected = out.results.filter((r) => r.ok).map((r) => r.text);
    assert.deepStrictEqual(collected.sort(), ["A1", "A3"]);
    assert.strictEqual(out.missing.length, 1);
    assert.strictEqual(out.missing[0].agent, "b");
    assert.strictEqual(out.missing[0].reason, "timeout");
  });

  it("keeps a settled-but-failed agent in results (ok:false), NOT in missing", async () => {
    const kanban = makeKanban();
    const dispatch = makeDispatch(kanban, [
      { result: "success", resultText: "A1" },
      { result: "failure", note: "dispatched · failed: boom" },
    ]);
    const orch = makeOrchestrate(kanban, dispatch);
    const out = await settleBoard(orch, { title: "C", question: "Q", agents: ["a", "b"] });
    const failed = out.results.find((r) => r.agent === "b");
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(out.missing.length, 0); // it answered, just failed
  });

  // AC-19: when result_text is null (only note present), the board result
  // surfaces FAILURE_RESULT_COPY — never the note snippet. The old
  // "flags truncated" test is updated to match the AC-19 contract.
  it("AC-19: null result_text (only note) → null text, truncated:false (never note snippet)", async () => {
    const kanban = makeKanban();
    const dispatch = makeDispatch(kanban, [
      { result: "success", note: "dispatched · session s · result: snippet only" },
    ]);
    const orch = makeOrchestrate(kanban, dispatch);
    const out = await settleBoard(orch, { title: "C", question: "Q", agents: ["a"] });
    // The note snippet must NOT be surfaced.
    assert.notStrictEqual(out.results[0].text, "snippet only", "note must never be surfaced");
    // ok reflects what the dispatcher reported (result:"success" → ok:true).
    // text is null because result_text is absent (dispatcher produced no canonical output).
    // Per AC-19, text is null (not the note snippet), and truncated:false.
    assert.strictEqual(out.results[0].ok, true, "ok reflects the dispatcher result field");
    assert.strictEqual(out.results[0].text, null, "text is null when result_text is absent");
    assert.strictEqual(out.results[0].truncated, false, "truncated:false per AC-19");
    // truncatedAny must also be false (no more truncation flag from note fallback).
    assert.strictEqual(out.truncatedAny, false, "truncatedAny:false per AC-19");
  });

  it("surfaces a dispatch 429 per-seat (reason 'dispatch refused'), collects the rest", async () => {
    const kanban = makeKanban();
    const dispatch = makeDispatch(kanban, [
      { result: "success", resultText: "A1" },
      { result: "success", resultText: "A2" },
      { result: "success", resultText: "A3" },
      { throwError: { statusCode: 429, message: "Max concurrent dispatches (3) reached" } },
    ]);
    const orch = makeOrchestrate(kanban, dispatch);
    const out = await settleBoard(orch, {
      title: "C",
      question: "Q",
      agents: ["a", "b", "c", "d"],
    });
    assert.strictEqual(out.results.filter((r) => r.ok).length, 3);
    const refused = out.missing.find((m) => m.agent === "d");
    assert.match(refused.reason, /^dispatch refused/);
  });

  it("halts the fan-out mid-flight on a CLOSED budget block (reason 'budget')", async () => {
    const kanban = makeKanban();
    const dispatch = makeDispatch(kanban, [
      { result: "success", resultText: "A1" },
      { result: "success", resultText: "A2" },
    ]);
    const orch = makeOrchestrate(kanban, dispatch);
    // block before the 2nd seat (spentUSD reaches 1)
    const budgetCheck = ({ spentUSD }) =>
      spentUSD >= 1 ? { reason: "closed-ceiling-exceeded", message: "halt" } : null;
    const out = await settleBoard(orch, {
      title: "C",
      question: "Q",
      agents: ["a", "b"],
      budgetCheck,
    });
    assert.ok(out.budgetHalt);
    assert.strictEqual(out.results.filter((r) => r.ok).length, 1); // only 'a' ran
    const blocked = out.missing.find((m) => m.agent === "b");
    assert.strictEqual(blocked.reason, "budget");
    assert.strictEqual(kanban.created.length, 1); // 'b' card never created
  });

  it("validates title/question/agents (400, thrown synchronously by the starter)", () => {
    const kanban = makeKanban();
    const orch = makeOrchestrate(kanban, makeDispatch(kanban, []));
    assert.throws(
      () => orch.runBoard({ title: "", question: "Q", agents: ["a"] }),
      (e) => e.statusCode === 400,
    );
    assert.throws(
      () => orch.runBoard({ title: "T", question: "Q", agents: [] }),
      (e) => e.statusCode === 400,
    );
  });

  it("sequential: keeps exactly one dispatch open at a time, still collects all", async () => {
    const kanban = makeKanban();
    let open = 0;
    let maxOpen = 0;
    const dispatch = {
      calls: [],
      dispatchTask(taskId, opts) {
        open += 1;
        maxOpen = Math.max(maxOpen, open);
        this.calls.push({ taskId, agent: opts.agent });
        const completion = Promise.resolve().then(() => {
          kanban._settle(taskId, { result: "success", result_text: opts.agent });
          open -= 1;
        });
        return { task: { id: taskId }, sessionKey: "k", agent: opts.agent, attemptIndex: 0, completion };
      },
    };
    const orch = makeOrchestrate(kanban, dispatch);
    const out = await settleBoard(orch, {
      title: "C",
      question: "Q",
      agents: ["a", "b", "c"],
      sequential: true,
    });
    // The whole point: parallel would open all 3 dispatches up front; sequential
    // never overlaps, so the single gateway event loop is never co-saturated.
    assert.strictEqual(maxOpen, 1);
    assert.strictEqual(out.results.length, 3);
    assert.ok(out.results.every((r) => r.ok === true));
    assert.deepStrictEqual(out.missing, []);
    assert.strictEqual(kanban.created.length, 3);
  });

  it("sequential: a timed-out seat is flagged missing but the rest still run (board, not chain)", async () => {
    const kanban = makeKanban();
    const dispatch = makeDispatch(kanban, [
      { result: "success", resultText: "A1" },
      { never: true }, // b never settles -> timeout, must NOT short-circuit c
      { result: "success", resultText: "A3" },
    ]);
    const orch = createOrchestrate({ kanban, dispatch, setTimerFn: immediateTimer });
    const out = await settleBoard(orch, {
      title: "C",
      question: "Q",
      agents: ["a", "b", "c"],
      sequential: true,
      timeoutSec: 1,
    });
    assert.deepStrictEqual(
      out.results.map((r) => [r.agent, r.ok]),
      [
        ["a", true],
        ["b", false],
        ["c", true],
      ],
    );
    assert.strictEqual(out.missing.length, 1);
    assert.strictEqual(out.missing[0].agent, "b");
    assert.strictEqual(out.missing[0].reason, "timeout");
  });

  it("server default sequentialBoard:true makes an omitted-flag board sequential", async () => {
    const kanban = makeKanban();
    let open = 0;
    let maxOpen = 0;
    const dispatch = {
      calls: [],
      dispatchTask(taskId, opts) {
        open += 1;
        maxOpen = Math.max(maxOpen, open);
        const completion = Promise.resolve().then(() => {
          kanban._settle(taskId, { result: "success", result_text: opts.agent });
          open -= 1;
        });
        return { task: { id: taskId }, sessionKey: "k", agent: opts.agent, attemptIndex: 0, completion };
      },
    };
    const orch = makeOrchestrate(kanban, dispatch, { sequentialBoard: true });
    // NOTE: no `sequential` field in params — the server default must apply.
    const out = await settleBoard(orch, { title: "C", question: "Q", agents: ["a", "b", "c"] });
    assert.strictEqual(maxOpen, 1);
    assert.strictEqual(out.results.length, 3);
    assert.ok(out.results.every((r) => r.ok === true));
  });

  it("per-run sequential:false overrides the server default (forces parallel)", async () => {
    const kanban = makeKanban();
    let open = 0;
    let maxOpen = 0;
    const dispatch = {
      calls: [],
      dispatchTask(taskId, opts) {
        open += 1;
        maxOpen = Math.max(maxOpen, open);
        const completion = Promise.resolve().then(() => {
          kanban._settle(taskId, { result: "success", result_text: opts.agent });
          open -= 1;
        });
        return { task: { id: taskId }, sessionKey: "k", agent: opts.agent, attemptIndex: 0, completion };
      },
    };
    const orch = makeOrchestrate(kanban, dispatch, { sequentialBoard: true });
    const out = await settleBoard(orch, {
      title: "C",
      question: "Q",
      agents: ["a", "b", "c"],
      sequential: false,
    });
    // Override wins: all three dispatched up front (parallel fan-out).
    assert.strictEqual(maxOpen, 3);
    assert.strictEqual(out.results.length, 3);
  });
});

// ---------------------------------------------------------------------------
// runChain (sequential context-passing)
// ---------------------------------------------------------------------------

describe("runChain", () => {
  it("passes each step's full text into the next step's card description", async () => {
    const kanban = makeKanban();
    const dispatch = makeDispatch(kanban, [
      { result: "success", resultText: "STEP1-OUT" },
      { result: "success", resultText: "STEP2-OUT" },
      { result: "success", resultText: "STEP3-OUT" },
    ]);
    const orch = makeOrchestrate(kanban, dispatch);
    const out = await settleChain(orch, {
      title: "Pipe",
      steps: [
        { agent: "a", instruction: "do 1" },
        { agent: "b", instruction: "do 2" },
        { agent: "c", instruction: "do 3" },
      ],
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.stoppedAt, null);
    assert.strictEqual(out.final, "STEP3-OUT");
    // step 2's card body must contain step 1's full answer
    assert.match(kanban.created[1].description, /STEP1-OUT/);
    assert.match(kanban.created[2].description, /STEP2-OUT/);
  });

  it("short-circuits on a failed step: downstream skipped, final = last good", async () => {
    const kanban = makeKanban();
    const dispatch = makeDispatch(kanban, [
      { result: "success", resultText: "S1" },
      { result: "failure", note: "dispatched · failed: nope" },
    ]);
    const orch = makeOrchestrate(kanban, dispatch);
    const out = await settleChain(orch, {
      title: "Pipe",
      steps: [
        { agent: "a", instruction: "1" },
        { agent: "b", instruction: "2" },
        { agent: "c", instruction: "3" },
      ],
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.stoppedAt, 1);
    assert.strictEqual(out.final, "S1");
    assert.strictEqual(out.steps[2].skipped, true);
    assert.strictEqual(out.steps[2].taskId, null);
    assert.strictEqual(kanban.created.length, 2); // step 3 never created
  });

  it("stops at step 0 when the first dispatch throws", async () => {
    const kanban = makeKanban();
    const dispatch = makeDispatch(kanban, [
      { throwError: { statusCode: 429, message: "cap reached" } },
    ]);
    const orch = makeOrchestrate(kanban, dispatch);
    const out = await settleChain(orch, {
      title: "Pipe",
      steps: [
        { agent: "a", instruction: "1" },
        { agent: "b", instruction: "2" },
      ],
    });
    assert.strictEqual(out.stoppedAt, 0);
    assert.strictEqual(out.final, null);
    assert.strictEqual(out.steps[1].skipped, true);
  });

  it("halts the chain on a mid-run CLOSED budget block", async () => {
    const kanban = makeKanban();
    const dispatch = makeDispatch(kanban, [
      { result: "success", resultText: "S1" },
      { result: "success", resultText: "S2" },
    ]);
    const orch = makeOrchestrate(kanban, dispatch);
    const budgetCheck = ({ spentUSD }) =>
      spentUSD >= 1 ? { reason: "closed-ceiling-exceeded", message: "halt" } : null;
    const out = await settleChain(orch, {
      title: "Pipe",
      steps: [
        { agent: "a", instruction: "1" },
        { agent: "b", instruction: "2" },
      ],
      budgetCheck,
    });
    assert.ok(out.budgetHalt);
    assert.strictEqual(out.stoppedAt, 1);
    assert.strictEqual(out.final, "S1");
    assert.strictEqual(out.steps[1].skipped, true);
    assert.strictEqual(out.steps[1].budgetBlocked, true);
    assert.strictEqual(kanban.created.length, 1); // step 2 never created
  });

  it("validates steps array + per-step fields (400, thrown synchronously by the starter)", () => {
    const kanban = makeKanban();
    const orch = makeOrchestrate(kanban, makeDispatch(kanban, []));
    assert.throws(
      () => orch.runChain({ title: "T", steps: [] }),
      (e) => e.statusCode === 400,
    );
    assert.throws(
      () => orch.runChain({ title: "T", steps: [{ agent: "a" }] }),
      (e) => e.statusCode === 400,
    );
  });
});

describe("getStatus", () => {
  it("reports availability + the default timeout", () => {
    const kanban = makeKanban();
    const orch = makeOrchestrate(kanban, makeDispatch(kanban, []), { timeoutSec: 300 });
    assert.deepStrictEqual(orch.getStatus(), {
      available: true,
      enabled: true,
      timeoutSec: 300,
      // M-2 — pre-dispatch fan-out gate inputs. Spawn disabled here, so pool
      // routing is off and no per-seat projection is configured.
      routeToPool: false,
      perSeatCostUSD: 0,
    });
  });
});
