const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { createFleetChat } = require("../src/fleet-chat");

// Track created resources so every test gets a clean, disposable environment
const cleanups = [];

function makeChat(options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-chat-test-"));
  const stateDir = path.join(tmpDir, "state");
  const logsDir = path.join(tmpDir, "logs");
  const chat = createFleetChat({ stateDir, logsDir, ...options });
  cleanups.push(() => {
    chat.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  return { chat, stateDir, logsDir };
}

function makeClock(start = 1000000) {
  let now = start;
  return {
    nowFn: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

const validMsg = { sender: "drone-1", receiver: "overmind", payload: "status report" };

describe("fleet-chat module", () => {
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()();
  });

  describe("createFleetChat()", () => {
    it("requires stateDir and logsDir", () => {
      assert.throws(() => createFleetChat({}), /stateDir/);
      assert.throws(() => createFleetChat({ stateDir: "/tmp/x" }), /logsDir/);
    });

    it("creates state and logs directories", () => {
      const { stateDir, logsDir } = makeChat();
      assert.ok(fs.existsSync(stateDir));
      assert.ok(fs.existsSync(logsDir));
      assert.ok(fs.existsSync(path.join(stateDir, "fleet-chat.db")));
    });
  });

  describe("publish() validation", () => {
    it("rejects non-object messages", () => {
      const { chat } = makeChat();
      assert.throws(() => chat.publish(null), /message must be an object/);
      assert.throws(() => chat.publish("hi"), /message must be an object/);
      assert.throws(() => chat.publish([1, 2]), /message must be an object/);
    });

    it("rejects missing or empty sender", () => {
      const { chat } = makeChat();
      assert.throws(() => chat.publish({ ...validMsg, sender: undefined }), /sender/);
      assert.throws(() => chat.publish({ ...validMsg, sender: "" }), /sender/);
      assert.throws(() => chat.publish({ ...validMsg, sender: 42 }), /sender/);
    });

    it("rejects sender longer than 128 chars", () => {
      const { chat } = makeChat();
      assert.throws(() => chat.publish({ ...validMsg, sender: "x".repeat(129) }), /128/);
      // Exactly 128 is fine
      assert.ok(chat.publish({ ...validMsg, sender: "x".repeat(128) }));
    });

    it("rejects missing or oversized receiver", () => {
      const { chat } = makeChat();
      assert.throws(() => chat.publish({ ...validMsg, receiver: "" }), /receiver/);
      assert.throws(() => chat.publish({ ...validMsg, receiver: "r".repeat(129) }), /receiver/);
    });

    it("rejects non-string payload", () => {
      const { chat } = makeChat();
      assert.throws(() => chat.publish({ ...validMsg, payload: { a: 1 } }), /payload/);
      assert.throws(() => chat.publish({ ...validMsg, payload: undefined }), /payload/);
    });

    it("rejects payload over 32KB (byte length, not char length)", () => {
      const { chat } = makeChat();
      assert.throws(
        () => chat.publish({ ...validMsg, payload: "p".repeat(32 * 1024 + 1) }),
        /32768/,
      );
      // Multi-byte chars: 11000 chars of a 3-byte char is 33000 bytes
      assert.throws(() => chat.publish({ ...validMsg, payload: "€".repeat(11000) }), /32768/);
      // Exactly 32KB is fine
      assert.ok(chat.publish({ ...validMsg, payload: "p".repeat(32 * 1024) }));
    });

    it("rejects non-array toolCalls", () => {
      const { chat } = makeChat();
      assert.throws(() => chat.publish({ ...validMsg, toolCalls: "tool" }), /toolCalls/);
      assert.throws(() => chat.publish({ ...validMsg, toolCalls: {} }), /toolCalls/);
    });
  });

  describe("publish() record", () => {
    it("auto-assigns a short prefixed id", () => {
      const { chat } = makeChat();
      const record = chat.publish(validMsg);
      assert.match(record.id, /^msg_[0-9a-f]{12}$/);
    });

    it("assigns unique ids per message", () => {
      const { chat } = makeChat();
      const a = chat.publish(validMsg);
      const b = chat.publish(validMsg);
      assert.notStrictEqual(a.id, b.id);
    });

    it("assigns server ts from injected clock", () => {
      const clock = makeClock(555000);
      const { chat } = makeChat({ nowFn: clock.nowFn });
      const record = chat.publish({ ...validMsg, ts: 1 }); // Caller ts is ignored
      assert.strictEqual(record.ts, 555000);
    });

    it("round-trips toolCalls", () => {
      const { chat } = makeChat();
      const toolCalls = [{ name: "exec", args: { cmd: "ls" } }];
      chat.publish({ ...validMsg, toolCalls });
      const [stored] = chat.query({ limit: 1 });
      assert.deepStrictEqual(stored.toolCalls, toolCalls);
    });
  });

  describe("onMessage()", () => {
    it("notifies subscribers of published messages", () => {
      const { chat } = makeChat();
      const received = [];
      chat.onMessage((m) => received.push(m));
      const record = chat.publish(validMsg);
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0].id, record.id);
    });

    it("supports unsubscribe", () => {
      const { chat } = makeChat();
      const received = [];
      const unsubscribe = chat.onMessage((m) => received.push(m));
      chat.publish(validMsg);
      unsubscribe();
      chat.publish(validMsg);
      assert.strictEqual(received.length, 1);
    });

    it("isolates subscriber errors from other subscribers", () => {
      const { chat } = makeChat();
      const received = [];
      chat.onMessage(() => {
        throw new Error("boom");
      });
      chat.onMessage((m) => received.push(m));
      assert.ok(chat.publish(validMsg)); // Does not throw
      assert.strictEqual(received.length, 1);
    });

    it("rejects non-function callbacks", () => {
      const { chat } = makeChat();
      assert.throws(() => chat.onMessage("nope"), /callback/);
    });
  });

  describe("JSONL durable log", () => {
    it("appends one JSON line per message", () => {
      const { chat, logsDir } = makeChat();
      chat.publish(validMsg);
      chat.publish({ ...validMsg, payload: "second" });

      const lines = fs
        .readFileSync(path.join(logsDir, "fleet-chat.jsonl"), "utf8")
        .trim()
        .split("\n");
      assert.strictEqual(lines.length, 2);
      const parsed = lines.map((l) => JSON.parse(l));
      assert.strictEqual(parsed[0].payload, "status report");
      assert.strictEqual(parsed[1].payload, "second");
      assert.match(parsed[0].id, /^msg_/);
    });

    it("rotates the log when it exceeds maxLogBytes", () => {
      const { chat, logsDir } = makeChat({ maxLogBytes: 200 });
      for (let i = 0; i < 4; i++) {
        chat.publish({ ...validMsg, payload: `payload number ${i} `.repeat(5) });
      }

      const files = fs.readdirSync(logsDir);
      const rotated = files.filter((f) => f !== "fleet-chat.jsonl");
      assert.ok(rotated.length >= 1, `expected rotated files, got: ${files.join(", ")}`);
      assert.match(rotated[0], /^fleet-chat\..+\.jsonl$/);
    });

    it("keeps at most 5 rotated files", () => {
      const { chat, logsDir } = makeChat({ maxLogBytes: 10 }); // Every publish rotates
      for (let i = 0; i < 9; i++) {
        chat.publish({ ...validMsg, payload: `rotation trigger ${i}` });
      }

      const rotated = fs.readdirSync(logsDir).filter((f) => f !== "fleet-chat.jsonl");
      assert.ok(rotated.length >= 1);
      assert.ok(rotated.length <= 5, `expected <= 5 rotated files, got ${rotated.length}`);
    });
  });

  describe("query()", () => {
    it("filters by sender and receiver", () => {
      const { chat } = makeChat();
      chat.publish({ sender: "a", receiver: "b", payload: "one" });
      chat.publish({ sender: "a", receiver: "c", payload: "two" });
      chat.publish({ sender: "d", receiver: "b", payload: "three" });

      assert.strictEqual(chat.query({ sender: "a" }).length, 2);
      assert.strictEqual(chat.query({ receiver: "b" }).length, 2);
      assert.strictEqual(chat.query({ sender: "a", receiver: "b" }).length, 1);
      assert.strictEqual(chat.query({ sender: "nobody" }).length, 0);
    });

    it("does LIKE substring match on payload text", () => {
      const { chat } = makeChat();
      chat.publish({ ...validMsg, payload: "deploy started on hermes" });
      chat.publish({ ...validMsg, payload: "deploy finished" });
      chat.publish({ ...validMsg, payload: "unrelated" });

      assert.strictEqual(chat.query({ text: "deploy" }).length, 2);
      assert.strictEqual(chat.query({ text: "hermes" }).length, 1);
    });

    it("treats LIKE wildcards in text as literals", () => {
      const { chat } = makeChat();
      chat.publish({ ...validMsg, payload: "progress 100% done" });
      chat.publish({ ...validMsg, payload: "progress 100 done" });
      chat.publish({ ...validMsg, payload: "snake_case_name" });
      chat.publish({ ...validMsg, payload: "snakeXcaseXname" });

      assert.strictEqual(chat.query({ text: "100%" }).length, 1);
      assert.strictEqual(chat.query({ text: "snake_case" }).length, 1);
    });

    it("orders newest first and supports before filter", () => {
      const clock = makeClock(1000);
      const { chat } = makeChat({ nowFn: clock.nowFn });
      chat.publish({ ...validMsg, payload: "oldest" });
      clock.advance(1000);
      chat.publish({ ...validMsg, payload: "middle" });
      clock.advance(1000);
      chat.publish({ ...validMsg, payload: "newest" });

      const all = chat.query({});
      assert.deepStrictEqual(
        all.map((m) => m.payload),
        ["newest", "middle", "oldest"],
      );

      const before = chat.query({ before: 3000 });
      assert.deepStrictEqual(
        before.map((m) => m.payload),
        ["middle", "oldest"],
      );
    });

    it("applies limit and caps it at 500", () => {
      const clock = makeClock(1);
      const { chat } = makeChat({ nowFn: clock.nowFn });
      for (let i = 0; i < 510; i++) {
        chat.publish({ ...validMsg, payload: `m${i}` });
        clock.advance(1);
      }

      assert.strictEqual(chat.query({ limit: 3 }).length, 3);
      assert.strictEqual(chat.query({ limit: 9999 }).length, 500);
      // Default limit is 100
      assert.strictEqual(chat.query({}).length, 100);
    });

    it("rejects invalid filter types", () => {
      const { chat } = makeChat();
      assert.throws(() => chat.query({ sender: 42 }), /sender/);
      assert.throws(() => chat.query({ receiver: {} }), /receiver/);
      assert.throws(() => chat.query({ text: 7 }), /text/);
      assert.throws(() => chat.query({ before: "yesterday" }), /before/);
      assert.throws(() => chat.query({ limit: 0 }), /limit/);
    });

    it("stores SQL-injection-shaped payloads safely (parameterized)", () => {
      const { chat, stateDir } = makeChat();
      const hostile = "'; DROP TABLE messages; --";
      chat.publish({ sender: "evil'; --", receiver: "victim", payload: hostile });
      chat.publish({ ...validMsg, payload: "innocent" });

      // Payload stored verbatim, retrievable via filters
      const found = chat.query({ text: "DROP TABLE" });
      assert.strictEqual(found.length, 1);
      assert.strictEqual(found[0].payload, hostile);
      assert.strictEqual(chat.query({ sender: "evil'; --" }).length, 1);

      // Table still exists with both rows (verified via separate connection)
      const db = new DatabaseSync(path.join(stateDir, "fleet-chat.db"));
      const { count } = db.prepare("SELECT COUNT(*) AS count FROM messages").get();
      db.close();
      assert.strictEqual(Number(count), 2);
    });
  });

  describe("prune()", () => {
    it("removes messages older than maxAgeDays", () => {
      const dayMs = 24 * 60 * 60 * 1000;
      const clock = makeClock(100 * dayMs);
      const { chat } = makeChat({ nowFn: clock.nowFn });

      chat.publish({ ...validMsg, payload: "ancient" });
      clock.advance(40 * dayMs);
      chat.publish({ ...validMsg, payload: "fresh" });

      const result = chat.prune({ maxAgeDays: 30 });
      assert.strictEqual(result.removedByAge, 1);
      const remaining = chat.query({});
      assert.strictEqual(remaining.length, 1);
      assert.strictEqual(remaining[0].payload, "fresh");
    });

    it("caps row count at maxRows, keeping newest", () => {
      const clock = makeClock(1000);
      const { chat } = makeChat({ nowFn: clock.nowFn });
      for (let i = 0; i < 10; i++) {
        chat.publish({ ...validMsg, payload: `m${i}` });
        clock.advance(1000);
      }

      const result = chat.prune({ maxAgeDays: 365, maxRows: 4 });
      assert.strictEqual(result.removedByCount, 6);
      const remaining = chat.query({});
      assert.deepStrictEqual(
        remaining.map((m) => m.payload),
        ["m9", "m8", "m7", "m6"],
      );
    });

    it("rejects invalid options", () => {
      const { chat } = makeChat();
      assert.throws(() => chat.prune({ maxAgeDays: -1 }), /maxAgeDays/);
      assert.throws(() => chat.prune({ maxRows: NaN }), /maxRows/);
    });
  });

  describe("getState()", () => {
    it("returns recent messages and counts", () => {
      const clock = makeClock(1000);
      const { chat } = makeChat({ nowFn: clock.nowFn });
      for (let i = 0; i < 25; i++) {
        chat.publish({ sender: `s${i % 3}`, receiver: `r${i % 2}`, payload: `m${i}` });
        clock.advance(1);
      }
      chat.onMessage(() => {});

      const state = chat.getState();
      assert.strictEqual(state.messages.length, 20); // Recent slice only
      assert.strictEqual(state.messages[0].payload, "m24"); // Newest first
      assert.strictEqual(state.counts.total, 25);
      assert.strictEqual(state.counts.senders, 3);
      assert.strictEqual(state.counts.receivers, 2);
      assert.strictEqual(state.subscribers, 1);
    });
  });
});
