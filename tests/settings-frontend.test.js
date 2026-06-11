/**
 * Unit tests for the Settings view's pure logic
 * (public/js/views/settings-core.js): per-section render isolation, restart
 * path accumulation, the post-restart health polling loop, the bounded
 * health probe, and the About-card model — plus regression guards on the
 * settings/evolution partials (the [hidden] CSS override and the gate
 * control's move into Settings).
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

/** The module is browser ESM; node:test loads it via dynamic import. */
async function core() {
  return import("../public/js/views/settings-core.js");
}

describe("settings-core pure helpers", () => {
  describe("applySections()", () => {
    it("applies every section and reports ok results", async () => {
      const { applySections } = await core();
      const seen = [];
      const results = applySections({ a: 1 }, [
        { name: "alerts", apply: (s) => seen.push(["alerts", s.a]) },
        { name: "gate", apply: (s) => seen.push(["gate", s.a]) },
      ]);
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
      assert.deepStrictEqual([...merged].sort(), ["federation.intervalMs", "mesh.intervalMs"]);
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

  describe("makeHealthCheck()", () => {
    it("returns true for an ok response and false otherwise", async () => {
      const { makeHealthCheck } = await core();
      const ok = makeHealthCheck({ fetchFn: async () => ({ ok: true }) });
      assert.strictEqual(await ok(), true);
      const notOk = makeHealthCheck({ fetchFn: async () => ({ ok: false }) });
      assert.strictEqual(await notOk(), false);
    });

    it("never throws: a rejecting fetch reads as still-down", async () => {
      const { makeHealthCheck } = await core();
      const check = makeHealthCheck({
        fetchFn: async () => {
          throw new Error("ECONNREFUSED");
        },
      });
      assert.strictEqual(await check(), false);
    });

    it("caps every probe: a hung fetch aborts after timeoutMs (false, not a wedge)", async () => {
      const { makeHealthCheck } = await core();
      // Fake fetch that never settles on its own but honors the abort signal
      // (same contract as the real fetch on a dead connection).
      const hungFetch = (url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("AbortError")));
        });
      const check = makeHealthCheck({ fetchFn: hungFetch, timeoutMs: 20 });
      const started = Date.now();
      assert.strictEqual(await check(), false);
      assert.ok(Date.now() - started < 2000, "probe must resolve near timeoutMs, not hang");
    });

    it("passes the url and no-store cache mode to fetch", async () => {
      const { makeHealthCheck } = await core();
      const seen = [];
      const check = makeHealthCheck({
        fetchFn: async (url, options) => {
          seen.push({ url, cache: options.cache });
          return { ok: true };
        },
      });
      await check();
      assert.deepStrictEqual(seen, [{ url: "/api/health", cache: "no-store" }]);
    });
  });

  describe("aboutModel()", () => {
    it("normalizes the /api/about payload", async () => {
      const { aboutModel } = await core();
      assert.deepStrictEqual(
        aboutModel({ name: "OpenFleetControl", version: "2.1.0", license: "MIT" }),
        { name: "OpenFleetControl", version: "v2.1.0", license: "MIT" },
      );
    });

    it("falls back to known constants on a missing or malformed payload", async () => {
      const { aboutModel } = await core();
      const fallback = { name: "Open Fleet Control", version: "", license: "MIT" };
      assert.deepStrictEqual(aboutModel(null), fallback);
      assert.deepStrictEqual(aboutModel("nope"), fallback);
      assert.deepStrictEqual(aboutModel({ name: "  ", version: 42, license: "" }), fallback);
    });
  });
});

// ---------------------------------------------------------------------------
// Partial regression guards (string-level: the partials are plain HTML)
// ---------------------------------------------------------------------------

const PARTIALS_DIR = path.join(__dirname, "..", "public", "partials");

describe("settings/evolution partial regression guards", () => {
  const settingsHtml = fs.readFileSync(path.join(PARTIALS_DIR, "settings.html"), "utf8");
  const evolutionHtml = fs.readFileSync(path.join(PARTIALS_DIR, "evolution.html"), "utf8");

  it("settings partial forces [hidden] to win over author display rules", () => {
    // Root cause of the "Restarting… sits there" bug: without this rule the
    // author `display: flex` on .set-restart-overlay beats the UA's
    // [hidden] { display: none }, so the overlay rendered permanently.
    assert.match(
      settingsHtml,
      /#settings-view-section\s+\[hidden\]\s*\{\s*display:\s*none\s*!important;/,
    );
  });

  it("settings partial hosts the live gate control and the About card", () => {
    assert.ok(settingsHtml.includes('id="set-gate-live"'), "live gate toggle missing");
    assert.ok(settingsHtml.includes('id="set-gate-state"'), "gate state line missing");
    assert.ok(settingsHtml.includes('id="set-about-card"'), "About card missing");
    assert.ok(settingsHtml.includes('id="set-about-version"'), "About version chip missing");
    // Compact About card sits at the very bottom of the settings body.
    assert.ok(
      settingsHtml.indexOf('id="set-about-card"') > settingsHtml.indexOf('id="set-gate-card"'),
      "About card must come after the gate card",
    );
  });

  it("evolution partial no longer carries a gate control (read-only banner)", () => {
    assert.ok(!evolutionHtml.includes("evo-gate-toggle"), "evolution gate toggle must be gone");
    assert.ok(evolutionHtml.includes('id="evo-gate-banner"'), "read-only banner must remain");
    assert.ok(evolutionHtml.includes('id="evo-gate-hint"'), "settings pointer hint missing");
  });

  it("evolution view js no longer PUTs the gate", () => {
    const evolutionJs = fs.readFileSync(
      path.join(__dirname, "..", "public", "js", "views", "evolution.js"),
      "utf8",
    );
    assert.ok(!evolutionJs.includes("putGate"), "putGate must be removed from the evolution view");
    assert.ok(
      !/method:\s*"PUT"/.test(evolutionJs),
      "evolution view must not issue PUT requests anymore",
    );
  });
});
