/**
 * Cortex facade — aggregates the read-only gbrain memory adapter and the
 * compression gauges into one module with a unified getState() for the
 * dashboard state endpoint.
 *
 * gbrain is the system of record for the memory browser (read-only here;
 * writes happen via a nightly sync). All heavy dependencies (CLIs, sqlite)
 * load lazily inside the adapters; creating a cortex performs no I/O.
 */

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
 * @param {object} [options.gbrain] - options for createGbrain (the read-only
 *   memory adapter and system of record)
 * @param {object} [options.gauges] - options for createGauges
 */
function createCortex(options = {}) {
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
      memory: { available: false, reason: null, pageCount: null, lastUpdated: null },
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
      memory: { available: false, reason: null, pageCount: null, lastUpdated: null },
      gbrain: { available: false, reason: null },
      gauges: [],
      gaugeSummary: summarizeGauges([]),
      contextEngine: { engine: null, source: null, reason: null },
    };

    // Memory browser is gbrain-backed (read-only). Availability comes from the
    // same probe as the gbrain section; pageCount/lastUpdated come from stats.
    let gbrainAvailability = null;
    try {
      gbrainAvailability = await gbrain.available();
      state.memory.available = !!gbrainAvailability.available;
      state.memory.reason = gbrainAvailability.reason || null;
      if (gbrainAvailability.available) {
        const memoryStats = await gbrain.stats();
        if (memoryStats && !memoryStats.error) {
          state.memory.pageCount = memoryStats.pageCount ?? null;
          state.memory.lastUpdated = memoryStats.lastUpdated ?? null;
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
      const availability = gbrainAvailability ?? (await gbrain.available());
      state.gbrain.available = !!availability.available;
      state.gbrain.reason = availability.reason || null;
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
    gbrain,
    gauges,
    // Unified state
    getState,
    warmup,
    // Memory passthroughs (read-only, gbrain-backed)
    searchMemory: (query, opts) => gbrain.search(query, opts),
    listMemory: (opts) => gbrain.list(opts),
    getMemory: (id) => gbrain.get(id),
    memoryStats: () => gbrain.stats(),
    getPage: (id) => gbrain.getPage(id),
    // Gauges passthrough
    getGauges: () => gauges.getGauges(),
  };
}

module.exports = { createCortex, summarizeGauges };
