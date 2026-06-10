const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createSafeStore } = require("../src/state-safety");

// Simple test schema: state must be an object with v === 1
function validate(obj) {
  if (obj && typeof obj === "object" && !Array.isArray(obj) && obj.v === 1) {
    return { valid: true, errors: [] };
  }
  return { valid: false, errors: [{ path: "v", reason: "v must be 1" }] };
}

function waitFor(predicate, timeoutMs = 2000, stepMs = 25) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor: timed out"));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("state-safety module", () => {
  let tmpDir;
  let filePath;
  let backupDir;

  function makeStore(overrides = {}) {
    return createSafeStore({
      filePath,
      validate,
      backupDir,
      createDefault: () => ({ v: 1, fresh: true }),
      debounceMs: 25,
      ...overrides,
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-safety-test-"));
    filePath = path.join(tmpDir, "state.json");
    backupDir = path.join(tmpDir, "backups");
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("createSafeStore()", () => {
    it("requires filePath, validate, and backupDir", () => {
      assert.throws(() => createSafeStore({ validate, backupDir }), /filePath/);
      assert.throws(() => createSafeStore({ filePath, backupDir }), /validate/);
      assert.throws(() => createSafeStore({ filePath, validate }), /backupDir/);
    });
  });

  describe("write()", () => {
    it("writes valid state and reads it back", () => {
      const store = makeStore();
      store.write({ v: 1, n: 42 });
      const result = store.read();
      assert.deepStrictEqual(result.data, { v: 1, n: 42 });
      assert.strictEqual(result.restored, false);
      assert.strictEqual(result.quarantinedPath, null);
    });

    it("throws with errors when state is invalid", () => {
      const store = makeStore();
      assert.throws(
        () => store.write({ v: 2 }),
        (err) => {
          assert.match(err.message, /invalid state/i);
          assert.strictEqual(err.errors.length, 1);
          assert.strictEqual(err.errors[0].path, "v");
          return true;
        },
      );
      assert.ok(!fs.existsSync(filePath), "invalid write must not touch the file");
    });

    it("leaves no temp files behind", () => {
      const store = makeStore();
      store.write({ v: 1, n: 1 });
      store.write({ v: 1, n: 2 });
      const leftovers = fs.readdirSync(tmpDir).filter((f) => f.includes(".tmp-"));
      assert.deepStrictEqual(leftovers, []);
    });

    it("backs up the previous good version on each overwrite", () => {
      const store = makeStore();
      store.write({ v: 1, n: 1 });
      assert.strictEqual(store.listBackups().length, 0, "first write has no previous version");
      store.write({ v: 1, n: 2 });
      const backups = store.listBackups();
      assert.strictEqual(backups.length, 1);
      const backedUp = JSON.parse(fs.readFileSync(backups[0].path, "utf8"));
      assert.deepStrictEqual(backedUp, { v: 1, n: 1 });
    });

    it("prunes backups to maxBackups, keeping the newest", () => {
      const store = makeStore({ maxBackups: 3 });
      for (let n = 1; n <= 6; n++) {
        store.write({ v: 1, n });
      }
      const backups = store.listBackups();
      assert.strictEqual(backups.length, 3);
      // Newest backup is the previous version of the latest write (n=5).
      const newest = JSON.parse(fs.readFileSync(backups[0].path, "utf8"));
      assert.strictEqual(newest.n, 5);
      const oldest = JSON.parse(fs.readFileSync(backups[2].path, "utf8"));
      assert.strictEqual(oldest.n, 3);
    });
  });

  describe("read() recovery", () => {
    it("returns the default when the file does not exist", () => {
      const store = makeStore();
      const result = store.read();
      assert.deepStrictEqual(result.data, { v: 1, fresh: true });
      assert.strictEqual(result.restored, false);
      assert.strictEqual(result.usedDefault, true);
    });

    it("quarantines a corrupt file and restores the newest valid backup", () => {
      const store = makeStore();
      store.write({ v: 1, n: 1 });
      store.write({ v: 1, n: 2 });
      store.write({ v: 1, n: 3 });
      fs.writeFileSync(filePath, "{{{ not json", "utf8");

      const result = store.read();
      assert.strictEqual(result.restored, true);
      assert.deepStrictEqual(
        result.data,
        { v: 1, n: 2 },
        "newest backup is the pre-corruption previous version",
      );
      assert.ok(result.quarantinedPath, "quarantine path returned");
      assert.ok(fs.existsSync(result.quarantinedPath), "quarantine file exists");
      assert.match(path.basename(result.quarantinedPath), /^state\.quarantine\..+\.json$/);
      assert.strictEqual(fs.readFileSync(result.quarantinedPath, "utf8"), "{{{ not json");
      // The state file itself was repaired on disk.
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), { v: 1, n: 2 });
    });

    it("quarantines a parseable-but-invalid file the same way", () => {
      const store = makeStore();
      store.write({ v: 1, n: 1 });
      store.write({ v: 1, n: 2 });
      fs.writeFileSync(filePath, JSON.stringify({ v: 99 }), "utf8");

      const result = store.read();
      assert.strictEqual(result.restored, true);
      assert.deepStrictEqual(result.data, { v: 1, n: 1 });
      assert.ok(fs.existsSync(result.quarantinedPath));
    });

    it("skips invalid backups and restores the next valid one", () => {
      const store = makeStore();
      store.write({ v: 1, n: 1 });
      store.write({ v: 1, n: 2 });
      store.write({ v: 1, n: 3 });
      // Corrupt the newest backup (n=2) so restore must use the older one (n=1).
      const backups = store.listBackups();
      assert.strictEqual(backups.length, 2);
      fs.writeFileSync(backups[0].path, "garbage", "utf8");
      fs.writeFileSync(filePath, "corrupt main", "utf8");

      const result = store.read();
      assert.strictEqual(result.restored, true);
      assert.deepStrictEqual(result.data, { v: 1, n: 1 });
      assert.ok(result.restoredFrom.endsWith(path.basename(backups[1].path)));
    });

    it("falls back to the default when there is no valid backup", () => {
      const store = makeStore();
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(filePath, "total garbage", "utf8");

      const result = store.read();
      assert.strictEqual(result.restored, false);
      assert.strictEqual(result.usedDefault, true);
      assert.deepStrictEqual(result.data, { v: 1, fresh: true });
      assert.ok(fs.existsSync(result.quarantinedPath));
      // Default state was persisted so the next read is clean.
      const again = store.read();
      assert.strictEqual(again.restored, false);
      assert.strictEqual(again.usedDefault, false);
      assert.deepStrictEqual(again.data, { v: 1, fresh: true });
    });
  });

  describe("restore()", () => {
    it("restores the newest valid backup on demand", () => {
      const store = makeStore();
      store.write({ v: 1, n: 1 });
      store.write({ v: 1, n: 2 });
      const result = store.restore();
      assert.deepStrictEqual(result.data, { v: 1, n: 1 });
      assert.ok(result.restoredFrom.includes("backups"));
      assert.deepStrictEqual(store.read().data, { v: 1, n: 1 });
    });

    it("returns null when no valid backup exists", () => {
      const store = makeStore();
      assert.strictEqual(store.restore(), null);
    });
  });

  describe("listBackups()", () => {
    it("returns backups newest first", () => {
      const store = makeStore();
      for (let n = 1; n <= 4; n++) store.write({ v: 1, n });
      const backups = store.listBackups();
      assert.strictEqual(backups.length, 3);
      const values = backups.map((b) => JSON.parse(fs.readFileSync(b.path, "utf8")).n);
      assert.deepStrictEqual(values, [3, 2, 1]);
    });

    it("returns an empty array when backupDir does not exist", () => {
      const store = makeStore();
      assert.deepStrictEqual(store.listBackups(), []);
    });
  });

  describe("watch()", () => {
    it("fires on a valid external write with the new data", async () => {
      const store = makeStore();
      store.write({ v: 1, n: 1 });
      const events = [];
      const watcher = store.watch((result) => events.push(result));
      try {
        fs.writeFileSync(filePath, JSON.stringify({ v: 1, n: 99 }), "utf8");
        await waitFor(() => events.length > 0);
        assert.strictEqual(events[0].restored, false);
        assert.deepStrictEqual(events[0].data, { v: 1, n: 99 });
      } finally {
        watcher.close();
      }
    });

    it("quarantines and restores after an invalid external write", async () => {
      const store = makeStore();
      store.write({ v: 1, n: 1 });
      store.write({ v: 1, n: 2 });
      const events = [];
      const watcher = store.watch((result) => events.push(result));
      try {
        fs.writeFileSync(filePath, "agent garbage }{", "utf8");
        await waitFor(() => events.length > 0);
        assert.strictEqual(events[0].restored, true);
        assert.deepStrictEqual(events[0].data, { v: 1, n: 1 });
        assert.ok(fs.existsSync(events[0].quarantinedPath));
        // State file healed on disk.
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), { v: 1, n: 1 });
      } finally {
        watcher.close();
      }
    });

    it("ignores the store's own writes", async () => {
      const store = makeStore();
      store.write({ v: 1, n: 1 });
      const events = [];
      const watcher = store.watch((result) => events.push(result));
      try {
        store.write({ v: 1, n: 2 });
        await sleep(150); // well past the debounce window
        assert.strictEqual(events.length, 0);
      } finally {
        watcher.close();
      }
    });
  });
});
