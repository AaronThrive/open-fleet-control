const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createNineRouterSource, parseTimestampMs } = require("../src/usage-sources/nine-router");

// node:sqlite ships with modern Node; used only against temp-dir fixtures
let sqlite = null;
try {
  sqlite = require("node:sqlite");
} catch (e) {
  // sqlite-backed tests will be skipped
}

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const SECRET = "sk-SECRET-NEVER-LEAK";

function createFullFixtureDb(dbPath) {
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE usageHistory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT, provider TEXT, model TEXT, connectionId TEXT,
      apiKey TEXT, endpoint TEXT,
      promptTokens INTEGER, completionTokens INTEGER, cost REAL,
      status TEXT, tokens TEXT, meta TEXT
    );
    CREATE TABLE usageDaily (dateKey TEXT PRIMARY KEY, data TEXT);
    CREATE TABLE providerConnections (
      id TEXT, provider TEXT, authType TEXT, name TEXT, email TEXT,
      priority INTEGER, isActive INTEGER, data TEXT, createdAt TEXT, updatedAt TEXT
    );
  `);
  const insert = db.prepare(
    `INSERT INTO usageHistory
       (timestamp, provider, model, apiKey, promptTokens, completionTokens, cost, status, tokens, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    new Date(NOW - 1 * HOUR).toISOString(),
    "openai",
    "gpt-5.1",
    SECRET,
    100,
    50,
    0.01,
    "success",
    SECRET,
    "{}",
  );
  insert.run(
    new Date(NOW - 2 * HOUR).toISOString(),
    "openai",
    "gpt-5.1-mini",
    SECRET,
    200,
    100,
    0.02,
    "success",
    SECRET,
    "{}",
  );
  insert.run(
    new Date(NOW - 30 * HOUR).toISOString(),
    "anthropic",
    "claude-fable-5",
    SECRET,
    1000,
    500,
    0.5,
    "error",
    SECRET,
    "{}",
  );

  db.prepare("INSERT INTO usageDaily VALUES (?, ?)").run(
    "2026-06-09",
    JSON.stringify({ totalTokens: 1950, cost: 0.53, requests: 3 }),
  );
  db.prepare("INSERT INTO usageDaily VALUES (?, ?)").run("2026-06-08", "{broken json!!");

  db.prepare("INSERT INTO providerConnections VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    "conn-1",
    "openai",
    "api-key",
    "main key",
    "user@example.com",
    1,
    1,
    JSON.stringify({ apiKey: SECRET, refreshToken: SECRET }),
    "2026-06-01T00:00:00Z",
    "2026-06-09T00:00:00Z",
  );
  db.close();
}

describe("usage-sources/nine-router", () => {
  let tmpDir;
  let dbPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-9router-test-"));
    if (sqlite) {
      dbPath = path.join(tmpDir, "data.sqlite");
      createFullFixtureDb(dbPath);
    }
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports unavailable for a missing db without throwing", async () => {
    const source = createNineRouterSource({ dbPath: path.join(tmpDir, "nope.sqlite") });
    assert.strictEqual(source.available, false);
    assert.ok(source.reason.includes("database not found"));
    const usage = await source.getUsage();
    assert.strictEqual(usage.available, false);
  });

  it("reports unavailable when the sqlite loader fails", async (t) => {
    if (!sqlite) return t.skip("node:sqlite unavailable");
    const source = createNineRouterSource({
      dbPath,
      sqliteLoader: () => {
        throw new Error("node:sqlite missing");
      },
    });
    assert.strictEqual(source.available, false);
    assert.ok(source.reason.includes("node:sqlite missing"));
  });

  describe("getUsage()", () => {
    it("aggregates totals, byProvider, byModel, byStatus", async (t) => {
      if (!sqlite) return t.skip("node:sqlite unavailable");
      const usage = await createNineRouterSource({ dbPath }).getUsage();
      assert.strictEqual(usage.available, true);
      assert.deepStrictEqual(usage.totals, {
        requests: 3,
        promptTokens: 1300,
        completionTokens: 650,
        totalTokens: 1950,
        cost: 0.53,
      });
      assert.strictEqual(usage.byProvider.length, 2);
      assert.strictEqual(usage.byProvider[0].provider, "anthropic"); // most tokens first
      assert.strictEqual(usage.byProvider[0].totalTokens, 1500);
      assert.strictEqual(usage.byModel.length, 3);
      assert.deepStrictEqual(usage.byStatus, { success: 2, error: 1 });
      assert.deepStrictEqual(usage.notes, []);
    });

    it("filters by sinceMs", async (t) => {
      if (!sqlite) return t.skip("node:sqlite unavailable");
      const usage = await createNineRouterSource({ dbPath }).getUsage({
        sinceMs: NOW - 24 * HOUR,
      });
      assert.strictEqual(usage.totals.requests, 2);
      assert.strictEqual(usage.totals.totalTokens, 450);
      assert.strictEqual(usage.byProvider.length, 1);
      assert.strictEqual(usage.byProvider[0].provider, "openai");
    });

    it("NEVER returns apiKey/tokens/meta column values", async (t) => {
      if (!sqlite) return t.skip("node:sqlite unavailable");
      const source = createNineRouterSource({ dbPath });
      const everything = JSON.stringify({
        usage: await source.getUsage(),
        daily: await source.getDaily(30),
        connections: await source.getConnections(),
      });
      assert.ok(!everything.includes(SECRET), "secret material leaked into output");
      assert.ok(!everything.includes("user@example.com"), "PII email leaked into output");
    });
  });

  describe("schema drift tolerance", () => {
    it("degrades to partial data when columns are missing", async (t) => {
      if (!sqlite) return t.skip("node:sqlite unavailable");
      const driftDb = path.join(tmpDir, "drift.sqlite");
      const db = new sqlite.DatabaseSync(driftDb);
      db.exec(`
        CREATE TABLE usageHistory (id INTEGER PRIMARY KEY, provider TEXT, promptTokens INTEGER);
        INSERT INTO usageHistory (provider, promptTokens) VALUES ('openai', 42);
      `);
      db.close();

      const usage = await createNineRouterSource({ dbPath: driftDb }).getUsage({ sinceMs: 0 });
      assert.strictEqual(usage.available, true);
      assert.strictEqual(usage.totals.requests, 1);
      assert.strictEqual(usage.totals.promptTokens, 42);
      assert.strictEqual(usage.totals.cost, 0);
      assert.ok(usage.notes.some((n) => n.includes("completionTokens")));
      assert.ok(usage.notes.some((n) => n.includes("cost")));
      assert.ok(usage.notes.some((n) => n.includes("timestamp")));
    });

    it("reports a note when usageHistory is missing entirely", async (t) => {
      if (!sqlite) return t.skip("node:sqlite unavailable");
      const emptyDb = path.join(tmpDir, "empty.sqlite");
      const db = new sqlite.DatabaseSync(emptyDb);
      db.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY);");
      db.close();

      const source = createNineRouterSource({ dbPath: emptyDb });
      const usage = await source.getUsage();
      assert.strictEqual(usage.available, true);
      assert.deepStrictEqual(usage.totals, {
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cost: 0,
      });
      assert.ok(usage.notes[0].includes("usageHistory table missing"));

      const daily = await source.getDaily();
      assert.deepStrictEqual(daily.days, []);
      assert.ok(daily.notes[0].includes("usageDaily table missing"));
    });

    it("survives a corrupt database file", async () => {
      const badDb = path.join(tmpDir, "corrupt.sqlite");
      fs.writeFileSync(badDb, "this is definitely not sqlite");
      const usage = await createNineRouterSource({ dbPath: badDb }).getUsage();
      assert.strictEqual(usage.available, false);
      assert.ok(usage.reason.length > 0);
    });
  });

  describe("getDaily()", () => {
    it("parses daily JSON blobs and flags unparseable ones", async (t) => {
      if (!sqlite) return t.skip("node:sqlite unavailable");
      const daily = await createNineRouterSource({ dbPath }).getDaily(7);
      assert.strictEqual(daily.available, true);
      assert.strictEqual(daily.days.length, 2);
      assert.strictEqual(daily.days[0].date, "2026-06-09"); // newest first
      assert.deepStrictEqual(daily.days[0].summary, { totalTokens: 1950, cost: 0.53, requests: 3 });
      assert.ok(daily.days[1].note.includes("unparseable"));
    });

    it("limits to the requested number of days", async (t) => {
      if (!sqlite) return t.skip("node:sqlite unavailable");
      const daily = await createNineRouterSource({ dbPath }).getDaily(1);
      assert.strictEqual(daily.days.length, 1);
    });
  });

  describe("getConnections()", () => {
    it("returns redacted connection rows (no data, no email)", async (t) => {
      if (!sqlite) return t.skip("node:sqlite unavailable");
      const result = await createNineRouterSource({ dbPath }).getConnections();
      assert.strictEqual(result.available, true);
      assert.strictEqual(result.connections.length, 1);
      const conn = result.connections[0];
      assert.strictEqual(conn.id, "conn-1");
      assert.strictEqual(conn.provider, "openai");
      assert.strictEqual(conn.authType, "api-key");
      assert.ok(!("data" in conn));
      assert.ok(!("email" in conn));
    });
  });

  describe("parseTimestampMs()", () => {
    it("handles ISO text, epoch seconds, epoch ms, and junk", () => {
      assert.strictEqual(
        parseTimestampMs("2026-06-09T00:00:00Z"),
        Date.parse("2026-06-09T00:00:00Z"),
      );
      assert.strictEqual(parseTimestampMs(1777563726), 1777563726000);
      assert.strictEqual(parseTimestampMs(1777563726000), 1777563726000);
      assert.strictEqual(parseTimestampMs("not a date"), null);
      assert.strictEqual(parseTimestampMs(null), null);
      assert.strictEqual(parseTimestampMs(""), null);
    });
  });
});
