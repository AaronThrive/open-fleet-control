/**
 * Tests for the sessions background-refresh worker:
 *  - files source: direct session-store parsing (CLI-shape parity)
 *  - kind derivation (spawn-child / cron / group / direct)
 *  - sessionType classification from kind (subagent count fix)
 *  - request paths always serve the cache (no CLI spawn)
 *  - refresh coalescing (concurrent refreshes share one fetch)
 *  - store-file mtime cache (re-parse only on change)
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createSessionsModule, deriveKind } = require("../src/sessions");

const NOW = Date.now();

function fixtureStore() {
  return {
    "agent:main:slack:channel:c0abc:thread:123.456": {
      sessionId: "11111111-1111-4111-8111-111111111111",
      updatedAt: NOW - 60 * 1000,
      chatType: "group",
      groupId: "c0abc",
      totalTokens: 1000,
      inputTokens: 600,
      outputTokens: 400,
      model: "gpt-5.5",
      modelProvider: "openai",
      contextTokens: 272000,
    },
    // Real-world subagent entry: kind must come from spawn metadata even
    // if a future key format drops the ":subagent:" segment.
    "agent:main:subagent:22222222-2222-4222-8222-222222222222": {
      sessionId: "33333333-3333-4333-8333-333333333333",
      updatedAt: NOW - 2 * 60 * 1000,
      spawnDepth: 1,
      subagentRole: "leaf",
      spawnedBy: "agent:main:cron:abc",
      totalTokens: 5000,
      model: "gpt-5.5",
      modelProvider: "codex",
    },
    "agent:main:worker:44444444-4444-4444-8444-444444444444": {
      sessionId: "55555555-5555-4555-8555-555555555555",
      updatedAt: NOW - 3 * 60 * 1000,
      subagentRole: "leaf",
      spawnedBy: "agent:main:main",
      totalTokens: 42,
    },
    "agent:main:cron:66666666-6666-4666-8666-666666666666": {
      sessionId: "77777777-7777-4777-8777-777777777777",
      updatedAt: NOW - 10 * 60 * 1000,
      totalTokens: 29578,
      model: "gpt-5.5",
      modelProvider: "codex",
    },
    "agent:main:main": {
      sessionId: "88888888-8888-4888-8888-888888888888",
      updatedAt: NOW - 30 * 60 * 1000,
      inputTokens: 10,
      outputTokens: 5,
    },
  };
}

function writeStore(dir, store) {
  const sessionsDir = path.join(dir, "agents", "main", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, "sessions.json"), JSON.stringify(store), "utf8");
}

function createModule(dir, overrides = {}) {
  return createSessionsModule({
    getOpenClawDir: () => dir,
    getOperatorBySlackId: () => null,
    runOpenClaw: () => {
      throw new Error("sync CLI must never run");
    },
    runOpenClawAsync: async () => {
      throw new Error("async CLI must not run for files source");
    },
    extractJSON: (s) => s,
    sessionsSource: "files",
    refreshMs: 30000,
    ...overrides,
  });
}

describe("deriveKind()", () => {
  it("classifies spawn metadata as spawn-child regardless of key", () => {
    assert.strictEqual(
      deriveKind("agent:main:worker:x", { spawnedBy: "agent:main:main" }),
      "spawn-child",
    );
    assert.strictEqual(deriveKind("agent:main:worker:x", { subagentRole: "leaf" }), "spawn-child");
    assert.strictEqual(deriveKind("agent:main:subagent:x", {}), "spawn-child");
  });

  it("classifies cron, group, and direct", () => {
    assert.strictEqual(deriveKind("agent:main:cron:x", {}), "cron");
    assert.strictEqual(deriveKind("agent:main:slack:channel:c1", { chatType: "group" }), "group");
    assert.strictEqual(deriveKind("agent:main:telegram:group:@g", { groupId: "g" }), "group");
    assert.strictEqual(deriveKind("agent:main:main", {}), "direct");
  });
});

describe("sessions files source", () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofc-sessions-"));
    writeStore(dir, fixtureStore());
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lists sessions from the store in CLI shape, newest first", () => {
    const mod = createModule(dir);
    const raw = mod.listSessionsFromStore();

    assert.strictEqual(raw.length, 5);
    assert.strictEqual(raw[0].key, "agent:main:slack:channel:c0abc:thread:123.456");
    const s = raw[0];
    assert.strictEqual(s.sessionId, "11111111-1111-4111-8111-111111111111");
    assert.strictEqual(s.totalTokens, 1000);
    assert.strictEqual(s.model, "gpt-5.5");
    assert.strictEqual(s.kind, "group");
    assert.ok(s.ageMs >= 60 * 1000);
    // Sorted newest-first
    const updatedAts = raw.map((r) => r.updatedAt);
    assert.deepStrictEqual(
      updatedAts,
      [...updatedAts].sort((a, b) => b - a),
    );
  });

  it("falls back to inputTokens+outputTokens when totalTokens missing", () => {
    const mod = createModule(dir);
    const raw = mod.listSessionsFromStore();
    const main = raw.find((s) => s.key === "agent:main:main");
    assert.strictEqual(main.totalTokens, 15);
  });

  it("classifies sessionType from kind (subagent without :subagent: key)", async () => {
    const mod = createModule(dir);
    await mod.refreshSessionsCache();
    const sessions = mod.getSessions({ limit: null });

    const byKey = Object.fromEntries(sessions.map((s) => [s.sessionKey, s]));
    assert.strictEqual(
      byKey["agent:main:subagent:22222222-2222-4222-8222-222222222222"].sessionType,
      "subagent",
    );
    // The classification fix: spawn-child kind wins even when the key
    // does not contain ":subagent:".
    assert.strictEqual(
      byKey["agent:main:worker:44444444-4444-4444-8444-444444444444"].sessionType,
      "subagent",
    );
    assert.strictEqual(
      byKey["agent:main:cron:66666666-6666-4666-8666-666666666666"].sessionType,
      "cron",
    );
    assert.strictEqual(byKey["agent:main:main"].sessionType, "main");
  });

  it("serves all request paths from the cache without spawning the CLI", async () => {
    const mod = createModule(dir);
    await mod.refreshSessionsCache();

    // limited and unlimited both come from the cache (runOpenClaw throws)
    assert.strictEqual(mod.getSessions({ limit: null }).length, 5);
    assert.strictEqual(mod.getSessions({ limit: 2 }).length, 2);
    const counted = mod.getSessions({ limit: 1, returnCount: true });
    assert.strictEqual(counted.totalCount, 5);
    assert.ok(Number.isFinite(mod.getCacheAgeMs()));
  });

  it("returns empty results before first refresh instead of blocking", () => {
    const mod = createModule(dir);
    assert.deepStrictEqual(mod.getSessions({ limit: null }), []);
    assert.strictEqual(mod.getCacheAgeMs(), Infinity);
  });

  it("re-parses only when the store file changes (mtime cache)", async () => {
    const mod = createModule(dir);
    await mod.refreshSessionsCache();
    assert.strictEqual(mod.getSessions({ limit: null }).length, 5);

    // Replace the store with a single session and bump mtime
    const store = { "agent:main:main": { sessionId: "x", updatedAt: NOW, totalTokens: 1 } };
    writeStore(dir, store);
    const storePath = path.join(dir, "agents", "main", "sessions", "sessions.json");
    fs.utimesSync(storePath, new Date(), new Date(Date.now() + 5000));

    await mod.refreshSessionsCache();
    assert.strictEqual(mod.getSessions({ limit: null }).length, 1);
  });

  it("getSessionDetail resolves from the cache", async () => {
    const mod = createModule(dir);
    const detail = await mod.getSessionDetail("agent:main:main");
    assert.strictEqual(detail.error, undefined);
    assert.strictEqual(detail.key, "agent:main:main");

    const missing = await mod.getSessionDetail("agent:main:nope");
    assert.strictEqual(missing.error, "Session not found");
  });

  it("returns [] when the store file does not exist", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ofc-empty-"));
    try {
      const mod = createModule(empty);
      assert.deepStrictEqual(mod.listSessionsFromStore(), []);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("resolveTranscriptForId()", () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofc-sessions-resolve-"));
    writeStore(dir, fixtureStore());
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolves only ids present in the session store", async () => {
    const sessionsDir = path.join(dir, "agents", "main", "sessions");
    const knownId = "11111111-1111-4111-8111-111111111111";
    const transcript = path.join(sessionsDir, `${knownId}.jsonl`);
    fs.writeFileSync(transcript, "{}\n", "utf8");

    const mod = createModule(dir);
    assert.strictEqual(await mod.resolveTranscriptForId(knownId), transcript);
    // Unknown UUID — well-formed but not in the store.
    assert.strictEqual(
      await mod.resolveTranscriptForId("99999999-9999-4999-8999-999999999999"),
      null,
    );
  });

  it("rejects malformed / path-traversal ids before any fs access", async () => {
    const mod = createModule(dir);
    for (const id of ["../../etc/passwd", "a/b", "a\\b", "..", ".", "id with space", "", null]) {
      assert.strictEqual(await mod.resolveTranscriptForId(id), null, `id ${id} must resolve null`);
    }
  });
});

describe("sessions worker coalescing (cli source)", () => {
  it("concurrent refreshes share a single in-flight CLI call", async () => {
    let calls = 0;
    const payload = JSON.stringify({
      sessions: [
        {
          key: "agent:main:main",
          sessionId: "a",
          updatedAt: NOW,
          ageMs: 1000,
          totalTokens: 5,
          kind: "direct",
        },
      ],
    });
    const mod = createSessionsModule({
      getOpenClawDir: () => os.tmpdir(),
      getOperatorBySlackId: () => null,
      runOpenClaw: () => {
        throw new Error("sync CLI must never run");
      },
      runOpenClawAsync: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 50));
        return payload;
      },
      extractJSON: (s) => s,
      sessionsSource: "cli",
      refreshMs: 30000,
    });

    await Promise.all([
      mod.refreshSessionsCache(),
      mod.refreshSessionsCache(),
      mod.refreshSessionsCache(),
    ]);
    assert.strictEqual(calls, 1);
    assert.strictEqual(mod.getSessions({ limit: null }).length, 1);

    // A later refresh runs again (not permanently coalesced)
    await mod.refreshSessionsCache();
    assert.strictEqual(calls, 2);
  });

  it("keeps the previous cache when the CLI fails", async () => {
    let fail = false;
    const payload = JSON.stringify({
      sessions: [{ key: "agent:main:main", sessionId: "a", updatedAt: NOW, ageMs: 0 }],
    });
    const mod = createSessionsModule({
      getOpenClawDir: () => os.tmpdir(),
      getOperatorBySlackId: () => null,
      runOpenClaw: () => null,
      runOpenClawAsync: async () => {
        if (fail) throw new Error("boom");
        return payload;
      },
      extractJSON: (s) => s,
      sessionsSource: "cli",
    });

    await mod.refreshSessionsCache();
    assert.strictEqual(mod.getSessions({ limit: null }).length, 1);

    fail = true;
    await mod.refreshSessionsCache(); // must not throw
    assert.strictEqual(mod.getSessions({ limit: null }).length, 1);
  });
});

describe("sessions module disabled (openclawSources=false)", () => {
  it("never refreshes and serves empty data", async () => {
    const mod = createSessionsModule({
      getOpenClawDir: () => {
        throw new Error("must not touch openclaw dir");
      },
      getOperatorBySlackId: () => null,
      runOpenClaw: () => {
        throw new Error("must not spawn CLI");
      },
      runOpenClawAsync: async () => {
        throw new Error("must not spawn CLI");
      },
      extractJSON: (s) => s,
      enabled: false,
    });

    await mod.refreshSessionsCache();
    mod.startSessionsRefresh();
    assert.deepStrictEqual(mod.getSessions({ limit: null }), []);
    mod.stopSessionsRefresh();
  });
});
