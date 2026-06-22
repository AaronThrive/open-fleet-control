/**
 * Tests for the pure (DOM-free) row builders used by the v2.2 Tokens view
 * detail-lists: windowRows (cost-breakdown windows), dailySummaryNumbers /
 * dailyRowsFrom (9Router daily rollups), and sourceRowsFrom (totals by
 * source). The module is browser ESM, so it is loaded via dynamic import.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert");

let windowRows;
let dailySummaryNumbers;
let dailyRowsFrom;
let sourceRowsFrom;
let planLinesFrom;

before(async () => {
  const mod = await import("../public/js/views/tokens.js");
  windowRows = mod.windowRows;
  dailySummaryNumbers = mod.dailySummaryNumbers;
  dailyRowsFrom = mod.dailyRowsFrom;
  sourceRowsFrom = mod.sourceRowsFrom;
  planLinesFrom = mod.planLinesFrom;
});

describe("tokens view row builders", () => {
  describe("windowRows()", () => {
    it("builds one row per known window with summed tokens", () => {
      const rows = windowRows({
        windows: {
          "24h": {
            marginalCost: 1.5,
            requests: 10,
            hypotheticalCost: 45,
            tokens: { input: 100, output: 50, cacheRead: 25, cacheWrite: 25 },
          },
          "7d": { marginalCost: 9, requests: 70, tokens: {} },
        },
      });
      assert.strictEqual(rows.length, 2);
      assert.strictEqual(rows[0].key, "24h");
      assert.strictEqual(rows[0].tokens, 200);
      assert.strictEqual(rows[0].marginal, 1.5);
      assert.strictEqual(rows[0].hypothetical, 45);
      assert.strictEqual(rows[1].key, "7d");
      assert.strictEqual(rows[1].tokens, 0);
      assert.strictEqual(rows[1].hypothetical, 0);
    });

    it("returns [] for missing/malformed payloads", () => {
      assert.deepStrictEqual(windowRows(null), []);
      assert.deepStrictEqual(windowRows({}), []);
    });

    it("includes the 30d window when present", () => {
      const rows = windowRows({
        windows: {
          "24h": { marginalCost: 1, requests: 1, tokens: {} },
          "30d": { marginalCost: 30, requests: 300, hypotheticalCost: 900, tokens: {} },
        },
      });
      const keys = rows.map((r) => r.key);
      assert.ok(keys.includes("30d"));
      const thirty = rows.find((r) => r.key === "30d");
      assert.strictEqual(thirty.marginal, 30);
      assert.strictEqual(thirty.hypothetical, 900);
    });
  });

  describe("planLinesFrom()", () => {
    it("extracts per-plan flat-fee lines for a window", () => {
      const lines = planLinesFrom(
        {
          windows: {
            "24h": {
              plans: [
                {
                  id: "claude",
                  label: "Claude Code Max",
                  planCost: 200,
                  hypotheticalMonthly: 500,
                  marginalMonthly: 0,
                  actualMonthlySpend: 200,
                  requests: 12,
                },
                {
                  id: "codex",
                  label: "Codex subscription",
                  planCost: 200,
                  hypotheticalMonthly: 120,
                  marginalMonthly: 5,
                  actualMonthlySpend: 205,
                  requests: 4,
                },
              ],
            },
          },
        },
        "24h",
      );
      assert.strictEqual(lines.length, 2);
      assert.strictEqual(lines[0].id, "claude");
      assert.strictEqual(lines[0].planCost, 200);
      assert.strictEqual(lines[0].hypotheticalMonthly, 500);
      assert.strictEqual(lines[1].id, "codex");
      assert.strictEqual(lines[1].marginalMonthly, 5);
    });

    it("falls back to top-level plans and returns [] when absent", () => {
      const fromTop = planLinesFrom({ plans: [{ id: "claude", planCost: 200 }] }, "24h");
      assert.strictEqual(fromTop.length, 1);
      assert.strictEqual(fromTop[0].planCost, 200);
      assert.deepStrictEqual(planLinesFrom(null, "24h"), []);
      assert.deepStrictEqual(planLinesFrom({}, "24h"), []);
    });
  });

  describe("dailySummaryNumbers()", () => {
    it("reads flat summary blobs", () => {
      assert.deepStrictEqual(dailySummaryNumbers({ totalTokens: 1950, cost: 0.53, requests: 3 }), {
        requests: 3,
        tokens: 1950,
        cost: 0.53,
      });
    });

    it("reads nested totals blobs and tolerates garbage", () => {
      assert.deepStrictEqual(
        dailySummaryNumbers({ totals: { tokens: 10, cost: "0.1", requests: 1 } }),
        { requests: 1, tokens: 10, cost: 0.1 },
      );
      assert.deepStrictEqual(dailySummaryNumbers(null), {
        requests: null,
        tokens: null,
        cost: null,
      });
      assert.deepStrictEqual(dailySummaryNumbers({ cost: "broken" }), {
        requests: null,
        tokens: null,
        cost: null,
      });
    });
  });

  describe("dailyRowsFrom()", () => {
    it("maps 9Router daily days into rows", () => {
      const rows = dailyRowsFrom({
        nineRouter: {
          available: true,
          daily: {
            days: [
              { date: "2026-06-10", summary: { totalTokens: 1950, cost: 0.53, requests: 3 } },
              { date: "2026-06-09", note: "unparseable data blob" },
              { bogus: true },
            ],
          },
        },
      });
      assert.strictEqual(rows.length, 2);
      assert.deepStrictEqual(rows[0], {
        date: "2026-06-10",
        requests: 3,
        tokens: 1950,
        cost: 0.53,
      });
      assert.deepStrictEqual(rows[1], {
        date: "2026-06-09",
        requests: null,
        tokens: null,
        cost: null,
      });
    });

    it("returns [] when the source is absent or unavailable", () => {
      assert.deepStrictEqual(dailyRowsFrom(null), []);
      assert.deepStrictEqual(dailyRowsFrom({ nineRouter: { available: false } }), []);
    });
  });

  describe("sourceRowsFrom()", () => {
    it("builds one row per usage source with 24h totals where supported", () => {
      const rows = sourceRowsFrom({
        claudeCode: {
          available: true,
          windows: {
            available: true,
            h24: {
              input: 100,
              output: 50,
              cacheRead: 10,
              cacheWrite: 5,
              requests: 4,
              estCost: 0.5,
            },
          },
        },
        codex: { available: true, activity: { entries: 12, sessions: 3 } },
        nineRouter: {
          available: true,
          usage: { totals: { requests: 7, totalTokens: 1950, cost: 0.53 } },
        },
        headroom: { available: true, stale: true, windowTokens: { totalRaw: 5000 } },
        openrouter: { available: true, credits: { totalUsage: 42.5, remaining: 7.5 } },
      });

      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      assert.strictEqual(rows.length, 5);
      assert.strictEqual(byId["claude-code"].tokens, 165);
      assert.strictEqual(byId["claude-code"].cost, 0.5);
      assert.strictEqual(byId["claude-code"].costKind, "est");
      assert.strictEqual(byId.codex.requests, 12);
      assert.strictEqual(byId.codex.tokens, null);
      assert.strictEqual(byId["nine-router"].cost, 0.53);
      assert.strictEqual(byId["nine-router"].costKind, "reported");
      assert.strictEqual(byId.headroom.status, "stale");
      // Headroom is a plan-quota observation, not a token-cost source: its
      // tokens/cost columns are nulled and the weighted figure moves to the
      // note so it's never read as a comparable token count or summed as cost.
      assert.strictEqual(byId.headroom.tokens, null);
      assert.ok(byId.headroom.note.includes("plan-quota"));
      assert.ok(byId.headroom.note.includes("5.0k"));
      assert.strictEqual(byId.openrouter.cost, 42.5);
      assert.strictEqual(byId.openrouter.costKind, "lifetime");
      assert.ok(byId.openrouter.note.includes("7.50"));
    });

    it("marks unavailable sources with their reason", () => {
      const rows = sourceRowsFrom({
        claudeCode: { available: false, reason: "no projects dir" },
      });
      const claude = rows.find((r) => r.id === "claude-code");
      assert.strictEqual(claude.status, "unavailable");
      assert.strictEqual(claude.note, "no projects dir");
      assert.strictEqual(claude.cost, null);
    });
  });
});
