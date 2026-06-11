/**
 * Tests for the pure (DOM-free) helpers used by the Sessions detail-list
 * view. The module is browser ESM, so it is loaded via dynamic import.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert");

let sessionStatus;
let toSessionRow;
let filterSessionRows;
let formatTokensCompact;

before(async () => {
  const mod = await import("../public/js/views/sessions.js");
  sessionStatus = mod.sessionStatus;
  toSessionRow = mod.toSessionRow;
  filterSessionRows = mod.filterSessionRows;
  formatTokensCompact = mod.formatTokensCompact;
});

const SESSIONS = [
  {
    sessionKey: "agent:main:slack:channel:c0aan38tzv5",
    sessionId: "uuid-1",
    label: "#cc-dev",
    groupChannel: "#cc-dev",
    displayName: null,
    kind: "group",
    channel: "slack",
    sessionType: "channel",
    active: true,
    recentlyActive: true,
    minutesAgo: 2,
    tokens: 120500,
    model: "anthropic/claude-opus-4",
    originator: { userId: "U123", username: "aaron", displayName: "Aaron", role: "owner" },
    topic: "Dev, AI",
    metrics: { burnRate: 5200, toolCalls: 0, minutesActive: 23 },
  },
  {
    sessionKey: "agent:main:subagent:abc",
    sessionId: "uuid-2",
    label: "Sub-agent abc",
    groupChannel: null,
    displayName: null,
    kind: "spawn-child",
    channel: "other",
    sessionType: "subagent",
    active: false,
    recentlyActive: true,
    minutesAgo: 25,
    tokens: 900,
    model: "claude-haiku-4",
    originator: null,
    topic: null,
    metrics: { burnRate: 36, toolCalls: 0, minutesActive: 25 },
  },
  {
    sessionKey: "agent:main:telegram:dm:42",
    sessionId: null,
    label: "📱 Telegram",
    kind: "direct",
    channel: "telegram",
    sessionType: "channel",
    active: false,
    recentlyActive: false,
    minutesAgo: 4320,
    tokens: 0,
    model: null,
    originator: null,
    topic: null,
    metrics: { burnRate: 0, toolCalls: 0, minutesActive: 1440 },
  },
];

describe("sessionStatus()", () => {
  it("classifies active sessions as live", () => {
    assert.strictEqual(sessionStatus(SESSIONS[0]), "live");
  });

  it("classifies inactive-but-recent sessions as recent", () => {
    assert.strictEqual(sessionStatus(SESSIONS[1]), "recent");
  });

  it("classifies everything else as idle", () => {
    assert.strictEqual(sessionStatus(SESSIONS[2]), "idle");
    assert.strictEqual(sessionStatus({}), "idle");
  });
});

describe("formatTokensCompact()", () => {
  it("renders thousands with one decimal and a k suffix", () => {
    assert.strictEqual(formatTokensCompact(120500), "120.5k");
    assert.strictEqual(formatTokensCompact(1000), "1.0k");
  });

  it("renders sub-thousand values verbatim", () => {
    assert.strictEqual(formatTokensCompact(900), "900");
    assert.strictEqual(formatTokensCompact(0), "0");
  });

  it("normalizes junk to 0", () => {
    assert.strictEqual(formatTokensCompact(null), "0");
    assert.strictEqual(formatTokensCompact(undefined), "0");
    assert.strictEqual(formatTokensCompact("nope"), "0");
  });
});

describe("toSessionRow()", () => {
  it("flattens session fields onto sortable/filterable row keys", () => {
    const row = toSessionRow(SESSIONS[0]);
    assert.strictEqual(row.id, "agent:main:slack:channel:c0aan38tzv5");
    assert.strictEqual(row.label, "#cc-dev");
    assert.strictEqual(row.channel, "slack");
    assert.strictEqual(row.kind, "channel");
    assert.strictEqual(row.model, "opus-4");
    assert.strictEqual(row.status, "live");
    assert.strictEqual(row.statusRank, 0);
    assert.strictEqual(row.tokens, 120500);
    assert.strictEqual(row.burnRate, 5200);
    assert.strictEqual(row.minutesAgo, 2);
    assert.strictEqual(row.originatorName, "Aaron");
    assert.strictEqual(row.topic, "Dev, AI");
    assert.strictEqual(row.session, SESSIONS[0]);
  });

  it("ranks recent and idle statuses after live", () => {
    assert.strictEqual(toSessionRow(SESSIONS[1]).statusRank, 1);
    assert.strictEqual(toSessionRow(SESSIONS[2]).statusRank, 2);
  });

  it("strips model provider prefixes", () => {
    assert.strictEqual(toSessionRow(SESSIONS[1]).model, "haiku-4");
  });

  it("normalizes missing fields", () => {
    const row = toSessionRow({ sessionKey: "k" });
    assert.strictEqual(row.id, "k");
    assert.strictEqual(row.label, "k");
    assert.strictEqual(row.channel, "other");
    assert.strictEqual(row.kind, "");
    assert.strictEqual(row.model, "");
    assert.strictEqual(row.status, "idle");
    assert.strictEqual(row.tokens, 0);
    assert.strictEqual(row.burnRate, 0);
    assert.strictEqual(row.minutesAgo, null);
    assert.strictEqual(row.originatorName, "");
    assert.strictEqual(row.topic, "");
  });

  it("falls back to originator username when no display name", () => {
    const row = toSessionRow({
      sessionKey: "k",
      originator: { username: "bob" },
    });
    assert.strictEqual(row.originatorName, "bob");
  });
});

describe("filterSessionRows()", () => {
  const rows = SESSIONS.map((s) => ({
    channel: s.channel,
    kind: s.sessionType,
    id: s.sessionKey,
  }));
  const ALL = { channel: "all", kind: "all" };

  it("passes everything for all-pass filters", () => {
    assert.strictEqual(filterSessionRows(rows, ALL).length, 3);
  });

  it("filters by channel", () => {
    assert.deepStrictEqual(
      filterSessionRows(rows, { ...ALL, channel: "slack" }).map((r) => r.id),
      ["agent:main:slack:channel:c0aan38tzv5"],
    );
  });

  it("filters by kind (sessionType)", () => {
    assert.deepStrictEqual(
      filterSessionRows(rows, { ...ALL, kind: "subagent" }).map((r) => r.id),
      ["agent:main:subagent:abc"],
    );
  });

  it("combines channel and kind filters", () => {
    assert.deepStrictEqual(filterSessionRows(rows, { channel: "telegram", kind: "subagent" }), []);
  });

  it("does not mutate the input array", () => {
    const copy = JSON.parse(JSON.stringify(rows));
    filterSessionRows(rows, { ...ALL, channel: "slack" });
    assert.deepStrictEqual(rows, copy);
  });
});
