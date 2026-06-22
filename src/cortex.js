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
      health: null,
      obsidian: null,
      recentUpdates: [],
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
   * Unified state with the gauge figures scoped to a date window.
   *
   * Everything except the gauges (memory/gbrain/health/obsidian/recent) is
   * date-agnostic, so this reuses the cached/warming base state and overlays
   * only `gauges` + `gaugeSummary` recomputed for the given range. An empty
   * or absent range yields the lifetime gauges — identical to getState() — so
   * the no-param request path is byte-for-byte unchanged.
   *
   * @param {object} [range] - { from, to } as epoch ms or ISO/date strings.
   * @throws when the range is invalid (e.g. from > to) — surfaced as a 400.
   */
  async function getStateRanged(range) {
    const base = await getState();
    const hasRange =
      range &&
      ((range.from !== null && range.from !== undefined && range.from !== "") ||
        (range.to !== null && range.to !== undefined && range.to !== ""));
    if (!hasRange) return base;

    // Recompute gauges for the window. getGauges validates the range and is
    // self-isolating per source, so a single failing source never throws here.
    const rangedGauges = gauges.getGauges({ range });
    return {
      ...base,
      gauges: rangedGauges,
      gaugeSummary: summarizeGauges(rangedGauges),
      // Echo the resolved window so the client can label "showing {range}".
      gaugeRange: { from: range.from ?? null, to: range.to ?? null },
    };
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
      // gbrain observability extras (shell out to the gbrain CLI; defensive,
      // null/[] when unavailable so existing consumers are unaffected).
      health: null,
      obsidian: null,
      recentUpdates: [],
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

    // gbrain health/obsidian/recent-updates: only meaningful once gbrain is
    // available, and each is independently guarded so a failing CLI call
    // leaves the field at its null/[] default rather than breaking the payload.
    if (state.gbrain.available && typeof gbrain.healthStats === "function") {
      try {
        const h = await gbrain.healthStats();
        if (h && !h.error) {
          state.health = {
            pageCount: h.pageCount ?? null,
            chunks: h.chunks ?? null,
            embedded: h.embedded ?? null,
            embeddedCoverage: h.embeddedCoverage ?? null,
            healthy: h.healthy ?? null,
          };
        }
      } catch (e) {
        // leave state.health = null
      }
    }

    if (state.gbrain.available && typeof gbrain.obsidianHealth === "function") {
      try {
        const o = await gbrain.obsidianHealth();
        if (o && !o.error) {
          state.obsidian = {
            lastImportAt: o.lastImportAt ?? null,
            lastImportOk: o.lastImportOk ?? null,
            lastExportAt: o.lastExportAt ?? null,
            lastExportSummary: o.lastExportSummary ?? null,
            vaultPagesApprox: o.vaultPagesApprox ?? null,
            stale: o.stale ?? null,
          };
        }
      } catch (e) {
        // leave state.obsidian = null
      }
    }

    if (state.gbrain.available && typeof gbrain.recentUpdates === "function") {
      try {
        const r = await gbrain.recentUpdates(10);
        if (r && !r.error && Array.isArray(r.items)) {
          state.recentUpdates = r.items.map((item) => ({
            id: item.id ?? null,
            title: item.title ?? null,
            type: item.type ?? null,
            updatedAt: item.updatedAt ?? null,
          }));
        }
      } catch (e) {
        // leave state.recentUpdates = []
      }
    }

    return state;
  }

  return {
    // Sub-adapters (for callers that need full access)
    gbrain,
    gauges,
    // Unified state
    getState,
    getStateRanged,
    warmup,
    // Memory passthroughs (read-only, gbrain-backed)
    searchMemory: (query, opts) => gbrain.search(query, opts),
    listMemory: (opts) => gbrain.list(opts),
    getMemory: (id) => gbrain.get(id),
    memoryStats: () => gbrain.stats(),
    getPage: (id) => gbrain.getPage(id),
    // gbrain observability passthroughs (read-only; surfaced into getState too)
    healthStats: () => gbrain.healthStats(),
    obsidianHealth: () => gbrain.obsidianHealth(),
    recentUpdates: (limit) => gbrain.recentUpdates(limit),
    // Gauges passthrough. Accepts { range: { from, to } } to scope the gauge
    // figures to a date window; no opts = lifetime totals (unchanged default).
    getGauges: (opts) => gauges.getGauges(opts),
  };
}

module.exports = { createCortex, summarizeGauges };
