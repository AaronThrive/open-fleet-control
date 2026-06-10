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
});
