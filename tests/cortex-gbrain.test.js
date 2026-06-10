const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createGbrain, parseJsonOutput } = require("../src/cortex-gbrain");

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
