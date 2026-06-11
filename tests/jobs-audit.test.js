/**
 * Unit tests for the audit hooks in src/jobs.js — the mutating jobs routes
 * (cache clear, run, pause, resume, skip, kill) record entries through the
 * injected audit recorder (setAuditRecorder). Uses the _resetForTesting api
 * injection hook so no jobs library or HTTP server is needed.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { handleJobsRequest, setAuditRecorder, _resetForTesting } = require("../src/jobs");

const USER = "tester@example.com";

function makeFakeApi() {
  const calls = [];
  return {
    calls,
    clearCache: () => calls.push(["clearCache"]),
    runJob: async (id) => {
      calls.push(["runJob", id]);
      return { success: true, jobId: id };
    },
    pauseJob: async (id, meta) => {
      calls.push(["pauseJob", id, meta]);
      return { success: true };
    },
    resumeJob: async (id) => {
      calls.push(["resumeJob", id]);
      return { success: true };
    },
    skipJob: async (id) => {
      calls.push(["skipJob", id]);
      return { success: true };
    },
    killJob: async (id) => {
      calls.push(["killJob", id]);
      return { success: true };
    },
  };
}

function makeReq({ method = "POST", user = USER } = {}) {
  const listeners = {};
  return {
    method,
    headers: user ? { "tailscale-user-login": user } : {},
    socket: { remoteAddress: "127.0.0.1" },
    on(event, cb) {
      listeners[event] = cb;
      // No body for these routes — fire "end" immediately when registered.
      if (event === "end") process.nextTick(cb);
    },
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

async function callRoute(pathname, { user = USER, method = "POST" } = {}) {
  const req = makeReq({ method, user });
  const res = makeRes();
  await handleJobsRequest(req, res, pathname, new URLSearchParams(""), method);
  return res;
}

describe("jobs audit hooks", () => {
  let api;
  let audits;

  beforeEach(() => {
    api = makeFakeApi();
    audits = [];
    _resetForTesting({ api });
    setAuditRecorder((entry) => audits.push(entry));
  });

  afterEach(() => {
    _resetForTesting();
  });

  it("POST /api/jobs/cache/clear records cache.clear with the actor", async () => {
    const res = await callRoute("/api/jobs/cache/clear");
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(audits.length, 1);
    assert.strictEqual(audits[0].action, "cache.clear");
    assert.strictEqual(audits[0].user, USER);
    assert.strictEqual(audits[0].target, "jobs");
  });

  it("POST /api/jobs/:id/run records job.run with the job id", async () => {
    const res = await callRoute("/api/jobs/nightly-sync/run");
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(audits.length, 1);
    assert.strictEqual(audits[0].action, "job.run");
    assert.strictEqual(audits[0].target, "nightly-sync");
    assert.deepStrictEqual(audits[0].detail, { success: true });
  });

  for (const op of ["pause", "resume", "skip", "kill"]) {
    it(`POST /api/jobs/:id/${op} records job.update {op:"${op}"}`, async () => {
      const res = await callRoute(`/api/jobs/j1/${op}`);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(audits.length, 1);
      assert.strictEqual(audits[0].action, "job.update");
      assert.strictEqual(audits[0].user, USER);
      assert.strictEqual(audits[0].target, "j1");
      assert.deepStrictEqual(audits[0].detail, { op });
    });
  }

  it("falls back to anonymous when the identity header is absent", async () => {
    const res = await callRoute("/api/jobs/cache/clear", { user: null });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(audits[0].user, "anonymous");
  });

  it("mutations still succeed when the audit recorder throws", async () => {
    setAuditRecorder(() => {
      throw new Error("audit disk full");
    });
    const res = await callRoute("/api/jobs/j1/run");
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.deepStrictEqual(api.calls, [["runJob", "j1"]], "the job must still run");
  });

  it("mutations still succeed when no recorder is injected", async () => {
    _resetForTesting({ api });
    const res = await callRoute("/api/jobs/cache/clear");
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
  });
});
