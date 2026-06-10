/**
 * Unit tests for the kanban dispatch routes in src/fleet-routes.js:
 *   GET  /api/fleet/kanban/dispatch                  (availability for the UI)
 *   POST /api/fleet/kanban/tasks/:id/dispatch        (?preview=1 for preview)
 *
 * Mirrors the cortex-routes pattern: mocked fleet runtime + mocked dispatch
 * module + fake req/res — no HTTP server, no CLI, no real agents. Covers the
 * 503 "not configured" fallback, roster validation, preview (no rate-limit
 * token, no audit), successful dispatch (+ audit detail {op:'dispatch'}),
 * rate limiting, and statusCode pass-through (409 / 429 / 503).
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { createFleetRoutes } = require("../src/fleet-routes");

function makeFleet({ allowed = true } = {}) {
  const auditRecords = [];
  const rateChecks = [];
  const fleet = {
    rateLimiter: {
      check: (key) => {
        rateChecks.push(key);
        return allowed ? { allowed: true } : { allowed: false, retryAfterMs: 1234 };
      },
    },
    audit: { record: (entry) => auditRecords.push(entry) },
    kanban: { getBoard: () => ({ tasks: [] }) },
  };
  return { fleet, auditRecords, rateChecks };
}

function makeDispatch(overrides = {}) {
  const calls = { dispatch: [], preview: [] };
  const module = {
    getStatus: () => ({
      available: true,
      enabled: true,
      node: "n1",
      maxConcurrent: 3,
      openCount: 0,
    }),
    previewDispatch: (taskId, opts) => {
      calls.preview.push({ taskId, opts });
      return { taskId, agent: opts.agent, node: "n1", message: "kickoff body" };
    },
    dispatchTask: (taskId, opts) => {
      calls.dispatch.push({ taskId, opts });
      return {
        task: { id: taskId, status: "assigned" },
        agent: opts.agent,
        sessionKey: `agent:${opts.agent}:kanban-${taskId}-1`,
        attemptIndex: 0,
        completion: Promise.resolve(),
      };
    },
    ...overrides,
  };
  return { module, calls };
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

const ROSTER = { agents: [{ id: "dev" }, { id: "ops" }] };
const DISPATCH_PATH = "/api/fleet/kanban/tasks/tsk_abc123/dispatch";

describe("kanban dispatch routes", () => {
  describe("GET /api/fleet/kanban/dispatch", () => {
    it("returns the module status when wired", async () => {
      const { fleet } = makeFleet();
      const { module } = makeDispatch();
      const routes = createFleetRoutes({ fleet, dispatch: module });
      const res = await call(routes, "GET", "/api/fleet/kanban/dispatch");
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.available, true);
      assert.strictEqual(res.body.maxConcurrent, 3);
    });

    it("reports unavailable (200) when dispatch is not wired", async () => {
      const { fleet } = makeFleet();
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "GET", "/api/fleet/kanban/dispatch");
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.body, { available: false, enabled: false, openCount: 0 });
    });
  });

  describe("POST .../tasks/:id/dispatch", () => {
    it("503s cleanly when dispatch is not configured", async () => {
      const { fleet, auditRecords } = makeFleet();
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "POST", DISPATCH_PATH, { agent: "dev" });
      assert.strictEqual(res.statusCode, 503);
      assert.match(res.body.error, /not configured/);
      assert.strictEqual(auditRecords.length, 0);
    });

    it("dispatches, audits task.update {op:'dispatch', agent}, returns the envelope", async () => {
      const { fleet, auditRecords } = makeFleet();
      const { module, calls } = makeDispatch();
      const routes = createFleetRoutes({ fleet, dispatch: module, rosterFn: () => ROSTER });
      const res = await call(routes, "POST", DISPATCH_PATH, { agent: "dev" });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.agent, "dev");
      assert.match(res.body.sessionKey, /^agent:dev:kanban-/);
      assert.strictEqual(res.body.task.id, "tsk_abc123");
      assert.strictEqual(res.body.completion, undefined); // internal promise never serialized

      assert.strictEqual(calls.dispatch.length, 1);
      assert.deepStrictEqual(calls.dispatch[0], {
        taskId: "tsk_abc123",
        opts: { agent: "dev", node: undefined, actor: "tester@example.com" },
      });

      assert.strictEqual(auditRecords.length, 1);
      assert.strictEqual(auditRecords[0].action, "task.update");
      assert.strictEqual(auditRecords[0].target, "tsk_abc123");
      assert.deepStrictEqual(auditRecords[0].detail, { op: "dispatch", agent: "dev" });
    });

    it("rejects agents missing from the local roster with 400 (and never dispatches)", async () => {
      const { fleet, auditRecords } = makeFleet();
      const { module, calls } = makeDispatch();
      const routes = createFleetRoutes({ fleet, dispatch: module, rosterFn: () => ROSTER });
      const res = await call(routes, "POST", DISPATCH_PATH, { agent: "nope" });
      assert.strictEqual(res.statusCode, 400);
      assert.match(res.body.error, /Unknown agent 'nope'/);
      assert.strictEqual(calls.dispatch.length, 0);
      assert.strictEqual(auditRecords.length, 0);
    });

    it("fails closed (503) when the roster read throws", async () => {
      const { fleet } = makeFleet();
      const { module, calls } = makeDispatch();
      const routes = createFleetRoutes({
        fleet,
        dispatch: module,
        rosterFn: () => {
          throw new Error("config unreadable");
        },
      });
      const res = await call(routes, "POST", DISPATCH_PATH, { agent: "dev" });
      assert.strictEqual(res.statusCode, 503);
      assert.match(res.body.error, /roster unavailable/i);
      assert.strictEqual(calls.dispatch.length, 0);
    });

    it("supports async rosterFn results", async () => {
      const { fleet } = makeFleet();
      const { module } = makeDispatch();
      const routes = createFleetRoutes({
        fleet,
        dispatch: module,
        rosterFn: async () => ROSTER,
      });
      const res = await call(routes, "POST", DISPATCH_PATH, { agent: "ops" });
      assert.strictEqual(res.statusCode, 200);
    });

    it("skips roster validation when no rosterFn is wired", async () => {
      const { fleet } = makeFleet();
      const { module } = makeDispatch();
      const routes = createFleetRoutes({ fleet, dispatch: module });
      const res = await call(routes, "POST", DISPATCH_PATH, { agent: "anything" });
      assert.strictEqual(res.statusCode, 200);
    });

    it("consumes a rate-limit token and 429s when exhausted", async () => {
      const { fleet } = makeFleet({ allowed: false });
      const { module, calls } = makeDispatch();
      const routes = createFleetRoutes({ fleet, dispatch: module, rosterFn: () => ROSTER });
      const res = await call(routes, "POST", DISPATCH_PATH, { agent: "dev" });
      assert.strictEqual(res.statusCode, 429);
      assert.strictEqual(res.body.retryAfterMs, 1234);
      assert.strictEqual(calls.dispatch.length, 0);
    });

    it("passes module statusCodes through (409 double dispatch, 429 capacity, 503 unavailable)", async () => {
      for (const [statusCode, message] of [
        [409, "Task tsk_abc123 already has an open dispatched attempt"],
        [429, "Max concurrent dispatches (3) reached"],
        [503, "Dispatch mechanism unavailable: openclaw CLI not found on PATH"],
      ]) {
        const { fleet } = makeFleet();
        const { module } = makeDispatch({
          dispatchTask: () => {
            const err = new Error(message);
            err.statusCode = statusCode;
            throw err;
          },
        });
        const routes = createFleetRoutes({ fleet, dispatch: module, rosterFn: () => ROSTER });
        const res = await call(routes, "POST", DISPATCH_PATH, { agent: "dev" });
        assert.strictEqual(res.statusCode, statusCode);
        assert.strictEqual(res.body.error, message);
      }
    });
  });

  describe("POST .../tasks/:id/dispatch?preview=1", () => {
    it("returns the composed message without consuming a token or auditing", async () => {
      const { fleet, auditRecords, rateChecks } = makeFleet();
      const { module, calls } = makeDispatch();
      const routes = createFleetRoutes({ fleet, dispatch: module, rosterFn: () => ROSTER });
      const res = await call(routes, "POST", DISPATCH_PATH, { agent: "dev" }, "preview=1");

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.preview, true);
      assert.strictEqual(res.body.message, "kickoff body");
      assert.strictEqual(calls.preview.length, 1);
      assert.strictEqual(calls.dispatch.length, 0);
      assert.strictEqual(auditRecords.length, 0);
      assert.strictEqual(rateChecks.length, 0);
    });

    it("validates the roster in preview mode too", async () => {
      const { fleet } = makeFleet();
      const { module, calls } = makeDispatch();
      const routes = createFleetRoutes({ fleet, dispatch: module, rosterFn: () => ROSTER });
      const res = await call(routes, "POST", DISPATCH_PATH, { agent: "ghost" }, "preview=1");
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(calls.preview.length, 0);
    });
  });
});
