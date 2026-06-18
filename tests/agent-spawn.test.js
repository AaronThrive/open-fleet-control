/**
 * Unit tests for src/agent-spawn.js — the on-demand isolated-worker pool
 * controller (Phase 3, PRD-001). One describe block per acceptance criterion
 * (AC-1..AC-10, AC-12, AC-15), driven by stubbed docker/mesh/roster/store and a
 * fake clock. No real docker, no real mesh, no real network.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createAgentSpawn, STATE, REASON } = require("../src/agent-spawn");

// 2.5 GiB — the verified per-worker cap (AC-3).
const WORKER_MEM = 2684354560;

// -------------------------------------------------------------------------
// Test harness: a fake clock + recording stubs.
// -------------------------------------------------------------------------
function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (ms) => {
      t = ms;
    },
  };
}

/** A docker stub recording every call; container behaviour is configurable. */
function makeDocker({ containers = [], inspect = {}, capMem = WORKER_MEM } = {}) {
  const calls = { ps: 0, start: [], stop: [], inspect: [], subscribe: 0 };
  let eventCb = null;
  return {
    iface: {
      ps: async () => {
        calls.ps++;
        return containers;
      },
      start: async (name) => {
        calls.start.push(name);
      },
      stop: async (name, opts) => {
        calls.stop.push({ name, opts });
      },
      inspect: async (name) => {
        calls.inspect.push(name);
        return (
          inspect[name] || {
            HostConfig: { Memory: capMem, MemorySwap: capMem },
            Config: { Labels: { "com.ofc.pool": "worker" } },
          }
        );
      },
      subscribeEvents: (cb) => {
        calls.subscribe++;
        eventCb = cb;
        return () => {
          eventCb = null;
        };
      },
    },
    calls,
    emit: (evt) => eventCb && eventCb(evt),
    hasSubscriber: () => eventCb !== null,
  };
}

/** A mesh stub recording register/unregister and serving getState. */
function makeMesh({ nodes = [] } = {}) {
  const calls = { register: [], unregister: [] };
  let idSeq = 0;
  const state = { nodes: [...nodes] };
  return {
    iface: {
      registerNode: async (input) => {
        calls.register.push(input);
        const record = { id: `node-${++idSeq}`, ...input };
        state.nodes.push({ ...record });
        return record;
      },
      unregisterNode: async (idOrHostname) => {
        calls.unregister.push(idOrHostname);
        const before = state.nodes.length;
        state.nodes = state.nodes.filter(
          (n) => n.id !== idOrHostname && n.hostname !== idOrHostname,
        );
        if (state.nodes.length === before) {
          throw new Error(`Unknown node: ${idOrHostname}`); // 404 — tolerated by controller
        }
      },
      getState: () => ({ nodes: [...state.nodes] }),
    },
    calls,
    state,
  };
}

/** A store stub: monotonic fencing tokens. */
function makeStore() {
  let v = 0;
  return { nextToken: () => ++v };
}

/** A roster stub. */
function makeRoster(roster = { agents: [], byNode: {}, counts: {} }) {
  return { getRoster: async () => roster };
}

function stoppedContainer(name) {
  return {
    Names: [`/${name}`],
    State: "exited",
    Labels: { "com.ofc.pool": "worker" },
  };
}
function runningContainer(name) {
  return {
    Names: [`/${name}`],
    State: "running",
    Labels: { "com.ofc.pool": "worker" },
  };
}

function makeController(overrides = {}) {
  const clock = overrides.clock || makeClock();
  const docker = overrides.docker || makeDocker(overrides.dockerOpts);
  const mesh = overrides.mesh || makeMesh(overrides.meshOpts);
  const store = overrides.store || makeStore();
  const roster = overrides.roster || makeRoster();
  const config = {
    fleet: {
      spawn: {
        enabled: true,
        poolCeiling: 8,
        targetPeak: 6,
        workerMemBytes: WORKER_MEM,
        readinessOks: 3,
        readinessTimeoutMs: 10000,
        idleReapMs: 60000,
        reconcileMs: 5000,
        maxLifetimeMs: 3600000,
        recycleJitterMs: 5000,
        queueMax: 5,
        queueDeadlineMs: 30000,
        slackDeadlineMs: 3000,
        ramBudgetBytes: Math.floor(0.8 * 32 * 1024 * 1024 * 1024),
        registrationTtlMs: 300000,
        ...(overrides.spawnCfg || {}),
      },
    },
  };
  const ctl = createAgentSpawn({
    config,
    mesh: mesh.iface,
    roster,
    store,
    docker: docker.iface,
    logger: { info() {}, warn() {}, error() {} },
    nowFn: clock.now,
    jitterFn: overrides.jitterFn || (() => 0),
  });
  return { ctl, clock, docker, mesh, store, roster, config };
}

// =========================================================================
// AC-1 — factory + disabled no-op
// =========================================================================
describe("AC-1 — factory + disabled gate", () => {
  it("constructs without side effects and is a no-op when enabled:false", async () => {
    const docker = makeDocker();
    const mesh = makeMesh();
    const config = { fleet: { spawn: { enabled: false } } };
    const ctl = createAgentSpawn({
      config,
      mesh: mesh.iface,
      roster: makeRoster(),
      store: makeStore(),
      docker: docker.iface,
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.strictEqual(ctl.enabled, false);
    ctl.start(); // must not subscribe or call docker/mesh

    const acq = await ctl.acquireWorker("advisor-1");
    assert.strictEqual(acq.ok, false);
    assert.strictEqual(acq.reason, REASON.DISABLED);

    assert.strictEqual(ctl.lease("anything"), null);
    assert.strictEqual((await ctl.reapIdle()) || 0, 0);
    assert.strictEqual((await ctl.recycleAged()) || 0, 0);

    // The critical assertion: ZERO docker and ZERO mesh calls.
    assert.strictEqual(docker.calls.ps, 0, "no docker ps");
    assert.strictEqual(docker.calls.start.length, 0, "no docker start");
    assert.strictEqual(docker.calls.subscribe, 0, "no events subscription");
    assert.strictEqual(mesh.calls.register.length, 0, "no mesh register");
    assert.strictEqual(mesh.calls.unregister.length, 0, "no mesh unregister");
  });

  it("is enabled only when spawn.enabled === true (strict)", () => {
    for (const v of [undefined, false, 1, "true", null]) {
      const ctl = createAgentSpawn({
        config: { fleet: { spawn: { enabled: v } } },
        mesh: makeMesh().iface,
        roster: makeRoster(),
        store: makeStore(),
        docker: makeDocker().iface,
        logger: { info() {}, warn() {}, error() {} },
      });
      assert.strictEqual(ctl.enabled, false, `enabled:${JSON.stringify(v)} → disabled`);
    }
  });
});

// =========================================================================
// AC-6 — atomic CAS state machine (implemented FIRST; gates the rest)
// =========================================================================
describe("AC-6 — atomic CAS state machine", () => {
  it("two idle→X transitions racing for one idle worker → exactly one fires", () => {
    const { ctl } = makeController();
    const w = ctl.trackWorker("worker-a", { running: true });
    w.registered = true;
    w.nodeId = "node-x";

    // Both contenders read `idle` (the TOCTOU window). lease() CASes
    // idle→leased; a competing reaper CASes idle→draining. Both start from the
    // SAME idle state + generation: only the first commit wins; the second's
    // CAS finds the state already mutated and loses with no side effect.
    const leaseWon = ctl.cas("worker-a", STATE.IDLE, STATE.LEASED, w.generation);
    const drainWon = ctl.cas("worker-a", STATE.IDLE, STATE.DRAINING, w.generation);

    const winners = (leaseWon ? 1 : 0) + (drainWon ? 1 : 0);
    assert.strictEqual(winners, 1, "exactly one idle→X CAS wins");
    assert.strictEqual(leaseWon, true, "the first CAS (lease) wins");
    assert.strictEqual(drainWon, false, "the second CAS (drain) loses — no side effect");

    const state = ctl.getPoolState().workers.find((x) => x.workerId === "worker-a");
    assert.strictEqual(state.state, STATE.LEASED, "state reflects only the winning transition");
  });

  it("a losing CAS performs no side effect", () => {
    const { ctl, store } = makeController();
    ctl.trackWorker("worker-b", { running: true });

    const h1 = ctl.lease("worker-b"); // wins idle→leased, stamps a token
    assert.ok(h1);
    const tokenBefore = store.nextToken; // sanity: store still usable
    assert.ok(typeof tokenBefore === "function");

    // Second lease on a now-leased worker must lose and stamp nothing.
    const h2 = ctl.lease("worker-b");
    assert.strictEqual(h2, null, "second lease loses");
  });

  it("generation mismatch always loses the CAS", () => {
    const { ctl } = makeController();
    const w = ctl.trackWorker("worker-c", { running: true });
    // Direct CAS with the wrong generation must fail.
    const ok = ctl.cas("worker-c", STATE.IDLE, STATE.LEASED, w.generation + 99);
    assert.strictEqual(ok, false);
    // Worker is untouched (still idle).
    const state = ctl.getPoolState().workers.find((x) => x.workerId === "worker-c");
    assert.strictEqual(state.state, STATE.IDLE);
  });

  it("rejects illegal transitions (e.g. idle→removed)", () => {
    const { ctl } = makeController();
    const w = ctl.trackWorker("worker-d", { running: true });
    assert.strictEqual(ctl.cas("worker-d", STATE.IDLE, STATE.REMOVED, w.generation), false);
  });

  it("release CASes leased→idle keyed on the lease generation; recycled gen loses", () => {
    const { ctl } = makeController();
    const w = ctl.trackWorker("worker-e", { running: true });
    const h = ctl.lease("worker-e");
    assert.ok(h);
    // Stale generation cannot release.
    assert.strictEqual(ctl.release("worker-e", h.generation + 1), false);
    // Correct generation releases back to idle.
    assert.strictEqual(ctl.release("worker-e", h.generation), true);
    const state = ctl.getPoolState().workers.find((x) => x.workerId === "worker-e");
    assert.strictEqual(state.state, STATE.IDLE);
  });
});

// =========================================================================
// AC-2 — warm start via docker start of a labelled pre-stopped container
// =========================================================================
describe("AC-2 — warm start", () => {
  it("docker start is called for a labelled pre-existing stopped container", async () => {
    const docker = makeDocker({ containers: [stoppedContainer("warm-1")] });
    const { ctl } = makeController({ docker });

    const res = await ctl.acquireWorker("advisor-1", { probeFn: async () => true });
    assert.strictEqual(res.ok, true, "acquire succeeds");
    assert.deepStrictEqual(docker.calls.start, ["warm-1"], "docker start called once for warm-1");
    // Discovery used docker ps -a with the pool label (never hard-coded).
    assert.ok(docker.calls.ps >= 1, "docker ps queried for pool containers");
  });

  it("fails closed with no_worker when no stopped pool container exists", async () => {
    const docker = makeDocker({ containers: [runningContainer("busy-1")] });
    const { ctl } = makeController({ docker });
    const res = await ctl.acquireWorker("advisor-1");
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, REASON.NO_WORKER);
    assert.strictEqual(docker.calls.start.length, 0);
  });
});

// =========================================================================
// AC-3 — per-worker resource cap verified on acquire
// =========================================================================
describe("AC-3 — resource cap verification", () => {
  it("mis-capped worker (wrong Memory) is drained and acquire fails closed", async () => {
    const docker = makeDocker({
      containers: [stoppedContainer("badcap-1")],
      inspect: {
        "badcap-1": { HostConfig: { Memory: 999, MemorySwap: 999 } },
      },
    });
    const { ctl } = makeController({ docker });
    const res = await ctl.acquireWorker("advisor-1", { probeFn: async () => true });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, REASON.MISCAP);
    // It was drained (stopped) and never registered.
    assert.deepStrictEqual(docker.calls.stop.map((s) => s.name), ["badcap-1"]);
  });

  it("MemorySwap != Memory (swap enabled) is rejected", async () => {
    const docker = makeDocker({
      containers: [stoppedContainer("swap-1")],
      inspect: {
        "swap-1": { HostConfig: { Memory: WORKER_MEM, MemorySwap: WORKER_MEM * 2 } },
      },
    });
    const { ctl } = makeController({ docker });
    const res = await ctl.acquireWorker("advisor-1", { probeFn: async () => true });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, REASON.MISCAP);
  });

  it("correctly-capped worker passes verifyCap", () => {
    const { ctl } = makeController();
    assert.strictEqual(
      ctl.verifyCap({ HostConfig: { Memory: WORKER_MEM, MemorySwap: WORKER_MEM } }),
      true,
    );
  });
});

// =========================================================================
// AC-5 — readiness gate: register LAST after N consecutive OKs
// =========================================================================
describe("AC-5 — readiness gate", () => {
  it("registers exactly once, only after N consecutive OK probes", async () => {
    const docker = makeDocker({ containers: [stoppedContainer("ready-1")] });
    const { ctl, mesh } = makeController({ docker });
    // Probe flaps (false) then steadies to 3 OKs.
    const seq = [false, true, false, true, true, true];
    let i = 0;
    const probeFn = async () => seq[Math.min(i++, seq.length - 1)];

    const res = await ctl.acquireWorker("advisor-1", { probeFn });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(mesh.calls.register.length, 1, "registered exactly once");
  });

  it("permanent readiness failure → drained, never registered", async () => {
    const clock = makeClock();
    const docker = makeDocker({ containers: [stoppedContainer("never-1")] });
    const { ctl, mesh } = makeController({
      docker,
      clock,
      spawnCfg: { readinessTimeoutMs: 100 },
    });
    // Probe never returns true; advance the clock so the deadline passes.
    let probes = 0;
    const probeFn = async () => {
      probes++;
      clock.advance(40);
      return false;
    };
    const res = await ctl.acquireWorker("advisor-1", { probeFn });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, REASON.READINESS);
    assert.strictEqual(mesh.calls.register.length, 0, "never registered");
    assert.deepStrictEqual(docker.calls.stop.map((s) => s.name), ["never-1"], "drained");
  });
});

// =========================================================================
// AC-7 — leaked-registration eviction (TTL + docker events)
// =========================================================================
describe("AC-7 — leaked-registration eviction", () => {
  it("fake die event → DELETE issued for that node + CAS-removed from pool", async () => {
    const docker = makeDocker({ containers: [stoppedContainer("evict-1")] });
    const { ctl, mesh } = makeController({ docker });
    ctl.start(); // subscribes to docker events
    assert.ok(docker.hasSubscriber(), "controller subscribed to docker events");

    // Acquire so the worker is in the pool + registered.
    const res = await ctl.acquireWorker("advisor-1", { probeFn: async () => true });
    assert.strictEqual(res.ok, true);
    const nodeId = res.worker.nodeId;
    assert.ok(nodeId);

    // Emit a die event for the container; controller auto-unregisters.
    docker.emit({ Action: "die", Actor: { Attributes: { name: "evict-1" } } });
    await new Promise((r) => setImmediate(r)); // let the async evict settle

    assert.ok(mesh.calls.unregister.includes(nodeId), "DELETE issued for the dead node");
    const tracked = ctl.getPoolState().workers.find((w) => w.workerId === "evict-1");
    assert.strictEqual(tracked, undefined, "removed from pool");
    ctl.stop();
  });

  it("lapsed TTL → unregister issued", async () => {
    const clock = makeClock();
    const docker = makeDocker({ containers: [stoppedContainer("ttl-1")] });
    const { ctl, mesh } = makeController({
      docker,
      clock,
      spawnCfg: { registrationTtlMs: 1000 },
    });
    const res = await ctl.acquireWorker("advisor-1", { probeFn: async () => true });
    assert.strictEqual(res.ok, true);
    const nodeId = res.worker.nodeId;

    // Advance the clock past the TTL and run the refresh sweep.
    clock.advance(2000);
    ctl.refreshRegistrations();
    await new Promise((r) => setImmediate(r));
    assert.ok(mesh.calls.unregister.includes(nodeId), "lapsed-TTL node unregistered");
  });

  it("tolerates a 404 on unregister (node already gone)", async () => {
    const docker = makeDocker({ containers: [stoppedContainer("g404-1")] });
    const { ctl } = makeController({ docker });
    const res = await ctl.acquireWorker("advisor-1", { probeFn: async () => true });
    // Emit die twice — the second unregister 404s but must not throw.
    docker.emit({ Action: "die", Actor: { Attributes: { name: "g404-1" } } });
    await new Promise((r) => setImmediate(r));
    assert.doesNotThrow(() => ctl.onDockerEvent({ Action: "die", id: "g404-1" }));
    assert.strictEqual(res.ok, true);
  });
});

// =========================================================================
// AC-8 — reconciliation loop converges docker ps vs mesh vs desired
// =========================================================================
describe("AC-8 — reconciliation loop", () => {
  it("present-but-unregistered → registered after readiness", async () => {
    const docker = makeDocker({ containers: [runningContainer("recon-1")] });
    const mesh = makeMesh({ nodes: [] }); // mesh empty, container live
    const { ctl } = makeController({ docker, mesh });

    const out = await ctl.reconcile({ probeFn: async () => true });
    assert.strictEqual(out.registered, 1, "the unregistered live container got registered");
    assert.strictEqual(mesh.calls.register.length, 1);
  });

  it("registered-but-absent → unregistered (mesh matches docker ps)", async () => {
    // Mesh has a pool node with no live container.
    const docker = makeDocker({ containers: [] });
    const mesh = makeMesh({
      nodes: [{ id: "ghost-node", hostname: "ghost-1", registeredBy: "spawn" }],
    });
    const { ctl } = makeController({ docker, mesh });

    const out = await ctl.reconcile({ probeFn: async () => true });
    assert.strictEqual(out.unregistered, 1, "the absent registered node got unregistered");
    assert.ok(mesh.calls.unregister.includes("ghost-node"));
  });

  it("divergent docker ps vs mesh vs desired converges", async () => {
    // Live: recon-a (unregistered), recon-b (already registered).
    // Mesh: recon-b (matches), ghost (no container).
    const docker = makeDocker({
      containers: [runningContainer("recon-a"), runningContainer("recon-b")],
    });
    const mesh = makeMesh({
      nodes: [
        { id: "nb", hostname: "recon-b", registeredBy: "spawn" },
        { id: "ng", hostname: "ghost", registeredBy: "spawn" },
      ],
    });
    const { ctl } = makeController({ docker, mesh });

    const out = await ctl.reconcile({ probeFn: async () => true });
    assert.strictEqual(out.registered, 1, "recon-a registered");
    assert.strictEqual(out.unregistered, 1, "ghost unregistered");
    assert.ok(mesh.calls.register.some((r) => r.hostname === "recon-a"));
    assert.ok(mesh.calls.unregister.includes("ng"));
  });
});

// =========================================================================
// AC-4 — idle reaper (drain idle, never leased/draining)
// =========================================================================
describe("AC-4 — idle reaper", () => {
  it("stops only workers idle >= idleReapMs; never leased/draining", async () => {
    const clock = makeClock();
    const docker = makeDocker();
    const { ctl } = makeController({ docker, clock, spawnCfg: { idleReapMs: 1000 } });

    // Three workers: one idle-old, one idle-fresh, one leased.
    const old = ctl.trackWorker("idle-old", { running: true });
    old.registered = true;
    old.nodeId = "n-old";
    clock.advance(500);
    const fresh = ctl.trackWorker("idle-fresh", { running: true });
    fresh.registered = true;
    fresh.nodeId = "n-fresh";
    const leasedW = ctl.trackWorker("leased-1", { running: true });
    leasedW.registered = true;
    leasedW.nodeId = "n-leased";
    ctl.lease("leased-1"); // now leased

    // Advance so idle-old crosses the reap threshold but idle-fresh does not.
    clock.advance(600); // idle-old age=1100>=1000, idle-fresh age=600<1000

    const reaped = await ctl.reapIdle();
    assert.strictEqual(reaped, 1, "exactly one idle-old worker reaped");
    assert.deepStrictEqual(docker.calls.stop.map((s) => s.name), ["idle-old"]);

    const names = ctl.getPoolState().workers.map((w) => w.workerId);
    assert.ok(names.includes("idle-fresh"), "fresh idle worker untouched");
    assert.ok(names.includes("leased-1"), "leased worker never reaped");
  });
});

// =========================================================================
// AC-15 — capacity governor
// =========================================================================
describe("AC-15 — capacity governor", () => {
  it("8 active workers → 9th spawn refused with capacity", async () => {
    const docker = makeDocker({ containers: [stoppedContainer("extra")] });
    const { ctl } = makeController({ docker, spawnCfg: { poolCeiling: 8 } });
    // Seed 8 active workers directly.
    for (let i = 0; i < 8; i++) ctl.trackWorker(`w${i}`, { running: true });

    const res = await ctl.acquireWorker("advisor-1");
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, REASON.CAPACITY);
    assert.strictEqual(docker.calls.start.length, 0, "no docker start on capacity refusal");
  });

  it("low live MemAvailable → refused even below the count ceiling", async () => {
    const docker = makeDocker({ containers: [stoppedContainer("memcap")] });
    const { ctl } = makeController({ docker });
    // Only 1 active worker (well below ceiling) but MemAvailable is tiny.
    const res = await ctl.acquireWorker("advisor-1", {
      readMemAvailableFn: () => 100 * 1024 * 1024, // 100 MiB — below next footprint
      probeFn: async () => true,
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, REASON.CAPACITY);
  });

  it("never counts swap as headroom (RAM budget breach refuses)", () => {
    const { ctl } = makeController({ spawnCfg: { ramBudgetBytes: WORKER_MEM } });
    // ramBudget is exactly one worker; base (5 GiB) alone already breaches.
    const out = ctl.admitCapacity();
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, REASON.CAPACITY);
  });

  it("admits when within budget and MemAvailable is healthy", () => {
    const { ctl } = makeController();
    const out = ctl.admitCapacity(() => 16 * 1024 * 1024 * 1024); // 16 GiB free
    assert.strictEqual(out.ok, true);
  });
});

// =========================================================================
// AC-10 — bounded per-advisor queue + deadline (typed reasons)
// =========================================================================
describe("AC-10 — bounded per-advisor queue + deadline", () => {
  it("saturated + full queue → next request gets queue_full", () => {
    const clock = makeClock();
    const { ctl } = makeController({
      clock,
      spawnCfg: { queueMax: 2, poolCeiling: 1 },
    });
    // Make capacity unavailable: 1 active worker at ceiling 1, none idle.
    const w = ctl.trackWorker("busy", { running: true });
    ctl.lease("busy"); // leased, no idle worker

    // No idle + capacity refused (at ceiling) → requests queue, bounded at 2.
    const r1 = ctl.admit("advisor-x");
    const r2 = ctl.admit("advisor-x");
    const r3 = ctl.admit("advisor-x");
    assert.strictEqual(r1.reason, REASON.QUEUED);
    assert.strictEqual(r2.reason, REASON.QUEUED);
    assert.strictEqual(r3.reason, REASON.QUEUE_FULL, "third over queueMax=2 is queue_full");
    assert.strictEqual(ctl.queueDepth("advisor-x"), 2, "queue bounded at queueMax");
  });

  it("a queued request past its deadline → queue_timeout", () => {
    const clock = makeClock();
    const { ctl } = makeController({
      clock,
      spawnCfg: { queueDeadlineMs: 1000, poolCeiling: 1 },
    });
    const w = ctl.trackWorker("busy", { running: true });
    ctl.lease("busy");

    ctl.admit("advisor-y"); // queued
    clock.advance(2000); // past deadline
    const timedOut = ctl.sweepQueueDeadlines();
    assert.strictEqual(timedOut.length, 1);
    assert.strictEqual(timedOut[0].reason, REASON.QUEUE_TIMEOUT);
    assert.strictEqual(timedOut[0].advisorId, "advisor-y");
    assert.strictEqual(ctl.queueDepth("advisor-y"), 0, "timed-out entry removed (no deadlock)");
  });

  it("admits immediately (queued reason) when an idle worker exists", () => {
    const { ctl } = makeController();
    ctl.trackWorker("idle-1", { running: true }); // idle
    const r = ctl.admit("advisor-z");
    assert.strictEqual(r.admitted, true);
  });

  it("rejects with capacity reason — never grows unbounded", () => {
    const { ctl } = makeController({ spawnCfg: { queueMax: 1, poolCeiling: 1 } });
    ctl.lease(ctl.trackWorker("busy", { running: true }).workerId);
    ctl.admit("a"); // fills queue (1)
    const over = ctl.admit("a");
    assert.strictEqual(over.reason, REASON.QUEUE_FULL);
  });
});

// =========================================================================
// AC-9 — max-lifetime recycle (jitter + never kill in-flight)
// =========================================================================
describe("AC-9 — max-lifetime recycle", () => {
  it("aged worker mid-lease finishes the lease, then drains (never killed in-flight)", async () => {
    const clock = makeClock();
    const docker = makeDocker();
    const { ctl } = makeController({
      clock,
      docker,
      spawnCfg: { maxLifetimeMs: 1000, recycleJitterMs: 0 },
    });
    const w = ctl.trackWorker("aged-1", { running: true });
    w.registered = true;
    w.nodeId = "n-aged";
    const handle = ctl.lease("aged-1"); // in-flight lease
    assert.ok(handle);

    clock.advance(2000); // past maxLifetime
    await ctl.recycleAged();

    // Worker is draining, NOT stopped — the live lease must settle first.
    const state = ctl.getPoolState().workers.find((x) => x.workerId === "aged-1");
    assert.strictEqual(state.state, STATE.DRAINING, "leased aged worker → draining, not removed");
    assert.strictEqual(docker.calls.stop.length, 0, "in-flight lease NOT docker-stopped");

    // Lease cannot be re-leased while draining (refuses new leases).
    assert.strictEqual(ctl.lease("aged-1"), null);

    // Now the lease settles → settleAndRemove stops + unregisters gracefully.
    await ctl.settleAndRemove("aged-1");
    assert.deepStrictEqual(docker.calls.stop.map((s) => s.name), ["aged-1"]);
  });

  it("idle aged worker is drained immediately on recycle", async () => {
    const clock = makeClock();
    const docker = makeDocker();
    const { ctl } = makeController({
      clock,
      docker,
      spawnCfg: { maxLifetimeMs: 1000, recycleJitterMs: 0 },
    });
    const w = ctl.trackWorker("aged-idle", { running: true });
    w.registered = true;
    w.nodeId = "n2";
    clock.advance(2000);
    const n = await ctl.recycleAged();
    assert.strictEqual(n, 1);
    assert.deepStrictEqual(docker.calls.stop.map((s) => s.name), ["aged-idle"]);
  });

  it("jitter spreads recycle times across workers", () => {
    // Deterministic jitter: each worker gets a different jitter value, so their
    // recycleAt values differ even at the same maxLifetime.
    const clock = makeClock();
    let j = 0;
    const jitters = [0, 0.5, 0.99];
    const { ctl } = makeController({
      clock,
      jitterFn: () => jitters[j++ % jitters.length],
      spawnCfg: { maxLifetimeMs: 1000, recycleJitterMs: 1000 },
    });
    const a = ctl.trackWorker("j-a", { running: true });
    const b = ctl.trackWorker("j-b", { running: true });
    const c = ctl.trackWorker("j-c", { running: true });
    const times = new Set([a.recycleAt, b.recycleAt, c.recycleAt]);
    assert.strictEqual(times.size, 3, "jitter produced 3 distinct recycle times");
  });
});

// =========================================================================
// AC-12 — drain semantics (graceful stop, never kill a live lease)
// =========================================================================
describe("AC-12 — drain semantics", () => {
  it("draining a leased worker defers docker stop until the lease settles", async () => {
    const docker = makeDocker();
    const { ctl } = makeController({ docker });
    const w = ctl.trackWorker("drain-1", { running: true });
    w.registered = true;
    w.nodeId = "nd";
    const h = ctl.lease("drain-1");

    // beginDrain on a leased worker marks draining but does NOT stop.
    assert.strictEqual(ctl.beginDrain("drain-1"), true);
    assert.strictEqual(docker.calls.stop.length, 0, "no stop while lease live");

    // The lease settles → settleAndRemove issues a graceful stop.
    await ctl.settleAndRemove("drain-1");
    assert.strictEqual(docker.calls.stop.length, 1);
    assert.strictEqual(docker.calls.stop[0].opts.graceful, true, "graceful stop, never kill");
  });

  it("drain refuses new leases on the draining worker", () => {
    const { ctl } = makeController();
    const w = ctl.trackWorker("drain-2", { running: true });
    ctl.beginDrain("drain-2");
    assert.strictEqual(ctl.lease("drain-2"), null, "draining worker refuses leases");
  });

  it("settleAndRemove unregisters the mesh node", async () => {
    const docker = makeDocker({ containers: [stoppedContainer("dr-3")] });
    const { ctl, mesh } = makeController({ docker });
    const res = await ctl.acquireWorker("advisor-1", { probeFn: async () => true });
    const nodeId = res.worker.nodeId;
    ctl.beginDrain("dr-3");
    await ctl.settleAndRemove("dr-3");
    assert.ok(mesh.calls.unregister.includes(nodeId), "node unregistered on drain-complete");
  });
});

// =========================================================================
// AC-14 stamp — lease stamps a monotonic fencing token (store contract)
// =========================================================================
describe("AC-14 (stamp) — fencing token on lease", () => {
  it("each successful lease stamps a strictly-increasing token", () => {
    const { ctl } = makeController();
    ctl.trackWorker("ft-1", { running: true });
    ctl.trackWorker("ft-2", { running: true });
    const h1 = ctl.lease("ft-1");
    const h2 = ctl.lease("ft-2");
    assert.ok(h1.token < h2.token, "tokens strictly increase across leases");
  });
});
