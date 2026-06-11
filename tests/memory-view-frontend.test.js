const { describe, it } = require("node:test");
const assert = require("node:assert");

/** The view module is browser ESM; node:test loads it via dynamic import. */
async function memoryHelpers() {
  return import("../public/js/views/memory.js");
}

describe("memory view pure helpers", () => {
  describe("classifyFileType()", () => {
    it("classifies date-stamped filenames as daily", async () => {
      const { classifyFileType } = await memoryHelpers();
      assert.strictEqual(classifyFileType("2026-06-11.md"), "daily");
      assert.strictEqual(classifyFileType("daily/2026-06-10-notes.md"), "daily");
    });

    it("classifies everything else as state", async () => {
      const { classifyFileType } = await memoryHelpers();
      assert.strictEqual(classifyFileType("heartbeat-state.json"), "state");
      assert.strictEqual(classifyFileType("notes.md"), "state");
      assert.strictEqual(classifyFileType(""), "state");
      assert.strictEqual(classifyFileType(null), "state");
    });
  });

  describe("buildFileRows()", () => {
    const MEMORY = {
      recentFiles: [
        { name: "2026-06-11.md", sizeFormatted: "4.2 KB", age: "2h" },
        { name: "heartbeat-state.json", sizeFormatted: "812 B", age: "5m" },
        { name: "no-meta.md" },
        { sizeFormatted: "1 KB" }, // no name — dropped
        null,
      ],
    };

    it("flattens recent files into rows with derived type", async () => {
      const { buildFileRows } = await memoryHelpers();
      const rows = buildFileRows(MEMORY);
      assert.strictEqual(rows.length, 3);
      assert.deepStrictEqual(rows[0], {
        name: "2026-06-11.md",
        type: "daily",
        size: "4.2 KB",
        age: "2h",
      });
      assert.strictEqual(rows[1].type, "state");
    });

    it("defaults missing size/age to em dashes", async () => {
      const { buildFileRows } = await memoryHelpers();
      const rows = buildFileRows(MEMORY);
      assert.strictEqual(rows[2].size, "—");
      assert.strictEqual(rows[2].age, "—");
    });

    it("returns an empty array for missing/invalid payloads", async () => {
      const { buildFileRows } = await memoryHelpers();
      assert.deepStrictEqual(buildFileRows(null), []);
      assert.deepStrictEqual(buildFileRows({}), []);
      assert.deepStrictEqual(buildFileRows({ recentFiles: "nope" }), []);
    });
  });

  describe("countText()", () => {
    it("pluralizes the file count", async () => {
      const { countText } = await memoryHelpers();
      assert.strictEqual(countText(0), "0 files");
      assert.strictEqual(countText(1), "1 file");
      assert.strictEqual(countText(12), "12 files");
    });

    it("treats missing counts as zero", async () => {
      const { countText } = await memoryHelpers();
      assert.strictEqual(countText(undefined), "0 files");
      assert.strictEqual(countText("nope"), "0 files");
    });
  });

  describe("linesText()", () => {
    it("formats a positive line count", async () => {
      const { linesText } = await memoryHelpers();
      assert.strictEqual(linesText(184), "· 184 lines");
    });

    it("renders an em dash for zero/missing counts", async () => {
      const { linesText } = await memoryHelpers();
      assert.strictEqual(linesText(0), "· —");
      assert.strictEqual(linesText(undefined), "· —");
      assert.strictEqual(linesText("x"), "· —");
    });
  });
});
