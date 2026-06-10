const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createSessionControl, parseTranscriptLine } = require("../src/session-control");

/* ------------------------------------------------------------------ */
/* Test doubles                                                        */
/* ------------------------------------------------------------------ */

/** Fake claude-code adapter backed by mutable pid + session lists. */
function fakeClaudeCode({ pids = [], sessions = [] } = {}) {
  const state = { pids, sessions, liveCalls: 0, sessionCalls: 0 };
  return {
    state,
    adapter: {
      getLive: async () => {
        state.liveCalls++;
        return { count: state.pids.length, ttys: ["pts/1"], pids: state.pids.slice() };
      },
      getSessions: async () => {
        state.sessionCalls++;
        return state.sessions.slice();
      },
    },
  };
}

/** Fake kill fn recording (pid, signal) calls; alive set controls ESRCH. */
function fakeKill(aliveSet) {
  const calls = [];
  const fn = (pid, signal) => {
    calls.push({ pid, signal });
    if (!aliveSet.has(pid)) {
      const err = new Error(`kill ESRCH ${pid}`);
      err.code = "ESRCH";
      throw err;
    }
    if (signal === "SIGKILL" || signal === "SIGTERM") {
      // Signals are recorded; the test decides when the process "dies".
    }
  };
  fn.calls = calls;
  return fn;
}

/** Capturing scheduler: runs nothing until .fire() is called. */
function fakeScheduler() {
  const scheduled = [];
  const fn = (callback, delayMs) => {
    const entry = { callback, delayMs, fired: false };
    scheduled.push(entry);
    return { unref: () => {} };
  };
  fn.scheduled = scheduled;
  fn.fire = (index = 0) => {
    scheduled[index].fired = true;
    scheduled[index].callback();
  };
  return fn;
}

const JSONL_CLAUDE = (role, text, extra = {}) =>
  JSON.stringify({
    type: role,
    timestamp: "2026-06-09T10:00:00.000Z",
    message: { role, content: [{ type: "text", text }] },
    ...extra,
  });

/* ------------------------------------------------------------------ */
/* parseTranscriptLine                                                 */
/* ------------------------------------------------------------------ */

describe("parseTranscriptLine()", () => {
  it("parses Claude Code dialect (type user/assistant)", () => {
    const message = parseTranscriptLine(JSONL_CLAUDE("assistant", "hello world"));
    assert.deepStrictEqual(message, {
      role: "assistant",
      text: "hello world",
      ts: "2026-06-09T10:00:00.000Z",
      tools: [],
    });
  });

  it("parses OpenClaw dialect (type message) with string content", () => {
    const message = parseTranscriptLine(
      JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
    );
    assert.strictEqual(message.role, "user");
    assert.strictEqual(message.text, "hi");
    assert.strictEqual(message.ts, null);
  });

  it("extracts tool names from tool_use and toolCall parts", () => {
    const message = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Bash" },
            { type: "toolCall", tool: "Read" },
            { type: "text", text: "running" },
          ],
        },
      }),
    );
    assert.deepStrictEqual(message.tools, ["Bash", "Read"]);
    assert.strictEqual(message.text, "running");
  });

  it("returns null for malformed/meta/empty lines", () => {
    assert.strictEqual(parseTranscriptLine("not json"), null);
    assert.strictEqual(
      parseTranscriptLine(JSON.stringify({ type: "file-history-snapshot" })),
      null,
    );
    assert.strictEqual(
      parseTranscriptLine(JSON.stringify({ type: "user", message: { role: "toolResult" } })),
      null,
    );
    assert.strictEqual(
      parseTranscriptLine(JSON.stringify({ type: "user", message: { role: "user", content: [] } })),
      null,
    );
  });

  it("truncates long text excerpts", () => {
    const message = parseTranscriptLine(JSONL_CLAUDE("user", "x".repeat(5000)));
    assert.strictEqual(message.text.length, 600);
  });
});

/* ------------------------------------------------------------------ */
/* killTerminalSession                                                 */
/* ------------------------------------------------------------------ */

describe("killTerminalSession()", () => {
  let claude;
  let alive;
  let killFn;
  let scheduler;
  let control;

  beforeEach(() => {
    claude = fakeClaudeCode({ pids: [4242] });
    alive = new Set([4242]);
    killFn = fakeKill(alive);
    scheduler = fakeScheduler();
    control = createSessionControl({
      claudeCode: claude.adapter,
      codex: { getLive: async () => ({ count: 1, ttys: [], pids: [5151] }) },
      resolveOpenClawTranscript: async () => null,
      killFn,
      scheduleFn: scheduler,
    });
    alive.add(5151);
  });

  it("rejects invalid pids with 400", async () => {
    assert.strictEqual((await control.killTerminalSession(0)).code, 400);
    assert.strictEqual((await control.killTerminalSession(1)).code, 400);
    assert.strictEqual((await control.killTerminalSession(NaN)).code, 400);
    assert.strictEqual((await control.killTerminalSession(3.5)).code, 400);
    assert.strictEqual(killFn.calls.length, 0);
  });

  it("404s for pids that are not live claude/codex processes (ps re-check)", async () => {
    const result = await control.killTerminalSession(9999);
    assert.strictEqual(result.code, 404);
    assert.match(result.error, /9999/);
    assert.strictEqual(killFn.calls.length, 0);
    assert.ok(claude.state.liveCalls >= 1, "must re-check ps at kill time");
  });

  it("re-checks liveness per call: a pid that disappeared is now a 404", async () => {
    assert.strictEqual((await control.killTerminalSession(4242)).success, true);
    claude.state.pids = []; // process list changed between calls
    const result = await control.killTerminalSession(4242);
    assert.strictEqual(result.code, 404);
  });

  it("SIGTERMs a valid claude pid and schedules SIGKILL escalation at 10s", async () => {
    const result = await control.killTerminalSession(4242);
    assert.deepStrictEqual(result, {
      success: true,
      pid: 4242,
      signal: "SIGTERM",
      escalatesToSigkillAfterMs: 10000,
    });
    assert.deepStrictEqual(killFn.calls, [{ pid: 4242, signal: "SIGTERM" }]);
    assert.strictEqual(scheduler.scheduled.length, 1);
    assert.strictEqual(scheduler.scheduled[0].delayMs, 10000);

    // Still alive after 10s → SIGKILL (probe with signal 0 first).
    scheduler.fire(0);
    assert.deepStrictEqual(killFn.calls.slice(1), [
      { pid: 4242, signal: 0 },
      { pid: 4242, signal: "SIGKILL" },
    ]);
  });

  it("does not SIGKILL when the process exited after SIGTERM", async () => {
    await control.killTerminalSession(4242);
    alive.delete(4242); // exited gracefully before the escalation timer
    scheduler.fire(0);
    const signals = killFn.calls.map((c) => c.signal);
    assert.ok(!signals.includes("SIGKILL"));
  });

  it("accepts codex pids too", async () => {
    const result = await control.killTerminalSession(5151);
    assert.strictEqual(result.success, true);
  });

  it("maps an ESRCH race on SIGTERM to 404", async () => {
    alive.delete(4242); // in the live list but exits before the signal lands
    const result = await control.killTerminalSession(4242);
    assert.strictEqual(result.code, 404);
  });
});

/* ------------------------------------------------------------------ */
/* getTerminalLive                                                     */
/* ------------------------------------------------------------------ */

describe("getTerminalLive()", () => {
  it("attaches cwds to live pids via the injected reader", async () => {
    const claude = fakeClaudeCode({ pids: [10, 11] });
    const control = createSessionControl({
      claudeCode: claude.adapter,
      resolveOpenClawTranscript: async () => null,
      readCwdFn: (pid) => (pid === 10 ? "/home/u/project-a" : null),
    });
    const live = await control.getTerminalLive();
    assert.strictEqual(live.count, 2);
    assert.deepStrictEqual(live.processes, [
      { pid: 10, cwd: "/home/u/project-a" },
      { pid: 11, cwd: null },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* readTranscriptChunk                                                 */
/* ------------------------------------------------------------------ */

describe("readTranscriptChunk()", () => {
  let tmpDir;
  let transcriptPath;
  let openclawPath;
  let control;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-control-test-"));
    transcriptPath = path.join(tmpDir, "abc-123.jsonl");
    openclawPath = path.join(tmpDir, "oc-456.jsonl");
    fs.writeFileSync(
      transcriptPath,
      [
        JSONL_CLAUDE("user", "first question"),
        JSON.stringify({ type: "file-history-snapshot", snapshot: {} }),
        JSONL_CLAUDE("assistant", "first answer"),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      openclawPath,
      JSON.stringify({ type: "message", message: { role: "user", content: "oc hello" } }) + "\n",
    );

    const claude = fakeClaudeCode({
      sessions: [{ sessionId: "abc-123", file: transcriptPath, cwd: tmpDir }],
    });
    control = createSessionControl({
      claudeCode: claude.adapter,
      resolveOpenClawTranscript: async (id) => (id === "oc-456" ? openclawPath : null),
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("validates source, id, and offset", async () => {
    assert.strictEqual((await control.readTranscriptChunk({ source: "x", id: "a" })).code, 400);
    assert.strictEqual(
      (await control.readTranscriptChunk({ source: "terminal", id: "" })).code,
      400,
    );
    assert.strictEqual(
      (await control.readTranscriptChunk({ source: "terminal", id: "abc-123", offset: -5 })).code,
      400,
    );
  });

  it("rejects path-traversal and unknown ids with 404 (no fs probing)", async () => {
    for (const id of ["../../etc/passwd", "..%2F..%2Fetc", "abc-123/../../x", "nope"]) {
      const result = await control.readTranscriptChunk({ source: "terminal", id });
      assert.strictEqual(result.code, 404, `id ${id} must 404`);
    }
    const ocResult = await control.readTranscriptChunk({ source: "openclaw", id: "../oc-456" });
    assert.strictEqual(ocResult.code, 404);
  });

  it("tails a terminal transcript and pages with nextOffset", async () => {
    const first = await control.readTranscriptChunk({ source: "terminal", id: "abc-123" });
    assert.strictEqual(first.error, undefined);
    assert.deepStrictEqual(
      first.messages.map((m) => [m.role, m.text]),
      [
        ["user", "first question"],
        ["assistant", "first answer"],
      ],
    );
    assert.strictEqual(first.eof, true);
    assert.strictEqual(first.nextOffset, first.size);

    // No new data: empty page, offset stable.
    const idle = await control.readTranscriptChunk({
      source: "terminal",
      id: "abc-123",
      offset: first.nextOffset,
    });
    assert.deepStrictEqual(idle.messages, []);
    assert.strictEqual(idle.nextOffset, first.nextOffset);

    // Appended lines come through incrementally.
    fs.appendFileSync(transcriptPath, JSONL_CLAUDE("assistant", "second answer") + "\n");
    const next = await control.readTranscriptChunk({
      source: "terminal",
      id: "abc-123",
      offset: first.nextOffset,
    });
    assert.deepStrictEqual(
      next.messages.map((m) => m.text),
      ["second answer"],
    );
    assert.strictEqual(next.eof, true);
  });

  it("re-tails when the offset is past the file size (truncated file)", async () => {
    const result = await control.readTranscriptChunk({
      source: "terminal",
      id: "abc-123",
      offset: 10 * 1024 * 1024,
    });
    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.messages.length, 2);
    assert.strictEqual(result.nextOffset, result.size);
  });

  it("does not consume a trailing partial line (writer mid-append)", async () => {
    const partial = JSONL_CLAUDE("assistant", "still writing");
    fs.appendFileSync(transcriptPath, partial.slice(0, 25)); // no newline, invalid JSON
    const first = await control.readTranscriptChunk({ source: "terminal", id: "abc-123" });
    assert.strictEqual(first.messages.length, 2);
    assert.ok(first.nextOffset < first.size, "partial line stays unconsumed");

    // Writer finishes the line; next poll picks it up from nextOffset.
    fs.appendFileSync(transcriptPath, partial.slice(25) + "\n");
    const next = await control.readTranscriptChunk({
      source: "terminal",
      id: "abc-123",
      offset: first.nextOffset,
    });
    assert.deepStrictEqual(
      next.messages.map((m) => m.text),
      ["still writing"],
    );
  });

  it("reads openclaw transcripts through the injected resolver", async () => {
    const result = await control.readTranscriptChunk({ source: "openclaw", id: "oc-456" });
    assert.strictEqual(result.error, undefined);
    assert.deepStrictEqual(
      result.messages.map((m) => [m.role, m.text]),
      [["user", "oc hello"]],
    );
  });

  it("aligns to the next full line when tailing into the middle of a file", async () => {
    // Build a file larger than the 64KB tail window with numbered lines.
    const lines = [];
    for (let i = 0; i < 600; i++) {
      lines.push(JSONL_CLAUDE("assistant", `message ${i} ${"pad".repeat(60)}`));
    }
    fs.writeFileSync(transcriptPath, lines.join("\n") + "\n");
    const result = await control.readTranscriptChunk({ source: "terminal", id: "abc-123" });
    assert.strictEqual(result.error, undefined);
    assert.ok(result.messages.length > 0);
    assert.ok(result.messages.length < 600, "tail window must not return the whole file");
    // Every parsed message is intact (alignment skipped the partial line).
    for (const message of result.messages) {
      assert.match(message.text, /^message \d+ /);
    }
    assert.strictEqual(result.nextOffset, result.size);
  });
});
