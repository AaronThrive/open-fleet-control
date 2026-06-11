/**
 * Unit tests for GET /api/fleet/alerts/analytics (src/fleet-routes.js).
 *
 * Drives createFleetRoutes() directly with a stub fleet runtime and a fake
 * req/res pair — no server spawn, no bundle dependency (the spawned-bundle
 * integration suite in fleet-routes.test.js only covers routes that exist
 * in the committed lib/server.js build).
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createFleetRoutes } = require("../src/fleet-routes");
const { createAlerts } = require("../src/alerts");

function makeRes() {
  const res = { statusCode: null, headers: null, body: null };
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers;
  };
  res.end = (payload) => {
    res.body = payload ? JSON.parse(payload) : null;
  };
  return res;
}

function makeReq(method = "GET") {
  return { method, headers: {}, socket: { remoteAddress: "127.0.0.1" } };
}

/** Minimal fleet runtime stub: only what the alerts routes touch. */
function makeFleet() {
  const alerts = createAlerts({
    config: { enabled: true, rules: {}, sinks: { webhooks: [] } },
    fetchFn: async () => ({ ok: true, status: 200 }),
  });
  return {
    alerts,
    rateLimiter: { check: () => ({ allowed: true }) },
    audit: { record: () => {}, query: () => [] },
  };
}

async function get(routes, urlPath) {
  const url = new URL(`http://localhost${urlPath}`);
  const res = makeRes();
  await routes.handle(makeReq(), res, url.pathname, url.searchParams);
  return res;
}

describe("GET /api/fleet/alerts/analytics", () => {
  it("returns the rollup shape with default 14-day window", async () => {
    const fleet = makeFleet();
    await fleet.alerts.fire({ type: "nodeOffline", severity: "critical", node: "hermes-1" });
    const routes = createFleetRoutes({ fleet });

    const res = await get(routes, "/api/fleet/alerts/analytics");
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.days, 14);
    assert.strictEqual(res.body.perDay.length, 14);
    assert.ok(Array.isArray(res.body.flaps));
    assert.ok(Array.isArray(res.body.topNodes));
    assert.ok(Array.isArray(res.body.topRules));
    // No logsDir on the stub engine → analytics is the zeroed shape; the
    // ring buffer is intentionally NOT the analytics source.
    assert.strictEqual(res.body.total, 0);
  });

  it("honors and validates the days param", async () => {
    const routes = createFleetRoutes({ fleet: makeFleet() });

    const week = await get(routes, "/api/fleet/alerts/analytics?days=7");
    assert.strictEqual(week.statusCode, 200);
    assert.strictEqual(week.body.perDay.length, 7);

    for (const bad of ["0", "200", "-1"]) {
      const res = await get(routes, `/api/fleet/alerts/analytics?days=${bad}`);
      assert.strictEqual(res.statusCode, 400, `days=${bad} should 400`);
      assert.match(res.body.error, /days/);
    }
  });

  it("rejects non-GET methods with the 404 envelope (read-only route)", async () => {
    const routes = createFleetRoutes({ fleet: makeFleet() });
    const url = new URL("http://localhost/api/fleet/alerts/analytics");
    const res = makeRes();
    await routes.handle(makeReq("POST"), res, url.pathname, url.searchParams);
    assert.strictEqual(res.statusCode, 404);
    assert.match(res.body.error, /Unknown fleet route/);
  });
});
