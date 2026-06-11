const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  cronToHuman,
  getCronJobs,
  forceCliRefresh,
  _resetForTesting,
  _waitForCliRefreshForTesting,
} = require("../src/cron");

describe("cron module", () => {
  describe("cronToHuman()", () => {
    it("returns null for null input", () => {
      assert.strictEqual(cronToHuman(null), null);
    });

    it("returns null for dash", () => {
      assert.strictEqual(cronToHuman("—"), null);
    });

    it("returns null for too few parts", () => {
      assert.strictEqual(cronToHuman("* *"), null);
    });

    it("converts every-minute cron", () => {
      assert.strictEqual(cronToHuman("* * * * *"), "Every minute");
    });

    it("converts every-N-minutes cron", () => {
      assert.strictEqual(cronToHuman("*/5 * * * *"), "Every 5 minutes");
      assert.strictEqual(cronToHuman("*/15 * * * *"), "Every 15 minutes");
    });

    it("converts every-N-hours cron", () => {
      assert.strictEqual(cronToHuman("0 */2 * * *"), "Every 2 hours");
    });

    it("converts hourly at specific minute", () => {
      assert.strictEqual(cronToHuman("30 * * * *"), "Hourly at :30");
      assert.strictEqual(cronToHuman("0 * * * *"), "Hourly at :00");
    });

    it("converts daily at specific time", () => {
      assert.strictEqual(cronToHuman("0 9 * * *"), "Daily at 9am");
      assert.strictEqual(cronToHuman("30 14 * * *"), "Daily at 2:30pm");
      assert.strictEqual(cronToHuman("0 0 * * *"), "Daily at 12am");
      assert.strictEqual(cronToHuman("0 12 * * *"), "Daily at 12pm");
    });

    it("converts weekday cron", () => {
      assert.strictEqual(cronToHuman("0 9 * * 1-5"), "Weekdays at 9am");
      assert.strictEqual(cronToHuman("0 9 * * MON-FRI"), "Weekdays at 9am");
    });

    it("converts weekend cron", () => {
      assert.strictEqual(cronToHuman("0 10 * * 0,6"), "Weekends at 10am");
      assert.strictEqual(cronToHuman("0 10 * * 6,0"), "Weekends at 10am");
    });

    it("converts specific day of week", () => {
      const result = cronToHuman("0 8 * * 1");
      assert.strictEqual(result, "Monday at 8am");
    });

    it("converts specific day of month", () => {
      const result = cronToHuman("0 9 1 * *");
      assert.strictEqual(result, "1st of month at 9am");
    });

    it("handles ordinal suffixes correctly", () => {
      assert.ok(cronToHuman("0 9 2 * *").includes("2nd"));
      assert.ok(cronToHuman("0 9 3 * *").includes("3rd"));
      assert.ok(cronToHuman("0 9 4 * *").includes("4th"));
      assert.ok(cronToHuman("0 9 21 * *").includes("21st"));
      assert.ok(cronToHuman("0 9 22 * *").includes("22nd"));
      assert.ok(cronToHuman("0 9 23 * *").includes("23rd"));
    });

    it("returns original expression as fallback", () => {
      const expr = "* * * 6 *";
      const result = cronToHuman(expr);
      assert.strictEqual(typeof result, "string");
    });
  });

  describe("getCronJobs()", () => {
    let tmpDir;
    const NO_HERMES = path.join(os.tmpdir(), "nonexistent-hermes", "jobs.json");
    const hostname = os.hostname();

    const OPENCLAW_JOB = {
      id: "job-1",
      name: "Morning Briefing",
      enabled: true,
      agentId: "morning_briefing",
      schedule: { kind: "cron", expr: "0 6 * * 1-5", tz: "America/Los_Angeles" },
      state: {
        nextRunAtMs: Date.now() + 3600000,
        lastStatus: "ok",
        lastRunStatus: "ok",
      },
    };

    const HERMES_JOB = {
      id: "h-1",
      name: "ECC readiness check",
      enabled: true,
      schedule: { kind: "cron", expr: "0 8 * * *", display: "0 8 * * *" },
      schedule_display: "0 8 * * *",
      next_run_at: new Date(Date.now() + 7200000).toISOString(),
      last_status: "ok",
      profile: null,
    };

    function writeOpenClawFixture(jobs) {
      fs.mkdirSync(path.join(tmpDir, "cron"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "cron", "jobs.json"), JSON.stringify({ jobs }));
    }

    function writeHermesFixture(jobs) {
      const hermesPath = path.join(tmpDir, "hermes-cron.json");
      fs.writeFileSync(hermesPath, JSON.stringify({ jobs }));
      return hermesPath;
    }

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-test-"));
      _resetForTesting();
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      _resetForTesting();
    });

    it("maps file-source jobs with agent, node and source", () => {
      writeOpenClawFixture([OPENCLAW_JOB]);
      const jobs = getCronJobs(() => tmpDir, { hermesCronPath: NO_HERMES });

      assert.strictEqual(jobs.length, 1);
      const job = jobs[0];
      assert.strictEqual(job.id, "job-1");
      assert.strictEqual(job.name, "Morning Briefing");
      assert.strictEqual(job.schedule, "0 6 * * 1-5");
      assert.strictEqual(job.scheduleHuman, "Weekdays at 6am");
      assert.strictEqual(job.enabled, true);
      assert.strictEqual(job.lastStatus, "ok");
      assert.strictEqual(job.agent, "morning_briefing");
      assert.strictEqual(job.node, hostname);
      assert.strictEqual(job.source, "openclaw");
      assert.notStrictEqual(job.nextRun, "—");
    });

    it("uses the CLI source when the legacy file is absent (cached, non-blocking)", async () => {
      let cliCalls = 0;
      _resetForTesting({
        cliRunner: async () => {
          cliCalls += 1;
          return JSON.stringify({ jobs: [OPENCLAW_JOB] });
        },
      });

      // First call: cache cold → returns immediately (empty) and kicks off refresh
      const first = getCronJobs(() => tmpDir, { hermesCronPath: NO_HERMES });
      assert.deepStrictEqual(first, []);

      await _waitForCliRefreshForTesting();

      const second = getCronJobs(() => tmpDir, { hermesCronPath: NO_HERMES });
      assert.strictEqual(second.length, 1);
      assert.strictEqual(second[0].agent, "morning_briefing");
      assert.strictEqual(second[0].source, "openclaw");
      assert.strictEqual(second[0].node, hostname);

      // Within the TTL no additional CLI invocations happen
      getCronJobs(() => tmpDir, { hermesCronPath: NO_HERMES });
      assert.strictEqual(cliCalls, 1);
    });

    it("survives CLI failures and keeps serving (empty) data", async () => {
      _resetForTesting({
        cliRunner: async () => {
          throw new Error("openclaw not found");
        },
      });

      const first = getCronJobs(() => tmpDir, { hermesCronPath: NO_HERMES });
      assert.deepStrictEqual(first, []);
      await _waitForCliRefreshForTesting();
      const second = getCronJobs(() => tmpDir, { hermesCronPath: NO_HERMES });
      assert.deepStrictEqual(second, []);
    });

    it("merges Hermes jobs as a second source", () => {
      writeOpenClawFixture([OPENCLAW_JOB]);
      const hermesPath = writeHermesFixture([HERMES_JOB]);

      const jobs = getCronJobs(() => tmpDir, { hermesCronPath: hermesPath });
      assert.strictEqual(jobs.length, 2);

      const hermes = jobs.find((j) => j.source === "hermes");
      assert.ok(hermes, "hermes job should be present");
      assert.strictEqual(hermes.id, "h-1");
      assert.strictEqual(hermes.name, "ECC readiness check");
      assert.strictEqual(hermes.schedule, "0 8 * * *");
      assert.strictEqual(hermes.scheduleHuman, "Daily at 8am");
      assert.strictEqual(hermes.enabled, true);
      assert.strictEqual(hermes.lastStatus, "ok");
      assert.strictEqual(hermes.node, hostname);
      assert.notStrictEqual(hermes.nextRun, "—");
    });

    it("renders only OpenClaw jobs when the Hermes source is absent", () => {
      writeOpenClawFixture([OPENCLAW_JOB]);
      const jobs = getCronJobs(() => tmpDir, { hermesCronPath: NO_HERMES });
      assert.strictEqual(jobs.length, 1);
      assert.ok(jobs.every((j) => j.source === "openclaw"));
    });

    it("handles disabled jobs and missing state fields", () => {
      writeOpenClawFixture([
        {
          id: "job-2",
          name: "Disabled Job",
          enabled: false,
          schedule: { kind: "cron", expr: "0 9 * * *" },
        },
      ]);
      const jobs = getCronJobs(() => tmpDir, { hermesCronPath: NO_HERMES });
      assert.strictEqual(jobs.length, 1);
      assert.strictEqual(jobs[0].enabled, false);
      assert.strictEqual(jobs[0].lastStatus, null);
      assert.strictEqual(jobs[0].agent, null);
      assert.strictEqual(jobs[0].nextRun, "—");
    });

    it("returns [] without crashing on a corrupt jobs file", () => {
      fs.mkdirSync(path.join(tmpDir, "cron"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "cron", "jobs.json"), "{not json");
      const jobs = getCronJobs(() => tmpDir, { hermesCronPath: NO_HERMES });
      assert.deepStrictEqual(jobs, []);
    });

    it("forceCliRefresh() re-runs the CLI within the TTL (post-mutation invalidation)", async () => {
      let cliCalls = 0;
      const enabledById = { "job-1": true };
      _resetForTesting({
        cliRunner: async () => {
          cliCalls += 1;
          return JSON.stringify({ jobs: [{ ...OPENCLAW_JOB, enabled: enabledById["job-1"] }] });
        },
      });

      getCronJobs(() => tmpDir, { hermesCronPath: NO_HERMES });
      await _waitForCliRefreshForTesting();
      assert.strictEqual(cliCalls, 1);

      // Simulate a mutation, then force a refresh despite the warm cache
      enabledById["job-1"] = false;
      await forceCliRefresh();
      assert.strictEqual(cliCalls, 2);

      const jobs = getCronJobs(() => tmpDir, { hermesCronPath: NO_HERMES });
      assert.strictEqual(jobs.length, 1);
      assert.strictEqual(jobs[0].enabled, false);
    });

    it("maps one-time schedules", () => {
      writeOpenClawFixture([
        { id: "job-3", name: "Once", enabled: true, schedule: { kind: "once" } },
      ]);
      const jobs = getCronJobs(() => tmpDir, { hermesCronPath: NO_HERMES });
      assert.strictEqual(jobs[0].schedule, "once");
      assert.strictEqual(jobs[0].scheduleHuman, "One-time");
    });
  });
});
