/**
 * Unit tests for src/cron-routes.js — POST /api/cron/:id/{enable|disable|run}.
 *
 * Pure DI: a fake actions module, audit recorder and rate limiter; mock
 * req/res objects. No server is booted and no CLI is spawned.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");
const { createCronRoutes, isCronActionRoute } = require("../src/cron-routes");

function makeReq({ method = "POST", user, ip = "127.0.0.1" } = {}) {
  return {
    method,
    headers: user ? { "tailscale-user-login": user } : {},
    socket: { remoteAddress: ip },
  };
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

function makeHarness({ allowed = true, enabled = true, actionImpl } = {}) {
  const calls = { actions: [], audits: [], rateKeys: [] };
  const actions = {
    setJobEnabled: async (id, enabledFlag) => {
      calls.actions.push(["setJobEnabled", id, enabledFlag]);
      if (actionImpl) return actionImpl();
      return { id, enabled: enabledFlag };
    },
    runJobNow: async (id) => {
      calls.actions.push(["runJobNow", id]);
      if (actionImpl) return actionImpl();
      return { id, triggered: true };
    },
  };
  const audit = {
    record(entry) {
      calls.audits.push(entry);
    },
  };
  const rateLimiter = {
    check(key) {
      calls.rateKeys.push(key);
      return allowed ? { allowed: true } : { allowed: false, retryAfterMs: 1234 };
    },
  };
  const routes = createCronRoutes({ actions, audit, rateLimiter, enabled });
  return { routes, calls };
}

describe("isCronActionRoute()", () => {
  it("matches only the action routes", () => {
    assert.strictEqual(isCronActionRoute("/api/cron/job-1/enable"), true);
    assert.strictEqual(isCronActionRoute("/api/cron/job-1/disable"), true);
    assert.strictEqual(isCronActionRoute("/api/cron/job-1/run"), true);
    assert.strictEqual(isCronActionRoute("/api/cron"), false);
    assert.strictEqual(isCronActionRoute("/api/cron/job-1"), false);
    assert.strictEqual(isCronActionRoute("/api/cron/job-1/delete"), false);
    assert.strictEqual(isCronActionRoute("/api/cron/a/b/enable"), false);
  });
});

describe("createCronRoutes()", () => {
  let harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  it("requires actions, audit and rateLimiter", () => {
    assert.throws(() => createCronRoutes({}));
  });

  it("POST /api/cron/:id/enable enables the job and audits cron.update", async () => {
    const res = makeRes();
    await harness.routes.handle(
      makeReq({ user: "Alice@Example.com" }),
      res,
      "/api/cron/job-1/enable",
    );
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { success: true, id: "job-1", enabled: true });
    assert.deepStrictEqual(harness.calls.actions, [["setJobEnabled", "job-1", true]]);
    assert.strictEqual(harness.calls.audits.length, 1);
    assert.strictEqual(harness.calls.audits[0].action, "cron.update");
    assert.strictEqual(harness.calls.audits[0].user, "alice@example.com");
    assert.strictEqual(harness.calls.audits[0].target, "job-1");
    assert.deepStrictEqual(harness.calls.audits[0].detail, { enabled: true });
  });

  it("POST /api/cron/:id/disable disables the job", async () => {
    const res = makeRes();
    await harness.routes.handle(makeReq(), res, "/api/cron/job-1/disable");
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(harness.calls.actions, [["setJobEnabled", "job-1", false]]);
    assert.deepStrictEqual(harness.calls.audits[0].detail, { enabled: false });
    assert.strictEqual(harness.calls.audits[0].user, "anonymous");
  });

  it("POST /api/cron/:id/run triggers the job and audits cron.run", async () => {
    const res = makeRes();
    await harness.routes.handle(makeReq(), res, "/api/cron/job-1/run");
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { success: true, id: "job-1", triggered: true });
    assert.deepStrictEqual(harness.calls.actions, [["runJobNow", "job-1"]]);
    assert.strictEqual(harness.calls.audits[0].action, "cron.run");
  });

  it("decodes URL-encoded job ids", async () => {
    const res = makeRes();
    await harness.routes.handle(makeReq(), res, "/api/cron/job%20one/run");
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(harness.calls.actions, [["runJobNow", "job one"]]);
  });

  it("rejects malformed URL encoding with 400", async () => {
    const res = makeRes();
    await harness.routes.handle(makeReq(), res, "/api/cron/%zz/run");
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(harness.calls.actions.length, 0);
  });

  it("rejects non-POST methods with 405", async () => {
    const res = makeRes();
    await harness.routes.handle(makeReq({ method: "GET" }), res, "/api/cron/job-1/enable");
    assert.strictEqual(res.statusCode, 405);
    assert.strictEqual(harness.calls.actions.length, 0);
  });

  it("responds 503 when OpenClaw sources are disabled (economy mode)", async () => {
    const h = makeHarness({ enabled: false });
    const res = makeRes();
    await h.routes.handle(makeReq(), res, "/api/cron/job-1/enable");
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(h.calls.actions.length, 0);
  });

  it("rate-limits per user|ip and returns 429 with retryAfterMs", async () => {
    const h = makeHarness({ allowed: false });
    const res = makeRes();
    await h.routes.handle(makeReq({ user: "bob", ip: "10.0.0.9" }), res, "/api/cron/job-1/run");
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(res.body.retryAfterMs, 1234);
    assert.deepStrictEqual(h.calls.rateKeys, ["bob|10.0.0.9"]);
    assert.strictEqual(h.calls.actions.length, 0);
    assert.strictEqual(h.calls.audits.length, 0);
  });

  it("maps action errors to their statusCode and records no audit entry", async () => {
    const h = makeHarness({
      actionImpl: () => {
        const err = new Error("Cron job 'h-1' comes from a read-only source");
        err.statusCode = 403;
        throw err;
      },
    });
    const res = makeRes();
    await h.routes.handle(makeReq(), res, "/api/cron/h-1/disable");
    assert.strictEqual(res.statusCode, 403);
    assert.match(res.body.error, /read-only/);
    assert.strictEqual(h.calls.audits.length, 0);
  });

  it("maps errors without statusCode to 500", async () => {
    const h = makeHarness({
      actionImpl: () => {
        throw new Error("boom");
      },
    });
    const res = makeRes();
    await h.routes.handle(makeReq(), res, "/api/cron/job-1/run");
    assert.strictEqual(res.statusCode, 500);
  });

  it("an audit failure never fails the request", async () => {
    const calls = { actions: [] };
    const routes = createCronRoutes({
      actions: {
        setJobEnabled: async (id, enabled) => {
          calls.actions.push([id, enabled]);
          return { id, enabled };
        },
        runJobNow: async () => ({}),
      },
      audit: {
        record() {
          throw new Error("audit disk full");
        },
      },
      rateLimiter: { check: () => ({ allowed: true }) },
    });
    const res = makeRes();
    await routes.handle(makeReq(), res, "/api/cron/job-1/enable");
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(calls.actions, [["job-1", true]]);
  });
});

describe("audit action registration", () => {
  it("cron.update and cron.run are valid AUDIT_ACTIONS", () => {
    const { AUDIT_ACTIONS } = require("../src/audit");
    assert.ok(AUDIT_ACTIONS.includes("cron.update"));
    assert.ok(AUDIT_ACTIONS.includes("cron.run"));
  });
});
