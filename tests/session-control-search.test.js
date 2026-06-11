const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createSessionControl } = require("../src/session-control");

/** Fake claude-code adapter backed by a mutable session list. */
function fakeClaudeCode({ pids = [], sessions = [] } = {}) {
  return {
    getLive: async () => ({ count: pids.length, ttys: [], pids: pids.slice() }),
    getSessions: async () => sessions.slice(),
  };
}

const JSONL_CLAUDE = (role, text, extra = {}) =>
  JSON.stringify({
    type: role,
    timestamp: "2026-06-09T10:00:00.000Z",
    message: { role, content: [{ type: "text", text }] },
    ...extra,
  });

describe("searchTranscript()", () => {
  let tmpDir;
  let transcriptPath;
  let openclawPath;
  let control;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-test-"));
    transcriptPath = path.join(tmpDir, "abc-123.jsonl");
    openclawPath = path.join(tmpDir, "oc-456.jsonl");
    fs.writeFileSync(
      transcriptPath,
      [
        JSONL_CLAUDE("user", "first question about Deployment"),
        JSON.stringify({ type: "file-history-snapshot", snapshot: {} }),
        JSONL_CLAUDE("assistant", "first answer"),
        JSONL_CLAUDE("user", "unrelated chatter"),
        JSONL_CLAUDE("assistant", "the deployment finished cleanly"),
        JSONL_CLAUDE("user", "thanks"),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      openclawPath,
      JSON.stringify({ type: "message", message: { role: "user", content: "oc needle here" } }) +
        "\n",
    );
    control = createSessionControl({
      claudeCode: fakeClaudeCode({
        sessions: [{ sessionId: "abc-123", file: transcriptPath, cwd: tmpDir }],
      }),
      resolveOpenClawTranscript: async (id) => (id === "oc-456" ? openclawPath : null),
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("validates source, id, query, and maxResults", async () => {
    const bad = [
      { source: "x", id: "abc-123", query: "q" },
      { source: "terminal", id: "", query: "q" },
      { source: "terminal", id: "abc-123", query: "" },
      { source: "terminal", id: "abc-123", query: "   " },
      { source: "terminal", id: "abc-123" },
      { source: "terminal", id: "abc-123", query: "x".repeat(300) },
      { source: "terminal", id: "abc-123", query: "q", maxResults: 0 },
      { source: "terminal", id: "abc-123", query: "q", maxResults: -2 },
      { source: "terminal", id: "abc-123", query: "q", maxResults: 1.5 },
    ];
    for (const params of bad) {
      const result = await control.searchTranscript(params);
      assert.strictEqual(result.code, 400, `params ${JSON.stringify(params)} must 400`);
    }
  });

  it("rejects path-traversal and unknown ids with 404", async () => {
    for (const id of ["../../etc/passwd", "abc-123/../../x", "nope"]) {
      const result = await control.searchTranscript({ source: "terminal", id, query: "q" });
      assert.strictEqual(result.code, 404, `id ${id} must 404`);
    }
  });

  it("finds case-insensitive matches with surrounding context", async () => {
    const result = await control.searchTranscript({
      source: "terminal",
      id: "abc-123",
      query: "deployment",
    });
    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.matchCount, 2);
    assert.strictEqual(result.truncated, false);

    const [first, second] = result.matches;
    assert.strictEqual(first.message.text, "first question about Deployment");
    assert.strictEqual(first.before, null); // first message in file
    assert.strictEqual(first.after.text, "first answer");

    assert.strictEqual(second.message.text, "the deployment finished cleanly");
    assert.strictEqual(second.before.text, "unrelated chatter");
    assert.strictEqual(second.after.text, "thanks");
  });

  it("returns after=null for a match on the final message", async () => {
    const result = await control.searchTranscript({
      source: "terminal",
      id: "abc-123",
      query: "thanks",
    });
    assert.strictEqual(result.matchCount, 1);
    assert.strictEqual(result.matches[0].after, null);
    assert.strictEqual(result.matches[0].before.text, "the deployment finished cleanly");
  });

  it("fills `after` correctly for consecutive matches", async () => {
    const result = await control.searchTranscript({
      source: "terminal",
      id: "abc-123",
      query: "first",
    });
    assert.strictEqual(result.matchCount, 2);
    assert.strictEqual(result.matches[0].after.text, "first answer");
    assert.strictEqual(result.matches[1].message.text, "first answer");
    assert.strictEqual(result.matches[1].after.text, "unrelated chatter");
  });

  it("matches on tool names too", async () => {
    fs.appendFileSync(
      transcriptPath,
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "KubectlApply" }] },
      }) + "\n",
    );
    const result = await control.searchTranscript({
      source: "terminal",
      id: "abc-123",
      query: "kubectlapply",
    });
    assert.strictEqual(result.matchCount, 1);
    assert.deepStrictEqual(result.matches[0].message.tools, ["KubectlApply"]);
  });

  it("caps results and reports truncated", async () => {
    const lines = [];
    for (let i = 0; i < 80; i++) lines.push(JSONL_CLAUDE("assistant", `needle ${i}`));
    fs.writeFileSync(transcriptPath, lines.join("\n") + "\n");
    const result = await control.searchTranscript({
      source: "terminal",
      id: "abc-123",
      query: "needle",
      maxResults: 10,
    });
    assert.strictEqual(result.matches.length, 10);
    assert.strictEqual(result.truncated, true);
  });

  it("clamps maxResults to the server-side hard cap", async () => {
    const lines = [];
    for (let i = 0; i < 250; i++) lines.push(JSONL_CLAUDE("assistant", `needle ${i}`));
    fs.writeFileSync(transcriptPath, lines.join("\n") + "\n");
    const result = await control.searchTranscript({
      source: "terminal",
      id: "abc-123",
      query: "needle",
      maxResults: 100000,
    });
    assert.ok(result.matches.length <= 200, "hard cap must hold");
    assert.strictEqual(result.truncated, true);
  });

  it("scans files larger than one read chunk (256KB) end to end", async () => {
    const lines = [];
    for (let i = 0; i < 2000; i++) {
      lines.push(JSONL_CLAUDE("assistant", `filler message ${i} ${"pad".repeat(80)}`));
    }
    lines.push(JSONL_CLAUDE("user", "the rare needle at the very end"));
    fs.writeFileSync(transcriptPath, lines.join("\n") + "\n");
    assert.ok(fs.statSync(transcriptPath).size > 256 * 1024, "fixture must exceed chunk size");

    const result = await control.searchTranscript({
      source: "terminal",
      id: "abc-123",
      query: "RARE NEEDLE",
    });
    assert.strictEqual(result.matchCount, 1);
    assert.strictEqual(result.matches[0].message.text, "the rare needle at the very end");
    assert.strictEqual(result.matches[0].before.text.startsWith("filler message 1999"), true);
  });

  it("ignores a trailing partial line (writer mid-append)", async () => {
    fs.appendFileSync(transcriptPath, JSONL_CLAUDE("user", "needle partial").slice(0, 30));
    const result = await control.searchTranscript({
      source: "terminal",
      id: "abc-123",
      query: "needle partial",
    });
    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.matchCount, 0);
  });

  it("searches openclaw transcripts through the injected resolver", async () => {
    const result = await control.searchTranscript({
      source: "openclaw",
      id: "oc-456",
      query: "NEEDLE",
    });
    assert.strictEqual(result.matchCount, 1);
    assert.strictEqual(result.matches[0].message.text, "oc needle here");
  });

  it("returns zero matches (not an error) when nothing matches", async () => {
    const result = await control.searchTranscript({
      source: "terminal",
      id: "abc-123",
      query: "zzz-not-present",
    });
    assert.strictEqual(result.error, undefined);
    assert.deepStrictEqual(result.matches, []);
    assert.strictEqual(result.matchCount, 0);
    assert.strictEqual(result.truncated, false);
  });
});
