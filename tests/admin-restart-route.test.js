/**
 * Unit tests for POST /api/fleet/admin/restart in src/fleet-routes.js.
 *
 * Uses a mocked fleet runtime and fake req/res objects (same harness style
 * as budgets-routes.test.js). The exit function is ALWAYS injected as a
 * fake — these tests must never call the real process.exit.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { createFleetRoutes } = require("../src/fleet-routes");
const { AUDIT_ACTIONS } = require("../src/audit");

function makeFleet({ rateLimitAllowed = true } = {}) {
  const auditRecords = [];
  const fleet = {
    rateLimiter: {
      check: () =>
        rateLimitAllowed ? { allowed: true } : { allowed: false, retryAfterMs: 1234 },
    },
    audit: {
      record: (entry) => auditRecords.push(entry),
    },
  };
  return { fleet, auditRecords };
}

function makeReq(method, user = "tester@example.com") {
  const req = new EventEmitter();
  req.method = method;
  req.headers = user ? { "tailscale-user-login": user } : {};
  req.socket = { remoteAddress: "127.0.0.1" };
  process.nextTick(() => req.emit("end"));
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

async function call(routes, method, pathname, { user } = {}) {
  const req = makeReq(method, user);
  const res = makeRes();
  await routes.handle(req, res, pathname, new URLSearchParams());
  return res;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("admin restart route", () => {
  it("registers service.restart in the audit action enum", () => {
    assert.ok(AUDIT_ACTIONS.includes("service.restart"));
  });

  it("responds {success, restartingInMs} then calls exitFn(1) after the delay", async () => {
    const { fleet } = makeFleet();
    const exitCalls = [];
    const routes = createFleetRoutes({
      fleet,
      exitFn: (code) => exitCalls.push(code),
      restartDelayMs: 10,
    });

    const res = await call(routes, "POST", "/api/fleet/admin/restart");
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { success: true, restartingInMs: 10 });
    // The exit is deferred so the response can flush first.
    assert.deepStrictEqual(exitCalls, []);
    await sleep(40);
    assert.deepStrictEqual(exitCalls, [1]);
  });

  it("records an audited service.restart entry with the caller identity", async () => {
    const { fleet, auditRecords } = makeFleet();
    const routes = createFleetRoutes({ fleet, exitFn: () => {}, restartDelayMs: 5 });

    await call(routes, "POST", "/api/fleet/admin/restart", { user: "Ops@Example.com" });
    assert.strictEqual(auditRecords.length, 1);
    assert.strictEqual(auditRecords[0].action, "service.restart");
    assert.strictEqual(auditRecords[0].user, "ops@example.com");
    assert.deepStrictEqual(auditRecords[0].detail, { restartingInMs: 5 });
  });

  it("falls back to the anonymous identity without the Tailscale header", async () => {
    const { fleet, auditRecords } = makeFleet();
    const routes = createFleetRoutes({ fleet, exitFn: () => {}, restartDelayMs: 5 });

    await call(routes, "POST", "/api/fleet/admin/restart", { user: null });
    assert.strictEqual(auditRecords[0].user, "anonymous");
  });

  it("is rate-limited: 429 with retryAfterMs and exitFn never fires", async () => {
    const { fleet, auditRecords } = makeFleet({ rateLimitAllowed: false });
    const exitCalls = [];
    const routes = createFleetRoutes({
      fleet,
      exitFn: (code) => exitCalls.push(code),
      restartDelayMs: 5,
    });

    const res = await call(routes, "POST", "/api/fleet/admin/restart");
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(res.body.error, "Rate limit exceeded");
    assert.strictEqual(res.body.retryAfterMs, 1234);
    await sleep(30);
    assert.deepStrictEqual(exitCalls, []);
    assert.deepStrictEqual(auditRecords, []);
  });

  it("rejects non-POST methods and unknown admin paths with 404", async () => {
    const { fleet } = makeFleet();
    const exitCalls = [];
    const routes = createFleetRoutes({
      fleet,
      exitFn: (code) => exitCalls.push(code),
      restartDelayMs: 5,
    });

    const get = await call(routes, "GET", "/api/fleet/admin/restart");
    assert.strictEqual(get.statusCode, 404);
    const unknown = await call(routes, "POST", "/api/fleet/admin/shutdown");
    assert.strictEqual(unknown.statusCode, 404);
    await sleep(30);
    assert.deepStrictEqual(exitCalls, []);
  });
});
