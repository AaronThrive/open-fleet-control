/**
 * Cortex facade — aggregates the LanceDB memory adapter, the gbrain
 * knowledge-graph adapter, and the compression gauges into one module with a
 * unified getState() for the dashboard state endpoint.
 *
 * All heavy dependencies (native LanceDB module, CLIs, sqlite) load lazily
 * inside the adapters; creating a cortex performs no I/O.
 */

const { createLanceMemory } = require("./cortex-lancedb");
const { createGbrain } = require("./cortex-gbrain");
const { createGauges } = require("./cortex-gauges");

/** Summarize gauge entries for the unified state payload. */
function summarizeGauges(gauges) {
  const list = Array.isArray(gauges) ? gauges : [];
  const availableGauges = list.filter((gauge) => gauge && gauge.available);
  const totalRawTokens = availableGauges.reduce(
    (sum, gauge) => sum + (Number(gauge.rawTokens) || 0),
    0,
  );
  const totalEffectiveTokens = availableGauges.reduce(
    (sum, gauge) => sum + (Number(gauge.effectiveTokens) || 0),
    0,
  );
  const overallSavingsPct =
    totalRawTokens > 0
      ? Math.round(((totalRawTokens - totalEffectiveTokens) / totalRawTokens) * 1000) / 10
      : null;
  return {
    sources: list.length,
    available: availableGauges.length,
    totalRawTokens,
    totalEffectiveTokens,
    overallSavingsPct,
  };
}

/**
 * Create the cortex facade.
 *
 * @param {object} [options]
 * @param {object} [options.lancedb] - options for createLanceMemory
 * @param {object} [options.gbrain] - options for createGbrain
 * @param {object} [options.gauges] - options for createGauges
 */
function createCortex(options = {}) {
  const memory = createLanceMemory(options.lancedb || {});
  const gbrain = createGbrain(options.gbrain || {});
  const gauges = createGauges(options.gauges || {});

  // getState cache — the memory/gbrain sections shell out to slow CLIs
  // (openclaw startup alone is seconds), so the collected state is served
  // stale-while-revalidate: requests get the cached payload instantly and a
  // single coalesced background collection keeps it fresh.
  let stateCache = { value: null, timestamp: 0 };
  let stateInFlight = null;
  const STATE_TTL_MS = 120000;

  /** Coalesced background collection: concurrent callers share one run. */
  function collect() {
    if (!stateInFlight) {
      stateInFlight = collectState()
        .then((value) => {
          stateCache = { value, timestamp: Date.now() };
          return value;
        })
        .finally(() => {
          stateInFlight = null;
        });
    }
    return stateInFlight;
  }

  /** Placeholder payload served while the first collection runs. */
  function warmingState() {
    return {
      warming: true,
      timestamp: Date.now(),
      memory: { available: false, cli: false, lancedb: false, reason: null, stats: null },
      gbrain: { available: false, reason: null },
      gauges: [],
      gaugeSummary: summarizeGauges([]),
      contextEngine: { engine: null, source: null, reason: "warming" },
    };
  }

  /**
   * Unified state (cached): adapter availability, gauge summary, memory
   * stats. NEVER blocks on collection — a cold cache kicks off a background
   * warm-up and immediately returns a `{ warming: true }` placeholder with
   * the empty state shape; a stale cache is served as-is while a coalesced
   * background refresh runs. Once warm, calls serve the cache instantly.
   */
  async function getState() {
    const age = Date.now() - stateCache.timestamp;
    if (stateCache.value && age < STATE_TTL_MS) return stateCache.value;

    // Stale or cold: refresh in the background, never inline.
    collect().catch(() => {});
    if (stateCache.value) return stateCache.value;
    return warmingState();
  }

  /**
   * Force a (coalesced) collection and resolve with the collected state.
   * Used by the startup pre-warm and tests that need the real payload.
   */
  function warmup() {
    return collect();
  }

  /**
   * Collect unified state: adapter availability, gauge summary, and memory
   * stats. Each section is independently guarded — a failing adapter
   * reports a reason instead of breaking the whole payload.
   */
  async function collectState() {
    const state = {
      timestamp: Date.now(),
      memory: { available: false, cli: false, lancedb: false, reason: null, stats: null },
      gbrain: { available: false, reason: null },
      gauges: [],
      gaugeSummary: summarizeGauges([]),
      contextEngine: { engine: null, source: null, reason: null },
    };

    try {
      const memoryAvailability = await memory.available();
      state.memory.available = !!memoryAvailability.available;
      state.memory.cli = !!memoryAvailability.cli;
      state.memory.lancedb = !!memoryAvailability.lancedb;
      state.memory.reason = memoryAvailability.reason || null;
      if (memoryAvailability.available) {
        const memoryStats = await memory.stats();
        if (memoryStats && !memoryStats.error) {
          state.memory.stats = memoryStats;
        } else if (memoryStats?.error) {
          state.memory.reason = state.memory.reason
            ? `${state.memory.reason}; stats: ${memoryStats.error}`
            : `stats: ${memoryStats.error}`;
        }
      }
    } catch (e) {
      state.memory.reason = e.message;
    }

    try {
      const gbrainAvailability = await gbrain.available();
      state.gbrain.available = !!gbrainAvailability.available;
      state.gbrain.reason = gbrainAvailability.reason || null;
    } catch (e) {
      state.gbrain.reason = e.message;
    }

    try {
      state.gauges = gauges.getGauges();
    } catch (e) {
      state.gauges = [];
    }
    state.gaugeSummary = summarizeGauges(state.gauges);

    try {
      state.contextEngine = gauges.getContextEngine();
    } catch (e) {
      state.contextEngine = { engine: null, source: null, reason: e.message };
    }

    return state;
  }

  return {
    // Sub-adapters (for callers that need full access)
    memory,
    gbrain,
    gauges,
    // Unified state
    getState,
    warmup,
    // Memory passthroughs
    searchMemory: (query, opts) => memory.search(query, opts),
    listMemory: (opts) => memory.list(opts),
    getMemory: (id) => memory.get(id),
    storeMemory: (text, opts) => memory.store(text, opts),
    updateMemory: (id, changes) => memory.update(id, changes),
    deleteMemory: (id) => memory.remove(id),
    memoryStats: () => memory.stats(),
    // Graph passthroughs
    getGraph: (opts) => gbrain.getGraph(opts),
    getPage: (id) => gbrain.getPage(id),
    // Gauges passthrough
    getGauges: () => gauges.getGauges(),
  };
}

module.exports = { createCortex, summarizeGauges };
