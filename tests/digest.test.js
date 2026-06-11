/**
 * Unit tests for src/digest.js — config normalization, due-time math,
 * digest composition over fixture sources, and the scheduler's
 * no-double-send guarantees (fake clock, persisted lastSentAt, test sends
 * never advancing the schedule).
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createDigest,
  createTopConsumersSource,
  normalizeDigestConfig,
  lastScheduledOccurrence,
} = require("../src/digest");

// Wednesday 2026-06-10T12:00:00Z
const NOW = Date.UTC(2026, 5, 10, 12, 0, 0);
const HOUR = 3600000;
const DAY = 86400000;

const silentLog = { log: () => {}, warn: () => {}, error: () => {} };

function iso(ms) {
  return new Date(ms).toISOString();
}

function fixtureSources(overrides = {}) {
  return {
    getBudgetStatus: async () => ({
      enabled: true,
      generatedAt: NOW,
      periods: {
        daily: {
          periodKey: "2026-06-10",
          elapsedPct: 50,
          usageAvailable: true,
          scopes: [
            { scope: "total", limitUSD: 10, spentUSD: 12, percent: 120, state: "critical" },
            { scope: "provider:kimi", limitUSD: 5, spentUSD: 1, percent: 20, state: "ok" },
          ],
        },
      },
      enforcement: {
        enabled: true,
        blocked: [{ period: "daily", periodKey: "2026-06-10", scope: "total" }],
        acks: [],
      },
    }),
    getBoard: () => ({
      tasks: [
        { id: "t1", status: "done", updated_at: iso(NOW - HOUR), stale: false },
        { id: "t2", status: "done", updated_at: iso(NOW - 90 * HOUR), stale: false }, // pre-window
        { id: "t3", status: "failed", updated_at: iso(NOW - 2 * HOUR), stale: false },
        { id: "t4", status: "inprogress", updated_at: iso(NOW - HOUR), stale: true },
      ],
    }),
    getCronJobs: () => [
      { name: "good-job", lastStatus: "ok" },
      { name: "bad-job", lastStatus: "error" },
    ],
    getMeshState: async () => ({
      nodes: [
        { hostname: "alpha", health: { status: "online" } },
        { hostname: "beta", health: { status: "offline" } },
      ],
    }),
    getAlertHistory: () => [
      { type: "nodeOffline" },
      { type: "nodeRecovered" },
      { type: "taskFailed" }, // unrelated — must not count as a mesh event
    ],
    getEvolutionState: () => ({ gate: true, pending: [{ id: "les_1", title: "Lesson A" }] }),
    getTopConsumers: async () => [
      { label: "claude-code (24h est)", costUSD: 1.23, tokens: 4500, requests: 7 },
    ],
    ...overrides,
  };
}

function makeDigest({ config, sources = fixtureSources(), stateFile = null, now = NOW } = {}) {
  const delivered = [];
  const clock = { now };
  const digest = createDigest({
    config,
    stateFile,
    sources,
    deliver: async (alert, sinkNames) => {
      delivered.push({ alert, sinkNames });
      return { dispatched: 2, delivered: 2, suppressed: false };
    },
    nowFn: () => clock.now,
    log: silentLog,
  });
  return { digest, delivered, clock };
}

describe("digest module", () => {
  describe("normalizeDigestConfig()", () => {
    it("fills safe defaults for missing/malformed config", () => {
      assert.deepStrictEqual(normalizeDigestConfig(undefined), {
        enabled: false,
        schedule: "daily",
        hourUtc: 8,
        sinks: ["*"],
      });
      assert.deepStrictEqual(
        normalizeDigestConfig({ enabled: "yes", schedule: "hourly", hourUtc: 99, sinks: "ntfy" }),
        { enabled: false, schedule: "daily", hourUtc: 8, sinks: ["*"] },
      );
    });

    it("keeps valid values and filters unknown sinks", () => {
      assert.deepStrictEqual(
        normalizeDigestConfig({
          enabled: true,
          schedule: "weekly",
          hourUtc: 0,
          sinks: ["ntfy", "bogus", "webhooks"],
        }),
        { enabled: true, schedule: "weekly", hourUtc: 0, sinks: ["ntfy", "webhooks"] },
      );
    });

    it('collapses any "*" (and empty lists) to ["*"]', () => {
      assert.deepStrictEqual(normalizeDigestConfig({ sinks: ["slack", "*"] }).sinks, ["*"]);
      assert.deepStrictEqual(normalizeDigestConfig({ sinks: [] }).sinks, ["*"]);
    });
  });

  describe("lastScheduledOccurrence()", () => {
    const daily8 = { schedule: "daily", hourUtc: 8 };

    it("daily: today's occurrence once the hour has passed", () => {
      assert.strictEqual(lastScheduledOccurrence(daily8, NOW), Date.UTC(2026, 5, 10, 8));
    });

    it("daily: yesterday's occurrence before the hour", () => {
      const early = Date.UTC(2026, 5, 10, 7, 59);
      assert.strictEqual(lastScheduledOccurrence(daily8, early), Date.UTC(2026, 5, 9, 8));
    });

    it("weekly: the most recent Monday at hourUtc", () => {
      const weekly = { schedule: "weekly", hourUtc: 8 };
      // Wednesday → Monday 2026-06-08T08:00Z
      assert.strictEqual(lastScheduledOccurrence(weekly, NOW), Date.UTC(2026, 5, 8, 8));
      // Monday 07:00 → previous Monday
      const mondayEarly = Date.UTC(2026, 5, 8, 7);
      assert.strictEqual(lastScheduledOccurrence(weekly, mondayEarly), Date.UTC(2026, 5, 1, 8));
      // Sunday → same week's Monday
      const sunday = Date.UTC(2026, 5, 14, 23);
      assert.strictEqual(lastScheduledOccurrence(weekly, sunday), Date.UTC(2026, 5, 8, 8));
    });
  });

  describe("composeDigest()", () => {
    it("renders every section from the fixture sources", async () => {
      const { digest } = makeDigest({ config: { enabled: true } });
      const { markdown, title } = await digest.composeDigest({ sinceMs: NOW - DAY });

      assert.ok(title.includes("Fleet digest (daily)"));
      // Budgets: scope lines + enforcement notice.
      assert.ok(markdown.includes("daily total: $12.00 / $10.00 (120%) ⛔"));
      assert.ok(markdown.includes("daily provider:kimi: $1.00 / $5.00 (20%)"));
      assert.ok(markdown.includes("dispatch blocking ACTIVE: daily total"));
      // Kanban: only cards updated inside the window count; stuck = stale.
      assert.ok(markdown.includes("done: 1 · failed: 1 · stuck: 1 (of 4 cards)"));
      // Cron: only the failing job is listed.
      assert.ok(markdown.includes("FAILING: bad-job (last status: error)"));
      assert.ok(!markdown.includes("good-job"));
      // Mesh: down-now nodes + event counts (flapping marker).
      assert.ok(markdown.includes("down now: beta (offline)"));
      assert.ok(markdown.includes("1 offline, 0 unreachable, 1 recovered (flapping)"));
      // Lessons + consumers.
      assert.ok(markdown.includes("1 pending approval: Lesson A"));
      assert.ok(markdown.includes("claude-code (24h est): $1.23 · 4.5k tok · 7 req"));
    });

    it("degrades gracefully when sources are missing or throw", async () => {
      const { digest } = makeDigest({
        config: { enabled: true },
        sources: {
          getBudgetStatus: async () => {
            throw new Error("boom");
          },
          // every other source absent
        },
      });
      const { markdown } = await digest.composeDigest({ sinceMs: NOW - DAY });
      assert.ok(markdown.includes("- budgets disabled"));
      assert.ok(markdown.includes("- kanban unavailable"));
      assert.ok(markdown.includes("- cron data unavailable"));
      assert.ok(markdown.includes("- mesh unavailable"));
      assert.ok(markdown.includes("- no lessons pending"));
      assert.ok(markdown.includes("- usage sources unavailable"));
    });

    it("reports unavailable usage when budgets cannot read spend", async () => {
      const { digest } = makeDigest({
        config: { enabled: true },
        sources: fixtureSources({
          getBudgetStatus: async () => ({
            enabled: true,
            periods: { daily: { periodKey: "2026-06-10", usageAvailable: false, scopes: [] } },
          }),
        }),
      });
      const { markdown } = await digest.composeDigest({ sinceMs: NOW - DAY });
      assert.ok(markdown.includes("daily: usage data unavailable"));
    });
  });

  describe("scheduler", () => {
    let tmpDir;
    let stateFile;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofc-digest-"));
      stateFile = path.join(tmpDir, "digest.json");
    });
    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("tick() sends once when due and never double-sends in the same window", async () => {
      const { digest, delivered, clock } = makeDigest({
        config: { enabled: true, schedule: "daily", hourUtc: 8, sinks: ["ntfy"] },
        stateFile,
      });
      // lastSentAt yesterday → today's 08:00 occurrence is due at 12:00.
      fs.writeFileSync(stateFile, JSON.stringify({ lastSentAt: NOW - DAY }));
      const reloaded = makeDigest({
        config: { enabled: true, schedule: "daily", hourUtc: 8, sinks: ["ntfy"] },
        stateFile,
      });

      await reloaded.digest.tick();
      assert.strictEqual(reloaded.delivered.length, 1);
      assert.deepStrictEqual(reloaded.delivered[0].sinkNames, ["ntfy"]);
      assert.strictEqual(reloaded.delivered[0].alert.type, "fleetDigest");
      assert.strictEqual(reloaded.delivered[0].alert.severity, "info");

      // Same window: not due again — even hours later.
      reloaded.clock.now = NOW + 5 * HOUR;
      await reloaded.digest.tick();
      assert.strictEqual(reloaded.delivered.length, 1);

      // Next day's occurrence → due again.
      reloaded.clock.now = NOW + DAY;
      await reloaded.digest.tick();
      assert.strictEqual(reloaded.delivered.length, 2);
      assert.strictEqual(delivered.length, 0); // first instance never ticked
      void digest;
      void clock;
    });

    it("persists lastSentAt so a restart does not double-send", async () => {
      fs.writeFileSync(stateFile, JSON.stringify({ lastSentAt: NOW - DAY }));
      const first = makeDigest({
        config: { enabled: true, schedule: "daily", hourUtc: 8 },
        stateFile,
      });
      await first.digest.tick();
      assert.strictEqual(first.delivered.length, 1);

      // "Restart": a fresh instance over the same state file, same clock.
      const second = makeDigest({
        config: { enabled: true, schedule: "daily", hourUtc: 8 },
        stateFile,
      });
      await second.digest.tick();
      assert.strictEqual(second.delivered.length, 0);
      assert.strictEqual(second.digest.getState().lastSentAt, NOW);
    });

    it("test sends (sendNow) never advance the schedule", async () => {
      fs.writeFileSync(stateFile, JSON.stringify({ lastSentAt: NOW - DAY }));
      const { digest, delivered } = makeDigest({
        config: { enabled: true, schedule: "daily", hourUtc: 8 },
        stateFile,
      });

      const result = await digest.sendNow();
      assert.strictEqual(result.sent, true);
      assert.strictEqual(result.scheduled, false);
      assert.strictEqual(delivered.length, 1);
      // lastSentAt untouched → the scheduled send still fires.
      assert.strictEqual(digest.getState().lastSentAt, NOW - DAY);
      await digest.tick();
      assert.strictEqual(delivered.length, 2);
    });

    it("does nothing while disabled and hot-applies a new config", async () => {
      fs.writeFileSync(stateFile, JSON.stringify({ lastSentAt: NOW - DAY }));
      const { digest, delivered } = makeDigest({ config: { enabled: false }, stateFile });
      await digest.tick();
      assert.strictEqual(delivered.length, 0);

      digest.applyConfig({ enabled: true, schedule: "daily", hourUtc: 8 });
      digest.stop(); // detach the interval started by applyConfig→start
      await digest.tick();
      assert.strictEqual(delivered.length, 1);
    });

    it("first enable anchors lastSentAt instead of sending immediately", async () => {
      const { digest, delivered } = makeDigest({
        config: { enabled: true, schedule: "daily", hourUtc: 8 },
        stateFile,
      });
      digest.start();
      digest.stop();
      assert.strictEqual(delivered.length, 0);
      assert.strictEqual(digest.getState().lastSentAt, NOW);
      assert.strictEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")).lastSentAt, NOW);
    });

    it("delivery failures do not advance lastSentAt", async () => {
      fs.writeFileSync(stateFile, JSON.stringify({ lastSentAt: NOW - DAY }));
      const clock = { now: NOW };
      const digest = createDigest({
        config: { enabled: true, schedule: "daily", hourUtc: 8 },
        stateFile,
        sources: fixtureSources(),
        deliver: async () => {
          throw new Error("sink down");
        },
        nowFn: () => clock.now,
        log: silentLog,
      });
      const result = await digest.tick();
      assert.strictEqual(result.sent, false);
      assert.strictEqual(digest.getState().lastSentAt, NOW - DAY);
    });
  });

  describe("createTopConsumersSource()", () => {
    it("aggregates claude-code and 9Router consumers sorted by cost", async () => {
      const usageSources = {
        sources: {
          claudeCode: {
            describe: () => ({ available: true }),
            getUsageWindows: async () => ({
              available: true,
              h24: {
                input: 1000,
                output: 500,
                cacheRead: 0,
                cacheWrite: 0,
                requests: 4,
                estCost: 0.5,
              },
            }),
          },
          nineRouter: {
            describe: () => ({ available: true }),
            getUsage: async () => ({
              byModel: [
                { model: "kimi-k2", cost: 2.5, totalTokens: 9000, requests: 12 },
                { model: "glm-4", cost: 0.1, totalTokens: 100, requests: 1 },
              ],
            }),
          },
        },
      };
      const getTopConsumers = createTopConsumersSource({ usageSources, nowFn: () => NOW });
      const consumers = await getTopConsumers();
      assert.deepStrictEqual(
        consumers.map((c) => c.label),
        ["9router kimi-k2 (24h)", "claude-code (24h est)", "9router glm-4 (24h)"],
      );
      assert.strictEqual(consumers[0].costUSD, 2.5);
      assert.strictEqual(consumers[1].tokens, 1500);
    });

    it("tolerates unavailable/broken sources", async () => {
      const usageSources = {
        sources: {
          claudeCode: { describe: () => ({ available: false }) },
          nineRouter: {
            describe: () => ({ available: true }),
            getUsage: async () => {
              throw new Error("sqlite gone");
            },
          },
        },
      };
      const getTopConsumers = createTopConsumersSource({ usageSources, nowFn: () => NOW });
      assert.deepStrictEqual(await getTopConsumers(), []);
    });

    it("throws without a usageSources instance", () => {
      assert.throws(() => createTopConsumersSource({}), /usageSources/);
    });
  });
});
