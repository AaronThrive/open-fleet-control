/**
 * Unit tests for the Settings view's pure logic
 * (public/js/views/settings-core.js): per-section render isolation, restart
 * path accumulation, and the post-restart health polling loop.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");

/** The module is browser ESM; node:test loads it via dynamic import. */
async function core() {
  return import("../public/js/views/settings-core.js");
}

describe("settings-core pure helpers", () => {
  describe("applySections()", () => {
    it("applies every section and reports ok results", async () => {
      const { applySections } = await core();
      const seen = [];
      const results = applySections(
        { a: 1 },
        [
          { name: "alerts", apply: (s) => seen.push(["alerts", s.a]) },
          { name: "gate", apply: (s) => seen.push(["gate", s.a]) },
        ],
      );
      assert.deepStrictEqual(seen, [
        ["alerts", 1],
        ["gate", 1],
      ]);
      assert.deepStrictEqual(results, [
        { name: "alerts", ok: true, error: null },
        { name: "gate", ok: true, error: null },
      ]);
    });

    it("isolates a throwing section: the rest still render", async () => {
      const { applySections } = await core();
      const seen = [];
      const results = applySections({}, [
        { name: "alerts", apply: () => seen.push("alerts") },
        {
          name: "budgets",
          apply: () => {
            throw new Error("bad shape");
          },
        },
        { name: "intervals", apply: () => seen.push("intervals") },
      ]);
      assert.deepStrictEqual(seen, ["alerts", "intervals"]);
      assert.deepStrictEqual(results[1], { name: "budgets", ok: false, error: "bad shape" });
      assert.strictEqual(results[0].ok, true);
      assert.strictEqual(results[2].ok, true);
    });

    it("stringifies non-Error throws and tolerates an empty section list", async () => {
      const { applySections } = await core();
      const results = applySections({}, [
        {
          name: "gate",
          apply: () => {
            throw "boom"; // eslint-disable-line no-throw-literal
          },
        },
      ]);
      assert.deepStrictEqual(results, [{ name: "gate", ok: false, error: "boom" }]);
      assert.deepStrictEqual(applySections({}, []), []);
      assert.deepStrictEqual(applySections({}, null), []);
    });
  });

  describe("mergeRestartPaths()", () => {
    it("merges and dedupes without mutating the input set", async () => {
      const { mergeRestartPaths } = await core();
      const current = new Set(["mesh.intervalMs"]);
      const merged = mergeRestartPaths(current, ["federation.intervalMs", "mesh.intervalMs"]);
      assert.deepStrictEqual(
        [...merged].sort(),
        ["federation.intervalMs", "mesh.intervalMs"],
      );
      assert.deepStrictEqual([...current], ["mesh.intervalMs"]);
      assert.notStrictEqual(merged, current);
    });

    it("ignores non-array additions and non-string entries", async () => {
      const { mergeRestartPaths } = await core();
      const current = new Set(["a"]);
      assert.deepStrictEqual([...mergeRestartPaths(current, undefined)], ["a"]);
      assert.deepStrictEqual([...mergeRestartPaths(current, "nope")], ["a"]);
      assert.deepStrictEqual([...mergeRestartPaths(current, [null, "", "b"])].sort(), ["a", "b"]);
    });
  });

  describe("formatRestartPaths()", () => {
    it("sorts and comma-joins", async () => {
      const { formatRestartPaths } = await core();
      assert.strictEqual(
        formatRestartPaths(new Set(["mesh.intervalMs", "federation.intervalMs"])),
        "federation.intervalMs, mesh.intervalMs",
      );
      assert.strictEqual(formatRestartPaths(new Set()), "");
      assert.strictEqual(formatRestartPaths(null), "");
    });
  });

  describe("pollUntilHealthy()", () => {
    /** Fake clock: sleep() advances time, no real timers. */
    function fakeClock() {
      let t = 0;
      return {
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      };
    }

    it("returns true once the check passes (earlier failures tolerated)", async () => {
      const { pollUntilHealthy } = await core();
      const { now, sleep } = fakeClock();
      let calls = 0;
      const healthy = await pollUntilHealthy({
        check: async () => {
          calls += 1;
          if (calls < 3) throw new Error("ECONNREFUSED");
          return true;
        },
        timeoutMs: 10000,
        intervalMs: 1000,
        sleep,
        now,
      });
      assert.strictEqual(healthy, true);
      assert.strictEqual(calls, 3);
    });

    it("treats falsy check results as still-down", async () => {
      const { pollUntilHealthy } = await core();
      const { now, sleep } = fakeClock();
      let calls = 0;
      const healthy = await pollUntilHealthy({
        check: async () => {
          calls += 1;
          return calls >= 2;
        },
        timeoutMs: 10000,
        intervalMs: 1000,
        sleep,
        now,
      });
      assert.strictEqual(healthy, true);
      assert.strictEqual(calls, 2);
    });

    it("returns false when the deadline passes without a healthy answer", async () => {
      const { pollUntilHealthy } = await core();
      const { now, sleep } = fakeClock();
      let calls = 0;
      const healthy = await pollUntilHealthy({
        check: async () => {
          calls += 1;
          return false;
        },
        timeoutMs: 5000,
        intervalMs: 1000,
        sleep,
        now,
      });
      assert.strictEqual(healthy, false);
      assert.strictEqual(calls, 5);
    });
  });
});
