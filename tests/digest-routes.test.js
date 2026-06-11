/**
 * Unit tests for the v2.2 route additions in src/fleet-routes.js:
 *   POST /api/fleet/digest/test   → digest.sendNow (audited, rate-limited)
 *   POST /api/fleet/budgets/ack   → budgets.ack    (audited, rate-limited)
 *   budget guardrail on POST /api/fleet/kanban/tasks/:id/dispatch
 *     (429 {error:"budget exceeded", scope, spent, limit} + budgetBreach
 *      alert; previews and unblocked dispatches unaffected)
 *
 * Mirrors the dispatch-routes pattern: mocked fleet runtime + fake req/res.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { createFleetRoutes } = require("../src/fleet-routes");

const USER = "tester@example.com";
const BLOCK = {
  scope: "total",
  spent: 12,
  limit: 10,
  period: "daily",
  periodKey: "2026-06-10",
};

function makeFleet({ allowed = true, block = null, sendResult } = {}) {
  const auditRecords = [];
  const rateChecks = [];
  const fired = [];
  const ackCalls = [];
  const sendCalls = [];
  const fleet = {
    rateLimiter: {
      check: (key) => {
        rateChecks.push(key);
        return allowed ? { allowed: true } : { allowed: false, retryAfterMs: 1234 };
      },
    },
    audit: { record: (entry) => auditRecords.push(entry) },
    kanban: { getBoard: () => ({ tasks: [] }) },
    fireAlert: async (event) => {
      fired.push(event);
      return { fired: true };
    },
    budgets: {
      checkDispatchBlock: () => block,
      ack: (user) => {
        ackCalls.push(user);
        return { acked: block ? ["daily:2026-06-10"] : [] };
      },
      getStatus: async () => ({ enabled: false }),
    },
    digest: {
      sendNow: async () => {
        sendCalls.push(Date.now());
        return (
          sendResult || {
            sent: true,
            scheduled: false,
            title: "Fleet digest (daily)",
            markdown: "**Fleet digest**",
            dispatched: 1,
            delivered: 1,
          }
        );
      },
    },
  };
  return { fleet, auditRecords, rateChecks, fired, ackCalls, sendCalls };
}

function makeDispatch() {
  const calls = { dispatch: [], preview: [] };
  const module = {
    getStatus: () => ({ available: true, enabled: true, openCount: 0 }),
    previewDispatch: (taskId, opts) => {
      calls.preview.push({ taskId, opts });
      return { taskId, agent: opts.agent, node: "n1", message: "kickoff" };
    },
    dispatchTask: (taskId, opts) => {
      calls.dispatch.push({ taskId, opts });
      return {
        task: { id: taskId, status: "assigned" },
        agent: opts.agent,
        sessionKey: "agent:dev:kanban-1",
        attemptIndex: 0,
        completion: Promise.resolve(),
      };
    },
  };
  return { module, calls };
}

function makeReq(method, body) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = { "tailscale-user-login": USER };
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

const DISPATCH_PATH = "/api/fleet/kanban/tasks/tsk_abc123/dispatch";

describe("digest + budget-guardrail routes", () => {
  describe("POST /api/fleet/digest/test", () => {
    it("composes + sends now and returns the delivery result", async () => {
      const { fleet, sendCalls } = makeFleet();
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "POST", "/api/fleet/digest/test", {});
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.result.sent, true);
      assert.strictEqual(res.body.result.delivered, 1);
      assert.strictEqual(sendCalls.length, 1);
    });

    it("is audited as digest.test with delivery counts (never the content)", async () => {
      const { fleet, auditRecords } = makeFleet();
      const routes = createFleetRoutes({ fleet });
      await call(routes, "POST", "/api/fleet/digest/test", {});
      assert.strictEqual(auditRecords.length, 1);
      assert.strictEqual(auditRecords[0].action, "digest.test");
      assert.strictEqual(auditRecords[0].user, USER);
      assert.deepStrictEqual(auditRecords[0].detail, { sent: true, dispatched: 1, delivered: 1 });
    });

    it("is rate-limited (429 with retryAfterMs, no send, no audit)", async () => {
      const { fleet, sendCalls, auditRecords } = makeFleet({ allowed: false });
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "POST", "/api/fleet/digest/test", {});
      assert.strictEqual(res.statusCode, 429);
      assert.strictEqual(res.body.retryAfterMs, 1234);
      assert.strictEqual(sendCalls.length, 0);
      assert.deepStrictEqual(auditRecords, []);
    });

    it("404s on GET", async () => {
      const { fleet } = makeFleet();
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "GET", "/api/fleet/digest/test");
      assert.strictEqual(res.statusCode, 404);
    });
  });

  describe("POST /api/fleet/budgets/ack", () => {
    it("acks through the budgets module and is audited as budgets.ack", async () => {
      const { fleet, auditRecords, ackCalls } = makeFleet({ block: BLOCK });
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "POST", "/api/fleet/budgets/ack", {});
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.body, { success: true, acked: ["daily:2026-06-10"] });
      assert.deepStrictEqual(ackCalls, [USER]);
      assert.strictEqual(auditRecords.length, 1);
      assert.strictEqual(auditRecords[0].action, "budgets.ack");
      assert.deepStrictEqual(auditRecords[0].detail, { acked: ["daily:2026-06-10"] });
    });

    it("is rate-limited", async () => {
      const { fleet, ackCalls } = makeFleet({ allowed: false, block: BLOCK });
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "POST", "/api/fleet/budgets/ack", {});
      assert.strictEqual(res.statusCode, 429);
      assert.deepStrictEqual(ackCalls, []);
    });

    it("404s on GET /api/fleet/budgets/ack", async () => {
      const { fleet } = makeFleet();
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "GET", "/api/fleet/budgets/ack");
      assert.strictEqual(res.statusCode, 404);
    });
  });

  describe("dispatch budget guardrail", () => {
    it("refuses dispatch with a 429 'budget exceeded' envelope when blocked", async () => {
      const { fleet, fired } = makeFleet({ block: BLOCK });
      const { module, calls } = makeDispatch();
      const routes = createFleetRoutes({ fleet, dispatch: module });
      const res = await call(routes, "POST", DISPATCH_PATH, { agent: "dev" });

      assert.strictEqual(res.statusCode, 429);
      assert.deepStrictEqual(res.body, {
        error: "budget exceeded",
        scope: "total",
        spent: 12,
        limit: 10,
        period: "daily",
        periodKey: "2026-06-10",
      });
      assert.strictEqual(calls.dispatch.length, 0); // dispatch never started
      // budgetBreach alert fired on the block event.
      assert.strictEqual(fired.length, 1);
      assert.strictEqual(fired[0].type, "budgetBreach");
      assert.strictEqual(fired[0].severity, "warn");
      assert.strictEqual(fired[0].task, "tsk_abc123");
      assert.ok(fired[0].message.includes("budget exceeded"));
    });

    it("dispatches normally when the guard reports no block", async () => {
      const { fleet, fired } = makeFleet({ block: null });
      const { module, calls } = makeDispatch();
      const routes = createFleetRoutes({ fleet, dispatch: module });
      const res = await call(routes, "POST", DISPATCH_PATH, { agent: "dev" });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(calls.dispatch.length, 1);
      assert.deepStrictEqual(fired, []);
    });

    it("never blocks read-only previews", async () => {
      const { fleet } = makeFleet({ block: BLOCK });
      const { module, calls } = makeDispatch();
      const routes = createFleetRoutes({ fleet, dispatch: module });
      const res = await call(routes, "POST", DISPATCH_PATH, { agent: "dev" }, "preview=1");
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.preview, true);
      assert.strictEqual(calls.preview.length, 1);
    });

    it("tolerates a fleet runtime without the guard (older mocks)", async () => {
      const { fleet } = makeFleet();
      delete fleet.budgets;
      const { module, calls } = makeDispatch();
      const routes = createFleetRoutes({ fleet, dispatch: module });
      const res = await call(routes, "POST", DISPATCH_PATH, { agent: "dev" });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(calls.dispatch.length, 1);
    });
  });
});
