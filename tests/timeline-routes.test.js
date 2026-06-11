/**
 * Unit tests for src/timeline-routes.js — GET /api/fleet/agents/:id/timeline.
 * Pure DI: a fake recorder + mock req/res. No server is booted.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");
const { createTimelineRoutes, isTimelineRoute } = require("../src/timeline-routes");

function makeReq(method = "GET") {
  return { method, headers: {}, socket: { remoteAddress: "127.0.0.1" } };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    writeHead(code) {
      this.statusCode = code;
    },
    end(data) {
      this.body = data ? JSON.parse(data) : null;
    },
  };
}

function makeHarness(impl) {
  const calls = [];
  const recorder = {
    getTimeline(agentId, opts) {
      calls.push({ agentId, opts });
      if (impl) return impl(agentId, opts);
      return { agent: { id: agentId }, events: [], summary: { total: 0 }, page: {} };
    },
  };
  return { routes: createTimelineRoutes({ recorder }), calls };
}

describe("isTimelineRoute()", () => {
  it("matches only the timeline route", () => {
    assert.strictEqual(isTimelineRoute("/api/fleet/agents/main/timeline"), true);
    assert.strictEqual(isTimelineRoute("/api/fleet/agents/ghl_monitor/timeline"), true);
    assert.strictEqual(isTimelineRoute("/api/fleet/agents/main"), false);
    assert.strictEqual(isTimelineRoute("/api/fleet/agents"), false);
    assert.strictEqual(isTimelineRoute("/api/agents/main/timeline"), false);
    assert.strictEqual(isTimelineRoute("/api/fleet/agents/a/b/timeline"), false);
    assert.strictEqual(isTimelineRoute("/api/fleet/agents//timeline"), false);
  });
});

describe("createTimelineRoutes()", () => {
  let harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  it("requires a recorder", () => {
    assert.throws(() => createTimelineRoutes({}), /recorder/);
  });

  it("serves the timeline and decodes the agent id", async () => {
    const res = makeRes();
    await harness.routes.handle(
      makeReq(),
      res,
      "/api/fleet/agents/ghl%5Fmonitor/timeline",
      new URLSearchParams(),
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.agent.id, "ghl_monitor");
    assert.deepStrictEqual(harness.calls[0].opts, {});
  });

  it("passes since/until/types/limit through to the recorder", async () => {
    const res = makeRes();
    await harness.routes.handle(
      makeReq(),
      res,
      "/api/fleet/agents/main/timeline",
      new URLSearchParams("since=100&until=200&types=audit,cron.run&limit=50"),
    );
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(harness.calls[0].opts, {
      since: "100",
      until: "200",
      types: "audit,cron.run",
      limit: 50,
    });
  });

  it("rejects a non-integer limit with 400 before reaching the recorder", async () => {
    const res = makeRes();
    await harness.routes.handle(
      makeReq(),
      res,
      "/api/fleet/agents/main/timeline",
      new URLSearchParams("limit=abc"),
    );
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /limit/i);
    assert.strictEqual(harness.calls.length, 0);
  });

  it("maps recorder validation errors to their statusCode", async () => {
    const { routes } = makeHarness(() => {
      const err = new Error("Invalid agent id");
      err.statusCode = 400;
      throw err;
    });
    const res = makeRes();
    await routes.handle(makeReq(), res, "/api/fleet/agents/x/timeline", new URLSearchParams());
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, "Invalid agent id");
  });

  it("maps unexpected recorder errors to 500", async () => {
    const { routes } = makeHarness(() => {
      throw new Error("disk on fire");
    });
    const res = makeRes();
    await routes.handle(makeReq(), res, "/api/fleet/agents/x/timeline", new URLSearchParams());
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.body.error, "disk on fire");
  });

  it("rejects non-GET methods with 405", async () => {
    const res = makeRes();
    await harness.routes.handle(
      makeReq("POST"),
      res,
      "/api/fleet/agents/main/timeline",
      new URLSearchParams(),
    );
    assert.strictEqual(res.statusCode, 405);
    assert.strictEqual(harness.calls.length, 0);
  });

  it("rejects malformed URL encoding with 400", async () => {
    const res = makeRes();
    await harness.routes.handle(
      makeReq(),
      res,
      "/api/fleet/agents/%E0%A4%A/timeline",
      new URLSearchParams(),
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(harness.calls.length, 0);
  });
});
