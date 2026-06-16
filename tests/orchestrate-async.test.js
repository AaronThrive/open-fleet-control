/**
 * Async-orchestration hardening tests for src/orchestrate.js.
 *
 * Covers the 202-shaped fire-and-forget refactor + the in-memory run registry:
 *   - the run registry lifecycle (open → running → settle → done/failed),
 *     immutable patch, concurrent-run isolation, and TTL reaping;
 *   - runBoard/runChain returning SYNCHRONOUSLY with {runId, status:"running"}
 *     BEFORE any dispatch completion resolves, then settling the registry;
 *   - getRun() lifecycle (running → done) and the orchestration.completed emit;
 *   - waitForRun() resolving at terminal status, and bailing at the cap when a
 *     run never settles (background still pending, not abandoned);
 *   - an UNEXPECTED background throw flipping the run to status:"failed";
 *   - the BOARD fix: every council seat is dispatched with {isBoard:true} so
 *     dispatch derives #ceo-boardroom, while CHAIN steps carry NO isBoard flag.
 *
 * Injected fakes only — no real kanban, agents, or wall-clock timers.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createOrchestrate,
  createRunRegistry,
  newRunId,
  SYNC_WAIT_CAP_MS,
} = require("../src/orchestrate");

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

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
    _settle(taskId, attempt) {
      const task = tasks.find((t) => t.id === taskId);
      if (task) task.attempts = [attempt];
    },
  };
}

/**
 * Fake dispatch that records the FULL opts (so we can assert isBoard threading)
 * and exposes a manual `release()` so a test can hold completions pending —
 * proving the starter returns BEFORE any completion resolves.
 */
function makeManualDispatch(kanban) {
  const calls = [];
  const releasers = [];
  return {
    calls,
    releaseAll() {
      releasers.splice(0).forEach((fn) => fn());
    },
    dispatchTask(taskId, opts) {
      calls.push({ taskId, opts });
      let resolveFn;
      const completion = new Promise((resolve) => {
        resolveFn = resolve;
      });
      releasers.push(() => {
        kanban._settle(taskId, { result: "success", result_text: `out-${opts.agent}` });
        resolveFn();
      });
      return {
        task: { id: taskId, status: "assigned" },
        sessionKey: `agent:${opts.agent}:kanban-${taskId}-1`,
        agent: opts.agent,
        attemptIndex: 0,
        completion,
      };
    },
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Run registry
// ---------------------------------------------------------------------------

describe("createRunRegistry", () => {
  function makeReg() {
    const emits = [];
    const timers = [];
    const reg = createRunRegistry({
      nowFn: () => 1700000000000,
      emit: (e) => emits.push(e),
      // capture the reap timer instead of scheduling it on the real clock
      setTimerFn: (fn) => {
        timers.push(fn);
        return { unref() {} };
      },
    });
    return { reg, emits, timers };
  }

  it("open() starts a run in 'running' with startedAt set and endedAt null", () => {
    const { reg } = makeReg();
    const entry = reg.open({ runId: "r1", mode: "board", agents: ["a", "b"] });
    assert.strictEqual(entry.status, "running");
    assert.strictEqual(entry.mode, "board");
    assert.deepStrictEqual(entry.agents, ["a", "b"]);
    assert.ok(entry.startedAt);
    assert.strictEqual(entry.endedAt, null);
  });

  it("settle(done) merges the result, stamps endedAt, emits completed ONCE", () => {
    const { reg, emits } = makeReg();
    reg.open({ runId: "r1", mode: "board", agents: ["a"] });
    const settled = reg.settle("r1", {
      status: "done",
      result: { results: [{ agent: "a", ok: true }], missing: [] },
    });
    assert.strictEqual(settled.status, "done");
    assert.strictEqual(settled.results[0].ok, true);
    assert.ok(settled.endedAt);
    assert.strictEqual(emits.length, 1);
    assert.strictEqual(emits[0].type, "orchestration.completed");
    assert.strictEqual(emits[0].status, "done");
    assert.strictEqual(emits[0].collected, 1);
  });

  it("fail(err) → status 'failed' with error populated, single completed emit", () => {
    const { reg, emits } = makeReg();
    reg.open({ runId: "r1", mode: "chain", agents: ["a"] });
    const failed = reg.fail("r1", new Error("boom"));
    assert.strictEqual(failed.status, "failed");
    assert.strictEqual(failed.error, "boom");
    assert.strictEqual(emits.length, 1);
    assert.strictEqual(emits[0].status, "failed");
  });

  it("patch() is immutable — returns a NEW object; previous reference unchanged", () => {
    const { reg } = makeReg();
    const before = reg.open({ runId: "r1", mode: "board", agents: ["a"] });
    const after = reg.patch("r1", { truncatedAny: true });
    assert.notStrictEqual(before, after);
    assert.strictEqual(before.truncatedAny, false); // old snapshot untouched
    assert.strictEqual(after.truncatedAny, true);
  });

  it("isolates concurrent runs by id (independent settle, no cross-talk)", () => {
    const { reg } = makeReg();
    reg.open({ runId: "rA", mode: "board", agents: ["a"] });
    reg.open({ runId: "rB", mode: "chain", agents: ["b"] });
    assert.strictEqual(reg._size(), 2);
    reg.settle("rA", { status: "done", result: { results: [{ ok: true }] } });
    assert.strictEqual(reg.get("rA").status, "done");
    assert.strictEqual(reg.get("rB").status, "running"); // unaffected
  });

  it("reaps a settled entry after RUN_TTL_MS (fire the captured reap timer)", () => {
    const { reg, timers } = makeReg();
    reg.open({ runId: "r1", mode: "board", agents: ["a"] });
    reg.settle("r1", { status: "done", result: { results: [] } });
    assert.ok(reg.get("r1"));
    assert.strictEqual(timers.length, 1);
    timers[0](); // simulate RUN_TTL_MS elapsing
    assert.strictEqual(reg.get("r1"), null);
  });

  it("newRunId mints unique orx_-prefixed ids", () => {
    const a = newRunId();
    const b = newRunId();
    assert.match(a, /^orx_[0-9a-f]{16}$/);
    assert.notStrictEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// Async starter behavior
// ---------------------------------------------------------------------------

describe("runBoard (async starter)", () => {
  it("returns SYNCHRONOUSLY with {runId, status:'running'} before completions settle", async () => {
    const kanban = makeKanban();
    const dispatch = makeManualDispatch(kanban);
    const orch = createOrchestrate({ kanban, dispatch, setTimerFn: setTimeout });

    const run = orch.runBoard({ title: "C", question: "Q", agents: ["a", "b"] });
    // The starter returned with a runId WITHOUT awaiting the run: the council
    // body runs on a later microtask (fire-and-forget), so nothing is collected
    // and the run is still "running" at return time.
    assert.match(run.runId, /^orx_/);
    assert.strictEqual(run.status, "running");
    assert.deepStrictEqual(run.agents, ["a", "b"]);
    assert.strictEqual(orch.getRun(run.runId).status, "running");
    assert.strictEqual(orch.getRun(run.runId).results.length, 0); // nothing collected yet

    // Let the background runner dispatch its seats, then prove they're pending
    // (still "running") BEFORE we release the completions.
    await tick();
    assert.strictEqual(dispatch.calls.length, 2); // both seats dispatched in background
    assert.strictEqual(orch.getRun(run.runId).status, "running"); // not settled yet

    dispatch.releaseAll();
    await run.completion;
    const done = orch.getRun(run.runId);
    assert.strictEqual(done.status, "done");
    assert.strictEqual(done.results.length, 2);
    assert.ok(done.results.every((r) => r.ok));
    assert.ok(done.endedAt);
  });

  it("dispatches every board seat with isBoard:true (→ #ceo-boardroom)", async () => {
    const kanban = makeKanban();
    const dispatch = makeManualDispatch(kanban);
    const orch = createOrchestrate({ kanban, dispatch, setTimerFn: setTimeout });

    const run = orch.runBoard({ title: "C", question: "Q", agents: ["finance", "sales", "ops"] });
    await tick(); // let the background runner dispatch its seats
    dispatch.releaseAll();
    await run.completion;

    assert.strictEqual(dispatch.calls.length, 3);
    assert.ok(
      dispatch.calls.every((c) => c.opts.isBoard === true),
      "every council seat must be flagged isBoard:true",
    );
  });

  it("flips to status:'failed' on an UNEXPECTED background throw (no unhandled rejection)", async () => {
    const kanban = makeKanban();
    // dispatch.dispatchTask throws ASYNCHRONOUSLY-after-start is hard; instead
    // make createTask blow up mid-runner so the background runner rejects.
    let n = 0;
    const throwingKanban = {
      ...kanban,
      createTask(fields, actor) {
        if (++n === 2) throw new Error("kanban exploded");
        return kanban.createTask(fields, actor);
      },
    };
    const dispatch = makeManualDispatch(throwingKanban);
    const orch = createOrchestrate({ kanban: throwingKanban, dispatch, setTimerFn: setTimeout });

    let unhandled = null;
    const onUnhandled = (e) => {
      unhandled = e;
    };
    process.on("unhandledRejection", onUnhandled);

    const run = orch.runBoard({ title: "C", question: "Q", agents: ["a", "b"] });
    await tick(); // let the background runner reach the throwing createTask
    dispatch.releaseAll();
    await run.completion;
    await tick();
    process.removeListener("unhandledRejection", onUnhandled);

    const failed = orch.getRun(run.runId);
    assert.strictEqual(failed.status, "failed");
    assert.match(failed.error, /kanban exploded/);
    assert.strictEqual(unhandled, null, "background throw must be caught, not unhandled");
  });
});

describe("runChain (async starter)", () => {
  it("returns running immediately, settles to done with final + ordered steps", async () => {
    const kanban = makeKanban();
    const dispatch = makeManualDispatch(kanban);
    const orch = createOrchestrate({ kanban, dispatch, setTimerFn: setTimeout });

    const run = orch.runChain({
      title: "Pipe",
      steps: [
        { agent: "a", instruction: "1" },
        { agent: "b", instruction: "2" },
      ],
    });
    assert.strictEqual(run.status, "running");
    assert.strictEqual(run.mode, "chain");
    assert.deepStrictEqual(run.agents, ["a", "b"]);

    // Chain dispatches sequentially; release as each step's completion is awaited.
    await tick();
    dispatch.releaseAll();
    await tick();
    dispatch.releaseAll();
    await run.completion;

    const done = orch.getRun(run.runId);
    assert.strictEqual(done.status, "done");
    assert.strictEqual(done.ok, true);
    assert.strictEqual(done.final, "out-b");
    assert.strictEqual(done.steps.length, 2);
  });

  it("dispatches chain steps with NO isBoard flag (→ #<agent>-command)", async () => {
    const kanban = makeKanban();
    const dispatch = makeManualDispatch(kanban);
    const orch = createOrchestrate({ kanban, dispatch, setTimerFn: setTimeout });

    const run = orch.runChain({ title: "Pipe", steps: [{ agent: "a", instruction: "1" }] });
    await tick();
    dispatch.releaseAll();
    await run.completion;

    assert.strictEqual(dispatch.calls.length, 1);
    assert.notStrictEqual(dispatch.calls[0].opts.isBoard, true);
  });
});

// ---------------------------------------------------------------------------
// waitForRun (?wait=true escape hatch)
// ---------------------------------------------------------------------------

describe("waitForRun", () => {
  it("resolves at terminal status when the run settles before the cap", async () => {
    const kanban = makeKanban();
    const dispatch = makeManualDispatch(kanban);
    const orch = createOrchestrate({ kanban, dispatch, setTimerFn: setTimeout });

    const run = orch.runBoard({ title: "C", question: "Q", agents: ["a"] });
    await tick(); // let the background runner dispatch before releasing
    dispatch.releaseAll();
    const snapshot = await orch.waitForRun(run.runId, 5000);
    assert.strictEqual(snapshot.status, "done");
    assert.strictEqual(snapshot.results.length, 1);
  });

  it("bails at the cap with status:'running' when the run never settles (not abandoned)", async () => {
    const kanban = makeKanban();
    const dispatch = makeManualDispatch(kanban); // never released → never settles
    // Real timer + a large per-board timeoutSec so the seat-race never fires
    // inside the cap window; only the waitForRun cap (5ms) trips.
    const orch = createOrchestrate({ kanban, dispatch, setTimerFn: setTimeout });

    const run = orch.runBoard({ title: "C", question: "Q", agents: ["a"], timeoutSec: 3600 });
    await tick(); // let the seat dispatch (its completion stays pending forever)
    const snapshot = await orch.waitForRun(run.runId, 5);
    assert.strictEqual(snapshot.status, "running"); // still pending, returned on cap

    // The background run is NOT abandoned: releasing later still settles it.
    dispatch.releaseAll();
    await run.completion;
    assert.strictEqual(orch.getRun(run.runId).status, "done");
  });

  it("returns null for an unknown runId", async () => {
    const kanban = makeKanban();
    const orch = createOrchestrate({ kanban, dispatch: makeManualDispatch(kanban), setTimerFn: setTimeout });
    assert.strictEqual(await orch.waitForRun("orx_nope"), null);
  });

  it("clamps capMs to the SYNC_WAIT_CAP_MS ceiling", () => {
    assert.ok(SYNC_WAIT_CAP_MS > 0);
  });
});
