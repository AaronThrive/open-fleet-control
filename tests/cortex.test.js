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

function brokenCortexOptions(tmpDir) {
  return {
    gbrain: {
      cliPath: "/nonexistent/gbrain",
      execFn: mockExecFn(() => ({ error: new Error("ENOENT"), stdout: "", stderr: "" })),
    },
    gauges: {
      paths: {
        leanCtx: path.join(tmpDir, "missing-lean-ctx.json"),
        lcmDb: path.join(tmpDir, "missing-lcm.db"),
        openclawConfig: path.join(tmpDir, "missing-openclaw.json"),
      },
    },
  };
}

function healthyCortexOptions(tmpDir) {
  const leanCtxPath = path.join(tmpDir, "lean-ctx.json");
  const openclawConfigPath = path.join(tmpDir, "openclaw.json");
  fs.writeFileSync(
    openclawConfigPath,
    JSON.stringify({ plugins: { slots: { contextEngine: "lean-ctx" } } }),
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
    gbrain: {
      execFn: mockExecFn(({ args }) => {
        if (args[0] === "stats") {
          return { error: null, stdout: "Pages:     5\nLinks:     0\n", stderr: "" };
        }
        // list (probe + listing): two pages, newest first
        return {
          error: null,
          stdout:
            '[{"slug":"a","title":"Alpha","type":"note","updated_at":"Thu Jun 11"},' +
            '{"slug":"b","title":"Bravo","type":"note","updated_at":"Mon Jun 08"}]',
          stderr: "",
        };
      }),
    },
    gauges: {
      paths: {
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
      // Make the gbrain adapter slow: getState must NOT wait for it.
      options.gbrain.execFn = async () => {
        await gate;
        return { error: new Error("ENOENT"), stdout: "", stderr: "" };
      };
      const cortex = createCortex(options);

      const startedAt = Date.now();
      const state = await cortex.getState();
      assert.ok(Date.now() - startedAt < 1000, "cold getState must not await collection");

      // Warming placeholder has the full empty shape (gbrain-backed memory).
      assert.strictEqual(state.warming, true);
      assert.strictEqual(state.memory.available, false);
      assert.strictEqual(state.memory.pageCount, null);
      assert.strictEqual(state.memory.lastUpdated, null);
      assert.strictEqual(state.memory.lancedb, undefined);
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
      // available() is probed once and cached; the coalesced collection runs once.
      assert.strictEqual(collections, 1);
    });
  });

  describe("getState() when every subsystem is down", () => {
    it("returns a complete state payload with reasons, never throws", async () => {
      const cortex = createCortex(brokenCortexOptions(tmpDir));
      const state = await cortex.warmup();

      assert.ok(typeof state.timestamp === "number");

      assert.strictEqual(state.memory.available, false);
      assert.ok(state.memory.reason.includes("gbrain CLI failed"));
      assert.strictEqual(state.memory.pageCount, null);
      assert.strictEqual(state.memory.lastUpdated, null);
      // No LanceDB field survives.
      assert.strictEqual(state.memory.lancedb, undefined);
      assert.strictEqual(state.memory.cli, undefined);
      assert.strictEqual(state.memory.stats, undefined);

      assert.strictEqual(state.gbrain.available, false);
      assert.ok(state.gbrain.reason.includes("gbrain CLI failed"));

      // headroom removed: exactly two gauge sources remain.
      assert.strictEqual(state.gauges.length, 2);
      assert.ok(state.gauges.every((g) => g.available === false));
      assert.ok(!state.gauges.some((g) => g.source === "headroom"));
      assert.strictEqual(state.gaugeSummary.available, 0);
      assert.strictEqual(state.gaugeSummary.sources, 2);
      assert.strictEqual(state.gaugeSummary.overallSavingsPct, null);

      // No openclaw config on this host: engine unknown, with a reason.
      assert.strictEqual(state.contextEngine.engine, null);
      assert.ok(state.contextEngine.reason.includes("not found"));
    });
  });

  describe("getState() when subsystems are healthy", () => {
    it("includes gbrain-backed memory, no graph, and the gauge summary", async () => {
      const cortex = createCortex(healthyCortexOptions(tmpDir));
      const state = await cortex.warmup();

      assert.strictEqual(state.memory.available, true);
      // Memory is gbrain-backed: pageCount from stats, lastUpdated from list.
      assert.strictEqual(state.memory.pageCount, 5);
      assert.strictEqual(state.memory.lastUpdated, "Thu Jun 11");
      assert.strictEqual(state.memory.lancedb, undefined);
      assert.strictEqual(state.memory.stats, undefined);

      assert.strictEqual(state.gbrain.available, true);
      assert.strictEqual(state.gbrain.reason, null);

      // lean-ctx available, lcm db missing — no headroom entry.
      assert.deepStrictEqual(
        state.gauges.map((g) => g.source),
        ["lean-ctx", "lcm"],
      );
      assert.deepStrictEqual(
        state.gauges.map((g) => g.available),
        [true, false],
      );
      assert.strictEqual(state.gaugeSummary.available, 1);
      assert.strictEqual(state.gaugeSummary.totalRawTokens, 200);
      assert.strictEqual(state.gaugeSummary.totalEffectiveTokens, 150);
      assert.strictEqual(state.gaugeSummary.overallSavingsPct, 25);

      // Active context engine resolved from plugins.slots.contextEngine.
      assert.strictEqual(state.contextEngine.engine, "lean-ctx");
      assert.strictEqual(state.contextEngine.source, "plugins.slots.contextEngine");

      // No knowledge-graph viz data on the state payload.
      assert.strictEqual(state.graph, undefined);
    });
  });

  describe("passthrough methods", () => {
    it("delegates memory (list/search/get/stats) and gauge calls to gbrain", async () => {
      const options = healthyCortexOptions(tmpDir);
      const cortex = createCortex(options);

      const list = await cortex.listMemory();
      assert.strictEqual(list.total, 2);
      assert.deepStrictEqual(list.items[0], {
        id: "a",
        title: "Alpha",
        type: "note",
        updatedAt: "Thu Jun 11",
      });
      // list must NOT pass a --limit cap (whole brain).
      const listCall = options.gbrain.execFn.calls.find(
        (c) => c.args[0] === "list" && !c.args.includes("--limit"),
      );
      assert.deepStrictEqual(listCall.args, ["list", "--json"]);

      const search = await cortex.searchMemory("brav");
      assert.strictEqual(search.total, 1);
      assert.strictEqual(search.items[0].id, "b");

      const stats = await cortex.memoryStats();
      assert.strictEqual(stats.pageCount, 5);

      const gauges = cortex.getGauges();
      assert.strictEqual(gauges.length, 2);
      assert.strictEqual(gauges[0].source, "lean-ctx");
    });

    it("propagates { error } results instead of throwing", async () => {
      const cortex = createCortex(brokenCortexOptions(tmpDir));
      assert.ok((await cortex.searchMemory("q")).error);
      assert.ok((await cortex.listMemory()).error);
      assert.ok((await cortex.getMemory("id")).error);
      assert.ok((await cortex.getPage("p")).error);
      assert.ok((await cortex.memoryStats()).error);
    });

    it("no longer exposes write or graph passthroughs", () => {
      const cortex = createCortex(brokenCortexOptions(tmpDir));
      assert.strictEqual(cortex.storeMemory, undefined);
      assert.strictEqual(cortex.updateMemory, undefined);
      assert.strictEqual(cortex.deleteMemory, undefined);
      assert.strictEqual(cortex.getGraph, undefined);
      assert.strictEqual(cortex.memory, undefined);
    });
  });
});
