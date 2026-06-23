/**
 * Plan-usage source — Claude (and Codex) subscription window state from
 * ~/.local/state/openclaw-quota/subscription_state.json (written by our own
 * plan-usage poller).
 *
 * Normalizes the snake_case file format into camelCase, flags stale data
 * (polled more than 30 minutes ago), and redacts key material: the file's
 * `token_prefix` field is never returned.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_STATS_PATH = path.join(
  os.homedir(),
  ".local",
  "state",
  "openclaw-quota",
  "subscription_state.json",
);
const STALE_AFTER_MS = 30 * 60 * 1000;

/** Finite number, or null for null/undefined/empty/junk (never 0-coerced). */
function toFiniteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/** Normalize one rate-limit window ({ utilization_pct, resets_at, ... }). */
function normalizeWindow(window) {
  if (!window || typeof window !== "object") return null;
  return {
    utilizationPct: toFiniteOrNull(window.utilization_pct),
    resetsAt: window.resets_at ?? null,
    secondsToReset: toFiniteOrNull(window.seconds_to_reset),
  };
}

function normalizeExtraUsage(extra) {
  if (!extra || typeof extra !== "object") return null;
  return {
    isEnabled: Boolean(extra.is_enabled),
    monthlyLimitUsd: Number(extra.monthly_limit_usd) || 0,
    usedCreditsUsd: Number(extra.used_credits_usd) || 0,
    utilizationPct: toFiniteOrNull(extra.utilization_pct),
  };
}

function normalizeTokenBucket(bucket) {
  if (!bucket || typeof bucket !== "object") return null;
  return {
    input: Number(bucket.input) || 0,
    output: Number(bucket.output) || 0,
    cacheReads: Number(bucket.cache_reads) || 0,
    cacheWritesTotal: Number(bucket.cache_writes_total) || 0,
  };
}

/** Normalize one Codex rate-limit window ({ utilization_pct, resets_at }). */
function normalizeCodexWindow(window) {
  if (!window || typeof window !== "object") return null;
  return {
    utilizationPct: toFiniteOrNull(window.utilization_pct),
    resetsAt: window.resets_at ?? null,
  };
}

/** Normalize the Codex credits block ({ balance, has_credits, unlimited }). */
function normalizeCodexCredits(credits) {
  if (!credits || typeof credits !== "object") return null;
  return {
    balance: toFiniteOrNull(credits.balance),
    hasCredits: Boolean(credits.has_credits),
    unlimited: Boolean(credits.unlimited),
  };
}

/**
 * Create the plan-usage subscription source.
 *
 * @param {object} [options]
 * @param {string} [options.statsPath] - default
 *        ~/.local/state/openclaw-quota/subscription_state.json
 * @param {function} [options.nowFn] - () => epoch ms (for staleness)
 */
function createPlanUsageSource(options = {}) {
  const statsPath = options.statsPath || DEFAULT_STATS_PATH;
  const nowFn = options.nowFn || Date.now;

  function describe() {
    if (!fs.existsSync(statsPath)) {
      return { available: false, reason: `file not found: ${statsPath}` };
    }
    return { available: true };
  }

  /** Read + parse the stats file, or null with a reason. Never throws. */
  function readState() {
    const status = describe();
    if (!status.available) return { error: status.reason };

    let data;
    try {
      data = JSON.parse(fs.readFileSync(statsPath, "utf8"));
    } catch (e) {
      return { error: `unreadable subscription state: ${e.message}` };
    }
    if (!data || typeof data !== "object") {
      return { error: "subscription state is not an object" };
    }
    return { data };
  }

  /** Stale if polledAt is missing/unparseable or older than the window. */
  function isStale(polledAt) {
    const polledMs = polledAt ? Date.parse(polledAt) : NaN;
    return !Number.isFinite(polledMs) || nowFn() - polledMs > STALE_AFTER_MS;
  }

  /** Normalized subscription snapshot. Never throws. */
  async function getSubscription() {
    const state = readState();
    if (state.error) return { available: false, reason: state.error };
    const data = state.data;

    const latest = data.latest && typeof data.latest === "object" ? data.latest : {};
    const windowTokens =
      data.window_tokens && typeof data.window_tokens === "object" ? data.window_tokens : {};

    const polledAt = latest.polled_at ?? null;
    const stale = isStale(polledAt);

    const byModel = {};
    if (windowTokens.by_model && typeof windowTokens.by_model === "object") {
      for (const [model, bucket] of Object.entries(windowTokens.by_model)) {
        const normalized = normalizeTokenBucket(bucket);
        if (normalized) byModel[model] = normalized;
      }
    }

    // Note: latest.token_prefix is deliberately never returned (key material).
    return {
      available: true,
      fiveHour: normalizeWindow(latest.five_hour),
      sevenDay: normalizeWindow(latest.seven_day),
      sevenDaySonnet: normalizeWindow(latest.seven_day_sonnet),
      extraUsage: normalizeExtraUsage(latest.extra_usage),
      windowTokens: {
        ...(normalizeTokenBucket(windowTokens) || {
          input: 0,
          output: 0,
          cacheReads: 0,
          cacheWritesTotal: 0,
        }),
        totalRaw: Number(windowTokens.total_raw) || 0,
        weightedTokenEquivalent: Number(windowTokens.weighted_token_equivalent) || 0,
      },
      byModel,
      polledAt,
      stale,
    };
  }

  /**
   * Normalized Codex plan-usage snapshot from the top-level `codex` block.
   * Never throws. Degrades gracefully (available:false) when the block is
   * absent, the file is missing, or the Codex poller reported unavailable.
   */
  async function getCodex() {
    const state = readState();
    if (state.error) return { available: false, reason: state.error };

    const codex = state.data.codex;
    if (!codex || typeof codex !== "object") {
      return { available: false, reason: "no codex block in subscription state" };
    }
    if (codex.available === false) {
      return { available: false, reason: "codex plan usage unavailable" };
    }

    const polledAt = codex.polled_at ?? null;
    // Honor an explicit stale flag from the poller; otherwise derive from age.
    const stale = typeof codex.stale === "boolean" ? codex.stale : isStale(polledAt);

    return {
      available: true,
      planType: codex.plan_type ?? null,
      fiveHour: normalizeCodexWindow(codex.five_hour),
      sevenDay: normalizeCodexWindow(codex.seven_day),
      credits: normalizeCodexCredits(codex.credits),
      polledAt,
      stale,
    };
  }

  const status = describe();
  return {
    source: "plan-usage",
    available: status.available,
    reason: status.reason,
    describe,
    getSubscription,
    getCodex,
  };
}

module.exports = { createPlanUsageSource };
