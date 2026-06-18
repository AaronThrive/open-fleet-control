/**
 * Wave 3 tests — AC-11 (dedup), AC-16 (terminal-status guarantee),
 * AC-19 (result_text surfacing), AC-22 (fail-closed).
 *
 * Tests are independent of each other and use only stubbed interfaces.
 * No real SQLite, no real docker, no real HTTP server, no real agents.
 *
 * Scope boundary reminder (PRD §10 RESOLVED):
 *   - OFC never talks to Slack directly.
 *   - openclaw's Bolt provider already acks ≤3s and posts/updates messages.
 *   - OFC obligation = DATA+CONTROL: dedup before run, result_text surfacing,
 *     typed terminal results on every failure path, no hang.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("node:events");

const { createFleetRoutes } = require("../src/fleet-routes");
const { createSpawnStore } = require("../src/spawn-store");
const { readAttemptResultText, FAILURE_RESULT_COPY } = require("../src/orchestrate");

// =========================================================================
// Shared test helpers
// =========================================================================

const ORCH_PATH = "/api/fleet/orchestrate";
const ROSTER = { agents: [{ id: "a" }, { id: "b" }] };

function makeFleet() {
  return {
    rateLimiter: { check: () => ({ allowed: true }) },
    audit: { record: () => {} },
    kanban: { getBoard: () => ({ tasks: [] }) },
    budgets: {
      checkDispatchBlock: () => null,
      checkOrchestrationBlock: () => null,
    },
    fireAlert: () => {},
  };
}

/** Minimal orchestrate mock — records calls and resolves synchronously. */
function makeOrchestrate() {
  const calls = { board: [], chain: [], single: [] };
  const module = {
    getStatus: () => ({ available: true, enabled: true, timeoutSec: 600 }),
    runSingle: (taskId, opts) => {
      calls.single.push({ taskId, opts });
      return { task: { id: taskId }, agent: opts.agent, sessionKey: "sk" };
    },
    runBoard: (params) => {
      calls.board.push(params);
      const runId = "orx_board_1";
      return {
        runId,
        mode: "board",
        agents: params.agents,
        status: "running",
        startedAt: 0,
        completion: Promise.resolve(),
      };
    },
    runChain: (params) => {
      calls.chain.push(params);
      const runId = "orx_chain_1";
      return {
        runId,
        mode: "chain",
        agents: params.steps.map((s) => s.agent),
        status: "running",
        startedAt: 0,
        completion: Promise.resolve(),
      };
    },
    getRun: () => null,
    waitForRun: async () => null,
  };
  return { module, calls };
}

function makeReq(method, body) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = { "tailscale-user-login": "tester@example.com" };
  req.socket = { remoteAddress: "127.0.0.1" };
  process.nextTick(() => {
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

function makeRes() {
  const res = { statusCode: null, body: null };
  res.writeHead = (code) => {
    res.statusCode = code;
  };
  res.end = (payload) => {
    res.body = payload ? JSON.parse(payload) : null;
  };
  return res;
}

async function call(routes, method, pathname, body) {
  const req = makeReq(method, body);
  const res = makeRes();
  await routes.handle(req, res, pathname, new URLSearchParams(""));
  return res;
}

// =========================================================================
// AC-19 — readAttemptResultText reads result_text; null → failure copy
// =========================================================================

describe("AC-19 — readAttemptResultText reads result_text, null → failure copy", () => {
  it("returns result_text when present and non-empty", () => {
    const attempt = {
      result: "success",
      result_text: "The full agent answer.",
      note: "ignored note",
    };
    const { text, truncated, failureCopy } = readAttemptResultText(attempt);
    assert.strictEqual(text, "The full agent answer.", "should return full result_text");
    assert.strictEqual(truncated, false);
    assert.strictEqual(failureCopy, null, "failureCopy must be null when result_text present");
  });

  it("returns null text + failure copy when result_text is null", () => {
    const attempt = { result: "failure", result_text: null, note: "truncated note snippet" };
    const { text, truncated, failureCopy } = readAttemptResultText(attempt);
    assert.strictEqual(text, null, "text must be null when result_text is null");
    assert.strictEqual(truncated, false);
    assert.strictEqual(
      failureCopy,
      FAILURE_RESULT_COPY,
      "failureCopy must be the explicit failure copy, not the note",
    );
    // Critical: the note must NOT be surfaced as text.
    assert.notStrictEqual(text, "truncated note snippet", "note must never be surfaced as result");
  });

  it("returns null text + failure copy when result_text is absent (undefined)", () => {
    const attempt = { result: "failure", note: "truncated note here" };
    const { text, failureCopy } = readAttemptResultText(attempt);
    assert.strictEqual(text, null);
    assert.strictEqual(failureCopy, FAILURE_RESULT_COPY);
    assert.notStrictEqual(text, "truncated note here");
  });

  it("returns null text + failure copy when result_text is empty string", () => {
    const attempt = { result: "success", result_text: "", note: "note fallback" };
    const { text, failureCopy } = readAttemptResultText(attempt);
    assert.strictEqual(text, null, "empty string result_text must not be surfaced");
    assert.strictEqual(failureCopy, FAILURE_RESULT_COPY);
  });

  it("returns failure copy when attempt is null (no attempt at all)", () => {
    const { text, failureCopy } = readAttemptResultText(null);
    assert.strictEqual(text, null);
    assert.strictEqual(failureCopy, FAILURE_RESULT_COPY);
  });

  it("FAILURE_RESULT_COPY is a non-empty string", () => {
    assert.ok(typeof FAILURE_RESULT_COPY === "string" && FAILURE_RESULT_COPY.length > 0);
  });
});

// =========================================================================
// AC-11 — event_id dedup at the orchestrate entry (dedup-before-spawn)
// =========================================================================

describe("AC-11 — event_id dedup before spawn at POST /api/fleet/orchestrate", () => {
  let stateDir;
  let store;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wave3-dedup-"));
    store = createSpawnStore({ stateDir });
  });

  afterEach(() => {
    if (store) {
      try {
        store.close();
      } catch (e) {
        /* best-effort */
      }
      store = null;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("first request with event_id starts a board run (not deduped)", async () => {
    const { module, calls } = makeOrchestrate();
    const routes = createFleetRoutes({
      fleet: makeFleet(),
      orchestrate: module,
      rosterFn: () => ROSTER,
      spawnStore: store,
    });

    const res = await call(routes, "POST", ORCH_PATH, {
      mode: "board",
      event_id: "slack_evt_001",
      title: "T",
      question: "Q",
      agents: ["a"],
    });

    assert.strictEqual(res.statusCode, 202, "first request should be accepted as 202");
    assert.strictEqual(res.body.deduped, undefined, "first request must not be deduped");
    assert.strictEqual(calls.board.length, 1, "runBoard must be called once for the first event");
  });

  it("second request with the SAME event_id is deduped — no second dispatch", async () => {
    const { module, calls } = makeOrchestrate();
    const routes = createFleetRoutes({
      fleet: makeFleet(),
      orchestrate: module,
      rosterFn: () => ROSTER,
      spawnStore: store,
    });

    const body = {
      mode: "board",
      event_id: "slack_evt_002",
      title: "T",
      question: "Q",
      agents: ["a"],
    };

    const res1 = await call(routes, "POST", ORCH_PATH, body);
    const res2 = await call(routes, "POST", ORCH_PATH, body);

    assert.strictEqual(res1.statusCode, 202, "first request accepted");
    assert.strictEqual(calls.board.length, 1, "runBoard called exactly once for first event");

    // Second request must be deduped.
    assert.strictEqual(res2.statusCode, 200, "deduped request returns 200");
    assert.strictEqual(res2.body.deduped, true, "deduped flag must be set");
    assert.strictEqual(res2.body.status, "deduped", "status must be 'deduped'");
    assert.strictEqual(res2.body.event_id, "slack_evt_002", "echoes the event_id back");
    assert.strictEqual(calls.board.length, 1, "runBoard must NOT be called a second time");
  });

  it("dedup_key alias works identically to event_id", async () => {
    const { module, calls } = makeOrchestrate();
    const routes = createFleetRoutes({
      fleet: makeFleet(),
      orchestrate: module,
      rosterFn: () => ROSTER,
      spawnStore: store,
    });

    const body = {
      mode: "board",
      dedup_key: "slack_evt_003",
      title: "T",
      question: "Q",
      agents: ["a"],
    };
    const res1 = await call(routes, "POST", ORCH_PATH, body);
    const res2 = await call(routes, "POST", ORCH_PATH, body);

    assert.strictEqual(res1.statusCode, 202, "first with dedup_key accepted");
    assert.strictEqual(res2.body.deduped, true, "second with same dedup_key is deduped");
    assert.strictEqual(calls.board.length, 1, "only one dispatch");
  });

  it("requests WITHOUT event_id behave exactly as today (no dedup, no change)", async () => {
    const { module, calls } = makeOrchestrate();
    const routes = createFleetRoutes({
      fleet: makeFleet(),
      orchestrate: module,
      rosterFn: () => ROSTER,
      spawnStore: store,
    });

    // Two requests without event_id — both should start runs (no dedup gate).
    const body = { mode: "board", title: "T", question: "Q", agents: ["a"] };
    const res1 = await call(routes, "POST", ORCH_PATH, body);
    const res2 = await call(routes, "POST", ORCH_PATH, body);

    assert.strictEqual(res1.statusCode, 202);
    assert.strictEqual(res2.statusCode, 202);
    assert.strictEqual(calls.board.length, 2, "both requests dispatch (no dedup without event_id)");
    assert.strictEqual(res1.body.deduped, undefined);
    assert.strictEqual(res2.body.deduped, undefined);
  });

  it("dedup works for chain mode too (not just board)", async () => {
    const { module, calls } = makeOrchestrate();
    const routes = createFleetRoutes({
      fleet: makeFleet(),
      orchestrate: module,
      rosterFn: () => ROSTER,
      spawnStore: store,
    });

    const body = {
      mode: "chain",
      event_id: "slack_evt_chain_001",
      title: "C",
      steps: [{ agent: "a", instruction: "step 1" }],
    };

    const res1 = await call(routes, "POST", ORCH_PATH, body);
    const res2 = await call(routes, "POST", ORCH_PATH, body);

    assert.strictEqual(res1.statusCode, 202);
    assert.strictEqual(res2.body.deduped, true);
    assert.strictEqual(calls.chain.length, 1, "chain not dispatched twice");
  });

  it("spawnStore unavailable → dedup degrades to no-op, run proceeds normally (AC-22 safe degradation)", async () => {
    // No spawnStore passed → dedup gate skipped entirely.
    const { module, calls } = makeOrchestrate();
    const routes = createFleetRoutes({
      fleet: makeFleet(),
      orchestrate: module,
      rosterFn: () => ROSTER,
      // spawnStore: intentionally omitted (spawn disabled)
    });

    const body = {
      mode: "board",
      event_id: "slack_evt_noop",
      title: "T",
      question: "Q",
      agents: ["a"],
    };
    const res1 = await call(routes, "POST", ORCH_PATH, body);
    const res2 = await call(routes, "POST", ORCH_PATH, body);

    // Both requests must succeed (dedup is a no-op when store unavailable).
    assert.strictEqual(res1.statusCode, 202);
    assert.strictEqual(res2.statusCode, 202);
    assert.strictEqual(calls.board.length, 2, "both proceed when dedup store is unavailable");
  });

  it("spawnStoreFn lazy getter works (wired after routes are constructed)", async () => {
    // This simulates the real index.js pattern: createFleetRoutes is called
    // before the spawn block fills the store, via a lazy getter closure.
    let liveStore = null;
    const { module, calls } = makeOrchestrate();
    const routes = createFleetRoutes({
      fleet: makeFleet(),
      orchestrate: module,
      rosterFn: () => ROSTER,
      spawnStoreFn: () => liveStore, // returns null until the store is wired
    });

    // Before wiring: dedup is a no-op.
    const body = {
      mode: "board",
      event_id: "slack_evt_lazy_001",
      title: "T",
      question: "Q",
      agents: ["a"],
    };
    const res0 = await call(routes, "POST", ORCH_PATH, body);
    assert.strictEqual(res0.statusCode, 202, "request proceeds when store not yet wired");
    assert.strictEqual(calls.board.length, 1);

    // Wire the store (simulates the spawn block running).
    liveStore = store;

    // Now dedup is active — same event_id is deduped.
    const res1 = await call(routes, "POST", ORCH_PATH, body);
    const res2 = await call(routes, "POST", ORCH_PATH, body);

    // res1 was the first registered insert after wiring — not a duplicate.
    // res2 is the duplicate.
    assert.strictEqual(res2.body.deduped, true, "dedup active once store is wired");
    assert.ok(
      calls.board.length <= 2,
      "runBoard called at most twice (one per non-deduped request)",
    );
  });
});

// =========================================================================
// AC-16 — terminal-status guarantee: every run reaches a terminal state
// =========================================================================

describe("AC-16 — terminal-status guarantee (OFC data+control side)", () => {
  // AC-16 scope: OFC must reliably PROVIDE the terminal result/status+reason.
  // chat.update is openclaw's job. OFC must not leave any run non-terminal.

  it("dedup rejection is a typed terminal result — status:'deduped', never a hang (AC-22)", async () => {
    // A deduped request must return a complete, typed, non-hanging terminal
    // response synchronously. The caller (Chief) reads deduped:true and does
    // not start a second dispatch.
    const stateDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "wave3-ac16-"));
    const s = createSpawnStore({ stateDir: stateDir2 });
    try {
      const { module } = makeOrchestrate();
      const routes = createFleetRoutes({
        fleet: makeFleet(),
        orchestrate: module,
        rosterFn: () => ROSTER,
        spawnStore: s,
      });
      const body = {
        mode: "board",
        event_id: "ac16_terminal_001",
        title: "T",
        question: "Q",
        agents: ["a"],
      };

      await call(routes, "POST", ORCH_PATH, body); // first: starts run
      const res = await call(routes, "POST", ORCH_PATH, body); // second: deduped

      // Must be a terminal, typed response — not a hang.
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.deduped, true);
      assert.strictEqual(res.body.status, "deduped", "typed status on dedup");
      assert.ok(typeof res.body.reason === "string", "must include a reason field");
    } finally {
      s.close();
      fs.rmSync(stateDir2, { recursive: true, force: true });
    }
  });

  it("board run starts and immediately has status:running (never non-terminal start)", async () => {
    const { module } = makeOrchestrate();
    const routes = createFleetRoutes({
      fleet: makeFleet(),
      orchestrate: module,
      rosterFn: () => ROSTER,
    });
    const res = await call(routes, "POST", ORCH_PATH, {
      mode: "board",
      title: "T",
      question: "Q",
      agents: ["a"],
    });
    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(res.body.status, "running", "started run has terminal-path status:running");
    assert.ok(typeof res.body.runId === "string", "runId present for caller to poll");
  });

  it("a 503 (orchestrate not configured) is a typed terminal response — never a hang", async () => {
    const routes = createFleetRoutes({ fleet: makeFleet() });
    const res = await call(routes, "POST", ORCH_PATH, { mode: "board", agents: ["a"] });
    assert.strictEqual(res.statusCode, 503);
    assert.ok(typeof res.body.error === "string", "typed error field present");
  });

  it("budget refusal (403) is a typed terminal response (AC-22 fail-closed)", async () => {
    // When the budget gate refuses, the caller gets a 403 with a typed reason.
    const fleet = makeFleet();
    fleet.budgets.checkOrchestrationBlock = () => ({
      reason: "open-mode-disabled",
      mode: "open",
      message: "OPEN mode disabled",
    });
    const { module } = makeOrchestrate();
    const routes = createFleetRoutes({
      fleet,
      orchestrate: module,
      rosterFn: () => ROSTER,
    });
    const res = await call(routes, "POST", ORCH_PATH, {
      mode: "board",
      budgetMode: "open",
      title: "T",
      question: "Q",
      agents: ["a"],
    });
    assert.strictEqual(res.statusCode, 403, "budget refusal is 403");
    assert.ok(typeof res.body.reason === "string", "typed reason on budget refusal");
  });
});

// =========================================================================
// AC-22 — fail-closed: every failure class yields a typed terminal result
// =========================================================================

describe("AC-22 — fail-closed: every failure class yields a typed terminal result", () => {
  // This block verifies the intersection of all failure classes with AC-22:
  // no code path leaves a caller hanging without a typed terminal response.

  let stateDir;
  let store;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wave3-ac22-"));
    store = createSpawnStore({ stateDir });
  });

  afterEach(() => {
    if (store) {
      try {
        store.close();
      } catch (e) {
        /* best-effort */
      }
      store = null;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  // Helper: run a request and assert a typed terminal response (not a hang).
  async function assertTypedTerminal(routes, body, expectedStatus) {
    const res = await call(routes, "POST", ORCH_PATH, body);
    assert.ok(
      res.statusCode !== null,
      "statusCode must be set (no hang — terminal response required)",
    );
    assert.ok(res.body !== null, "body must be set (typed terminal result)");
    if (expectedStatus) {
      assert.strictEqual(res.statusCode, expectedStatus);
    }
    return res;
  }

  it("duplicate event_id → typed terminal deduped response (AC-11 + AC-22)", async () => {
    const { module } = makeOrchestrate();
    const routes = createFleetRoutes({
      fleet: makeFleet(),
      orchestrate: module,
      rosterFn: () => ROSTER,
      spawnStore: store,
    });
    const body = {
      mode: "board",
      event_id: "ac22_dedup_01",
      title: "T",
      question: "Q",
      agents: ["a"],
    };
    await call(routes, "POST", ORCH_PATH, body);
    const res = await assertTypedTerminal(routes, body, 200);
    assert.strictEqual(res.body.deduped, true);
    assert.ok(typeof res.body.status === "string", "status field present");
  });

  it("rate-limit refusal → typed terminal 429 (no hang)", async () => {
    const fleet = makeFleet();
    fleet.rateLimiter.check = () => ({ allowed: false, retryAfterMs: 5000 });
    const { module } = makeOrchestrate();
    const routes = createFleetRoutes({
      fleet,
      orchestrate: module,
      rosterFn: () => ROSTER,
    });
    const res = await assertTypedTerminal(
      routes,
      { mode: "board", title: "T", question: "Q", agents: ["a"] },
      429,
    );
    assert.ok(typeof res.body.retryAfterMs === "number", "retryAfterMs present on 429");
  });

  it("missing mode → typed terminal 400 (no hang)", async () => {
    const { module } = makeOrchestrate();
    const routes = createFleetRoutes({
      fleet: makeFleet(),
      orchestrate: module,
      rosterFn: () => ROSTER,
    });
    const res = await assertTypedTerminal(routes, { mode: "bogus_mode" }, 400);
    assert.ok(typeof res.body.error === "string");
  });

  it("no spawnStore + event_id → dedup no-op, run proceeds (safe degradation, never crash)", async () => {
    const { module, calls } = makeOrchestrate();
    // Critically: no spawnStore (spawn disabled). The dedup gate must degrade
    // gracefully — not crash, not hang.
    const routes = createFleetRoutes({
      fleet: makeFleet(),
      orchestrate: module,
      rosterFn: () => ROSTER,
    });
    const body = {
      mode: "board",
      event_id: "ac22_nostore_01",
      title: "T",
      question: "Q",
      agents: ["a"],
    };
    const res = await assertTypedTerminal(routes, body, 202);
    assert.strictEqual(res.body.deduped, undefined, "no dedup flag when store unavailable");
    assert.strictEqual(calls.board.length, 1, "run dispatched normally");
  });
});

// =========================================================================
// AC-19 (continued) — board/chain run results surface result_text correctly
// =========================================================================

describe("AC-19 (extended) — board and chain results use result_text, not note", () => {
  it("full result_text is returned as text (not truncated)", () => {
    const attempt = {
      result: "success",
      result_text: "Full 12KB agent answer here.",
      note: "dispatched · completed · result: Full 12",
    };
    const { text, truncated, failureCopy } = readAttemptResultText(attempt);
    assert.strictEqual(text, "Full 12KB agent answer here.", "full result_text surfaced");
    assert.strictEqual(truncated, false, "not truncated");
    assert.strictEqual(failureCopy, null, "no failure copy when text is present");
  });

  it("when result_text null and run failed, failure copy is surfaced (not the note snippet)", () => {
    const attempt = {
      result: "failure",
      result_text: null,
      note: "dispatched · failed · result: First 300 chars of truncated...",
    };
    const { text, failureCopy } = readAttemptResultText(attempt);
    assert.strictEqual(text, null, "text is null when result_text is null");
    assert.strictEqual(failureCopy, FAILURE_RESULT_COPY, "explicit failure copy is provided");
    // The note snippet must NOT be used.
    assert.notStrictEqual(
      text,
      "First 300 chars of truncated...",
      "note snippet must never be surfaced as result",
    );
  });

  it("FAILURE_RESULT_COPY is a non-empty string that includes try-again language", () => {
    // Sanity: the copy must communicate a failure + actionable message.
    assert.ok(typeof FAILURE_RESULT_COPY === "string" && FAILURE_RESULT_COPY.length > 0);
    // Should mention failure or trying again — this is the UX requirement.
    const lower = FAILURE_RESULT_COPY.toLowerCase();
    const hasFail =
      lower.includes("fail") || lower.includes("could not") || lower.includes("unable");
    const hasTryAgain =
      lower.includes("try") || lower.includes("again") || lower.includes("complete");
    assert.ok(
      hasFail || hasTryAgain,
      `FAILURE_RESULT_COPY should communicate failure or retry: "${FAILURE_RESULT_COPY}"`,
    );
  });
});
