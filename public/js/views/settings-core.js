/**
 * Settings view — pure logic (no DOM, no fetch).
 *
 * Extracted from js/views/settings.js so the section-isolation and
 * restart-flow behavior is unit-testable under node:test (dynamic import,
 * same pattern as components/detail-list.js).
 */

/**
 * Apply server settings to a list of independent page sections.
 *
 * Each section's `apply(settings)` runs in isolation: one section throwing
 * (bad data shape, missing markup, renderer bug) no longer prevents the
 * remaining sections from rendering. Returns one result per section so the
 * caller can show an inline error chip on the failed card only.
 *
 * @param {object} settings - server settings payload
 * @param {Array<{name: string, apply: function}>} sections
 * @returns {Array<{name: string, ok: boolean, error: string|null}>}
 */
export function applySections(settings, sections) {
  return (sections || []).map(({ name, apply }) => {
    try {
      apply(settings);
      return { name, ok: true, error: null };
    } catch (err) {
      return { name, ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

/**
 * Merge newly reported restartRequired paths into the accumulated set.
 * Returns a NEW Set (never mutates the input); non-array additions are
 * ignored so callers can pass a PATCH response field through unchecked.
 *
 * @param {Set<string>} current
 * @param {Array<string>|*} added
 * @returns {Set<string>}
 */
export function mergeRestartPaths(current, added) {
  const base = current instanceof Set ? current : new Set();
  if (!Array.isArray(added)) return new Set(base);
  return new Set([...base, ...added.filter((p) => typeof p === "string" && p.length > 0)]);
}

/**
 * Stable display string for the restart banner's path list.
 * @param {Set<string>|Array<string>} paths
 * @returns {string}
 */
export function formatRestartPaths(paths) {
  return [...(paths || [])].sort().join(", ");
}

/**
 * Poll an async health check until it reports healthy or the timeout
 * elapses. Used after POST /api/fleet/admin/restart: the service exits and
 * systemd respawns it ~5s later, so the first few checks are expected to
 * fail (thrown errors and falsy results both count as "still down").
 *
 * @param {object} options
 * @param {function} options.check - async () => boolean
 * @param {number} [options.timeoutMs=60000]
 * @param {number} [options.intervalMs=1000]
 * @param {function} [options.sleep] - async (ms) => void (injectable for tests)
 * @param {function} [options.now] - () => epoch ms (injectable for tests)
 * @returns {Promise<boolean>} true when healthy, false on timeout
 */
export async function pollUntilHealthy({
  check,
  timeoutMs = 60000,
  intervalMs = 1000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(intervalMs);
    try {
      if (await check()) return true;
    } catch (err) {
      // Still down/unreachable — keep polling until the deadline.
    }
  }
  return false;
}

/**
 * Build a bounded /api/health probe for pollUntilHealthy().
 *
 * Every probe is individually time-capped via AbortController: a request
 * that hangs on a dead or half-open connection resolves false after
 * timeoutMs instead of wedging the poll loop. Never throws — any fetch
 * failure (refused, aborted, network change) reads as "still down".
 *
 * @param {object} [options]
 * @param {function} [options.fetchFn] - fetch implementation (injectable for tests)
 * @param {string} [options.url]
 * @param {number} [options.timeoutMs] - per-probe cap (default 2000)
 * @returns {function(): Promise<boolean>}
 */
export function makeHealthCheck({
  fetchFn = (...args) => fetch(...args),
  url = "/api/health",
  timeoutMs = 2000,
} = {}) {
  return async function healthCheck() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(url, { signal: controller.signal, cache: "no-store" });
      return !!(response && response.ok);
    } catch (err) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Normalize the GET /api/about payload into the compact About-card model.
 * Tolerates a missing/failed payload by falling back to known constants —
 * the card must render even when the endpoint is unavailable.
 *
 * @param {object|null} payload - /api/about response (or null on failure)
 * @returns {{name: string, version: string, license: string}}
 */
export function aboutModel(payload) {
  const src = payload && typeof payload === "object" ? payload : {};
  const str = (value) => (typeof value === "string" && value.trim() ? value.trim() : "");
  return {
    name: str(src.name) || "Open Fleet Control",
    version: str(src.version) ? `v${str(src.version)}` : "",
    license: str(src.license) || "MIT",
  };
}
