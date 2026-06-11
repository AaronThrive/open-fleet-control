/**
 * OpenRouter usage source — credits + key info from the OpenRouter REST API.
 *
 *   GET /api/v1/credits   -> { data: { total_credits, total_usage } }
 *   GET /api/v1/auth/key  -> { data: { label, usage, limit, rate_limit, ... } }
 *
 * The API key is accepted as a constructor parameter only (the orchestrator
 * sources it from env/config). It may be a 1Password reference
 * (op://vault/item/field): refs count as "configured" and are resolved
 * LAZILY through the secrets layer right before each API call (the layer
 * caches per ref), so a ref that failed at boot recovers without a restart.
 * The key is never logged and never included in any returned object or
 * error message. Requests time out after 10 seconds. Errors are returned as
 * { error } — never thrown to callers.
 */

const { defaultSecrets } = require("../secrets");

const DEFAULT_BASE_URL = "https://openrouter.ai";
const DEFAULT_TIMEOUT_MS = 10000;

function defaultFetchFn(...args) {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("global fetch is not available in this runtime");
  }
  return globalThis.fetch(...args);
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Create the OpenRouter usage source.
 *
 * @param {object} [options]
 * @param {string} [options.apiKey] - OpenRouter API key, literal or op:// ref
 *   (caller-provided only)
 * @param {function} [options.fetchFn] - fetch-compatible function (for tests)
 * @param {object} [options.secrets] - secrets resolver for op:// keys
 *   (default: shared resolver; injectable so tests never spawn the op CLI)
 * @param {string} [options.baseUrl] - default https://openrouter.ai
 * @param {number} [options.timeoutMs] - default 10000
 */
function createOpenRouterSource(options = {}) {
  const apiKey = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
  const fetchFn = options.fetchFn || defaultFetchFn;
  const secrets = options.secrets || defaultSecrets;
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const available = apiKey.length > 0;
  const isRef = secrets.isSecretRef(apiKey);

  /**
   * Effective key for one request: literals pass through; op:// refs resolve
   * lazily through the (caching) secrets layer. Returns null when an op://
   * ref cannot be resolved — the caller must NOT hit the API in that case.
   */
  function effectiveKey() {
    if (!isRef) return apiKey;
    const result = secrets.resolveSync(apiKey);
    return result.ok ? result.value : null;
  }

  /** Strip the key from any string that might echo request details. */
  function scrub(text, key) {
    const message = String(text || "");
    return key ? message.split(key).join("[redacted]") : message;
  }

  /** GET an API path; resolves { ok, status, body } or { error }. */
  async function request(pathname) {
    if (!available) {
      return { error: "OpenRouter API key not configured" };
    }
    const key = effectiveKey();
    if (key === null) {
      // Ref + scrubbed failure detail live in the secrets module status.
      return { error: "OpenRouter API key (1Password ref) could not be resolved" };
    }
    const controller =
      typeof globalThis.AbortController === "function" ? new globalThis.AbortController() : null;
    const timer = setTimeout(() => {
      if (controller) controller.abort();
    }, timeoutMs);
    try {
      const res = await fetchFn(`${baseUrl}${pathname}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
        signal: controller ? controller.signal : undefined,
      });
      if (!res.ok) {
        return { error: `OpenRouter API returned HTTP ${res.status}` };
      }
      let body;
      try {
        body = await res.json();
      } catch (e) {
        return { error: "OpenRouter API returned non-JSON body" };
      }
      return { body };
    } catch (e) {
      const reason =
        e && e.name === "AbortError"
          ? `request timed out after ${timeoutMs}ms`
          : scrub(e.message, key);
      return { error: reason };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Account credits: { totalCredits, totalUsage, remaining } or { error }. */
  async function getCredits() {
    const res = await request("/api/v1/credits");
    if (res.error) return { available, error: res.error };
    // Handle both { data: {...} } envelope and flat payload variations.
    const data =
      res.body && typeof res.body === "object" && res.body.data && typeof res.body.data === "object"
        ? res.body.data
        : res.body || {};
    const totalCredits = toNumber(data.total_credits ?? data.totalCredits);
    const totalUsage = toNumber(data.total_usage ?? data.totalUsage);
    return {
      available,
      totalCredits,
      totalUsage,
      remaining:
        totalCredits !== null && totalUsage !== null
          ? Math.round((totalCredits - totalUsage) * 1e6) / 1e6
          : null,
    };
  }

  /** API key metadata: label, usage, limit, rate limit. Never the key. */
  async function getKeyInfo() {
    const res = await request("/api/v1/auth/key");
    if (res.error) return { available, error: res.error };
    const data =
      res.body && typeof res.body === "object" && res.body.data && typeof res.body.data === "object"
        ? res.body.data
        : res.body || {};
    return {
      available,
      label: typeof data.label === "string" ? data.label : null,
      usage: toNumber(data.usage),
      limit: toNumber(data.limit),
      limitRemaining: toNumber(data.limit_remaining ?? data.limitRemaining),
      isFreeTier: typeof data.is_free_tier === "boolean" ? data.is_free_tier : null,
      rateLimit:
        data.rate_limit && typeof data.rate_limit === "object"
          ? {
              requests: toNumber(data.rate_limit.requests),
              interval: data.rate_limit.interval ?? null,
            }
          : null,
    };
  }

  return {
    source: "openrouter",
    available,
    reason: available ? undefined : "no API key configured",
    getCredits,
    getKeyInfo,
  };
}

module.exports = { createOpenRouterSource };
