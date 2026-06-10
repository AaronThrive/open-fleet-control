/**
 * Unit tests for src/dispatch.js — kanban → agent dispatch.
 *
 * Uses a REAL kanban engine on a temp state dir (so attempt/move/comment
 * bookkeeping is exercised end-to-end) and a MOCKED execFn — no real agent
 * is ever invoked from tests. Covers: message composition, the CLI argv
 * contract, dispatch side effects, the double-dispatch 409 guard, the max
 * concurrency rail, remote-node refusal, disabled/unavailable 503s, and
 * attempt closing on run success/failure.
 */

const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createKanban } = require("../src/kanban");
const {
  createDispatch,
  composeKickoffMessage,
  resolveBinary,
  isOpenDispatchAttempt,
  DISPATCH_NOTE,
} = require("../src/dispatch");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ofc-dispatch-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let dirCounter = 0;
function freshKanban() {
  const stateDir = path.join(tmpRoot, `state-${dirCounter++}`);
  fs.mkdirSync(stateDir, { recursive: true });
  return createKanban({ stateDir });
}

/** Mock execFn that records calls and resolves/rejects on command. */
function makeExecFn({ fail = false, stdout = "{}" } = {}) {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fn = (args, opts) => {
    calls.push({ args, opts });
    return gate.then(() => {
      if (fail) throw new Error("gateway exploded");
      return { stdout };
    });
  };
  return { fn, calls, release };
}

function makeDispatch({ kanban, execFn, config = {}, onEvent } = {}) {
  return createDispatch({
    kanban,
    execFn,
    briefsDir: "/opt/briefs",
    onEvent,
    config: { baseUrl: "http://127.0.0.1:4444", node: "test-node", ...config },
  });
}

describe("composeKickoffMessage", () => {
  it("includes card fields, base URL, protocol brief, and the binding instructions", () => {
    const task = {
      id: "tsk_abc123",
      title: "Fix the flux capacitor",
      description: "It fluxes the wrong way.",
      priority: 1,
      due: "2026-07-01",
    };
    const message = composeKickoffMessage(task, {
      agent: "dev",
      baseUrl: "http://127.0.0.1:4444",
      briefsDir: "/opt/briefs",
    });
    assert.match(message, /Task tsk_abc123: Fix the flux capacitor/);
    assert.match(message, /Priority: P1/);
    assert.match(message, /Due: 2026-07-01/);
    assert.match(message, /It fluxes the wrong way\./);
    assert.match(message, /http:\/\/127\.0\.0\.1:4444\/api\/fleet\/briefs\/agent-task-protocol/);
    assert.match(message, /\/opt\/briefs\/agent-task-protocol\.md/);
    assert.match(message, /tasks\/tsk_abc123\/comments/);
    assert.match(message, /tasks\/tsk_abc123\/move/);
    assert.match(message, /chat\/publish/);
    assert.match(message, /evolution\/lessons/);
    assert.match(message, /Tailscale-User-Login: dev/);
  });

  it("renders empty description and missing due date gracefully", () => {
    const task = { id: "tsk_000001", title: "T", description: "", priority: 2, due: null };
    const message = composeKickoffMessage(task, {
      agent: "dev",
      baseUrl: "http://x",
      briefsDir: null,
    });
    assert.match(message, /Due: none/);
    assert.match(message, /\(none\)/);
  });
});

describe("dispatchTask", () => {
  let kanban;
  beforeEach(() => {
    kanban = freshKanban();
  });

  it("invokes the CLI with the right argv, records attempt + move + comment, fires onEvent", async () => {
    const exec = makeExecFn({
      stdout: JSON.stringify({ result: { meta: { agentMeta: { sessionId: "sess-1" } } } }),
    });
    const events = [];
    const dispatch = makeDispatch({ kanban, execFn: exec.fn, onEvent: (e) => events.push(e) });
    const task = kanban.createTask({ title: "Build it", description: "desc", priority: 2 }, "op");

    const result = dispatch.dispatchTask(task.id, { agent: "dev", actor: "aaron" });

    // CLI contract
    assert.strictEqual(exec.calls.length, 1);
    const args = exec.calls[0].args;
    assert.strictEqual(args[0], "agent");
    assert.strictEqual(args[args.indexOf("--agent") + 1], "dev");
    assert.match(
      args[args.indexOf("--session-key") + 1],
      new RegExp(`^agent:dev:kanban-${task.id}-\\d+$`),
    );
    assert.match(args[args.indexOf("--message") + 1], /Build it/);
    assert.ok(args.includes("--json"));
    assert.strictEqual(args[args.indexOf("--timeout") + 1], "600");

    // Card bookkeeping
    assert.strictEqual(result.task.status, "assigned"); // moved out of inbox
    assert.strictEqual(result.task.attempts.length, 1);
    assert.strictEqual(result.task.attempts[0].agent, "dev");
    assert.strictEqual(result.task.attempts[0].note, DISPATCH_NOTE);
    assert.strictEqual(result.task.attempts[0].ended_at, null);
    assert.strictEqual(result.task.comments.length, 1);
    assert.match(result.task.comments[0].text, /Dispatched to dev by aaron/);
    assert.strictEqual(result.task.comments[0].author, "aaron");
    assert.match(result.sessionKey, /^agent:dev:kanban-/);

    // Event
    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual(
      { type: events[0].type, taskId: events[0].taskId, agent: events[0].agent },
      { type: "task.dispatched", taskId: task.id, agent: "dev" },
    );

    // Completion closes the attempt with the parsed session id
    exec.release();
    await result.completion;
    const closed = kanban.getBoard().tasks.find((t) => t.id === task.id);
    assert.strictEqual(closed.attempts[0].result, "success");
    assert.match(closed.attempts[0].note, /^dispatched · session sess-1$/);
    assert.ok(closed.attempts[0].ended_at);
  });

  it("does not move a card that is already in 'assigned'", async () => {
    const exec = makeExecFn();
    const dispatch = makeDispatch({ kanban, execFn: exec.fn });
    const task = kanban.createTask({ title: "T", status: "assigned" }, "op");
    const result = dispatch.dispatchTask(task.id, { agent: "dev" });
    assert.strictEqual(result.task.status, "assigned");
    exec.release();
    await result.completion;
  });

  it("closes the attempt as failure and comments when the run fails", async () => {
    const exec = makeExecFn({ fail: true });
    const dispatch = makeDispatch({ kanban, execFn: exec.fn });
    const task = kanban.createTask({ title: "T" }, "op");
    const result = dispatch.dispatchTask(task.id, { agent: "dev" });
    exec.release();
    await result.completion;

    const after = kanban.getBoard().tasks.find((t) => t.id === task.id);
    assert.strictEqual(after.attempts[0].result, "failure");
    assert.match(after.attempts[0].note, /^dispatched · failed: gateway exploded/);
    assert.ok(after.attempts[0].ended_at);
    const failureComment = after.comments.find((c) => c.author === "dispatch");
    assert.match(failureComment.text, /failed: gateway exploded/);
  });

  it("refuses to dispatch the same task twice while an attempt is open (409)", async () => {
    const exec = makeExecFn();
    const dispatch = makeDispatch({ kanban, execFn: exec.fn });
    const task = kanban.createTask({ title: "T" }, "op");
    const first = dispatch.dispatchTask(task.id, { agent: "dev" });
    assert.throws(
      () => dispatch.dispatchTask(task.id, { agent: "dev" }),
      (err) => err.statusCode === 409 && /open dispatched attempt/.test(err.message),
    );
    exec.release();
    await first.completion;
    // After the attempt closes, re-dispatch is allowed again.
    const second = dispatch.dispatchTask(task.id, { agent: "dev" });
    exec.release();
    await second.completion;
  });

  it("enforces the max concurrent dispatches rail (429)", async () => {
    const exec = makeExecFn();
    const dispatch = makeDispatch({ kanban, execFn: exec.fn, config: { maxConcurrent: 2 } });
    const a = kanban.createTask({ title: "A" }, "op");
    const b = kanban.createTask({ title: "B" }, "op");
    const c = kanban.createTask({ title: "C" }, "op");
    const r1 = dispatch.dispatchTask(a.id, { agent: "dev" });
    const r2 = dispatch.dispatchTask(b.id, { agent: "dev" });
    assert.throws(
      () => dispatch.dispatchTask(c.id, { agent: "dev" }),
      (err) => err.statusCode === 429 && /Max concurrent dispatches \(2\)/.test(err.message),
    );
    exec.release();
    await Promise.all([r1.completion, r2.completion]);
    // Slots freed — third dispatch now proceeds.
    const r3 = dispatch.dispatchTask(c.id, { agent: "dev" });
    exec.release();
    await r3.completion;
  });

  it("refuses remote node targeting (v1 is local-only)", () => {
    const exec = makeExecFn();
    const dispatch = makeDispatch({ kanban, execFn: exec.fn });
    const task = kanban.createTask({ title: "T" }, "op");
    assert.throws(
      () => dispatch.dispatchTask(task.id, { agent: "dev", node: "other-node" }),
      (err) => err.statusCode === 400 && /remote dispatch not yet supported/.test(err.message),
    );
    assert.strictEqual(exec.calls.length, 0);
  });

  it("accepts node targeting when it names this node", async () => {
    const exec = makeExecFn();
    const dispatch = makeDispatch({ kanban, execFn: exec.fn });
    const task = kanban.createTask({ title: "T" }, "op");
    const result = dispatch.dispatchTask(task.id, { agent: "dev", node: "test-node" });
    exec.release();
    await result.completion;
  });

  it("503s when disabled via config", () => {
    const exec = makeExecFn();
    const dispatch = makeDispatch({ kanban, execFn: exec.fn, config: { enabled: false } });
    const task = kanban.createTask({ title: "T" }, "op");
    assert.throws(
      () => dispatch.dispatchTask(task.id, { agent: "dev" }),
      (err) => err.statusCode === 503 && /disabled/.test(err.message),
    );
  });

  it("404s unknown tasks and 400s a missing agent", () => {
    const exec = makeExecFn();
    const dispatch = makeDispatch({ kanban, execFn: exec.fn });
    assert.throws(
      () => dispatch.dispatchTask("tsk_ffffff", { agent: "dev" }),
      (err) => err.statusCode === 404,
    );
    const task = kanban.createTask({ title: "T" }, "op");
    assert.throws(
      () => dispatch.dispatchTask(task.id, { agent: "  " }),
      (err) => err.statusCode === 400,
    );
  });
});

describe("previewDispatch / getStatus", () => {
  it("preview returns the composed message without side effects", () => {
    const kanban = freshKanban();
    const exec = makeExecFn();
    const dispatch = makeDispatch({ kanban, execFn: exec.fn });
    const task = kanban.createTask({ title: "Preview me" }, "op");
    const preview = dispatch.previewDispatch(task.id, { agent: "dev" });
    assert.strictEqual(preview.taskId, task.id);
    assert.strictEqual(preview.agent, "dev");
    assert.match(preview.message, /Preview me/);
    assert.strictEqual(exec.calls.length, 0);
    const after = kanban.getBoard().tasks.find((t) => t.id === task.id);
    assert.strictEqual(after.attempts.length, 0);
    assert.strictEqual(after.comments.length, 0);
    assert.strictEqual(after.status, "inbox");
  });

  it("getStatus reports availability, cap, and the open dispatch count", async () => {
    const kanban = freshKanban();
    const exec = makeExecFn();
    const dispatch = makeDispatch({ kanban, execFn: exec.fn, config: { maxConcurrent: 5 } });
    assert.deepStrictEqual(dispatch.getStatus(), {
      available: true,
      enabled: true,
      node: "test-node",
      maxConcurrent: 5,
      openCount: 0,
    });
    const task = kanban.createTask({ title: "T" }, "op");
    const result = dispatch.dispatchTask(task.id, { agent: "dev" });
    assert.strictEqual(dispatch.getStatus().openCount, 1);
    exec.release();
    await result.completion;
    assert.strictEqual(dispatch.getStatus().openCount, 0);
  });
});

describe("helpers", () => {
  it("isOpenDispatchAttempt respects note prefix, ended_at, and the TTL window", () => {
    const now = Date.now();
    const fresh = {
      note: "dispatched",
      ended_at: null,
      started_at: new Date(now - 1000).toISOString(),
    };
    const closed = { ...fresh, ended_at: new Date(now).toISOString() };
    const foreign = { ...fresh, note: "manual run" };
    const ancient = { ...fresh, started_at: new Date(now - 999999999).toISOString() };
    assert.strictEqual(isOpenDispatchAttempt(fresh, now, 60000), true);
    assert.strictEqual(isOpenDispatchAttempt(closed, now, 60000), false);
    assert.strictEqual(isOpenDispatchAttempt(foreign, now, 60000), false);
    assert.strictEqual(isOpenDispatchAttempt(ancient, now, 60000), false);
  });

  it("resolveBinary finds executables on a PATH and misses absent ones", () => {
    const binDir = path.join(tmpRoot, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const bin = path.join(binDir, "fake-openclaw");
    fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
    assert.strictEqual(resolveBinary("fake-openclaw", binDir), bin);
    assert.strictEqual(resolveBinary("definitely-not-here", binDir), null);
  });
});
