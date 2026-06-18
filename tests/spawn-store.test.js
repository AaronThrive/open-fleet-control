const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createSpawnStore } = require("../src/spawn-store");

describe("spawn-store module", () => {
  let stateDir;
  let store;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-store-test-"));
  });

  afterEach(() => {
    if (store) {
      try {
        store.close();
      } catch (e) {
        // best-effort close
      }
      store = null;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function makeStore(overrides = {}) {
    store = createSpawnStore({ stateDir, ...overrides });
    return store;
  }

  describe("createSpawnStore()", () => {
    it("requires a non-empty stateDir", () => {
      assert.throws(() => createSpawnStore({}), /stateDir must be a non-empty string/);
      assert.throws(() => createSpawnStore({ stateDir: "" }), /stateDir must be a non-empty string/);
    });

    it("creates the state directory if missing", () => {
      const nested = path.join(stateDir, "deep", "nested");
      const s = createSpawnStore({ stateDir: nested });
      s.close();
      assert.ok(fs.existsSync(nested));
    });

    it("creates the SQLite database file", () => {
      makeStore();
      assert.ok(fs.existsSync(path.join(stateDir, "spawn-store.db")));
    });
  });

  // -------------------------------------------------------------------------
  // AC-13: slack_event_dedup
  // -------------------------------------------------------------------------

  describe("insertDedup() — AC-13", () => {
    it("first insert of an event_id is not a duplicate", () => {
      const s = makeStore();
      const result = s.insertDedup("evt_abc123");
      assert.strictEqual(result.isDuplicate, false);
    });

    it("second insert of the same event_id is a duplicate", () => {
      const s = makeStore();
      s.insertDedup("evt_abc123");
      const result = s.insertDedup("evt_abc123");
      assert.strictEqual(result.isDuplicate, true);
    });

    it("distinct event_ids are each not duplicates", () => {
      const s = makeStore();
      assert.strictEqual(s.insertDedup("evt_001").isDuplicate, false);
      assert.strictEqual(s.insertDedup("evt_002").isDuplicate, false);
      assert.strictEqual(s.insertDedup("evt_003").isDuplicate, false);
    });

    it("rejects empty or non-string eventId", () => {
      const s = makeStore();
      assert.throws(() => s.insertDedup(""), /eventId must be a non-empty string/);
      assert.throws(() => s.insertDedup(null), /eventId must be a non-empty string/);
      assert.throws(() => s.insertDedup(42), /eventId must be a non-empty string/);
    });

    it("lazy GC prunes expired rows on insert", () => {
      // Use a nowFn that starts in the past so the first row is already expired.
      let now = 0;
      const s = createSpawnStore({ stateDir, nowFn: () => now });
      store = s;

      // Insert at t=0 — expires at t=600000
      s.insertDedup("evt_old");

      // Advance time past the 10-minute TTL
      now = 10 * 60 * 1001;

      // Inserting a new event prunes the expired row; old event is no longer
      // in the table, so re-inserting it is not a duplicate.
      s.insertDedup("evt_new");
      const result = s.insertDedup("evt_old");
      assert.strictEqual(result.isDuplicate, false, "expired row should have been GC'd");
    });
  });

  describe("pruneDedup()", () => {
    it("removes expired rows and returns the count", () => {
      let now = 0;
      const s = createSpawnStore({ stateDir, nowFn: () => now });
      store = s;

      s.insertDedup("evt_a");
      s.insertDedup("evt_b");
      // Advance past TTL
      now = 10 * 60 * 1001;
      const removed = s.pruneDedup();
      assert.strictEqual(removed, 2);
    });

    it("returns 0 when no rows are expired", () => {
      const s = makeStore();
      s.insertDedup("evt_fresh");
      const removed = s.pruneDedup();
      assert.strictEqual(removed, 0);
    });
  });

  // -------------------------------------------------------------------------
  // AC-14: fencing_counter
  // -------------------------------------------------------------------------

  describe("nextToken() — AC-14", () => {
    it("starts at 1 on first call", () => {
      const s = makeStore();
      assert.strictEqual(s.nextToken(), 1);
    });

    it("returns strictly increasing tokens", () => {
      const s = makeStore();
      const t1 = s.nextToken();
      const t2 = s.nextToken();
      const t3 = s.nextToken();
      assert.ok(t1 < t2, "t1 < t2");
      assert.ok(t2 < t3, "t2 < t3");
    });

    it("tokens are strictly increasing across a simulated process restart", () => {
      // Simulate first process
      const s1 = createSpawnStore({ stateDir });
      const t1 = s1.nextToken();
      const t2 = s1.nextToken();
      s1.close();

      // Simulate second process (same DB file)
      const s2 = createSpawnStore({ stateDir });
      store = s2; // register for cleanup
      const t3 = s2.nextToken();
      const t4 = s2.nextToken();

      assert.ok(t1 < t2, "within first instance: t1 < t2");
      assert.ok(t2 < t3, "across restart: t2 < t3");
      assert.ok(t3 < t4, "within second instance: t3 < t4");
    });

    it("10 sequential calls produce 10 distinct increasing values", () => {
      const s = makeStore();
      const tokens = Array.from({ length: 10 }, () => s.nextToken());
      for (let i = 1; i < tokens.length; i++) {
        assert.ok(tokens[i] > tokens[i - 1], `token[${i}] must be > token[${i - 1}]`);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Result sink (AC-14 cont.)
  // -------------------------------------------------------------------------

  describe("createResultSink()", () => {
    it("accepts a result with a fresh token", () => {
      const s = makeStore();
      const sink = s.createResultSink();
      const t = s.nextToken();
      const out = sink.accept("node-1", 0, t, { answer: "hello" });
      assert.strictEqual(out.accepted, true);
      assert.strictEqual(out.reason, null);
    });

    it("rejects a result whose token is older than the latest accepted", () => {
      const s = makeStore();
      const sink = s.createResultSink();
      const t1 = s.nextToken();
      const t2 = s.nextToken();

      // Accept the newer token first
      sink.accept("node-1", 0, t2, { answer: "new" });

      // Now the older token is stale
      const out = sink.accept("node-1", 0, t1, { answer: "old" });
      assert.strictEqual(out.accepted, false);
      assert.strictEqual(out.reason, "stale_token");
    });

    it("accepts a result equal to the current high-water mark (idempotent accept)", () => {
      const s = makeStore();
      const sink = s.createResultSink();
      const t = s.nextToken();

      sink.accept("node-1", 0, t, { answer: "a" });
      const out = sink.accept("node-1", 0, t, { answer: "a-again" });
      assert.strictEqual(out.accepted, true);
    });

    it("tracks (nodeId, generation) independently", () => {
      const s = makeStore();
      const sink = s.createResultSink();
      const t1 = s.nextToken();
      const t2 = s.nextToken();

      // node-1 gen-0: accept t2 first, then t1 is stale
      sink.accept("node-1", 0, t2, { answer: "n1g0" });
      assert.strictEqual(sink.accept("node-1", 0, t1, {}).accepted, false);

      // node-1 gen-1: fresh generation, t1 is NOT stale for this generation
      const out = sink.accept("node-1", 1, t1, { answer: "n1g1" });
      assert.strictEqual(out.accepted, true, "fresh generation should accept old-looking token");

      // node-2: completely independent
      const out2 = sink.accept("node-2", 0, t1, { answer: "n2g0" });
      assert.strictEqual(out2.accepted, true);
    });

    it("reset() clears all high-water marks", () => {
      const s = makeStore();
      const sink = s.createResultSink();
      const t1 = s.nextToken();
      const t2 = s.nextToken();

      sink.accept("node-1", 0, t2, {});
      // t1 is stale before reset
      assert.strictEqual(sink.accept("node-1", 0, t1, {}).accepted, false);

      sink.reset();
      // After reset, t1 is accepted again
      assert.strictEqual(sink.accept("node-1", 0, t1, {}).accepted, true);
    });

    it("validates accept() parameters", () => {
      const s = makeStore();
      const sink = s.createResultSink();
      assert.throws(() => sink.accept("", 0, 1, {}), /nodeId/);
      assert.throws(() => sink.accept("node-1", NaN, 1, {}), /generation/);
      assert.throws(() => sink.accept("node-1", 0, NaN, {}), /token/);
    });
  });

  describe("close()", () => {
    it("closes without throwing", () => {
      const s = createSpawnStore({ stateDir });
      store = null; // prevent double-close in afterEach
      assert.doesNotThrow(() => s.close());
    });
  });
});
