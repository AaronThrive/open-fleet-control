const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createCodexSource, isCodexProcess, historyTsToMs } = require("../src/usage-sources/codex");

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

function historyLine(sessionId, tsMs, text) {
  return JSON.stringify({ session_id: sessionId, ts: Math.floor(tsMs / 1000), text });
}

describe("usage-sources/codex", () => {
  let tmpDir;
  let codexDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-codex-test-"));
    codexDir = path.join(tmpDir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });

    const lines = [
      historyLine("sess-a", NOW - 5 * HOUR, "fix the build"),
      "not json at all {{",
      historyLine("sess-a", NOW - 2 * HOUR, "x".repeat(500)), // long text -> preview capped
      historyLine("sess-b", NOW - 1 * HOUR, "update codex"),
      JSON.stringify({ ts: "garbage", text: "no usable timestamp" }),
    ];
    fs.writeFileSync(path.join(codexDir, "history.jsonl"), lines.join("\n") + "\n");

    // Rollout session files under sessions/YYYY/MM/DD/
    const dayDir = path.join(codexDir, "sessions", "2026", "06", "09");
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(path.join(dayDir, "rollout-2026-06-09T16-38-15-aaa.jsonl"), "{}\n");
    fs.writeFileSync(path.join(dayDir, "rollout-2026-06-09T20-24-57-bbb.jsonl"), "{}\n");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports unavailable for a missing codex dir without throwing", async () => {
    const source = createCodexSource({ codexDir: path.join(tmpDir, "nope") });
    assert.strictEqual(source.available, false);
    assert.ok(source.reason.includes("no Codex data"));
    const activity = await source.getActivity();
    assert.strictEqual(activity.available, false);
    assert.strictEqual(activity.tokensAvailable, false);
  });

  describe("getActivity()", () => {
    it("is honest about missing tokens and parses the timeline", async () => {
      const source = createCodexSource({ codexDir });
      const activity = await source.getActivity();
      assert.strictEqual(activity.available, true);
      assert.strictEqual(activity.tokensAvailable, false);
      assert.strictEqual(activity.entries, 4); // malformed line skipped
      assert.strictEqual(activity.sessions, 2);
      assert.ok(activity.firstAt < activity.lastAt);
      // recent is newest-first
      assert.strictEqual(activity.recent[0].sessionId, "sess-b");
      assert.strictEqual(activity.recent[0].preview, "update codex");
    });

    it("caps text previews at 120 characters", async () => {
      const source = createCodexSource({ codexDir });
      const activity = await source.getActivity();
      const long = activity.recent.find((e) => e.preview && e.preview.startsWith("xxx"));
      assert.ok(long, "long entry present");
      assert.strictEqual(long.preview.length, 120);
    });

    it("filters by sinceMs (entries without timestamps excluded)", async () => {
      const source = createCodexSource({ codexDir });
      const activity = await source.getActivity({ sinceMs: NOW - 3 * HOUR });
      assert.strictEqual(activity.entries, 2);
      assert.strictEqual(activity.sessions, 2);
    });

    it("tolerates a sessions-only layout (history missing)", async () => {
      const onlySessions = path.join(tmpDir, "only-sessions");
      fs.mkdirSync(path.join(onlySessions, "sessions"), { recursive: true });
      const source = createCodexSource({ codexDir: onlySessions });
      assert.strictEqual(source.available, true);
      const activity = await source.getActivity();
      assert.strictEqual(activity.available, true);
      assert.strictEqual(activity.entries, 0);
      assert.ok(activity.note.includes("history file not found"));
    });
  });

  describe("getSessionFiles()", () => {
    it("enumerates nested rollout files and reports the newest", async () => {
      const source = createCodexSource({ codexDir });
      const files = await source.getSessionFiles();
      assert.strictEqual(files.available, true);
      assert.strictEqual(files.count, 2);
      assert.ok(files.newest.file.startsWith("rollout-"));
      assert.ok(Date.parse(files.newest.modifiedAt) > 0);
    });

    it("reports unavailable when the sessions dir is missing", async () => {
      const noSessions = path.join(tmpDir, "no-sessions");
      fs.mkdirSync(noSessions, { recursive: true });
      fs.writeFileSync(path.join(noSessions, "history.jsonl"), "");
      const source = createCodexSource({ codexDir: noSessions });
      const files = await source.getSessionFiles();
      assert.strictEqual(files.available, false);
      assert.strictEqual(files.count, 0);
    });
  });

  describe("live process detection", () => {
    it("matches codex processes only", async () => {
      const psFn = async () => [
        { pid: 1, tty: "pts/0", command: "codex" },
        { pid: 2, tty: "pts/1", command: "/home/u/.codex/bin/codex exec --json" },
        { pid: 3, tty: "pts/2", command: "claude" },
        { pid: 4, tty: "?", command: "codex-helper" },
      ];
      const source = createCodexSource({ codexDir, psFn });
      const live = await source.getLive();
      assert.strictEqual(live.count, 2);
      assert.deepStrictEqual(live.ttys.sort(), ["pts/0", "pts/1"]);
    });

    it("never throws when psFn fails", async () => {
      const source = createCodexSource({
        codexDir,
        psFn: async () => {
          throw new Error("no ps here");
        },
      });
      const live = await source.getLive();
      assert.strictEqual(live.count, 0);
      assert.ok(live.error.includes("no ps here"));
    });
  });

  describe("helpers", () => {
    it("historyTsToMs handles epoch seconds, epoch ms, and junk", () => {
      assert.strictEqual(historyTsToMs(1777563726), 1777563726000);
      assert.strictEqual(historyTsToMs(1777563726000), 1777563726000);
      assert.strictEqual(historyTsToMs("garbage"), null);
      assert.strictEqual(historyTsToMs(null), null);
      assert.strictEqual(historyTsToMs(-5), null);
    });

    it("isCodexProcess matches only the codex executable", () => {
      assert.strictEqual(isCodexProcess("codex"), true);
      assert.strictEqual(isCodexProcess("/usr/bin/codex exec"), true);
      assert.strictEqual(isCodexProcess("codex-helper"), false);
      assert.strictEqual(isCodexProcess("vi codex.js"), false);
    });
  });
});
