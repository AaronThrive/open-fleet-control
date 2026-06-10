const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const schema = require("../src/kanban-schema");
const { createKanban, createWatchdog } = require("../src/kanban");

function validBoard(tasks = []) {
  return { version: 1, updated_at: new Date().toISOString(), tasks };
}

function validTask(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: "tsk_a1b2c3",
    title: "Scout the perimeter",
    description: "",
    status: "inbox",
    assignee: null,
    node: null,
    priority: 2,
    due: null,
    progress: 0,
    order: 0,
    parent_id: null,
    attempts: [],
    comments: [],
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function errorPaths(result) {
  return result.errors.map((e) => e.path);
}

describe("kanban-schema module", () => {
  describe("exports", () => {
    it("exports the STATUS enum and column order", () => {
      assert.deepStrictEqual(schema.COLUMN_ORDER, [
        "inbox",
        "assigned",
        "inprogress",
        "review",
        "done",
        "failed",
      ]);
      assert.strictEqual(schema.STATUS.INBOX, "inbox");
      assert.strictEqual(schema.STATUS.FAILED, "failed");
      assert.ok(Object.isFrozen(schema.STATUS));
      assert.ok(Object.isFrozen(schema.COLUMN_ORDER));
    });
  });

  describe("validateBoard()", () => {
    it("accepts a valid board", () => {
      const result = schema.validateBoard(validBoard([validTask()]));
      assert.strictEqual(result.valid, true);
      assert.deepStrictEqual(result.errors, []);
    });

    it("accepts an empty board", () => {
      assert.strictEqual(schema.validateBoard(validBoard()).valid, true);
    });

    it("rejects non-objects", () => {
      for (const bad of [null, undefined, [], "board", 42]) {
        assert.strictEqual(schema.validateBoard(bad).valid, false);
      }
    });

    it("rejects a wrong version", () => {
      const result = schema.validateBoard({ ...validBoard(), version: 2 });
      assert.strictEqual(result.valid, false);
      assert.ok(errorPaths(result).includes("version"));
    });

    it("rejects a bad updated_at", () => {
      const result = schema.validateBoard({ ...validBoard(), updated_at: "yesterday" });
      assert.ok(errorPaths(result).includes("updated_at"));
    });

    it("rejects non-array tasks", () => {
      const result = schema.validateBoard({ ...validBoard(), tasks: {} });
      assert.ok(errorPaths(result).includes("tasks"));
    });

    it("rejects duplicate task ids", () => {
      const result = schema.validateBoard(validBoard([validTask(), validTask()]));
      assert.strictEqual(result.valid, false);
      assert.ok(errorPaths(result).includes("tasks[1].id"));
    });

    it("reports task errors with indexed paths", () => {
      const result = schema.validateBoard(validBoard([validTask({ priority: 9 })]));
      assert.ok(errorPaths(result).includes("tasks[0].priority"));
    });
  });

  describe("validateTask()", () => {
    it("accepts a fully valid task", () => {
      assert.strictEqual(schema.validateTask(validTask()).valid, true);
    });

    it("rejects unknown top-level task fields (agent garbage protection)", () => {
      const result = schema.validateTask(validTask({ hallucinated: true }));
      assert.strictEqual(result.valid, false);
      assert.ok(errorPaths(result).includes("task.hallucinated"));
    });

    it("rejects bad id formats", () => {
      for (const id of ["tsk_ABCDEF", "tsk_12345", "task_abc123", "tsk_1234567", ""]) {
        const result = schema.validateTask(validTask({ id }));
        assert.strictEqual(result.valid, false, `id '${id}' should be rejected`);
        assert.ok(errorPaths(result).includes("task.id"));
      }
    });

    it("rejects empty and oversized titles", () => {
      assert.ok(errorPaths(schema.validateTask(validTask({ title: "" }))).includes("task.title"));
      const long = "x".repeat(201);
      assert.ok(errorPaths(schema.validateTask(validTask({ title: long }))).includes("task.title"));
      assert.strictEqual(schema.validateTask(validTask({ title: "x".repeat(200) })).valid, true);
    });

    it("rejects descriptions over 10KB", () => {
      const big = "d".repeat(10 * 1024 + 1);
      const result = schema.validateTask(validTask({ description: big }));
      assert.ok(errorPaths(result).includes("task.description"));
      assert.strictEqual(
        schema.validateTask(validTask({ description: "d".repeat(10 * 1024) })).valid,
        true,
      );
    });

    it("rejects unknown statuses", () => {
      const result = schema.validateTask(validTask({ status: "blocked" }));
      assert.ok(errorPaths(result).includes("task.status"));
    });

    it("rejects oversized assignee and node", () => {
      const long = "a".repeat(129);
      assert.ok(
        errorPaths(schema.validateTask(validTask({ assignee: long }))).includes("task.assignee"),
      );
      assert.ok(errorPaths(schema.validateTask(validTask({ node: long }))).includes("task.node"));
    });

    it("rejects invalid priorities", () => {
      for (const priority of [0, 4, 1.5, "1", null]) {
        const result = schema.validateTask(validTask({ priority }));
        assert.ok(errorPaths(result).includes("task.priority"), `priority ${priority}`);
      }
    });

    it("accepts ISO dates or null for due, rejects junk", () => {
      assert.strictEqual(schema.validateTask(validTask({ due: "2026-07-01" })).valid, true);
      assert.strictEqual(
        schema.validateTask(validTask({ due: "2026-07-01T12:00:00.000Z" })).valid,
        true,
      );
      assert.strictEqual(schema.validateTask(validTask({ due: null })).valid, true);
      assert.ok(
        errorPaths(schema.validateTask(validTask({ due: "next week" }))).includes("task.due"),
      );
    });

    it("rejects out-of-range or non-integer progress", () => {
      for (const progress of [-1, 101, 50.5, "50"]) {
        const result = schema.validateTask(validTask({ progress }));
        assert.ok(errorPaths(result).includes("task.progress"), `progress ${progress}`);
      }
    });

    it("rejects non-integer order", () => {
      assert.ok(errorPaths(schema.validateTask(validTask({ order: 1.5 }))).includes("task.order"));
    });

    it("rejects malformed parent_id", () => {
      const result = schema.validateTask(validTask({ parent_id: "nope" }));
      assert.ok(errorPaths(result).includes("task.parent_id"));
      assert.strictEqual(schema.validateTask(validTask({ parent_id: "tsk_ffffff" })).valid, true);
    });

    it("validates attempts: result enum, ISO timestamps, unknown fields", () => {
      const goodAttempt = {
        agent: "drone-1",
        started_at: new Date().toISOString(),
        ended_at: null,
        result: null,
        branch: null,
        note: null,
      };
      assert.strictEqual(schema.validateTask(validTask({ attempts: [goodAttempt] })).valid, true);

      const badResult = schema.validateTask(
        validTask({ attempts: [{ ...goodAttempt, result: "meh" }] }),
      );
      assert.ok(errorPaths(badResult).includes("task.attempts[0].result"));

      const badStart = schema.validateTask(
        validTask({ attempts: [{ ...goodAttempt, started_at: "soon" }] }),
      );
      assert.ok(errorPaths(badStart).includes("task.attempts[0].started_at"));

      const unknown = schema.validateTask(validTask({ attempts: [{ ...goodAttempt, extra: 1 }] }));
      assert.ok(errorPaths(unknown).includes("task.attempts[0].extra"));
    });

    it("validates comments: author, ts, 4KB text cap", () => {
      const goodComment = { author: "overmind", ts: new Date().toISOString(), text: "ok" };
      assert.strictEqual(schema.validateTask(validTask({ comments: [goodComment] })).valid, true);

      const big = schema.validateTask(
        validTask({ comments: [{ ...goodComment, text: "c".repeat(4097) }] }),
      );
      assert.ok(errorPaths(big).includes("task.comments[0].text"));

      const badTs = schema.validateTask(validTask({ comments: [{ ...goodComment, ts: "today" }] }));
      assert.ok(errorPaths(badTs).includes("task.comments[0].ts"));
    });

    it("rejects bad created_at / updated_at", () => {
      assert.ok(
        errorPaths(schema.validateTask(validTask({ created_at: "x" }))).includes("task.created_at"),
      );
      assert.ok(
        errorPaths(schema.validateTask(validTask({ updated_at: 5 }))).includes("task.updated_at"),
      );
    });
  });

  describe("createTask()", () => {
    it("generates ids matching tsk_ + 6 lowercase hex", () => {
      for (let i = 0; i < 20; i++) {
        const task = schema.createTask({ title: "T" });
        assert.match(task.id, /^tsk_[0-9a-f]{6}$/);
      }
    });

    it("applies defaults", () => {
      const task = schema.createTask({ title: "Spawn more overlords" });
      assert.strictEqual(task.status, "inbox");
      assert.strictEqual(task.description, "");
      assert.strictEqual(task.assignee, null);
      assert.strictEqual(task.node, null);
      assert.strictEqual(task.priority, 2);
      assert.strictEqual(task.due, null);
      assert.strictEqual(task.progress, 0);
      assert.strictEqual(task.order, 0);
      assert.strictEqual(task.parent_id, null);
      assert.deepStrictEqual(task.attempts, []);
      assert.deepStrictEqual(task.comments, []);
      assert.strictEqual(task.created_at, task.updated_at);
      assert.strictEqual(schema.validateTask(task).valid, true);
    });

    it("throws on a missing title", () => {
      assert.throws(
        () => schema.createTask({}),
        (err) => {
          assert.ok(err.errors.some((e) => e.path === "task.title"));
          return true;
        },
      );
    });

    it("throws on unknown fields and supplied ids", () => {
      assert.throws(() => schema.createTask({ title: "T", bogus: 1 }), /unknown task field/);
      assert.throws(() => schema.createTask({ title: "T", id: "tsk_aaaaaa" }), /id is generated/);
    });
  });
});

describe("kanban module", () => {
  let tmpDir;
  let events;

  function makeKanban(overrides = {}) {
    return createKanban({
      stateDir: tmpDir,
      onChange: (event) => events.push(event),
      debounceMs: 25,
      ...overrides,
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-test-"));
    events = [];
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("createKanban()", () => {
    it("requires stateDir", () => {
      assert.throws(() => createKanban({}), /stateDir/);
    });

    it("starts with a fresh empty board", () => {
      const kanban = makeKanban();
      const board = kanban.getBoard();
      assert.strictEqual(board.version, 1);
      assert.deepStrictEqual(board.tasks, []);
    });
  });

  describe("createTask()", () => {
    it("creates a task, persists it, and fires task.created", () => {
      const kanban = makeKanban();
      const task = kanban.createTask({ title: "Harvest minerals" }, "overmind");
      assert.match(task.id, /^tsk_[0-9a-f]{6}$/);

      const board = kanban.getBoard();
      assert.strictEqual(board.tasks.length, 1);
      assert.strictEqual(board.tasks[0].title, "Harvest minerals");

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].type, "task.created");
      assert.strictEqual(events[0].actor, "overmind");
      assert.strictEqual(events[0].taskId, task.id);

      // Persisted on disk for other processes/agents.
      const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, "kanban.json"), "utf8"));
      assert.strictEqual(onDisk.tasks.length, 1);
    });

    it("rejects invalid fields without writing", () => {
      const kanban = makeKanban();
      assert.throws(() => kanban.createTask({ title: "" }, "overmind"));
      assert.deepStrictEqual(kanban.getBoard().tasks, []);
      assert.strictEqual(events.length, 0);
    });
  });

  describe("updateTask()", () => {
    it("patches fields and bumps updated_at", () => {
      const kanban = makeKanban();
      const task = kanban.createTask({ title: "Old title" }, "overmind");
      const updated = kanban.updateTask(task.id, { title: "New title", progress: 40 }, "drone-1");
      assert.strictEqual(updated.title, "New title");
      assert.strictEqual(updated.progress, 40);
      assert.ok(Date.parse(updated.updated_at) >= Date.parse(task.updated_at));

      const event = events.find((e) => e.type === "task.updated");
      assert.ok(event);
      assert.deepStrictEqual(event.changes.sort(), ["progress", "title"]);
      assert.strictEqual(event.actor, "drone-1");
    });

    it("rejects unknown patch fields via validation", () => {
      const kanban = makeKanban();
      const task = kanban.createTask({ title: "T" }, "overmind");
      assert.throws(() => kanban.updateTask(task.id, { hallucinated: true }, "drone-1"));
      assert.strictEqual(kanban.getBoard().tasks[0].title, "T");
    });

    it("rejects patching id and created_at", () => {
      const kanban = makeKanban();
      const task = kanban.createTask({ title: "T" }, "overmind");
      assert.throws(
        () => kanban.updateTask(task.id, { id: "tsk_ffffff" }, "a"),
        /cannot be patched/,
      );
      assert.throws(
        () => kanban.updateTask(task.id, { created_at: new Date().toISOString() }, "a"),
        /cannot be patched/,
      );
    });

    it("rejects invalid status values via validation", () => {
      const kanban = makeKanban();
      const task = kanban.createTask({ title: "T" }, "overmind");
      assert.throws(() => kanban.updateTask(task.id, { status: "limbo" }, "a"));
    });

    it("throws for unknown task ids", () => {
      const kanban = makeKanban();
      assert.throws(() => kanban.updateTask("tsk_000000", { title: "X" }, "a"), /Unknown task/);
    });
  });

  describe("moveTask()", () => {
    it("moves a task between columns and fires task.moved", () => {
      const kanban = makeKanban();
      const task = kanban.createTask({ title: "T" }, "overmind");
      const moved = kanban.moveTask(task.id, "inprogress", 3, "drone-1");
      assert.strictEqual(moved.status, "inprogress");
      assert.strictEqual(moved.order, 3);

      const event = events.find((e) => e.type === "task.moved");
      assert.strictEqual(event.from, "inbox");
      assert.strictEqual(event.to, "inprogress");
      assert.strictEqual(event.order, 3);
    });

    it("rejects moves to unknown statuses", () => {
      const kanban = makeKanban();
      const task = kanban.createTask({ title: "T" }, "overmind");
      assert.throws(() => kanban.moveTask(task.id, "purgatory", 0, "a"), /unknown status/);
      assert.throws(() => kanban.moveTask(task.id, "review", 1.5, "a"), /order must be an integer/);
      assert.strictEqual(kanban.getBoard().tasks[0].status, "inbox");
    });
  });

  describe("addComment() / addAttempt()", () => {
    it("appends a comment with a timestamp", () => {
      const kanban = makeKanban();
      const task = kanban.createTask({ title: "T" }, "overmind");
      const updated = kanban.addComment(task.id, { author: "drone-1", text: "On it" });
      assert.strictEqual(updated.comments.length, 1);
      assert.strictEqual(updated.comments[0].author, "drone-1");
      assert.ok(!Number.isNaN(Date.parse(updated.comments[0].ts)));
      assert.ok(events.some((e) => e.type === "comment.added"));
    });

    it("rejects oversized comments", () => {
      const kanban = makeKanban();
      const task = kanban.createTask({ title: "T" }, "overmind");
      assert.throws(() =>
        kanban.addComment(task.id, { author: "drone-1", text: "x".repeat(5000) }),
      );
      assert.deepStrictEqual(kanban.getBoard().tasks[0].comments, []);
    });

    it("appends an attempt with defaults", () => {
      const kanban = makeKanban();
      const task = kanban.createTask({ title: "T" }, "overmind");
      const updated = kanban.addAttempt(task.id, { agent: "drone-2" });
      assert.strictEqual(updated.attempts.length, 1);
      assert.strictEqual(updated.attempts[0].agent, "drone-2");
      assert.strictEqual(updated.attempts[0].ended_at, null);
      assert.strictEqual(updated.attempts[0].result, null);
      assert.ok(events.some((e) => e.type === "attempt.added"));
    });

    it("rejects unknown attempt fields", () => {
      const kanban = makeKanban();
      const task = kanban.createTask({ title: "T" }, "overmind");
      assert.throws(
        () => kanban.addAttempt(task.id, { agent: "d", garbage: 1 }),
        /unknown attempt/,
      );
    });
  });

  describe("deleteTask()", () => {
    it("removes the task and fires task.deleted", () => {
      const kanban = makeKanban();
      const task = kanban.createTask({ title: "Doomed" }, "overmind");
      const removed = kanban.deleteTask(task.id, "overmind");
      assert.strictEqual(removed.id, task.id);
      assert.deepStrictEqual(kanban.getBoard().tasks, []);
      assert.ok(events.some((e) => e.type === "task.deleted"));
    });

    it("throws for unknown ids", () => {
      const kanban = makeKanban();
      assert.throws(() => kanban.deleteTask("tsk_000000", "a"), /Unknown task/);
    });
  });

  describe("immutability and persistence", () => {
    it("mutating a returned board does not affect stored state", () => {
      const kanban = makeKanban();
      kanban.createTask({ title: "Original" }, "overmind");
      const board = kanban.getBoard();
      board.tasks[0].title = "Mutated";
      board.tasks.push({ junk: true });
      const fresh = kanban.getBoard();
      assert.strictEqual(fresh.tasks.length, 1);
      assert.strictEqual(fresh.tasks[0].title, "Original");
    });

    it("a second instance over the same stateDir sees persisted tasks", () => {
      const kanban = makeKanban();
      const task = kanban.createTask({ title: "Shared" }, "overmind");
      const second = createKanban({ stateDir: tmpDir });
      assert.strictEqual(second.getBoard().tasks[0].id, task.id);
    });

    it("recovers from agent garbage written directly to kanban.json", () => {
      const kanban = makeKanban();
      kanban.createTask({ title: "First" }, "overmind");
      kanban.createTask({ title: "Second" }, "overmind");
      fs.writeFileSync(path.join(tmpDir, "kanban.json"), "}} agent meltdown {{", "utf8");
      const board = kanban.getBoard();
      // Restored from the newest backup (board state with just "First").
      assert.strictEqual(board.version, 1);
      assert.ok(board.tasks.length >= 1);
      assert.strictEqual(board.tasks[0].title, "First");
    });
  });

  describe("createWatchdog()", () => {
    it("requires kanban", () => {
      assert.throws(() => createWatchdog({}), /kanban/);
    });

    it("flags stale assigned/inprogress tasks and fires onStale once per episode", () => {
      const kanban = makeKanban();
      const task = kanban.createTask({ title: "Long mission" }, "overmind");
      kanban.moveTask(task.id, "inprogress", 0, "drone-1");
      const doneTask = kanban.createTask({ title: "Finished", status: "done" }, "overmind");

      let fakeNow = Date.now();
      const staleCalls = [];
      const watchdog = createWatchdog({
        kanban,
        thresholdMs: 30 * 60 * 1000,
        onStale: (t) => staleCalls.push(t.id),
        now: () => fakeNow,
      });

      // Fresh task: not stale.
      assert.deepStrictEqual(watchdog.check(), []);
      assert.strictEqual(kanban.getBoard().tasks.find((t) => t.id === task.id).stale, false);

      // Advance past the threshold.
      fakeNow += 31 * 60 * 1000;
      assert.deepStrictEqual(watchdog.check(), [task.id]);
      assert.deepStrictEqual(staleCalls, [task.id]);
      assert.strictEqual(kanban.getBoard().tasks.find((t) => t.id === task.id).stale, true);
      // Done task never flagged even though it is old.
      assert.strictEqual(kanban.getBoard().tasks.find((t) => t.id === doneTask.id).stale, false);

      // Second sweep: still stale, but onStale does NOT fire again.
      watchdog.check();
      assert.strictEqual(staleCalls.length, 1);
    });

    it("re-arms after the task shows activity again", () => {
      const kanban = makeKanban();
      const task = kanban.createTask({ title: "Flaky mission" }, "overmind");
      kanban.moveTask(task.id, "assigned", 0, "overmind");

      let fakeNow = Date.now();
      const staleCalls = [];
      const watchdog = createWatchdog({
        kanban,
        thresholdMs: 30 * 60 * 1000,
        onStale: (t) => staleCalls.push(t.id),
        now: () => fakeNow,
      });

      fakeNow += 31 * 60 * 1000;
      watchdog.check();
      assert.strictEqual(staleCalls.length, 1);

      // Activity: a new comment refreshes the task (comment ts = real now,
      // which is within the threshold of fakeNow + 31min? No — so advance
      // the activity by commenting, then verify un-flag at current fakeNow).
      kanban.addComment(task.id, { author: "drone-1", text: "Still alive" });
      fakeNow = Date.now() + 60 * 1000; // just after the comment, well under threshold
      assert.deepStrictEqual(watchdog.check(), []);
      assert.strictEqual(kanban.getBoard().tasks.find((t) => t.id === task.id).stale, false);

      // Goes stale again later → fires a second time (re-armed).
      fakeNow += 31 * 60 * 1000;
      assert.deepStrictEqual(watchdog.check(), [task.id]);
      assert.deepStrictEqual(staleCalls, [task.id, task.id]);
    });

    it("uses the latest of updated_at, comment ts, and attempt started_at", () => {
      const kanban = makeKanban();
      const task = kanban.createTask({ title: "Mission" }, "overmind");
      kanban.moveTask(task.id, "inprogress", 0, "drone-1");

      let fakeNow = Date.now();
      const watchdog = createWatchdog({ kanban, thresholdMs: 30 * 60 * 1000, now: () => fakeNow });

      // An attempt with a future started_at counts as fresh activity even
      // when updated_at would otherwise be considered stale.
      const future = new Date(fakeNow + 20 * 60 * 1000).toISOString();
      kanban.addAttempt(task.id, { agent: "drone-1", started_at: future });
      fakeNow += 45 * 60 * 1000; // 45min later: 25min after the attempt started
      assert.deepStrictEqual(watchdog.check(), []);

      fakeNow += 10 * 60 * 1000; // now 35min after the attempt
      assert.deepStrictEqual(watchdog.check(), [task.id]);
    });
  });
});
