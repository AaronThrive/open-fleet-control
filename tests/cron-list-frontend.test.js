/**
 * Tests for the pure (DOM-free) helpers used by the Cron detail-list view.
 * The module is browser ESM, so it is loaded via dynamic import.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert");

let classifySchedule;
let filterCronJobs;
let toCronRow;

before(async () => {
  const mod = await import("../public/js/views/cron.js");
  classifySchedule = mod.classifySchedule;
  filterCronJobs = mod.filterCronJobs;
  toCronRow = mod.toCronRow;
});

const JOBS = [
  {
    id: "j1",
    name: "Nightly sync",
    schedule: "0 9 * * *",
    scheduleHuman: "Every day at 09:00",
    nextRun: "in 2h",
    enabled: true,
    lastStatus: "ok",
    agent: "main",
    node: "alpha",
    source: "openclaw",
  },
  {
    id: "j2",
    name: "Weekly digest",
    schedule: "0 8 * * 1",
    enabled: false,
    lastStatus: "error",
    agent: "digest",
    node: "beta",
    source: "openclaw",
  },
  {
    id: "j3",
    name: "Hermes heartbeat",
    schedule: "*/5 * * * *",
    enabled: true,
    lastStatus: null,
    agent: null,
    node: null,
    source: "hermes",
  },
];

describe("classifySchedule()", () => {
  it("classifies day-of-week expressions as weekly", () => {
    assert.strictEqual(classifySchedule({ schedule: "0 8 * * 1" }), "weekly");
  });

  it("classifies sub-hourly expressions as frequent", () => {
    assert.strictEqual(classifySchedule({ schedule: "*/5 * * * *" }), "frequent");
    assert.strictEqual(classifySchedule({ schedule: "0 */2 * * *" }), "frequent");
  });

  it("classifies fixed-time expressions as daily", () => {
    assert.strictEqual(classifySchedule({ schedule: "0 9 * * *" }), "daily");
  });

  it("classifies non-cron values as other", () => {
    assert.strictEqual(classifySchedule({ schedule: "once" }), "other");
    assert.strictEqual(classifySchedule({ schedule: "" }), "other");
    assert.strictEqual(classifySchedule({}), "other");
  });
});

describe("filterCronJobs()", () => {
  const ALL = { status: "all", schedule: "all", source: "all", agent: "all" };

  it("returns every job for all-pass filters", () => {
    assert.strictEqual(filterCronJobs(JOBS, ALL).length, 3);
  });

  it("filters by enabled/disabled status", () => {
    assert.deepStrictEqual(
      filterCronJobs(JOBS, { ...ALL, status: "enabled" }).map((j) => j.id),
      ["j1", "j3"],
    );
    assert.deepStrictEqual(
      filterCronJobs(JOBS, { ...ALL, status: "disabled" }).map((j) => j.id),
      ["j2"],
    );
  });

  it("filters by schedule classification", () => {
    assert.deepStrictEqual(
      filterCronJobs(JOBS, { ...ALL, schedule: "weekly" }).map((j) => j.id),
      ["j2"],
    );
    assert.deepStrictEqual(
      filterCronJobs(JOBS, { ...ALL, schedule: "frequent" }).map((j) => j.id),
      ["j3"],
    );
  });

  it("filters by source, defaulting unknown sources to openclaw", () => {
    assert.deepStrictEqual(
      filterCronJobs(JOBS, { ...ALL, source: "hermes" }).map((j) => j.id),
      ["j3"],
    );
    assert.deepStrictEqual(
      filterCronJobs([{ id: "x", schedule: "0 9 * * *" }], { ...ALL, source: "openclaw" }).map(
        (j) => j.id,
      ),
      ["x"],
    );
  });

  it("filters by agent and combines filters", () => {
    assert.deepStrictEqual(
      filterCronJobs(JOBS, { ...ALL, agent: "main" }).map((j) => j.id),
      ["j1"],
    );
    assert.deepStrictEqual(filterCronJobs(JOBS, { ...ALL, agent: "main", status: "disabled" }), []);
  });

  it("does not mutate the input array", () => {
    const copy = JSON.parse(JSON.stringify(JOBS));
    filterCronJobs(JOBS, { ...ALL, status: "enabled" });
    assert.deepStrictEqual(JOBS, copy);
  });
});

describe("toCronRow()", () => {
  it("maps job fields onto flat row keys with fallbacks", () => {
    const row = toCronRow(JOBS[0]);
    assert.strictEqual(row.id, "j1");
    assert.strictEqual(row.name, "Nightly sync");
    assert.strictEqual(row.scheduleHuman, "Every day at 09:00");
    assert.strictEqual(row.schedule, "0 9 * * *");
    assert.strictEqual(row.nextRun, "in 2h");
    assert.strictEqual(row.lastStatus, "ok");
    assert.strictEqual(row.agent, "main");
    assert.strictEqual(row.node, "alpha");
    assert.strictEqual(row.source, "openclaw");
    assert.strictEqual(row.enabled, true);
    assert.strictEqual(row.job, JOBS[0]);
  });

  it("falls back to the raw expression when no human schedule exists", () => {
    const row = toCronRow(JOBS[1]);
    assert.strictEqual(row.scheduleHuman, "0 8 * * 1");
    assert.strictEqual(row.enabled, false);
  });

  it("normalizes missing fields and unknown sources", () => {
    const row = toCronRow({ name: "Bare" });
    assert.strictEqual(row.id, "Bare");
    assert.strictEqual(row.scheduleHuman, "—");
    assert.strictEqual(row.nextRun, "—");
    assert.strictEqual(row.lastStatus, "");
    assert.strictEqual(row.agent, "");
    assert.strictEqual(row.node, "");
    assert.strictEqual(row.source, "openclaw");
    assert.strictEqual(row.enabled, true);
  });

  it("flags hermes-source rows", () => {
    assert.strictEqual(toCronRow(JOBS[2]).source, "hermes");
  });
});
