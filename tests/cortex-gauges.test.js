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

const HEADROOM_FIXTURE = {
  latest: {
    five_hour: { utilization_pct: 28.0 },
    seven_day: { utilization_pct: 4.0 },
    polled_at: "2026-06-10T05:48:12Z",
  },
  window_tokens: {
    input: 100,
    output: 50,
    cache_reads: 800,
    cache_writes_total: 50,
    total_raw: 1000,
    weighted_token_equivalent: 600,
  },
};

const LEAN_CTX_FIXTURE = {
  total_commands: 3,
  total_input_tokens: 200,
  total_output_tokens: 150,
  first_use: "2026-03-30T20:36:20Z",
  last_use: "2026-06-09T19:17:53Z",
  daily: [{ date: "2026-06-09" }, { date: "2026-06-08" }],
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

  describe("getGauges() with fixture files", () => {
    it("reads all three sources and computes savings", (t) => {
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

      const [headroom, leanCtx, lcm] = gauges;
      // headroom: 1000 raw vs 600 weighted -> 40% saved
      assert.strictEqual(headroom.rawTokens, 1000);
      assert.strictEqual(headroom.effectiveTokens, 600);
      assert.strictEqual(headroom.savingsPct, 40);
      assert.strictEqual(headroom.detail.cacheReads, 800);
      assert.strictEqual(headroom.detail.fiveHourUtilizationPct, 28);

      // lean-ctx: 200 in vs 150 out -> 25% saved
      assert.strictEqual(leanCtx.rawTokens, 200);
      assert.strictEqual(leanCtx.effectiveTokens, 150);
      assert.strictEqual(leanCtx.savingsPct, 25);
      assert.strictEqual(leanCtx.detail.totalCommands, 3);
      assert.strictEqual(leanCtx.detail.daysTracked, 2);

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
