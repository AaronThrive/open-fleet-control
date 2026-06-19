/**
 * Unit tests for the read-only cortex memory routes in src/fleet-routes.js:
 * GET /api/fleet/cortex, GET /api/fleet/cortex/memory (list/search),
 * GET /api/fleet/cortex/memory/:id, and GET /api/fleet/cortex/gauges. The
 * memory browser is READ-ONLY (gbrain-backed); store/update/delete and the
 * knowledge-graph viz endpoint have been removed and must 404. Uses a mocked
 * fleet runtime (no HTTP server, no CLI) and fake req/res objects.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { createFleetRoutes } = require("../src/fleet-routes");

function makeFleet({ cortex = {}, allowed = true } = {}) {
  const auditRecords = [];
  const fleet = {
    rateLimiter: {
      check: () => (allowed ? { allowed: true } : { allowed: false, retryAfterMs: 1234 }),
    },
    audit: {
      record: (entry) => auditRecords.push(entry),
    },
    cortex: {
      getState: async () => ({}),
      searchMemory: async () => ({ items: [], total: 0 }),
      listMemory: async () => ({ items: [], total: 0 }),
      getMemory: async () => ({ id: "m-1", content: "hello" }),
      getGauges: () => [],
      ...cortex,
    },
  };
  return { fleet, auditRecords };
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

async function call(routes, method, pathname, body, search) {
  const req = makeReq(method, body);
  const res = makeRes();
  await routes.handle(req, res, pathname, new URLSearchParams(search || ""));
  return res;
}

describe("cortex memory routes (read-only, gbrain-backed)", () => {
  describe("GET /api/fleet/cortex/memory (list + search)", () => {
    it("lists gbrain pages as { items, total }", async () => {
      const { fleet } = makeFleet({
        cortex: {
          listMemory: async () => ({
            items: [{ id: "a", title: "Alpha", type: "note", updatedAt: "Thu Jun 11" }],
            total: 1,
          }),
        },
      });
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "GET", "/api/fleet/cortex/memory");
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.total, 1);
      assert.deepStrictEqual(res.body.items[0], {
        id: "a",
        title: "Alpha",
        type: "note",
        updatedAt: "Thu Jun 11",
      });
    });

    it("routes to searchMemory when a query is present", async () => {
      const seen = [];
      const { fleet } = makeFleet({
        cortex: {
          searchMemory: async (query, opts) => {
            seen.push({ query, opts });
            return { items: [], total: 0 };
          },
        },
      });
      const routes = createFleetRoutes({ fleet });
      const res = await call(
        routes,
        "GET",
        "/api/fleet/cortex/memory",
        undefined,
        "query=alpha&limit=5",
      );
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(seen, [{ query: "alpha", opts: { limit: 5 } }]);
    });

    it("maps adapter { error } to 503", async () => {
      const { fleet } = makeFleet({
        cortex: { listMemory: async () => ({ error: "gbrain list failed: ENOENT" }) },
      });
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "GET", "/api/fleet/cortex/memory");
      assert.strictEqual(res.statusCode, 503);
      assert.match(res.body.error, /gbrain list failed/);
    });
  });

  describe("GET /api/fleet/cortex/memory/:id", () => {
    it("returns the gbrain page content { id, content }", async () => {
      const { fleet } = makeFleet({
        cortex: { getMemory: async (id) => ({ id, content: "# Page\nbody" }) },
      });
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "GET", "/api/fleet/cortex/memory/projects%2Falpha");
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.body, { id: "projects/alpha", content: "# Page\nbody" });
    });

    it("maps not-found to 404", async () => {
      const { fleet } = makeFleet({
        cortex: { getMemory: async () => ({ error: "gbrain returned no content for page: nope" }) },
      });
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "GET", "/api/fleet/cortex/memory/nope");
      // "no content for page" doesn't match /not found/, so it maps to 503;
      // a genuine "not found" message maps to 404.
      assert.strictEqual(res.statusCode, 503);

      const nf = makeFleet({
        cortex: { getMemory: async () => ({ error: "memory not found: nope" }) },
      });
      const res2 = await call(createFleetRoutes({ fleet: nf.fleet }), "GET", "/api/fleet/cortex/memory/nope");
      assert.strictEqual(res2.statusCode, 404);
    });
  });

  describe("GET /api/fleet/cortex/gauges", () => {
    it("returns the gauge list", async () => {
      const { fleet } = makeFleet({
        cortex: { getGauges: () => [{ source: "lean-ctx", available: true }] },
      });
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "GET", "/api/fleet/cortex/gauges");
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.gauges.length, 1);
      assert.strictEqual(res.body.gauges[0].source, "lean-ctx");
    });
  });

  describe("removed endpoints are gone (read-only contract)", () => {
    it("404s POST /memory (store removed)", async () => {
      const { fleet, auditRecords } = makeFleet();
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "POST", "/api/fleet/cortex/memory", { text: "x" });
      assert.strictEqual(res.statusCode, 404);
      assert.strictEqual(auditRecords.length, 0);
    });

    it("404s PATCH /memory/:id (update removed)", async () => {
      const { fleet, auditRecords } = makeFleet();
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "PATCH", "/api/fleet/cortex/memory/m-1", { text: "x" });
      assert.strictEqual(res.statusCode, 404);
      assert.strictEqual(auditRecords.length, 0);
    });

    it("404s DELETE /memory/:id (delete removed)", async () => {
      const { fleet, auditRecords } = makeFleet();
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "DELETE", "/api/fleet/cortex/memory/m-1");
      assert.strictEqual(res.statusCode, 404);
      assert.strictEqual(auditRecords.length, 0);
    });

    it("404s GET /graph (knowledge-graph viz removed)", async () => {
      const { fleet } = makeFleet();
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "GET", "/api/fleet/cortex/graph");
      assert.strictEqual(res.statusCode, 404);
    });
  });

  it("returns 404 for unsupported methods on /memory/:id", async () => {
    const { fleet } = makeFleet();
    const routes = createFleetRoutes({ fleet });
    const res = await call(routes, "PUT", "/api/fleet/cortex/memory/m-1", {});
    assert.strictEqual(res.statusCode, 404);
  });
});
