const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createCortex, summarizeGauges } = require("../src/cortex");

// --- Injected dependencies: no real CLIs, no real ~/.openclaw, no network ---

function mockExecFn(responder) {
  const calls = [];
  const fn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return responder({ cmd, args, opts });
  };
  fn.calls = calls;
  return fn;
}

const failingLoader = () => {
  throw new Error("Cannot find module '@lancedb/lancedb'");
};

const STATS_TEXT = "• Total memories: 7\nMemories by scope:\n  • global: 7\n";

function brokenCortexOptions(tmpDir) {
  return {
    lancedb: {
      dbPath: "/nonexistent/lancedb",
      execFn: mockExecFn(() => ({ error: new Error("ENOENT"), stdout: "", stderr: "" })),
      lanceModuleLoader: failingLoader,
    },
    gbrain: {
      cliPath: "/nonexistent/gbrain",
      execFn: mockExecFn(() => ({ error: new Error("ENOENT"), stdout: "", stderr: "" })),
    },
    gauges: {
      paths: {
        headroom: path.join(tmpDir, "missing-headroom.json"),
        leanCtx: path.join(tmpDir, "missing-lean-ctx.json"),
        lcmDb: path.join(tmpDir, "missing-lcm.db"),
        openclawConfig: path.join(tmpDir, "missing-openclaw.json"),
      },
    },
  };
}

function healthyCortexOptions(tmpDir) {
  const headroomPath = path.join(tmpDir, "headroom.json");
  const leanCtxPath = path.join(tmpDir, "lean-ctx.json");
  const openclawConfigPath = path.join(tmpDir, "openclaw.json");
  fs.writeFileSync(
    openclawConfigPath,
    JSON.stringify({ plugins: { slots: { contextEngine: "headroom" } } }),
  );
  fs.writeFileSync(
    headroomPath,
    JSON.stringify({ window_tokens: { total_raw: 1000, weighted_token_equivalent: 600 } }),
  );
  fs.writeFileSync(
    leanCtxPath,
    JSON.stringify({
      total_input_tokens: 200,
      total_output_tokens: 150,
      total_commands: 1,
      // Genuine raw-vs-compressed pair lives in cep (real stats.json schema)
      cep: { sessions: 1, total_tokens_original: 200, total_tokens_compressed: 150 },
    }),
  );
  return {
    lancedb: {
      dbPath: "/nonexistent/lancedb",
      execFn: mockExecFn(({ args }) => {
        if (args[1] === "search") return { error: null, stdout: "[]", stderr: "" };
        return { error: null, stdout: STATS_TEXT, stderr: "" };
      }),
      lanceModuleLoader: failingLoader,
    },
    gbrain: {
      execFn: mockExecFn(({ args }) => {
        if (args[0] === "list")
          return { error: null, stdout: '[{"slug":"a","title":"A"}]', stderr: "" };
        return { error: null, stdout: "[]", stderr: "" };
      }),
    },
    gauges: {
      paths: {
        headroom: headroomPath,
        leanCtx: leanCtxPath,
        lcmDb: path.join(tmpDir, "missing-lcm.db"),
        openclawConfig: openclawConfigPath,
      },
    },
  };
}

describe("cortex facade", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-facade-test-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("summarizeGauges()", () => {
    it("aggregates only available gauges", () => {
      const summary = summarizeGauges([
        { source: "a", available: true, rawTokens: 1000, effectiveTokens: 600 },
        { source: "b", available: false, rawTokens: 999999, effectiveTokens: 999999 },
        { source: "c", available: true, rawTokens: 1000, effectiveTokens: 400 },
      ]);
      assert.deepStrictEqual(summary, {
        sources: 3,
        available: 2,
        totalRawTokens: 2000,
        totalEffectiveTokens: 1000,
        overallSavingsPct: 50,
      });
    });

    it("handles empty/invalid input", () => {
      assert.strictEqual(summarizeGauges([]).overallSavingsPct, null);
      assert.strictEqual(summarizeGauges(null).sources, 0);
    });
  });

  describe("getState() cold start (warming)", () => {
    it("serves { warming: true } immediately instead of blocking on collection", async () => {
      let releaseExec;
      const gate = new Promise((resolve) => {
        releaseExec = resolve;
      });
      const options = brokenCortexOptions(tmpDir);
      // Make the memory adapter slow: getState must NOT wait for it.
      options.lancedb.execFn = async () => {
        await gate;
        return { error: new Error("ENOENT"), stdout: "", stderr: "" };
      };
      const cortex = createCortex(options);

      const startedAt = Date.now();
      const state = await cortex.getState();
      assert.ok(Date.now() - startedAt < 1000, "cold getState must not await collection");

      // Warming placeholder has the full empty shape.
      assert.strictEqual(state.warming, true);
      assert.strictEqual(state.memory.available, false);
      assert.strictEqual(state.gbrain.available, false);
      assert.deepStrictEqual(state.gauges, []);
      assert.strictEqual(state.gaugeSummary.sources, 0);
      assert.strictEqual(state.contextEngine.engine, null);

      // Once the background collection finishes, the real payload is served
      // (no warming flag) straight from cache.
      releaseExec();
      const collected = await cortex.warmup();
      assert.strictEqual(collected.warming, undefined);
      const warm = await cortex.getState();
      assert.strictEqual(warm, collected);
    });

    it("coalesces concurrent warm-ups into one collection", async () => {
      const options = brokenCortexOptions(tmpDir);
      let collections = 0;
      options.gbrain.execFn = async () => {
        collections++;
        return { error: new Error("ENOENT"), stdout: "", stderr: "" };
      };
      const cortex = createCortex(options);
      const [a, b] = await Promise.all([cortex.warmup(), cortex.warmup()]);
      assert.strictEqual(a, b);
      assert.strictEqual(collections, 1);
    });
  });

  describe("getState() when every subsystem is down", () => {
    it("returns a complete state payload with reasons, never throws", async () => {
      const cortex = createCortex(brokenCortexOptions(tmpDir));
      const state = await cortex.warmup();

      assert.ok(typeof state.timestamp === "number");

      assert.strictEqual(state.memory.available, false);
      assert.ok(state.memory.reason.includes("openclaw CLI unavailable"));
      assert.ok(state.memory.reason.includes("@lancedb/lancedb not loadable"));
      assert.strictEqual(state.memory.stats, null);

      assert.strictEqual(state.gbrain.available, false);
      assert.ok(state.gbrain.reason.includes("gbrain CLI failed"));

      assert.strictEqual(state.gauges.length, 3);
      assert.ok(state.gauges.every((g) => g.available === false));
      assert.strictEqual(state.gaugeSummary.available, 0);
      assert.strictEqual(state.gaugeSummary.sources, 3);
      assert.strictEqual(state.gaugeSummary.overallSavingsPct, null);

      // No openclaw config on this host: engine unknown, with a reason.
      assert.strictEqual(state.contextEngine.engine, null);
      assert.ok(state.contextEngine.reason.includes("not found"));
    });
  });

  describe("getState() when subsystems are healthy", () => {
    it("includes availability, memory stats, and the gauge summary", async () => {
      const cortex = createCortex(healthyCortexOptions(tmpDir));
      const state = await cortex.warmup();

      assert.strictEqual(state.memory.available, true);
      assert.strictEqual(state.memory.cli, true);
      assert.strictEqual(state.memory.lancedb, false);
      assert.strictEqual(state.memory.stats.totalMemories, 7);
      assert.deepStrictEqual(state.memory.stats.byScope, { global: 7 });

      assert.strictEqual(state.gbrain.available, true);
      assert.strictEqual(state.gbrain.reason, null);

      // headroom + lean-ctx available, lcm db missing
      assert.deepStrictEqual(
        state.gauges.map((g) => g.available),
        [true, true, false],
      );
      assert.strictEqual(state.gaugeSummary.available, 2);
      assert.strictEqual(state.gaugeSummary.totalRawTokens, 1200);
      assert.strictEqual(state.gaugeSummary.totalEffectiveTokens, 750);
      assert.strictEqual(state.gaugeSummary.overallSavingsPct, 37.5);

      // Active context engine resolved from plugins.slots.contextEngine.
      assert.strictEqual(state.contextEngine.engine, "headroom");
      assert.strictEqual(state.contextEngine.source, "plugins.slots.contextEngine");
    });
  });

  describe("passthrough methods", () => {
    it("delegates memory, graph, and gauge calls to the adapters", async () => {
      const options = healthyCortexOptions(tmpDir);
      const cortex = createCortex(options);

      const search = await cortex.searchMemory("query", { limit: 3 });
      assert.deepStrictEqual(search.results, []);
      const searchCall = options.lancedb.execFn.calls.find((c) => c.args[1] === "search");
      assert.deepStrictEqual(searchCall.args, [
        "memory-pro",
        "search",
        "query",
        "--json",
        "--limit",
        "3",
      ]);

      const stats = await cortex.memoryStats();
      assert.strictEqual(stats.totalMemories, 7);

      const graph = await cortex.getGraph({ limit: 10 });
      assert.deepStrictEqual(graph.nodes, [{ id: "a", title: "A", type: "page" }]);

      const page = await cortex.getPage("a");
      assert.ok(page.error || page.content); // empty stdout from mock yields {error}

      const gauges = cortex.getGauges();
      assert.strictEqual(gauges.length, 3);
      assert.strictEqual(gauges[0].source, "headroom");
    });

    it("propagates { error } results instead of throwing", async () => {
      const cortex = createCortex(brokenCortexOptions(tmpDir));
      assert.ok((await cortex.searchMemory("q")).error);
      assert.ok((await cortex.listMemory()).error);
      assert.ok((await cortex.getMemory("id")).error);
      assert.ok((await cortex.storeMemory("text")).error);
      assert.ok((await cortex.updateMemory("id", { text: "x" })).error);
      assert.ok((await cortex.deleteMemory("id")).error);
      assert.ok((await cortex.getGraph()).error);
      assert.ok((await cortex.getPage("p")).error);
    });
  });
});
