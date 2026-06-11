const { describe, it } = require("node:test");
const assert = require("node:assert");

/** The component is browser ESM; node:test loads it via dynamic import. */
async function helpers() {
  return import("../public/js/components/detail-list.js");
}

describe("detail-list pure helpers", () => {
  const ROWS = [
    { id: "b", name: "Beta", count: 2, note: null },
    { id: "a", name: "alpha", count: 10, note: "first" },
    { id: "c", name: "Gamma", count: 1, note: "third" },
  ];

  describe("sortRows()", () => {
    it("sorts strings case-insensitively ascending and descending", async () => {
      const { sortRows } = await helpers();
      const asc = sortRows(ROWS, { key: "name", dir: "asc" }).map((r) => r.id);
      assert.deepStrictEqual(asc, ["a", "b", "c"]);
      const desc = sortRows(ROWS, { key: "name", dir: "desc" }).map((r) => r.id);
      assert.deepStrictEqual(desc, ["c", "b", "a"]);
    });

    it("sorts numbers numerically, not lexically", async () => {
      const { sortRows } = await helpers();
      const asc = sortRows(ROWS, { key: "count", dir: "asc" }).map((r) => r.count);
      assert.deepStrictEqual(asc, [1, 2, 10]);
    });

    it("pushes null/undefined values last and does not mutate input", async () => {
      const { sortRows } = await helpers();
      const before = [...ROWS];
      const sorted = sortRows(ROWS, { key: "note", dir: "asc" });
      assert.strictEqual(sorted[sorted.length - 1].id, "b");
      assert.deepStrictEqual(ROWS, before);
    });

    it("returns a copy when no sort is given", async () => {
      const { sortRows } = await helpers();
      const out = sortRows(ROWS, null);
      assert.deepStrictEqual(out, ROWS);
      assert.notStrictEqual(out, ROWS);
    });
  });

  describe("filterRows()", () => {
    it("matches case-insensitively across the given keys", async () => {
      const { filterRows } = await helpers();
      const out = filterRows(ROWS, "ALPH", ["name"]);
      assert.deepStrictEqual(
        out.map((r) => r.id),
        ["a"],
      );
    });

    it("ignores keys outside filterKeys", async () => {
      const { filterRows } = await helpers();
      const out = filterRows(ROWS, "third", ["name"]);
      assert.deepStrictEqual(out, []);
    });

    it("searches all values when filterKeys is empty, skipping null", async () => {
      const { filterRows } = await helpers();
      const out = filterRows(ROWS, "third", []);
      assert.deepStrictEqual(
        out.map((r) => r.id),
        ["c"],
      );
    });

    it("returns everything for a blank query", async () => {
      const { filterRows } = await helpers();
      assert.strictEqual(filterRows(ROWS, "  ", ["name"]).length, 3);
    });
  });
});
