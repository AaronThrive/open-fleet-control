/**
 * Unit tests for the budgets routes in src/fleet-routes.js:
 * GET /api/fleet/budgets/status. Uses a mocked fleet runtime (no HTTP
 * server) and fake req/res objects — same harness style as
 * cortex-routes.test.js. The endpoint is read-only: no rate-limit token,
 * no audit entry.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { createFleetRoutes } = require("../src/fleet-routes");

const SAMPLE_STATUS = {
  enabled: true,
  generatedAt: 1765368000000,
  periods: {
    daily: {
      periodKey: "2026-06-10",
      elapsedPct: 50,
      usageAvailable: true,
      scopes: [{ scope: "total", limitUSD: 10, spentUSD: 3.2, percent: 32, state: "ok" }],
    },
  },
};

function makeFleet({ budgets = {} } = {}) {
  let rateLimitChecks = 0;
  const auditRecords = [];
  const fleet = {
    rateLimiter: {
      check: () => {
        rateLimitChecks += 1;
        return { allowed: true };
      },
    },
    audit: {
      record: (entry) => auditRecords.push(entry),
    },
    budgets: {
      getStatus: async () => SAMPLE_STATUS,
      ...budgets,
    },
  };
  return { fleet, auditRecords, getRateLimitChecks: () => rateLimitChecks };
}

function makeReq(method) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = { "tailscale-user-login": "tester@example.com" };
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

async function call(routes, method, pathname) {
  const req = makeReq(method);
  const res = makeRes();
  await routes.handle(req, res, pathname, new URLSearchParams());
  return res;
}

describe("budgets routes", () => {
  describe("GET /api/fleet/budgets/status", () => {
    it("returns the module status verbatim with 200", async () => {
      const { fleet } = makeFleet();
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "GET", "/api/fleet/budgets/status");
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.body, SAMPLE_STATUS);
    });

    it("passes { enabled: false } through cleanly when budgets are off", async () => {
      const { fleet } = makeFleet({ budgets: { getStatus: async () => ({ enabled: false }) } });
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "GET", "/api/fleet/budgets/status");
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.body, { enabled: false });
    });

    it("is read-only: consumes no rate-limit token and records no audit entry", async () => {
      const { fleet, auditRecords, getRateLimitChecks } = makeFleet();
      const routes = createFleetRoutes({ fleet });
      await call(routes, "GET", "/api/fleet/budgets/status");
      assert.strictEqual(getRateLimitChecks(), 0);
      assert.deepStrictEqual(auditRecords, []);
    });

    it("maps a module failure to a JSON error envelope", async () => {
      const { fleet } = makeFleet({
        budgets: {
          getStatus: async () => {
            throw new Error("status exploded");
          },
        },
      });
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "GET", "/api/fleet/budgets/status");
      assert.strictEqual(res.statusCode, 400);
      assert.deepStrictEqual(res.body, { error: "status exploded" });
    });
  });

  describe("unknown budgets routes", () => {
    it("404s on POST /api/fleet/budgets/status", async () => {
      const { fleet } = makeFleet();
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "POST", "/api/fleet/budgets/status");
      assert.strictEqual(res.statusCode, 404);
    });

    it("404s on GET /api/fleet/budgets", async () => {
      const { fleet } = makeFleet();
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "GET", "/api/fleet/budgets");
      assert.strictEqual(res.statusCode, 404);
    });
  });
});
