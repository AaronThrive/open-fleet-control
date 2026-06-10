const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");

// We import the module to test its exports and pure functions.
// The jobs module relies on dynamic ESM import of external jobs API,
// so we focus on testing what's available without that dependency.
const { handleJobsRequest, isJobsRoute, _resetForTesting } = require("../src/jobs");

describe("jobs module", () => {
  describe("exports", () => {
    it("exports handleJobsRequest function", () => {
      assert.strictEqual(typeof handleJobsRequest, "function");
    });

    it("exports isJobsRoute function", () => {
      assert.strictEqual(typeof isJobsRoute, "function");
    });
  });

  describe("isJobsRoute()", () => {
    it("returns true for /api/jobs", () => {
      assert.strictEqual(isJobsRoute("/api/jobs"), true);
    });

    it("returns true for /api/jobs/some-job", () => {
      assert.strictEqual(isJobsRoute("/api/jobs/some-job"), true);
    });

    it("returns true for /api/jobs/some-job/history", () => {
      assert.strictEqual(isJobsRoute("/api/jobs/some-job/history"), true);
    });

    it("returns true for /api/jobs/scheduler/status", () => {
      assert.strictEqual(isJobsRoute("/api/jobs/scheduler/status"), true);
    });

    it("returns true for /api/jobs/stats", () => {
      assert.strictEqual(isJobsRoute("/api/jobs/stats"), true);
    });

    it("returns false for /api/health", () => {
      assert.strictEqual(isJobsRoute("/api/health"), false);
    });

    it("returns false for /api/sessions", () => {
      assert.strictEqual(isJobsRoute("/api/sessions"), false);
    });

    it("returns false for /api/job (no trailing s)", () => {
      assert.strictEqual(isJobsRoute("/api/job"), false);
    });

    it("returns false for empty string", () => {
      assert.strictEqual(isJobsRoute(""), false);
    });

    it("returns false for /jobs (no /api prefix)", () => {
      assert.strictEqual(isJobsRoute("/jobs"), false);
    });
  });

  describe("handleJobsRequest()", () => {
    afterEach(() => {
      // Reset API state after each test
      _resetForTesting();
    });

    it("returns 200 { available: false } when jobs API is not available", async () => {
      // Force API to be unavailable for this test
      _resetForTesting({ forceUnavailable: true });

      let statusCode = null;
      let body = null;

      const mockRes = {
        writeHead(code, _headers) {
          statusCode = code;
        },
        end(data) {
          body = data;
        },
      };

      const mockReq = {};
      const query = new URLSearchParams();

      await handleJobsRequest(mockReq, mockRes, "/api/jobs", query, "GET");

      assert.strictEqual(statusCode, 200);
      const parsed = JSON.parse(body);
      assert.strictEqual(parsed.available, false);
      assert.ok(parsed.reason, "should include a reason");
      assert.ok(
        parsed.reason.includes("not installed"),
        `Reason should mention not installed: ${parsed.reason}`,
      );
      assert.deepStrictEqual(parsed.jobs, [], "should include an empty jobs array");
    });

    it("degrades gracefully for sub-routes when jobs API is not available", async () => {
      _resetForTesting({ forceUnavailable: true });

      let statusCode = null;
      let body = null;

      const mockRes = {
        writeHead(code, _headers) {
          statusCode = code;
        },
        end(data) {
          body = data;
        },
      };

      await handleJobsRequest({}, mockRes, "/api/jobs/stats", new URLSearchParams(), "GET");

      assert.strictEqual(statusCode, 200);
      const parsed = JSON.parse(body);
      assert.strictEqual(parsed.available, false);
    });
  });

  describe("cron fallback (jobs library absent)", () => {
    const { setCronFallback } = require("../src/jobs");

    const CRON_JOBS = [
      {
        id: "job-ok",
        name: "Nightly sync",
        schedule: "0 2 * * *",
        scheduleHuman: "Daily at 2am",
        enabled: true,
        nextRun: "14h",
        lastStatus: "ok",
        agent: "main",
        node: "oc-bot-1",
        source: "openclaw",
      },
      {
        id: "job-err",
        name: "Flaky job",
        schedule: "*/5 * * * *",
        scheduleHuman: "Every 5 minutes",
        enabled: false,
        nextRun: null,
        lastStatus: "error",
        agent: "main",
        node: "oc-bot-1",
        source: "hermes",
      },
    ];

    function makeRes() {
      const out = { statusCode: null, body: null };
      out.res = {
        writeHead(code) {
          out.statusCode = code;
        },
        end(data) {
          out.body = data;
        },
      };
      return out;
    }

    afterEach(() => {
      _resetForTesting();
    });

    it("serves cron jobs as available read-only jobs on GET /api/jobs", async () => {
      _resetForTesting({ forceUnavailable: true });
      setCronFallback(() => CRON_JOBS);

      const out = makeRes();
      await handleJobsRequest({}, out.res, "/api/jobs", new URLSearchParams(), "GET");

      assert.strictEqual(out.statusCode, 200);
      const parsed = JSON.parse(out.body);
      assert.strictEqual(parsed.available, true);
      assert.strictEqual(parsed.source, "cron");
      assert.strictEqual(parsed.readOnly, true);
      assert.strictEqual(parsed.jobs.length, 2);

      const ok = parsed.jobs.find((j) => j.id === "job-ok");
      assert.strictEqual(ok.name, "Nightly sync");
      assert.strictEqual(ok.paused, false);
      assert.strictEqual(ok.schedule, "0 2 * * *");
      assert.strictEqual(ok.nextRunRelative, "14h");
      assert.strictEqual(ok.lane, "openclaw");
      assert.strictEqual(ok.readOnly, true);
      assert.ok(ok.tags.includes("openclaw"));

      const err = parsed.jobs.find((j) => j.id === "job-err");
      assert.strictEqual(err.paused, true, "disabled cron job maps to paused");
      assert.strictEqual(err.stats.streak.type, "failed", "error lastStatus surfaces as failing");
      assert.ok(err.stats.streak.count >= 2);
    });

    it("serves a single cron job on GET /api/jobs/:id and 404s unknown ids", async () => {
      _resetForTesting({ forceUnavailable: true });
      setCronFallback(() => CRON_JOBS);

      const found = makeRes();
      await handleJobsRequest({}, found.res, "/api/jobs/job-ok", new URLSearchParams(), "GET");
      assert.strictEqual(found.statusCode, 200);
      assert.strictEqual(JSON.parse(found.body).job.id, "job-ok");

      const missing = makeRes();
      await handleJobsRequest({}, missing.res, "/api/jobs/nope", new URLSearchParams(), "GET");
      assert.strictEqual(missing.statusCode, 404);
    });

    it("rejects mutating routes with 405 when backed by cron", async () => {
      _resetForTesting({ forceUnavailable: true });
      setCronFallback(() => CRON_JOBS);

      for (const route of [
        ["/api/jobs/job-ok/run", "POST"],
        ["/api/jobs/job-ok/pause", "POST"],
        ["/api/jobs/job-ok/resume", "POST"],
        ["/api/jobs/job-ok/skip", "POST"],
        ["/api/jobs/job-ok/kill", "POST"],
        ["/api/jobs/cache/clear", "POST"],
      ]) {
        const out = makeRes();
        await handleJobsRequest({}, out.res, route[0], new URLSearchParams(), route[1]);
        assert.strictEqual(out.statusCode, 405, `${route[0]} should be 405`);
        assert.ok(JSON.parse(out.body).error, `${route[0]} should carry an error message`);
      }
    });

    it("returns empty history and basic stats for cron-backed jobs", async () => {
      _resetForTesting({ forceUnavailable: true });
      setCronFallback(() => CRON_JOBS);

      const history = makeRes();
      await handleJobsRequest(
        {},
        history.res,
        "/api/jobs/job-ok/history",
        new URLSearchParams(),
        "GET",
      );
      assert.strictEqual(history.statusCode, 200);
      assert.deepStrictEqual(JSON.parse(history.body).history, []);

      const stats = makeRes();
      await handleJobsRequest({}, stats.res, "/api/jobs/stats", new URLSearchParams(), "GET");
      assert.strictEqual(stats.statusCode, 200);
      const parsedStats = JSON.parse(stats.body);
      assert.strictEqual(parsedStats.available, true);
      assert.strictEqual(parsedStats.stats.totalJobs, 2);
      assert.strictEqual(parsedStats.stats.activeJobs, 1);
    });

    it("falls back to available:false when the cron source has no jobs", async () => {
      _resetForTesting({ forceUnavailable: true });
      setCronFallback(() => []);

      const out = makeRes();
      await handleJobsRequest({}, out.res, "/api/jobs", new URLSearchParams(), "GET");
      assert.strictEqual(out.statusCode, 200);
      assert.strictEqual(JSON.parse(out.body).available, false);
    });

    it("falls back to available:false when the cron source throws", async () => {
      _resetForTesting({ forceUnavailable: true });
      setCronFallback(() => {
        throw new Error("cron exploded");
      });

      const out = makeRes();
      await handleJobsRequest({}, out.res, "/api/jobs", new URLSearchParams(), "GET");
      assert.strictEqual(out.statusCode, 200);
      assert.strictEqual(JSON.parse(out.body).available, false);
    });
  });
});
