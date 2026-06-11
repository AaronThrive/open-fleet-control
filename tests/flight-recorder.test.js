/**
 * Unit tests for src/flight-recorder.js — the per-agent activity timeline
 * aggregator. Pure DI: fixture sources only, no filesystem (except the
 * store-source tests, which use a temp dir).
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createFlightRecorder,
  createStoreSessionsSource,
  EVENT_TYPES,
} = require("../src/flight-recorder");

// Fixed "now" for deterministic windows: 2026-06-11T12:00:00Z.
const NOW = Date.parse("2026-06-11T12:00:00.000Z");
const HOUR = 3600 * 1000;

function iso(ms) {
  return new Date(ms).toISOString();
}

/** A recorder with a full set of fixture sources around agent "scout". */
function makeRecorder(overrides = {}) {
  const sessions = {
    scout: [
      {
        key: "agent:scout:main",
        sessionId: "sess-1",
        sessionStartedAt: NOW - 5 * HOUR,
        updatedAt: NOW - 2 * HOUR, // quiet for 2h → ended
        totalTokens: 1200,
        model: "claude-fable-5",
        label: "Main",
      },
      {
        key: "agent:scout:kanban-t1",
        sessionId: "sess-2",
        sessionStartedAt: NOW - 1 * HOUR,
        updatedAt: NOW - 5 * 60 * 1000, // active 5 min ago → not ended
        totalTokens: 300,
        model: "claude-fable-5",
        label: null,
      },
    ],
  };
  const board = {
    tasks: [
      {
        id: "t1",
        title: "Fix the flux capacitor",
        attempts: [
          {
            agent: "scout",
            started_at: iso(NOW - 3 * HOUR),
            ended_at: iso(NOW - 2.5 * HOUR),
            result: "success",
            branch: "fix/flux",
            note: "dispatched · session sess-2",
          },
          { agent: "other", started_at: iso(NOW - HOUR), ended_at: null, result: null },
        ],
        comments: [
          { author: "scout", ts: iso(NOW - 2.8 * HOUR), text: "[scout] starting work" },
          { author: "aaron", ts: iso(NOW - 2.7 * HOUR), text: "ok" },
        ],
      },
    ],
  };
  const cronJobs = [
    {
      id: "cj-1",
      name: "Morning briefing",
      agent: "scout",
      lastRunAtMs: NOW - 4 * HOUR,
      lastStatus: "ok",
      schedule: "0 6 * * *",
      source: "openclaw",
    },
    { id: "cj-2", name: "Other job", agent: "main", lastRunAtMs: NOW - HOUR, lastStatus: "ok" },
    { id: "cj-3", name: "Never ran", agent: "scout", lastRunAtMs: null },
  ];
  const auditEntries = [
    { ts: iso(NOW - 30 * 60 * 1000), user: "scout", action: "task.move", target: "t1" },
    { ts: iso(NOW - 40 * 60 * 1000), user: "aaron", action: "session.kill", target: "scout" },
    {
      ts: iso(NOW - 50 * 60 * 1000),
      user: "aaron",
      action: "task.update",
      target: "t1",
      detail: { op: "dispatch", agent: "scout" },
    },
    { ts: iso(NOW - HOUR), user: "aaron", action: "brief.write", target: "playbook" },
  ];

  return createFlightRecorder({
    readAgentSessions: (agentId) => sessions[agentId] || [],
    getBoard: () => board,
    queryAudit: () => auditEntries,
    getCronJobs: () => cronJobs,
    nowFn: () => NOW,
    ...overrides,
  });
}

describe("getTimeline() — aggregation", () => {
  it("merges all sources into one newest-first timeline", () => {
    const result = makeRecorder().getTimeline("scout");
    const types = result.events.map((e) => e.type);

    // Newest-first ordering across mixed sources.
    const tsList = result.events.map((e) => Date.parse(e.ts));
    assert.deepStrictEqual(
      tsList,
      [...tsList].sort((a, b) => b - a),
    );

    assert.ok(types.includes("session.start"));
    assert.ok(types.includes("session.end"));
    assert.ok(types.includes("dispatch"));
    assert.ok(types.includes("dispatch.result"));
    assert.ok(types.includes("cron.run"));
    assert.ok(types.includes("audit"));
    assert.ok(types.includes("note"));
  });

  it("emits the normalized event shape", () => {
    const result = makeRecorder().getTimeline("scout");
    for (const event of result.events) {
      assert.strictEqual(typeof event.ts, "string");
      assert.ok(Number.isFinite(Date.parse(event.ts)));
      assert.ok(EVENT_TYPES.includes(event.type));
      assert.strictEqual(typeof event.title, "string");
      assert.ok(event.refs && typeof event.refs === "object");
    }
  });

  it("does not end a still-active session", () => {
    const result = makeRecorder().getTimeline("scout");
    const ends = result.events.filter((e) => e.type === "session.end");
    assert.strictEqual(ends.length, 1);
    assert.strictEqual(ends[0].refs.sessionKey, "agent:scout:main");
    // The active session still contributes its start event.
    const starts = result.events.filter((e) => e.type === "session.start");
    assert.strictEqual(starts.length, 2);
  });

  it("attributes kanban attempts and comments to the agent only", () => {
    const result = makeRecorder().getTimeline("scout");
    const dispatches = result.events.filter((e) => e.type === "dispatch");
    assert.strictEqual(dispatches.length, 1);
    assert.strictEqual(dispatches[0].refs.taskId, "t1");
    assert.match(dispatches[0].title, /Fix the flux capacitor/);

    const results = result.events.filter((e) => e.type === "dispatch.result");
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].detail.result, "success");

    const notes = result.events.filter((e) => e.type === "note");
    assert.strictEqual(notes.length, 1);
    assert.strictEqual(notes[0].detail.text, "[scout] starting work");
  });

  it("includes audit entries where the agent is actor, target, or detail.agent", () => {
    const result = makeRecorder().getTimeline("scout");
    const audits = result.events.filter((e) => e.type === "audit");
    assert.strictEqual(audits.length, 3);
    const roles = audits.map((e) => e.detail.role).sort();
    assert.deepStrictEqual(roles, ["actor", "mentioned", "target"]);
    // task.* audit entries carry the task ref.
    const move = audits.find((e) => e.detail.action === "task.move");
    assert.strictEqual(move.refs.taskId, "t1");
  });

  it("includes only the agent's cron jobs with a known last run", () => {
    const result = makeRecorder().getTimeline("scout");
    const cron = result.events.filter((e) => e.type === "cron.run");
    assert.strictEqual(cron.length, 1);
    assert.strictEqual(cron[0].detail.jobId, "cj-1");
    assert.strictEqual(cron[0].detail.status, "ok");
  });
});

describe("getTimeline() — windows, filters, pagination", () => {
  it("applies the since/until window", () => {
    const recorder = makeRecorder();
    const result = recorder.getTimeline("scout", {
      since: iso(NOW - HOUR),
      until: iso(NOW),
    });
    for (const event of result.events) {
      assert.ok(Date.parse(event.ts) >= NOW - HOUR);
    }
    // The 3h-old dispatch is outside this window.
    assert.ok(!result.events.some((e) => e.type === "dispatch"));
  });

  it("accepts epoch-ms strings for since/until", () => {
    const result = makeRecorder().getTimeline("scout", {
      since: String(NOW - HOUR),
      until: String(NOW),
    });
    assert.strictEqual(result.range.since, iso(NOW - HOUR));
    assert.strictEqual(result.range.until, iso(NOW));
  });

  it("defaults to a 24h window ending now", () => {
    const result = makeRecorder().getTimeline("scout");
    assert.strictEqual(result.range.until, iso(NOW));
    assert.strictEqual(result.range.since, iso(NOW - 24 * HOUR));
  });

  it("filters by types (comma string and array)", () => {
    const recorder = makeRecorder();
    const onlyAudit = recorder.getTimeline("scout", { types: "audit" });
    assert.ok(onlyAudit.events.length > 0);
    assert.ok(onlyAudit.events.every((e) => e.type === "audit"));

    const two = recorder.getTimeline("scout", { types: ["dispatch", "dispatch.result"] });
    assert.ok(two.events.every((e) => e.type === "dispatch" || e.type === "dispatch.result"));
  });

  it("rejects unknown types and bad params with 400-coded errors", () => {
    const recorder = makeRecorder();
    for (const call of [
      () => recorder.getTimeline("scout", { types: "bogus" }),
      () => recorder.getTimeline("scout", { since: "not-a-date" }),
      () => recorder.getTimeline("scout", { limit: 0 }),
      () => recorder.getTimeline("scout", { limit: 2.5 }),
      () => recorder.getTimeline("scout", { since: iso(NOW), until: iso(NOW - HOUR) }),
      () => recorder.getTimeline(""),
      () => recorder.getTimeline("../etc"),
      () => recorder.getTimeline(42),
    ]) {
      assert.throws(call, (err) => err.statusCode === 400);
    }
  });

  it("paginates large logs via limit + nextUntil without losing events", () => {
    // 500 audit entries, one per minute — simulating a large log.
    const entries = [];
    for (let i = 0; i < 500; i++) {
      entries.push({ ts: iso(NOW - i * 60 * 1000), user: "scout", action: "task.update" });
    }
    const recorder = createFlightRecorder({
      queryAudit: ({ limit }) => {
        // The aggregator must never ask for an unbounded read.
        assert.ok(Number.isFinite(limit) && limit <= 1000);
        return entries;
      },
      nowFn: () => NOW,
    });

    const page1 = recorder.getTimeline("scout", { limit: 200 });
    assert.strictEqual(page1.events.length, 200);
    assert.strictEqual(page1.summary.total, 500);
    assert.strictEqual(page1.page.hasMore, true);
    assert.ok(Number.isFinite(page1.page.nextUntil));

    const page2 = recorder.getTimeline("scout", { limit: 200, until: page1.page.nextUntil });
    assert.strictEqual(page2.events.length, 200);
    // No overlap between pages.
    const seen = new Set(page1.events.map((e) => e.ts));
    assert.ok(page2.events.every((e) => !seen.has(e.ts)));

    const page3 = recorder.getTimeline("scout", { limit: 200, until: page2.page.nextUntil });
    assert.strictEqual(page3.page.hasMore, false);
    assert.strictEqual(page3.page.nextUntil, null);
    assert.strictEqual(page1.events.length + page2.events.length + page3.events.length, 500);
  });

  it("caps limit at 1000", () => {
    const result = makeRecorder().getTimeline("scout", { limit: 99999 });
    assert.strictEqual(result.page.limit, 1000);
  });
});

describe("getTimeline() — summary", () => {
  it("counts events by type over the full window (not just the page)", () => {
    const result = makeRecorder().getTimeline("scout", { limit: 1 });
    assert.strictEqual(result.events.length, 1);
    const countSum = Object.values(result.summary.counts).reduce((a, b) => a + b, 0);
    assert.strictEqual(countSum, result.summary.total);
    assert.ok(result.summary.total > 1);
  });

  it("sums session tokens for sessions overlapping the window and notes the cost gap", () => {
    const result = makeRecorder().getTimeline("scout");
    assert.strictEqual(result.summary.tokens, 1500); // 1200 + 300
    assert.strictEqual(result.summary.cost, null);
    assert.ok(result.summary.gaps.some((g) => /cost/.test(g)));
  });

  it("excludes sessions entirely outside the window from the token total", () => {
    const result = makeRecorder().getTimeline("scout", {
      since: iso(NOW - 90 * 60 * 1000),
      until: iso(NOW),
    });
    // Only the second session (started 1h ago) overlaps.
    assert.strictEqual(result.summary.tokens, 300);
  });
});

describe("getTimeline() — resilience", () => {
  it("tolerates missing sources (contributes nothing)", () => {
    const recorder = createFlightRecorder({ nowFn: () => NOW });
    const result = recorder.getTimeline("scout");
    assert.deepStrictEqual(result.events, []);
    assert.strictEqual(result.summary.total, 0);
    assert.strictEqual(result.summary.tokens, 0);
  });

  it("degrades a throwing source to a gap note instead of failing", () => {
    const recorder = makeRecorder({
      getBoard: () => {
        throw new Error("kanban store corrupt");
      },
    });
    const result = recorder.getTimeline("scout");
    assert.ok(result.events.length > 0); // other sources still contribute
    assert.ok(!result.events.some((e) => e.type === "dispatch"));
    assert.ok(result.summary.gaps.some((g) => /kanban source unavailable/.test(g)));
  });

  it("skips malformed entries from sources", () => {
    const recorder = createFlightRecorder({
      readAgentSessions: () => [null, {}, { key: "k", updatedAt: "soon" }],
      getBoard: () => ({ tasks: [null, { id: "x", title: "t", attempts: "no", comments: null }] }),
      queryAudit: () => [null, { user: "scout", action: "task.move", ts: "invalid" }],
      getCronJobs: () => "not-an-array",
      nowFn: () => NOW,
    });
    const result = recorder.getTimeline("scout");
    assert.deepStrictEqual(result.events, []);
  });
});

describe("createStoreSessionsSource()", () => {
  it("reads the per-agent session store and normalizes entries", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flight-recorder-"));
    try {
      const sessionsDir = path.join(tmpDir, "scout", "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionsDir, "sessions.json"),
        JSON.stringify({
          "agent:scout:main": {
            sessionId: "abc",
            sessionStartedAt: 1000,
            updatedAt: 2000,
            inputTokens: 10,
            outputTokens: 5,
            model: "m1",
            displayName: "Main chat",
          },
          bogus: "not-an-object",
        }),
      );
      const read = createStoreSessionsSource({ agentsDir: tmpDir });
      const entries = read("scout");
      assert.strictEqual(entries.length, 1);
      assert.deepStrictEqual(entries[0], {
        key: "agent:scout:main",
        sessionId: "abc",
        sessionStartedAt: 1000,
        updatedAt: 2000,
        totalTokens: 15,
        model: "m1",
        label: "Main chat",
      });
      // Missing store + hostile ids degrade to [].
      assert.deepStrictEqual(read("nobody"), []);
      assert.deepStrictEqual(read("../../etc"), []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("requires an agentsDir", () => {
    assert.throws(() => createStoreSessionsSource({}), /agentsDir/);
  });
});
