/**
 * Alert engine with pluggable sinks (webhooks + Slack via OpenClaw gateway).
 *
 * Events are deduplicated (same type+node/task within 5 minutes fires once),
 * recorded in a ring buffer for the UI, and dispatched to all matching sinks.
 * Sink delivery is resilient: 10s timeout, one retry, failures are logged and
 * never thrown to the caller. The dashboard never holds Slack tokens — the
 * Slack sink only POSTs {channel, text} to the configured gateway URL.
 */

const crypto = require("crypto");

const SEVERITIES = new Set(["info", "warn", "critical"]);
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const RING_BUFFER_SIZE = 200;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RETRY_DELAY_MS = 30000;
const DEFAULT_RECENT_LIMIT = 50;
const DEDUPE_SWEEP_THRESHOLD = 1000;
const ALERT_SOURCE = "open-fleet-control";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Validate and normalize a fired event, throwing descriptive errors.
 * @param {object} event
 * @param {function} nowFn
 * @returns {object} Normalized event
 */
function normalizeEvent(event, nowFn) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new TypeError("event must be an object");
  }
  if (typeof event.type !== "string" || event.type.length === 0) {
    throw new TypeError("event.type must be a non-empty string");
  }
  const severity = event.severity === undefined ? "info" : event.severity;
  if (!SEVERITIES.has(severity)) {
    throw new TypeError("event.severity must be one of: info, warn, critical");
  }
  return {
    type: event.type,
    severity,
    node: event.node != null ? String(event.node) : null,
    task: event.task != null ? String(event.task) : null,
    message: event.message != null ? String(event.message) : "",
    ts: Number.isFinite(event.ts) ? event.ts : nowFn(),
  };
}

/**
 * Create the alert engine.
 *
 * @param {object} options
 * @param {object} options.config - The `fleet.alerts` config section:
 *   {enabled, rules: {nodeOffline, nodeUnreachable, taskFailed, taskStale, lessonPending},
 *    sinks: {slack: {enabled, gatewayUrl, channel}, webhooks: [{url, secret, events}]}}
 * @param {function} [options.fetchFn=fetch] - Injectable fetch for tests
 * @param {function} [options.nowFn=Date.now] - Injectable clock for tests
 * @param {number} [options.timeoutMs=10000] - Per-request timeout
 * @param {number} [options.retryDelayMs=30000] - Delay before the single retry
 * @returns {{fire: function, getRecent: function}}
 */
function createAlerts({
  config = {},
  fetchFn = globalThis.fetch,
  nowFn = Date.now,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
} = {}) {
  if (typeof fetchFn !== "function") {
    throw new TypeError("fetchFn must be a function");
  }

  const dedupeLastFired = new Map();
  let recentAlerts = [];

  // Lazy cleanup so the dedupe map cannot grow unbounded.
  function sweepDedupe(now) {
    if (dedupeLastFired.size < DEDUPE_SWEEP_THRESHOLD) return;
    for (const [key, ts] of dedupeLastFired) {
      if (now - ts >= DEDUPE_WINDOW_MS) {
        dedupeLastFired.delete(key);
      }
    }
  }

  async function postOnce(url, body, headers) {
    const controller = new globalThis.AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (res && typeof res.ok === "boolean" && !res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // One attempt + one retry after retryDelayMs; never throws.
  async function postWithRetry(label, url, body, headers) {
    try {
      await postOnce(url, body, headers);
      return true;
    } catch (err) {
      console.error(
        `[Alerts] ${label} delivery to ${url} failed (retrying in ${retryDelayMs}ms):`,
        err.message,
      );
    }

    await delay(retryDelayMs);

    try {
      await postOnce(url, body, headers);
      return true;
    } catch (err) {
      console.error(
        `[Alerts] ${label} delivery to ${url} failed after retry, giving up:`,
        err.message,
      );
      return false;
    }
  }

  function webhookMatchesEvent(webhook, type) {
    const events = Array.isArray(webhook.events) ? webhook.events : ["*"];
    return events.includes("*") || events.includes(type);
  }

  function dispatchToWebhook(webhook, alert) {
    const body = JSON.stringify({
      event: alert.type,
      severity: alert.severity,
      node: alert.node,
      task: alert.task,
      message: alert.message,
      ts: alert.ts,
      source: ALERT_SOURCE,
    });

    const headers = { "Content-Type": "application/json" };
    if (webhook.secret) {
      const hmac = crypto.createHmac("sha256", webhook.secret).update(body).digest("hex");
      headers["X-OFC-Signature"] = `sha256=${hmac}`;
    }

    return postWithRetry("webhook", webhook.url, body, headers);
  }

  function dispatchToSlack(slack, alert) {
    const context = [
      alert.node ? `node=${alert.node}` : null,
      alert.task ? `task=${alert.task}` : null,
    ]
      .filter(Boolean)
      .join(" ");

    const text = `[${alert.severity.toUpperCase()}] ${alert.type}${context ? ` (${context})` : ""}: ${alert.message}`;
    const body = JSON.stringify({ channel: slack.channel, text });

    return postWithRetry("slack", slack.gatewayUrl, body, {
      "Content-Type": "application/json",
    });
  }

  /**
   * Fire an alert event: dedupe, record, and dispatch to matching sinks.
   * Sink failures never propagate to the caller.
   *
   * @param {{type: string, severity?: string, node?: string, task?: string, message?: string, ts?: number}} event
   * @returns {Promise<{fired: boolean, reason?: string, dispatched?: number, delivered?: number}>}
   */
  async function fire(event) {
    const alert = normalizeEvent(event, nowFn);

    if (!config.enabled) {
      return { fired: false, reason: "disabled" };
    }

    const rules = config.rules || {};
    if (Object.prototype.hasOwnProperty.call(rules, alert.type) && !rules[alert.type]) {
      return { fired: false, reason: "rule-disabled" };
    }

    const now = nowFn();
    sweepDedupe(now);
    const dedupeKey = `${alert.type}:${alert.node || ""}:${alert.task || ""}`;
    const lastFired = dedupeLastFired.get(dedupeKey);
    if (lastFired !== undefined && now - lastFired < DEDUPE_WINDOW_MS) {
      return { fired: false, reason: "deduped" };
    }
    dedupeLastFired.set(dedupeKey, now);

    recentAlerts = [...recentAlerts, alert].slice(-RING_BUFFER_SIZE);

    const sinks = config.sinks || {};
    const dispatches = [];

    for (const webhook of Array.isArray(sinks.webhooks) ? sinks.webhooks : []) {
      if (webhook && webhook.url && webhookMatchesEvent(webhook, alert.type)) {
        dispatches.push(dispatchToWebhook(webhook, alert));
      }
    }

    if (sinks.slack && sinks.slack.enabled && sinks.slack.gatewayUrl) {
      dispatches.push(dispatchToSlack(sinks.slack, alert));
    }

    const results = await Promise.allSettled(dispatches);
    const delivered = results.filter((r) => r.status === "fulfilled" && r.value === true).length;

    return { fired: true, dispatched: dispatches.length, delivered };
  }

  /**
   * Last N fired alerts (ring buffer of 200), newest first.
   * @param {number} [limit=50]
   * @returns {Array<object>}
   */
  function getRecent(limit = DEFAULT_RECENT_LIMIT) {
    const parsed = Number(limit);
    const effective =
      Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_RECENT_LIMIT;
    return recentAlerts.slice(-effective).reverse();
  }

  return { fire, getRecent };
}

module.exports = { createAlerts };
