/**
 * Cost budget evaluator — compares LLM API spend against configured daily /
 * weekly USD budgets and fires onBreach() once per period per scope per
 * severity (warn at 80%, critical at 100%). Fired state is persisted to
 * state/budgets.json so restarts never re-alert within the same period.
 *
 * Config (fleet.budgets):
 *   { enabled: false,
 *     daily:  { totalUSD: 0, perProvider: {} },   // 0 / absent = no limit
 *     weekly: { totalUSD: 0, perProvider: {} },
 *     checkIntervalMs: 900000,
 *     enforce: { enabled: false } }               // dispatch blocking (below)
 *
 * Enforcement (fleet.budgets.enforce, default OFF): when ANY scope of a
 * period reaches 100% of its budget, checkDispatchBlock() reports a block
 * and the kanban dispatch route refuses new dispatches with a 429-style
 * {error: "budget exceeded", scope, spent, limit} until either the budget
 * window rolls over or an operator acknowledges via ack() (wired to
 * POST /api/fleet/budgets/ack). Acks are per period-window, persisted in
 * the state file, and pruned automatically when the window rolls. Block
 * state is refreshed by every evaluate() AND getStatus() pass, so the
 * guard always reflects the latest computed spend.
 *
 * getUsage contract (injected; see createUsageProvider for the standard
 * implementation over the usage-sources module):
 *   async ({ sinceMs, period: "daily"|"weekly" }) => {
 *     nineRouterByProvider?: { [provider]: usdInWindow },  // headline signal
 *     openrouterCumulativeUSD?: number,  // LIFETIME usage counter — the
 *                                        // evaluator converts it to a window
 *                                        // delta via a persisted baseline
 *     claudeCodeUSD?: number,            // est cost @ API rates (OAuth subs
 *                                        // → near-zero marginal; informative)
 *     tokensEstUSD?: number,             // tokens-module estimate, fallback
 *   } | null                             // null = provider not wired yet
 *
 * Spend semantics (documented decision): the "total" scope counts REAL API
 * spend only — Nine-Router per-provider cost + the OpenRouter window delta.
 * claude-code estimated cost is excluded from totals (primary usage is OAuth
 * subscriptions with near-zero marginal $) but is available as an explicit
 * perProvider scope ("claude-code"). When no API spend signal exists at all,
 * the total falls back to tokensEstUSD.
 *
 * Periods are calendar-based in UTC: daily = YYYY-MM-DD, weekly = ISO week
 * (GGGG-Www). onBreach receives:
 *   { period, periodKey, scope, severity, budgetUSD, actualUSD, ratio }
 * where scope is "total" or "provider:<name>".
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_CHECK_INTERVAL_MS = 900000; // 15 min
const WARN_RATIO = 0.8;
const CRITICAL_RATIO = 1.0;
const DAY_MS = 86400000;

/** Normalize a {totalUSD, perProvider} period config to safe values. */
function normalizePeriod(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const perProvider = {};
  if (src.perProvider && typeof src.perProvider === "object" && !Array.isArray(src.perProvider)) {
    for (const [provider, value] of Object.entries(src.perProvider)) {
      const usd = Number(value);
      if (provider.length > 0 && Number.isFinite(usd) && usd > 0) perProvider[provider] = usd;
    }
  }
  const totalUSD = Number(src.totalUSD);
  return {
    totalUSD: Number.isFinite(totalUSD) && totalUSD > 0 ? totalUSD : 0,
    perProvider,
  };
}

/** Normalize the full fleet.budgets config section to safe values. */
function normalizeBudgetsConfig(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    enabled: src.enabled === true,
    daily: normalizePeriod(src.daily),
    weekly: normalizePeriod(src.weekly),
    checkIntervalMs:
      Number.isInteger(src.checkIntervalMs) && src.checkIntervalMs >= 60000
        ? src.checkIntervalMs
        : DEFAULT_CHECK_INTERVAL_MS,
    enforce: {
      enabled: Boolean(
        src.enforce && typeof src.enforce === "object" && src.enforce.enabled === true,
      ),
    },
  };
}

/** UTC day key, e.g. "2026-06-10". */
function dailyKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** ISO-8601 week key in UTC, e.g. "2026-W24". */
function weeklyKey(ms) {
  const date = new Date(ms);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // ISO week: shift to the Thursday of this week, then count weeks from Jan 4.
  const dayOfWeek = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayOfWeek);
  const isoYear = target.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((target - yearStart) / DAY_MS + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** Epoch ms of the start (UTC) of the period containing `ms`. */
function periodStartMs(period, ms) {
  const date = new Date(ms);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (period === "daily") return dayStart;
  const dayOfWeek = new Date(dayStart).getUTCDay() || 7; // ISO: Monday = 1
  return dayStart - (dayOfWeek - 1) * DAY_MS;
}

function periodKey(period, ms) {
  return period === "daily" ? dailyKey(ms) : weeklyKey(ms);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/** One scope row of the getStatus() snapshot (pure). */
function scopeStatus(scope, limitUSD, spentUSD) {
  const ratio = limitUSD > 0 ? spentUSD / limitUSD : 0;
  return {
    scope,
    limitUSD,
    spentUSD: round2(spentUSD),
    percent: round1(ratio * 100),
    state: ratio >= CRITICAL_RATIO ? "critical" : ratio >= WARN_RATIO ? "warn" : "ok",
  };
}

/**
 * Create the budget evaluator.
 *
 * @param {object} options
 * @param {function} options.getUsage - injected usage aggregate (see header)
 * @param {object} [options.config] - fleet.budgets section
 * @param {function} options.onBreach - breach callback (see header)
 * @param {string} [options.stateFile] - persisted fired-state path
 * @param {function} [options.nowFn=Date.now]
 * @param {object} [options.log=console]
 * @returns {{start, stop, evaluate, applyConfig, getState, getStatus}}
 */
function createBudgets({
  getUsage,
  onBreach,
  config,
  stateFile = null,
  nowFn = Date.now,
  log = console,
} = {}) {
  if (typeof getUsage !== "function") throw new TypeError("createBudgets requires getUsage");
  if (typeof onBreach !== "function") throw new TypeError("createBudgets requires onBreach");

  let cfg = normalizeBudgetsConfig(config);
  let timer = null;
  let evaluating = null;
  let warnedNoProvider = false;
  let lastCheck = null;
  let lastSpend = null;

  // In-memory dispatch-block registry, refreshed by every spend computation:
  // "<period>:<periodKey>:<scope>" -> {period, periodKey, scope, limitUSD,
  // spentUSD}. Deliberately NOT persisted — it is recomputed from real spend
  // on the first evaluation after boot (budgets.start() evaluates eagerly).
  let blocked = {};

  // ---- persisted state: { fired, openrouterBaseline, acks } -----------------
  // acks: "<period>:<periodKey>" -> {by, ts} — operator acknowledgements that
  // clear dispatch blocking for the current window (pruned on window roll).
  let state = loadState();

  function loadState() {
    const empty = { fired: {}, openrouterBaseline: {}, acks: {} };
    if (!stateFile) return empty;
    try {
      if (!fs.existsSync(stateFile)) return empty;
      const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      return {
        fired: raw && typeof raw.fired === "object" && raw.fired !== null ? raw.fired : {},
        openrouterBaseline:
          raw && typeof raw.openrouterBaseline === "object" && raw.openrouterBaseline !== null
            ? raw.openrouterBaseline
            : {},
        acks: raw && typeof raw.acks === "object" && raw.acks !== null ? raw.acks : {},
      };
    } catch (e) {
      log.warn(`[Budgets] Failed to read state file ${stateFile}: ${e.message}`);
      return empty;
    }
  }

  function saveState() {
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmpFile = `${stateFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmpFile, `${JSON.stringify(state, null, 2)}\n`);
      fs.renameSync(tmpFile, stateFile);
    } catch (e) {
      log.warn(`[Budgets] Failed to persist state to ${stateFile}: ${e.message}`);
    }
  }

  /** Drop fired entries + baselines + acks from non-current periods. */
  function pruneState(currentKeys) {
    let changed = false;
    const next = {};
    for (const [key, value] of Object.entries(state.fired)) {
      const [period, pKey] = key.split(":");
      if (currentKeys[period] === pKey) next[key] = value;
      else changed = true;
    }
    const nextAcks = {};
    for (const [key, value] of Object.entries(state.acks)) {
      const [period, pKey] = key.split(":");
      if (currentKeys[period] === pKey) nextAcks[key] = value;
      else changed = true;
    }
    for (const period of Object.keys(state.openrouterBaseline)) {
      const baseline = state.openrouterBaseline[period];
      if (!baseline || baseline.periodKey !== currentKeys[period]) {
        delete state.openrouterBaseline[period];
        changed = true;
      }
    }
    if (changed) state = { ...state, fired: next, acks: nextAcks };
    return changed;
  }

  // ---- spend computation ----------------------------------------------------

  /**
   * Window spend from one getUsage() result: {byProvider, totalUSD}.
   * Updates the persisted OpenRouter baseline (cumulative → window delta).
   */
  function computeSpend(usage, period, key) {
    const byProvider = {};
    let hasApiSignal = false;

    if (usage.nineRouterByProvider && typeof usage.nineRouterByProvider === "object") {
      hasApiSignal = true;
      for (const [provider, value] of Object.entries(usage.nineRouterByProvider)) {
        const usd = Number(value);
        if (Number.isFinite(usd)) byProvider[provider] = (byProvider[provider] || 0) + usd;
      }
    }

    if (Number.isFinite(usage.openrouterCumulativeUSD)) {
      hasApiSignal = true;
      const cumulative = usage.openrouterCumulativeUSD;
      const baseline = state.openrouterBaseline[period];
      if (!baseline || baseline.periodKey !== key || baseline.value > cumulative) {
        // New period (or counter reset): the first observation becomes the
        // baseline, so the window delta starts at 0.
        state.openrouterBaseline = {
          ...state.openrouterBaseline,
          [period]: { periodKey: key, value: cumulative },
        };
        byProvider.openrouter = 0;
      } else {
        byProvider.openrouter = round2(cumulative - baseline.value);
      }
    }

    // Informative provider scope only — excluded from totals (see header).
    if (Number.isFinite(usage.claudeCodeUSD)) {
      byProvider["claude-code"] = usage.claudeCodeUSD;
    }

    let totalUSD = 0;
    for (const [provider, usd] of Object.entries(byProvider)) {
      if (provider !== "claude-code") totalUSD += usd;
    }
    if (!hasApiSignal && Number.isFinite(usage.tokensEstUSD)) {
      totalUSD = usage.tokensEstUSD; // est-cost fallback
    }
    return { byProvider, totalUSD: round2(totalUSD) };
  }

  // ---- dispatch-block registry ------------------------------------------------

  /**
   * Refresh the block registry for one scope from a freshly computed spend.
   * Crossing 100% adds the entry; dropping back below removes it. Stale
   * entries from rolled-over windows are filtered at read time.
   */
  function recordBlockState(period, key, scope, limitUSD, spentUSD) {
    const blockKey = `${period}:${key}:${scope}`;
    if (limitUSD > 0 && spentUSD / limitUSD >= CRITICAL_RATIO) {
      blocked = {
        ...blocked,
        [blockKey]: { period, periodKey: key, scope, limitUSD, spentUSD: round2(spentUSD) },
      };
    } else if (blocked[blockKey]) {
      const rest = { ...blocked };
      delete rest[blockKey];
      blocked = rest;
    }
  }

  /** Block entries for the CURRENT windows only, unacked first. */
  function currentBlocks(now) {
    const currentKeys = { daily: dailyKey(now), weekly: weeklyKey(now) };
    return Object.values(blocked).filter((entry) => currentKeys[entry.period] === entry.periodKey);
  }

  /**
   * Dispatch guard for the kanban dispatch route. Returns null when
   * dispatching is allowed, otherwise the first unacknowledged over-budget
   * scope: {scope, spent, limit, period, periodKey}.
   *
   * Synchronous by design — it reads the registry maintained by
   * evaluate()/getStatus() (budgets.start() evaluates eagerly at boot, so
   * the registry is warm before the first dispatch can arrive).
   */
  function checkDispatchBlock() {
    if (!cfg.enabled || !cfg.enforce.enabled) return null;
    const now = nowFn();
    for (const entry of currentBlocks(now)) {
      if (state.acks[`${entry.period}:${entry.periodKey}`]) continue; // acknowledged
      return {
        scope: entry.scope,
        spent: entry.spentUSD,
        limit: entry.limitUSD,
        period: entry.period,
        periodKey: entry.periodKey,
      };
    }
    return null;
  }

  /**
   * Operator acknowledgement: clears dispatch blocking for every currently
   * blocked window (the ack is per period-window and expires automatically
   * when the window rolls — see pruneState).
   *
   * @param {string} [user]
   * @returns {{acked: string[]}} the "<period>:<periodKey>" windows acked
   */
  function ack(user = "anonymous") {
    const now = nowFn();
    const acked = [];
    for (const entry of currentBlocks(now)) {
      const ackKey = `${entry.period}:${entry.periodKey}`;
      if (acked.includes(ackKey)) continue;
      acked.push(ackKey);
      if (!state.acks[ackKey]) {
        state = { ...state, acks: { ...state.acks, [ackKey]: { by: user, ts: now } } };
      }
    }
    if (acked.length > 0) saveState();
    return { acked };
  }

  // ---- breach checks ----------------------------------------------------------

  function firedKey(period, key, scope, severity) {
    return `${period}:${key}:${scope}:${severity}`;
  }

  /** Returns true when state changed (a breach was recorded). */
  function checkScope(period, key, scope, budgetUSD, actualUSD, now) {
    const ratio = budgetUSD > 0 ? actualUSD / budgetUSD : 0;
    const severity = ratio >= CRITICAL_RATIO ? "critical" : ratio >= WARN_RATIO ? "warn" : null;
    if (!severity) return false;

    const sevKey = firedKey(period, key, scope, severity);
    if (state.fired[sevKey]) return false;

    const record = { ts: now, budgetUSD, actualUSD: round2(actualUSD) };
    const fired = { ...state.fired, [sevKey]: record };
    // Critical implies warn — mark both so a later dip/rise can't re-warn.
    const warnKey = firedKey(period, key, scope, "warn");
    if (severity === "critical" && !fired[warnKey]) fired[warnKey] = record;
    state = { ...state, fired };

    try {
      onBreach({
        period,
        periodKey: key,
        scope,
        severity,
        budgetUSD,
        actualUSD: round2(actualUSD),
        ratio: Math.round(ratio * 1000) / 1000,
      });
    } catch (e) {
      log.error(`[Budgets] onBreach callback failed: ${e.message}`);
    }
    return true;
  }

  // ---- evaluation loop ----------------------------------------------------------

  async function evaluateOnce() {
    if (!cfg.enabled) return { checked: false, reason: "disabled" };

    const now = nowFn();
    const currentKeys = { daily: dailyKey(now), weekly: weeklyKey(now) };
    let dirty = pruneState(currentKeys);
    const spendByPeriod = {};

    for (const period of ["daily", "weekly"]) {
      const periodCfg = cfg[period];
      const providerScopes = Object.entries(periodCfg.perProvider);
      if (periodCfg.totalUSD <= 0 && providerScopes.length === 0) continue;

      let usage;
      try {
        usage = await getUsage({ sinceMs: periodStartMs(period, now), period });
      } catch (e) {
        log.error(`[Budgets] getUsage failed (${period}): ${e.message}`);
        continue;
      }
      if (!usage || typeof usage !== "object") {
        if (!warnedNoProvider) {
          warnedNoProvider = true;
          log.warn("[Budgets] No usage provider wired yet — budget checks are skipped");
        }
        continue;
      }

      const key = periodKey(period, now);
      const spend = computeSpend(usage, period, key);
      spendByPeriod[period] = spend;
      dirty = true; // baselines may have moved; cheap to persist per check

      if (periodCfg.totalUSD > 0) {
        checkScope(period, key, "total", periodCfg.totalUSD, spend.totalUSD, now);
        recordBlockState(period, key, "total", periodCfg.totalUSD, spend.totalUSD);
      }
      for (const [provider, budgetUSD] of providerScopes) {
        const actual = Number(spend.byProvider[provider]) || 0;
        checkScope(period, key, `provider:${provider}`, budgetUSD, actual, now);
        recordBlockState(period, key, `provider:${provider}`, budgetUSD, actual);
      }
    }

    if (dirty) saveState();
    lastCheck = now;
    lastSpend = spendByPeriod;
    return { checked: true, spend: spendByPeriod };
  }

  /** Single-flight evaluation; never throws. */
  function evaluate() {
    if (evaluating) return evaluating;
    evaluating = evaluateOnce()
      .catch((e) => {
        log.error(`[Budgets] Evaluation failed: ${e.message}`);
        return { checked: false, reason: e.message };
      })
      .finally(() => {
        evaluating = null;
      });
    return evaluating;
  }

  function start() {
    if (timer || !cfg.enabled) return;
    evaluate(); // immediate first check
    timer = setInterval(evaluate, cfg.checkIntervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  /** Hot-apply a new fleet.budgets config (settings PATCH path). */
  function applyConfig(newConfig) {
    stop();
    cfg = normalizeBudgetsConfig(newConfig);
    if (cfg.enabled) start();
  }

  /**
   * Read-only mid-period snapshot for the dashboard burn-down gauges.
   *
   * Reuses computeSpend() — the exact aggregation the breach evaluator
   * runs — so the gauges can never disagree with the alerts. Unlike
   * evaluate(), this never fires onBreach and never persists state (the
   * in-memory OpenRouter baseline may advance for a new period; the next
   * evaluate() persists it, same as before).
   *
   * Returns { enabled: false } when disabled or when no scope has a limit,
   * otherwise:
   *   { enabled: true, generatedAt, periods: { daily?, weekly? } }
   * where each period is
   *   { periodKey, elapsedPct, usageAvailable,
   *     scopes: [{ scope, limitUSD, spentUSD, percent, state }] }
   * with state one of "ok" | "warn" | "critical" and scope "total" or
   * "provider:<name>".
   */
  async function getStatus() {
    if (!cfg.enabled) return { enabled: false };

    const now = nowFn();
    const periods = {};

    for (const period of ["daily", "weekly"]) {
      const periodCfg = cfg[period];
      const providerScopes = Object.entries(periodCfg.perProvider);
      if (periodCfg.totalUSD <= 0 && providerScopes.length === 0) continue;

      const startMs = periodStartMs(period, now);
      const lengthMs = period === "daily" ? DAY_MS : 7 * DAY_MS;
      const elapsedPct = round1(Math.min(100, Math.max(0, ((now - startMs) / lengthMs) * 100)));

      let usage = null;
      try {
        usage = await getUsage({ sinceMs: startMs, period });
      } catch (e) {
        log.error(`[Budgets] getUsage failed for status (${period}): ${e.message}`);
      }
      const usageAvailable = Boolean(usage && typeof usage === "object");
      const key = periodKey(period, now);
      const spend = usageAvailable
        ? computeSpend(usage, period, key)
        : { byProvider: {}, totalUSD: 0 };

      const scopes = [];
      if (periodCfg.totalUSD > 0) {
        scopes.push(scopeStatus("total", periodCfg.totalUSD, spend.totalUSD));
        if (usageAvailable)
          recordBlockState(period, key, "total", periodCfg.totalUSD, spend.totalUSD);
      }
      for (const [provider, limitUSD] of providerScopes) {
        const actual = Number(spend.byProvider[provider]) || 0;
        scopes.push(scopeStatus(`provider:${provider}`, limitUSD, actual));
        if (usageAvailable) recordBlockState(period, key, `provider:${provider}`, limitUSD, actual);
      }
      periods[period] = { periodKey: key, elapsedPct, usageAvailable, scopes };
    }

    if (Object.keys(periods).length === 0) return { enabled: false };
    return {
      enabled: true,
      generatedAt: now,
      periods,
      enforcement: {
        enabled: cfg.enforce.enabled,
        blocked: currentBlocks(now).map((entry) => ({
          period: entry.period,
          periodKey: entry.periodKey,
          scope: entry.scope,
          limitUSD: entry.limitUSD,
          spentUSD: entry.spentUSD,
          acked: Boolean(state.acks[`${entry.period}:${entry.periodKey}`]),
        })),
        acks: Object.entries(state.acks).map(([window, value]) => ({
          window,
          by: value.by || "anonymous",
          ts: value.ts || null,
        })),
      },
    };
  }

  function getState() {
    return {
      enabled: cfg.enabled,
      checkIntervalMs: cfg.checkIntervalMs,
      enforceEnabled: cfg.enforce.enabled,
      lastCheck,
      lastSpend,
      firedCount: Object.keys(state.fired).length,
      blockedCount: Object.keys(blocked).length,
      ackCount: Object.keys(state.acks).length,
    };
  }

  return {
    start,
    stop,
    evaluate,
    applyConfig,
    getState,
    getStatus,
    checkDispatchBlock,
    ack,
  };
}

/**
 * Standard getUsage implementation over the usage-sources module
 * (src/usage-sources). Wire it from the orchestrator:
 *
 *   fleet.setUsageProvider(createUsageProvider({ usageSources }));
 *
 * Every sub-source is individually guarded; a broken source simply drops
 * its field from the aggregate.
 */
function createUsageProvider({ usageSources }) {
  if (!usageSources || !usageSources.sources) {
    throw new TypeError("createUsageProvider requires a usageSources instance");
  }
  const { nineRouter, openrouter, claudeCode } = usageSources.sources;

  return async function getUsage({ sinceMs, period }) {
    const out = {};

    try {
      if (nineRouter && nineRouter.describe().available) {
        const usage = await nineRouter.getUsage({ sinceMs });
        if (usage && Array.isArray(usage.byProvider)) {
          out.nineRouterByProvider = {};
          for (const row of usage.byProvider) {
            if (row && typeof row.provider === "string") {
              out.nineRouterByProvider[row.provider] = Number(row.cost) || 0;
            }
          }
        }
      }
    } catch (e) {
      console.error("[Budgets] nine-router usage read failed:", e.message);
    }

    try {
      if (openrouter && openrouter.available) {
        const credits = await openrouter.getCredits();
        if (credits && Number.isFinite(credits.totalUsage)) {
          out.openrouterCumulativeUSD = credits.totalUsage;
        }
      }
    } catch (e) {
      console.error("[Budgets] openrouter usage read failed:", e.message);
    }

    try {
      if (claudeCode && claudeCode.describe().available) {
        const windows = await claudeCode.getUsageWindows();
        if (windows && windows.available) {
          const bucket = period === "weekly" ? windows.d7 : windows.h24;
          if (bucket && Number.isFinite(bucket.estCost)) {
            out.claudeCodeUSD = bucket.estCost;
            out.tokensEstUSD = bucket.estCost;
          }
        }
      }
    } catch (e) {
      console.error("[Budgets] claude-code usage read failed:", e.message);
    }

    return out;
  };
}

module.exports = {
  createBudgets,
  createUsageProvider,
  normalizeBudgetsConfig,
  // exported for tests
  dailyKey,
  weeklyKey,
  periodStartMs,
};
