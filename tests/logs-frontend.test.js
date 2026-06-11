/**
 * Tests for the pure (DOM-free) helpers exported by the Logs view module:
 * free-text search matching, client-side pagination, and the count summary.
 * The module is browser ESM, so it is loaded via dynamic import.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert");

let entryMatchesSearch;
let paginate;
let summarize;

before(async () => {
  const mod = await import("../public/js/views/logs.js");
  entryMatchesSearch = mod.entryMatchesSearch;
  paginate = mod.paginate;
  summarize = mod.summarize;
});

const ENTRY = {
  id: "aud_1",
  ts: "2026-06-11T10:00:00.000Z",
  user: "alice@example.com",
  action: "task.move",
  target: "tsk_42",
  detail: { to: "review", note: "Promoted by Watchdog" },
};

describe("entryMatchesSearch()", () => {
  it("matches everything on an empty/blank/nullish term", () => {
    assert.strictEqual(entryMatchesSearch(ENTRY, ""), true);
    assert.strictEqual(entryMatchesSearch(ENTRY, "   "), true);
    assert.strictEqual(entryMatchesSearch(ENTRY, null), true);
    assert.strictEqual(entryMatchesSearch(ENTRY, undefined), true);
  });

  it("matches user, action, target and timestamp case-insensitively", () => {
    assert.strictEqual(entryMatchesSearch(ENTRY, "ALICE"), true);
    assert.strictEqual(entryMatchesSearch(ENTRY, "task.move"), true);
    assert.strictEqual(entryMatchesSearch(ENTRY, "TSK_42"), true);
    assert.strictEqual(entryMatchesSearch(ENTRY, "2026-06-11"), true);
  });

  it("matches inside the JSON-serialized detail", () => {
    assert.strictEqual(entryMatchesSearch(ENTRY, "watchdog"), true);
    assert.strictEqual(entryMatchesSearch(ENTRY, '"to":"review"'), true);
  });

  it("rejects non-matching terms and malformed entries", () => {
    assert.strictEqual(entryMatchesSearch(ENTRY, "no-such-string"), false);
    assert.strictEqual(entryMatchesSearch(null, "x"), false);
    assert.strictEqual(entryMatchesSearch("not-an-object", "x"), false);
  });

  it("tolerates entries with null target/detail", () => {
    const sparse = { ...ENTRY, target: null, detail: null };
    assert.strictEqual(entryMatchesSearch(sparse, "alice"), true);
    assert.strictEqual(entryMatchesSearch(sparse, "review"), false);
  });
});

describe("paginate()", () => {
  const list = Array.from({ length: 120 }, (_, i) => i);

  it("slices the requested page", () => {
    const { items, page, totalPages, total } = paginate(list, 2, 50);
    assert.deepStrictEqual(items[0], 50);
    assert.strictEqual(items.length, 50);
    assert.strictEqual(page, 2);
    assert.strictEqual(totalPages, 3);
    assert.strictEqual(total, 120);
  });

  it("clamps out-of-range pages into the valid range", () => {
    assert.strictEqual(paginate(list, 99, 50).page, 3);
    assert.strictEqual(paginate(list, 0, 50).page, 1);
    assert.strictEqual(paginate(list, -5, 50).page, 1);
    assert.deepStrictEqual(paginate(list, 99, 50).items.length, 20);
  });

  it("reports a single page for empty or short lists", () => {
    assert.deepStrictEqual(paginate([], 1, 50), {
      items: [],
      page: 1,
      totalPages: 1,
      total: 0,
    });
    assert.strictEqual(paginate([1, 2], 1, 50).totalPages, 1);
  });

  it("tolerates non-array input and bad page sizes", () => {
    assert.deepStrictEqual(paginate(null, 1, 50).items, []);
    const fallback = paginate(list, 1, 0);
    assert.ok(fallback.items.length > 0, "falls back to the default page size");
  });
});

describe("summarize()", () => {
  it("counts entries, distinct actions and distinct actors", () => {
    const entries = [
      { user: "alice", action: "task.move" },
      { user: "alice", action: "task.move" },
      { user: "bob", action: "brief.write" },
      { user: "bob", action: "settings.update" },
    ];
    assert.deepStrictEqual(summarize(entries), { entries: 4, actions: 3, actors: 2 });
  });

  it("handles empty and malformed input", () => {
    assert.deepStrictEqual(summarize([]), { entries: 0, actions: 0, actors: 0 });
    assert.deepStrictEqual(summarize(null), { entries: 0, actions: 0, actors: 0 });
    assert.deepStrictEqual(summarize([{}, { user: "a" }]), { entries: 2, actions: 0, actors: 1 });
  });
});
