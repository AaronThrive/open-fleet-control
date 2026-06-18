/**
 * AC-17 — caller-side remote routing + parallel flip (guarded).
 *
 * When fleet.spawn.enabled === true, runBoard/runChain:
 *   (a) lease a pool worker per seat via the controller and dispatch an agent
 *       ref (`id@<workerNode>`) that resolveAgentNode returns kind:"remote" for;
 *   (b) default to PARALLEL board execution (the config layer flips the default
 *       only when spawn is enabled — a GUARD, not an unconditional flip).
 * When spawn is disabled, behaviour is byte-identical to today: sequential
 * default preserved, NO worker leasing, the bare advisor id is dispatched.
 *
 * The dispatch core (startRun/runRemote POST body) is NOT modified — this test
 * proves the ONLY change is caller-side: WHICH ref is dispatched + parallel-vs-
 * sequential selection + leasing. We assert against a STUBBED controller (lease
 * returns a fake remote handle), a fake dispatch (records the ref it received),
 * and the real resolveAgentNode (src/agent-locator.js) to prove the leased ref
 * resolves kind:"remote".
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { createOrchestrate } = require("../src/orchestrate");
const { createAgentLocator } = require("../src/agent-locator");
const { resolveSequentialBoard, resolveDispatchConcurrency } = require("../src/config");

// --- Fakes (mirroring tests/orchestrate.test.js style) -----------------------

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
 * Fake dispatch that records the agent ref it received AND whether more than one
 * dispatch was open at the same time (to prove PARALLEL fan-out). Each call's
 * completion settles only when its release() is invoked, so the test can hold
 * all seats open simultaneously.
 */
function makeGatedDispatch(kanban) {
  const calls = [];
  let openNow = 0;
  let maxOpen = 0;
  const releases = [];
  return {
    calls,
    get maxOpen() {
      return maxOpen;
    },
    releaseAll() {
      releases.forEach((r) => r());
    },
    dispatchTask(taskId, opts) {
      calls.push({ taskId, agent: opts.agent, isBoard: opts.isBoard === true });
      openNow += 1;
      maxOpen = Math.max(maxOpen, openNow);
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      releases.push(release);
      const completion = gate.then(() => {
        openNow -= 1;
        kanban._settle(taskId, { result: "success", result_text: `ans:${opts.agent}` });
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

/** Simple immediate-settle dispatch (records refs; no gating). */
function makeDispatch(kanban, outcomes = []) {
  const calls = [];
  let i = 0;
  return {
    calls,
    dispatchTask(taskId, opts) {
      const outcome = outcomes[i++] || { result: "success", text: "ok" };
      calls.push({ taskId, agent: opts.agent, isBoard: opts.isBoard === true });
      const completion = Promise.resolve().then(() => {
        const attempt = { result: outcome.result || "success" };
        attempt.result_text = outcome.text !== undefined ? outcome.text : `ans:${opts.agent}`;
        kanban._settle(taskId, attempt);
      });
      return {
        task: { id: taskId, status: "assigned" },
        sessionKey: `k`,
        agent: opts.agent,
        attemptIndex: 0,
        completion,
      };
    },
  };
}

/**
 * Stub spawn controller. lease() hands back a fake remote worker handle keyed to
 * a worker node name; records release / drain calls so the test can assert the
 * worker is returned (success) or drained (failure) exactly once per seat.
 */
function makeStubController({ workerNodes }) {
  let idx = 0;
  const leased = [];
  const released = [];
  const drained = [];
  return {
    leased,
    released,
    drained,
    lease(advisorId) {
      if (idx >= workerNodes.length) return null; // pool exhausted
      const workerId = workerNodes[idx++];
      const handle = { workerId, nodeId: `node-${workerId}`, generation: 0, token: idx };
      leased.push({ advisorId, workerId });
      return handle;
    },
    release(workerId, generation) {
      released.push({ workerId, generation });
      return true;
    },
    beginDrain(workerId) {
      drained.push({ workerId });
      return true;
    },
    settleAndRemove() {
      return Promise.resolve(true);
    },
  };
}

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
// (b) The parallel-flip GUARD (config layer) — the default flips only on spawn.
// ---------------------------------------------------------------------------
describe("AC-17 — parallel-flip guard (config default)", () => {
  it("default is PARALLEL (sequentialBoard:false) when spawn is enabled", () => {
    assert.strictEqual(resolveSequentialBoard({ spawn: { enabled: true } }, {}), false);
  });
  it("default is SEQUENTIAL (sequentialBoard:true) when spawn is disabled", () => {
    assert.strictEqual(resolveSequentialBoard({ spawn: { enabled: false } }, {}), true);
  });
  it("an explicit operator value ALWAYS wins (guard, not unconditional flip)", () => {
    // explicit true with spawn enabled → stays sequential
    assert.strictEqual(
      resolveSequentialBoard({ spawn: { enabled: true } }, { orchestrate: { sequentialBoard: true } }),
      true,
    );
    // explicit false with spawn disabled → stays parallel
    assert.strictEqual(
      resolveSequentialBoard(
        { spawn: { enabled: false } },
        { orchestrate: { sequentialBoard: false } },
      ),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// (a) Enabled → parallel + remote leasing.
// ---------------------------------------------------------------------------
describe("AC-17 — spawn ENABLED: parallel fan-out to leased remote workers", () => {
  it("leases one worker per seat and dispatches the id@workerNode remote ref", async () => {
    const kanban = makeKanban();
    const dispatch = makeGatedDispatch(kanban);
    const controller = makeStubController({ workerNodes: ["worker-a", "worker-b", "worker-c"] });
    const orch = createOrchestrate({
      kanban,
      dispatch,
      spawn: controller,
      spawnEnabled: true,
      // No explicit sequentialBoard → the config layer would default this to
      // false; here we feed the resolved default directly.
      config: { sequentialBoard: false },
    });

    const run = orch.runBoard({
      title: "Council",
      question: "What now?",
      agents: ["alpha", "beta", "gamma"],
    });
    // All three seats must be OPEN simultaneously (parallel) before any settles.
    // The gated dispatch records maxOpen; release after the parallel fan-out.
    // Give microtasks a tick to register all three dispatches.
    await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(dispatch.maxOpen, 3, "all 3 seats dispatched in PARALLEL");
    dispatch.releaseAll();
    await run.completion;
    const out = orch.getRun(run.runId);

    // Each seat dispatched a REMOTE pin: alpha@worker-a, beta@worker-b, ...
    const refs = dispatch.calls.map((c) => c.agent).sort();
    assert.deepStrictEqual(refs, ["alpha@worker-a", "beta@worker-b", "gamma@worker-c"]);
    // One lease per seat.
    assert.strictEqual(controller.leased.length, 3);
    // Each leased worker RELEASED back to idle on success (not drained).
    assert.strictEqual(controller.released.length, 3, "all workers released on success");
    assert.strictEqual(controller.drained.length, 0, "no worker drained on success");
    // Board collected all three.
    assert.strictEqual(out.results.length, 3);
    assert.ok(out.results.every((r) => r.ok));
  });

  it("the leased id@workerNode ref resolves kind:remote via the REAL locator", async () => {
    // Prove the ref orchestrate dispatches is exactly what resolveAgentNode maps
    // to a remote route — i.e. the EXISTING runRemote POST path will fire, with
    // no change to the dispatch core.
    const locator = createAgentLocator({
      rosterFn: async () => ({
        agents: [
          { id: "alpha", node: "self-box" }, // advisor also lives locally
          { id: "alpha", node: "worker-a" }, // ...and on the leased worker node
        ],
      }),
      meshFn: async () => ({
        nodes: [
          {
            hostname: "worker-a",
            url: "https://worker-a:443/health",
            healthPath: "/health",
            health: { status: "online" },
          },
        ],
      }),
      selfNode: "self-box",
    });
    const route = await locator.resolve("alpha@worker-a");
    assert.strictEqual(route.kind, "remote", "id@workerNode pin resolves remote");
    assert.strictEqual(route.node, "worker-a");
    assert.strictEqual(route.baseUrl, "https://worker-a:443");
  });

  it("drains (not releases) a worker whose seat failed", async () => {
    const kanban = makeKanban();
    const dispatch = makeDispatch(kanban, [
      { result: "failure", text: undefined }, // alpha fails
      { result: "success", text: "ok" }, // beta ok
    ]);
    const controller = makeStubController({ workerNodes: ["worker-a", "worker-b"] });
    const orch = createOrchestrate({
      kanban,
      dispatch,
      spawn: controller,
      spawnEnabled: true,
      config: { sequentialBoard: false },
    });
    await settleBoard(orch, { title: "C", question: "Q?", agents: ["alpha", "beta"] });
    // The failed seat's worker is drained; the successful seat's worker released.
    assert.strictEqual(controller.drained.length, 1, "failed seat → worker drained");
    assert.strictEqual(controller.drained[0].workerId, "worker-a");
    assert.strictEqual(controller.released.length, 1, "successful seat → worker released");
    assert.strictEqual(controller.released[0].workerId, "worker-b");
  });

  it("runChain leases + routes each step to a remote worker", async () => {
    const kanban = makeKanban();
    const dispatch = makeDispatch(kanban, [
      { result: "success", text: "s1" },
      { result: "success", text: "s2" },
    ]);
    const controller = makeStubController({ workerNodes: ["worker-a", "worker-b"] });
    const orch = createOrchestrate({ kanban, dispatch, spawn: controller, spawnEnabled: true });
    const out = await settleChain(orch, {
      title: "Pipe",
      steps: [
        { agent: "alpha", instruction: "do A" },
        { agent: "beta", instruction: "do B" },
      ],
    });
    const refs = dispatch.calls.map((c) => c.agent);
    assert.deepStrictEqual(refs, ["alpha@worker-a", "beta@worker-b"]);
    assert.strictEqual(controller.released.length, 2, "both chain steps released their workers");
    assert.strictEqual(out.ok, true);
  });
});

// ---------------------------------------------------------------------------
// Disabled → byte-identical: sequential default, no leasing, bare ids.
// ---------------------------------------------------------------------------
describe("AC-17 — spawn DISABLED: unchanged (sequential, no leasing, bare ids)", () => {
  it("dispatches the BARE advisor id and never leases when spawnEnabled is false", async () => {
    const kanban = makeKanban();
    const dispatch = makeDispatch(kanban, [
      { result: "success", text: "A1" },
      { result: "success", text: "A2" },
    ]);
    // Wire a controller but keep spawnEnabled:false — routeToPool must stay off.
    const controller = makeStubController({ workerNodes: ["w1", "w2"] });
    const orch = createOrchestrate({
      kanban,
      dispatch,
      spawn: controller,
      spawnEnabled: false,
      config: { sequentialBoard: true }, // disabled → sequential default preserved
    });
    await settleBoard(orch, { title: "C", question: "Q?", agents: ["a", "b"] });

    // Bare ids only — no @workerNode pins.
    const refs = dispatch.calls.map((c) => c.agent).sort();
    assert.deepStrictEqual(refs, ["a", "b"]);
    // Controller never touched.
    assert.strictEqual(controller.leased.length, 0, "no worker leased when disabled");
    assert.strictEqual(controller.released.length, 0);
    assert.strictEqual(controller.drained.length, 0);
  });

  it("a controller-less orchestrate (the legacy wiring) is unaffected", async () => {
    const kanban = makeKanban();
    const dispatch = makeDispatch(kanban, [{ result: "success", text: "x" }]);
    const orch = createOrchestrate({ kanban, dispatch, config: { sequentialBoard: false } });
    await settleBoard(orch, { title: "C", question: "Q?", agents: ["solo"] });
    assert.strictEqual(dispatch.calls[0].agent, "solo", "bare id dispatched, no pin");
  });
});

// ---------------------------------------------------------------------------
// AC-18 linkage sanity: enabled pool raises the cap that AC-17's parallel needs.
// ---------------------------------------------------------------------------
describe("AC-17 + AC-18 — parallel needs the raised cap", () => {
  it("enabling spawn flips the board default AND raises maxConcurrent together", () => {
    const fleetEnabled = { dispatch: { maxConcurrent: 3 }, spawn: { enabled: true, poolCeiling: 6 } };
    assert.strictEqual(resolveSequentialBoard(fleetEnabled, {}), false, "default flips to parallel");
    assert.strictEqual(resolveDispatchConcurrency(fleetEnabled), 6, "cap raised in lockstep");
  });
});
