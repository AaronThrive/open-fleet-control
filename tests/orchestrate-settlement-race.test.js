/**
 * Regression test for the board-settlement race — the root cause of
 * "board runs 15+ min in status:running, ZERO answers collected, seats retried".
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ROOT CAUSE (proven below with the REAL kanban + REAL dispatch + REAL
 * orchestrate; only the `openclaw` exec is stubbed):
 *
 *   orchestrate's per-seat wait was `withTimeout(completion, budgetMs)` with
 *   `budgetMs = orchestrate.timeoutSec * 1000`. In production config
 *   orchestrate.timeoutSec === dispatch.timeoutSec (both 1200). But dispatch
 *   resolves `completion` only AFTER it kills the CLI at
 *   `dispatch.timeoutSec*1000 + 5000` AND the watcher writes the settled
 *   attempt. So the runner's BARE budget (timeoutSec*1000) always expires
 *   ~5s+ BEFORE completion can resolve for a seat that uses its full budget.
 *
 *   Two failures cascade from that one race:
 *     (a) the seat is recorded timedOut → `missing:timeout`, its answer lost,
 *         EVEN THOUGH the agent produced one; and
 *     (b) because the runner abandoned the wait, that seat's dispatch attempt
 *         is still OPEN (ended_at === null). In a sequential board it keeps
 *         counting toward dispatch's maxConcurrent cap, so LATER seats can be
 *         refused with 429 — the run never collects a single answer.
 *
 * THE FIX: wait `budgetMs + COMPLETION_GRACE_MS` (grace > dispatch's own
 * +5000ms kill buffer + the attempt write), so `completion` reliably wins the
 * race whenever the agent actually answered. The withTimeout fallback still
 * bounds a genuinely-stuck dispatch, so the runner can never wedge forever.
 *
 * These tests pin the budget to dispatch's REAL kill horizon (the production
 * coupling), so they fail on the bare-budget code and pass on the fix.
 * ────────────────────────────────────────────────────────────────────────────
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createKanban } = require("../src/kanban");
const { createDispatch } = require("../src/dispatch");
const { createOrchestrate } = require("../src/orchestrate");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ofc-settle-"));
let dirCounter = 0;

function freshKanban() {
  const stateDir = path.join(tmpRoot, `state-${dirCounter++}`);
  fs.mkdirSync(stateDir, { recursive: true });
  return createKanban({ stateDir });
}

/** A valid `openclaw agent --json` stdout carrying a session id + answer text. */
function openclawStdout(agent, answer) {
  return JSON.stringify({
    runId: "run_x",
    status: "ok",
    summary: "completed",
    result: {
      payloads: [{ text: answer }],
      meta: { agentMeta: { sessionId: `sess-${agent}` } },
    },
  });
}

/**
 * Stubbed execFn standing in for the REAL `openclaw` binary. It honours the
 * dispatch-supplied `timeoutMs` exactly like execFile would: if the agent's
 * answer lands before timeoutMs it resolves with stdout; if not, it REJECTS
 * with a killed-process error (err.killed=true) — the same shape execFile
 * produces on a timeout kill. This is what lets the test exercise dispatch's
 * real kill horizon (timeoutSec*1000 + 5000) and the watcher's timeout path.
 *
 * Everything else — the dispatch watcher, kanban attempt writes, attempt
 * indexing, auto-move, and the orchestrate runner — is production code.
 */
function makeExecFn(settleAfterMs, answerFor) {
  return (args, { timeoutMs }) => {
    const agent = args[args.indexOf("--agent") + 1];
    return new Promise((resolve, reject) => {
      const answerTimer = setTimeout(() => {
        clearTimeout(killTimer);
        resolve({ stdout: openclawStdout(agent, answerFor(agent)) });
      }, settleAfterMs);
      const killTimer = setTimeout(() => {
        clearTimeout(answerTimer);
        const err = new Error(`Command failed: openclaw (timed out after ${timeoutMs}ms)`);
        err.killed = true;
        err.signal = "SIGTERM";
        reject(err);
      }, timeoutMs);
    });
  };
}

describe("board settlement race — completion must win against dispatch's kill horizon", () => {
  it("collects a seat that answers PAST the bare per-seat budget but within the kill+grace window (the fix)", async () => {
    const kanban = freshKanban();

    // Production coupling: orchestrate.timeoutSec === dispatch.timeoutSec.
    // Scaled to 1s so the test is fast. dispatch kills the CLI at
    // 1*1000 + 5000 = 6000ms; completion resolves AFTER that + the attempt
    // write. The agent answers at 1200ms — PAST the bare 1000ms budget (so the
    // OLD code abandoned the wait and lost the answer) but well before the kill,
    // so with COMPLETION_GRACE_MS the runner waits long enough to collect it.
    const SHARED_TIMEOUT_SEC = 1; // dispatch + orchestrate both 1s (the real coupling)
    const SETTLE_MS = 1200; // agent answers 200ms after the bare budget expires

    const dispatch = createDispatch({
      kanban,
      config: { baseUrl: "http://127.0.0.1:3333", timeoutSec: SHARED_TIMEOUT_SEC, maxConcurrent: 3 },
      execFn: makeExecFn(SETTLE_MS, (a) => `ANSWER from ${a}`),
    });
    const orchestrate = createOrchestrate({
      kanban,
      dispatch,
      config: { timeoutSec: SHARED_TIMEOUT_SEC, sequentialBoard: true },
    });

    const run = orchestrate.runBoard({
      title: "race proof",
      question: "what is your job?",
      agents: ["ops", "finance"],
      actor: "test",
      timeoutSec: SHARED_TIMEOUT_SEC,
      sequential: true,
    });

    const snap = await orchestrate.waitForRun(run.runId, 90 * 1000);
    assert.strictEqual(snap.status, "done", "run reaches terminal status");
    assert.strictEqual(snap.results.length, 2, "two seats collected");

    for (const r of snap.results) {
      assert.strictEqual(r.ok, true, `seat ${r.agent} settled ok (not lost to the race)`);
      assert.match(r.text || "", /ANSWER from/, `seat ${r.agent} answer captured`);
    }
    assert.deepStrictEqual(snap.missing, [], "no seat is wrongly flagged missing");

    // Each card's dispatch attempt settled success with result_text, and the
    // watcher auto-moved it out of assigned/inprogress. Board dispatches go
    // straight to `done` (the boardroom never leaves a growing pile in review).
    const board = kanban.getBoard();
    for (const task of board.tasks) {
      const a0 = task.attempts[0];
      assert.strictEqual(a0.result, "success", `${task.id} attempt settled success`);
      assert.strictEqual(a0.ended_at !== null, true, `${task.id} attempt is CLOSED`);
      assert.ok(a0.result_text && a0.result_text.length > 0, `${task.id} captured result_text`);
      assert.strictEqual(task.status, "done", `${task.id} auto-moved to done`);
    }
  });

  it("does NOT starve later sequential seats: seat 1 closes before seat 2 dispatches (no 429 cascade)", async () => {
    const kanban = freshKanban();
    // Three seats answering past the bare budget. Under the OLD bare-budget
    // code, seat 1's wait was abandoned with its attempt still OPEN, which kept
    // counting toward maxConcurrent (set to 1 here to make the cascade
    // deterministic) and 429'd seats 2 and 3 — the "every seat retried, never
    // settles" production signature. With the fix, each seat closes before the
    // next dispatches, so a cap of 1 is sufficient and every seat is collected.
    const SHARED_TIMEOUT_SEC = 1;
    const SETTLE_MS = 1200;

    const dispatch = createDispatch({
      kanban,
      config: { baseUrl: "http://127.0.0.1:3333", timeoutSec: SHARED_TIMEOUT_SEC, maxConcurrent: 1 },
      execFn: makeExecFn(SETTLE_MS, (a) => `ANSWER from ${a}`),
    });
    const orchestrate = createOrchestrate({
      kanban,
      dispatch,
      config: { timeoutSec: SHARED_TIMEOUT_SEC, sequentialBoard: true },
    });

    const run = orchestrate.runBoard({
      title: "cascade proof",
      question: "q",
      agents: ["ops", "dev", "finance"],
      actor: "test",
      timeoutSec: SHARED_TIMEOUT_SEC,
      sequential: true,
    });

    const snap = await orchestrate.waitForRun(run.runId, 90 * 1000);
    assert.strictEqual(snap.status, "done");
    assert.strictEqual(snap.results.length, 3, "all three seats collected");
    for (const r of snap.results) {
      assert.strictEqual(r.ok, true, `seat ${r.agent} collected (no 429 starvation)`);
      assert.match(r.text || "", /ANSWER from/, `seat ${r.agent} answer captured`);
    }
    assert.deepStrictEqual(snap.missing, [], "no seat lost to 429/timeout cascade");
  });

  it("a genuinely STUCK dispatch is still bounded — settles done with a TERMINAL failure, never wedges", async () => {
    const kanban = freshKanban();
    // The agent NEVER answers. dispatch kills the CLI at timeoutSec*1000 + 5000;
    // the watcher records the attempt as result:"failure" (note "timeout: …")
    // and auto-moves the card to `failed`. completion then resolves (at the kill
    // horizon, WITHIN the runner's budget+grace window), so the seat is a
    // SETTLED FAILURE in results (ok:false, text:null → caller surfaces
    // FAILURE_RESULT_COPY) — a terminal outcome, not a silent loss and not an
    // infinite wedge. This proves the grace BOUNDS the wait, and that a stuck
    // seat is reported terminally rather than hanging the run.
    const SHARED_TIMEOUT_SEC = 1;
    const NEVER_MS = 60 * 60 * 1000; // far beyond the kill horizon

    const dispatch = createDispatch({
      kanban,
      config: { baseUrl: "http://127.0.0.1:3333", timeoutSec: SHARED_TIMEOUT_SEC, maxConcurrent: 3 },
      execFn: makeExecFn(NEVER_MS, (a) => `never ${a}`),
    });
    const orchestrate = createOrchestrate({
      kanban,
      dispatch,
      config: { timeoutSec: SHARED_TIMEOUT_SEC, sequentialBoard: true },
    });

    const run = orchestrate.runBoard({
      title: "stuck proof",
      question: "q",
      agents: ["ops"],
      actor: "test",
      timeoutSec: SHARED_TIMEOUT_SEC,
      sequential: true,
    });

    const snap = await orchestrate.waitForRun(run.runId, 90 * 1000);
    assert.strictEqual(snap.status, "done", "run still reaches a terminal status (no wedge)");
    assert.strictEqual(snap.results.length, 1, "the stuck seat is present in results");
    assert.strictEqual(snap.results[0].ok, false, "stuck seat is not falsely collected");
    assert.strictEqual(snap.results[0].text, null, "stuck seat carries no text (caller uses failure copy)");

    // Dispatch killed the CLI at its own horizon and recorded a TERMINAL
    // failure on the attempt; the card auto-moved to `failed`. This is the
    // settled-failure terminal outcome, not an orchestrate-side timeout.
    const task = kanban.getBoard().tasks[0];
    assert.strictEqual(task.attempts[0].result, "failure", "attempt settled as failure");
    assert.strictEqual(task.attempts[0].ended_at !== null, true, "attempt is closed (not left open)");
    assert.strictEqual(task.status, "failed", "card auto-moved to failed");
  });

  it("collects a seat that settles WELL WITHIN budget (no regression for fast seats)", async () => {
    const kanban = freshKanban();
    // Fast seat: settles at 30ms, budget 5s. Must still be collected.
    const dispatch = createDispatch({
      kanban,
      config: { baseUrl: "http://127.0.0.1:3333", timeoutSec: 30, maxConcurrent: 3 },
      execFn: makeExecFn(30, (a) => `FAST ${a}`),
    });
    const orchestrate = createOrchestrate({
      kanban,
      dispatch,
      config: { timeoutSec: 5, sequentialBoard: true },
    });

    const run = orchestrate.runBoard({
      title: "fast proof",
      question: "q",
      agents: ["ops"],
      actor: "test",
      timeoutSec: 5,
      sequential: true,
    });

    const snap = await orchestrate.waitForRun(run.runId, 90 * 1000);
    assert.strictEqual(snap.status, "done");
    assert.strictEqual(snap.results[0].ok, true, "fast seat collected");
    assert.match(snap.results[0].text || "", /FAST ops/);
    assert.deepStrictEqual(snap.missing, []);
  });
});
