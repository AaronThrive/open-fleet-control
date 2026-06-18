/**
 * AC-18 — `maxConcurrent` raised in lockstep with the spawn pool size.
 *
 * The dispatch core (src/dispatch.js) enforces a board-wide open-attempt cap:
 * once `countOpenDispatches(board) >= maxConcurrent`, the next dispatchTask
 * throws 429. A PARALLEL board of K seats opens K dispatches at once, so a cap
 * below K makes the later seats 429. AC-17 flips boards to parallel (fanning
 * each seat to its own isolated remote worker) ONLY when the pool is enabled;
 * AC-18 is the gate that proves the 429 linkage BOTH directions so the parallel
 * flip is safe.
 *
 * This file proves:
 *   1. The relationship is explicit + configured: `resolveDispatchConcurrency`
 *      raises maxConcurrent to >= poolCeiling when spawn is enabled, and leaves
 *      it untouched when spawn is disabled (pure-helper, both directions).
 *   2. END-TO-END against the REAL dispatch core: a parallel board of 6 seats
 *      with maxConcurrent raised to the pool ceiling (6) → ZERO 429s; the same
 *      6-seat parallel fan-out with maxConcurrent BELOW the seat count → 429s
 *      reproduced (proving the cap is the chokepoint the lockstep raise lifts).
 *
 * No real agent is ever invoked — execFn is a controllable gate so all six
 * dispatches stay OPEN simultaneously (the only state in which the cap bites).
 */

const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createKanban } = require("../src/kanban");
const { createDispatch } = require("../src/dispatch");
const { resolveDispatchConcurrency } = require("../src/config");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ofc-ac18-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let dirCounter = 0;
function freshKanban() {
  const stateDir = path.join(tmpRoot, `state-${dirCounter++}`);
  fs.mkdirSync(stateDir, { recursive: true });
  return createKanban({ stateDir });
}

/** Gated execFn: every dispatch stays open until release() is called. */
function makeGatedExecFn() {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fn = (args, opts) => {
    calls.push({ args, opts });
    return gate.then(() => ({ stdout: "{}" }));
  };
  return { fn, calls, release };
}

function makeDispatch(kanban, execFn, maxConcurrent) {
  return createDispatch({
    kanban,
    execFn,
    briefsDir: "/opt/briefs",
    config: { baseUrl: "http://127.0.0.1:4444", node: "test-node", maxConcurrent },
  });
}

/**
 * Fan a parallel "board" of `seatCount` independent dispatches (one card per
 * seat, all opened at once — exactly what runBoard's parallel branch does).
 * Returns { ok, refused } where `refused` counts 429 (cap) rejections.
 */
function fanParallelBoard(kanban, dispatch, seatCount) {
  const live = [];
  let refused = 0;
  for (let i = 0; i < seatCount; i++) {
    const card = kanban.createTask({ title: `seat ${i}` }, "op");
    try {
      const r = dispatch.dispatchTask(card.id, { agent: "dev", isBoard: true });
      live.push(r);
    } catch (e) {
      if (e.statusCode === 429) refused++;
      else throw e;
    }
  }
  return { live, refused };
}

// ---------------------------------------------------------------------------
// 1) The pure linkage helper — both directions.
// ---------------------------------------------------------------------------
describe("AC-18 — resolveDispatchConcurrency (pure linkage)", () => {
  it("raises maxConcurrent to the pool ceiling when spawn is ENABLED", () => {
    const eff = resolveDispatchConcurrency({
      dispatch: { maxConcurrent: 3 },
      spawn: { enabled: true, poolCeiling: 6 },
    });
    assert.strictEqual(eff, 6, "effective cap must rise to the pool ceiling");
  });

  it("never lowers a configured value already above the ceiling", () => {
    const eff = resolveDispatchConcurrency({
      dispatch: { maxConcurrent: 10 },
      spawn: { enabled: true, poolCeiling: 6 },
    });
    assert.strictEqual(eff, 10, "a higher configured value is preserved");
  });

  it("preserves the configured value EXACTLY when spawn is DISABLED", () => {
    const eff = resolveDispatchConcurrency({
      dispatch: { maxConcurrent: 3 },
      spawn: { enabled: false, poolCeiling: 6 },
    });
    assert.strictEqual(eff, 3, "spawn disabled → no lockstep raise (byte-identical)");
  });

  it("defaults sanely when fields are absent", () => {
    assert.strictEqual(resolveDispatchConcurrency({}), 3);
    assert.strictEqual(
      resolveDispatchConcurrency({ spawn: { enabled: true } }),
      8,
      "enabled with default ceiling 8",
    );
  });
});

// ---------------------------------------------------------------------------
// 2) END-TO-END against the REAL dispatch 429 cap — both directions.
// ---------------------------------------------------------------------------
describe("AC-18 — parallel board vs the dispatch 429 cap (real core)", () => {
  let kanban;
  beforeEach(() => {
    kanban = freshKanban();
  });

  it("RAISED: 6-seat parallel board with maxConcurrent at the pool ceiling (6) → ZERO 429s", async () => {
    // Pool ceiling 6, maxConcurrent raised in lockstep to 6 (AC-18 linkage).
    const effective = resolveDispatchConcurrency({
      dispatch: { maxConcurrent: 3 }, // configured low
      spawn: { enabled: true, poolCeiling: 6 }, // pool of 6
    });
    assert.strictEqual(effective, 6);

    const exec = makeGatedExecFn();
    const dispatch = makeDispatch(kanban, exec.fn, effective);

    // All 6 seats open at once (gate held) — the cap bites here if too low.
    const { live, refused } = fanParallelBoard(kanban, dispatch, 6);
    assert.strictEqual(refused, 0, "raised cap → no seat is refused with 429");
    assert.strictEqual(live.length, 6, "all six parallel seats dispatched");

    exec.release();
    await Promise.all(live.map((r) => r.completion));
  });

  it("LOWERED: same 6-seat parallel board with maxConcurrent BELOW seat count (3) → 429s reproduced", async () => {
    // The control: spawn DISABLED keeps the configured cap of 3, so the same
    // parallel fan-out trips the 429 rail — proving the cap is the chokepoint
    // the lockstep raise lifts.
    const effective = resolveDispatchConcurrency({
      dispatch: { maxConcurrent: 3 },
      spawn: { enabled: false, poolCeiling: 6 },
    });
    assert.strictEqual(effective, 3, "disabled → cap stays at the configured 3");

    const exec = makeGatedExecFn();
    const dispatch = makeDispatch(kanban, exec.fn, effective);

    const { live, refused } = fanParallelBoard(kanban, dispatch, 6);
    // First 3 open; seats 4..6 hit the cap.
    assert.strictEqual(live.length, 3, "only the cap-many seats dispatch");
    assert.strictEqual(refused, 3, "the over-cap seats are refused with 429");

    exec.release();
    await Promise.all(live.map((r) => r.completion));
  });
});
