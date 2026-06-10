const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createUsageSources } = require("../src/usage-sources");

let sqlite = null;
try {
  sqlite = require("node:sqlite");
} catch (e) {
  // sqlite-backed assertions degrade gracefully
}

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const KEY = "sk-or-v1-AGGREGATOR-TEST-KEY";

const EXPECTED_ROUTES = [
  "GET /api/usage/sources",
  "GET /api/usage/claude-code",
  "GET /api/usage/codex",
  "GET /api/usage/nine-router",
  "GET /api/usage/subscription",
  "GET /api/usage/openrouter",
];

function writeClaudeFixture(projectsDir) {
  const proj = path.join(projectsDir, "-home-user");
  fs.mkdirSync(proj, { recursive: true });
  const lines = [
    JSON.stringify({
      type: "user",
      sessionId: "s1",
      cwd: "/home/user",
      timestamp: new Date(NOW - HOUR).toISOString(),
      message: { role: "user", content: "hi" },
    }),
    JSON.stringify({
      type: "assistant",
      sessionId: "s1",
      cwd: "/home/user",
      timestamp: new Date(NOW - HOUR + 1000).toISOString(),
      message: {
        role: "assistant",
        model: "claude-fable-5",
        content: [],
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    }),
  ];
  fs.writeFileSync(path.join(proj, "s1.jsonl"), lines.join("\n") + "\n");
}

function writeCodexFixture(codexDir) {
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "history.jsonl"),
    JSON.stringify({ session_id: "c1", ts: Math.floor((NOW - HOUR) / 1000), text: "hello" }) + "\n",
  );
}

function writeNineRouterFixture(dbPath) {
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE usageHistory (
      id INTEGER PRIMARY KEY, timestamp TEXT, provider TEXT, model TEXT,
      apiKey TEXT, promptTokens INTEGER, completionTokens INTEGER, cost REAL, status TEXT
    );
    CREATE TABLE usageDaily (dateKey TEXT PRIMARY KEY, data TEXT);
  `);
  db.prepare(
    "INSERT INTO usageHistory VALUES (1, ?, 'openai', 'gpt-5.1', 'SECRET', 5, 5, 0.001, 'success')",
  ).run(new Date(NOW - HOUR).toISOString());
  db.close();
}

function writeHeadroomFixture(statsPath) {
  fs.writeFileSync(
    statsPath,
    JSON.stringify({
      latest: {
        five_hour: { utilization_pct: 10, resets_at: null, seconds_to_reset: null },
        polled_at: new Date(NOW - 60 * 1000).toISOString(),
        token_prefix: "sk-ant-x",
      },
      window_tokens: { input: 1, output: 2, cache_reads: 3, cache_writes_total: 4 },
    }),
  );
}

function openrouterFetch() {
  return async (url) => ({
    ok: true,
    status: 200,
    json: async () =>
      url.includes("/credits")
        ? { data: { total_credits: 100, total_usage: 25 } }
        : { data: { label: "agg", usage: 25, limit: 100 } },
  });
}

describe("usage-sources aggregator (index)", () => {
  let tmpDir;
  let config;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-sources-test-"));
    const projectsDir = path.join(tmpDir, "projects");
    const codexDir = path.join(tmpDir, ".codex");
    const dbPath = path.join(tmpDir, "data.sqlite");
    const statsPath = path.join(tmpDir, "subscription_state.json");

    writeClaudeFixture(projectsDir);
    writeCodexFixture(codexDir);
    if (sqlite) writeNineRouterFixture(dbPath);
    writeHeadroomFixture(statsPath);

    config = {
      claudeProjectsDir: projectsDir,
      codexDir,
      nineRouterDb: dbPath,
      headroomStats: statsPath,
      openrouterKey: KEY,
      psFn: async () => [{ pid: 1, tty: "pts/0", command: "claude" }],
      fetchFn: openrouterFetch(),
      nowFn: () => NOW,
    };
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("getAll()", () => {
    it("collects all five sources in one parallel snapshot", async (t) => {
      if (!sqlite) return t.skip("node:sqlite unavailable");
      const all = await createUsageSources(config).getAll();

      assert.deepStrictEqual(Object.keys(all).sort(), [
        "claudeCode",
        "codex",
        "headroom",
        "nineRouter",
        "openrouter",
      ]);

      assert.strictEqual(all.claudeCode.available, true);
      assert.strictEqual(all.claudeCode.sessions.length, 1);
      assert.strictEqual(all.claudeCode.sessions[0].tokens.input, 10);
      assert.strictEqual(all.claudeCode.live.count, 1);
      assert.strictEqual(all.claudeCode.windows.h24.requests, 1);

      assert.strictEqual(all.codex.available, true);
      assert.strictEqual(all.codex.activity.tokensAvailable, false);
      assert.strictEqual(all.codex.activity.entries, 1);

      assert.strictEqual(all.nineRouter.available, true);
      assert.strictEqual(all.nineRouter.usage.totals.requests, 1);

      assert.strictEqual(all.headroom.available, true);
      assert.strictEqual(all.headroom.stale, false);

      assert.strictEqual(all.openrouter.available, true);
      assert.strictEqual(all.openrouter.credits.remaining, 75);
      assert.strictEqual(all.openrouter.keyInfo.label, "agg");
    });

    it("isolates a broken source without hiding the others", async () => {
      const badDb = path.join(tmpDir, "broken.sqlite");
      fs.writeFileSync(badDb, "not a sqlite database");
      const all = await createUsageSources({
        ...config,
        nineRouterDb: badDb,
        fetchFn: async () => {
          throw new Error(`boom ${KEY}`);
        },
      }).getAll();

      // nine-router opens but queries fail -> graceful per-call failure
      assert.strictEqual(all.nineRouter.usage.available, false);
      // openrouter fetch throws -> error captured, key scrubbed
      assert.strictEqual(all.openrouter.available, true);
      assert.ok(all.openrouter.credits.error.includes("[redacted]"));
      assert.ok(!JSON.stringify(all).includes(KEY));
      // healthy sources unaffected
      assert.strictEqual(all.claudeCode.available, true);
      assert.strictEqual(all.headroom.available, true);
    });

    it("marks everything unavailable on an empty host without throwing", async () => {
      const empty = path.join(tmpDir, "empty-host");
      fs.mkdirSync(empty, { recursive: true });
      const all = await createUsageSources({
        claudeProjectsDir: path.join(empty, "projects"),
        codexDir: path.join(empty, ".codex"),
        nineRouterDb: path.join(empty, "data.sqlite"),
        headroomStats: path.join(empty, "subscription_state.json"),
      }).getAll();

      assert.strictEqual(all.claudeCode.available, false);
      assert.strictEqual(all.codex.available, false);
      assert.strictEqual(all.nineRouter.available, false);
      assert.strictEqual(all.headroom.available, false);
      assert.strictEqual(all.openrouter.available, false);
      for (const source of Object.values(all)) {
        assert.ok(source.reason.length > 0, "every unavailable source carries a reason");
      }
    });
  });

  describe("routes map", () => {
    it("exposes the documented route keys as async handlers", () => {
      const { routes } = createUsageSources(config);
      assert.deepStrictEqual(Object.keys(routes).sort(), [...EXPECTED_ROUTES].sort());
      for (const handler of Object.values(routes)) {
        assert.strictEqual(typeof handler, "function");
      }
    });

    it("handlers accept URLSearchParams queries", async () => {
      const { routes } = createUsageSources(config);
      const result = await routes["GET /api/usage/claude-code"]({
        query: new URLSearchParams("sinceMs=0&limit=5"),
      });
      assert.strictEqual(result.available, true);
      assert.strictEqual(result.sessions.length, 1);
      assert.ok(result.live);
      assert.ok(result.windows);
    });

    it("handlers accept plain-object queries and no ctx at all", async (t) => {
      if (!sqlite) return t.skip("node:sqlite unavailable");
      const { routes } = createUsageSources(config);

      const nineRouter = await routes["GET /api/usage/nine-router"]({
        query: { sinceMs: 0, days: 7 },
      });
      assert.strictEqual(nineRouter.available, true);
      assert.strictEqual(nineRouter.usage.totals.requests, 1);

      const subscription = await routes["GET /api/usage/subscription"]();
      assert.strictEqual(subscription.available, true);
      assert.ok(!JSON.stringify(subscription).includes("sk-ant"));

      const openrouter = await routes["GET /api/usage/openrouter"]();
      assert.strictEqual(openrouter.available, true);
      assert.strictEqual(openrouter.credits.totalCredits, 100);
    });

    it("ignores invalid query values instead of failing", async () => {
      const { routes } = createUsageSources(config);
      const result = await routes["GET /api/usage/codex"]({
        query: new URLSearchParams("sinceMs=banana&limit=banana"),
      });
      assert.strictEqual(result.available, true);
      assert.strictEqual(result.activity.entries, 1);
    });

    it("every handler returns a JSON-serializable object", async () => {
      const { routes } = createUsageSources(config);
      for (const [route, handler] of Object.entries(routes)) {
        const result = await handler({ query: new URLSearchParams() });
        assert.strictEqual(typeof result, "object", route);
        assert.doesNotThrow(() => JSON.stringify(result), route);
      }
    });
  });

  describe("sources object", () => {
    it("exposes the five adapter instances for direct wiring", () => {
      const { sources } = createUsageSources(config);
      assert.deepStrictEqual(Object.keys(sources).sort(), [
        "claudeCode",
        "codex",
        "headroom",
        "nineRouter",
        "openrouter",
      ]);
      assert.strictEqual(sources.claudeCode.source, "claude-code");
      assert.strictEqual(sources.openrouter.available, true);
    });
  });
});
