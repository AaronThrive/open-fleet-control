/**
 * Tests for the state module performance paths:
 *  - getCapacity counts from the sessions cache via sessionType (kind-based)
 *  - getSubagentStatus uses the cache, never the sync CLI
 *  - gateway status is cache-served (stale-while-revalidate)
 *  - openclawEnabled=false skips OpenClaw filesystem scans
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");

const { createStateModule } = require("../src/state");

const BASE_CONFIG = {
  paths: {
    workspace: os.tmpdir(),
    memory: path.join(os.tmpdir(), "nonexistent-memory"),
    state: os.tmpdir(),
    cerebro: os.tmpdir(),
    skills: os.tmpdir(),
    jobs: os.tmpdir(),
    logs: os.tmpdir(),
  },
  billing: { claudePlanCost: 200, claudePlanName: "Test" },
};

function mappedSession(overrides = {}) {
  return {
    sessionKey: "agent:main:main",
    sessionId: "00000000-0000-4000-8000-000000000000",
    label: "test",
    kind: "direct",
    channel: "other",
    sessionType: "channel",
    active: true,
    recentlyActive: true,
    minutesAgo: 1,
    tokens: 100,
    model: "gpt-5.5",
    originator: null,
    topic: null,
    metrics: { burnRate: 0, toolCalls: 0, minutesActive: 1 },
    ...overrides,
  };
}

function makeState({ sessions = [], openclawEnabled = true, runOpenClawAsync } = {}) {
  return createStateModule({
    CONFIG: BASE_CONFIG,
    getOpenClawDir: () => path.join(os.tmpdir(), "nonexistent-openclaw"),
    getSessions: () => sessions,
    getSystemVitals: () => ({}),
    getCronJobs: () => [],
    loadOperators: () => ({ operators: [], roles: {} }),
    calculateOperatorStats: (data) => data,
    getLlmUsage: () => ({}),
    getDailyTokenUsage: () => ({}),
    getTokenStats: () => ({}),
    getCerebroTopics: () => ({}),
    runOpenClawAsync,
    openclawEnabled,
    readTranscript: () => [],
  });
}

describe("state.getCapacity()", () => {
  it("counts subagent/cron sessions via kind-derived sessionType", () => {
    const sessions = [
      // spawn-child whose key has NO ":subagent:" segment — the old
      // key-matching filter undercounted these
      mappedSession({
        sessionKey: "agent:main:worker:abc",
        sessionType: "subagent",
        minutesAgo: 1,
      }),
      mappedSession({
        sessionKey: "agent:main:cron:def",
        sessionType: "cron",
        minutesAgo: 2,
      }),
      mappedSession({ sessionKey: "agent:main:slack:channel:c1", minutesAgo: 1 }),
      // Inactive — must not be counted
      mappedSession({
        sessionKey: "agent:main:subagent:old",
        sessionType: "subagent",
        minutesAgo: 120,
      }),
    ];
    const state = makeState({ sessions });
    const capacity = state.getCapacity();

    assert.strictEqual(capacity.subagent.active, 2);
    assert.strictEqual(capacity.main.active, 1);
  });

  it("skips the OpenClaw filesystem fallback when openclawEnabled is false", () => {
    const state = makeState({ sessions: [], openclawEnabled: false });
    const capacity = state.getCapacity();
    assert.strictEqual(capacity.main.active, 0);
    assert.strictEqual(capacity.subagent.active, 0);
  });
});

describe("state.getSubagentStatus()", () => {
  it("serves subagents from the sessions cache without the sync CLI", () => {
    const sessions = [
      mappedSession({
        sessionKey: "agent:main:subagent:11111111-1111-4111-8111-111111111111",
        sessionId: "22222222-2222-4222-8222-222222222222",
        sessionType: "subagent",
        minutesAgo: 3,
        tokens: 555,
        model: "gpt-5.5",
      }),
      mappedSession({ sessionKey: "agent:main:main", sessionType: "main" }),
    ];
    const state = makeState({ sessions });
    const subagents = state.getSubagentStatus();

    assert.strictEqual(subagents.length, 1);
    assert.strictEqual(subagents[0].id, "11111111-1111-4111-8111-111111111111");
    assert.strictEqual(subagents[0].tokens, 555);
    assert.strictEqual(subagents[0].status, "active");
  });
});

describe("state.getSystemStatus()", () => {
  it("serves gateway status from cache and refreshes in the background", async () => {
    let calls = 0;
    const state = makeState({
      sessions: [],
      runOpenClawAsync: async () => {
        calls++;
        return "gateway is running";
      },
    });

    // First call: cache cold → returns Unknown immediately, kicks refresh
    const first = state.getSystemStatus();
    assert.strictEqual(first.gateway, "Unknown");
    assert.ok(typeof first.hostname === "string" && first.hostname.length > 0);

    await new Promise((r) => setTimeout(r, 50));
    const second = state.getSystemStatus();
    assert.strictEqual(second.gateway, "Running");
    assert.strictEqual(calls, 1);
  });

  it("never spawns the CLI when openclawEnabled is false", async () => {
    let calls = 0;
    const state = makeState({
      sessions: [],
      openclawEnabled: false,
      runOpenClawAsync: async () => {
        calls++;
        return "running";
      },
    });
    state.getSystemStatus();
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(calls, 0);
  });
});

describe("state.getFullState() subagents", () => {
  it("derives subagents via sessionType (not key matching)", () => {
    const sessions = [
      mappedSession({
        sessionKey: "agent:main:worker:nokey",
        sessionId: "99999999-9999-4999-8999-999999999999",
        sessionType: "subagent",
        minutesAgo: 5,
        tokens: 7,
      }),
    ];
    const state = makeState({ sessions });
    const full = state.getFullState();
    assert.strictEqual(full.subagents.length, 1);
    assert.strictEqual(full.subagents[0].id, "99999999-9999-4999-8999-999999999999");
  });
});
