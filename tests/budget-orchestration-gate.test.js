/**
 * Unit tests for the OPEN/CLOSED orchestration mode gate in src/budgets.js:
 *   - checkOrchestrationBlock({ mode, ceiling, spentUSD, projectedUSD })
 *   - normalizeBudgetsConfig allowOpen / closedCeilingUSD defaults
 *
 * OPEN is refused unless allowOpen=true (403-class "open-mode-disabled");
 * CLOSED enforces a per-orchestration ceiling (429-class
 * "closed-ceiling-exceeded"); unknown modes fail closed to CLOSED; the gate is
 * independent of cfg.enabled/enforce (it governs a single run's mode).
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createBudgets, normalizeBudgetsConfig } = require("../src/budgets");

const silentLog = { log: () => {}, warn: () => {}, error: () => {} };

function makeBudgets(config) {
  return createBudgets({
    config,
    getUsage: async () => ({}),
    onBreach: () => {},
    log: silentLog,
  });
}

describe("normalizeBudgetsConfig — orchestration keys", () => {
  it("defaults allowOpen=false and closedCeilingUSD=0 (safe)", () => {
    const cfg = normalizeBudgetsConfig({});
    assert.strictEqual(cfg.allowOpen, false);
    assert.strictEqual(cfg.closedCeilingUSD, 0);
  });
  it("only treats allowOpen===true as true, coerces ceiling", () => {
    assert.strictEqual(normalizeBudgetsConfig({ allowOpen: "yes" }).allowOpen, false);
    assert.strictEqual(normalizeBudgetsConfig({ allowOpen: true }).allowOpen, true);
    assert.strictEqual(normalizeBudgetsConfig({ closedCeilingUSD: 2.5 }).closedCeilingUSD, 2.5);
    assert.strictEqual(normalizeBudgetsConfig({ closedCeilingUSD: -1 }).closedCeilingUSD, 0);
    assert.strictEqual(normalizeBudgetsConfig({ closedCeilingUSD: "x" }).closedCeilingUSD, 0);
  });
});

describe("checkOrchestrationBlock()", () => {
  describe("OPEN mode", () => {
    it("refuses OPEN when allowOpen is off (default)", () => {
      const b = makeBudgets({});
      const block = b.checkOrchestrationBlock({ mode: "open" });
      assert.ok(block);
      assert.strictEqual(block.reason, "open-mode-disabled");
      assert.strictEqual(block.mode, "open");
    });
    it("allows OPEN (no per-run ceiling) once allowOpen is true", () => {
      const b = makeBudgets({ allowOpen: true });
      assert.strictEqual(b.checkOrchestrationBlock({ mode: "open", spentUSD: 9999 }), null);
    });
  });

  describe("CLOSED mode", () => {
    it("allows when under the per-task ceiling", () => {
      const b = makeBudgets({ closedCeilingUSD: 2 });
      assert.strictEqual(b.checkOrchestrationBlock({ mode: "closed", spentUSD: 1 }), null);
    });
    it("refuses on the pre-check when projected reaches the ceiling", () => {
      const b = makeBudgets({ closedCeilingUSD: 2 });
      const block = b.checkOrchestrationBlock({
        mode: "closed",
        spentUSD: 1.5,
        projectedUSD: 1,
      });
      assert.ok(block);
      assert.strictEqual(block.reason, "closed-ceiling-exceeded");
      assert.strictEqual(block.ceiling, 2);
    });
    it("refuses mid-run when accrued spend reaches the ceiling", () => {
      const b = makeBudgets({ closedCeilingUSD: 2 });
      const block = b.checkOrchestrationBlock({ mode: "closed", spentUSD: 2 });
      assert.ok(block);
      assert.strictEqual(block.reason, "closed-ceiling-exceeded");
      assert.strictEqual(block.spent, 2);
    });
    it("honors a per-call ceiling override above the config default", () => {
      const b = makeBudgets({ closedCeilingUSD: 2 });
      // override raises the cap to 10 → 3 spent is fine
      assert.strictEqual(b.checkOrchestrationBlock({ mode: "closed", ceiling: 10, spentUSD: 3 }), null);
    });
    it("imposes NO per-task ceiling when both config + override are 0/absent", () => {
      const b = makeBudgets({});
      assert.strictEqual(b.checkOrchestrationBlock({ mode: "closed", spentUSD: 9999 }), null);
    });
  });

  describe("defaults + fail-safe", () => {
    it("defaults to CLOSED when mode is omitted", () => {
      const b = makeBudgets({ closedCeilingUSD: 2 });
      const block = b.checkOrchestrationBlock({ spentUSD: 5 });
      assert.strictEqual(block.mode, "closed");
    });
    it("fails closed (CLOSED) on an unknown mode string", () => {
      const b = makeBudgets({ closedCeilingUSD: 2, allowOpen: true });
      // "wild" is not "open" → treated as CLOSED → ceiling enforced
      const block = b.checkOrchestrationBlock({ mode: "wild", spentUSD: 5 });
      assert.ok(block);
      assert.strictEqual(block.mode, "closed");
    });
    it("is exported alongside checkDispatchBlock + ack", () => {
      const b = makeBudgets({});
      assert.strictEqual(typeof b.checkOrchestrationBlock, "function");
      assert.strictEqual(typeof b.checkDispatchBlock, "function");
      assert.strictEqual(typeof b.ack, "function");
    });
  });
});
