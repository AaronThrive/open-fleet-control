/**
 * Tests for the pure helpers behind the AI Jobs page (public/jobs.html).
 * The module is browser ESM, so it is loaded via dynamic import.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert");

let getJobStatus;
let filterJobsByStatus;
let summarizeJobs;
let formatSchedule;

before(async () => {
  const mod = await import("../public/js/jobs-helpers.js");
  getJobStatus = mod.getJobStatus;
  filterJobsByStatus = mod.filterJobsByStatus;
  summarizeJobs = mod.summarizeJobs;
  formatSchedule = mod.formatSchedule;
});

const JOBS = [
  { id: "a", stats: { totalRuns: 10, totalSuccess: 9 } },
  { id: "b", paused: true, stats: { totalRuns: 4, totalSuccess: 4 } },
  { id: "c", stats: { streak: { type: "failed", count: 3 }, totalRuns: 6, totalSuccess: 2 } },
];

describe("getJobStatus()", () => {
  it("reports paused before anything else", () => {
    assert.strictEqual(getJobStatus({ paused: true }), "paused");
    assert.strictEqual(
      getJobStatus({ paused: true, stats: { streak: { type: "failed", count: 5 } } }),
      "paused",
    );
  });

  it("reports failed only at two or more consecutive failures", () => {
    assert.strictEqual(getJobStatus({ stats: { streak: { type: "failed", count: 2 } } }), "failed");
    assert.strictEqual(
      getJobStatus({ stats: { streak: { type: "failed", count: 1 } } }),
      "enabled",
    );
  });

  it("defaults to enabled", () => {
    assert.strictEqual(getJobStatus({}), "enabled");
  });
});

describe("filterJobsByStatus()", () => {
  it("passes everything through for the all filter", () => {
    assert.strictEqual(filterJobsByStatus(JOBS, "all").length, 3);
  });

  it("maps the active filter to enabled status", () => {
    assert.deepStrictEqual(
      filterJobsByStatus(JOBS, "active").map((j) => j.id),
      ["a"],
    );
  });

  it("filters paused and failed", () => {
    assert.deepStrictEqual(
      filterJobsByStatus(JOBS, "paused").map((j) => j.id),
      ["b"],
    );
    assert.deepStrictEqual(
      filterJobsByStatus(JOBS, "failed").map((j) => j.id),
      ["c"],
    );
  });

  it("does not mutate the input", () => {
    const copy = JSON.parse(JSON.stringify(JOBS));
    filterJobsByStatus(JOBS, "active");
    assert.deepStrictEqual(JOBS, copy);
  });
});

describe("summarizeJobs()", () => {
  it("counts totals and computes the aggregate success rate", () => {
    const s = summarizeJobs(JOBS);
    assert.strictEqual(s.total, 3);
    assert.strictEqual(s.active, 2); // not paused
    assert.strictEqual(s.paused, 1);
    assert.strictEqual(s.failed, 1);
    assert.strictEqual(s.successRate, 75); // 15 of 20 runs
  });

  it("reports 100% success with no runs and zeroes for no jobs", () => {
    assert.strictEqual(summarizeJobs([{ id: "x" }]).successRate, 100);
    assert.deepStrictEqual(summarizeJobs([]), {
      total: 0,
      active: 0,
      paused: 0,
      failed: 0,
      successRate: 100,
    });
  });
});

describe("formatSchedule()", () => {
  it("passes strings through and handles empty values", () => {
    assert.strictEqual(formatSchedule("0 9 * * *"), "0 9 * * *");
    assert.strictEqual(formatSchedule(null), "—");
    assert.strictEqual(formatSchedule(undefined), "—");
  });

  it("prefers cron, then interval, then at", () => {
    assert.strictEqual(formatSchedule({ cron: "*/5 * * * *" }), "*/5 * * * *");
    assert.strictEqual(formatSchedule({ interval: "10m" }), "Every 10m");
    assert.strictEqual(formatSchedule({ at: "09:00" }), "At 09:00");
  });

  it("uses the provided translator for interval and at", () => {
    const translate = (key, params, fallback) => `[${key}:${params.value}]${fallback}`;
    assert.strictEqual(formatSchedule({ interval: "10m" }, translate), "[jobs.every:10m]Every 10m");
    assert.strictEqual(formatSchedule({ at: "09:00" }, translate), "[jobs.at:09:00]At 09:00");
  });

  it("stringifies unknown schedule shapes", () => {
    assert.strictEqual(formatSchedule({ weird: true }), '{"weird":true}');
  });
});
