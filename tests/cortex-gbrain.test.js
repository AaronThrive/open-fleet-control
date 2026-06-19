const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  createGbrain,
  parseJsonOutput,
  parseTsvPages,
  parseStatsText,
  toMemoryItem,
} = require("../src/cortex-gbrain");

/** Verbatim `gbrain stats` text output from gbrain 0.12.3 on a live host. */
const STATS_TEXT_OUTPUT =
  "Pages:     383\n" +
  "Chunks:    1582\n" +
  "Embedded:  1582\n" +
  "Links:     0\n" +
  "Tags:      8\n" +
  "Timeline:  0\n" +
  "\n" +
  "By type:\n" +
  "  concept: 379\n" +
  "  system: 3\n" +
  "  reference: 1\n";

function mockExecFn(responder) {
  const calls = [];
  const fn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return responder({ cmd, args, opts, callIndex: calls.length - 1 });
  };
  fn.calls = calls;
  return fn;
}

const PAGES = [
  { slug: "projects/alpha", title: "Project Alpha", type: "project", updated_at: "Thu Jun 11" },
  { slug: "people/bob", title: "Bob", type: "person", updated_at: "Mon Jun 08" },
  { id: "fallback-id", name: "No slug page" },
];

describe("cortex-gbrain module", () => {
  describe("parseJsonOutput()", () => {
    it("parses clean JSON", () => {
      assert.deepStrictEqual(parseJsonOutput('[{"a":1}]'), [{ a: 1 }]);
    });

    it("parses JSON surrounded by noise", () => {
      assert.deepStrictEqual(parseJsonOutput('warming up...\n[{"a":1}]\ndone'), [{ a: 1 }]);
    });

    it("returns null for non-JSON output (broken bundle error)", () => {
      assert.strictEqual(
        parseJsonOutput("ENOENT: no such file or directory, open '/$bunfs/root/pglite.data'"),
        null,
      );
    });
  });

  describe("parseTsvPages()", () => {
    it("parses gbrain list TSV output (slug\\ttype\\tdate\\ttitle)", () => {
      const tsv =
        "projects/alpha\tproject\tTue Jun 09\tProject Alpha\n" +
        "people/bob\tperson\tMon Jun 08\tBob\n";
      assert.deepStrictEqual(parseTsvPages(tsv), [
        {
          slug: "projects/alpha",
          type: "project",
          updated_at: "Tue Jun 09",
          title: "Project Alpha",
        },
        { slug: "people/bob", type: "person", updated_at: "Mon Jun 08", title: "Bob" },
      ]);
    });

    it("returns an empty array for 'No pages found.'", () => {
      assert.deepStrictEqual(parseTsvPages("No pages found.\n"), []);
    });

    it("returns null for non-TSV output (broken bundle error line)", () => {
      assert.strictEqual(
        parseTsvPages("ENOENT: no such file or directory, open '/$bunfs/root/pglite.data'"),
        null,
      );
      assert.strictEqual(parseTsvPages(""), null);
      assert.strictEqual(parseTsvPages(null), null);
    });
  });

  describe("toMemoryItem()", () => {
    it("normalizes a page record into a memory-browser item", () => {
      assert.deepStrictEqual(
        toMemoryItem({ slug: "a/b", title: "B", type: "concept", updated_at: "Tue Jun 09" }),
        { id: "a/b", title: "B", type: "concept", updatedAt: "Tue Jun 09" },
      );
    });

    it("falls back through id/name and defaults type to page", () => {
      assert.deepStrictEqual(toMemoryItem({ id: "x", name: "X" }), {
        id: "x",
        title: "X",
        type: "page",
        updatedAt: null,
      });
    });

    it("returns null for records with no id/slug", () => {
      assert.strictEqual(toMemoryItem({ title: "no id" }), null);
      assert.strictEqual(toMemoryItem(null), null);
    });
  });

  describe("available()", () => {
    it("probes with list --limit 1 --json using an args array", async () => {
      const execFn = mockExecFn(() => ({ error: null, stdout: "[]", stderr: "" }));
      const gbrain = createGbrain({ cliPath: "/opt/gbrain", execFn });
      const result = await gbrain.available();

      assert.strictEqual(result.available, true);
      assert.strictEqual(result.reason, null);
      const call = execFn.calls[0];
      assert.strictEqual(call.cmd, "/opt/gbrain");
      assert.ok(Array.isArray(call.args));
      assert.deepStrictEqual(call.args, ["list", "--limit", "1", "--json"]);
    });

    it("applies a 15s timeout to CLI calls", async () => {
      const execFn = mockExecFn(() => ({ error: null, stdout: "[]", stderr: "" }));
      const gbrain = createGbrain({ execFn });
      await gbrain.available();
      assert.strictEqual(execFn.calls[0].opts.timeoutMs, 15000);
    });

    it("reports unavailable when the binary is missing", async () => {
      const execFn = mockExecFn(() => ({
        error: new Error("spawn gbrain ENOENT"),
        stdout: "",
        stderr: "",
      }));
      const gbrain = createGbrain({ cliPath: "/missing/gbrain", execFn });
      const result = await gbrain.available();
      assert.strictEqual(result.available, false);
      assert.ok(result.reason.includes("gbrain CLI failed"));
      assert.ok(result.reason.includes("/missing/gbrain"));
    });

    it("reports unavailable when the CLI runs but emits no JSON (broken pglite bundle)", async () => {
      const execFn = mockExecFn(() => ({
        error: null,
        stdout: "ENOENT: no such file or directory, open '/$bunfs/root/pglite.data'",
        stderr: "",
      }));
      const gbrain = createGbrain({ execFn });
      const result = await gbrain.available();
      assert.strictEqual(result.available, false);
      assert.ok(result.reason.includes("no usable JSON"));
      assert.ok(result.reason.includes("pglite.data"));
    });

    it("reports available when the CLI emits TSV instead of JSON (gbrain <= 0.12.x)", async () => {
      const execFn = mockExecFn(() => ({
        error: null,
        stdout: "projects/alpha\tproject\tTue Jun 09\tProject Alpha\n",
        stderr: "",
      }));
      const gbrain = createGbrain({ execFn });
      const result = await gbrain.available();
      assert.strictEqual(result.available, true);
      assert.strictEqual(result.reason, null);
    });
  });

  describe("list()", () => {
    it("lists ALL pages with no --limit cap and shapes { items, total }", async () => {
      const execFn = mockExecFn(({ args }) => {
        if (args[0] === "list") return { error: null, stdout: JSON.stringify(PAGES), stderr: "" };
        return { error: new Error(`unexpected: ${args.join(" ")}`), stdout: "", stderr: "" };
      });
      const gbrain = createGbrain({ execFn });
      const result = await gbrain.list();

      // No --limit flag: the memory browser shows the whole brain.
      assert.deepStrictEqual(execFn.calls[0].args, ["list", "--json"]);
      assert.strictEqual(result.total, 3);
      assert.deepStrictEqual(result.items, [
        { id: "projects/alpha", title: "Project Alpha", type: "project", updatedAt: "Thu Jun 11" },
        { id: "people/bob", title: "Bob", type: "person", updatedAt: "Mon Jun 08" },
        { id: "fallback-id", title: "No slug page", type: "page", updatedAt: null },
      ]);
    });

    it("parses TSV list output (gbrain <= 0.12.x)", async () => {
      const execFn = mockExecFn(() => ({
        error: null,
        stdout:
          "projects/alpha\tproject\tTue Jun 09\tProject Alpha\n" +
          "people/bob\tperson\tMon Jun 08\tBob\n",
        stderr: "",
      }));
      const gbrain = createGbrain({ execFn });
      const result = await gbrain.list();
      assert.strictEqual(result.total, 2);
      assert.strictEqual(result.items[0].id, "projects/alpha");
      assert.strictEqual(result.items[0].updatedAt, "Tue Jun 09");
    });

    it("paginates with limit and offset over the full set", async () => {
      const execFn = mockExecFn(() => ({ error: null, stdout: JSON.stringify(PAGES), stderr: "" }));
      const gbrain = createGbrain({ execFn });
      const result = await gbrain.list({ limit: 1, offset: 1 });
      assert.strictEqual(result.total, 3);
      assert.strictEqual(result.items.length, 1);
      assert.strictEqual(result.items[0].id, "people/bob");
    });

    it("filters by case-insensitive substring on title/slug via query", async () => {
      const execFn = mockExecFn(() => ({ error: null, stdout: JSON.stringify(PAGES), stderr: "" }));
      const gbrain = createGbrain({ execFn });
      const byTitle = await gbrain.list({ query: "bob" });
      assert.strictEqual(byTitle.total, 1);
      assert.strictEqual(byTitle.items[0].id, "people/bob");

      const bySlug = await gbrain.list({ query: "projects/" });
      assert.strictEqual(bySlug.total, 1);
      assert.strictEqual(bySlug.items[0].id, "projects/alpha");
    });

    it("returns { error } when listing pages fails", async () => {
      const execFn = mockExecFn(() => ({ error: new Error("boom"), stdout: "", stderr: "" }));
      const gbrain = createGbrain({ execFn });
      const result = await gbrain.list();
      assert.ok(result.error.includes("gbrain list failed"));
    });
  });

  describe("search()", () => {
    it("is a thin filter over list()", async () => {
      const execFn = mockExecFn(() => ({ error: null, stdout: JSON.stringify(PAGES), stderr: "" }));
      const gbrain = createGbrain({ execFn });
      const result = await gbrain.search("alpha");
      assert.strictEqual(result.total, 1);
      assert.strictEqual(result.items[0].id, "projects/alpha");
    });

    it("rejects an empty query without calling the CLI", async () => {
      const execFn = mockExecFn(() => ({ error: null, stdout: "[]", stderr: "" }));
      const gbrain = createGbrain({ execFn });
      assert.ok((await gbrain.search("")).error);
      assert.ok((await gbrain.search("   ")).error);
      assert.strictEqual(execFn.calls.length, 0);
    });
  });

  describe("stats()", () => {
    it("returns the TRUE page count from gbrain stats plus newest lastUpdated", async () => {
      const execFn = mockExecFn(({ args }) => {
        if (args[0] === "list") {
          return {
            error: null,
            stdout:
              "projects/alpha\tproject\tThu Jun 11\tProject Alpha\n" +
              "people/bob\tperson\tMon Jun 08\tBob\n",
            stderr: "",
          };
        }
        if (args[0] === "stats") return { error: null, stdout: STATS_TEXT_OUTPUT, stderr: "" };
        return { error: new Error(`unexpected: ${args.join(" ")}`), stdout: "", stderr: "" };
      });
      const gbrain = createGbrain({ execFn });
      const result = await gbrain.stats();
      // list cap < true count: page count must come from stats (383), not 2.
      assert.deepStrictEqual(result, { pageCount: 383, lastUpdated: "Thu Jun 11" });
    });

    it("falls back to the listed page count when stats is unusable", async () => {
      const execFn = mockExecFn(({ args }) => {
        if (args[0] === "list") return { error: null, stdout: JSON.stringify(PAGES), stderr: "" };
        return { error: new Error("stats not supported"), stdout: "", stderr: "" };
      });
      const gbrain = createGbrain({ execFn });
      const result = await gbrain.stats();
      assert.strictEqual(result.pageCount, 3);
      assert.strictEqual(result.lastUpdated, "Thu Jun 11");
    });

    it("returns { error } when listing pages fails", async () => {
      const execFn = mockExecFn(() => ({ error: new Error("boom"), stdout: "", stderr: "" }));
      const gbrain = createGbrain({ execFn });
      assert.ok((await gbrain.stats()).error.includes("gbrain list failed"));
    });
  });

  describe("parseStatsText()", () => {
    it("parses gbrain stats text output (pages/links/chunks counts)", () => {
      assert.deepStrictEqual(parseStatsText(STATS_TEXT_OUTPUT), {
        pages: 383,
        chunks: 1582,
        embedded: 1582,
        links: 0,
        tags: 8,
      });
    });

    it("returns null for unusable output (broken bundle error, empty)", () => {
      assert.strictEqual(parseStatsText("ENOENT: no such file or directory"), null);
      assert.strictEqual(parseStatsText(""), null);
      assert.strictEqual(parseStatsText(null), null);
    });
  });

  describe("get() / getPage()", () => {
    it("passes hostile ids as a single argv element (no shell injection)", async () => {
      const execFn = mockExecFn(() => ({ error: null, stdout: "# Page\ncontent", stderr: "" }));
      const gbrain = createGbrain({ execFn });
      const hostileId = "page; rm -rf / $(reboot)";
      const result = await gbrain.get(hostileId);

      assert.deepStrictEqual(execFn.calls[0].args, ["get", hostileId]);
      assert.strictEqual(result.id, hostileId);
      assert.strictEqual(result.content, "# Page\ncontent");
    });

    it("returns { error } for empty content or CLI failure", async () => {
      const emptyFn = mockExecFn(() => ({ error: null, stdout: "   ", stderr: "" }));
      const gbrainEmpty = createGbrain({ execFn: emptyFn });
      assert.ok((await gbrainEmpty.get("slug")).error.includes("no content"));

      const failFn = mockExecFn(() => ({ error: new Error("nope"), stdout: "", stderr: "" }));
      const gbrainFail = createGbrain({ execFn: failFn });
      assert.ok((await gbrainFail.get("slug")).error.includes("gbrain get failed"));
    });

    it("rejects invalid ids without calling the CLI", async () => {
      const execFn = mockExecFn(() => ({ error: null, stdout: "x", stderr: "" }));
      const gbrain = createGbrain({ execFn });
      assert.ok((await gbrain.get("")).error);
      assert.ok((await gbrain.get(null)).error);
      assert.strictEqual(execFn.calls.length, 0);
    });
  });
});
