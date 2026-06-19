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

/**
 * Real lcm.db summaries schema includes created_at (sqlite datetime, UTC).
 * Used for the activity-detection tests: lossless-claw may be installed but
 * idle, in which case the newest created_at is the last compaction.
 */
function createLcmFixtureDbWithDates(dbPath, dates) {
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE summaries (
      summary_id TEXT PRIMARY KEY,
      token_count INTEGER NOT NULL,
      source_message_token_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
  const insert = db.prepare("INSERT INTO summaries VALUES (?, ?, ?, ?)");
  dates.forEach((date, i) => insert.run(`s${i}`, 50, 500, date));
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

  describe("getGauges() shape (headroom removed)", () => {
    it("returns exactly two sources: lean-ctx then lcm", () => {
      const gauges = createGauges({
        paths: { leanCtx: "/nope", lcmDb: "/nope" },
      }).getGauges();
      assert.strictEqual(gauges.length, 2);
      assert.deepStrictEqual(
        gauges.map((g) => g.source),
        ["lean-ctx", "lcm"],
      );
      // No headroom gauge is ever produced.
      assert.ok(!gauges.some((g) => g.source === "headroom"));
    });
  });

  describe("path overrides from config", () => {
    it("ignores empty-string overrides and falls back to the default paths", () => {
      // CONFIG defaults flow empty strings through fleet.js; they must not
      // clobber the built-in ~/.lean-ctx etc. locations.
      const home = fs.mkdtempSync(path.join(tmpDir, "home-"));
      fs.mkdirSync(path.join(home, ".lean-ctx"), { recursive: true });
      fs.writeFileSync(
        path.join(home, ".lean-ctx", "stats.json"),
        JSON.stringify(LEAN_CTX_FIXTURE),
      );

      const gauges = createGauges({
        home,
        paths: { leanCtx: "   ", lcmDb: "" },
      }).getGauges();

      assert.strictEqual(gauges[0].available, true);
      assert.strictEqual(gauges[0].detail.totalCommands, 1508);
    });

    it("still honours real path overrides", () => {
      const dir = fs.mkdtempSync(path.join(tmpDir, "override-"));
      writeFixtures(dir);
      const gauges = createGauges({
        paths: {
          leanCtx: path.join(dir, "lean-ctx.json"),
          lcmDb: path.join(dir, "missing.db"),
        },
      }).getGauges();
      assert.strictEqual(gauges[0].available, true);
      assert.strictEqual(gauges[1].available, false);
    });
  });

  describe("lean-ctx gauge (real stats.json schema)", () => {
    it("reports honest totals with no savings % when none is derivable", () => {
      const dir = fs.mkdtempSync(path.join(tmpDir, "lc-real-"));
      writeFixtures(dir);
      const gauge = createGauges({
        paths: { leanCtx: path.join(dir, "lean-ctx.json"), lcmDb: "/nope" },
      }).getGauges()[0];

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
        paths: { leanCtx: path.join(dir, "lean-ctx.json"), lcmDb: "/nope" },
      }).getGauges()[0];

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
        paths: { leanCtx: path.join(dir, "lean-ctx.json"), lcmDb: "/nope" },
      }).getGauges()[0];

      assert.strictEqual(gauge.available, true);
      assert.strictEqual(gauge.savingsPct, null);
      assert.deepStrictEqual(gauge.detail.topCommands, []);
      assert.strictEqual(gauge.detail.tokensProcessed, 99);
    });

    it("reports unavailable when the stats file is missing", () => {
      const dir = fs.mkdtempSync(path.join(tmpDir, "lc-missing-"));
      const gauge = createGauges({
        paths: { leanCtx: path.join(dir, "lean-ctx.json"), lcmDb: "/nope" },
      }).getGauges()[0];
      assert.strictEqual(gauge.available, false);
      assert.ok(gauge.detail.error.includes("file not found"));
    });
  });

  describe("getGauges() with fixture files", () => {
    it("reads both sources", (t) => {
      if (!sqlite) return t.skip("node:sqlite unavailable");
      const dir = fs.mkdtempSync(path.join(tmpDir, "all-"));
      writeFixtures(dir);
      const lcmDb = path.join(dir, "lcm.db");
      createLcmFixtureDb(lcmDb);

      const gauges = createGauges({
        paths: {
          leanCtx: path.join(dir, "lean-ctx.json"),
          lcmDb,
        },
      }).getGauges();

      assert.strictEqual(gauges.length, 2);
      assert.deepStrictEqual(
        gauges.map((g) => g.source),
        ["lean-ctx", "lcm"],
      );
      assert.ok(gauges.every((g) => g.available === true));

      const lcm = gauges[1];
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
          leanCtx: path.join(dir, "lean-ctx.json"),
          lcmDb: path.join(dir, "lcm.db"),
        },
      }).getGauges();

      assert.strictEqual(gauges[0].available, true);
      assert.strictEqual(gauges[1].available, false);
      assert.ok(gauges[1].detail.error.includes("database not found"));
    });

    it("tolerates corrupt JSON without breaking other sources", (t) => {
      if (!sqlite) return t.skip("node:sqlite unavailable");
      const dir = fs.mkdtempSync(path.join(tmpDir, "corrupt-"));
      fs.writeFileSync(path.join(dir, "lean-ctx.json"), "{not json!!");
      const lcmDb = path.join(dir, "lcm.db");
      createLcmFixtureDb(lcmDb);

      const gauges = createGauges({
        paths: {
          leanCtx: path.join(dir, "lean-ctx.json"),
          lcmDb,
        },
      }).getGauges();

      assert.strictEqual(gauges[0].available, false);
      assert.strictEqual(gauges[1].available, true);
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
        paths: { leanCtx: "/nope", lcmDb },
      }).getGauges();
      const lcm = gauges[1];

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
        paths: { leanCtx: "/nope", lcmDb },
      }).getGauges()[1];

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
        paths: { leanCtx: "/nope", lcmDb },
      }).getGauges()[1];

      assert.strictEqual(lcm.available, false);
      assert.ok(lcm.detail.error.includes("no summaries/messages tables"));
    });

    it("detects last compaction activity and flags a stale (idle) engine", (t) => {
      if (!sqlite) return t.skip("node:sqlite unavailable");
      // Live host case: lossless-claw enabled in config but idle — newest
      // summary is from 2026-06-01 while "now" is 2026-06-11.
      const dir = fs.mkdtempSync(path.join(tmpDir, "lcm-idle-"));
      const lcmDb = path.join(dir, "lcm.db");
      createLcmFixtureDbWithDates(lcmDb, ["2026-03-28 16:27:11", "2026-06-01 21:04:32"]);

      const lcm = createGauges({
        paths: { leanCtx: "/nope", lcmDb },
        now: () => Date.parse("2026-06-11T22:00:00Z"),
      }).getGauges()[1];

      assert.strictEqual(lcm.available, true);
      assert.strictEqual(lcm.detail.lastActivity, "2026-06-01 21:04:32");
      assert.strictEqual(lcm.detail.stale, true);
      assert.strictEqual(lcm.detail.staleDays, 10);
    });

    it("does not flag a recently active engine as stale", (t) => {
      if (!sqlite) return t.skip("node:sqlite unavailable");
      const dir = fs.mkdtempSync(path.join(tmpDir, "lcm-fresh-"));
      const lcmDb = path.join(dir, "lcm.db");
      createLcmFixtureDbWithDates(lcmDb, ["2026-06-10 09:00:00"]);

      const lcm = createGauges({
        paths: { leanCtx: "/nope", lcmDb },
        now: () => Date.parse("2026-06-11T22:00:00Z"),
      }).getGauges()[1];

      assert.strictEqual(lcm.detail.lastActivity, "2026-06-10 09:00:00");
      assert.strictEqual(lcm.detail.stale, false);
    });

    it("reports lastActivity null (never stale) when created_at is absent", (t) => {
      if (!sqlite) return t.skip("node:sqlite unavailable");
      const dir = fs.mkdtempSync(path.join(tmpDir, "lcm-nodates-"));
      const lcmDb = path.join(dir, "lcm.db");
      createLcmFixtureDb(lcmDb);

      const lcm = createGauges({
        paths: { leanCtx: "/nope", lcmDb },
      }).getGauges()[1];

      assert.strictEqual(lcm.available, true);
      assert.strictEqual(lcm.detail.lastActivity, null);
      assert.strictEqual(lcm.detail.stale, null);
    });

    it("reports unavailable when the sqlite loader itself fails", () => {
      const dir = fs.mkdtempSync(path.join(tmpDir, "no-sqlite-"));
      writeFixtures(dir);
      const lcmDb = path.join(dir, "lcm.db");
      fs.writeFileSync(lcmDb, "this is not a sqlite db");

      const gauges = createGauges({
        paths: {
          leanCtx: path.join(dir, "lean-ctx.json"),
          lcmDb,
        },
        sqliteLoader: () => {
          throw new Error("node:sqlite not available in this runtime");
        },
      }).getGauges();

      assert.strictEqual(gauges[1].available, false);
      assert.ok(gauges[1].detail.error.includes("node:sqlite not available"));
      // Other gauge unaffected
      assert.strictEqual(gauges[0].available, true);
    });
  });

  describe("getContextEngine()", () => {
    function writeOpenclawConfig(dir, payload) {
      const configPath = path.join(dir, "openclaw.json");
      fs.writeFileSync(configPath, JSON.stringify(payload));
      return configPath;
    }

    it("reads the active engine from plugins.slots.contextEngine", () => {
      const dir = fs.mkdtempSync(path.join(tmpDir, "engine-"));
      const openclawConfig = writeOpenclawConfig(dir, {
        plugins: { slots: { memory: "memory-core", contextEngine: "lean-ctx" } },
      });

      const engine = createGauges({ paths: { openclawConfig } }).getContextEngine();
      assert.strictEqual(engine.engine, "lean-ctx");
      assert.strictEqual(engine.source, "plugins.slots.contextEngine");
      assert.strictEqual(engine.reason, null);
    });

    it("returns engine null with a reason when the config file is missing", () => {
      const dir = fs.mkdtempSync(path.join(tmpDir, "engine-missing-"));
      const engine = createGauges({
        paths: { openclawConfig: path.join(dir, "openclaw.json") },
      }).getContextEngine();

      assert.strictEqual(engine.engine, null);
      assert.ok(engine.reason.includes("not found"));
    });

    it("returns engine null with a reason when the slot is unset or config is malformed", () => {
      const dir = fs.mkdtempSync(path.join(tmpDir, "engine-bad-"));
      const noSlot = writeOpenclawConfig(dir, { plugins: { slots: {} } });
      const unset = createGauges({ paths: { openclawConfig: noSlot } }).getContextEngine();
      assert.strictEqual(unset.engine, null);
      assert.ok(unset.reason.includes("no contextEngine slot"));

      const malformedPath = path.join(dir, "broken.json");
      fs.writeFileSync(malformedPath, "{nope");
      const broken = createGauges({
        paths: { openclawConfig: malformedPath },
      }).getContextEngine();
      assert.strictEqual(broken.engine, null);
      assert.ok(broken.reason.length > 0);
    });
  });
});
