const { describe, it, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createAgentsRoster,
  parseAgentsConfig,
  scanSessionsDir,
  isSessionFile,
  nodeBaseUrl,
  ACTIVE_THRESHOLD_MS,
} = require("../src/agents-roster");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = 1_750_000_000_000;

function configFixture() {
  return {
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.5" },
        workspace: "/home/user/.openclaw/workspace",
        subagents: { maxConcurrent: 8 },
      },
      list: [
        { id: "main", model: "openai/gpt-5.5" },
        {
          id: "dev",
          name: "Kelsey CTO",
          workspace: "/home/user/.openclaw/workspace-dev",
          model: "anthropic/claude-opus-4-6",
          subagents: { maxConcurrent: 2 },
        },
        { id: "", name: "broken — no id" },
        null,
      ],
    },
  };
}

/**
 * Build a throwaway fixture tree:
 *   <root>/openclaw.json
 *   <root>/agents/<id>/sessions/<files...>
 * sessionAges maps agent id -> array of session-file ages in ms (mtime = NOW - age).
 */
function makeFixtureTree(config, sessionAges = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agents-roster-test-"));
  const configPath = path.join(root, "openclaw.json");
  if (typeof config === "string") {
    fs.writeFileSync(configPath, config);
  } else if (config !== null) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  const agentsDir = path.join(root, "agents");
  for (const [agentId, ages] of Object.entries(sessionAges)) {
    const sessionsDir = path.join(agentsDir, agentId, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    ages.forEach((ageMs, i) => {
      const file = path.join(sessionsDir, `session-${i}.jsonl`);
      fs.writeFileSync(file, "{}\n");
      const mtime = new Date(NOW - ageMs);
      fs.utimesSync(file, mtime, mtime);
    });
  }
  return { root, configPath, agentsDir };
}

function makeRoster(tree, overrides = {}) {
  return createAgentsRoster({
    openclawConfigPath: tree.configPath,
    agentsDir: tree.agentsDir,
    nowFn: () => NOW,
    hostname: "self-host",
    ...overrides,
  });
}

/** Minimal fetch-shaped response. */
function okResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

function meshFixture(nodes) {
  return { getState: async () => ({ nodes }) };
}

function onlineNode(hostname, url) {
  return { id: `id-${hostname}`, hostname, url, health: { status: "online" } };
}

// Created lazily in before() so failures surface as test failures, and
// removed in after() so fixture trees never leak into the temp dir.
const trees = [];
function tree(config, sessionAges) {
  const t = makeFixtureTree(config, sessionAges);
  trees.push(t);
  return t;
}

after(() => {
  for (const t of trees) {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// parseAgentsConfig — config parsing
// ---------------------------------------------------------------------------

describe("parseAgentsConfig", () => {
  it("parses agents.list with defaults inheritance", () => {
    const agents = parseAgentsConfig(configFixture());
    assert.equal(agents.length, 2); // empty-id and null entries dropped

    const main = agents[0];
    assert.equal(main.id, "main");
    assert.equal(main.name, "main"); // name falls back to id
    assert.equal(main.model, "openai/gpt-5.5");
    assert.equal(main.workspace, "/home/user/.openclaw/workspace"); // default
    assert.equal(main.subagentsMax, 8); // default subagents.maxConcurrent

    const dev = agents[1];
    assert.equal(dev.name, "Kelsey CTO");
    assert.equal(dev.model, "anthropic/claude-opus-4-6"); // per-agent override
    assert.equal(dev.workspace, "/home/user/.openclaw/workspace-dev");
    assert.equal(dev.subagentsMax, 2); // per-agent override
  });

  it("supports a plain-string defaults.model", () => {
    const agents = parseAgentsConfig({
      agents: { defaults: { model: "openai/gpt-5.5" }, list: [{ id: "a" }] },
    });
    assert.equal(agents[0].model, "openai/gpt-5.5");
  });

  it("tolerates malformed shapes", () => {
    assert.deepEqual(parseAgentsConfig(null), []);
    assert.deepEqual(parseAgentsConfig("nope"), []);
    assert.deepEqual(parseAgentsConfig({}), []);
    assert.deepEqual(parseAgentsConfig({ agents: { list: "not-an-array" } }), []);
    assert.deepEqual(parseAgentsConfig({ agents: { list: [{ name: "no id" }] } }), []);
  });

  it("yields nulls when no defaults exist", () => {
    const agents = parseAgentsConfig({ agents: { list: [{ id: "solo" }] } });
    assert.deepEqual(agents[0], {
      id: "solo",
      name: "solo",
      model: null,
      workspace: null,
      subagentsMax: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Session enrichment
// ---------------------------------------------------------------------------

describe("session enrichment", () => {
  it("counts session files and reports the latest mtime", () => {
    const t = tree(configFixture(), {
      main: [60 * 60 * 1000, 5 * 60 * 1000, 24 * 60 * 60 * 1000],
    });
    const roster = makeRoster(t);
    const main = roster.getLocalRoster().agents.find((a) => a.id === "main");
    assert.equal(main.sessionCount, 3);
    assert.equal(main.lastActiveAt, NOW - 5 * 60 * 1000);
  });

  it("excludes sidecar and deleted files from the count", () => {
    const t = tree(configFixture(), { main: [60 * 60 * 1000] });
    const sessionsDir = path.join(t.agentsDir, "main", "sessions");
    for (const sidecar of [
      "abc.jsonl.codex-app-server.json",
      "abc.trajectory.jsonl",
      "abc.trajectory-path.json",
      "abc.jsonl.deleted.2026-06-08T07-13-31.676Z",
    ]) {
      fs.writeFileSync(path.join(sessionsDir, sidecar), "{}");
    }
    const roster = makeRoster(t);
    const main = roster.getLocalRoster().agents.find((a) => a.id === "main");
    assert.equal(main.sessionCount, 1);
  });

  it("tolerates a missing sessions directory", () => {
    const t = tree(configFixture()); // no sessions created at all
    const roster = makeRoster(t);
    const local = roster.getLocalRoster();
    assert.equal(local.agents.length, 2);
    for (const agent of local.agents) {
      assert.equal(agent.sessionCount, 0);
      assert.equal(agent.lastActiveAt, null);
      assert.equal(agent.active, false);
    }
  });

  it("tolerates a missing or malformed config file", () => {
    const missing = makeRoster(tree(null));
    assert.deepEqual(missing.getLocalRoster().agents, []);

    const malformed = makeRoster(tree("{ this is not json"));
    assert.deepEqual(malformed.getLocalRoster().agents, []);
  });
});

// ---------------------------------------------------------------------------
// Activity threshold
// ---------------------------------------------------------------------------

describe("activity threshold", () => {
  it("marks agents active only when the latest session is <10min old", () => {
    const t = tree(configFixture(), {
      main: [5 * 60 * 1000], // 5 min ago — active
      dev: [15 * 60 * 1000], // 15 min ago — idle
    });
    const roster = makeRoster(t);
    const local = roster.getLocalRoster();
    assert.equal(local.agents.find((a) => a.id === "main").active, true);
    assert.equal(local.agents.find((a) => a.id === "dev").active, false);
    assert.deepEqual(local.counts, { total: 2, active: 1 });
  });

  it("treats exactly-at-threshold as idle", () => {
    const t = tree(configFixture(), { main: [ACTIVE_THRESHOLD_MS] });
    const roster = makeRoster(t);
    assert.equal(roster.getLocalRoster().agents.find((a) => a.id === "main").active, false);
  });
});

// ---------------------------------------------------------------------------
// Fleet aggregation (mesh)
// ---------------------------------------------------------------------------

describe("fleet aggregation", () => {
  const remoteAgents = [
    {
      id: "main",
      name: "main",
      model: "openai/gpt-5.5",
      workspace: "/w",
      subagentsMax: 4,
      sessionCount: 7,
      lastActiveAt: NOW - 1000,
      active: true,
    },
  ];

  it("merges ONLINE node agents with node attribution", async () => {
    const t = tree(configFixture(), { main: [5 * 60 * 1000] });
    const calls = [];
    const roster = makeRoster(t, {
      mesh: meshFixture([
        onlineNode("hermes", "https://hermes.tail.net/health"),
        {
          id: "x",
          hostname: "downbox",
          url: "https://downbox/health",
          health: { status: "offline" },
        },
      ]),
      fetchFn: async (url) => {
        calls.push(url);
        return okResponse({ hostname: "hermes", agents: remoteAgents });
      },
    });

    const fleet = await roster.getRoster();
    // Offline node never fetched; online node fetched at its base URL.
    assert.deepEqual(calls, ["https://hermes.tail.net/api/agents"]);
    assert.equal(fleet.agents.length, 3); // 2 local + 1 remote
    assert.deepEqual(Object.keys(fleet.byNode).sort(), ["hermes", "self-host"]);
    assert.equal(fleet.byNode.hermes[0].node, "hermes");
    assert.equal(fleet.byNode["self-host"][0].node, "self-host");
    assert.deepEqual(fleet.counts, { total: 3, active: 2, nodes: 2 });
  });

  it("tolerates 404 from older nodes and network failures", async () => {
    const t = tree(configFixture());
    const roster = makeRoster(t, {
      mesh: meshFixture([
        onlineNode("oldnode", "https://oldnode/health"),
        onlineNode("flaky", "https://flaky/health"),
      ]),
      fetchFn: async (url) => {
        if (url.startsWith("https://oldnode")) {
          return { ok: false, status: 404, json: async () => ({}) };
        }
        throw new Error("ECONNREFUSED");
      },
    });
    const fleet = await roster.getRoster();
    assert.equal(fleet.agents.length, 2); // local-only — both remotes skipped
    assert.deepEqual(fleet.counts, { total: 2, active: 0, nodes: 1 });
  });

  it("skips nodes registered under this host's own name", async () => {
    const t = tree(configFixture());
    const calls = [];
    const roster = makeRoster(t, {
      mesh: meshFixture([onlineNode("self-host", "https://self-host/health")]),
      fetchFn: async (url) => {
        calls.push(url);
        return okResponse({ agents: remoteAgents });
      },
    });
    const fleet = await roster.getRoster();
    assert.deepEqual(calls, []);
    assert.equal(fleet.agents.length, 2);
  });

  it("caches the aggregation for 60s", async () => {
    const t = tree(configFixture());
    let now = NOW;
    let fetches = 0;
    const roster = makeRoster(t, {
      nowFn: () => now,
      mesh: meshFixture([onlineNode("hermes", "https://hermes/health")]),
      fetchFn: async () => {
        fetches++;
        return okResponse({ agents: remoteAgents });
      },
    });

    await roster.getRoster();
    await roster.getRoster();
    assert.equal(fetches, 1); // second call served from cache

    now = NOW + 61 * 1000;
    await roster.getRoster();
    assert.equal(fetches, 2); // cache expired — refetched
  });

  it("works without a mesh (local-only fleet)", async () => {
    const t = tree(configFixture());
    const roster = makeRoster(t);
    const fleet = await roster.getRoster();
    assert.equal(fleet.agents.length, 2);
    assert.deepEqual(fleet.counts, { total: 2, active: 0, nodes: 1 });
  });
});

// ---------------------------------------------------------------------------
// Assignees
// ---------------------------------------------------------------------------

describe("getAssignees", () => {
  it("returns sorted plain ids plus id@node forms", async () => {
    const t = tree(configFixture());
    const roster = makeRoster(t, {
      mesh: meshFixture([onlineNode("hermes", "https://hermes/health")]),
      fetchFn: async () => okResponse({ agents: [{ id: "main" }] }),
    });
    const assignees = await roster.getAssignees();
    assert.deepEqual(assignees, ["dev", "dev@self-host", "main", "main@hermes", "main@self-host"]);
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe("routes", () => {
  function mockRes() {
    const res = { statusCode: null, headers: null, body: null };
    res.writeHead = (code, headers) => {
      res.statusCode = code;
      res.headers = headers;
    };
    res.end = (body) => {
      res.body = body;
    };
    return res;
  }

  it("GET /api/agents serves the local-only roster", async () => {
    const t = tree(configFixture(), { main: [5 * 60 * 1000] });
    const roster = makeRoster(t);
    const res = mockRes();
    await roster.routes["GET /api/agents"]({ method: "GET" }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["Content-Type"], "application/json");
    const payload = JSON.parse(res.body);
    assert.equal(payload.hostname, "self-host");
    assert.equal(payload.agents.length, 2);
    assert.equal(payload.counts.active, 1);
    // Local-only payload has no node attribution — the aggregator adds it.
    assert.equal(payload.agents[0].node, undefined);
  });

  it("GET /api/agents/fleet serves the aggregation plus assignees", async () => {
    const t = tree(configFixture());
    const roster = makeRoster(t, {
      mesh: meshFixture([onlineNode("hermes", "https://hermes/health")]),
      fetchFn: async () => okResponse({ agents: [{ id: "ops", active: true }] }),
    });
    const res = mockRes();
    await roster.routes["GET /api/agents/fleet"]({ method: "GET" }, res);

    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.counts.total, 3);
    assert.equal(payload.counts.nodes, 2);
    assert.ok(Array.isArray(payload.assignees));
    assert.ok(payload.assignees.includes("ops@hermes"));
    assert.ok(payload.assignees.includes("dev"));
  });
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

describe("helpers", () => {
  it("isSessionFile filters sidecars", () => {
    assert.equal(isSessionFile("abc.jsonl"), true);
    assert.equal(isSessionFile("abc.trajectory.jsonl"), false);
    assert.equal(isSessionFile("abc.jsonl.deleted.2026-01-01"), false);
    assert.equal(isSessionFile("abc.jsonl.codex-app-server.json"), false);
  });

  it("nodeBaseUrl strips paths and tolerates malformed URLs", () => {
    assert.equal(nodeBaseUrl("https://host.tail.net:8443/health"), "https://host.tail.net:8443");
    assert.equal(nodeBaseUrl("https://host/health"), "https://host");
    assert.equal(nodeBaseUrl("not a url"), null);
  });

  it("scanSessionsDir degrades to zero on missing dirs", () => {
    assert.deepEqual(scanSessionsDir("/nonexistent/path/sessions"), {
      sessionCount: 0,
      lastActiveAt: null,
    });
  });
});
