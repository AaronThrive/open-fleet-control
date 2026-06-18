/**
 * Unit tests for POST /api/fleet/orchestrate in src/fleet-routes.js.
 *
 * Mirrors the dispatch-routes test harness: mocked fleet runtime (rate limiter,
 * audit, budgets gate, fireAlert), a mocked orchestrate module, fake req/res —
 * no HTTP server, no CLI, no real agents. Covers the 503 "not configured"
 * fallback, mode validation, fail-closed roster validation, the OPEN policy
 * gate (403), the CLOSED ceiling gate + fleet-window block (429), the happy
 * board/chain envelopes + audit, and rate limiting.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { createFleetRoutes } = require("../src/fleet-routes");

const ORCH_PATH = "/api/fleet/orchestrate";
const ROSTER = { agents: [{ id: "a" }, { id: "b" }, { id: "c" }] };

function makeFleet({
  allowed = true,
  dispatchBlock = null,
  orchestrationBlock = null,
  orchestrationBlockFn = null,
} = {}) {
  const auditRecords = [];
  const rateChecks = [];
  const alerts = [];
  const orchBlockArgs = [];
  const fleet = {
    rateLimiter: {
      check: (key) => {
        rateChecks.push(key);
        return allowed ? { allowed: true } : { allowed: false, retryAfterMs: 1234 };
      },
    },
    audit: { record: (entry) => auditRecords.push(entry) },
    kanban: { getBoard: () => ({ tasks: [] }) },
    budgets: {
      checkDispatchBlock: () => dispatchBlock,
      checkOrchestrationBlock: (args) => {
        orchBlockArgs.push(args);
        return orchestrationBlockFn ? orchestrationBlockFn(args) : orchestrationBlock;
      },
    },
    fireAlert: (event) => {
      alerts.push(event);
    },
  };
  return { fleet, auditRecords, rateChecks, alerts, orchBlockArgs };
}

/**
 * Mock orchestrate module modeling the new ASYNC starter + registry contract:
 * runBoard/runChain return SYNCHRONOUSLY with { runId, agents, status:
 * "running", startedAt, completion }; the collected snapshot is stored in an
 * in-memory `runs` map and read back via getRun(runId) / waitForRun(runId).
 * By default the board/chain runs settle to "done" immediately (synchronously),
 * so ?wait=true paths see the collected results — but the starter itself never
 * blocks, exactly like the real module.
 */
function makeOrchestrate(overrides = {}) {
  const calls = { single: [], board: [], chain: [] };
  const runs = new Map();
  let counter = 0;

  function startBoard(params) {
    calls.board.push(params);
    const runId = `orx_b${++counter}`;
    const startedAt = "2026-06-16T00:00:00.000Z";
    const snapshot = {
      runId,
      mode: "board",
      status: "done",
      agents: params.agents.slice(),
      taskId: "tsk_1",
      question: params.question,
      results: params.agents.map((agent, i) => ({
        agent,
        taskId: `tsk_${i + 1}`,
        text: `out-${agent}`,
        ok: true,
        truncated: false,
      })),
      missing: [],
      truncatedAny: false,
      budgetHalt: null,
      error: null,
      startedAt,
      endedAt: "2026-06-16T00:00:01.000Z",
    };
    runs.set(runId, snapshot);
    return { runId, mode: "board", agents: snapshot.agents, status: "running", startedAt, completion: Promise.resolve() };
  }

  function startChain(params) {
    calls.chain.push(params);
    const runId = `orx_c${++counter}`;
    const startedAt = "2026-06-16T00:00:00.000Z";
    const snapshot = {
      runId,
      mode: "chain",
      status: "done",
      agents: params.steps.map((s) => s.agent),
      title: params.title,
      steps: params.steps.map((s) => ({ agent: s.agent, ok: true })),
      final: "final-out",
      ok: true,
      stoppedAt: null,
      budgetHalt: null,
      error: null,
      startedAt,
      endedAt: "2026-06-16T00:00:01.000Z",
    };
    runs.set(runId, snapshot);
    return { runId, mode: "chain", agents: snapshot.agents, status: "running", startedAt, completion: Promise.resolve() };
  }

  const module = {
    getStatus: () => ({ available: true, enabled: true, timeoutSec: 600 }),
    runSingle: (taskId, opts) => {
      calls.single.push({ taskId, opts });
      return {
        task: { id: taskId, status: "assigned" },
        agent: opts.agent,
        sessionKey: `agent:${opts.agent}:kanban-${taskId}-1`,
      };
    },
    runBoard: startBoard,
    runChain: startChain,
    getRun: (runId) => runs.get(runId) || null,
    waitForRun: async (runId) => runs.get(runId) || null,
    ...overrides,
  };
  return { module, calls, runs };
}

function makeReq(method, body) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = { "tailscale-user-login": "tester@example.com" };
  req.socket = { remoteAddress: "127.0.0.1" };
  process.nextTick(() => {
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

function makeRes() {
  const res = { statusCode: null, body: null };
  res.writeHead = (code) => {
    res.statusCode = code;
  };
  res.end = (payload) => {
    res.body = payload ? JSON.parse(payload) : null;
  };
  return res;
}

async function call(routes, method, pathname, body, query = "") {
  const req = makeReq(method, body);
  const res = makeRes();
  await routes.handle(req, res, pathname, new URLSearchParams(query));
  return res;
}

describe("POST /api/fleet/orchestrate", () => {
  it("503s cleanly when orchestrate is not configured", async () => {
    const { fleet, auditRecords } = makeFleet();
    const routes = createFleetRoutes({ fleet });
    const res = await call(routes, "POST", ORCH_PATH, { mode: "board" });
    assert.strictEqual(res.statusCode, 503);
    assert.match(res.body.error, /not configured/);
    assert.strictEqual(auditRecords.length, 0);
  });

  it("rejects an unknown mode with 400 (no cards, no audit)", async () => {
    const { fleet, auditRecords } = makeFleet();
    const { module } = makeOrchestrate();
    const routes = createFleetRoutes({ fleet, orchestrate: module, rosterFn: () => ROSTER });
    const res = await call(routes, "POST", ORCH_PATH, { mode: "bogus" });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /mode' must be one of/);
    assert.strictEqual(auditRecords.length, 0);
  });

  it("403s OPEN mode when allowOpen is off (policy refusal) + fires alert", async () => {
    const { fleet, alerts, auditRecords } = makeFleet({
      orchestrationBlock: {
        reason: "open-mode-disabled",
        mode: "open",
        message: "OPEN mode requires unlimited-budget opt-in.",
      },
    });
    const { module, calls } = makeOrchestrate();
    const routes = createFleetRoutes({ fleet, orchestrate: module, rosterFn: () => ROSTER });
    const res = await call(routes, "POST", ORCH_PATH, {
      mode: "board",
      budgetMode: "open",
      title: "C",
      question: "Q",
      agents: ["a"],
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.reason, "open-mode-disabled");
    assert.strictEqual(calls.board.length, 0); // gated before any run
    assert.strictEqual(auditRecords.length, 0);
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].type, "budgetBreach");
  });

  it("429s CLOSED mode when the per-task ceiling is reached pre-dispatch", async () => {
    const { fleet, alerts } = makeFleet({
      orchestrationBlock: {
        reason: "closed-ceiling-exceeded",
        mode: "closed",
        message: "ceiling reached",
      },
    });
    const { module, calls } = makeOrchestrate();
    const routes = createFleetRoutes({ fleet, orchestrate: module, rosterFn: () => ROSTER });
    const res = await call(routes, "POST", ORCH_PATH, {
      mode: "board",
      title: "C",
      question: "Q",
      agents: ["a"],
    });
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(res.body.reason, "closed-ceiling-exceeded");
    assert.strictEqual(calls.board.length, 0);
    assert.strictEqual(alerts.length, 1);
  });

  // M-2 — a parallel pool board must be gated on the WHOLE fan-out width BEFORE
  // K seats fan out (the mid-run CLOSED re-check can only halt later seats once
  // they have already dispatched).
  it("M-2: parallel pool board projects perSeatCost × seatCount into the pre-dispatch gate", async () => {
    const CEILING = 5;
    const PER_SEAT = 2;
    // Block fires only when projectedUSD pushes the run to/over the ceiling.
    const { fleet, alerts, orchBlockArgs } = makeFleet({
      orchestrationBlockFn: ({ projectedUSD = 0 }) =>
        projectedUSD >= CEILING
          ? { reason: "closed-ceiling-exceeded", mode: "closed", message: "projected ceiling" }
          : null,
    });
    // Pool routing ACTIVE + a configured per-seat estimate.
    const { module, calls } = makeOrchestrate({
      getStatus: () => ({
        available: true,
        enabled: true,
        timeoutSec: 600,
        routeToPool: true,
        perSeatCostUSD: PER_SEAT,
      }),
    });
    const routes = createFleetRoutes({ fleet, orchestrate: module, rosterFn: () => ROSTER });

    // 3 seats × $2 = $6 projected ≥ $5 ceiling → refused BEFORE any fan-out.
    const res = await call(routes, "POST", ORCH_PATH, {
      mode: "board",
      title: "C",
      question: "Q",
      agents: ["a", "b", "c"],
    });
    assert.strictEqual(res.statusCode, 429, "refused on projected fan-out cost");
    assert.strictEqual(res.body.reason, "closed-ceiling-exceeded");
    assert.strictEqual(calls.board.length, 0, "no seats fanned out");
    assert.strictEqual(alerts.length, 1);
    // The gate received projectedUSD = perSeat × seatCount.
    assert.ok(
      orchBlockArgs.some((a) => a && a.projectedUSD === PER_SEAT * 3),
      "pre-dispatch gate saw projectedUSD = perSeat × seatCount",
    );
  });

  it("M-2: a narrow parallel pool board UNDER the projected ceiling still runs", async () => {
    const CEILING = 5;
    const PER_SEAT = 2;
    const { fleet, alerts } = makeFleet({
      orchestrationBlockFn: ({ projectedUSD = 0 }) =>
        projectedUSD >= CEILING
          ? { reason: "closed-ceiling-exceeded", mode: "closed", message: "projected ceiling" }
          : null,
    });
    const { module, calls } = makeOrchestrate({
      getStatus: () => ({
        available: true,
        enabled: true,
        timeoutSec: 600,
        routeToPool: true,
        perSeatCostUSD: PER_SEAT,
      }),
    });
    const routes = createFleetRoutes({ fleet, orchestrate: module, rosterFn: () => ROSTER });
    // 2 seats × $2 = $4 < $5 → admitted, board starts.
    const res = await call(routes, "POST", ORCH_PATH, {
      mode: "board",
      title: "C",
      question: "Q",
      agents: ["a", "b"],
    });
    assert.strictEqual(res.statusCode, 202, "narrow board admitted");
    assert.strictEqual(calls.board.length, 1, "board fanned out");
    assert.strictEqual(alerts.length, 0);
  });

  it("M-2: spawn-disabled board is byte-identical — no projected gate applied", async () => {
    const { fleet, orchBlockArgs } = makeFleet();
    // getStatus default has NO routeToPool (spawn disabled).
    const { module, calls } = makeOrchestrate();
    const routes = createFleetRoutes({ fleet, orchestrate: module, rosterFn: () => ROSTER });
    const res = await call(routes, "POST", ORCH_PATH, {
      mode: "board",
      title: "C",
      question: "Q",
      agents: ["a", "b", "c"],
    });
    assert.strictEqual(res.statusCode, 202, "board runs");
    assert.strictEqual(calls.board.length, 1);
    // No call ever carried a projectedUSD (the M-2 fan-out gate never engaged).
    assert.ok(
      orchBlockArgs.every((a) => !a || a.projectedUSD === undefined),
      "no projected gate when spawn disabled",
    );
  });

  it("429s when the fleet daily/weekly window block is active (reuses checkDispatchBlock)", async () => {
    const { fleet } = makeFleet({
      dispatchBlock: {
        scope: "total",
        spent: 12,
        limit: 10,
        period: "daily",
        periodKey: "2026-06-10",
      },
    });
    const { module, calls } = makeOrchestrate();
    const routes = createFleetRoutes({ fleet, orchestrate: module, rosterFn: () => ROSTER });
    const res = await call(routes, "POST", ORCH_PATH, {
      mode: "board",
      title: "C",
      question: "Q",
      agents: ["a"],
    });
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(res.body.error, "budget exceeded");
    assert.strictEqual(calls.board.length, 0); // window block fires first
  });

  it("rejects a roster-unknown board agent with 400 (fail closed, no run)", async () => {
    const { fleet, auditRecords } = makeFleet();
    const { module, calls } = makeOrchestrate();
    const routes = createFleetRoutes({ fleet, orchestrate: module, rosterFn: () => ROSTER });
    const res = await call(routes, "POST", ORCH_PATH, {
      mode: "board",
      title: "C",
      question: "Q",
      agents: ["a", "nope"],
    });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /Unknown agent 'nope'/);
    assert.strictEqual(calls.board.length, 0);
    assert.strictEqual(auditRecords.length, 0);
  });

  it("starts a board ASYNC: 202 {runId, status:'running'} + task.create audit {async:true}", async () => {
    const { fleet, auditRecords, rateChecks } = makeFleet();
    const { module, calls } = makeOrchestrate();
    const routes = createFleetRoutes({ fleet, orchestrate: module, rosterFn: () => ROSTER });
    const res = await call(routes, "POST", ORCH_PATH, {
      mode: "board",
      title: "Council",
      question: "What now?",
      agents: ["a", "b"],
    });
    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.mode, "board");
    assert.strictEqual(res.body.status, "running");
    assert.match(res.body.runId, /^orx_/);
    assert.deepStrictEqual(res.body.agents, ["a", "b"]);
    // 202 carries no collected results — the Chief polls GET :runId for those.
    assert.strictEqual(res.body.results, undefined);
    assert.strictEqual(calls.board.length, 1);
    // a mid-run budgetCheck closure is handed to the runner
    assert.strictEqual(typeof calls.board[0].budgetCheck, "function");
    assert.strictEqual(rateChecks.length, 1); // one token
    assert.strictEqual(auditRecords.length, 1);
    assert.strictEqual(auditRecords[0].action, "task.create");
    assert.strictEqual(auditRecords[0].detail.op, "orchestrate:board");
    assert.strictEqual(auditRecords[0].detail.async, true);
    assert.strictEqual(auditRecords[0].target, res.body.runId);
  });

  it("starts a chain ASYNC: 202 {runId, status:'running'} + task.create audit {async:true}", async () => {
    const { fleet, auditRecords } = makeFleet();
    const { module, calls } = makeOrchestrate();
    const routes = createFleetRoutes({ fleet, orchestrate: module, rosterFn: () => ROSTER });
    const res = await call(routes, "POST", ORCH_PATH, {
      mode: "chain",
      title: "Pipe",
      steps: [
        { agent: "a", instruction: "1" },
        { agent: "b", instruction: "2" },
      ],
    });
    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(res.body.mode, "chain");
    assert.strictEqual(res.body.status, "running");
    assert.match(res.body.runId, /^orx_/);
    assert.deepStrictEqual(res.body.agents, ["a", "b"]);
    assert.strictEqual(res.body.final, undefined); // not collected at 202
    assert.strictEqual(calls.chain.length, 1);
    assert.strictEqual(auditRecords[0].detail.op, "orchestrate:chain");
    assert.strictEqual(auditRecords[0].detail.steps, 2);
    assert.strictEqual(auditRecords[0].detail.async, true);
  });

  it("board {wait:true} blocks (capped) and returns 200 with collected results", async () => {
    const { fleet, auditRecords } = makeFleet();
    const { module, calls } = makeOrchestrate();
    const routes = createFleetRoutes({ fleet, orchestrate: module, rosterFn: () => ROSTER });
    const res = await call(routes, "POST", ORCH_PATH, {
      mode: "board",
      title: "Council",
      question: "What now?",
      agents: ["a", "b"],
      wait: true,
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.mode, "board");
    assert.strictEqual(res.body.status, "done");
    assert.strictEqual(res.body.results.length, 2);
    assert.strictEqual(calls.board.length, 1);
    assert.strictEqual(auditRecords[0].detail.async, false); // sync path
  });

  it("?wait=true (query) also takes the sync 200 path", async () => {
    const { fleet } = makeFleet();
    const { module } = makeOrchestrate();
    const routes = createFleetRoutes({ fleet, orchestrate: module, rosterFn: () => ROSTER });
    const res = await call(
      routes,
      "POST",
      ORCH_PATH,
      { mode: "chain", title: "Pipe", steps: [{ agent: "a", instruction: "1" }] },
      "wait=true",
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.status, "done");
    assert.strictEqual(res.body.final, "final-out");
  });

  it("GET :runId returns the run snapshot (200) once it exists", async () => {
    const { fleet } = makeFleet();
    const { module } = makeOrchestrate();
    const routes = createFleetRoutes({ fleet, orchestrate: module, rosterFn: () => ROSTER });
    const start = await call(routes, "POST", ORCH_PATH, {
      mode: "board",
      title: "Council",
      question: "Q",
      agents: ["a", "b"],
    });
    const { runId } = start.body;
    const got = await call(routes, "GET", `${ORCH_PATH}/${runId}`);
    assert.strictEqual(got.statusCode, 200);
    assert.strictEqual(got.body.success, true);
    assert.strictEqual(got.body.runId, runId);
    assert.strictEqual(got.body.mode, "board");
    assert.strictEqual(got.body.status, "done");
    assert.strictEqual(got.body.results.length, 2);
  });

  it("GET :runId for an unknown/expired run is 404", async () => {
    const { fleet } = makeFleet();
    const { module } = makeOrchestrate();
    const routes = createFleetRoutes({ fleet, orchestrate: module, rosterFn: () => ROSTER });
    const got = await call(routes, "GET", `${ORCH_PATH}/orx_nope`);
    assert.strictEqual(got.statusCode, 404);
    assert.match(got.body.error, /Unknown runId/);
  });

  it("runs single: delegates + audits task.update {op:'orchestrate:single'}", async () => {
    const { fleet, auditRecords } = makeFleet();
    const { module, calls } = makeOrchestrate();
    const routes = createFleetRoutes({ fleet, orchestrate: module, rosterFn: () => ROSTER });
    const res = await call(routes, "POST", ORCH_PATH, {
      mode: "single",
      taskId: "tsk_xyz",
      agent: "a",
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.mode, "single");
    assert.strictEqual(res.body.agent, "a");
    assert.strictEqual(calls.single.length, 1);
    assert.strictEqual(auditRecords[0].detail.op, "orchestrate:single");
  });

  it("consumes a rate-limit token and 429s when exhausted (before any run)", async () => {
    const { fleet } = makeFleet({ allowed: false });
    const { module, calls } = makeOrchestrate();
    const routes = createFleetRoutes({ fleet, orchestrate: module, rosterFn: () => ROSTER });
    const res = await call(routes, "POST", ORCH_PATH, {
      mode: "board",
      title: "C",
      question: "Q",
      agents: ["a"],
    });
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(res.body.retryAfterMs, 1234);
    assert.strictEqual(calls.board.length, 0);
  });

  it("400s board with an empty agents array", async () => {
    const { fleet } = makeFleet();
    const { module } = makeOrchestrate();
    const routes = createFleetRoutes({ fleet, orchestrate: module, rosterFn: () => ROSTER });
    const res = await call(routes, "POST", ORCH_PATH, {
      mode: "board",
      title: "C",
      question: "Q",
      agents: [],
    });
    assert.strictEqual(res.statusCode, 400);
  });

  // M-3 — event_id / dedup_key length is bounded at the route boundary (before
  // it can be written into the durable SQLite dedup table).
  it("M-3: a 257-char event_id is rejected with 400 before any run", async () => {
    const { fleet } = makeFleet();
    const { module, calls } = makeOrchestrate();
    const routes = createFleetRoutes({ fleet, orchestrate: module, rosterFn: () => ROSTER });
    const res = await call(routes, "POST", ORCH_PATH, {
      mode: "board",
      title: "C",
      question: "Q",
      agents: ["a"],
      event_id: "x".repeat(257),
    });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /256 characters/);
    assert.strictEqual(calls.board.length, 0, "no run started on an over-long event_id");
  });

  it("M-3: a 256-char event_id is accepted (boundary)", async () => {
    const { fleet } = makeFleet();
    const { module, calls } = makeOrchestrate();
    const routes = createFleetRoutes({ fleet, orchestrate: module, rosterFn: () => ROSTER });
    const res = await call(routes, "POST", ORCH_PATH, {
      mode: "board",
      title: "C",
      question: "Q",
      agents: ["a"],
      event_id: "y".repeat(256),
    });
    assert.strictEqual(res.statusCode, 202, "256-char event_id is within bounds");
    assert.strictEqual(calls.board.length, 1);
  });

  it("M-3: an over-long dedup_key alias is also rejected with 400", async () => {
    const { fleet } = makeFleet();
    const { module, calls } = makeOrchestrate();
    const routes = createFleetRoutes({ fleet, orchestrate: module, rosterFn: () => ROSTER });
    const res = await call(routes, "POST", ORCH_PATH, {
      mode: "board",
      title: "C",
      question: "Q",
      agents: ["a"],
      dedup_key: "z".repeat(300),
    });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /256 characters/);
    assert.strictEqual(calls.board.length, 0);
  });
});
