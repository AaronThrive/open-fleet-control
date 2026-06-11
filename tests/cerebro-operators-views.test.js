const { describe, it } = require("node:test");
const assert = require("node:assert");

/** The view modules are browser ESM; node:test loads them via dynamic import. */
async function cerebroHelpers() {
  return import("../public/js/views/cerebro.js");
}
async function operatorsHelpers() {
  return import("../public/js/views/operators.js");
}

describe("cerebro view pure helpers", () => {
  describe("shortenPath()", () => {
    it("shortens macOS and Linux home prefixes to ~", async () => {
      const { shortenPath } = await cerebroHelpers();
      assert.strictEqual(shortenPath("/Users/aaron/cerebro"), "~/cerebro");
      assert.strictEqual(shortenPath("/home/broclaw2/cerebro"), "~/cerebro");
    });

    it("leaves non-home paths untouched and defaults to ~/cerebro", async () => {
      const { shortenPath } = await cerebroHelpers();
      assert.strictEqual(shortenPath("/srv/cerebro"), "/srv/cerebro");
      assert.strictEqual(shortenPath(null), "~/cerebro");
    });
  });

  describe("initCommands()", () => {
    it("builds the topics and orphans mkdir commands from the path", async () => {
      const { initCommands } = await cerebroHelpers();
      assert.deepStrictEqual(initCommands("/home/x/cerebro"), [
        "mkdir -p ~/cerebro/topics",
        "mkdir -p ~/cerebro/orphans",
      ]);
    });
  });

  describe("buildTopicRows()", () => {
    const CEREBRO = {
      recentTopics: [
        { name: "alpha", title: "Alpha topic", status: "active", threads: 3, age: "5m" },
        { name: "beta", title: "", status: "resolved", threads: "2", age: "" },
        { name: "hidden-one", title: "Secret", status: "parked", threads: 0, age: "1d" },
        { title: "no name — dropped" },
        null,
      ],
    };

    it("flattens topics with defaults for missing fields", async () => {
      const { buildTopicRows } = await cerebroHelpers();
      const rows = buildTopicRows(CEREBRO);
      assert.strictEqual(rows.length, 3);
      assert.deepStrictEqual(rows[0], {
        name: "alpha",
        title: "Alpha topic",
        status: "active",
        threads: 3,
        age: "5m",
      });
      // Empty title falls back to name, string thread counts are coerced
      assert.strictEqual(rows[1].title, "beta");
      assert.strictEqual(rows[1].threads, 2);
      assert.strictEqual(rows[1].age, "—");
    });

    it("drops privacy-hidden topics via the isHidden callback", async () => {
      const { buildTopicRows } = await cerebroHelpers();
      const rows = buildTopicRows(CEREBRO, (name) => name === "hidden-one");
      assert.deepStrictEqual(
        rows.map((r) => r.name),
        ["alpha", "beta"],
      );
    });

    it("returns an empty list for missing/uninitialized payloads", async () => {
      const { buildTopicRows } = await cerebroHelpers();
      assert.deepStrictEqual(buildTopicRows(null), []);
      assert.deepStrictEqual(buildTopicRows({}), []);
    });
  });

  describe("countText()", () => {
    it("shows the plain total when nothing is hidden", async () => {
      const { countText } = await cerebroHelpers();
      assert.strictEqual(countText(7, 7, 0), "7");
    });

    it("shows the visible/hidden breakdown when topics are hidden", async () => {
      const { countText } = await cerebroHelpers();
      assert.strictEqual(countText(7, 5, 2), "7 (5 visible, 2 hidden)");
    });
  });
});

describe("operators view pure helpers", () => {
  const SESSIONS = [
    { sessionKey: "s1", label: "Build", active: true, tokens: 1500, originator: { userId: "u1" } },
    {
      sessionKey: "s2",
      label: "Chat",
      active: false,
      tokens: 500,
      originator: { userId: "slack-9" },
    },
    {
      sessionKey: "s3",
      label: "Misc",
      active: false,
      tokens: 250,
      originator: { displayName: "Aaron" },
    },
    {
      sessionKey: "s4",
      label: "Other",
      active: true,
      tokens: 9999,
      originator: { userId: "someone-else" },
    },
    { sessionKey: "s5", label: "No originator", tokens: 10 },
  ];

  const OPERATOR = {
    id: "u1",
    username: "aaron",
    displayName: "Aaron",
    role: "owner",
    source: "slack",
    firstSeen: "2026-01-01T00:00:00.000Z",
    metadata: { slackId: "slack-9" },
    stats: { activeSessions: 1, totalSessions: 3, lastSeen: "2026-06-11T00:00:00.000Z" },
  };

  describe("sessionsForOperator()", () => {
    it("matches by operator id, slack id, and display name", async () => {
      const { sessionsForOperator } = await operatorsHelpers();
      const matched = sessionsForOperator(OPERATOR, SESSIONS);
      assert.deepStrictEqual(
        matched.map((s) => s.sessionKey),
        ["s1", "s2", "s3"],
      );
    });

    it("never matches sessions without an originator", async () => {
      const { sessionsForOperator } = await operatorsHelpers();
      const matched = sessionsForOperator({ id: "x", username: undefined }, SESSIONS);
      assert.deepStrictEqual(matched, []);
    });
  });

  describe("formatTokens()", () => {
    it("formats thousands and millions compactly", async () => {
      const { formatTokens } = await operatorsHelpers();
      assert.strictEqual(formatTokens(999), "999");
      assert.strictEqual(formatTokens(2250), "2.3k");
      assert.strictEqual(formatTokens(2500000), "2.5M");
      assert.strictEqual(formatTokens(undefined), "0");
    });
  });

  describe("buildOperatorRows()", () => {
    it("builds rows with token totals and recent session breakdown", async () => {
      const { buildOperatorRows } = await operatorsHelpers();
      const rows = buildOperatorRows([OPERATOR], SESSIONS);
      assert.strictEqual(rows.length, 1);
      const row = rows[0];
      assert.strictEqual(row.id, "u1");
      assert.strictEqual(row.name, "Aaron");
      assert.strictEqual(row.role, "owner");
      assert.strictEqual(row.slackId, "slack-9");
      assert.strictEqual(row.tokens, 2250);
      assert.strictEqual(row.active, 1); // server stats preferred
      assert.strictEqual(row.sessions, 3);
      assert.strictEqual(row.lastSeenMs, new Date("2026-06-11T00:00:00.000Z").getTime());
      assert.deepStrictEqual(row.recentSessions[0], { label: "Build", active: true, tokens: 1500 });
    });

    it("falls back to session-derived counts when server stats are absent", async () => {
      const { buildOperatorRows } = await operatorsHelpers();
      const bare = { id: "u1", username: "aaron", metadata: { slackId: "slack-9" } };
      const [row] = buildOperatorRows([bare], SESSIONS);
      assert.strictEqual(row.active, 1); // s1 active
      assert.strictEqual(row.sessions, 2); // s1 + s2 (no displayName match)
      assert.strictEqual(row.role, "user");
      assert.strictEqual(row.lastSeenMs, 0);
    });

    it("skips empty operator records and handles missing sessions", async () => {
      const { buildOperatorRows } = await operatorsHelpers();
      const rows = buildOperatorRows([null, {}, { username: "ghost" }], null);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].id, "ghost");
      assert.strictEqual(rows[0].tokens, 0);
      assert.deepStrictEqual(rows[0].recentSessions, []);
    });
  });
});
