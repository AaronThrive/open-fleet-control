const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createClaudeCodeSource,
  parsePsOutput,
  isClaudeProcess,
} = require("../src/usage-sources/claude-code");

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function iso(ms) {
  return new Date(ms).toISOString();
}

function assistantLine(sessionId, tsMs, usage, model = "claude-fable-5") {
  return JSON.stringify({
    type: "assistant",
    sessionId,
    cwd: "/home/user/project",
    timestamp: iso(tsMs),
    message: { role: "assistant", model, content: [], usage },
  });
}

function userLine(sessionId, tsMs) {
  return JSON.stringify({
    type: "user",
    sessionId,
    cwd: "/home/user/project",
    timestamp: iso(tsMs),
    message: { role: "user", content: "hello" },
  });
}

function writeSessionFixture(projectsDir) {
  const projDir = path.join(projectsDir, "-home-user-project");
  const subDir = path.join(projDir, "subagents");
  fs.mkdirSync(subDir, { recursive: true });

  // Main session: snapshot noise + malformed line + user + 2 assistant turns
  const mainLines = [
    JSON.stringify({ type: "mode", mode: "normal", sessionId: "sess-main" }),
    JSON.stringify({ type: "file-history-snapshot", messageId: "m1", snapshot: {} }),
    "{this is not json",
    userLine("sess-main", NOW - 2 * HOUR),
    assistantLine("sess-main", NOW - 2 * HOUR + 1000, {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 200,
    }),
    assistantLine("sess-main", NOW - 1 * HOUR, {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }),
  ];
  fs.writeFileSync(path.join(projDir, "sess-main.jsonl"), mainLines.join("\n") + "\n");

  // Subagent transcript under subagents/
  const subLines = [
    userLine("sess-sub", NOW - 30 * 60 * 1000),
    assistantLine(
      "sess-sub",
      NOW - 29 * 60 * 1000,
      { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 0 },
      "claude-haiku-4-5",
    ),
  ];
  fs.writeFileSync(path.join(subDir, "sess-sub.jsonl"), subLines.join("\n") + "\n");

  // Old session (5 days ago) in a second project
  const oldDir = path.join(projectsDir, "-home-user-other");
  fs.mkdirSync(oldDir, { recursive: true });
  const oldLines = [
    userLine("sess-old", NOW - 5 * DAY),
    assistantLine("sess-old", NOW - 5 * DAY + 1000, { input_tokens: 1, output_tokens: 1 }),
  ];
  fs.writeFileSync(path.join(oldDir, "sess-old.jsonl"), oldLines.join("\n") + "\n");
}

describe("usage-sources/claude-code", () => {
  let tmpDir;
  let projectsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-claude-test-"));
    projectsDir = path.join(tmpDir, "projects");
    fs.mkdirSync(projectsDir);
    writeSessionFixture(projectsDir);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("availability", () => {
    it("reports unavailable for a missing projects dir without throwing", async () => {
      const source = createClaudeCodeSource({ projectsDir: path.join(tmpDir, "nope") });
      assert.strictEqual(source.available, false);
      assert.ok(source.reason.includes("directory not found"));
      assert.deepStrictEqual(await source.getSessions(), []);
      const windows = await source.getUsageWindows();
      assert.strictEqual(windows.available, false);
    });
  });

  describe("getSessions()", () => {
    it("parses sessions, skipping non-message and malformed lines", async () => {
      const source = createClaudeCodeSource({ projectsDir, nowFn: () => NOW });
      const sessions = await source.getSessions();
      assert.strictEqual(sessions.length, 3);

      const main = sessions.find((s) => s.sessionId === "sess-main");
      assert.ok(main, "main session present");
      assert.strictEqual(main.messages, 3); // 1 user + 2 assistant; noise skipped
      assert.deepStrictEqual(main.tokens, {
        input: 110,
        output: 55,
        cacheRead: 800,
        cacheWrite: 200,
      });
      assert.strictEqual(main.model, "claude-fable-5");
      assert.strictEqual(main.cwd, "/home/user/project");
      assert.strictEqual(main.live, false);
      assert.strictEqual(main.subagent, false);
      assert.ok(Date.parse(main.startedAt) < Date.parse(main.lastActiveAt));
    });

    it("finds subagent transcripts under subagents/ and flags them", async () => {
      const source = createClaudeCodeSource({ projectsDir, nowFn: () => NOW });
      const sub = (await source.getSessions()).find((s) => s.sessionId === "sess-sub");
      assert.ok(sub, "subagent session present");
      assert.strictEqual(sub.subagent, true);
      assert.strictEqual(sub.model, "claude-haiku-4-5");
      assert.strictEqual(sub.tokens.input, 7);
    });

    it("filters sessions by sinceMs", async () => {
      const source = createClaudeCodeSource({ projectsDir, nowFn: () => NOW });
      const sessions = await source.getSessions({ sinceMs: NOW - DAY });
      const ids = sessions.map((s) => s.sessionId).sort();
      assert.deepStrictEqual(ids, ["sess-main", "sess-sub"]);
    });

    it("respects the limit parameter", async () => {
      const source = createClaudeCodeSource({ projectsDir, nowFn: () => NOW });
      const sessions = await source.getSessions({ limit: 1 });
      assert.strictEqual(sessions.length, 1);
    });
  });

  describe("getUsageWindows()", () => {
    it("buckets tokens into h24/d3/d7 with estimated cost", async () => {
      const source = createClaudeCodeSource({ projectsDir, nowFn: () => NOW });
      const windows = await source.getUsageWindows();
      assert.strictEqual(windows.available, true);

      // h24: main (2 assistant) + sub (1 assistant) = 3 requests
      assert.strictEqual(windows.h24.requests, 3);
      assert.strictEqual(windows.h24.input, 117);
      assert.strictEqual(windows.h24.output, 58);
      assert.strictEqual(windows.h24.cacheRead, 800);
      assert.strictEqual(windows.h24.cacheWrite, 200);

      // d3 same as h24 (old session is 5 days back)
      assert.strictEqual(windows.d3.requests, 3);

      // d7 also includes the 5-day-old session
      assert.strictEqual(windows.d7.requests, 4);
      assert.strictEqual(windows.d7.input, 118);

      // est cost present and monotonic across windows
      assert.ok(windows.h24.estCost > 0);
      assert.ok(windows.d7.estCost >= windows.h24.estCost);
    });

    it("computes cost from Opus rates ($15/M input)", async () => {
      const dir = fs.mkdtempSync(path.join(tmpDir, "cost-"));
      const proj = path.join(dir, "-p");
      fs.mkdirSync(proj);
      fs.writeFileSync(
        path.join(proj, "s.jsonl"),
        assistantLine("s", NOW - HOUR, { input_tokens: 1000000, output_tokens: 0 }) + "\n",
      );
      const windows = await createClaudeCodeSource({
        projectsDir: dir,
        nowFn: () => NOW,
      }).getUsageWindows();
      assert.strictEqual(windows.h24.estCost, 15);
    });
  });

  describe("live process detection", () => {
    it("matches claude processes and reports count + TTYs", async () => {
      const psFn = async () => [
        { pid: 100, tty: "pts/3", command: "claude" },
        { pid: 101, tty: "pts/7", command: "/usr/local/bin/claude --resume abc" },
        { pid: 102, tty: "?", command: "claude" },
        { pid: 103, tty: "pts/1", command: "/usr/bin/codex exec" },
        { pid: 104, tty: "pts/2", command: "claude-monitor --watch" },
      ];
      const source = createClaudeCodeSource({ projectsDir, psFn });
      const live = await source.getLive();
      assert.strictEqual(live.count, 3);
      assert.deepStrictEqual(live.ttys.sort(), ["pts/3", "pts/7"]);
      assert.deepStrictEqual(live.pids.sort(), [100, 101, 102]);
    });

    it("never throws when psFn fails", async () => {
      const source = createClaudeCodeSource({
        projectsDir,
        psFn: async () => {
          throw new Error("ps exploded");
        },
      });
      const live = await source.getLive();
      assert.strictEqual(live.count, 0);
      assert.ok(live.error.includes("ps exploded"));
    });
  });

  describe("helpers", () => {
    it("parsePsOutput parses pid/tty/args columns", () => {
      const parsed = parsePsOutput("  123 pts/0 claude --flag\n 456 ?    node server.js\n\n");
      assert.deepStrictEqual(parsed, [
        { pid: 123, tty: "pts/0", command: "claude --flag" },
        { pid: 456, tty: "?", command: "node server.js" },
      ]);
    });

    it("isClaudeProcess matches only the claude executable", () => {
      assert.strictEqual(isClaudeProcess("claude"), true);
      assert.strictEqual(isClaudeProcess("/usr/local/bin/claude --resume"), true);
      assert.strictEqual(isClaudeProcess("claude-monitor"), false);
      assert.strictEqual(isClaudeProcess("grep claude"), false);
      assert.strictEqual(isClaudeProcess(""), false);
    });
  });
});
