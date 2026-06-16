const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createBudgets,
  createUsageProvider,
  normalizeBudgetsConfig,
  dailyKey,
  weeklyKey,
  periodStartMs,
} = require("../src/budgets");

// 2026-06-10T12:00:00Z (Wednesday)
const NOW = Date.UTC(2026, 5, 10, 12, 0, 0);
const QUIET_LOG = { warn: () => {}, error: () => {} };

let tmpDir;
let stateFile;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofc-budgets-"));
  stateFile = path.join(tmpDir, "budgets.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeBudgets({ config, usage, now = NOW } = {}) {
  const breaches = [];
  const clock = { now };
  const budgets = createBudgets({
    config,
    stateFile,
    nowFn: () => clock.now,
    log: QUIET_LOG,
    getUsage: typeof usage === "function" ? usage : async () => usage ?? null,
    onBreach: (breach) => breaches.push(breach),
  });
  return { budgets, breaches, clock };
}

describe("budgets module", () => {
  describe("normalizeBudgetsConfig()", () => {
    it("fills safe defaults for missing/malformed config", () => {
      assert.deepStrictEqual(normalizeBudgetsConfig(undefined), {
        enabled: false,
        daily: { totalUSD: 0, perProvider: {} },
        weekly: { totalUSD: 0, perProvider: {} },
        checkIntervalMs: 900000,
        enforce: { enabled: false },
        allowOpen: false,
        closedCeilingUSD: 0,
      });
      const normalized = normalizeBudgetsConfig({
        enabled: true,
        daily: { totalUSD: -5, perProvider: { kimi: "3", bad: -1, zero: 0 } },
        checkIntervalMs: 10, // below the 60s floor → default
      });
      assert.strictEqual(normalized.daily.totalUSD, 0);
      assert.deepStrictEqual(normalized.daily.perProvider, { kimi: 3 });
      assert.strictEqual(normalized.checkIntervalMs, 900000);
    });
  });

  describe("period helpers", () => {
    it("computes UTC daily and ISO-week keys", () => {
      assert.strictEqual(dailyKey(NOW), "2026-06-10");
      assert.strictEqual(weeklyKey(NOW), "2026-W24");
      // Sunday belongs to the same ISO week as the preceding Monday.
      assert.strictEqual(weeklyKey(Date.UTC(2026, 5, 14)), "2026-W24");
      assert.strictEqual(weeklyKey(Date.UTC(2026, 5, 15)), "2026-W25");
    });

    it("computes period starts (UTC midnight / ISO Monday)", () => {
      assert.strictEqual(periodStartMs("daily", NOW), Date.UTC(2026, 5, 10));
      assert.strictEqual(periodStartMs("weekly", NOW), Date.UTC(2026, 5, 8)); // Monday
    });
  });

  describe("threshold evaluation", () => {
    const config = { enabled: true, daily: { totalUSD: 10 } };

    it("does nothing below 80%", async () => {
      const { budgets, breaches } = makeBudgets({
        config,
        usage: { nineRouterByProvider: { kimi: 7.99 } },
      });
      await budgets.evaluate();
      assert.deepStrictEqual(breaches, []);
    });

    it("fires warn at >=80%, once per period per scope", async () => {
      let spend = 8;
      const { budgets, breaches } = makeBudgets({
        config,
        usage: async () => ({ nineRouterByProvider: { kimi: spend } }),
      });
      await budgets.evaluate();
      await budgets.evaluate();
      spend = 9; // still in warn band
      await budgets.evaluate();

      assert.strictEqual(breaches.length, 1);
      assert.deepStrictEqual(breaches[0], {
        period: "daily",
        periodKey: "2026-06-10",
        scope: "total",
        severity: "warn",
        budgetUSD: 10,
        actualUSD: 8,
        ratio: 0.8,
      });
    });

    it("escalates to critical at >=100% (warn already fired)", async () => {
      let spend = 8.5;
      const { budgets, breaches } = makeBudgets({
        config,
        usage: async () => ({ nineRouterByProvider: { kimi: spend } }),
      });
      await budgets.evaluate(); // warn
      spend = 10.5;
      await budgets.evaluate(); // critical
      await budgets.evaluate(); // no repeat

      assert.deepStrictEqual(
        breaches.map((b) => b.severity),
        ["warn", "critical"],
      );
    });

    it("fires critical only (single breach) when the first observation is already over 100%", async () => {
      const { budgets, breaches } = makeBudgets({
        config,
        usage: { nineRouterByProvider: { kimi: 25 } },
      });
      await budgets.evaluate();
      await budgets.evaluate();
      assert.strictEqual(breaches.length, 1);
      assert.strictEqual(breaches[0].severity, "critical");
    });

    it("evaluates per-provider scopes independently of the total", async () => {
      const { budgets, breaches } = makeBudgets({
        config: { enabled: true, daily: { totalUSD: 100, perProvider: { kimi: 2, glm: 5 } } },
        usage: { nineRouterByProvider: { kimi: 3, glm: 1 } },
      });
      await budgets.evaluate();
      assert.strictEqual(breaches.length, 1);
      assert.strictEqual(breaches[0].scope, "provider:kimi");
      assert.strictEqual(breaches[0].severity, "critical");
    });

    it("supports weekly budgets with the weekly window", async () => {
      const windows = [];
      const { budgets, breaches } = makeBudgets({
        config: { enabled: true, weekly: { totalUSD: 10 } },
        usage: async ({ sinceMs, period }) => {
          windows.push({ sinceMs, period });
          return { nineRouterByProvider: { kimi: 9 } };
        },
      });
      await budgets.evaluate();
      assert.deepStrictEqual(windows, [{ sinceMs: Date.UTC(2026, 5, 8), period: "weekly" }]);
      assert.strictEqual(breaches[0].period, "weekly");
      assert.strictEqual(breaches[0].periodKey, "2026-W24");
    });
  });

  describe("persistence (state/budgets.json)", () => {
    it("survives restarts: a re-created evaluator does not re-alert in the same period", async () => {
      const config = { enabled: true, daily: { totalUSD: 10 } };
      const usage = { nineRouterByProvider: { kimi: 12 } };

      const first = makeBudgets({ config, usage });
      await first.budgets.evaluate();
      assert.strictEqual(first.breaches.length, 1);
      assert.ok(fs.existsSync(stateFile));

      const second = makeBudgets({ config, usage });
      await second.budgets.evaluate();
      assert.deepStrictEqual(second.breaches, []);
    });

    it("re-alerts in a NEW period and prunes the old period's state", async () => {
      const config = { enabled: true, daily: { totalUSD: 10 } };
      const usage = { nineRouterByProvider: { kimi: 12 } };
      const { budgets, breaches, clock } = makeBudgets({ config, usage });

      await budgets.evaluate();
      clock.now = NOW + 86400000; // next UTC day
      await budgets.evaluate();

      assert.strictEqual(breaches.length, 2);
      assert.strictEqual(breaches[1].periodKey, "2026-06-11");
      const persisted = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      assert.ok(
        Object.keys(persisted.fired).every((k) => k.includes("2026-06-11")),
        "old daily period entries pruned",
      );
    });

    it("tolerates a corrupt state file", async () => {
      fs.writeFileSync(stateFile, "{nope");
      const { budgets, breaches } = makeBudgets({
        config: { enabled: true, daily: { totalUSD: 10 } },
        usage: { nineRouterByProvider: { kimi: 12 } },
      });
      await budgets.evaluate();
      assert.strictEqual(breaches.length, 1);
    });
  });

  describe("spend computation", () => {
    it("converts the cumulative OpenRouter counter into a window delta via a baseline", async () => {
      let cumulative = 100;
      const { budgets, breaches } = makeBudgets({
        config: { enabled: true, daily: { perProvider: { openrouter: 1 } } },
        usage: async () => ({ openrouterCumulativeUSD: cumulative }),
      });

      await budgets.evaluate(); // baseline = 100, delta 0 → no breach
      assert.deepStrictEqual(breaches, []);

      cumulative = 100.9; // delta 0.9 → 90% of $1 → warn
      await budgets.evaluate();
      assert.strictEqual(breaches.length, 1);
      assert.strictEqual(breaches[0].scope, "provider:openrouter");
      assert.strictEqual(breaches[0].actualUSD, 0.9);
    });

    it("excludes claude-code est cost from the total but honors its provider scope", async () => {
      const usage = {
        nineRouterByProvider: { kimi: 1 },
        claudeCodeUSD: 500, // est @ API rates; OAuth sub → not real spend
      };
      const total = makeBudgets({ config: { enabled: true, daily: { totalUSD: 100 } }, usage });
      await total.budgets.evaluate();
      assert.deepStrictEqual(total.breaches, []); // 500 not counted toward total

      fs.rmSync(stateFile, { force: true });
      const scoped = makeBudgets({
        config: { enabled: true, daily: { perProvider: { "claude-code": 100 } } },
        usage,
      });
      await scoped.budgets.evaluate();
      assert.strictEqual(scoped.breaches.length, 1);
      assert.strictEqual(scoped.breaches[0].scope, "provider:claude-code");
    });

    it("falls back to tokensEstUSD for the total when no API spend signal exists", async () => {
      const { budgets, breaches } = makeBudgets({
        config: { enabled: true, daily: { totalUSD: 10 } },
        usage: { tokensEstUSD: 11 },
      });
      await budgets.evaluate();
      assert.strictEqual(breaches.length, 1);
      assert.strictEqual(breaches[0].actualUSD, 11);
    });
  });

  describe("lifecycle / guards", () => {
    it("requires getUsage and onBreach", () => {
      assert.throws(() => createBudgets({ onBreach: () => {} }), /getUsage/);
      assert.throws(() => createBudgets({ getUsage: () => {} }), /onBreach/);
    });

    it("is a no-op when disabled", async () => {
      const { budgets, breaches } = makeBudgets({
        config: { enabled: false, daily: { totalUSD: 1 } },
        usage: { nineRouterByProvider: { kimi: 99 } },
      });
      const result = await budgets.evaluate();
      assert.deepStrictEqual(result, { checked: false, reason: "disabled" });
      assert.deepStrictEqual(breaches, []);
    });

    it("skips quietly when the usage provider is not wired (getUsage → null)", async () => {
      const { budgets, breaches } = makeBudgets({
        config: { enabled: true, daily: { totalUSD: 1 } },
        usage: async () => null,
      });
      const result = await budgets.evaluate();
      assert.strictEqual(result.checked, true);
      assert.deepStrictEqual(breaches, []);
    });

    it("never throws when getUsage rejects", async () => {
      const { budgets, breaches } = makeBudgets({
        config: { enabled: true, daily: { totalUSD: 1 } },
        usage: async () => {
          throw new Error("source exploded");
        },
      });
      await assert.doesNotReject(() => budgets.evaluate());
      assert.deepStrictEqual(breaches, []);
    });

    it("a throwing onBreach callback never breaks evaluation", async () => {
      const budgets = createBudgets({
        config: { enabled: true, daily: { totalUSD: 1 } },
        stateFile,
        nowFn: () => NOW,
        log: QUIET_LOG,
        getUsage: async () => ({ nineRouterByProvider: { kimi: 5 } }),
        onBreach: () => {
          throw new Error("sink down");
        },
      });
      await assert.doesNotReject(() => budgets.evaluate());
    });

    it("applyConfig() hot-swaps thresholds", async () => {
      const { budgets, breaches } = makeBudgets({
        config: { enabled: true, daily: { totalUSD: 100 } },
        usage: { nineRouterByProvider: { kimi: 12 } },
      });
      await budgets.evaluate();
      assert.deepStrictEqual(breaches, []);

      budgets.applyConfig({ enabled: true, daily: { totalUSD: 10 } });
      budgets.stop(); // applyConfig started the timer; tests drive evaluate()
      await budgets.evaluate();
      assert.strictEqual(breaches.length, 1);
      assert.strictEqual(breaches[0].severity, "critical");
    });

    it("getState() reports without leaking internals", async () => {
      const { budgets } = makeBudgets({
        config: { enabled: true, daily: { totalUSD: 10 } },
        usage: { nineRouterByProvider: { kimi: 1 } },
      });
      await budgets.evaluate();
      const state = budgets.getState();
      assert.strictEqual(state.enabled, true);
      assert.strictEqual(state.lastCheck, NOW);
      assert.ok(state.lastSpend.daily);
    });
  });

  describe("getStatus()", () => {
    it("returns { enabled: false } when disabled", async () => {
      const { budgets } = makeBudgets({
        config: { enabled: false, daily: { totalUSD: 10 } },
        usage: { nineRouterByProvider: { kimi: 3 } },
      });
      assert.deepStrictEqual(await budgets.getStatus(), { enabled: false });
    });

    it("returns { enabled: false } when enabled but no scope has a limit", async () => {
      const { budgets } = makeBudgets({
        config: { enabled: true },
        usage: { nineRouterByProvider: { kimi: 3 } },
      });
      assert.deepStrictEqual(await budgets.getStatus(), { enabled: false });
    });

    it("reports limit, spend, percent, state, and period progress per scope", async () => {
      // NOW = Wednesday 2026-06-10T12:00Z → 50% of the day, 2.5/7 of the week.
      const { budgets } = makeBudgets({
        config: {
          enabled: true,
          daily: { totalUSD: 10, perProvider: { kimi: 2 } },
          weekly: { totalUSD: 50 },
        },
        usage: { nineRouterByProvider: { kimi: 3.2 } },
      });
      const status = await budgets.getStatus();

      assert.strictEqual(status.enabled, true);
      assert.strictEqual(status.generatedAt, NOW);

      const daily = status.periods.daily;
      assert.strictEqual(daily.periodKey, "2026-06-10");
      assert.strictEqual(daily.elapsedPct, 50);
      assert.strictEqual(daily.usageAvailable, true);
      assert.deepStrictEqual(daily.scopes, [
        { scope: "total", limitUSD: 10, spentUSD: 3.2, percent: 32, state: "ok" },
        { scope: "provider:kimi", limitUSD: 2, spentUSD: 3.2, percent: 160, state: "critical" },
      ]);

      const weekly = status.periods.weekly;
      assert.strictEqual(weekly.periodKey, "2026-W24");
      assert.strictEqual(weekly.elapsedPct, 35.7);
      assert.deepStrictEqual(weekly.scopes, [
        { scope: "total", limitUSD: 50, spentUSD: 3.2, percent: 6.4, state: "ok" },
      ]);
    });

    it("marks warn at >=80% without firing or recording a breach", async () => {
      const { budgets, breaches } = makeBudgets({
        config: { enabled: true, daily: { totalUSD: 10 } },
        usage: { nineRouterByProvider: { kimi: 8.5 } },
      });
      const status = await budgets.getStatus();
      assert.strictEqual(status.periods.daily.scopes[0].state, "warn");
      assert.strictEqual(status.periods.daily.scopes[0].percent, 85);
      // getStatus is read-only: no breach fired, no fired-state persisted.
      assert.deepStrictEqual(breaches, []);
      assert.ok(!fs.existsSync(stateFile));
    });

    it("reports zero spend with usageAvailable=false when the provider is not wired", async () => {
      const { budgets } = makeBudgets({
        config: { enabled: true, daily: { totalUSD: 10 } },
        usage: async () => null,
      });
      const status = await budgets.getStatus();
      assert.strictEqual(status.periods.daily.usageAvailable, false);
      assert.deepStrictEqual(status.periods.daily.scopes, [
        { scope: "total", limitUSD: 10, spentUSD: 0, percent: 0, state: "ok" },
      ]);
    });

    it("never throws when getUsage rejects (degrades to usageAvailable=false)", async () => {
      const { budgets } = makeBudgets({
        config: { enabled: true, daily: { totalUSD: 10 } },
        usage: async () => {
          throw new Error("source exploded");
        },
      });
      const status = await budgets.getStatus();
      assert.strictEqual(status.enabled, true);
      assert.strictEqual(status.periods.daily.usageAvailable, false);
    });

    it("shares the OpenRouter baseline with the evaluator (same window delta)", async () => {
      let cumulative = 100;
      const { budgets } = makeBudgets({
        config: { enabled: true, daily: { totalUSD: 10 } },
        usage: async () => ({ openrouterCumulativeUSD: cumulative }),
      });
      await budgets.evaluate(); // baseline = 100
      cumulative = 103.5;
      const status = await budgets.getStatus();
      assert.strictEqual(status.periods.daily.scopes[0].spentUSD, 3.5);
      assert.strictEqual(status.periods.daily.scopes[0].percent, 35);
    });
  });

  describe("createUsageProvider()", () => {
    function stubUsageSources({ nineRows = null, totalUsage = null, windows = null } = {}) {
      return {
        sources: {
          nineRouter: {
            describe: () => ({ available: nineRows !== null }),
            getUsage: async () => ({ byProvider: nineRows || [] }),
          },
          openrouter: {
            available: totalUsage !== null,
            getCredits: async () => ({ totalUsage }),
          },
          claudeCode: {
            describe: () => ({ available: windows !== null }),
            getUsageWindows: async () => ({ available: true, ...windows }),
          },
        },
      };
    }

    it("maps nine-router byProvider rows, openrouter credits, and claude windows", async () => {
      const getUsage = createUsageProvider({
        usageSources: stubUsageSources({
          nineRows: [
            { provider: "kimi", cost: 1.25 },
            { provider: "glm", cost: 0.5 },
          ],
          totalUsage: 42.5,
          windows: { h24: { estCost: 3.1 }, d7: { estCost: 9.9 } },
        }),
      });

      const daily = await getUsage({ sinceMs: 0, period: "daily" });
      assert.deepStrictEqual(daily.nineRouterByProvider, { kimi: 1.25, glm: 0.5 });
      assert.strictEqual(daily.openrouterCumulativeUSD, 42.5);
      assert.strictEqual(daily.claudeCodeUSD, 3.1);

      const weekly = await getUsage({ sinceMs: 0, period: "weekly" });
      assert.strictEqual(weekly.claudeCodeUSD, 9.9);
    });

    it("drops unavailable sources instead of failing", async () => {
      const getUsage = createUsageProvider({ usageSources: stubUsageSources() });
      assert.deepStrictEqual(await getUsage({ sinceMs: 0, period: "daily" }), {});
    });

    it("survives a throwing source", async () => {
      const stub = stubUsageSources({ nineRows: [] });
      stub.sources.nineRouter.getUsage = async () => {
        throw new Error("db locked");
      };
      const getUsage = createUsageProvider({ usageSources: stub });
      const result = await getUsage({ sinceMs: 0, period: "daily" });
      assert.strictEqual(result.nineRouterByProvider, undefined);
    });

    it("requires a usageSources instance", () => {
      assert.throws(() => createUsageProvider({}), /usageSources/);
    });
  });
});
