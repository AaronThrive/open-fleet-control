/**
 * Unit tests for src/cron-actions.js — cron write-actions (enable/disable/
 * run-now) for OpenClaw-source jobs. ALL CLI interaction goes through the
 * injected execFn; these tests never spawn the real openclaw binary.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { createCronActions } = require("../src/cron-actions");

const OPENCLAW_JOB = { id: "job-1", name: "Morning Briefing", enabled: true, source: "openclaw" };
const HERMES_JOB = { id: "h-1", name: "ECC readiness check", enabled: true, source: "hermes" };

function makeHarness({ jobs = [OPENCLAW_JOB, HERMES_JOB], execImpl, refreshImpl } = {}) {
  const calls = { exec: [], refresh: 0 };
  const actions = createCronActions({
    execFn: async (args) => {
      calls.exec.push(args);
      if (execImpl) return execImpl(args);
      return "";
    },
    getJobs: () => jobs,
    refreshJobs: async () => {
      calls.refresh += 1;
      if (refreshImpl) return refreshImpl();
    },
  });
  return { actions, calls };
}

describe("createCronActions()", () => {
  let savedProfile;

  beforeEach(() => {
    savedProfile = process.env.OPENCLAW_PROFILE;
    delete process.env.OPENCLAW_PROFILE;
  });

  afterEach(() => {
    if (savedProfile === undefined) delete process.env.OPENCLAW_PROFILE;
    else process.env.OPENCLAW_PROFILE = savedProfile;
  });

  it("requires a getJobs function", () => {
    assert.throws(() => createCronActions({}), /getJobs/);
  });

  describe("setJobEnabled()", () => {
    it("enables a job via `cron enable <id>`", async () => {
      const { actions, calls } = makeHarness();
      const result = await actions.setJobEnabled("job-1", true);
      assert.deepStrictEqual(calls.exec, [["cron", "enable", "job-1"]]);
      assert.deepStrictEqual(result, { id: "job-1", enabled: true });
    });

    it("disables a job via `cron disable <id>`", async () => {
      const { actions, calls } = makeHarness();
      const result = await actions.setJobEnabled("job-1", false);
      assert.deepStrictEqual(calls.exec, [["cron", "disable", "job-1"]]);
      assert.deepStrictEqual(result, { id: "job-1", enabled: false });
    });

    it("prepends --profile when OPENCLAW_PROFILE is set", async () => {
      process.env.OPENCLAW_PROFILE = "prod";
      const { actions, calls } = makeHarness();
      await actions.setJobEnabled("job-1", true);
      assert.deepStrictEqual(calls.exec, [["--profile", "prod", "cron", "enable", "job-1"]]);
    });

    it("refreshes the cached job list after a successful mutation", async () => {
      const { actions, calls } = makeHarness();
      await actions.setJobEnabled("job-1", false);
      assert.strictEqual(calls.refresh, 1);
    });

    it("rejects Hermes-source jobs with a read-only 403 (no CLI call)", async () => {
      const { actions, calls } = makeHarness();
      await assert.rejects(
        () => actions.setJobEnabled("h-1", false),
        (err) => err.statusCode === 403 && /read-only/i.test(err.message),
      );
      assert.strictEqual(calls.exec.length, 0);
      assert.strictEqual(calls.refresh, 0);
    });

    it("rejects unknown job ids with 404", async () => {
      const { actions, calls } = makeHarness();
      await assert.rejects(
        () => actions.setJobEnabled("nope", true),
        (err) => err.statusCode === 404 && /not found/i.test(err.message),
      );
      assert.strictEqual(calls.exec.length, 0);
    });

    it("rejects empty/non-string ids with 400", async () => {
      const { actions } = makeHarness();
      for (const bad of ["", "   ", null, undefined, 42]) {
        await assert.rejects(
          () => actions.setJobEnabled(bad, true),
          (err) => err.statusCode === 400,
        );
      }
    });

    it("maps CLI failures to 502 and skips the cache refresh", async () => {
      const { actions, calls } = makeHarness({
        execImpl: () => {
          throw new Error("gateway timeout");
        },
      });
      await assert.rejects(
        () => actions.setJobEnabled("job-1", true),
        (err) => err.statusCode === 502 && /gateway timeout/.test(err.message),
      );
      assert.strictEqual(calls.refresh, 0);
    });

    it("does not fail the mutation when the cache refresh itself fails", async () => {
      const { actions } = makeHarness({
        refreshImpl: () => {
          throw new Error("refresh boom");
        },
      });
      const result = await actions.setJobEnabled("job-1", true);
      assert.deepStrictEqual(result, { id: "job-1", enabled: true });
    });
  });

  describe("runJobNow()", () => {
    it("triggers a run via `cron run <id>` and refreshes the cache", async () => {
      const { actions, calls } = makeHarness();
      const result = await actions.runJobNow("job-1");
      assert.deepStrictEqual(calls.exec, [["cron", "run", "job-1"]]);
      assert.deepStrictEqual(result, { id: "job-1", triggered: true });
      assert.strictEqual(calls.refresh, 1);
    });

    it("rejects Hermes-source jobs with a read-only 403", async () => {
      const { actions, calls } = makeHarness();
      await assert.rejects(
        () => actions.runJobNow("h-1"),
        (err) => err.statusCode === 403 && /read-only/i.test(err.message),
      );
      assert.strictEqual(calls.exec.length, 0);
    });

    it("rejects unknown job ids with 404", async () => {
      const { actions } = makeHarness();
      await assert.rejects(
        () => actions.runJobNow("nope"),
        (err) => err.statusCode === 404,
      );
    });

    it("maps CLI failures to 502", async () => {
      const { actions } = makeHarness({
        execImpl: () => {
          throw new Error("no gateway");
        },
      });
      await assert.rejects(
        () => actions.runJobNow("job-1"),
        (err) => err.statusCode === 502 && /no gateway/.test(err.message),
      );
    });

    it("survives a getJobs() failure with a 503", async () => {
      const actions = createCronActions({
        execFn: async () => "",
        getJobs: () => {
          throw new Error("source exploded");
        },
        refreshJobs: async () => {},
      });
      await assert.rejects(
        () => actions.runJobNow("job-1"),
        (err) => err.statusCode === 503,
      );
    });
  });
});
