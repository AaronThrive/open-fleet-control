const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  TOKEN_RATES,
  emptyUsageBucket,
  addUsageToBucket,
  addUsageToModelMap,
  summarizeModelUsage,
  calculateCostForBucket,
  refreshTokenUsageAsync,
  getDailyTokenUsage,
  getCostBreakdown,
} = require("../src/tokens");

describe("tokens module", () => {
  describe("TOKEN_RATES", () => {
    it("has input rate", () => {
      assert.strictEqual(TOKEN_RATES.input, 15.0);
    });

    it("has output rate", () => {
      assert.strictEqual(TOKEN_RATES.output, 75.0);
    });

    it("has cache read rate", () => {
      assert.strictEqual(TOKEN_RATES.cacheRead, 1.5);
    });

    it("has cache write rate", () => {
      assert.strictEqual(TOKEN_RATES.cacheWrite, 18.75);
    });
  });

  describe("emptyUsageBucket()", () => {
    it("returns object with zero values", () => {
      const bucket = emptyUsageBucket();
      assert.strictEqual(bucket.input, 0);
      assert.strictEqual(bucket.output, 0);
      assert.strictEqual(bucket.cacheRead, 0);
      assert.strictEqual(bucket.cacheWrite, 0);
      assert.strictEqual(bucket.cost, 0);
      assert.strictEqual(bucket.requests, 0);
    });

    it("returns a new object each time", () => {
      const a = emptyUsageBucket();
      const b = emptyUsageBucket();
      assert.notStrictEqual(a, b);
      a.input = 100;
      assert.strictEqual(b.input, 0);
    });
  });

  describe("calculateCostForBucket()", () => {
    it("calculates cost for given token counts", () => {
      const bucket = {
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
      };
      const result = calculateCostForBucket(bucket);
      assert.strictEqual(result.inputCost, 15.0);
      assert.strictEqual(result.outputCost, 75.0);
      assert.strictEqual(result.cacheReadCost, 1.5);
      assert.strictEqual(result.cacheWriteCost, 18.75);
      assert.strictEqual(result.totalCost, 15.0 + 75.0 + 1.5 + 18.75);
    });

    it("returns zero cost for empty bucket", () => {
      const bucket = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const result = calculateCostForBucket(bucket);
      assert.strictEqual(result.totalCost, 0);
    });

    it("accepts custom rates", () => {
      const bucket = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
      const customRates = { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 };
      const result = calculateCostForBucket(bucket, customRates);
      assert.strictEqual(result.inputCost, 10.0);
      assert.strictEqual(result.totalCost, 10.0);
    });

    it("calculates proportionally for partial token counts", () => {
      const bucket = { input: 500_000, output: 0, cacheRead: 0, cacheWrite: 0 };
      const result = calculateCostForBucket(bucket);
      assert.strictEqual(result.inputCost, 7.5);
    });
  });

  describe("addUsageToBucket()", () => {
    it("accumulates token counts, reported cost, and requests", () => {
      const bucket = emptyUsageBucket();
      addUsageToBucket(bucket, {
        input: 100,
        output: 50,
        cacheRead: 1000,
        cacheWrite: 200,
        cost: { total: 0.5 },
      });
      addUsageToBucket(bucket, { input: 10, output: 5 });

      assert.strictEqual(bucket.input, 110);
      assert.strictEqual(bucket.output, 55);
      assert.strictEqual(bucket.cacheRead, 1000);
      assert.strictEqual(bucket.cacheWrite, 200);
      assert.strictEqual(bucket.cost, 0.5);
      assert.strictEqual(bucket.requests, 2);
    });
  });

  describe("addUsageToModelMap()", () => {
    it("groups usage by model and defaults missing models to 'unknown'", () => {
      const map = {};
      addUsageToModelMap(map, "claude-opus-4", { input: 100, output: 10 });
      addUsageToModelMap(map, "claude-opus-4", { input: 50, output: 5 });
      addUsageToModelMap(map, "gpt-5.5", { input: 7, output: 3, cacheRead: 99 });
      addUsageToModelMap(map, null, { input: 1, output: 1 });

      assert.strictEqual(map["claude-opus-4"].input, 150);
      assert.strictEqual(map["claude-opus-4"].requests, 2);
      assert.strictEqual(map["gpt-5.5"].cacheRead, 99);
      assert.strictEqual(map.unknown.input, 1);
    });
  });

  describe("summarizeModelUsage()", () => {
    it("returns models sorted by cost with distinct cache read/write counts", () => {
      const map = {};
      addUsageToModelMap(map, "cheap-model", { input: 1000, output: 100 });
      addUsageToModelMap(map, "big-model", {
        input: 1_000_000,
        output: 100_000,
        cacheRead: 2_000_000,
        cacheWrite: 500_000,
      });

      const summary = summarizeModelUsage(map);
      assert.strictEqual(summary.length, 2);
      assert.strictEqual(summary[0].model, "big-model", "sorted by cost desc");
      assert.strictEqual(summary[0].cacheRead, 2_000_000);
      assert.strictEqual(summary[0].cacheWrite, 500_000);
      // 1M*$15 + 0.1M*$75 + 2M*$1.50 + 0.5M*$18.75 = 15 + 7.5 + 3 + 9.375
      assert.ok(Math.abs(summary[0].estCost - 34.875) < 1e-9);
      assert.strictEqual(summary[0].reportedCost, 0);
      assert.strictEqual(summary[0].cost, summary[0].estCost, "falls back to estimate");
    });

    it("prefers the provider-reported cost when present", () => {
      const map = {};
      addUsageToModelMap(map, "model-a", { input: 1000, output: 100, cost: { total: 1.25 } });

      const summary = summarizeModelUsage(map);
      assert.strictEqual(summary[0].reportedCost, 1.25);
      assert.strictEqual(summary[0].cost, 1.25);
    });

    it("handles an empty or missing map", () => {
      assert.deepStrictEqual(summarizeModelUsage({}), []);
      assert.deepStrictEqual(summarizeModelUsage(undefined), []);
    });
  });

  describe("per-model usage refresh + cost breakdown (temp sessions dir)", () => {
    it("aggregates byModel per window and exposes it via getCostBreakdown", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofc-tokens-test-"));
      const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });

      const now = Date.now();
      const hoursAgo = (h) => new Date(now - h * 3600 * 1000).toISOString();
      const entry = (ts, model, usage) =>
        JSON.stringify({ timestamp: ts, message: { model, usage } });

      const lines = [
        // Within 24h
        entry(hoursAgo(1), "claude-opus-4", {
          input: 1000,
          output: 200,
          cacheRead: 5000,
          cacheWrite: 300,
          cost: { total: 0.1 },
        }),
        entry(hoursAgo(2), "gpt-5.5", { input: 400, output: 40, cacheRead: 800, cacheWrite: 0 }),
        // Older than 24h but within 3d
        entry(hoursAgo(48), "claude-opus-4", { input: 2000, output: 100 }),
        // Older than 3d but within 7d
        entry(hoursAgo(120), "gpt-5.5", { input: 10_000, output: 1000 }),
      ];
      fs.writeFileSync(path.join(sessionsDir, "test-session.jsonl"), lines.join("\n") + "\n");

      try {
        await refreshTokenUsageAsync(() => tmpDir);
        const usage = getDailyTokenUsage(() => tmpDir);

        // 24h window: both models present
        const m24 = usage.windows["24h"].byModel;
        assert.strictEqual(m24["claude-opus-4"].input, 1000);
        assert.strictEqual(m24["claude-opus-4"].cacheRead, 5000);
        assert.strictEqual(m24["claude-opus-4"].cacheWrite, 300);
        assert.strictEqual(m24["gpt-5.5"].requests, 1);

        // 3d window includes the 48h-old opus entry
        assert.strictEqual(usage.windows["3d"].byModel["claude-opus-4"].input, 3000);

        // 7d window includes everything
        assert.strictEqual(usage.windows["7d"].byModel["gpt-5.5"].input, 10_400);

        // getCostBreakdown surfaces sorted byModel arrays per window
        const breakdown = getCostBreakdown(
          {},
          () => [],
          () => tmpDir,
        );
        const by24 = breakdown.windows["24h"].byModel;
        assert.ok(Array.isArray(by24));
        assert.strictEqual(by24.length, 2);
        const opus = by24.find((m) => m.model === "claude-opus-4");
        assert.strictEqual(opus.cacheRead, 5000);
        assert.strictEqual(opus.reportedCost, 0.1);
        assert.strictEqual(opus.cost, 0.1, "uses honest reported cost when available");

        const by7 = breakdown.windows["7d"].byModel;
        assert.strictEqual(by7.length, 2);
        const gpt7 = by7.find((m) => m.model === "gpt-5.5");
        assert.ok(gpt7.estCost > 0);
        assert.strictEqual(gpt7.cost, gpt7.estCost, "estimates when no reported cost");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
