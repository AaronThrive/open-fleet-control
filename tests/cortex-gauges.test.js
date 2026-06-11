const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createGauges, computeSavingsPct } = require("../src/cortex-gauges");

// node:sqlite ships with modern Node; used here only against temp-dir fixtures
let sqlite = null;
try {
  sqlite = require("node:sqlite");
} catch (e) {
  // Tests that need sqlite will be skipped
}

/**
 * Real ~/.headroom/subscription_state.json schema (verbatim shape from a
 * live host): five_hour/seven_day/extra_usage/polled_at live under `latest`,
 * window token totals under `window_tokens`. Regression fixture for the
 * "gauge renders zeros despite real data" bug.
 */
const HEADROOM_FIXTURE = {
  latest: {
    five_hour: {
      used: 29,
      limit: 100,
      utilization_pct: 29,
      resets_at: "2026-06-11T22:00:00Z",
      seconds_to_reset: 4200,
    },
    seven_day: {
      used: 35,
      limit: 100,
      utilization_pct: 35,
      resets_at: "2026-06-15T00:00:00Z",
      seconds_to_reset: 273600,
    },
    extra_usage: {
      is_enabled: true,
      monthly_limit_usd: 50,
      used_credits_usd: 12.34,
      utilization_pct: 24.7,
    },
    polled_at: "2026-06-11T19:58:00Z",
    seven_day_sonnet: { used: 11, limit: 100, utilization_pct: 11 },
  },
  window_tokens: {
    input: 368180,
    output: 545773,
    cache_reads: 158577891,
    cache_writes_5m: 3000000,
    cache_writes_1h: 1291792,
    cache_writes_total: 4291792,
    total_raw: 163783636,
    weighted_token_equivalent: 17000000,
    by_model: { "claude-fable-5": { input: 368180, output: 545773 } },
  },
  contribution: { tokens_submitted: 0 },
  poll_count: 417,
  history: [],
};

/**
 * What headroom writes right after a restart / failed poll: same top-level
 * keys but latest and window_tokens are null. The gauge previously reported
 * available:true with all-zero numbers for this state.
 */
const HEADROOM_NULL_STATE = {
  latest: null,
  window_tokens: null,
  contribution: { tokens_submitted: 0 },
  discrepancies: [],
  poll_count: 417,
  poll_errors: 1,
  last_error: "fetch returned None",
  last_active_at: null,
  history: [],
};

/**
 * Real ~/.lean-ctx/stats.json schema: per-command entries carry
 * {count, input_tokens, output_tokens} where input ~== output for nearly
 * every command (the same measurement, not before/after compression).
 * Genuine savings are only derivable from the cep block when present.
 */
const LEAN_CTX_FIXTURE = {
  total_commands: 1508,
  total_input_tokens: 210061437,
  total_output_tokens: 210055213,
  first_use: "2026-03-30T20:36:20Z",
  last_use: "2026-06-09T19:17:53Z",
  commands: {
    rg: { count: 75, input_tokens: 178951855, output_tokens: 178951855 },
    ps: { count: 35, input_tokens: 886528, output_tokens: 886528 },
    curl: { count: 20, input_tokens: 64013, output_tokens: 57774 },
    jq: { count: 68, input_tokens: 33366, output_tokens: 33366 },
  },
  daily: [
    { date: "2026-06-08", commands: 6, input_tokens: 31668, output_tokens: 25429 },
    { date: "2026-06-09", commands: 7, input_tokens: 87434, output_tokens: 87449 },
  ],
  cep: {
    sessions: 0,
    total_cache_hits: 0,
    total_cache_reads: 0,
    total_tokens_original: 0,
    total_tokens_compressed: 0,
    modes: {},
    scores: [],
  },
};

function writeFixtures(dir) {
  fs.writeFileSync(path.join(dir, "headroom.json"), JSON.stringify(HEADROOM_FIXTURE));
  fs.writeFileSync(path.join(dir, "lean-ctx.json"), JSON.stringify(LEAN_CTX_FIXTURE));
}

function createLcmFixtureDb(dbPath) {
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE summaries (
      summary_id TEXT PRIMARY KEY,
      token_count INTEGER NOT NULL,
      source_message_token_count INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO summaries VALUES ('s1', 60, 700), ('s2', 40, 300);
    CREATE TABLE messages (
      message_id INTEGER PRIMARY KEY,
      token_count INTEGER NOT NULL
    );
    INSERT INTO messages VALUES (1, 500), (2, 500);
  `);
  db.close();
}

describe("cortex-gauges module", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-gauges-test-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("computeSavingsPct()", () => {
    it("computes the saved percentage to one decimal", () => {
      assert.strictEqual(computeSavingsPct(1000, 600), 40);
      assert.strictEqual(computeSavingsPct(200, 150), 25);
      assert.strictEqual(computeSavingsPct(3, 1), 66.7);
    });

    it("returns null when raw is zero, negative, or non-numeric", () => {
      assert.strictEqual(computeSavingsPct(0, 100), null);
      assert.strictEqual(computeSavingsPct(-5, 1), null);
      assert.strictEqual(computeSavingsPct("nope", 1), null);
    });

    it("reports negative savings when effective exceeds raw (overhead)", () => {
      assert.strictEqual(computeSavingsPct(100, 150), -50);
    });
  });

  describe("headroom gauge (real subscription_state.json schema)", () => {
    it("surfaces window totals, 5h/7d utilization, extra usage, and polled_at", () => {
      const dir = fs.mkdtempSync(path.join(tmpDir, "hr-real-"));
      writeFixtures(dir);
      const [headroom] = createGauges({
        paths: { headroom: path.join(dir, "headroom.json"), leanCtx: "/nope", lcmDb: "/nope" },
      }).getGauges();

      assert.strictEqual(headroom.available, true);
      assert.strictEqual(headroom.rawTokens, 163783636);
      assert.strictEqual(headroom.effectiveTokens, 17000000);
      assert.strictEqual(headroom.savingsPct, computeSavingsPct(163783636, 17000000));

      assert.strictEqual(headroom.detail.input, 368180);
      assert.strictEqual(headroom.detail.output, 545773);
      assert.strictEqual(headroom.detail.cacheReads, 158577891);
      assert.strictEqual(headroom.detail.cacheWritesTotal, 4291792);
      assert.strictEqual(headroom.detail.fiveHourUtilizationPct, 29);
      assert.strictEqual(headroom.detail.sevenDayUtilizationPct, 35);
      assert.strictEqual(headroom.detail.extraUsageUsd, 12.34);
      assert.strictEqual(headroom.detail.extraUsageLimitUsd, 50);
      assert.strictEqual(headroom.detail.polledAt, "2026-06-11T19:58:00Z");
    });

    it("sums the window components when total_raw is absent", () => {
      const dir = fs.mkdtempSync(path.join(tmpDir, "hr-sum-"));
      const fixture = JSON.parse(JSON.stringify(HEADROOM_FIXTURE));
      delete fixture.window_tokens.total_raw;
      fs.writeFileSync(path.join(dir, "headroom.json"), JSON.stringify(fixture));
      const [headroom] = createGauges({
        paths: { headroom: path.join(dir, "headroom.json"), leanCtx: "/nope", lcmDb: "/nope" },
      }).getGauges();

      // input + output + cache_reads + cache_writes_total
      assert.strictEqual(headroom.rawTokens, 368180 + 545773 + 158577891 + 4291792);
    });

    it("reports unavailable (not zeros) when latest and window_tokens are null", () => {
      const dir = fs.mkdtempSync(path.join(tmpDir, "hr-null-"));
      fs.writeFileSync(path.join(dir, "headroom.json"), JSON.stringify(HEADROOM_NULL_STATE));
      const [headroom] = createGauges({
        paths: { headroom: path.join(dir, "headroom.json"), leanCtx: "/nope", lcmDb: "/nope" },
      }).getGauges();

      assert.strictEqual(headroom.available, false);
      assert.ok(headroom.detail.error.includes("no poll data"));
      assert.strictEqual(headroom.rawTokens, 0);
    });

    it("omits extra-usage dollars when extra usage is disabled", () => {
      const dir = fs.mkdtempSync(path.join(tmpDir, "hr-noextra-"));
      const fixture = JSON.parse(JSON.stringify(HEADROOM_FIXTURE));
      fixture.latest.extra_usage.is_enabled = false;
      fs.writeFileSync(path.join(dir, "headroom.json"), JSON.stringify(fixture));
      const [headroom] = createGauges({
        paths: { headroom: path.join(dir, "headroom.json"), leanCtx: "/nope", lcmDb: "/nope" },
      }).getGauges();

      assert.strictEqual(headroom.detail.extraUsageUsd, null);
      assert.strictEqual(headroom.detail.extraUsageLimitUsd, null);
    });
  });

  describe("path overrides from config", () => {
    it("ignores empty-string overrides and falls back to the default paths", () => {
      // CONFIG defaults flow empty strings through fleet.js; they must not
      // clobber the built-in ~/.headroom etc. locations.
      const home = fs.mkdtempSync(path.join(tmpDir, "home-"));
      fs.mkdirSync(path.join(home, ".headroom"), { recursive: true });
      fs.writeFileSync(
        path.join(home, ".headroom", "subscription_state.json"),
        JSON.stringify(HEADROOM_FIXTURE),
      );
      fs.mkdirSync(path.join(home, ".lean-ctx"), { recursive: true });
      fs.writeFileSync(
        path.join(home, ".lean-ctx", "stats.json"),
        JSON.stringify(LEAN_CTX_FIXTURE),
      );

      const gauges = createGauges({
        home,
        paths: { headroom: "", leanCtx: "   ", lcmDb: "" },
      }).getGauges();

      assert.strictEqual(gauges[0].available, true);
      assert.strictEqual(gauges[0].rawTokens, 163783636);
      assert.strictEqual(gauges[1].available, true);
      assert.strictEqual(gauges[1].detail.totalCommands, 1508);
    });

    it("still honours real path overrides", () => {
      const dir = fs.mkdtempSync(path.join(tmpDir, "override-"));
      writeFixtures(dir);
      const gauges = createGauges({
        paths: {
          headroom: path.join(dir, "headroom.json"),
          leanCtx: path.join(dir, "lean-ctx.json"),
          lcmDb: path.join(dir, "missing.db"),
        },
      }).getGauges();
      assert.strictEqual(gauges[0].available, true);
      assert.strictEqual(gauges[1].available, true);
      assert.strictEqual(gauges[2].available, false);
    });
  });

  describe("lean-ctx gauge (real stats.json schema)", () => {
    it("reports honest totals with no savings % when none is derivable", () => {
      const dir = fs.mkdtempSync(path.join(tmpDir, "lc-real-"));
      writeFixtures(dir);
      const gauge = createGauges({
        paths: { headroom: "/nope", leanCtx: path.join(dir, "lean-ctx.json"), lcmDb: "/nope" },
      }).getGauges()[1];

      assert.strictEqual(gauge.available, true);
      // input_tokens ~== output_tokens in stats.json: NOT a raw/compressed
      // pair, so no bogus 0% — savingsPct must be null with an explanation.
      assert.strictEqual(gauge.savingsPct, null);
      assert.ok(gauge.detail.note.includes("not derivable"));
      assert.strictEqual(gauge.rawTokens, gauge.effectiveTokens);
      assert.strictEqual(gauge.detail.totalCommands, 1508);
      assert.strictEqual(gauge.detail.tokensProcessed, 210055213);
      assert.strictEqual(gauge.detail.daysTracked, 2);
      assert.strictEqual(gauge.detail.firstUse, "2026-03-30T20:36:20Z");
      // Top commands ranked by tokens
      assert.strictEqual(gauge.detail.topCommands[0].command, "rg");
      assert.strictEqual(gauge.detail.topCommands[0].tokens, 178951855);
      assert.ok(gauge.detail.topCommands.length <= 5);
    });

    it("derives genuine savings from the cep block when populated", () => {
      const dir = fs.mkdtempSync(path.join(tmpDir, "lc-cep-"));
      const fixture = JSON.parse(JSON.stringify(LEAN_CTX_FIXTURE));
      fixture.cep = {
        sessions: 4,
        total_tokens_original: 1000,
        total_tokens_compressed: 400,
      };
      fs.writeFileSync(path.join(dir, "lean-ctx.json"), JSON.stringify(fixture));
      const gauge = createGauges({
        paths: { headroom: "/nope", leanCtx: path.join(dir, "lean-ctx.json"), lcmDb: "/nope" },
      }).getGauges()[1];

      assert.strictEqual(gauge.available, true);
      assert.strictEqual(gauge.rawTokens, 1000);
      assert.strictEqual(gauge.effectiveTokens, 400);
      assert.strictEqual(gauge.savingsPct, 60);
      assert.strictEqual(gauge.detail.savingsSource, "cep");
      assert.strictEqual(gauge.detail.totalCommands, 1508);
    });

    it("tolerates a minimal stats file with no commands map", () => {
      const dir = fs.mkdtempSync(path.join(tmpDir, "lc-min-"));
      fs.writeFileSync(
        path.join(dir, "lean-ctx.json"),
        JSON.stringify({ total_commands: 3, total_output_tokens: 99 }),
      );
      const gauge = createGauges({
        paths: { headroom: "/nope", leanCtx: path.join(dir, "lean-ctx.json"), lcmDb: "/nope" },
      }).getGauges()[1];

      assert.strictEqual(gauge.available, true);
      assert.strictEqual(gauge.savingsPct, null);
      assert.deepStrictEqual(gauge.detail.topCommands, []);
      assert.strictEqual(gauge.detail.tokensProcessed, 99);
    });
  });

  describe("getGauges() with fixture files", () => {
    it("reads all three sources", (t) => {
      if (!sqlite) return t.skip("node:sqlite unavailable");
      const dir = fs.mkdtempSync(path.join(tmpDir, "all-"));
      writeFixtures(dir);
      const lcmDb = path.join(dir, "lcm.db");
      createLcmFixtureDb(lcmDb);

      const gauges = createGauges({
        paths: {
          headroom: path.join(dir, "headroom.json"),
          leanCtx: path.join(dir, "lean-ctx.json"),
          lcmDb,
        },
      }).getGauges();

      assert.strictEqual(gauges.length, 3);
      assert.deepStrictEqual(
        gauges.map((g) => g.source),
        ["headroom", "lean-ctx", "lcm"],
      );
      assert.ok(gauges.every((g) => g.available === true));

      const lcm = gauges[2];
      // lcm: summaries 1000 source tokens -> 100 summary tokens = 90% saved
      assert.strictEqual(lcm.rawTokens, 1000);
      assert.strictEqual(lcm.effectiveTokens, 100);
      assert.strictEqual(lcm.savingsPct, 90);
      assert.strictEqual(lcm.detail.summaries, 2);
      assert.strictEqual(lcm.detail.messages, 2);
    });

    it("marks each missing source unavailable independently", () => {
      const dir = fs.mkdtempSync(path.join(tmpDir, "missing-"));
      // Only lean-ctx exists
      fs.writeFileSync(path.join(dir, "lean-ctx.json"), JSON.stringify(LEAN_CTX_FIXTURE));

      const gauges = createGauges({
        paths: {
          headroom: path.join(dir, "headroom.json"),
          leanCtx: path.join(dir, "lean-ctx.json"),
          lcmDb: path.join(dir, "lcm.db"),
        },
      }).getGauges();

      assert.strictEqual(gauges[0].available, false);
      assert.ok(gauges[0].detail.error.includes("file not found"));
      assert.strictEqual(gauges[1].available, true);
      assert.strictEqual(gauges[2].available, false);
      assert.ok(gauges[2].detail.error.includes("database not found"));
    });

    it("tolerates corrupt JSON without breaking other sources", (t) => {
      if (!sqlite) return t.skip("node:sqlite unavailable");
      const dir = fs.mkdtempSync(path.join(tmpDir, "corrupt-"));
      fs.writeFileSync(path.join(dir, "headroom.json"), "{not json!!");
      fs.writeFileSync(path.join(dir, "lean-ctx.json"), JSON.stringify(LEAN_CTX_FIXTURE));
      const lcmDb = path.join(dir, "lcm.db");
      createLcmFixtureDb(lcmDb);

      const gauges = createGauges({
        paths: {
          headroom: path.join(dir, "headroom.json"),
          leanCtx: path.join(dir, "lean-ctx.json"),
          lcmDb,
        },
      }).getGauges();

      assert.strictEqual(gauges[0].available, false);
      assert.strictEqual(gauges[1].available, true);
      assert.strictEqual(gauges[2].available, true);
    });
  });

  describe("lcm schema-surprise tolerance", () => {
    it("falls back to messages-only when summaries is missing", (t) => {
      if (!sqlite) return t.skip("node:sqlite unavailable");
      const dir = fs.mkdtempSync(path.join(tmpDir, "msgs-only-"));
      const lcmDb = path.join(dir, "lcm.db");
      const db = new sqlite.DatabaseSync(lcmDb);
      db.exec(`
        CREATE TABLE messages (message_id INTEGER PRIMARY KEY, token_count INTEGER NOT NULL);
        INSERT INTO messages VALUES (1, 300), (2, 200);
      `);
      db.close();

      const gauges = createGauges({
        paths: { headroom: "/nope", leanCtx: "/nope", lcmDb },
      }).getGauges();
      const lcm = gauges[2];

      assert.strictEqual(lcm.available, true);
      assert.strictEqual(lcm.rawTokens, 500);
      assert.strictEqual(lcm.effectiveTokens, 500);
      assert.strictEqual(lcm.savingsPct, 0);
      assert.ok(lcm.detail.note.includes("no usable summaries"));
    });

    it("uses descendant_token_count when source_message_token_count is absent", (t) => {
      if (!sqlite) return t.skip("node:sqlite unavailable");
      const dir = fs.mkdtempSync(path.join(tmpDir, "old-schema-"));
      const lcmDb = path.join(dir, "lcm.db");
      const db = new sqlite.DatabaseSync(lcmDb);
      db.exec(`
        CREATE TABLE summaries (
          summary_id TEXT PRIMARY KEY,
          token_count INTEGER NOT NULL,
          descendant_token_count INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO summaries VALUES ('s1', 50, 400);
      `);
      db.close();

      const lcm = createGauges({
        paths: { headroom: "/nope", leanCtx: "/nope", lcmDb },
      }).getGauges()[2];

      assert.strictEqual(lcm.available, true);
      assert.strictEqual(lcm.rawTokens, 400);
      assert.strictEqual(lcm.effectiveTokens, 50);
      assert.strictEqual(lcm.detail.rawColumn, "descendant_token_count");
    });

    it("reports unavailable for a db with no token tables", (t) => {
      if (!sqlite) return t.skip("node:sqlite unavailable");
      const dir = fs.mkdtempSync(path.join(tmpDir, "no-tables-"));
      const lcmDb = path.join(dir, "lcm.db");
      const db = new sqlite.DatabaseSync(lcmDb);
      db.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY);");
      db.close();

      const lcm = createGauges({
        paths: { headroom: "/nope", leanCtx: "/nope", lcmDb },
      }).getGauges()[2];

      assert.strictEqual(lcm.available, false);
      assert.ok(lcm.detail.error.includes("no summaries/messages tables"));
    });

    it("reports unavailable when the sqlite loader itself fails", () => {
      const dir = fs.mkdtempSync(path.join(tmpDir, "no-sqlite-"));
      writeFixtures(dir);
      const lcmDb = path.join(dir, "lcm.db");
      fs.writeFileSync(lcmDb, "this is not a sqlite db");

      const gauges = createGauges({
        paths: {
          headroom: path.join(dir, "headroom.json"),
          leanCtx: path.join(dir, "lean-ctx.json"),
          lcmDb,
        },
        sqliteLoader: () => {
          throw new Error("node:sqlite not available in this runtime");
        },
      }).getGauges();

      assert.strictEqual(gauges[2].available, false);
      assert.ok(gauges[2].detail.error.includes("node:sqlite not available"));
      // Other gauges unaffected
      assert.strictEqual(gauges[0].available, true);
      assert.strictEqual(gauges[1].available, true);
    });
  });
});
