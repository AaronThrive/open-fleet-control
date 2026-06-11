/**
 * Alert history analytics — rollups computed from logs/alerts.jsonl.
 *
 * Covers computeAlertAnalytics() (pure) and createAlertHistory().analytics()
 * (file-backed): per-day buckets over the window, severity counts, flap
 * cycles (fired→recovered per rule+node), top noisiest nodes/rules, window
 * filtering, rotated-file inclusion, and graceful empty/missing history.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createAlertHistory, computeAlertAnalytics } = require("../src/alerts-history");

// Fixed "now": 2026-06-10T12:00:00Z (a known UTC day for bucket assertions).
const NOW = Date.UTC(2026, 5, 10, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

/** Entry factory with sane defaults. */
function entry(overrides = {}) {
  return {
    id: "alr_test",
    type: "nodeOffline",
    severity: "critical",
    node: "hermes-1",
    task: null,
    message: "test",
    ts: NOW,
    ...overrides,
  };
}

describe("computeAlertAnalytics()", () => {
  it("returns an empty 14-day shape for no entries", () => {
    const result = computeAlertAnalytics([], { now: NOW });
    assert.strictEqual(result.days, 14);
    assert.strictEqual(result.total, 0);
    assert.strictEqual(result.perDay.length, 14);
    assert.strictEqual(result.perDay[13].date, "2026-06-10");
    assert.strictEqual(result.perDay[0].date, "2026-05-28");
    for (const day of result.perDay) {
      assert.deepStrictEqual(
        { total: day.total, critical: day.critical, warn: day.warn, info: day.info },
        { total: 0, critical: 0, warn: 0, info: 0 },
      );
    }
    assert.deepStrictEqual(result.flaps, []);
    assert.deepStrictEqual(result.topNodes, []);
    assert.deepStrictEqual(result.topRules, []);
    assert.strictEqual(typeof result.since, "number");
  });

  it("buckets entries per UTC day with severity counts", () => {
    const entries = [
      entry({ ts: NOW, severity: "critical" }),
      entry({ ts: NOW - 3600000, severity: "warn", type: "taskStale" }),
      entry({ ts: NOW - DAY_MS, severity: "info", type: "nodeRecovered" }),
    ];
    const result = computeAlertAnalytics(entries, { now: NOW });
    const today = result.perDay[13];
    const yesterday = result.perDay[12];
    assert.strictEqual(result.total, 3);
    assert.deepStrictEqual(
      { total: today.total, critical: today.critical, warn: today.warn, info: today.info },
      { total: 2, critical: 1, warn: 1, info: 0 },
    );
    assert.deepStrictEqual(
      {
        total: yesterday.total,
        critical: yesterday.critical,
        warn: yesterday.warn,
        info: yesterday.info,
      },
      { total: 1, critical: 0, warn: 0, info: 1 },
    );
  });

  it("excludes entries outside the window and treats unknown severities as info", () => {
    const entries = [
      entry({ ts: NOW - 14 * DAY_MS }), // before the 14-day window
      entry({ ts: NOW + DAY_MS }), // future
      entry({ ts: NOW, severity: "bogus" }),
    ];
    const result = computeAlertAnalytics(entries, { now: NOW });
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.perDay[13].info, 1);
  });

  it("honors a custom days option and clamps garbage to the default", () => {
    const seven = computeAlertAnalytics([], { now: NOW, days: 7 });
    assert.strictEqual(seven.days, 7);
    assert.strictEqual(seven.perDay.length, 7);
    for (const bad of [0, -3, "x", 9999, null]) {
      const result = computeAlertAnalytics([], { now: NOW, days: bad });
      assert.strictEqual(result.days, 14, `days=${String(bad)} should clamp to 14`);
    }
  });

  it("counts flap cycles (fired→recovered) per rule+node", () => {
    const entries = [
      // hermes-1: two full offline→recovered cycles
      entry({ ts: NOW - 5000, type: "nodeOffline", node: "hermes-1" }),
      entry({ ts: NOW - 4000, type: "nodeRecovered", node: "hermes-1", severity: "info" }),
      entry({ ts: NOW - 3000, type: "nodeOffline", node: "hermes-1" }),
      entry({ ts: NOW - 2000, type: "nodeRecovered", node: "hermes-1", severity: "info" }),
      // oc-bot-1: one unreachable→recovered cycle
      entry({ ts: NOW - 3500, type: "nodeUnreachable", node: "oc-bot-1", severity: "warn" }),
      entry({ ts: NOW - 2500, type: "nodeRecovered", node: "oc-bot-1", severity: "info" }),
      // recovered without a preceding down alert → no cycle
      entry({ ts: NOW - 1000, type: "nodeRecovered", node: "ghost", severity: "info" }),
      // down without recovery → no cycle
      entry({ ts: NOW - 500, type: "nodeOffline", node: "stuck" }),
    ];
    const result = computeAlertAnalytics(entries, { now: NOW });
    assert.deepStrictEqual(result.flaps, [
      { rule: "nodeOffline", node: "hermes-1", cycles: 2 },
      { rule: "nodeUnreachable", node: "oc-bot-1", cycles: 1 },
    ]);
  });

  it("ranks top noisiest nodes and rules descending", () => {
    const entries = [
      entry({ node: "a", type: "taskFailed", severity: "warn" }),
      entry({ node: "a", type: "taskFailed", severity: "warn" }),
      entry({ node: "a", type: "nodeOffline" }),
      entry({ node: "b", type: "nodeOffline" }),
      entry({ node: null, type: "lessonPending", severity: "info" }),
    ];
    const result = computeAlertAnalytics(entries, { now: NOW });
    assert.deepStrictEqual(result.topNodes, [
      { node: "a", count: 3 },
      { node: "b", count: 1 },
    ]);
    assert.deepStrictEqual(result.topRules, [
      { type: "nodeOffline", count: 2 },
      { type: "taskFailed", count: 2 },
      { type: "lessonPending", count: 1 },
    ]);
  });
});

describe("createAlertHistory().analytics()", () => {
  let logsDir;

  beforeEach(() => {
    logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofc-history-analytics-"));
  });

  afterEach(() => {
    fs.rmSync(logsDir, { recursive: true, force: true });
  });

  it("returns the empty shape when no history file exists", () => {
    const history = createAlertHistory({ logsDir: path.join(logsDir, "nope") });
    const result = history.analytics({ now: NOW });
    assert.strictEqual(result.total, 0);
    assert.strictEqual(result.perDay.length, 14);
  });

  it("computes analytics from appended alerts", () => {
    const history = createAlertHistory({ logsDir });
    history.append(entry({ ts: NOW - 1000, type: "nodeOffline", node: "hermes-1" }));
    history.append(
      entry({ ts: NOW - 500, type: "nodeRecovered", node: "hermes-1", severity: "info" }),
    );
    const result = history.analytics({ now: NOW });
    assert.strictEqual(result.total, 2);
    assert.deepStrictEqual(result.flaps, [{ rule: "nodeOffline", node: "hermes-1", cycles: 1 }]);
    assert.deepStrictEqual(result.topRules, [
      { type: "nodeOffline", count: 1 },
      { type: "nodeRecovered", count: 1 },
    ]);
  });

  it("includes rotated files and skips malformed lines", () => {
    fs.writeFileSync(
      path.join(logsDir, "alerts.2026-06-09T00-00-00-000Z.jsonl"),
      `${JSON.stringify(entry({ ts: NOW - DAY_MS }))}\nnot json\n{"type":"x"}\n`,
      "utf8",
    );
    const history = createAlertHistory({ logsDir });
    history.append(entry({ ts: NOW }));
    const result = history.analytics({ now: NOW });
    assert.strictEqual(result.total, 2);
    assert.strictEqual(result.perDay[12].total, 1);
    assert.strictEqual(result.perDay[13].total, 1);
  });
});
