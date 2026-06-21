const { describe, it, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createHermesAgents,
  summarizeHermesSessions,
  agentIdFromSessionKey,
  parseHermesModel,
  ACTIVE_THRESHOLD_MS,
} = require("../src/hermes-agents");

// ---------------------------------------------------------------------------
// Fixtures — mirror the real ~/.hermes layout:
//   <hermesDir>/sessions/sessions.json
//   <hermesDir>/config.yaml
//   <hermesDir>/workspace/
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-06-10T12:00:00");

function hermesSession(key, updatedAt, extra = {}) {
  return {
    session_key: key,
    session_id: "20260610_000000_abcdef12",
    created_at: "2026-06-01T00:00:00.000000",
    updated_at: updatedAt,
    platform: "slack",
    chat_type: "dm",
    total_tokens: 0,
    estimated_cost_usd: 0.0,
    ...extra,
  };
}

const CONFIG_YAML = [
  "model:",
  "  default: gpt-5.5",
  "  provider: openai",
  "providers: {}",
  "agent:",
  "  max_turns: 90",
  "",
].join("\n");

/** Build a throwaway ~/.hermes-shaped tree. */
function makeHermesTree({ sessions, configYaml = CONFIG_YAML, workspace = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-agents-test-"));
  if (sessions !== null && sessions !== undefined) {
    fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "sessions", "sessions.json"),
      typeof sessions === "string" ? sessions : JSON.stringify(sessions, null, 2),
    );
  }
  if (configYaml !== null) fs.writeFileSync(path.join(root, "config.yaml"), configYaml);
  if (workspace) fs.mkdirSync(path.join(root, "workspace"), { recursive: true });
  return root;
}

const roots = [];
function tree(opts) {
  const root = makeHermesTree(opts);
  roots.push(root);
  return root;
}

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("agentIdFromSessionKey", () => {
  it("extracts the agent id from agent:<id>:... keys", () => {
    assert.equal(agentIdFromSessionKey("agent:main:slack:dm:D0B86HQ3SQ1:1780527444.5"), "main");
    assert.equal(agentIdFromSessionKey("agent:ops:cli:local:x:y"), "ops");
  });

  it("falls back to 'hermes' for unknown shapes", () => {
    assert.equal(agentIdFromSessionKey("not-an-agent-key"), "hermes");
    assert.equal(agentIdFromSessionKey("agent:"), "hermes");
    assert.equal(agentIdFromSessionKey(null), "hermes");
  });
});

describe("summarizeHermesSessions", () => {
  it("groups sessions per agent with latest updated_at", () => {
    const summaries = summarizeHermesSessions({
      "agent:main:slack:dm:D1:1": hermesSession("agent:main:slack:dm:D1:1", "2026-06-08T10:00:00"),
      "agent:main:slack:dm:D1:2": hermesSession("agent:main:slack:dm:D1:2", "2026-06-09T10:00:00"),
      "agent:ops:cli:local:x:y": hermesSession("agent:ops:cli:local:x:y", "2026-06-05T10:00:00"),
    });
    assert.deepEqual(Object.keys(summaries).sort(), ["main", "ops"]);
    assert.equal(summaries.main.sessionCount, 2);
    assert.equal(summaries.main.lastActiveAt, Date.parse("2026-06-09T10:00:00"));
    assert.equal(summaries.ops.sessionCount, 1);
  });

  it("falls back to created_at when updated_at is missing", () => {
    const summaries = summarizeHermesSessions({
      "agent:main:a:b:c:d": hermesSession("agent:main:a:b:c:d", undefined),
    });
    assert.equal(summaries.main.lastActiveAt, Date.parse("2026-06-01T00:00:00.000000"));
  });

  it("tolerates malformed shapes", () => {
    assert.deepEqual(summarizeHermesSessions(null), {});
    assert.deepEqual(summarizeHermesSessions([]), {});
    assert.deepEqual(summarizeHermesSessions("nope"), {});
    const summaries = summarizeHermesSessions({ "agent:main:a:b:c:d": null });
    assert.equal(summaries.main.sessionCount, 1);
    assert.equal(summaries.main.lastActiveAt, null);
  });
});

describe("parseHermesModel", () => {
  it("combines provider and default from the model block", () => {
    assert.equal(parseHermesModel(CONFIG_YAML), "openai/gpt-5.5");
  });

  it("returns the bare model when no provider is set", () => {
    assert.equal(parseHermesModel("model:\n  default: gpt-5.5\nagent:\n"), "gpt-5.5");
  });

  it("returns null when the block or default is missing", () => {
    assert.equal(parseHermesModel("agent:\n  max_turns: 90\n"), null);
    assert.equal(parseHermesModel("model:\n  provider: openai\nagent:\n"), null);
    assert.equal(parseHermesModel(null), null);
  });
});

// ---------------------------------------------------------------------------
// createHermesAgents
// ---------------------------------------------------------------------------

describe("createHermesAgents", () => {
  it("requires a hermesDir string", () => {
    assert.throws(() => createHermesAgents({}), /hermesDir/);
  });

  it("lists agents in the openclaw roster entry shape", () => {
    const root = tree({
      sessions: {
        "agent:main:slack:dm:D1:1": hermesSession(
          "agent:main:slack:dm:D1:1",
          "2026-06-10T11:55:00", // 5 min before NOW — active
        ),
        "agent:main:slack:dm:D1:2": hermesSession(
          "agent:main:slack:dm:D1:2",
          "2026-06-04T00:00:00",
        ),
      },
    });
    const adapter = createHermesAgents({ hermesDir: root, nowFn: () => NOW });
    const agents = adapter.listAgents();

    assert.equal(agents.length, 1);
    assert.deepEqual(agents[0], {
      id: "main",
      name: "Hermes",
      model: "openai/gpt-5.5",
      workspace: path.join(root, "workspace"),
      subagentsMax: null,
      sessionCount: 2,
      lastActiveAt: Date.parse("2026-06-10T11:55:00"),
      active: true,
      source: "hermes",
    });
  });

  it("marks agents idle past the activity threshold", () => {
    const root = tree({
      sessions: {
        "agent:main:slack:dm:D1:1": hermesSession(
          "agent:main:slack:dm:D1:1",
          "2026-06-10T11:55:00",
        ),
      },
    });
    const adapter = createHermesAgents({
      hermesDir: root,
      nowFn: () => Date.parse("2026-06-10T11:55:00") + ACTIVE_THRESHOLD_MS,
    });
    assert.equal(adapter.listAgents()[0].active, false);
  });

  it("enumerates multiple distinct agent ids, sorted", () => {
    const root = tree({
      sessions: {
        "agent:ops:cli:local:x:1": hermesSession("agent:ops:cli:local:x:1", "2026-06-09T00:00:00"),
        "agent:main:slack:dm:D1:1": hermesSession(
          "agent:main:slack:dm:D1:1",
          "2026-06-08T00:00:00",
        ),
      },
    });
    const adapter = createHermesAgents({ hermesDir: root, nowFn: () => NOW });
    const agents = adapter.listAgents();
    assert.deepEqual(
      agents.map((a) => [a.id, a.name]),
      [
        ["main", "Hermes"],
        ["ops", "Hermes ops"],
      ],
    );
  });

  it("degrades to a single zeroed 'hermes' entry when no sessions exist", () => {
    const root = tree({ sessions: null, configYaml: null, workspace: false });
    const adapter = createHermesAgents({ hermesDir: root, nowFn: () => NOW });
    assert.deepEqual(adapter.listAgents(), [
      {
        id: "hermes",
        name: "Hermes",
        model: null,
        workspace: null,
        subagentsMax: null,
        sessionCount: 0,
        lastActiveAt: null,
        active: false,
        source: "hermes",
      },
    ]);
  });

  it("tolerates malformed sessions.json", () => {
    const root = tree({ sessions: "{ not json" });
    const adapter = createHermesAgents({ hermesDir: root, nowFn: () => NOW });
    const agents = adapter.listAgents();
    assert.equal(agents.length, 1);
    assert.equal(agents[0].id, "hermes");
    assert.equal(agents[0].sessionCount, 0);
  });

  it("tolerates a completely missing hermesDir", () => {
    const adapter = createHermesAgents({
      hermesDir: "/nonexistent/hermes-dir",
      nowFn: () => NOW,
    });
    const agents = adapter.listAgents();
    assert.equal(agents.length, 1);
    assert.equal(agents[0].id, "hermes");
    assert.equal(agents[0].model, null);
    assert.equal(agents[0].workspace, null);
  });
});
