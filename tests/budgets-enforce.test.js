/**
 * Unit tests for the v2.2 budget guardrails in src/budgets.js:
 * dispatch blocking (checkDispatchBlock), operator acknowledgement (ack),
 * window-roll expiry, and the spend-source wiring that fixes the v2.0
 * usageAvailable:false issue (createUsageProvider → evaluator → gauges).
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createBudgets, createUsageProvider } = require("../src/budgets");

// Wednesday 2026-06-10T12:00:00Z
const NOW = Date.UTC(2026, 5, 10, 12, 0, 0);
const DAY = 86400000;

const silentLog = { log: () => {}, warn: () => {}, error: () => {} };

let tmpDir;
let stateFile;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofc-enforce-"));
  stateFile = path.join(tmpDir, "budgets.json");
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeBudgets({ config, usage, now = NOW } = {}) {
  const clock = { now };
  const breaches = [];
  const budgets = createBudgets({
    config,
    stateFile,
    getUsage: typeof usage === "function" ? usage : async () => usage,
    onBreach: (breach) => breaches.push(breach),
    nowFn: () => clock.now,
    log: silentLog,
  });
  return { budgets, breaches, clock };
}

const ENFORCED = {
  enabled: true,
  daily: { totalUSD: 10 },
  enforce: { enabled: true },
};

describe("budget guardrails (enforce)", () => {
  describe("checkDispatchBlock()", () => {
    it("blocks after an evaluation sees a scope at >=100%", async () => {
      const { budgets } = makeBudgets({
        config: ENFORCED,
        usage: { nineRouterByProvider: { kimi: 12 } },
      });
      assert.strictEqual(budgets.checkDispatchBlock(), null); // nothing evaluated yet
      await budgets.evaluate();
      assert.deepStrictEqual(budgets.checkDispatchBlock(), {
        scope: "total",
        spent: 12,
        limit: 10,
        period: "daily",
        periodKey: "2026-06-10",
      });
    });

    it("does not block below 100% (warn level included)", async () => {
      const { budgets } = makeBudgets({
        config: ENFORCED,
        usage: { nineRouterByProvider: { kimi: 9.5 } },
      });
      await budgets.evaluate();
      assert.strictEqual(budgets.checkDispatchBlock(), null);
    });

    it("does not block when enforce is disabled, even over budget", async () => {
      const { budgets } = makeBudgets({
        config: { enabled: true, daily: { totalUSD: 10 } }, // enforce default OFF
        usage: { nineRouterByProvider: { kimi: 12 } },
      });
      await budgets.evaluate();
      assert.strictEqual(budgets.checkDispatchBlock(), null);
    });

    it("blocks on per-provider scopes too", async () => {
      const { budgets } = makeBudgets({
        config: {
          enabled: true,
          daily: { totalUSD: 0, perProvider: { kimi: 2 } },
          enforce: { enabled: true },
        },
        usage: { nineRouterByProvider: { kimi: 3 } },
      });
      await budgets.evaluate();
      assert.strictEqual(budgets.checkDispatchBlock().scope, "provider:kimi");
    });

    it("getStatus() refreshes the block registry (gauges and guard agree)", async () => {
      let spend = 5;
      const { budgets } = makeBudgets({
        config: ENFORCED,
        usage: async () => ({ nineRouterByProvider: { kimi: spend } }),
      });
      await budgets.evaluate();
      assert.strictEqual(budgets.checkDispatchBlock(), null);

      spend = 11; // crosses 100% between evaluator passes
      await budgets.getStatus();
      assert.strictEqual(budgets.checkDispatchBlock().spent, 11);

      spend = 4; // window reset / source correction → unblocks
      await budgets.getStatus();
      assert.strictEqual(budgets.checkDispatchBlock(), null);
    });

    it("clears automatically when the budget window rolls over", async () => {
      const { budgets, clock } = makeBudgets({
        config: ENFORCED,
        usage: { nineRouterByProvider: { kimi: 12 } },
      });
      await budgets.evaluate();
      assert.ok(budgets.checkDispatchBlock());

      clock.now = NOW + DAY; // next UTC day → new daily window
      assert.strictEqual(budgets.checkDispatchBlock(), null);
    });
  });

  describe("ack()", () => {
    it("clears the block for the current window and reports what was acked", async () => {
      const { budgets } = makeBudgets({
        config: ENFORCED,
        usage: { nineRouterByProvider: { kimi: 12 } },
      });
      await budgets.evaluate();
      assert.ok(budgets.checkDispatchBlock());

      const result = budgets.ack("operator@example.com");
      assert.deepStrictEqual(result, { acked: ["daily:2026-06-10"] });
      assert.strictEqual(budgets.checkDispatchBlock(), null);
    });

    it("acks nothing when nothing is blocked", async () => {
      const { budgets } = makeBudgets({
        config: ENFORCED,
        usage: { nineRouterByProvider: { kimi: 1 } },
      });
      await budgets.evaluate();
      assert.deepStrictEqual(budgets.ack("operator"), { acked: [] });
    });

    it("persists acks across a restart within the same window", async () => {
      const first = makeBudgets({
        config: ENFORCED,
        usage: { nineRouterByProvider: { kimi: 12 } },
      });
      await first.budgets.evaluate();
      first.budgets.ack("operator");

      // Restart: fresh instance over the same state file re-evaluates the
      // over-budget spend but honors the persisted ack.
      const second = makeBudgets({
        config: ENFORCED,
        usage: { nineRouterByProvider: { kimi: 12 } },
      });
      await second.budgets.evaluate();
      assert.strictEqual(second.budgets.checkDispatchBlock(), null);
    });

    it("expires acks when the window rolls (a NEW breach blocks again)", async () => {
      const { budgets, clock } = makeBudgets({
        config: ENFORCED,
        usage: { nineRouterByProvider: { kimi: 12 } },
      });
      await budgets.evaluate();
      budgets.ack("operator");
      assert.strictEqual(budgets.checkDispatchBlock(), null);

      clock.now = NOW + DAY; // next day: ack pruned, breach re-detected
      await budgets.evaluate();
      assert.strictEqual(budgets.checkDispatchBlock().periodKey, "2026-06-11");
    });
  });

  describe("getStatus() enforcement reporting", () => {
    it("exposes enforcement state alongside the gauges", async () => {
      const { budgets } = makeBudgets({
        config: ENFORCED,
        usage: { nineRouterByProvider: { kimi: 12 } },
      });
      await budgets.evaluate();
      budgets.ack("operator@example.com");
      const status = await budgets.getStatus();

      assert.strictEqual(status.enforcement.enabled, true);
      assert.deepStrictEqual(status.enforcement.blocked, [
        {
          period: "daily",
          periodKey: "2026-06-10",
          scope: "total",
          limitUSD: 10,
          spentUSD: 12,
          acked: true,
        },
      ]);
      assert.strictEqual(status.enforcement.acks.length, 1);
      assert.strictEqual(status.enforcement.acks[0].window, "daily:2026-06-10");
      assert.strictEqual(status.enforcement.acks[0].by, "operator@example.com");
    });
  });

  describe("spend-source wiring (v2.0 usageAvailable:false root cause)", () => {
    function stubUsageSources() {
      return {
        sources: {
          nineRouter: {
            describe: () => ({ available: true }),
            getUsage: async () => ({
              byProvider: [
                { provider: "kimi", cost: 7 },
                { provider: "glm", cost: 5 },
              ],
            }),
          },
          openrouter: { available: false },
          claudeCode: { describe: () => ({ available: false }) },
        },
      };
    }

    it("createUsageProvider feeds the evaluator: gauges report usageAvailable:true and real spend", async () => {
      const { budgets, breaches } = makeBudgets({
        config: ENFORCED,
        usage: createUsageProvider({ usageSources: stubUsageSources() }),
      });
      const status = await budgets.getStatus();
      assert.strictEqual(status.periods.daily.usageAvailable, true);
      assert.deepStrictEqual(status.periods.daily.scopes[0], {
        scope: "total",
        limitUSD: 10,
        spentUSD: 12,
        percent: 120,
        state: "critical",
      });

      await budgets.evaluate();
      // Critical implies warn — a single critical breach fires once.
      assert.strictEqual(breaches.length, 1);
      assert.strictEqual(breaches[0].severity, "critical");
      assert.deepStrictEqual(budgets.checkDispatchBlock().spent, 12);
    });

    it("src/index.js wires the provider into the fleet runtime (regression guard)", () => {
      const indexSource = fs.readFileSync(path.join(__dirname, "..", "src", "index.js"), "utf8");
      assert.match(
        indexSource,
        /fleet\.setUsageProvider\(createUsageProvider\(\{ usageSources \}\)\)/,
        "src/index.js must wire fleet.setUsageProvider(createUsageProvider({ usageSources }))",
      );
      assert.match(indexSource, /fleet\.setDigestSources\(/);
    });
  });
});
