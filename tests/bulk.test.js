/**
 * Unit tests for src/bulk.js — fake mesh / chat / dispatch / runAction /
 * fetchFn throughout: no network, no CLI, no real agents.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createBulk, BULK_ACTIONS, MAX_TARGETS } = require("../src/bulk");

const NODE_A = {
  id: "node-a",
  hostname: "alpha",
  port: 443,
  healthPath: "/health",
  url: "https://alpha.ts.net/health",
};
const NODE_B = {
  id: "node-b",
  hostname: "beta",
  port: 3333,
  healthPath: "/health",
  url: "https://beta.ts.net:3333/health",
};

function makeMesh(nodes = [NODE_A, NODE_B]) {
  return { getState: async () => ({ nodes }) };
}

function makeChat() {
  const published = [];
  return {
    published,
    publish: (msg) => {
      if (typeof msg.payload !== "string" || msg.payload.length === 0) {
        throw new TypeError("payload must be a string");
      }
      const record = { id: `msg_${published.length + 1}`, ...msg };
      published.push(record);
      return record;
    },
  };
}

function makeDispatch() {
  const dispatched = [];
  return {
    dispatched,
    dispatchTask: (taskId, opts) => {
      if (opts.agent === "busy-agent") {
        const err = new Error("Task already has an open dispatched attempt");
        err.statusCode = 409;
        throw err;
      }
      dispatched.push({ taskId, ...opts });
      return { sessionKey: `agent:${opts.agent}:kanban-${taskId}-1` };
    },
  };
}

/** fetchFn fake keyed by URL substring. */
function makeFetch(routes = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    for (const [needle, responder] of Object.entries(routes)) {
      if (url.includes(needle)) return responder(url);
    }
    throw new Error(`connect ECONNREFUSED ${url}`);
  };
  return { fn, calls };
}

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function makeBulk(overrides = {}) {
  const chat = overrides.chat || makeChat();
  const dispatch = "dispatch" in overrides ? overrides.dispatch : makeDispatch();
  const runCalls = [];
  const bulk = createBulk({
    mesh: overrides.mesh || makeMesh(),
    chat,
    dispatch,
    rosterFn:
      "rosterFn" in overrides
        ? overrides.rosterFn
        : async () => ({ agents: [{ id: "main" }, { id: "worker" }, { id: "busy-agent" }] }),
    runAction:
      overrides.runAction ||
      (async (name, opts) => {
        runCalls.push({ name, opts });
        return { success: true, output: `${name} ok`, detail: {} };
      }),
    fetchFn: overrides.fetchFn || makeFetch().fn,
  });
  return { bulk, chat, dispatch, runCalls };
}

describe("bulk module", () => {
  describe("validation", () => {
    it("rejects unknown actions with a 400 statusCode", async () => {
      const { bulk } = makeBulk();
      await assert.rejects(
        () => bulk.execute({ action: "rm-rf", targets: ["local"] }),
        (err) => err.statusCode === 400 && /Unknown bulk action/.test(err.message),
      );
    });

    it("rejects non-string targets", async () => {
      const { bulk } = makeBulk();
      await assert.rejects(
        () => bulk.execute({ action: "health-check", targets: [42] }),
        (err) => err.statusCode === 400,
      );
    });

    it("caps the target list", async () => {
      const { bulk } = makeBulk();
      const targets = Array.from({ length: MAX_TARGETS + 1 }, (_, i) => `n${i}`);
      await assert.rejects(
        () => bulk.execute({ action: "health-check", targets }),
        (err) => err.statusCode === 400 && /Too many targets/.test(err.message),
      );
    });

    it("requires params.taskId for dispatch-task", async () => {
      const { bulk } = makeBulk();
      await assert.rejects(
        () => bulk.execute({ action: "dispatch-task", targets: ["main"], params: {} }),
        (err) => err.statusCode === 400 && /taskId/.test(err.message),
      );
    });

    it("requires at least one agent target for dispatch-task", async () => {
      const { bulk } = makeBulk();
      await assert.rejects(
        () => bulk.execute({ action: "dispatch-task", targets: [], params: { taskId: "t1" } }),
        (err) => err.statusCode === 400,
      );
    });

    it("requires non-empty text for chat-broadcast", async () => {
      const { bulk } = makeBulk();
      await assert.rejects(
        () => bulk.execute({ action: "chat-broadcast", targets: ["all"], params: { text: " " } }),
        (err) => err.statusCode === 400,
      );
    });

    it("exposes the supported action list", () => {
      assert.deepStrictEqual(BULK_ACTIONS, [
        "kill-stale-sessions",
        "health-check",
        "gateway-status",
        "dispatch-task",
        "chat-broadcast",
      ]);
    });
  });

  describe("node-targeted actions", () => {
    it("health-check defaults to the local node and uses the quick-action runner", async () => {
      const { bulk, runCalls } = makeBulk();
      const report = await bulk.execute({ action: "health-check" });
      assert.deepStrictEqual(report.targets, ["local"]);
      assert.strictEqual(report.results.length, 1);
      assert.strictEqual(report.results[0].ok, true);
      assert.strictEqual(runCalls[0].name, "health-check");
    });

    it("health-check fans out to mesh nodes' /health endpoints", async () => {
      const fetch = makeFetch({
        "alpha.ts.net/health": () => jsonResponse({ status: "ok", version: "2.1.0" }),
        "beta.ts.net:3333/health": () => jsonResponse({}, false, 503),
      });
      const { bulk } = makeBulk({ fetchFn: fetch.fn });
      const report = await bulk.execute({
        action: "health-check",
        targets: ["node-a", "node-b"],
      });
      assert.strictEqual(report.okCount, 1);
      assert.strictEqual(report.failCount, 1);
      const a = report.results.find((r) => r.target === "node-a");
      const b = report.results.find((r) => r.target === "node-b");
      assert.strictEqual(a.ok, true);
      assert.ok(a.detail.includes("healthy"));
      assert.ok(a.detail.includes("v2.1.0"));
      assert.strictEqual(b.ok, false);
      assert.ok(b.detail.includes("503"));
    });

    it("gateway-status proxies remote nodes through /api/action", async () => {
      const fetch = makeFetch({
        "alpha.ts.net/api/action?action=gateway-status": () =>
          jsonResponse({ success: true, output: "Gateway reachable, port 18789" }),
      });
      const { bulk } = makeBulk({ fetchFn: fetch.fn });
      const report = await bulk.execute({ action: "gateway-status", targets: ["node-a"] });
      assert.strictEqual(report.results[0].ok, true);
      assert.ok(report.results[0].detail.includes("18789"));
      assert.ok(fetch.calls[0].startsWith("https://alpha.ts.net/api/action"));
    });

    it("kill-stale-sessions runs the clear-stale quick action locally with staleMinutes", async () => {
      const { bulk, runCalls } = makeBulk();
      const report = await bulk.execute({
        action: "kill-stale-sessions",
        targets: ["local"],
        params: { staleMinutes: 120 },
      });
      assert.strictEqual(report.results[0].ok, true);
      assert.strictEqual(runCalls[0].name, "clear-stale-sessions");
      assert.strictEqual(runCalls[0].opts.staleMinutes, 120);
    });

    it("kill-stale-sessions proxies remote nodes through /api/action", async () => {
      const fetch = makeFetch({
        "beta.ts.net:3333/api/action?action=clear-stale-sessions": () =>
          jsonResponse({ success: true, output: "Cleanup done: 3 session entries removed" }),
      });
      const { bulk } = makeBulk({ fetchFn: fetch.fn });
      const report = await bulk.execute({ action: "kill-stale-sessions", targets: ["node-b"] });
      assert.strictEqual(report.results[0].ok, true);
      assert.ok(report.results[0].detail.includes("Cleanup done"));
    });

    it("matches targets by hostname as well as id", async () => {
      const fetch = makeFetch({
        "alpha.ts.net/health": () => jsonResponse({ status: "ok" }),
      });
      const { bulk } = makeBulk({ fetchFn: fetch.fn });
      const report = await bulk.execute({ action: "health-check", targets: ["alpha"] });
      assert.strictEqual(report.results[0].ok, true);
    });

    it("unknown nodes fail their own entry without aborting the rest", async () => {
      const fetch = makeFetch({
        "alpha.ts.net/health": () => jsonResponse({ status: "ok" }),
      });
      const { bulk } = makeBulk({ fetchFn: fetch.fn });
      const report = await bulk.execute({
        action: "health-check",
        targets: ["ghost-node", "node-a"],
      });
      assert.strictEqual(report.okCount, 1);
      const ghost = report.results.find((r) => r.target === "ghost-node");
      assert.strictEqual(ghost.ok, false);
      assert.ok(ghost.detail.includes("Unknown node"));
    });

    it("network failures are captured per-target", async () => {
      const { bulk } = makeBulk({ fetchFn: makeFetch({}).fn });
      const report = await bulk.execute({ action: "health-check", targets: ["node-a"] });
      assert.strictEqual(report.results[0].ok, false);
      assert.ok(report.results[0].detail.includes("ECONNREFUSED"));
    });
  });

  describe("dispatch-task", () => {
    it("fans the same task to multiple agents via the dispatch runtime", async () => {
      const { bulk, dispatch } = makeBulk();
      const report = await bulk.execute({
        action: "dispatch-task",
        targets: ["main", "worker"],
        params: { taskId: "task_1" },
        actor: "ops@example.com",
      });
      assert.strictEqual(report.okCount, 2);
      assert.strictEqual(dispatch.dispatched.length, 2);
      assert.strictEqual(dispatch.dispatched[0].actor, "ops@example.com");
      assert.ok(report.results[0].detail.includes("session key"));
    });

    it("a 409 from one agent never aborts the others", async () => {
      const { bulk } = makeBulk();
      const report = await bulk.execute({
        action: "dispatch-task",
        targets: ["busy-agent", "main"],
        params: { taskId: "task_1" },
      });
      assert.strictEqual(report.okCount, 1);
      assert.strictEqual(report.failCount, 1);
      const busy = report.results.find((r) => r.target === "busy-agent");
      assert.ok(busy.detail.includes("open dispatched attempt"));
    });

    it("fails closed for agents missing from the roster", async () => {
      const { bulk, dispatch } = makeBulk();
      const report = await bulk.execute({
        action: "dispatch-task",
        targets: ["intruder"],
        params: { taskId: "task_1" },
      });
      assert.strictEqual(report.results[0].ok, false);
      assert.ok(report.results[0].detail.includes("not in the local roster"));
      assert.strictEqual(dispatch.dispatched.length, 0);
    });

    it("responds cleanly when dispatch is not configured", async () => {
      const { bulk } = makeBulk({ dispatch: null });
      const report = await bulk.execute({
        action: "dispatch-task",
        targets: ["main"],
        params: { taskId: "task_1" },
      });
      assert.strictEqual(report.results[0].ok, false);
      assert.ok(report.results[0].detail.includes("not configured"));
    });
  });

  describe("chat-broadcast", () => {
    it("publishes one message per receiver, attributed to the actor", async () => {
      const { bulk, chat } = makeBulk();
      const report = await bulk.execute({
        action: "chat-broadcast",
        targets: ["main", "worker"],
        params: { text: "fleet maintenance at 09:00 UTC" },
        actor: "ops@example.com",
      });
      assert.strictEqual(report.okCount, 2);
      assert.strictEqual(chat.published.length, 2);
      assert.strictEqual(chat.published[0].sender, "ops@example.com");
      assert.strictEqual(chat.published[0].receiver, "main");
      assert.strictEqual(chat.published[0].payload, "fleet maintenance at 09:00 UTC");
    });

    it("defaults to a single broadcast to 'all'", async () => {
      const { bulk, chat } = makeBulk();
      const report = await bulk.execute({
        action: "chat-broadcast",
        params: { text: "hello fleet" },
      });
      assert.deepStrictEqual(report.targets, ["all"]);
      assert.strictEqual(chat.published[0].receiver, "all");
    });

    it("honors an explicit sender param", async () => {
      const { bulk, chat } = makeBulk();
      await bulk.execute({
        action: "chat-broadcast",
        targets: ["main"],
        params: { text: "hi", sender: "control-tower" },
        actor: "ops@example.com",
      });
      assert.strictEqual(chat.published[0].sender, "control-tower");
    });
  });
});
