/**
 * Unit tests for the agent-run verb in src/actions.js — the server side of
 * remote dispatch. A remote OFC POSTs agent-run; this node runs the agent
 * locally via deps.runAgent and returns the parsed result.
 *
 * Uses a fake runAgent (no real CLI). Covers the happy path, CLI-reported
 * error, boundary validation (fail-closed, runner never called), timeout/null,
 * and an older node missing the runner.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { executeAction, clampAgentTimeout } = require("../src/actions");

const SUCCESS_STDOUT = JSON.stringify({
  result: {
    meta: { agentMeta: { sessionId: "sess-remote-1" } },
    payloads: [{ text: "Remote agent finished. PR #7 opened." }],
  },
});

/** Fake long-timeout agent runner: records argv, returns canned stdout. */
function makeRunAgent(stdout) {
  const calls = [];
  const fn = async (args, opts) => {
    calls.push({ args, opts });
    return stdout;
  };
  return { fn, calls };
}

function depsWith(runAgent) {
  return {
    runOpenClawAsync: async () => null, // never used by agent-run
    extractJSON: (o) => o,
    PORT: 3333,
    ...(runAgent ? { runAgent } : {}),
  };
}

describe("actions agent-run", () => {
  it("happy path: parses sessionId + outputText, success:true, builds the right argv", async () => {
    const runner = makeRunAgent(SUCCESS_STDOUT);
    const result = await executeAction("agent-run", depsWith(runner.fn), {
      agent: "dev",
      message: "do the thing",
      sessionKey: "agent:dev:kanban-tsk_1-123",
      timeoutSec: 120,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.detail.sessionId, "sess-remote-1");
    assert.strictEqual(result.detail.outputText, "Remote agent finished. PR #7 opened.");
    assert.strictEqual(result.detail.cliError, null);
    assert.match(result.output, /Remote agent finished/);

    assert.strictEqual(runner.calls.length, 1);
    const args = runner.calls[0].args;
    assert.strictEqual(args[0], "agent");
    assert.strictEqual(args[args.indexOf("--agent") + 1], "dev");
    assert.strictEqual(args[args.indexOf("--session-key") + 1], "agent:dev:kanban-tsk_1-123");
    assert.strictEqual(args[args.indexOf("--message") + 1], "do the thing");
    assert.ok(args.includes("--json"));
    assert.strictEqual(args[args.indexOf("--timeout") + 1], "120");
  });

  it("omits --session-key when none is supplied", async () => {
    const runner = makeRunAgent(SUCCESS_STDOUT);
    await executeAction("agent-run", depsWith(runner.fn), { agent: "dev", message: "hi" });
    assert.ok(!runner.calls[0].args.includes("--session-key"));
  });

  it("CLI-reported error → success:false, error set, detail.cliError populated", async () => {
    const runner = makeRunAgent(JSON.stringify({ error: "agent turn aborted", result: null }));
    const result = await executeAction("agent-run", depsWith(runner.fn), {
      agent: "dev",
      message: "go",
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, "agent turn aborted");
    assert.strictEqual(result.detail.cliError, "agent turn aborted");
  });

  it("rejects an invalid agent id (fail-closed, runner never called)", async () => {
    const runner = makeRunAgent(SUCCESS_STDOUT);
    const result = await executeAction("agent-run", depsWith(runner.fn), {
      agent: "bad id; rm -rf",
      message: "go",
    });
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Invalid agent id/);
    assert.strictEqual(runner.calls.length, 0);
  });

  it("rejects an oversized message (>64KB) without calling the runner", async () => {
    const runner = makeRunAgent(SUCCESS_STDOUT);
    const result = await executeAction("agent-run", depsWith(runner.fn), {
      agent: "dev",
      message: "x".repeat(64 * 1024 + 1),
    });
    assert.strictEqual(result.success, false);
    assert.match(result.error, /1\.\.64KB/);
    assert.strictEqual(runner.calls.length, 0);
  });

  it("rejects an empty message", async () => {
    const runner = makeRunAgent(SUCCESS_STDOUT);
    const result = await executeAction("agent-run", depsWith(runner.fn), {
      agent: "dev",
      message: "",
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(runner.calls.length, 0);
  });

  it("rejects a malformed sessionKey", async () => {
    const runner = makeRunAgent(SUCCESS_STDOUT);
    const result = await executeAction("agent-run", depsWith(runner.fn), {
      agent: "dev",
      message: "go",
      sessionKey: "bad key with spaces",
    });
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Invalid sessionKey/);
    assert.strictEqual(runner.calls.length, 0);
  });

  it("runAgent returning null (timeout) → success:false", async () => {
    const runner = makeRunAgent(null);
    const result = await executeAction("agent-run", depsWith(runner.fn), {
      agent: "dev",
      message: "go",
    });
    assert.strictEqual(result.success, false);
    assert.match(result.error, /failed or timed out/);
  });

  it("an older node without the runner reports it cleanly", async () => {
    const result = await executeAction("agent-run", depsWith(null), {
      agent: "dev",
      message: "go",
    });
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Agent runner unavailable/);
  });

  it("clampAgentTimeout floors at 30s, caps at 1800s, defaults on garbage", () => {
    assert.strictEqual(clampAgentTimeout(10), 30);
    assert.strictEqual(clampAgentTimeout(99999), 1800);
    assert.strictEqual(clampAgentTimeout("nope"), 600);
    assert.strictEqual(clampAgentTimeout(300), 300);
  });
});
