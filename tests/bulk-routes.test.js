/**
 * Unit tests for the POST /api/fleet/bulk route in src/fleet-routes.js.
 *
 * Mirrors the dispatch-routes pattern: mocked fleet runtime + mocked bulk
 * module + fake req/res — no HTTP server, no network. Covers the 503 "not
 * configured" fallback, identity attribution, the single audit entry with
 * the targets list (action.execute + detail.kind="bulk"), per-target result
 * pass-through, rate limiting, validation statusCode pass-through, and
 * method/path rejection.
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
  };
  return { fleet, auditRecords, rateChecks };
}

function makeBulkModule(overrides = {}) {
  const calls = [];
  const module = {
    execute: async (request) => {
      calls.push(request);
      return {
        action: request.action,
        targets: request.targets,
        results: request.targets.map((target) => ({ target, ok: target !== "bad", detail: "d" })),
        okCount: request.targets.filter((t) => t !== "bad").length,
        failCount: request.targets.filter((t) => t === "bad").length,
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

describe("bulk routes", () => {
  it("responds 503 when the bulk module is not wired", async () => {
    const { fleet } = makeFleet();
    const routes = createFleetRoutes({ fleet });
    const res = await call(routes, "POST", "/api/fleet/bulk", {
      action: "health-check",
      targets: ["local"],
    });
    assert.strictEqual(res.statusCode, 503);
    assert.ok(res.body.error.includes("not configured"));
  });

  it("executes the bulk action and returns per-target results", async () => {
    const { fleet } = makeFleet();
    const { module, calls } = makeBulkModule();
    const routes = createFleetRoutes({ fleet, bulk: module });
    const res = await call(routes, "POST", "/api/fleet/bulk", {
      action: "health-check",
      targets: ["node-a", "bad"],
      params: { staleMinutes: 60 },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.results.length, 2);
    assert.strictEqual(res.body.okCount, 1);
    assert.strictEqual(res.body.failCount, 1);
    // Actor identity flows into the module call.
    assert.strictEqual(calls[0].actor, "tester@example.com");
    assert.deepStrictEqual(calls[0].params, { staleMinutes: 60 });
  });

  it("records ONE audit entry with the targets list (action.execute, kind bulk)", async () => {
    const { fleet, auditRecords } = makeFleet();
    const { module } = makeBulkModule();
    const routes = createFleetRoutes({ fleet, bulk: module });
    await call(routes, "POST", "/api/fleet/bulk", {
      action: "kill-stale-sessions",
      targets: ["node-a", "node-b"],
    });
    assert.strictEqual(auditRecords.length, 1);
    const entry = auditRecords[0];
    assert.strictEqual(entry.user, "tester@example.com");
    assert.strictEqual(entry.action, "action.execute");
    assert.strictEqual(entry.target, "kill-stale-sessions");
    assert.strictEqual(entry.detail.kind, "bulk");
    assert.deepStrictEqual(entry.detail.targets, ["node-a", "node-b"]);
    assert.strictEqual(entry.detail.okCount, 2);
    assert.strictEqual(entry.detail.failCount, 0);
  });

  it("consumes a rate-limit token and 429s when exhausted", async () => {
    const { fleet, rateChecks } = makeFleet({ allowed: false });
    const { module, calls } = makeBulkModule();
    const routes = createFleetRoutes({ fleet, bulk: module });
    const res = await call(routes, "POST", "/api/fleet/bulk", {
      action: "health-check",
      targets: ["local"],
    });
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(res.body.retryAfterMs, 1234);
    assert.strictEqual(rateChecks.length, 1);
    assert.strictEqual(calls.length, 0); // never reached the module
  });

  it("passes module validation errors through as their statusCode", async () => {
    const { fleet, auditRecords } = makeFleet();
    const { module } = makeBulkModule({
      execute: async () => {
        const err = new Error("Unknown bulk action: rm-rf");
        err.statusCode = 400;
        throw err;
      },
    });
    const routes = createFleetRoutes({ fleet, bulk: module });
    const res = await call(routes, "POST", "/api/fleet/bulk", { action: "rm-rf" });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.error.includes("Unknown bulk action"));
    assert.strictEqual(auditRecords.length, 0); // nothing executed, nothing audited
  });

  it("404s GET /api/fleet/bulk and deeper paths", async () => {
    const { fleet } = makeFleet();
    const { module } = makeBulkModule();
    const routes = createFleetRoutes({ fleet, bulk: module });
    const getRes = await call(routes, "GET", "/api/fleet/bulk");
    assert.strictEqual(getRes.statusCode, 404);
    const deepRes = await call(routes, "POST", "/api/fleet/bulk/extra", {
      action: "health-check",
    });
    assert.strictEqual(deepRes.statusCode, 404);
  });
});
