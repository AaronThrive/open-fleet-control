/**
 * Phase E tests — atomic task checkout + dispatch liveness watchdog.
 *
 * (a) Two concurrent claims of the SAME card → exactly one wins, the loser is
 *     blocked and does NOT proceed (no agent run fired).
 * (b) The watchdog reclaims a stale claim once, respects the retry cap, snoozes
 *     (does not re-sweep the same open attempt), and does NOT touch fresh
 *     in-flight work.
 * (c) Boot wiring (the NOOP stand-in) doesn't crash when disabled.
 *
 * Uses a REAL kanban engine on a temp state dir and a MOCKED execFn — no real
 * agent is ever invoked.
 */

const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createKanban } = require("../src/kanban");
const { createDispatch, DISPATCH_NOTE, isOpenDispatchAttempt } = require("../src/dispatch");
const { createDispatchWatchdog } = require("../src/dispatch-watchdog");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ofc-phaseE-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let dirCounter = 0;
function freshKanban() {
  const stateDir = path.join(tmpRoot, `state-${dirCounter++}`);
  fs.mkdirSync(stateDir, { recursive: true });
  return createKanban({ stateDir });
}

/** Count open dispatched attempts on a task (mirrors dispatch's lock math). */
function openLockCount(task, nowMs, openTtlMs = 1200 * 1000 + 15 * 60 * 1000) {
  return task.attempts.filter((a) => isOpenDispatchAttempt(a, nowMs, openTtlMs)).length;
}

// ---------------------------------------------------------------------------
// (a) Atomic checkout — compare-and-set claim
// ---------------------------------------------------------------------------

describe("atomic checkout: kanban.claimTask", () => {
  let kanban;
  let task;
  beforeEach(() => {
    kanban = freshKanban();
    task = kanban.createTask({ title: "Claim me" }, "tester");
  });

  it("two concurrent claims → exactly one wins, the loser is blocked", () => {
    // The precondition is "no open dispatched attempt yet". Both claimers read
    // the same starting state, but claimTask re-checks at write time, so they
    // serialize: first writes the lock, second sees it and is refused.
    const TTL = 1200 * 1000 + 15 * 60 * 1000;
    const precondition = (fresh) =>
      !fresh.attempts.some((a) => isOpenDispatchAttempt(a, Date.now(), TTL));

    const first = kanban.claimTask(task.id, { agent: "alpha", note: DISPATCH_NOTE, precondition });
    const second = kanban.claimTask(task.id, { agent: "beta", note: DISPATCH_NOTE, precondition });

    const winners = [first, second].filter((r) => r.claimed);
    const losers = [first, second].filter((r) => !r.claimed);
    assert.strictEqual(winners.length, 1, "exactly one claimer wins");
    assert.strictEqual(losers.length, 1, "exactly one claimer is blocked");
    assert.match(losers[0].reason, /precondition not satisfied/);

    // Only ONE open lock persisted on the card.
    const after = kanban.getBoard().tasks.find((t) => t.id === task.id);
    assert.strictEqual(openLockCount(after, Date.now()), 1, "single open lock on the board");
    assert.strictEqual(after.attempts.length, 1, "loser appended nothing");
  });

  it("a failed precondition writes nothing and reports a reason", () => {
    const r = kanban.claimTask(task.id, {
      agent: "alpha",
      precondition: () => false,
    });
    assert.strictEqual(r.claimed, false);
    const after = kanban.getBoard().tasks.find((t) => t.id === task.id);
    assert.strictEqual(after.attempts.length, 0, "no attempt appended when refused");
  });

  it("validates inputs", () => {
    assert.throws(() => kanban.claimTask(task.id, { precondition: () => true }), /agent/);
    assert.throws(() => kanban.claimTask(task.id, { agent: "a" }), /precondition/);
  });
});

describe("atomic checkout: dispatchTask blocks the concurrent loser", () => {
  it("two concurrent dispatchTask calls → one fires a run, the other 409s", () => {
    const kanban = freshKanban();
    const task = kanban.createTask({ title: "Race" }, "tester");
    const execCalls = [];
    // execFn returns a never-settling promise so both attempts stay "in flight"
    // for the duration of the test (we only care which one got to FIRE).
    const execFn = (args) => {
      execCalls.push(args);
      return new Promise(() => {});
    };
    const dispatch = createDispatch({
      kanban,
      execFn,
      config: { enabled: true, maxConcurrent: 3, timeoutSec: 1200 },
    });

    const results = [];
    for (const agent of ["alpha", "beta"]) {
      try {
        dispatch.dispatchTask(task.id, { agent });
        results.push({ agent, ok: true });
      } catch (e) {
        results.push({ agent, ok: false, status: e.statusCode, message: e.message });
      }
    }

    const wins = results.filter((r) => r.ok);
    const blocked = results.filter((r) => !r.ok);
    assert.strictEqual(wins.length, 1, "exactly one dispatch proceeds");
    assert.strictEqual(blocked.length, 1, "exactly one dispatch is blocked");
    assert.strictEqual(blocked[0].status, 409, "loser blocked with 409");
    assert.strictEqual(execCalls.length, 1, "loser did NOT fire an agent run");

    const after = kanban.getBoard().tasks.find((t) => t.id === task.id);
    assert.strictEqual(openLockCount(after, Date.now()), 1, "single open dispatch lock");
  });
});

// ---------------------------------------------------------------------------
// (b) Liveness watchdog / stale-lock sweeper
// ---------------------------------------------------------------------------

describe("dispatch watchdog: stale-lock reclaim", () => {
  let kanban;
  let clock;
  const STALE_AFTER = 15 * 60 * 1000;

  beforeEach(() => {
    kanban = freshKanban();
    clock = Date.now();
  });
  const now = () => clock;

  /**
   * Open a dispatched lock on a card stamped at the CURRENT fake clock, so the
   * watchdog's age math (nowMs - startedMs) is exact and each lock gets a
   * distinct started_at fingerprint (production locks always differ because a
   * full sweep interval elapses between them).
   */
  function openDispatch(taskId, agent = "alpha") {
    return kanban.addAttempt(taskId, {
      agent,
      note: DISPATCH_NOTE,
      started_at: new Date(clock).toISOString(),
    });
  }

  it("does NOT touch fresh in-flight work", () => {
    const task = kanban.createTask({ title: "Fresh", status: "inprogress" }, "tester");
    openDispatch(task.id);
    const reclaims = [];
    const wd = createDispatchWatchdog({
      kanban,
      config: { staleAfterMs: STALE_AFTER, maxRetries: 2 },
      // timeoutSec 60 → the watchdog's safety floor (timeoutSec+60s) stays below
      // STALE_AFTER, so these tests exercise the intended 15-min reclaim semantics
      // (models a fleet whose dispatches time out fast, making a 15-min lock wedged).
      dispatchConfig: { timeoutSec: 60 },
      fireAlert: (e) => reclaims.push(e),
      now,
    });
    // 5 minutes later — still well under the 15-min threshold.
    clock += 5 * 60 * 1000;
    const swept = wd.check();
    assert.deepStrictEqual(swept, [], "no fresh lock reclaimed");
    assert.strictEqual(reclaims.length, 0, "no alert fired for fresh work");
    const after = kanban.getBoard().tasks.find((t) => t.id === task.id);
    assert.strictEqual(openLockCount(after, now()), 1, "lock left intact");
  });

  it("reclaims a stale lock once, re-dispatches under the cap, then snoozes", () => {
    const task = kanban.createTask({ title: "Stuck", status: "inprogress" }, "tester");
    openDispatch(task.id);
    const reclaims = [];
    const redispatched = [];
    const wd = createDispatchWatchdog({
      kanban,
      config: { staleAfterMs: STALE_AFTER, maxRetries: 2 },
      // timeoutSec 60 → the watchdog's safety floor (timeoutSec+60s) stays below
      // STALE_AFTER, so these tests exercise the intended 15-min reclaim semantics
      // (models a fleet whose dispatches time out fast, making a 15-min lock wedged).
      dispatchConfig: { timeoutSec: 60 },
      // redispatch wrapper opens a brand-new lock (what real dispatchTask does).
      redispatch: (taskId, { agent }) => {
        redispatched.push({ taskId, agent });
        openDispatch(taskId, agent);
      },
      fireAlert: (e) => reclaims.push(e),
      now,
    });

    // Advance past the threshold and sweep.
    clock += STALE_AFTER + 1000;
    const swept1 = wd.check();
    assert.deepStrictEqual(swept1, [task.id], "stale lock reclaimed once");
    assert.strictEqual(redispatched.length, 1, "re-dispatched under the cap");
    assert.strictEqual(reclaims.length, 1);
    assert.strictEqual(reclaims[0].type, "dispatchReclaimed");
    assert.strictEqual(reclaims[0].severity, "warn", "retry → warn severity");

    // The OLD lock was closed (reclaimed) and a NEW lock opened by redispatch.
    const afterReclaim = kanban.getBoard().tasks.find((t) => t.id === task.id);
    const closed = afterReclaim.attempts.filter((a) => a.ended_at !== null);
    assert.ok(
      closed.some((a) => /reclaimed/.test(a.note || "")),
      "old attempt marked reclaimed",
    );
    assert.strictEqual(openLockCount(afterReclaim, now()), 1, "exactly one fresh lock now");

    // Snooze: an immediate re-sweep (clock barely moved, new lock is fresh)
    // must NOT reclaim again.
    clock += 1000;
    const swept2 = wd.check();
    assert.deepStrictEqual(swept2, [], "snoozed — fresh re-dispatch not reclaimed");
    assert.strictEqual(reclaims.length, 1, "no second alert while snoozed");
  });

  it("respects the retry cap → marks the card failed instead of looping", () => {
    const task = kanban.createTask({ title: "Doomed", status: "inprogress" }, "tester");
    openDispatch(task.id);
    const reclaims = [];
    const wd = createDispatchWatchdog({
      kanban,
      config: { staleAfterMs: STALE_AFTER, maxRetries: 2 },
      // timeoutSec 60 → the watchdog's safety floor (timeoutSec+60s) stays below
      // STALE_AFTER, so these tests exercise the intended 15-min reclaim semantics
      // (models a fleet whose dispatches time out fast, making a 15-min lock wedged).
      dispatchConfig: { timeoutSec: 60 },
      redispatch: (taskId, { agent }) => openDispatch(taskId, agent),
      fireAlert: (e) => reclaims.push(e),
      now,
    });

    // Drive three stale sweeps. Each sweep needs the current lock to be stale,
    // so advance the clock past the threshold before each one.
    for (let i = 0; i < 3; i++) {
      clock += STALE_AFTER + 1000;
      wd.check();
    }

    // retries 1 and 2 re-dispatch (warn); retry 3 hits the cap → failed (critical).
    assert.strictEqual(reclaims.length, 3, "reclaimed three times");
    assert.strictEqual(reclaims[0].severity, "warn");
    assert.strictEqual(reclaims[1].severity, "warn");
    assert.strictEqual(reclaims[2].severity, "critical", "cap reached → critical");
    assert.match(reclaims[2].message, /retry cap/);

    const final = kanban.getBoard().tasks.find((t) => t.id === task.id);
    assert.strictEqual(final.status, "failed", "card moved to failed at the cap");
    assert.strictEqual(openLockCount(final, now()), 0, "no open lock left after failure");
    assert.strictEqual(wd.getState().tracked, 1, "card still tracked (snooze bookkeeping)");
  });

  it("re-arms when the lock closes normally (no open lock → drop snooze)", () => {
    const task = kanban.createTask({ title: "Recovers", status: "inprogress" }, "tester");
    const afterClaim = openDispatch(task.id);
    const attemptIndex = afterClaim.attempts.length - 1;
    const wd = createDispatchWatchdog({
      kanban,
      config: { staleAfterMs: STALE_AFTER, maxRetries: 2 },
      // timeoutSec 60 → the watchdog's safety floor (timeoutSec+60s) stays below
      // STALE_AFTER, so these tests exercise the intended 15-min reclaim semantics
      // (models a fleet whose dispatches time out fast, making a 15-min lock wedged).
      dispatchConfig: { timeoutSec: 60 },
      redispatch: () => {},
      fireAlert: () => {},
      now,
    });
    // Lock closes (run settled) before going stale.
    kanban.updateAttempt(task.id, attemptIndex, {
      ended_at: new Date(now()).toISOString(),
      result: "success",
    });
    clock += STALE_AFTER + 1000;
    const swept = wd.check();
    assert.deepStrictEqual(swept, [], "closed lock is not reclaimed");
    assert.strictEqual(wd.getState().tracked, 0, "snooze bookkeeping dropped (re-armed)");
  });
});

// ---------------------------------------------------------------------------
// (c) Boot wiring — disabled / NOOP path
// ---------------------------------------------------------------------------

describe("dispatch watchdog: boot wiring", () => {
  it("constructs and runs with sane defaults", () => {
    const kanban = freshKanban();
    const wd = createDispatchWatchdog({ kanban });
    const st = wd.getState();
    assert.strictEqual(st.running, false);
    assert.strictEqual(st.checkIntervalMs, 60000);
    assert.strictEqual(st.staleAfterMs, 1500000);
    assert.strictEqual(st.maxRetries, 2);
    // start()/stop() must not throw and must be idempotent.
    wd.start();
    wd.start();
    assert.strictEqual(wd.getState().running, true);
    wd.stop();
    wd.stop();
    assert.strictEqual(wd.getState().running, false);
  });

  it("requires a kanban engine", () => {
    assert.throws(() => createDispatchWatchdog({}), /kanban is required/);
  });

  it("NOOP stand-in (disabled path) is inert and safe to drive", () => {
    // Mirrors the NOOP_DISPATCH_WATCHDOG used in index.js when disabled.
    const noop = { check: () => [], start() {}, stop() {}, getState: () => ({ running: false }) };
    assert.deepStrictEqual(noop.check(), []);
    assert.doesNotThrow(() => {
      noop.start();
      noop.stop();
    });
    assert.strictEqual(noop.getState().running, false);
  });
});
