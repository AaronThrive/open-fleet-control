/**
 * Generic token-bucket rate limiter.
 *
 * Each key gets its own bucket holding up to `max` tokens that refill
 * continuously at a rate of `max` tokens per `windowMs`. Stale buckets are
 * swept lazily during check() calls so the key map cannot grow unbounded.
 */

const DEFAULT_WINDOW_MS = 60000;
const DEFAULT_MAX = 120;
const STALE_WINDOW_MULTIPLIER = 2;

/**
 * Create a token-bucket rate limiter.
 *
 * @param {object} [options]
 * @param {number} [options.windowMs=60000] - Window over which `max` requests are allowed
 * @param {number} [options.max=120] - Maximum requests per window (bucket capacity)
 * @param {function} [options.nowFn=Date.now] - Injectable clock for tests
 * @returns {{check: function(string): {allowed: boolean, remaining: number, retryAfterMs: number}, size: function(): number}}
 */
function createRateLimiter({
  windowMs = DEFAULT_WINDOW_MS,
  max = DEFAULT_MAX,
  nowFn = Date.now,
} = {}) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError("windowMs must be a positive number");
  }
  if (!Number.isFinite(max) || max <= 0) {
    throw new TypeError("max must be a positive number");
  }
  if (typeof nowFn !== "function") {
    throw new TypeError("nowFn must be a function");
  }

  const buckets = new Map();
  let lastSweep = nowFn();

  // Lazy cleanup: at most once per window, drop buckets idle for 2+ windows.
  function sweep(now) {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    const staleBefore = now - windowMs * STALE_WINDOW_MULTIPLIER;
    for (const [key, bucket] of buckets) {
      if (bucket.lastSeen < staleBefore) {
        buckets.delete(key);
      }
    }
  }

  /**
   * Check (and consume) one request for the given key.
   *
   * @param {string} key - Bucket key (e.g. IP address, client id)
   * @returns {{allowed: boolean, remaining: number, retryAfterMs: number}}
   */
  function check(key) {
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("key must be a non-empty string");
    }

    const now = nowFn();
    sweep(now);

    // Multiply before dividing to avoid floating-point drift on exact refills
    const existing = buckets.get(key);
    const refilled = existing
      ? Math.min(max, existing.tokens + (Math.max(0, now - existing.last) * max) / windowMs)
      : max;

    if (refilled >= 1) {
      const tokens = refilled - 1;
      buckets.set(key, { tokens, last: now, lastSeen: now });
      return { allowed: true, remaining: Math.floor(tokens), retryAfterMs: 0 };
    }

    buckets.set(key, { tokens: refilled, last: now, lastSeen: now });
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.ceil(((1 - refilled) * windowMs) / max),
    };
  }

  // Number of tracked keys (exposed for observability and tests).
  function size() {
    return buckets.size;
  }

  return { check, size };
}

module.exports = { createRateLimiter };
