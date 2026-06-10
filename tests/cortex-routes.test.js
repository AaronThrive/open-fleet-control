/**
 * Unit tests for the cortex memory routes in src/fleet-routes.js:
 * GET/PATCH/DELETE /api/fleet/cortex/memory/:id. Uses a mocked fleet
 * runtime (no HTTP server, no CLI) and fake req/res objects, covering
 * dispatch, validation, audit records, rate limiting, and the adapter
 * { error } → HTTP status mapping (404 / 400 / 503).
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
      searchMemory: async () => ({ results: [] }),
      listMemory: async () => ({ items: [] }),
      getMemory: async () => ({ item: { id: "m-1", text: "hello" } }),
      storeMemory: async () => ({ ok: true, id: "m-new" }),
      updateMemory: async () => ({ ok: true, id: "m-1" }),
      deleteMemory: async () => ({ ok: true, id: "m-1" }),
      getGraph: async () => ({ nodes: [], edges: [] }),
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

async function call(routes, method, pathname, body) {
  const req = makeReq(method, body);
  const res = makeRes();
  await routes.handle(req, res, pathname, new URLSearchParams());
  return res;
}

describe("cortex memory routes", () => {
  describe("PATCH /api/fleet/cortex/memory/:id", () => {
    it("forwards editable fields, audits memory.write {op:update}, returns 200", async () => {
      const updates = [];
      const { fleet, auditRecords } = makeFleet({
        cortex: {
          updateMemory: async (id, changes) => {
            updates.push({ id, changes });
            return { ok: true, id, item: { id, text: changes.text } };
          },
        },
      });
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "PATCH", "/api/fleet/cortex/memory/m-1", {
        text: "edited",
        importance: 0.9,
        ignored: "field",
      });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.success, true);
      assert.deepStrictEqual(updates, [
        { id: "m-1", changes: { text: "edited", importance: 0.9 } },
      ]);

      assert.strictEqual(auditRecords.length, 1);
      assert.strictEqual(auditRecords[0].action, "memory.write");
      assert.strictEqual(auditRecords[0].target, "m-1");
      assert.deepStrictEqual(auditRecords[0].detail, {
        op: "update",
        fields: ["text", "importance"],
      });
    });

    it("decodes URL-encoded memory ids", async () => {
      const seen = [];
      const { fleet } = makeFleet({
        cortex: {
          updateMemory: async (id) => {
            seen.push(id);
            return { ok: true, id };
          },
        },
      });
      const routes = createFleetRoutes({ fleet });
      const encoded = encodeURIComponent("memory-test:global:20260607T205517Z");
      const res = await call(routes, "PATCH", `/api/fleet/cortex/memory/${encoded}`, {
        text: "x",
      });
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(seen, ["memory-test:global:20260607T205517Z"]);
    });

    it("rejects bodies with no editable fields with 400 before calling the adapter", async () => {
      let called = false;
      const { fleet, auditRecords } = makeFleet({
        cortex: {
          updateMemory: async () => {
            called = true;
            return { ok: true };
          },
        },
      });
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "PATCH", "/api/fleet/cortex/memory/m-1", { junk: true });
      assert.strictEqual(res.statusCode, 400);
      assert.match(res.body.error, /at least one of/i);
      assert.strictEqual(called, false);
      assert.strictEqual(auditRecords.length, 0);
    });

    it("maps adapter errors to 404 / 400 / 503 and skips the audit record", async () => {
      const cases = [
        { error: "memory not found: m-1", status: 404 },
        { error: "memory importance must be a number between 0 and 1", status: 400 },
        { error: "memory-pro delete failed: spawn openclaw ENOENT", status: 503 },
      ];
      for (const { error, status } of cases) {
        const { fleet, auditRecords } = makeFleet({
          cortex: { updateMemory: async () => ({ error }) },
        });
        const routes = createFleetRoutes({ fleet });
        const res = await call(routes, "PATCH", "/api/fleet/cortex/memory/m-1", { text: "x" });
        assert.strictEqual(res.statusCode, status, `expected ${status} for "${error}"`);
        assert.strictEqual(res.body.error, error);
        assert.strictEqual(auditRecords.length, 0);
      }
    });

    it("returns 429 with retryAfterMs when rate limited", async () => {
      const { fleet } = makeFleet({ allowed: false });
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "PATCH", "/api/fleet/cortex/memory/m-1", { text: "x" });
      assert.strictEqual(res.statusCode, 429);
      assert.strictEqual(res.body.retryAfterMs, 1234);
    });
  });

  describe("DELETE /api/fleet/cortex/memory/:id", () => {
    it("deletes, audits memory.write {op:delete}, returns 200", async () => {
      const deleted = [];
      const { fleet, auditRecords } = makeFleet({
        cortex: {
          deleteMemory: async (id) => {
            deleted.push(id);
            return { ok: true, id };
          },
        },
      });
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "DELETE", "/api/fleet/cortex/memory/m-1");

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.success, true);
      assert.deepStrictEqual(deleted, ["m-1"]);
      assert.strictEqual(auditRecords[0].action, "memory.write");
      assert.strictEqual(auditRecords[0].target, "m-1");
      assert.deepStrictEqual(auditRecords[0].detail, { op: "delete" });
    });

    it("maps not-found to 404 and adapter failures to 503", async () => {
      for (const { error, status } of [
        { error: "memory not found: nope", status: 404 },
        { error: "memory-pro delete failed: timeout", status: 503 },
      ]) {
        const { fleet, auditRecords } = makeFleet({
          cortex: { deleteMemory: async () => ({ error }) },
        });
        const routes = createFleetRoutes({ fleet });
        const res = await call(routes, "DELETE", "/api/fleet/cortex/memory/nope");
        assert.strictEqual(res.statusCode, status);
        assert.strictEqual(auditRecords.length, 0);
      }
    });

    it("returns 429 when rate limited", async () => {
      const { fleet } = makeFleet({ allowed: false });
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "DELETE", "/api/fleet/cortex/memory/m-1");
      assert.strictEqual(res.statusCode, 429);
    });
  });

  describe("GET /api/fleet/cortex/memory/:id", () => {
    it("returns the memory item", async () => {
      const { fleet } = makeFleet();
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "GET", "/api/fleet/cortex/memory/m-1");
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.body.item, { id: "m-1", text: "hello" });
    });

    it("maps not-found to 404", async () => {
      const { fleet } = makeFleet({
        cortex: { getMemory: async () => ({ error: "memory not found: nope" }) },
      });
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "GET", "/api/fleet/cortex/memory/nope");
      assert.strictEqual(res.statusCode, 404);
    });
  });

  describe("POST /api/fleet/cortex/memory (audit detail)", () => {
    it("audits memory.write {op:store} with the new id as target", async () => {
      const { fleet, auditRecords } = makeFleet();
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "POST", "/api/fleet/cortex/memory", { text: "hello" });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(auditRecords[0].action, "memory.write");
      assert.strictEqual(auditRecords[0].target, "m-new");
      assert.strictEqual(auditRecords[0].detail.op, "store");
      assert.strictEqual(typeof auditRecords[0].detail.bytes, "number");
    });
  });

  it("returns 404 for unsupported methods on /memory/:id", async () => {
    const { fleet } = makeFleet();
    const routes = createFleetRoutes({ fleet });
    const res = await call(routes, "PUT", "/api/fleet/cortex/memory/m-1", {});
    assert.strictEqual(res.statusCode, 404);
  });
});
