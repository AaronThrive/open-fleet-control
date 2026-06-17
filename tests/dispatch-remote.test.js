/**
 * Unit tests for the REMOTE dispatch path in src/dispatch.js (Phase 2).
 *
 * Uses a REAL kanban engine + a fake resolveAgentNode + a fake fetchFn — no
 * real CLI, no network. The key invariant: the remote branch produces the
 * exact same {ok, stdout} the watcher consumes, so attempt bookkeeping is
 * identical to a local run. Also asserts the BACK-COMPAT guarantee: with NO
 * resolver wired, behaviour is unchanged (the dedicated dispatch.test.js suite
 * proves the full legacy surface; here we re-assert the local execFn path).
 */

const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createKanban } = require("../src/kanban");
const { createDispatch, synthStdout } = require("../src/dispatch");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ofc-dispatch-remote-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let dirCounter = 0;
function freshKanban() {
  const stateDir = path.join(tmpRoot, `state-${dirCounter++}`);
  fs.mkdirSync(stateDir, { recursive: true });
  return createKanban({ stateDir });
}

const REMOTE_SUCCESS = {
  success: true,
  output: "Remote done.",
  error: null,
  detail: {
    sessionId: "sess-remote-9",
    outputText: "Remote agent answer.\nLine two.",
    cliError: null,
  },
};

/** Fake fetch returning a canned Response-like object. */
function makeFetch({ ok = true, status = 200, json = REMOTE_SUCCESS, reject = false } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (reject) throw new Error("ECONNREFUSED");
    return {
      ok,
      status,
      json: async () => {
        if (json === "MALFORMED") throw new Error("bad json");
        return json;
      },
    };
  };
  return { fn, calls };
}

function remoteDispatch({ kanban, resolveAgentNode, fetchFn, execFn }) {
  return createDispatch({
    kanban,
    execFn,
    resolveAgentNode,
    fetchFn,
    meshIdentity: "node-a",
    briefsDir: "/opt/briefs",
    config: { baseUrl: "http://127.0.0.1:4444", node: "node-a" },
  });
}

describe("dispatch remote path", () => {
  let kanban;
  beforeEach(() => {
    kanban = freshKanban();
  });

  it("resolver→remote success closes the attempt as success with the remote result_text", async () => {
    const fetch = makeFetch();
    const dispatch = remoteDispatch({
      kanban,
      resolveAgentNode: async () => ({
        kind: "remote",
        node: "node-b",
        baseUrl: "https://node-b.ts.net",
        online: true,
      }),
      fetchFn: fetch.fn,
    });
    const task = kanban.createTask({ title: "T" }, "op");
    const result = dispatch.dispatchTask(task.id, { agent: "scout" });
    await result.completion;

    // The POST went to the remote /api/action with the agent-run envelope.
    assert.strictEqual(fetch.calls.length, 1);
    assert.strictEqual(fetch.calls[0].url, "https://node-b.ts.net/api/action");
    assert.strictEqual(fetch.calls[0].opts.method, "POST");
    const sentBody = JSON.parse(fetch.calls[0].opts.body);
    assert.strictEqual(sentBody.action, "agent-run");
    assert.strictEqual(sentBody.agent, "scout");
    assert.strictEqual(fetch.calls[0].opts.headers["Tailscale-User-Login"], "node-a");
    assert.strictEqual(fetch.calls[0].opts.headers["X-OFC-Dispatch"], "1");

    const after = kanban.getBoard().tasks.find((t) => t.id === task.id);
    assert.strictEqual(after.status, "review");
    assert.strictEqual(after.attempts[0].result, "success");
    assert.match(after.attempts[0].note, /session sess-remote-9/);
    assert.strictEqual(after.attempts[0].result_text, "Remote agent answer.\nLine two.");
  });

  it("strips the @node pin → remote agent-run receives the BARE agent id", async () => {
    const fetch = makeFetch();
    const seen = [];
    const dispatch = remoteDispatch({
      kanban,
      // The resolver receives the FULL ref for routing; capture it, then route remote.
      resolveAgentNode: async (ref) => {
        seen.push(ref);
        return { kind: "remote", node: "node-b", baseUrl: "https://node-b.ts.net", online: true };
      },
      fetchFn: fetch.fn,
    });
    const task = kanban.createTask({ title: "T" }, "op");
    const result = dispatch.dispatchTask(task.id, { agent: "scout@node-b" });
    await result.completion;

    // Routing saw the full pinned ref...
    assert.strictEqual(seen[0], "scout@node-b");
    // ...but the remote agent-run body carries the BARE id (no "@"), otherwise the
    // remote agent-run validator rejects it with "Invalid agent id" (the live bug).
    const sentBody = JSON.parse(fetch.calls[0].opts.body);
    assert.strictEqual(sentBody.agent, "scout");
    assert.ok(!sentBody.sessionKey.includes("@"), "session key must not carry the @node qualifier");

    const after = kanban.getBoard().tasks.find((t) => t.id === task.id);
    assert.strictEqual(after.attempts[0].result, "success");
  });

  it("remote agent-error envelope closes the attempt as failure (card → failed)", async () => {
    const fetch = makeFetch({
      json: { success: false, error: "remote agent crashed", detail: { cliError: "remote agent crashed" } },
    });
    const dispatch = remoteDispatch({
      kanban,
      resolveAgentNode: async () => ({ kind: "remote", node: "node-b", baseUrl: "https://b", online: true }),
      fetchFn: fetch.fn,
    });
    const task = kanban.createTask({ title: "T" }, "op");
    const result = dispatch.dispatchTask(task.id, { agent: "scout" });
    await result.completion;

    const after = kanban.getBoard().tasks.find((t) => t.id === task.id);
    assert.strictEqual(after.status, "failed");
    assert.strictEqual(after.attempts[0].result, "failure");
    assert.match(after.attempts[0].note, /remote agent crashed/);
  });

  it("fetch network error → failure", async () => {
    const fetch = makeFetch({ reject: true });
    const dispatch = remoteDispatch({
      kanban,
      resolveAgentNode: async () => ({ kind: "remote", node: "node-b", baseUrl: "https://b", online: true }),
      fetchFn: fetch.fn,
    });
    const task = kanban.createTask({ title: "T" }, "op");
    const result = dispatch.dispatchTask(task.id, { agent: "scout" });
    await result.completion;

    const after = kanban.getBoard().tasks.find((t) => t.id === task.id);
    assert.strictEqual(after.status, "failed");
    assert.strictEqual(after.attempts[0].result, "failure");
  });

  it("remote non-2xx → failure with HTTP <code>", async () => {
    const fetch = makeFetch({ ok: false, status: 401 });
    const dispatch = remoteDispatch({
      kanban,
      resolveAgentNode: async () => ({ kind: "remote", node: "node-b", baseUrl: "https://b", online: true }),
      fetchFn: fetch.fn,
    });
    const task = kanban.createTask({ title: "T" }, "op");
    const result = dispatch.dispatchTask(task.id, { agent: "scout" });
    await result.completion;

    const after = kanban.getBoard().tasks.find((t) => t.id === task.id);
    assert.strictEqual(after.attempts[0].result, "failure");
    assert.match(after.attempts[0].note, /HTTP 401/);
  });

  it("malformed JSON body → failure", async () => {
    const fetch = makeFetch({ json: "MALFORMED" });
    const dispatch = remoteDispatch({
      kanban,
      resolveAgentNode: async () => ({ kind: "remote", node: "node-b", baseUrl: "https://b", online: true }),
      fetchFn: fetch.fn,
    });
    const task = kanban.createTask({ title: "T" }, "op");
    const result = dispatch.dispatchTask(task.id, { agent: "scout" });
    await result.completion;

    const after = kanban.getBoard().tasks.find((t) => t.id === task.id);
    assert.strictEqual(after.attempts[0].result, "failure");
    assert.match(after.attempts[0].note, /Malformed agent-run response/);
  });

  it("offline mesh precheck fast-fails WITHOUT calling fetch", async () => {
    const fetch = makeFetch();
    const dispatch = remoteDispatch({
      kanban,
      resolveAgentNode: async () => ({ kind: "remote", node: "node-b", baseUrl: "https://b", online: false }),
      fetchFn: fetch.fn,
    });
    const task = kanban.createTask({ title: "T" }, "op");
    const result = dispatch.dispatchTask(task.id, { agent: "scout" });
    await result.completion;

    assert.strictEqual(fetch.calls.length, 0);
    const after = kanban.getBoard().tasks.find((t) => t.id === task.id);
    assert.strictEqual(after.attempts[0].result, "failure");
    assert.match(after.attempts[0].note, /offline \(mesh precheck\)/);
  });

  it("resolver→unknown → failure, never touches fetch", async () => {
    const fetch = makeFetch();
    const dispatch = remoteDispatch({
      kanban,
      resolveAgentNode: async () => ({ kind: "unknown", agentId: "ghost" }),
      fetchFn: fetch.fn,
    });
    const task = kanban.createTask({ title: "T" }, "op");
    const result = dispatch.dispatchTask(task.id, { agent: "ghost" });
    await result.completion;

    assert.strictEqual(fetch.calls.length, 0);
    const after = kanban.getBoard().tasks.find((t) => t.id === task.id);
    assert.strictEqual(after.attempts[0].result, "failure");
    assert.match(after.attempts[0].note, /Unknown agent 'ghost'/);
  });

  it("resolver→unreachable → failure", async () => {
    const fetch = makeFetch();
    const dispatch = remoteDispatch({
      kanban,
      resolveAgentNode: async () => ({ kind: "unreachable", agentId: "scout", node: "node-c" }),
      fetchFn: fetch.fn,
    });
    const task = kanban.createTask({ title: "T" }, "op");
    const result = dispatch.dispatchTask(task.id, { agent: "scout" });
    await result.completion;

    const after = kanban.getBoard().tasks.find((t) => t.id === task.id);
    assert.strictEqual(after.attempts[0].result, "failure");
    assert.match(after.attempts[0].note, /No mesh node hosts agent 'scout'/);
  });

  it("a resolver blow-up routes to failure (never rejects the completion)", async () => {
    const dispatch = remoteDispatch({
      kanban,
      resolveAgentNode: async () => {
        throw new Error("roster exploded");
      },
      fetchFn: makeFetch().fn,
    });
    const task = kanban.createTask({ title: "T" }, "op");
    const result = dispatch.dispatchTask(task.id, { agent: "scout" });
    await result.completion; // must not reject

    const after = kanban.getBoard().tasks.find((t) => t.id === task.id);
    assert.strictEqual(after.attempts[0].result, "failure");
    assert.match(after.attempts[0].note, /roster exploded/);
  });

  it("resolver→local routes through execFn exactly like a local dispatch", async () => {
    const calls = [];
    const execFn = (args, opts) => {
      calls.push({ args, opts });
      return Promise.resolve({
        stdout: JSON.stringify({ result: { meta: { agentMeta: { sessionId: "sess-local" } } } }),
      });
    };
    const fetch = makeFetch();
    const dispatch = remoteDispatch({
      kanban,
      resolveAgentNode: async () => ({ kind: "local", agentId: "dev" }),
      fetchFn: fetch.fn,
      execFn,
    });
    const task = kanban.createTask({ title: "T" }, "op");
    const result = dispatch.dispatchTask(task.id, { agent: "dev" });
    await result.completion;

    assert.strictEqual(fetch.calls.length, 0); // local never hits the network
    assert.strictEqual(calls.length, 1); // ran via execFn
    const after = kanban.getBoard().tasks.find((t) => t.id === task.id);
    assert.strictEqual(after.attempts[0].result, "success");
    assert.match(after.attempts[0].note, /session sess-local/);
  });

  it("concurrency cap (429) and open-attempt lock (409) still apply on the remote path", async () => {
    const fetch = makeFetch();
    let release;
    const gate = new Promise((r) => (release = r));
    const slowFetch = async (url, opts) => {
      fetch.calls.push({ url, opts });
      await gate;
      return { ok: true, status: 200, json: async () => REMOTE_SUCCESS };
    };
    const dispatch = createDispatch({
      kanban,
      resolveAgentNode: async () => ({ kind: "remote", node: "node-b", baseUrl: "https://b", online: true }),
      fetchFn: slowFetch,
      config: { baseUrl: "http://x", node: "node-a", maxConcurrent: 1 },
    });
    const a = kanban.createTask({ title: "A" }, "op");
    const b = kanban.createTask({ title: "B" }, "op");
    const r1 = dispatch.dispatchTask(a.id, { agent: "scout" });
    // same card again → 409
    assert.throws(
      () => dispatch.dispatchTask(a.id, { agent: "scout" }),
      (e) => e.statusCode === 409,
    );
    // second card past the cap → 429
    assert.throws(
      () => dispatch.dispatchTask(b.id, { agent: "scout" }),
      (e) => e.statusCode === 429,
    );
    release();
    await r1.completion;
  });
});

describe("synthStdout", () => {
  it("round-trips through parseRunResult for a success envelope", () => {
    const stdout = synthStdout(REMOTE_SUCCESS);
    const { parseRunResult } = require("../src/dispatch");
    const parsed = parseRunResult(stdout);
    assert.strictEqual(parsed.sessionId, "sess-remote-9");
    assert.strictEqual(parsed.outputText, "Remote agent answer.\nLine two.");
    assert.strictEqual(parsed.error, null);
  });

  it("carries a CLI error from the envelope detail", () => {
    const { parseRunResult } = require("../src/dispatch");
    const stdout = synthStdout({ success: false, error: "boom", detail: { cliError: "boom" } });
    assert.strictEqual(parseRunResult(stdout).error, "boom");
  });
});
