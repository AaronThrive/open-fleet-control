/**
 * Unit tests for the v2.1 audit-coverage additions in src/fleet-routes.js:
 *   PATCH /api/fleet/settings            → settings.update (sections only)
 *   POST  /api/fleet/settings/test-alert → alert.test
 *   POST  /api/fleet/chat/publish        → chat.publish
 *
 * Mirrors the dispatch-routes pattern: mocked fleet runtime + fake req/res —
 * no HTTP server. Each route is also exercised with an audit recorder that
 * THROWS, proving the best-effort contract (a failed audit write never fails
 * the mutation).
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { createFleetRoutes } = require("../src/fleet-routes");

const USER = "tester@example.com";

function makeFleet({ auditThrows = false } = {}) {
  const auditRecords = [];
  const fired = [];
  const published = [];
  const fleet = {
    rateLimiter: { check: () => ({ allowed: true }) },
    audit: {
      record: (entry) => {
        if (auditThrows) throw new Error("audit disk full");
        auditRecords.push(entry);
      },
    },
    chat: {
      publish: (msg) => {
        const record = { id: "msg_1", sender: msg.sender, receiver: msg.receiver, ts: 1 };
        published.push(record);
        return record;
      },
    },
    fireAlert: async (event) => {
      fired.push(event);
      return { fired: true };
    },
  };
  return { fleet, auditRecords, fired, published };
}

function makeSettings() {
  const updates = [];
  return {
    updates,
    service: {
      get: () => ({}),
      update: (patch, actor) => {
        updates.push({ patch, actor });
        return { applied: { ok: true }, restartRequired: ["mesh.intervalMs"] };
      },
    },
  };
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

async function call(routes, method, pathname, body) {
  const req = makeReq(method, body);
  const res = makeRes();
  await routes.handle(req, res, pathname, new URLSearchParams(""));
  return res;
}

describe("audit coverage: settings PATCH", () => {
  it("records settings.update with the changed top-level sections (never values)", async () => {
    const { fleet, auditRecords } = makeFleet();
    const { service, updates } = makeSettings();
    const routes = createFleetRoutes({ fleet, settings: service });

    const patch = {
      alerts: { sinks: { ntfy: { topic: "secret-topic" } } },
      budgets: { daily: 12 },
    };
    const res = await call(routes, "PATCH", "/api/fleet/settings", patch);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].actor, USER);

    assert.strictEqual(auditRecords.length, 1);
    const entry = auditRecords[0];
    assert.strictEqual(entry.action, "settings.update");
    assert.strictEqual(entry.user, USER);
    assert.deepStrictEqual(entry.detail.sections, ["alerts", "budgets"]);
    assert.deepStrictEqual(entry.detail.restartRequired, ["mesh.intervalMs"]);
    // The audit detail must never carry setting VALUES (potential secrets).
    assert.ok(!JSON.stringify(entry.detail).includes("secret-topic"));
  });

  it("still succeeds when the audit write throws", async () => {
    const { fleet } = makeFleet({ auditThrows: true });
    const { service, updates } = makeSettings();
    const routes = createFleetRoutes({ fleet, settings: service });

    const res = await call(routes, "PATCH", "/api/fleet/settings", { alerts: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(updates.length, 1, "the mutation must still be applied");
  });
});

describe("audit coverage: settings test-alert", () => {
  it("records alert.test with the actor and fired flag", async () => {
    const { fleet, auditRecords, fired } = makeFleet();
    const routes = createFleetRoutes({ fleet, settings: makeSettings().service });

    const res = await call(routes, "POST", "/api/fleet/settings/test-alert", { message: "hi" });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fired.length, 1);

    assert.strictEqual(auditRecords.length, 1);
    assert.strictEqual(auditRecords[0].action, "alert.test");
    assert.strictEqual(auditRecords[0].user, USER);
    assert.strictEqual(auditRecords[0].detail.fired, true);
  });

  it("still succeeds when the audit write throws", async () => {
    const { fleet, fired } = makeFleet({ auditThrows: true });
    const routes = createFleetRoutes({ fleet, settings: makeSettings().service });

    const res = await call(routes, "POST", "/api/fleet/settings/test-alert", {});
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(fired.length, 1);
  });
});

describe("audit coverage: chat publish", () => {
  const BODY = { sender: "agent-a", receiver: "agent-b", payload: "hello" };

  it("records chat.publish with the HTTP actor (not the message sender)", async () => {
    const { fleet, auditRecords, published } = makeFleet();
    const routes = createFleetRoutes({ fleet });

    const res = await call(routes, "POST", "/api/fleet/chat/publish", BODY);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(published.length, 1);

    assert.strictEqual(auditRecords.length, 1);
    const entry = auditRecords[0];
    assert.strictEqual(entry.action, "chat.publish");
    assert.strictEqual(entry.user, USER);
    assert.strictEqual(entry.target, "msg_1");
    assert.deepStrictEqual(entry.detail, { sender: "agent-a", receiver: "agent-b" });
  });

  it("still succeeds when the audit write throws", async () => {
    const { fleet, published } = makeFleet({ auditThrows: true });
    const routes = createFleetRoutes({ fleet });

    const res = await call(routes, "POST", "/api/fleet/chat/publish", BODY);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(published.length, 1, "the message must still be published");
  });
});
