/**
 * Headroom usage source — Claude Max subscription window state from
 * ~/.headroom/subscription_state.json (written by the headroom poller).
 *
 * Normalizes the snake_case file format into camelCase, flags stale data
 * (polled more than 30 minutes ago), and redacts key material: the file's
 * `token_prefix` field is never returned.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_STATS_PATH = path.join(os.homedir(), ".headroom", "subscription_state.json");
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

/**
 * Create the Headroom subscription source.
 *
 * @param {object} [options]
 * @param {string} [options.statsPath] - default ~/.headroom/subscription_state.json
 * @param {function} [options.nowFn] - () => epoch ms (for staleness)
 */
function createHeadroomSource(options = {}) {
  const statsPath = options.statsPath || DEFAULT_STATS_PATH;
  const nowFn = options.nowFn || Date.now;

  function describe() {
    if (!fs.existsSync(statsPath)) {
      return { available: false, reason: `file not found: ${statsPath}` };
    }
    return { available: true };
  }

  /** Normalized subscription snapshot. Never throws. */
  async function getSubscription() {
    const status = describe();
    if (!status.available) return { available: false, reason: status.reason };

    let data;
    try {
      data = JSON.parse(fs.readFileSync(statsPath, "utf8"));
    } catch (e) {
      return { available: false, reason: `unreadable subscription state: ${e.message}` };
    }
    if (!data || typeof data !== "object") {
      return { available: false, reason: "subscription state is not an object" };
    }

    const latest = data.latest && typeof data.latest === "object" ? data.latest : {};
    const windowTokens =
      data.window_tokens && typeof data.window_tokens === "object" ? data.window_tokens : {};

    const polledAt = latest.polled_at ?? null;
    const polledMs = polledAt ? Date.parse(polledAt) : NaN;
    const stale = !Number.isFinite(polledMs) || nowFn() - polledMs > STALE_AFTER_MS;

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

  const status = describe();
  return {
    source: "headroom",
    available: status.available,
    reason: status.reason,
    describe,
    getSubscription,
  };
}

module.exports = { createHeadroomSource };
