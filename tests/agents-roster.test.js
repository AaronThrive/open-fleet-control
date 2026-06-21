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
    // Hermetic default: never fall back to the real CONFIG singleton.
    agentsConfig: {},
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

  it("attributes mesh agents with via=mesh and a default openclaw source", async () => {
    const t = tree(configFixture());
    const roster = makeRoster(t, {
      mesh: meshFixture([onlineNode("hermes", "https://hermes/health")]),
      fetchFn: async () => okResponse({ hostname: "hermes", agents: remoteAgents }),
    });
    const fleet = await roster.getRoster();
    const remote = fleet.byNode.hermes[0];
    assert.equal(remote.via, "mesh");
    assert.equal(remote.source, "openclaw");
  });
});

// ---------------------------------------------------------------------------
// Fleet aggregation (federation remotes)
// ---------------------------------------------------------------------------

describe("federation aggregation", () => {
  const hermesAgent = {
    id: "main",
    name: "Hermes",
    model: "openai/gpt-5.5",
    sessionCount: 4,
    lastActiveAt: NOW - 2000,
    active: true,
    source: "hermes",
  };

  function federationStateFixture(remotes) {
    return async () => ({ remotes, counts: { remotes: remotes.length } });
  }

  it("merges agents from reachable remotes with via=federation", async () => {
    const t = tree(configFixture());
    const calls = [];
    const roster = makeRoster(t, {
      federationStateFn: federationStateFixture([
        {
          id: "r1",
          label: "hermes-ofc",
          baseUrl: "https://hermes-agent-1.tail.net",
          status: { reachable: true },
        },
        {
          id: "r2",
          label: "down-ofc",
          baseUrl: "https://down.tail.net",
          status: { reachable: false },
        },
        { id: "r3", label: "unchecked", baseUrl: "https://new.tail.net", status: {} },
      ]),
      fetchFn: async (url) => {
        calls.push(url);
        return okResponse({ hostname: "hermes-host", agents: [hermesAgent] });
      },
    });

    const fleet = await roster.getRoster();
    // Only the reachable remote is queried.
    assert.deepEqual(calls, ["https://hermes-agent-1.tail.net/api/agents"]);
    assert.equal(fleet.agents.length, 3); // 2 local + 1 federation
    const fed = fleet.byNode["hermes-host"][0];
    assert.equal(fed.via, "federation");
    assert.equal(fed.source, "hermes");
    assert.equal(fed.node, "hermes-host");
    assert.deepEqual(fleet.counts, { total: 3, active: 1, nodes: 2 });
  });

  it("accepts a flat reachable flag (no status wrapper)", async () => {
    const t = tree(configFixture());
    const roster = makeRoster(t, {
      federationStateFn: federationStateFixture([
        { id: "r1", label: "flat", baseUrl: "https://flat.tail.net", reachable: true },
      ]),
      fetchFn: async () => okResponse({ hostname: "flat-host", agents: [hermesAgent] }),
    });
    const fleet = await roster.getRoster();
    assert.equal(fleet.byNode["flat-host"].length, 1);
  });

  it("dedupes federation remotes already covered by a mesh node (by hostname)", async () => {
    const t = tree(configFixture());
    const roster = makeRoster(t, {
      mesh: meshFixture([onlineNode("mesh-node", "https://mesh-node/health")]),
      federationStateFn: federationStateFixture([
        { id: "r1", label: "dup-mesh", baseUrl: "https://dup.tail.net", reachable: true },
      ]),
      fetchFn: async (url) => {
        // Same machine reachable through both transports — federation copy
        // must be dropped.
        void url;
        return okResponse({ hostname: "mesh-node", agents: [{ id: "ops", active: false }] });
      },
    });

    const fleet = await roster.getRoster();
    assert.equal(fleet.agents.length, 3); // 2 local + 1 mesh, zero federation
    assert.deepEqual(Object.keys(fleet.byNode).sort(), ["mesh-node", "self-host"]);
    assert.equal(fleet.byNode["mesh-node"].length, 1);
  });

  it("keeps a same-host second instance, grouped under the remote label", async () => {
    // Real deployment shape: a Hermes-sourced OFC instance runs on the SAME
    // machine as this one (same os.hostname()) but serves a different
    // roster — it must NOT be deduped away, and its group must not collide
    // with the local node group.
    const t = tree(configFixture());
    const roster = makeRoster(t, {
      federationStateFn: federationStateFixture([
        {
          id: "r1",
          label: "hermes-ofc",
          baseUrl: "https://hermes-agent-1.tail.net",
          reachable: true,
        },
      ]),
      fetchFn: async () => okResponse({ hostname: "self-host", agents: [hermesAgent] }),
    });

    const fleet = await roster.getRoster();
    assert.equal(fleet.agents.length, 3); // 2 local + 1 hermes
    assert.deepEqual(Object.keys(fleet.byNode).sort(), ["hermes-ofc", "self-host"]);
    assert.equal(fleet.byNode["hermes-ofc"][0].source, "hermes");
    assert.equal(fleet.byNode["hermes-ofc"][0].via, "federation");
  });

  it("falls back to the remote label when the body has no hostname", async () => {
    const t = tree(configFixture());
    const roster = makeRoster(t, {
      federationStateFn: federationStateFixture([
        { id: "r1", label: "labeled-remote", baseUrl: "https://x.tail.net", reachable: true },
      ]),
      fetchFn: async () => okResponse({ agents: [hermesAgent] }),
    });
    const fleet = await roster.getRoster();
    assert.ok(fleet.byNode["labeled-remote"]);
  });

  it("tolerates 404s, network failures, and a throwing federationStateFn", async () => {
    const t = tree(configFixture());

    const flaky = makeRoster(t, {
      federationStateFn: federationStateFixture([
        { id: "r1", label: "old", baseUrl: "https://old.tail.net", reachable: true },
        { id: "r2", label: "down", baseUrl: "https://down.tail.net", reachable: true },
        { id: "r3", label: "bad-url", baseUrl: "::::not-a-url", reachable: true },
      ]),
      fetchFn: async (url) => {
        if (url.startsWith("https://old"))
          return { ok: false, status: 404, json: async () => ({}) };
        throw new Error("ECONNREFUSED");
      },
    });
    const fleet = await flaky.getRoster();
    assert.equal(fleet.agents.length, 2); // local-only

    const throwing = makeRoster(tree(configFixture()), {
      federationStateFn: async () => {
        throw new Error("federation offline");
      },
    });
    assert.equal((await throwing.getRoster()).agents.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Agents source config (fleet.agents)
// ---------------------------------------------------------------------------

describe("agents source config", () => {
  const hermesEntries = [
    {
      id: "main",
      name: "Hermes",
      model: "openai/gpt-5.5",
      workspace: "/home/user/.hermes/workspace",
      subagentsMax: null,
      sessionCount: 3,
      lastActiveAt: NOW - 60_000,
      active: true,
      source: "hermes",
    },
  ];

  it("source=openclaw (default) tags local agents with source=openclaw", () => {
    const roster = makeRoster(tree(configFixture()));
    for (const agent of roster.getLocalRoster().agents) {
      assert.equal(agent.source, "openclaw");
    }
  });

  it("source=hermes serves the hermes adapter as the local roster", () => {
    const roster = createAgentsRoster({
      agentsConfig: { source: "hermes" },
      hermesAgents: { listAgents: () => hermesEntries },
      nowFn: () => NOW,
      hostname: "hermes-host",
    });
    const local = roster.getLocalRoster();
    assert.deepEqual(local.agents, hermesEntries);
    assert.deepEqual(local.counts, { total: 1, active: 1 });
    assert.equal(local.hostname, "hermes-host");
  });

  it("source=hermes tolerates a throwing adapter", () => {
    const roster = createAgentsRoster({
      agentsConfig: { source: "hermes" },
      hermesAgents: {
        listAgents: () => {
          throw new Error("boom");
        },
      },
      nowFn: () => NOW,
    });
    assert.deepEqual(roster.getLocalRoster().agents, []);
  });

  it("source=none serves an empty local roster without openclaw paths", () => {
    const roster = createAgentsRoster({ agentsConfig: { source: "none" }, nowFn: () => NOW });
    assert.deepEqual(roster.getLocalRoster().agents, []);
  });

  it("source=openclaw still requires the openclaw paths", () => {
    assert.throws(
      () => createAgentsRoster({ agentsConfig: { source: "openclaw" } }),
      /openclawConfigPath/,
    );
  });

  it("config paths override constructor paths", () => {
    const t = tree(configFixture());
    const roster = createAgentsRoster({
      openclawConfigPath: "/nonexistent/openclaw.json",
      agentsDir: "/nonexistent/agents",
      agentsConfig: {
        source: "openclaw",
        openclawConfigPath: t.configPath,
        agentsDir: t.agentsDir,
      },
      nowFn: () => NOW,
      hostname: "self-host",
    });
    assert.equal(roster.getLocalRoster().agents.length, 2);
  });

  it("unknown source values fall back to openclaw", () => {
    const t = tree(configFixture());
    const roster = makeRoster(t, { agentsConfig: { source: "martian" } });
    assert.equal(roster.getLocalRoster().agents.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Assignees
// ---------------------------------------------------------------------------

describe("getAssignees", () => {
  it("qualifies only ids that exist on more than one node", async () => {
    // Fleet: self-host has {main, dev}; hermes has {main}. Only "main" is
    // ambiguous (2 nodes) → it gets both @node forms; "dev" is unique to a
    // single node → bare id only, no qualifier.
    const t = tree(configFixture());
    const roster = makeRoster(t, {
      mesh: meshFixture([onlineNode("hermes", "https://hermes/health")]),
      fetchFn: async () => okResponse({ agents: [{ id: "main" }] }),
    });
    const assignees = await roster.getAssignees();
    assert.deepEqual(assignees, ["dev", "main", "main@hermes", "main@self-host"]);
  });

  it("emits bare ids only when every id is unique to a single node", async () => {
    // Two nodes, but no id is shared → no @node qualifiers at all.
    const t = tree(configFixture());
    const roster = makeRoster(t, {
      mesh: meshFixture([onlineNode("hermes", "https://hermes/health")]),
      fetchFn: async () => okResponse({ agents: [{ id: "ops" }] }),
    });
    const assignees = await roster.getAssignees();
    assert.deepEqual(assignees, ["dev", "main", "ops"]);
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
      // "main" collides with the local node → ambiguous, so it gets @node forms.
      fetchFn: async () => okResponse({ agents: [{ id: "main", active: true }] }),
    });
    const res = mockRes();
    await roster.routes["GET /api/agents/fleet"]({ method: "GET" }, res);

    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.counts.total, 3);
    assert.equal(payload.counts.nodes, 2);
    assert.ok(Array.isArray(payload.assignees));
    assert.ok(payload.assignees.includes("main@hermes"));
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
