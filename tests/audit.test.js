const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createAudit, AUDIT_ACTIONS } = require("../src/audit");

describe("audit module", () => {
  let tmpDir;
  let logsDir;
  let audit;

  function activeLog() {
    return path.join(logsDir, "audit.jsonl");
  }

  function rotatedFiles() {
    return fs
      .readdirSync(logsDir)
      .filter((f) => f !== "audit.jsonl" && /^audit\..+\.jsonl$/.test(f))
      .sort();
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
    logsDir = path.join(tmpDir, "logs");
    audit = createAudit({ logsDir });
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("createAudit()", () => {
    it("throws without a logsDir", () => {
      assert.throws(() => createAudit({}), /logsDir/);
      assert.throws(() => createAudit(), /logsDir/);
    });
  });

  describe("record() validation", () => {
    it("rejects actions outside the documented enum", () => {
      assert.throws(() => audit.record({ action: "hack.world" }), /Invalid audit action/);
      assert.throws(() => audit.record({ action: "task.created" }), /Invalid audit action/);
      assert.throws(() => audit.record({ action: "" }), /Invalid audit action/);
      assert.throws(() => audit.record({}), /Invalid audit action/);
      assert.throws(() => audit.record(null), /must be an object/);
    });

    it("accepts every documented action", () => {
      for (const action of AUDIT_ACTIONS) {
        const rec = audit.record({ user: "alice", action });
        assert.strictEqual(rec.action, action);
      }
      assert.strictEqual(audit.query({ limit: 1000 }).length, AUDIT_ACTIONS.length);
    });

    it("includes session.kill in the enum and records it", () => {
      assert.ok(AUDIT_ACTIONS.includes("session.kill"));
      const rec = audit.record({
        user: "alice",
        action: "session.kill",
        target: "12345",
        detail: { source: "terminal", signal: "SIGTERM" },
      });
      assert.strictEqual(rec.action, "session.kill");
      assert.strictEqual(rec.target, "12345");
      assert.deepStrictEqual(rec.detail, { source: "terminal", signal: "SIGTERM" });
      assert.strictEqual(audit.query({ action: "session.kill" }).length, 1);
    });

    it("includes the v2.1 audit-everything actions in the enum", () => {
      const added = [
        "settings.update",
        "chat.publish",
        "topic.status",
        "operator.save",
        "action.execute",
        "alert.test",
        "cache.clear",
        "job.run",
        "job.update",
      ];
      for (const action of added) {
        assert.ok(AUDIT_ACTIONS.includes(action), `${action} should be a documented action`);
      }
    });

    it("rejects non-string user and target", () => {
      assert.throws(() => audit.record({ action: "task.create", user: 42 }), /user/);
      assert.throws(() => audit.record({ action: "task.create", target: {} }), /target/);
    });

    it("defaults user to anonymous and stamps server ts + id", () => {
      const rec = audit.record({ action: "brief.write", target: "deploy.md" });
      assert.strictEqual(rec.user, "anonymous");
      assert.match(rec.id, /^aud_[0-9a-f]{16}$/);
      assert.ok(!Number.isNaN(Date.parse(rec.ts)));
      assert.strictEqual(rec.target, "deploy.md");
      assert.strictEqual(rec.detail, null);

      const line = fs.readFileSync(activeLog(), "utf8").trim();
      assert.deepStrictEqual(JSON.parse(line), rec);
    });
  });

  describe("query() filters and ordering", () => {
    it("filters by user and action, newest first", () => {
      audit.record({ user: "alice", action: "task.create", target: "t1" });
      audit.record({ user: "bob", action: "task.delete", target: "t2" });
      audit.record({ user: "alice", action: "task.update", target: "t3" });

      const byUser = audit.query({ user: "alice" });
      assert.deepStrictEqual(
        byUser.map((r) => r.target),
        ["t3", "t1"],
      );

      const byAction = audit.query({ action: "task.delete" });
      assert.strictEqual(byAction.length, 1);
      assert.strictEqual(byAction[0].user, "bob");

      const both = audit.query({ user: "alice", action: "task.create" });
      assert.strictEqual(both.length, 1);
      assert.strictEqual(both[0].target, "t1");
    });

    it("rejects unknown action filters and bad limits", () => {
      assert.throws(() => audit.query({ action: "nope.nope" }), /Invalid audit action filter/);
      assert.throws(() => audit.query({ limit: 0 }), /limit/);
      assert.throws(() => audit.query({ limit: "many" }), /limit/);
      assert.throws(() => audit.query({ since: "not-a-date" }), /since/);
    });

    it("filters by since/until (inclusive)", () => {
      fs.mkdirSync(logsDir, { recursive: true });
      const lines = [
        { id: "aud_1", ts: "2026-06-01T00:00:00.000Z", user: "a", action: "task.create" },
        { id: "aud_2", ts: "2026-06-05T00:00:00.000Z", user: "a", action: "task.create" },
        { id: "aud_3", ts: "2026-06-09T00:00:00.000Z", user: "a", action: "task.create" },
      ];
      fs.writeFileSync(activeLog(), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

      const since = audit.query({ since: "2026-06-05T00:00:00.000Z" });
      assert.deepStrictEqual(
        since.map((r) => r.id),
        ["aud_3", "aud_2"],
      );

      const until = audit.query({ until: "2026-06-05T00:00:00.000Z" });
      assert.deepStrictEqual(
        until.map((r) => r.id),
        ["aud_2", "aud_1"],
      );

      const window = audit.query({
        since: "2026-06-02T00:00:00.000Z",
        until: "2026-06-08T00:00:00.000Z",
      });
      assert.deepStrictEqual(
        window.map((r) => r.id),
        ["aud_2"],
      );
    });

    it("skips malformed lines without crashing", () => {
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(
        activeLog(),
        'not json at all\n{"half": \n' +
          JSON.stringify({ id: "aud_ok", ts: "2026-06-01T00:00:00.000Z", action: "gate.toggle" }) +
          "\n",
      );
      const results = audit.query({});
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].id, "aud_ok");
    });
  });

  describe("query() limits", () => {
    it("defaults to 200 and respects smaller limits", () => {
      for (let i = 0; i < 15; i++) {
        audit.record({ user: "u", action: "memory.write", target: `t${i}` });
      }
      const five = audit.query({ limit: 5 });
      assert.strictEqual(five.length, 5);
      // Newest first: the last-recorded entry leads.
      assert.strictEqual(five[0].target, "t14");
      assert.strictEqual(audit.query({}).length, 15);
    });

    it("caps the limit at 1000", () => {
      fs.mkdirSync(logsDir, { recursive: true });
      const lines = [];
      for (let i = 0; i < 1005; i++) {
        const ts = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
        lines.push(JSON.stringify({ id: `aud_${i}`, ts, user: "u", action: "task.create" }));
      }
      fs.writeFileSync(activeLog(), lines.join("\n") + "\n");

      const results = audit.query({ limit: 5000 });
      assert.strictEqual(results.length, 1000);
      assert.strictEqual(results[0].id, "aud_1004");
    });
  });

  describe("rotation", () => {
    it("rotates the active log once it reaches 50MB", () => {
      audit.record({ user: "u", action: "task.create", target: "before-rotation" });
      // Inflate the active log past the 50MB threshold (sparse extend — fast).
      fs.truncateSync(activeLog(), 50 * 1024 * 1024 + 1);

      const rec = audit.record({ user: "u", action: "task.update", target: "after-rotation" });

      const rotated = rotatedFiles();
      assert.strictEqual(rotated.length, 1);
      assert.ok(fs.statSync(path.join(logsDir, rotated[0])).size > 50 * 1024 * 1024);

      // Fresh active file contains only the new entry.
      const activeLines = fs.readFileSync(activeLog(), "utf8").trim().split("\n");
      assert.strictEqual(activeLines.length, 1);
      assert.strictEqual(JSON.parse(activeLines[0]).id, rec.id);
    });

    it("keeps at most 10 rotated files, pruning the oldest", () => {
      fs.mkdirSync(logsDir, { recursive: true });
      for (let i = 0; i < 11; i++) {
        const stamp = `2026-01-${String(i + 1).padStart(2, "0")}T00-00-00-000Z`;
        fs.writeFileSync(path.join(logsDir, `audit.${stamp}.jsonl`), "");
      }
      fs.writeFileSync(activeLog(), "");
      fs.truncateSync(activeLog(), 50 * 1024 * 1024);

      audit.record({ user: "u", action: "task.create" });

      const rotated = rotatedFiles();
      assert.strictEqual(rotated.length, 10);
      // The two oldest were pruned.
      assert.ok(!rotated.includes("audit.2026-01-01T00-00-00-000Z.jsonl"));
      assert.ok(!rotated.includes("audit.2026-01-02T00-00-00-000Z.jsonl"));
    });

    it("query() reads rotated files too, newest first across files", () => {
      fs.mkdirSync(logsDir, { recursive: true });
      const oldEntry = {
        id: "aud_old",
        ts: "2026-01-01T00:00:00.000Z",
        user: "u",
        action: "task.create",
      };
      fs.writeFileSync(
        path.join(logsDir, "audit.2026-01-02T00-00-00-000Z.jsonl"),
        JSON.stringify(oldEntry) + "\n",
      );
      const fresh = audit.record({ user: "u", action: "task.create", target: "fresh" });

      const results = audit.query({ action: "task.create" });
      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].id, fresh.id);
      assert.strictEqual(results[1].id, "aud_old");
    });
  });
});
