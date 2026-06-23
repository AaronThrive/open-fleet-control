const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createPlanUsageSource } = require("../src/usage-sources/plan-usage");

const POLLED_AT = "2026-06-10T15:40:43Z";
const POLLED_MS = Date.parse(POLLED_AT);
const MINUTE = 60 * 1000;

const CODEX_BLOCK = {
  available: true,
  plan_type: "prolite",
  five_hour: { utilization_pct: 42, resets_at: "2026-06-10T19:30:00Z" },
  seven_day: { utilization_pct: 18, resets_at: Math.floor(POLLED_MS / 1000) + 86400 },
  credits: { balance: 12.5, has_credits: true, unlimited: false },
  polled_at: POLLED_AT,
  stale: false,
};

const FIXTURE = {
  latest: {
    five_hour: {
      utilization_pct: 28,
      resets_at: "2026-06-10T19:30:00Z",
      seconds_to_reset: 13756.5,
    },
    seven_day: {
      utilization_pct: 12,
      resets_at: "2026-06-13T02:00:00Z",
      seconds_to_reset: 209956.5,
    },
    seven_day_sonnet: { utilization_pct: 0, resets_at: null, seconds_to_reset: null },
    extra_usage: {
      is_enabled: true,
      monthly_limit_usd: 100,
      used_credits_usd: 3.92,
      utilization_pct: 3.92,
    },
    polled_at: POLLED_AT,
    token_prefix: "sk-ant-o", // key material — must never appear in output
  },
  window_tokens: {
    input: 189384,
    output: 197106,
    cache_reads: 42417777,
    cache_writes_5m: 1427861,
    cache_writes_1h: 963073,
    cache_writes_total: 2390934,
    total_raw: 45195201,
    weighted_token_equivalent: 41307009.5,
    by_model: {
      "claude-fable-5": {
        input: 189143,
        output: 175728,
        cache_reads: 35075259,
        cache_writes_total: 1978688,
      },
      "claude-haiku-4-5": {
        input: 241,
        output: 21378,
        cache_reads: 7342518,
        cache_writes_total: 412246,
      },
    },
  },
  codex: CODEX_BLOCK,
};

describe("usage-sources/plan-usage", () => {
  let tmpDir;
  let statsPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-plan-usage-test-"));
    statsPath = path.join(tmpDir, "subscription_state.json");
    fs.writeFileSync(statsPath, JSON.stringify(FIXTURE));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports unavailable for a missing file without throwing", async () => {
    const source = createPlanUsageSource({ statsPath: path.join(tmpDir, "nope.json") });
    assert.strictEqual(source.available, false);
    assert.ok(source.reason.includes("file not found"));
    const sub = await source.getSubscription();
    assert.strictEqual(sub.available, false);
  });

  it("reports unavailable for corrupt JSON", async () => {
    const corrupt = path.join(tmpDir, "corrupt.json");
    fs.writeFileSync(corrupt, "{nope");
    const sub = await createPlanUsageSource({ statsPath: corrupt }).getSubscription();
    assert.strictEqual(sub.available, false);
    assert.ok(sub.reason.includes("unreadable"));
  });

  describe("getSubscription()", () => {
    it("normalizes windows, extra usage, window tokens, and by-model", async () => {
      const source = createPlanUsageSource({ statsPath, nowFn: () => POLLED_MS + 5 * MINUTE });
      const sub = await source.getSubscription();

      assert.strictEqual(sub.available, true);
      assert.deepStrictEqual(sub.fiveHour, {
        utilizationPct: 28,
        resetsAt: "2026-06-10T19:30:00Z",
        secondsToReset: 13756.5,
      });
      assert.strictEqual(sub.sevenDay.utilizationPct, 12);
      assert.deepStrictEqual(sub.sevenDaySonnet, {
        utilizationPct: 0,
        resetsAt: null,
        secondsToReset: null,
      });
      assert.deepStrictEqual(sub.extraUsage, {
        isEnabled: true,
        monthlyLimitUsd: 100,
        usedCreditsUsd: 3.92,
        utilizationPct: 3.92,
      });
      assert.deepStrictEqual(sub.windowTokens, {
        input: 189384,
        output: 197106,
        cacheReads: 42417777,
        cacheWritesTotal: 2390934,
        totalRaw: 45195201,
        weightedTokenEquivalent: 41307009.5,
      });
      assert.deepStrictEqual(Object.keys(sub.byModel).sort(), [
        "claude-fable-5",
        "claude-haiku-4-5",
      ]);
      assert.strictEqual(sub.byModel["claude-haiku-4-5"].output, 21378);
      assert.strictEqual(sub.polledAt, POLLED_AT);
    });

    it("flags fresh data as not stale and >30min-old data as stale", async () => {
      const fresh = await createPlanUsageSource({
        statsPath,
        nowFn: () => POLLED_MS + 29 * MINUTE,
      }).getSubscription();
      assert.strictEqual(fresh.stale, false);

      const stale = await createPlanUsageSource({
        statsPath,
        nowFn: () => POLLED_MS + 31 * MINUTE,
      }).getSubscription();
      assert.strictEqual(stale.stale, true);
    });

    it("treats a missing/unparseable polled_at as stale", async () => {
      const noPoll = path.join(tmpDir, "no-poll.json");
      fs.writeFileSync(noPoll, JSON.stringify({ latest: {}, window_tokens: {} }));
      const sub = await createPlanUsageSource({ statsPath: noPoll }).getSubscription();
      assert.strictEqual(sub.available, true);
      assert.strictEqual(sub.stale, true);
      assert.strictEqual(sub.polledAt, null);
    });

    it("NEVER returns the token_prefix key material", async () => {
      const sub = await createPlanUsageSource({ statsPath }).getSubscription();
      const serialized = JSON.stringify(sub);
      assert.ok(!serialized.includes("sk-ant"), "token prefix leaked into output");
      assert.ok(!serialized.includes("token_prefix"));
    });

    it("tolerates missing sections with nulls instead of throwing", async () => {
      const sparse = path.join(tmpDir, "sparse.json");
      fs.writeFileSync(sparse, JSON.stringify({ latest: { polled_at: POLLED_AT } }));
      const sub = await createPlanUsageSource({
        statsPath: sparse,
        nowFn: () => POLLED_MS,
      }).getSubscription();
      assert.strictEqual(sub.available, true);
      assert.strictEqual(sub.fiveHour, null);
      assert.strictEqual(sub.extraUsage, null);
      assert.deepStrictEqual(sub.byModel, {});
      assert.strictEqual(sub.windowTokens.totalRaw, 0);
    });
  });

  describe("getCodex()", () => {
    it("normalizes the codex block snake_case -> camelCase", async () => {
      const codex = await createPlanUsageSource({
        statsPath,
        nowFn: () => POLLED_MS,
      }).getCodex();

      assert.strictEqual(codex.available, true);
      assert.strictEqual(codex.planType, "prolite");
      assert.deepStrictEqual(codex.fiveHour, {
        utilizationPct: 42,
        resetsAt: "2026-06-10T19:30:00Z",
      });
      assert.strictEqual(codex.sevenDay.utilizationPct, 18);
      assert.deepStrictEqual(codex.credits, {
        balance: 12.5,
        hasCredits: true,
        unlimited: false,
      });
      assert.strictEqual(codex.polledAt, POLLED_AT);
      assert.strictEqual(codex.stale, false);
    });

    it("degrades gracefully when the codex block is absent", async () => {
      const noCodex = path.join(tmpDir, "no-codex.json");
      fs.writeFileSync(noCodex, JSON.stringify({ latest: { polled_at: POLLED_AT } }));
      const codex = await createPlanUsageSource({ statsPath: noCodex }).getCodex();
      assert.strictEqual(codex.available, false);
      assert.ok(codex.reason.includes("no codex block"));
    });

    it("reports unavailable when the codex poller flags available:false", async () => {
      const off = path.join(tmpDir, "codex-off.json");
      fs.writeFileSync(off, JSON.stringify({ codex: { available: false } }));
      const codex = await createPlanUsageSource({ statsPath: off }).getCodex();
      assert.strictEqual(codex.available, false);
    });

    it("honors an explicit stale flag and falls back to age otherwise", async () => {
      const explicit = await createPlanUsageSource({
        statsPath,
        nowFn: () => POLLED_MS + 31 * MINUTE, // old, but block says stale:false
      }).getCodex();
      assert.strictEqual(explicit.stale, false);

      const noFlag = path.join(tmpDir, "codex-noflag.json");
      fs.writeFileSync(
        noFlag,
        JSON.stringify({ codex: { available: true, polled_at: POLLED_AT } }),
      );
      const derived = await createPlanUsageSource({
        statsPath: noFlag,
        nowFn: () => POLLED_MS + 31 * MINUTE,
      }).getCodex();
      assert.strictEqual(derived.stale, true);
    });

    it("returns unavailable for a missing file without throwing", async () => {
      const codex = await createPlanUsageSource({
        statsPath: path.join(tmpDir, "nope-codex.json"),
      }).getCodex();
      assert.strictEqual(codex.available, false);
    });
  });
});
