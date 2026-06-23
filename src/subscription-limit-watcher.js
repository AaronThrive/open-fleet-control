/**
 * Subscription / rate-limit watcher (D1).
 *
 * OFC budgets only watch USD spend. This watcher closes the gap for
 * subscription / rate-limited plans (Claude Max, Codex) where the constraint
 * is a PLAN UTILIZATION PERCENTAGE per rolling window, not a dollar amount.
 *
 * It periodically reads the available subscription-utilization gauges for each
 * tracked provider and fires an alert (type "subscriptionLimit") when any
 * tracked window crosses the warn (default 80%) or critical (default 95%)
 * threshold. De-dupe is per provider+window+severity so a breach fires exactly
 * ONCE on crossing — never re-firing every tick while a window stays hot. When
 * a window drops back below warn the latch clears, so a later re-crossing
 * fires again.
 *
 * Data sources are INJECTED (mirrors the budgets getUsage() injection):
 *   getProviderWindows() => [
 *     { provider, window, utilizationPct, capPct?, resetsAt?, stale }
 *   ]
 * The orchestrator adapts the usage-sources (src/usage-sources/plan-usage.js
 * for Claude; the Codex source when/if it exposes quota) into that flat shape.
 *
 * IMPORTANT — STALE DATA DEPENDENCY:
 * The Claude windows come from the plan-usage poller's subscription_state.json.
 * The plan-usage source exposes a `stale` flag (data polled more than 30 min
 * ago). This watcher MUST NOT fire false criticals off a multi-day-old
 * snapshot: any window marked `stale` is SKIPPED (no alert, counted as
 * skippedStale) so the latch state is never advanced from rotten data.
 * Adapters are expected to propagate `stale` truthfully.
 */

const DEFAULT_WARN_PCT = 80;
const DEFAULT_CRITICAL_PCT = 95;
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MIN_POLL_INTERVAL_MS = 30 * 1000; // floor so a bad config can't busy-loop

/** Finite number in [0,100]-ish, or null. Never coerces junk to 0. */
function toPctOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/** Clamp a percentage threshold to a sane (0,100] value or fall back. */
function normalizePct(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0 || num > 100) return fallback;
  return num;
}

/**
 * Normalize the fleet.subscriptionLimits config section to safe values.
 * Defaults: disabled, warn 80, critical 95, 5-min poll.
 */
function normalizeConfig(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const warnPct = normalizePct(src.warnPct, DEFAULT_WARN_PCT);
  let criticalPct = normalizePct(src.criticalPct, DEFAULT_CRITICAL_PCT);
  // critical must sit at or above warn; otherwise a "critical" could never beat warn.
  if (criticalPct < warnPct) criticalPct = DEFAULT_CRITICAL_PCT >= warnPct ? DEFAULT_CRITICAL_PCT : warnPct;
  const pollRaw = Number(src.pollIntervalMs);
  const pollIntervalMs =
    Number.isFinite(pollRaw) && pollRaw >= MIN_POLL_INTERVAL_MS ? pollRaw : DEFAULT_POLL_INTERVAL_MS;
  return {
    enabled: src.enabled === true,
    warnPct,
    criticalPct,
    pollIntervalMs,
  };
}

/** Stable latch key for a provider+window. */
function latchKey(provider, window) {
  return `${provider}::${window}`;
}

/** Severity for a utilization pct against thresholds, or null when below warn. */
function severityFor(pct, cfg) {
  if (pct >= cfg.criticalPct) return "critical";
  if (pct >= cfg.warnPct) return "warn";
  return null;
}

/** Rank so a crossing from warn → critical still fires (critical outranks warn). */
function severityRank(severity) {
  if (severity === "critical") return 2;
  if (severity === "warn") return 1;
  return 0;
}

/**
 * Create the subscription-limit watcher.
 *
 * @param {object} options
 * @param {function} options.getProviderWindows - () => array (sync or Promise) of
 *   { provider, window, utilizationPct, capPct?, resetsAt?, stale } rows.
 * @param {function} options.onAlert - alert callback (see header / fireAlert shape).
 * @param {object} [options.config] - fleet.subscriptionLimits section.
 * @param {object} [options.log=console]
 * @returns {{start, stop, evaluate, applyConfig, getState}}
 */
function createSubscriptionLimitWatcher({
  getProviderWindows,
  onAlert,
  config,
  log = console,
} = {}) {
  if (typeof getProviderWindows !== "function") {
    throw new TypeError("createSubscriptionLimitWatcher requires getProviderWindows");
  }
  if (typeof onAlert !== "function") {
    throw new TypeError("createSubscriptionLimitWatcher requires onAlert");
  }

  let cfg = normalizeConfig(config);
  let timer = null;
  let evaluating = null;
  let lastCheck = null;
  let lastResult = null;
  // latchKey -> highest severity rank already alerted for the current crossing.
  // Cleared back to 0 when a window drops below warn, so a re-crossing re-fires.
  let latched = {};

  /** Fire one alert for a crossing. Never lets a bad callback abort the loop. */
  function emit(row, severity) {
    const pct = Math.round(toPctOrNull(row.utilizationPct) * 10) / 10;
    const capPct = toPctOrNull(row.capPct);
    const capText = capPct !== null ? `${capPct}%` : "plan limit";
    try {
      onAlert({
        type: "subscriptionLimit",
        severity,
        provider: row.provider,
        window: row.window,
        pct,
        capPct,
        resetsAt: row.resetsAt ?? null,
        task: `${row.provider}:${row.window}`,
        message:
          `Subscription limit ${severity} (${row.provider} ${row.window}): ` +
          `${pct}% of ${capText}` +
          (row.resetsAt ? ` — resets ${row.resetsAt}` : ""),
      });
    } catch (e) {
      log.error(`[SubscriptionLimits] onAlert callback failed: ${e.message}`);
    }
  }

  async function evaluateOnce() {
    if (!cfg.enabled) return { checked: false, reason: "disabled" };

    let rows;
    try {
      rows = await getProviderWindows();
    } catch (e) {
      log.error(`[SubscriptionLimits] getProviderWindows failed: ${e.message}`);
      return { checked: false, reason: e.message };
    }
    if (!Array.isArray(rows)) {
      return { checked: false, reason: "no provider windows available" };
    }

    let fired = 0;
    let skippedStale = 0;
    let skippedMissing = 0;
    const seen = new Set();

    for (const row of rows) {
      if (!row || typeof row !== "object" || !row.provider || !row.window) {
        skippedMissing++;
        continue;
      }
      // Stale data must never advance the latch or fire — see header dependency note.
      if (row.stale) {
        skippedStale++;
        continue;
      }
      const pct = toPctOrNull(row.utilizationPct);
      if (pct === null) {
        skippedMissing++;
        continue;
      }

      const key = latchKey(row.provider, row.window);
      seen.add(key);
      const severity = severityFor(pct, cfg);
      const rank = severityRank(severity);
      const priorRank = latched[key] || 0;

      if (rank === 0) {
        // Dropped below warn — clear the latch so a later re-crossing alerts.
        if (priorRank !== 0) latched = { ...latched, [key]: 0 };
        continue;
      }
      // Only fire when crossing UP into a higher severity than already alerted.
      if (rank > priorRank) {
        latched = { ...latched, [key]: rank };
        emit(row, severity);
        fired++;
      }
    }

    lastCheck = Date.now();
    lastResult = { checked: true, fired, skippedStale, skippedMissing, evaluated: seen.size };
    return lastResult;
  }

  /** Single-flight evaluation; never throws. */
  function evaluate() {
    if (evaluating) return evaluating;
    evaluating = evaluateOnce()
      .catch((e) => {
        log.error(`[SubscriptionLimits] Evaluation failed: ${e.message}`);
        return { checked: false, reason: e.message };
      })
      .finally(() => {
        evaluating = null;
      });
    return evaluating;
  }

  function start() {
    if (timer || !cfg.enabled) return;
    evaluate(); // immediate first check (mirrors budgets.start())
    timer = setInterval(evaluate, cfg.pollIntervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  /** Hot-apply a new fleet.subscriptionLimits config (settings PATCH path). */
  function applyConfig(newConfig) {
    stop();
    cfg = normalizeConfig(newConfig);
    if (cfg.enabled) start();
  }

  function getState() {
    return {
      enabled: cfg.enabled,
      warnPct: cfg.warnPct,
      criticalPct: cfg.criticalPct,
      pollIntervalMs: cfg.pollIntervalMs,
      running: timer !== null,
      lastCheck,
      lastResult,
      latched: { ...latched },
    };
  }

  return { start, stop, evaluate, applyConfig, getState };
}

module.exports = {
  createSubscriptionLimitWatcher,
  normalizeConfig,
  DEFAULT_WARN_PCT,
  DEFAULT_CRITICAL_PCT,
  DEFAULT_POLL_INTERVAL_MS,
};
