const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const {
  createLanceMemory,
  extractJsonPayload,
  parseStatsText,
  EXPORT_FORMAT_VERSION,
} = require("../src/cortex-lancedb");

// --- Test helpers (pure dependency injection; no real CLI, no real ~/.openclaw) ---

function mockExecFn(responder) {
  const calls = [];
  const fn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return responder({ cmd, args, opts, callIndex: calls.length - 1 });
  };
  fn.calls = calls;
  return fn;
}

const failingLoader = () => {
  throw new Error("Cannot find module '@lancedb/lancedb'");
};

function fakeLanceLoader(rows, captured = {}) {
  return () => ({
    connect: async (connectedPath) => {
      captured.connectedPath = connectedPath;
      return {
        openTable: async (tableName) => {
          captured.tableName = tableName;
          return {
            countRows: async () => rows.length,
            query: () => {
              const builder = {
                where(clause) {
                  captured.where = clause;
                  return builder;
                },
                limit(n) {
                  captured.limit = n;
                  return builder;
                },
                toArray: async () => rows,
              };
              return builder;
            },
          };
        },
      };
    },
  });
}

/**
 * Lance loader whose toArray() returns the next rows array from a sequence
 * (last entry repeats). Lets tests model "row exists, then it's gone".
 */
function sequencedLanceLoader(sequence, captured = {}) {
  let call = 0;
  return () => ({
    connect: async () => ({
      openTable: async () => ({
        countRows: async () => (sequence[sequence.length - 1] || []).length,
        query: () => {
          const builder = {
            where(clause) {
              captured.where = clause;
              return builder;
            },
            limit(n) {
              captured.limit = n;
              return builder;
            },
            toArray: async () => {
              const rows = sequence[Math.min(call, sequence.length - 1)];
              call += 1;
              return rows;
            },
          };
          return builder;
        },
      }),
    }),
  });
}

// Plugin log noise that the real openclaw CLI interleaves with output
const LOG_NOISE = "[90m05:48:36[39m [35m[plugins][39m [36m[headroom] Plugin registered[39m\n";

// Fixture mirroring the documented `openclaw memory-pro export` format
const EXPORT_FIXTURE = {
  version: "1.0",
  exportedAt: "2026-06-10T05:50:54.068Z",
  count: 1,
  filters: {},
  memories: [
    {
      id: "memory-test:global:20260607T205517Z",
      text: "global memory visibility test",
      category: "fact",
      scope: "global",
      importance: 0.81,
      timestamp: 1780865717037,
      metadata: '{"source":"legacy","l0_abstract":"abstract","l1_overview":"overview"}',
    },
  ],
};

describe("cortex-lancedb module", () => {
  describe("extractJsonPayload()", () => {
    it("extracts a JSON array buried in ANSI log noise", () => {
      const payload = [{ entry: { id: "a1", text: "hello" }, score: 0.5 }];
      const noisy = LOG_NOISE + JSON.stringify(payload) + "\n" + LOG_NOISE;
      assert.deepStrictEqual(extractJsonPayload(noisy), payload);
    });

    it("returns null when no JSON is present", () => {
      assert.strictEqual(extractJsonPayload(LOG_NOISE + "no json here"), null);
      assert.strictEqual(extractJsonPayload(""), null);
      assert.strictEqual(extractJsonPayload(null), null);
    });

    it("skips bracket-looking noise like [plugins] before real JSON", () => {
      const noisy = "[plugins] starting [39m\n" + '{"ok":true}';
      assert.deepStrictEqual(extractJsonPayload(noisy), { ok: true });
    });
  });

  describe("available()", () => {
    it("reports unavailable with reasons when CLI and module are both missing", async () => {
      const execFn = mockExecFn(() => ({
        error: new Error("spawn openclaw ENOENT"),
        stdout: "",
        stderr: "",
      }));
      const memory = createLanceMemory({
        dbPath: "/nonexistent/lancedb",
        execFn,
        lanceModuleLoader: failingLoader,
      });
      const result = await memory.available();
      assert.strictEqual(result.available, false);
      assert.strictEqual(result.cli, false);
      assert.strictEqual(result.lancedb, false);
      assert.ok(result.reason.includes("openclaw CLI unavailable"));
      assert.ok(result.reason.includes("@lancedb/lancedb not loadable"));
    });

    it("is available when only the CLI works", async () => {
      const execFn = mockExecFn(() => ({ error: null, stdout: LOG_NOISE, stderr: "" }));
      const memory = createLanceMemory({
        dbPath: "/nonexistent/lancedb",
        execFn,
        lanceModuleLoader: failingLoader,
      });
      const result = await memory.available();
      assert.strictEqual(result.available, true);
      assert.strictEqual(result.cli, true);
      assert.strictEqual(result.lancedb, false);
      // Availability probe used memory-pro stats
      assert.deepStrictEqual(execFn.calls[0].args, ["memory-pro", "stats", "--json"]);
    });

    it("is available for direct reads when module loads and dataset exists", async () => {
      const execFn = mockExecFn(() => ({
        error: new Error("spawn openclaw ENOENT"),
        stdout: "",
        stderr: "",
      }));
      const memory = createLanceMemory({
        dbPath: os.tmpdir(), // any existing directory
        execFn,
        lanceModuleLoader: fakeLanceLoader([]),
      });
      const result = await memory.available();
      assert.strictEqual(result.available, true);
      assert.strictEqual(result.lancedb, true);
    });
  });

  describe("search()", () => {
    it("builds an args array (no shell interpolation possible)", async () => {
      const execFn = mockExecFn(() => ({ error: null, stdout: "[]", stderr: "" }));
      const memory = createLanceMemory({ execFn, lanceModuleLoader: failingLoader });
      const hostileQuery = 'foo"; rm -rf / #';
      await memory.search(hostileQuery, { limit: 5, scope: "global" });

      const call = execFn.calls[0];
      assert.strictEqual(call.cmd, "openclaw");
      assert.ok(Array.isArray(call.args), "args must be an array, not a shell string");
      assert.deepStrictEqual(call.args, [
        "memory-pro",
        "search",
        hostileQuery,
        "--json",
        "--limit",
        "5",
        "--scope",
        "global",
      ]);
    });

    it("parses JSON results from noisy stderr and strips vectors", async () => {
      const hits = [
        {
          entry: {
            id: "id-1",
            text: "remember this",
            vector: [0.1, 0.2, 0.3],
            category: "fact",
            scope: "agent:main",
            importance: 0.9,
            timestamp: 123,
            metadata: '{"l0_abstract":"a"}',
          },
          score: 0.87,
        },
      ];
      const execFn = mockExecFn(() => ({
        error: null,
        stdout: LOG_NOISE,
        stderr: LOG_NOISE + JSON.stringify(hits) + "\n" + LOG_NOISE,
      }));
      const memory = createLanceMemory({ execFn, lanceModuleLoader: failingLoader });
      const result = await memory.search("remember");

      assert.ok(!result.error, result.error);
      assert.strictEqual(result.results.length, 1);
      const hit = result.results[0];
      assert.strictEqual(hit.id, "id-1");
      assert.strictEqual(hit.score, 0.87);
      assert.strictEqual(hit.vector, undefined);
      assert.deepStrictEqual(hit.metadata, { l0_abstract: "a" });
    });

    it("returns an error object (not a throw) when CLI fails", async () => {
      const execFn = mockExecFn(() => ({
        error: new Error("timeout"),
        stdout: "",
        stderr: "",
      }));
      const memory = createLanceMemory({ execFn, lanceModuleLoader: failingLoader });
      const result = await memory.search("anything");
      assert.ok(result.error.includes("memory-pro search failed"));
    });

    it("returns an error when output contains no JSON", async () => {
      const execFn = mockExecFn(() => ({ error: null, stdout: LOG_NOISE, stderr: LOG_NOISE }));
      const memory = createLanceMemory({ execFn, lanceModuleLoader: failingLoader });
      const result = await memory.search("anything");
      assert.ok(result.error.includes("could not parse JSON"));
    });

    it("rejects empty queries without calling the CLI", async () => {
      const execFn = mockExecFn(() => ({ error: null, stdout: "[]", stderr: "" }));
      const memory = createLanceMemory({ execFn, lanceModuleLoader: failingLoader });
      const result = await memory.search("   ");
      assert.ok(result.error);
      assert.strictEqual(execFn.calls.length, 0);
    });
  });

  describe("list() / get() via direct LanceDB reads", () => {
    const sampleRow = {
      id: "row-1",
      text: "stored memory",
      vector: [1, 2, 3],
      category: "fact",
      scope: "global",
      importance: 0.5,
      timestamp: 42,
      metadata: '{"tier":"hot"}',
    };

    it("lists rows with scope/category filters and strips vectors", async () => {
      const captured = {};
      const memory = createLanceMemory({
        dbPath: os.tmpdir(),
        execFn: mockExecFn(() => ({ error: null, stdout: "", stderr: "" })),
        lanceModuleLoader: fakeLanceLoader([sampleRow], captured),
      });
      const result = await memory.list({ limit: 7, scope: "global", category: "fact" });

      assert.ok(!result.error, result.error);
      assert.strictEqual(captured.tableName, "memories");
      assert.strictEqual(captured.where, "scope = 'global' AND category = 'fact'");
      assert.strictEqual(captured.limit, 7);
      assert.strictEqual(result.items[0].id, "row-1");
      assert.strictEqual(result.items[0].vector, undefined);
      assert.deepStrictEqual(result.items[0].metadata, { tier: "hot" });
    });

    it("escapes single quotes in filter values (no filter injection)", async () => {
      const captured = {};
      const memory = createLanceMemory({
        dbPath: os.tmpdir(),
        execFn: mockExecFn(() => ({ error: null, stdout: "", stderr: "" })),
        lanceModuleLoader: fakeLanceLoader([sampleRow], captured),
      });
      await memory.get("abc' OR '1'='1");
      assert.strictEqual(captured.where, "id = 'abc'' OR ''1''=''1'");
    });

    it("returns { error } when the lance module is unavailable", async () => {
      const memory = createLanceMemory({
        dbPath: os.tmpdir(),
        execFn: mockExecFn(() => ({ error: null, stdout: "", stderr: "" })),
        lanceModuleLoader: failingLoader,
      });
      const listResult = await memory.list();
      assert.ok(listResult.error.includes("@lancedb/lancedb not loadable"));
      const getResult = await memory.get("some-id");
      assert.ok(getResult.error.includes("@lancedb/lancedb not loadable"));
    });

    it("returns { error } for a missing id", async () => {
      const memory = createLanceMemory({
        dbPath: os.tmpdir(),
        execFn: mockExecFn(() => ({ error: null, stdout: "", stderr: "" })),
        lanceModuleLoader: fakeLanceLoader([]),
      });
      const result = await memory.get("nope");
      assert.ok(result.error.includes("memory not found"));
    });
  });

  describe("store()", () => {
    it("writes an export-format temp file and imports it via the CLI", async () => {
      let importedPayload = null;
      const execFn = mockExecFn(({ args }) => {
        // Read the temp file while it still exists (deleted after import)
        if (args[1] === "import") {
          importedPayload = JSON.parse(fs.readFileSync(args[2], "utf8"));
        }
        return { error: null, stdout: LOG_NOISE, stderr: "" };
      });
      const memory = createLanceMemory({ execFn, lanceModuleLoader: failingLoader });
      const result = await memory.store("a brand new memory", {
        category: "decision",
        scope: "agent:main",
        importance: 0.95,
      });

      assert.strictEqual(result.ok, true);
      assert.ok(result.id);

      // CLI invocation: import <tmpfile> --scope agent:main
      const call = execFn.calls[0];
      assert.strictEqual(call.cmd, "openclaw");
      assert.strictEqual(call.args[0], "memory-pro");
      assert.strictEqual(call.args[1], "import");
      assert.ok(call.args[2].startsWith(os.tmpdir()), "temp file must live in os.tmpdir()");
      assert.deepStrictEqual(call.args.slice(3), ["--scope", "agent:main"]);

      // Temp file must be cleaned up afterwards
      assert.strictEqual(fs.existsSync(call.args[2]), false);

      // Round-trip: payload matches the documented export envelope
      assert.ok(importedPayload, "import file should have been written before exec");
      assert.deepStrictEqual(
        Object.keys(importedPayload).sort(),
        Object.keys(EXPORT_FIXTURE).sort(),
      );
      assert.strictEqual(importedPayload.version, EXPORT_FORMAT_VERSION);
      assert.strictEqual(importedPayload.count, 1);
      const memoryRecord = importedPayload.memories[0];
      assert.deepStrictEqual(
        Object.keys(memoryRecord).sort(),
        Object.keys(EXPORT_FIXTURE.memories[0]).sort(),
      );
      assert.strictEqual(memoryRecord.text, "a brand new memory");
      assert.strictEqual(memoryRecord.category, "decision");
      assert.strictEqual(memoryRecord.scope, "agent:main");
      assert.strictEqual(memoryRecord.importance, 0.95);
      assert.strictEqual(typeof memoryRecord.timestamp, "number");
      assert.doesNotThrow(() => JSON.parse(memoryRecord.metadata));
    });

    it("cleans up the temp file and reports { error } when import fails", async () => {
      let tmpFile = null;
      const execFn = mockExecFn(({ args }) => {
        tmpFile = args[2];
        return { error: new Error("import exploded"), stdout: "", stderr: "" };
      });
      const memory = createLanceMemory({ execFn, lanceModuleLoader: failingLoader });
      const result = await memory.store("text");
      assert.ok(result.error.includes("memory-pro import failed"));
      assert.strictEqual(fs.existsSync(tmpFile), false);
    });

    it("rejects empty text without writing anything", async () => {
      const execFn = mockExecFn(() => ({ error: null, stdout: "", stderr: "" }));
      const memory = createLanceMemory({ execFn, lanceModuleLoader: failingLoader });
      const result = await memory.store("");
      assert.ok(result.error);
      assert.strictEqual(execFn.calls.length, 0);
    });
  });

  describe("update()", () => {
    const currentRow = {
      id: "row-1",
      text: "old text",
      vector: [1, 2, 3],
      category: "fact",
      scope: "agent:main",
      importance: 0.5,
      timestamp: 42,
      metadata: '{"tier":"hot"}',
    };

    function updateHarness({ rows = [currentRow], responder } = {}) {
      const importedPayloads = [];
      const execFn = mockExecFn((call) => {
        if (call.args[1] === "import") {
          importedPayloads.push(JSON.parse(fs.readFileSync(call.args[2], "utf8")));
        }
        return responder ? responder(call) : { error: null, stdout: LOG_NOISE, stderr: "" };
      });
      const memory = createLanceMemory({
        dbPath: os.tmpdir(),
        execFn,
        lanceModuleLoader: fakeLanceLoader(rows),
      });
      return { memory, execFn, importedPayloads };
    }

    it("deletes then re-imports the merged record, preserving id and timestamp", async () => {
      const { memory, execFn, importedPayloads } = updateHarness();
      const result = await memory.update("row-1", { text: "new text", importance: 0.9 });

      assert.ok(!result.error, result.error);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.id, "row-1");
      assert.strictEqual(result.item.text, "new text");

      // CLI sequence: delete (with the row's scope), then import
      assert.deepStrictEqual(execFn.calls[0].args, [
        "memory-pro",
        "delete",
        "row-1",
        "--scope",
        "agent:main",
      ]);
      assert.strictEqual(execFn.calls[1].args[1], "import");
      assert.deepStrictEqual(execFn.calls[1].args.slice(3), ["--scope", "agent:main"]);
      assert.strictEqual(execFn.calls.length, 2);

      // Re-imported record: id + timestamp preserved, unchanged fields kept,
      // metadata merged with an edit marker
      const record = importedPayloads[0].memories[0];
      assert.strictEqual(record.id, "row-1");
      assert.strictEqual(record.timestamp, 42);
      assert.strictEqual(record.text, "new text");
      assert.strictEqual(record.category, "fact");
      assert.strictEqual(record.scope, "agent:main");
      assert.strictEqual(record.importance, 0.9);
      const metadata = JSON.parse(record.metadata);
      assert.strictEqual(metadata.tier, "hot");
      assert.strictEqual(metadata.updatedBy, "open-fleet-control-cortex");
      assert.strictEqual(importedPayloads[0].version, EXPORT_FORMAT_VERSION);
    });

    it("moves between scopes: deletes from the old scope, imports into the new", async () => {
      const { memory, execFn, importedPayloads } = updateHarness();
      const result = await memory.update("row-1", { scope: "global" });

      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(execFn.calls[0].args.slice(2), ["row-1", "--scope", "agent:main"]);
      assert.deepStrictEqual(execFn.calls[1].args.slice(3), ["--scope", "global"]);
      assert.strictEqual(importedPayloads[0].memories[0].scope, "global");
    });

    it("rejects empty change-sets and invalid values without touching the CLI", async () => {
      const { memory, execFn } = updateHarness();
      assert.ok((await memory.update("row-1", {})).error.includes("at least one editable field"));
      assert.ok((await memory.update("row-1", { text: "  " })).error.includes("non-empty string"));
      assert.ok(
        (await memory.update("row-1", { importance: 5 })).error.includes("between 0 and 1"),
      );
      assert.ok((await memory.update("row-1", { category: "" })).error.includes("category"));
      assert.ok((await memory.update("", { text: "x" })).error.includes("memory id"));
      assert.strictEqual(execFn.calls.length, 0);
    });

    it("returns a not-found error for unknown ids without touching the CLI", async () => {
      const { memory, execFn } = updateHarness({ rows: [] });
      const result = await memory.update("nope", { text: "x" });
      assert.ok(result.error.includes("memory not found"));
      assert.strictEqual(execFn.calls.length, 0);
    });

    it("leaves the memory untouched when the delete step fails", async () => {
      const { memory, execFn } = updateHarness({
        responder: ({ args }) =>
          args[1] === "delete"
            ? { error: new Error("delete exploded"), stdout: "", stderr: "" }
            : { error: null, stdout: "", stderr: "" },
      });
      const result = await memory.update("row-1", { text: "new" });
      assert.ok(result.error.includes("update failed (delete step)"));
      assert.strictEqual(execFn.calls.length, 1);
    });

    it("rolls the original record back when the re-import fails", async () => {
      let importCount = 0;
      const { memory, execFn, importedPayloads } = updateHarness({
        responder: ({ args }) => {
          if (args[1] === "import") {
            importCount += 1;
            if (importCount === 1) {
              return { error: new Error("import exploded"), stdout: "", stderr: "" };
            }
          }
          return { error: null, stdout: "", stderr: "" };
        },
      });
      const result = await memory.update("row-1", { text: "new" });
      assert.ok(result.error.includes("update failed (import step)"));
      assert.ok(result.error.includes("original memory restored"));
      // delete + failed import + rollback import
      assert.strictEqual(execFn.calls.length, 3);
      const restored = importedPayloads[1].memories[0];
      assert.strictEqual(restored.id, "row-1");
      assert.strictEqual(restored.text, "old text");
      assert.strictEqual(restored.metadata, '{"tier":"hot"}');
    });

    it("reports ROLLBACK FAILED when the restore import also fails", async () => {
      const { memory } = updateHarness({
        responder: ({ args }) =>
          args[1] === "import"
            ? { error: new Error("import always fails"), stdout: "", stderr: "" }
            : { error: null, stdout: "", stderr: "" },
      });
      const result = await memory.update("row-1", { text: "new" });
      assert.ok(result.error.includes("ROLLBACK FAILED"));
    });
  });

  describe("remove()", () => {
    const row = {
      id: "row-1",
      text: "stored memory",
      category: "fact",
      scope: "global",
      importance: 0.5,
      timestamp: 42,
      metadata: null,
    };

    it("deletes with the row's scope and verifies the row is gone", async () => {
      const execFn = mockExecFn(() => ({ error: null, stdout: LOG_NOISE, stderr: "" }));
      const memory = createLanceMemory({
        dbPath: os.tmpdir(),
        execFn,
        lanceModuleLoader: sequencedLanceLoader([[row], []]),
      });
      const result = await memory.remove("row-1");
      assert.ok(!result.error, result.error);
      assert.deepStrictEqual(result, { ok: true, id: "row-1" });
      assert.deepStrictEqual(execFn.calls[0].args, [
        "memory-pro",
        "delete",
        "row-1",
        "--scope",
        "global",
      ]);
      assert.strictEqual(execFn.calls.length, 1);
    });

    it("reports an error when the row is still present after the CLI delete", async () => {
      const execFn = mockExecFn(() => ({ error: null, stdout: "", stderr: "" }));
      const memory = createLanceMemory({
        dbPath: os.tmpdir(),
        execFn,
        lanceModuleLoader: sequencedLanceLoader([[row], [row]]),
      });
      const result = await memory.remove("row-1");
      assert.ok(result.error.includes("did not take effect"));
    });

    it("returns a not-found error for unknown ids without calling the CLI", async () => {
      const execFn = mockExecFn(() => ({ error: null, stdout: "", stderr: "" }));
      const memory = createLanceMemory({
        dbPath: os.tmpdir(),
        execFn,
        lanceModuleLoader: fakeLanceLoader([]),
      });
      const result = await memory.remove("nope");
      assert.ok(result.error.includes("memory not found"));
      assert.strictEqual(execFn.calls.length, 0);
    });

    it("builds an injection-safe args array and runs blind when the dataset is unreadable", async () => {
      const execFn = mockExecFn(() => ({ error: null, stdout: "", stderr: "" }));
      const memory = createLanceMemory({ execFn, lanceModuleLoader: failingLoader });
      const hostileId = 'x"; rm -rf / #';
      const result = await memory.remove(hostileId);
      assert.strictEqual(result.ok, true);
      assert.ok(Array.isArray(execFn.calls[0].args));
      assert.deepStrictEqual(execFn.calls[0].args, ["memory-pro", "delete", hostileId]);
    });

    it("propagates CLI failures as { error }", async () => {
      const execFn = mockExecFn(() => ({
        error: new Error("delete exploded"),
        stdout: "",
        stderr: "",
      }));
      const memory = createLanceMemory({ execFn, lanceModuleLoader: failingLoader });
      const result = await memory.remove("row-1");
      assert.ok(result.error.includes("memory-pro delete failed"));
    });

    it("rejects empty ids without calling the CLI", async () => {
      const execFn = mockExecFn(() => ({ error: null, stdout: "", stderr: "" }));
      const memory = createLanceMemory({ execFn, lanceModuleLoader: failingLoader });
      assert.ok((await memory.remove("")).error.includes("memory id"));
      assert.strictEqual(execFn.calls.length, 0);
    });
  });

  describe("stats()", () => {
    const STATS_TEXT = [
      "Memory Statistics:",
      "• Total memories: 135",
      "• Available scopes: 19",
      "",
      "Memories by scope:",
      "  • agent:main: 106",
      "  • global: 29",
      "",
      "Memories by category:",
      "  • preference: 37",
      "  • fact: 37",
    ].join("\n");

    it("parses the plain-text CLI stats output", () => {
      const stats = parseStatsText(LOG_NOISE + STATS_TEXT);
      assert.strictEqual(stats.totalMemories, 135);
      assert.deepStrictEqual(stats.byScope, { "agent:main": 106, global: 29 });
      assert.deepStrictEqual(stats.byCategory, { preference: 37, fact: 37 });
    });

    // Real-world quirk: `stats --json` can exit non-zero while still
    // printing its JSON envelope to stderr (plugin log noise around it)
    const STATS_JSON_ENVELOPE = {
      memory: {
        totalCount: 135,
        scopeCounts: { "agent:main": 106, global: 29 },
        categoryCounts: { preference: 37, fact: 37 },
      },
      retrieval: { mode: "hybrid" },
    };

    it("prefers the stats --json envelope even on stderr with non-zero exit", async () => {
      const execFn = mockExecFn(() => ({
        error: new Error("Command failed: openclaw memory-pro stats --json"),
        stdout: LOG_NOISE,
        stderr: LOG_NOISE + JSON.stringify(STATS_JSON_ENVELOPE, null, 2) + "\n",
      }));
      const memory = createLanceMemory({ execFn, lanceModuleLoader: failingLoader });
      const stats = await memory.stats();
      assert.strictEqual(stats.totalMemories, 135);
      assert.deepStrictEqual(stats.byScope, { "agent:main": 106, global: 29 });
      assert.deepStrictEqual(stats.byCategory, { preference: 37, fact: 37 });
      assert.strictEqual(stats.source, "cli");
      assert.deepStrictEqual(execFn.calls[0].args, ["memory-pro", "stats", "--json"]);
      assert.strictEqual(execFn.calls.length, 1);
    });

    it("treats the CLI as available when it emits JSON despite a non-zero exit", async () => {
      const execFn = mockExecFn(() => ({
        error: new Error("Command failed"),
        stdout: "",
        stderr: JSON.stringify(STATS_JSON_ENVELOPE),
      }));
      const memory = createLanceMemory({
        dbPath: "/nonexistent/lancedb",
        execFn,
        lanceModuleLoader: failingLoader,
      });
      const result = await memory.available();
      assert.strictEqual(result.available, true);
      assert.strictEqual(result.cli, true);
    });

    it("falls back to the plain-text CLI output when --json gives no payload", async () => {
      const execFn = mockExecFn(({ callIndex }) => {
        if (callIndex === 0) return { error: null, stdout: LOG_NOISE, stderr: "" }; // --json: no payload
        return { error: null, stdout: STATS_TEXT, stderr: "" };
      });
      const memory = createLanceMemory({ execFn, lanceModuleLoader: failingLoader });
      const stats = await memory.stats();
      assert.strictEqual(stats.totalMemories, 135);
      assert.strictEqual(stats.source, "cli");
      assert.deepStrictEqual(execFn.calls[0].args, ["memory-pro", "stats", "--json"]);
      assert.deepStrictEqual(execFn.calls[1].args, ["memory-pro", "stats"]);
    });

    it("falls back to a direct countRows when the CLI fails", async () => {
      const execFn = mockExecFn(() => ({
        error: new Error("no CLI"),
        stdout: "",
        stderr: "",
      }));
      const memory = createLanceMemory({
        dbPath: os.tmpdir(),
        execFn,
        lanceModuleLoader: fakeLanceLoader([{ id: "a" }, { id: "b" }]),
      });
      const stats = await memory.stats();
      assert.strictEqual(stats.totalMemories, 2);
      assert.strictEqual(stats.source, "lancedb");
    });

    it("returns { error } when neither CLI nor direct read works", async () => {
      const execFn = mockExecFn(() => ({
        error: new Error("no CLI"),
        stdout: "",
        stderr: "",
      }));
      const memory = createLanceMemory({
        dbPath: "/nonexistent/lancedb",
        execFn,
        lanceModuleLoader: failingLoader,
      });
      const stats = await memory.stats();
      assert.ok(stats.error);
    });
  });
});
