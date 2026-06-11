const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  createGbrain,
  parseJsonOutput,
  parseTsvPages,
  parseExtractLinks,
  parseStatsText,
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
  { slug: "projects/alpha", title: "Project Alpha", type: "project" },
  { slug: "people/bob", title: "Bob", type: "person" },
  { id: "fallback-id", name: "No slug page" },
];

const LINKS = [
  { from: "projects/alpha", to: "people/bob", type: "mentions" },
  { source: "people/bob", target: "projects/alpha" },
  { from: "orphan-without-target" },
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

  describe("parseExtractLinks()", () => {
    it("parses NDJSON add_link lines followed by a pretty summary (real CLI shape)", () => {
      const out =
        '{"action":"add_link","from":"projects/alpha","to":"people/bob","type":"mentions","context":"..."}\n' +
        '{"action":"add_link","from":"people/bob","to":"projects/alpha","type":"link"}\n' +
        '{\n  "links_created": 2,\n  "timeline_entries_created": 0,\n  "pages_processed": 10\n}\n';
      const links = parseExtractLinks(out);
      assert.strictEqual(links.length, 2);
      assert.strictEqual(links[0].from, "projects/alpha");
      assert.strictEqual(links[1].to, "projects/alpha");
    });

    it("returns [] for a bare summary object with zero candidates", () => {
      const out =
        '{\n  "links_created": 0,\n  "timeline_entries_created": 0,\n  "pages_processed": 383\n}\n';
      assert.deepStrictEqual(parseExtractLinks(out), []);
    });

    it("accepts a plain JSON array or { links: [...] } envelope", () => {
      assert.strictEqual(parseExtractLinks(JSON.stringify(LINKS)).length, 3);
      assert.strictEqual(parseExtractLinks(JSON.stringify({ links: LINKS })).length, 3);
    });

    it("returns null for unusable output", () => {
      assert.strictEqual(parseExtractLinks("not json at all"), null);
      assert.strictEqual(parseExtractLinks(""), null);
      assert.strictEqual(parseExtractLinks(null), null);
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

  describe("getGraph()", () => {
    it("builds nodes from list and edges from extract links", async () => {
      const execFn = mockExecFn(({ args }) => {
        if (args[0] === "list") return { error: null, stdout: JSON.stringify(PAGES), stderr: "" };
        if (args[0] === "extract")
          return { error: null, stdout: JSON.stringify(LINKS), stderr: "" };
        return { error: new Error(`unexpected: ${args.join(" ")}`), stdout: "", stderr: "" };
      });
      const gbrain = createGbrain({ execFn });
      const graph = await gbrain.getGraph({ limit: 50 });

      assert.ok(!graph.error, graph.error);
      assert.deepStrictEqual(execFn.calls[0].args, ["list", "--limit", "50", "--json"]);
      assert.deepStrictEqual(execFn.calls[1].args, [
        "extract",
        "links",
        "--source",
        "db",
        "--dry-run",
        "--json",
      ]);

      assert.deepStrictEqual(graph.nodes, [
        { id: "projects/alpha", title: "Project Alpha", type: "project" },
        { id: "people/bob", title: "Bob", type: "person" },
        { id: "fallback-id", title: "No slug page", type: "page" },
      ]);
      // The link without a target is dropped; alt field names are normalized
      assert.deepStrictEqual(graph.edges, [
        { from: "projects/alpha", to: "people/bob", kind: "mentions" },
        { from: "people/bob", to: "projects/alpha", kind: "link" },
      ]);
    });

    it("builds nodes from TSV list and edges from NDJSON extract (real gbrain 0.12.x output)", async () => {
      const execFn = mockExecFn(({ args }) => {
        if (args[0] === "list") {
          return {
            error: null,
            stdout:
              "projects/alpha\tproject\tTue Jun 09\tProject Alpha\n" +
              "people/bob\tperson\tMon Jun 08\tBob\n",
            stderr: "",
          };
        }
        if (args[0] === "extract") {
          return {
            error: null,
            stdout:
              '{"action":"add_link","from":"projects/alpha","to":"people/bob","type":"mentions","context":"x"}\n' +
              '{\n  "links_created": 1,\n  "timeline_entries_created": 0,\n  "pages_processed": 2\n}\n',
            stderr: "",
          };
        }
        return { error: new Error(`unexpected: ${args.join(" ")}`), stdout: "", stderr: "" };
      });
      const gbrain = createGbrain({ execFn });
      const graph = await gbrain.getGraph({ limit: 10 });

      assert.ok(!graph.error, graph.error);
      assert.deepStrictEqual(graph.nodes, [
        { id: "projects/alpha", title: "Project Alpha", type: "project" },
        { id: "people/bob", title: "Bob", type: "person" },
      ]);
      assert.deepStrictEqual(graph.edges, [
        { from: "projects/alpha", to: "people/bob", kind: "mentions" },
      ]);
      assert.strictEqual(graph.note, undefined);
    });

    it("returns empty edges without a note when extract reports zero candidates", async () => {
      const execFn = mockExecFn(({ args }) => {
        if (args[0] === "list") {
          return { error: null, stdout: "a/b\tconcept\tTue Jun 09\tB\n", stderr: "" };
        }
        return {
          error: null,
          stdout:
            '{\n  "links_created": 0,\n  "timeline_entries_created": 0,\n  "pages_processed": 1\n}\n',
          stderr: "",
        };
      });
      const gbrain = createGbrain({ execFn });
      const graph = await gbrain.getGraph();
      assert.strictEqual(graph.nodes.length, 1);
      assert.deepStrictEqual(graph.edges, []);
      assert.strictEqual(graph.note, undefined);
    });

    it("degrades to empty edges with a note when link extraction fails", async () => {
      const execFn = mockExecFn(({ args }) => {
        if (args[0] === "list") return { error: null, stdout: JSON.stringify(PAGES), stderr: "" };
        return { error: new Error("extract not supported"), stdout: "", stderr: "" };
      });
      const gbrain = createGbrain({ execFn });
      const graph = await gbrain.getGraph();

      assert.strictEqual(graph.nodes.length, 3);
      assert.deepStrictEqual(graph.edges, []);
      assert.ok(graph.note.includes("link extraction unavailable"));
    });

    it("returns { error } when listing pages fails", async () => {
      const execFn = mockExecFn(() => ({ error: new Error("boom"), stdout: "", stderr: "" }));
      const gbrain = createGbrain({ execFn });
      const graph = await gbrain.getGraph();
      assert.ok(graph.error.includes("gbrain list failed"));
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

  describe("getGraph() provenance", () => {
    it("attaches total pages, db link count, and last-updated from stats + list", async () => {
      const execFn = mockExecFn(({ args }) => {
        if (args[0] === "list") {
          // gbrain list is sorted most-recently-updated first
          return {
            error: null,
            stdout:
              "projects/alpha\tproject\tThu Jun 11\tProject Alpha\n" +
              "people/bob\tperson\tMon Jun 08\tBob\n",
            stderr: "",
          };
        }
        if (args[0] === "extract") {
          return { error: null, stdout: '{\n  "links_created": 0\n}\n', stderr: "" };
        }
        if (args[0] === "stats") {
          return { error: null, stdout: STATS_TEXT_OUTPUT, stderr: "" };
        }
        return { error: new Error(`unexpected: ${args.join(" ")}`), stdout: "", stderr: "" };
      });
      const gbrain = createGbrain({ execFn });
      const graph = await gbrain.getGraph({ limit: 10 });

      assert.ok(!graph.error, graph.error);
      // The graph may render fewer nodes (list caps at 100) than the brain
      // holds — provenance must carry the TRUE page count from stats.
      assert.deepStrictEqual(graph.provenance, {
        totalPages: 383,
        dbLinks: 0,
        lastUpdated: "Thu Jun 11",
      });
    });

    it("falls back to the listed page count when stats is unusable", async () => {
      const execFn = mockExecFn(({ args }) => {
        if (args[0] === "list") return { error: null, stdout: JSON.stringify(PAGES), stderr: "" };
        if (args[0] === "extract")
          return { error: null, stdout: JSON.stringify(LINKS), stderr: "" };
        return { error: new Error("stats not supported"), stdout: "", stderr: "" };
      });
      const gbrain = createGbrain({ execFn });
      const graph = await gbrain.getGraph();

      assert.ok(!graph.error, graph.error);
      assert.strictEqual(graph.provenance.totalPages, 3);
      assert.strictEqual(graph.provenance.dbLinks, null);
    });
  });

  describe("getPage()", () => {
    it("passes hostile ids as a single argv element (no shell injection)", async () => {
      const execFn = mockExecFn(() => ({ error: null, stdout: "# Page\ncontent", stderr: "" }));
      const gbrain = createGbrain({ execFn });
      const hostileId = "page; rm -rf / $(reboot)";
      const result = await gbrain.getPage(hostileId);

      assert.deepStrictEqual(execFn.calls[0].args, ["get", hostileId]);
      assert.strictEqual(result.id, hostileId);
      assert.strictEqual(result.content, "# Page\ncontent");
    });

    it("returns { error } for empty content or CLI failure", async () => {
      const emptyFn = mockExecFn(() => ({ error: null, stdout: "   ", stderr: "" }));
      const gbrainEmpty = createGbrain({ execFn: emptyFn });
      assert.ok((await gbrainEmpty.getPage("slug")).error.includes("no content"));

      const failFn = mockExecFn(() => ({ error: new Error("nope"), stdout: "", stderr: "" }));
      const gbrainFail = createGbrain({ execFn: failFn });
      assert.ok((await gbrainFail.getPage("slug")).error.includes("gbrain get failed"));
    });

    it("rejects invalid ids without calling the CLI", async () => {
      const execFn = mockExecFn(() => ({ error: null, stdout: "x", stderr: "" }));
      const gbrain = createGbrain({ execFn });
      assert.ok((await gbrain.getPage("")).error);
      assert.ok((await gbrain.getPage(null)).error);
      assert.strictEqual(execFn.calls.length, 0);
    });
  });
});
