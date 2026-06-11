/**
 * Alert engine with pluggable sinks (webhooks + Slack via OpenClaw gateway
 * + ntfy push notifications).
 *
 * Events are deduplicated (same type+node/task within 5 minutes fires once),
 * recorded in a ring buffer for the UI, and dispatched to all matching sinks.
 * Sink delivery is resilient: 10s timeout, one retry, failures are logged and
 * never thrown to the caller. The dashboard never holds Slack tokens — the
 * Slack sink only POSTs {channel, text} to the configured gateway URL.
 *
 * ntfy sink: POSTs the alert message as plain text to <server>/<topic> with
 * ntfy publish headers (Title = event type + node/task context, Priority
 * mapped from severity, Tags from severity). No credentials are stored —
 * access control is the topic name itself (treat it like a secret).
 *
 * Routing: `config.routing` is an optional {<rule>: [sink names]} map that
 * restricts which sinks a rule's alerts are dispatched to. Sink names are
 * "slack", "ntfy", and "webhooks" (the whole webhook group — per-webhook
 * `events` filters still apply on top). A missing rule entry, a non-array
 * value, or an entry containing "*" means ALL sinks (fail open).
 *
 * Mutes: `config.mutes` is an array of {rule?, node?, until?} entries.
 * A FIRE-able alert matching any active (non-expired) entry is skipped
 * (reason "muted") and counted; muted alerts never consume the dedupe slot.
 *
 * History: when a `logsDir` is provided, every fired alert is also appended
 * to logs/alerts.jsonl (20MB rotation, keep 5) and query(filter) reads it
 * newest-first (see alerts-history.js).
 *
 * Test-mode delivery suppression (defense in depth): when the process runs
 * under `node --test` (NODE_TEST_CONTEXT) or OFC_DISABLE_ALERT_DELIVERY=1,
 * AND the engine would deliver through the ambient global fetch (no
 * injected fetchFn), sinks become no-ops — the alert is still recorded in
 * the ring buffer + history, but nothing leaves the process. Tests that
 * inject a fetchFn stub keep deterministic delivery assertions.
 *
 * Sink dispatcher reuse: the actual sink delivery (webhook HMAC POST, Slack
 * gateway POST, ntfy publish — including timeout, single retry, and
 * test-mode suppression) lives in createSinkDispatcher(), used both by the
 * alert engine's fire() and by the fleet digest (src/digest.js) so there is
 * exactly one delivery implementation.
 */

const crypto = require("crypto");
const { createAlertHistory, computeAlertAnalytics } = require("./alerts-history");

const SEVERITIES = new Set(["info", "warn", "critical"]);
const NTFY_DEFAULT_SERVER = "https://ntfy.sh";
// Severity → ntfy Priority header (https://docs.ntfy.sh/publish/#message-priority)
const NTFY_PRIORITIES = { critical: "urgent", warn: "high", info: "default" };
// Severity → ntfy Tags header (emoji shortcodes rendered by ntfy clients)
const NTFY_TAGS = { critical: "rotating_light", warn: "warning", info: "information_source" };
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

/** True when alert delivery must not leave the process (test context). */
function isTestDeliveryContext() {
  return Boolean(process.env.NODE_TEST_CONTEXT) || process.env.OFC_DISABLE_ALERT_DELIVERY === "1";
}

/** Epoch ms for a mute's `until` (number or parseable string), or null. */
function muteUntilMs(until) {
  if (until === undefined || until === null || until === "") return null;
  const ms = typeof until === "number" ? until : Date.parse(until);
  return Number.isFinite(ms) ? ms : null;
}

/** Epoch ms for a `since` filter (number, epoch-ms string, or ISO string). */
function parseSinceMs(since) {
  if (since === undefined || since === null || since === "") return null;
  if (typeof since === "number") return Number.isFinite(since) ? since : null;
  const text = String(since);
  const ms = /^\d+$/.test(text) ? Number(text) : Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * True when the alert matches an active mute entry. Entries must target at
 * least one of rule/node (empty catch-alls are ignored); `until` makes a
 * mute temporary — expired entries no longer match.
 *
 * @param {Array<{rule?: string, node?: string, until?: string|number}>} mutes
 * @param {{type: string, node: string|null}} alert
 * @param {number} now - epoch ms
 * @returns {boolean}
 */
function matchesMute(mutes, alert, now) {
  if (!Array.isArray(mutes)) return false;
  for (const mute of mutes) {
    if (!mute || typeof mute !== "object") continue;
    const hasRule = typeof mute.rule === "string" && mute.rule.length > 0;
    const hasNode = typeof mute.node === "string" && mute.node.length > 0;
    if (!hasRule && !hasNode) continue; // ignore empty catch-all entries
    const untilMs = muteUntilMs(mute.until);
    if (untilMs !== null && now >= untilMs) continue; // expired
    if (hasRule && mute.rule !== alert.type) continue;
    if (hasNode && mute.node !== alert.node) continue;
    return true;
  }
  return false;
}

/**
 * Resolve which sinks a rule's alerts may dispatch to.
 *
 * @param {object|undefined} routing - `config.routing` ({<rule>: [sinks]})
 * @param {string} type - alert type (rule name)
 * @returns {Set<string>|null} allowed sink names, or null = all sinks
 */
function sinkRoutesForType(routing, type) {
  if (!routing || typeof routing !== "object" || Array.isArray(routing)) return null;
  const entry = routing[type];
  if (!Array.isArray(entry) || entry.includes("*")) return null; // fail open
  return new Set(entry.filter((sink) => typeof sink === "string"));
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
    id: `alr_${crypto.randomBytes(6).toString("hex")}`,
    type: event.type,
    severity,
    node: event.node != null ? String(event.node) : null,
    task: event.task != null ? String(event.task) : null,
    message: event.message != null ? String(event.message) : "",
    ts: Number.isFinite(event.ts) ? event.ts : nowFn(),
  };
}

/**
 * Reusable sink dispatcher — the single implementation of webhook / Slack /
 * ntfy delivery (10s timeout, one retry, failures logged and never thrown).
 * Consumed by createAlerts() below and by the fleet digest (src/digest.js).
 *
 * Test-mode suppression matches the alert engine contract: when the process
 * runs under `node --test` or OFC_DISABLE_ALERT_DELIVERY=1 AND delivery
 * would go through the ambient global fetch, dispatch() becomes a no-op
 * that reports { suppressed: true }.
 *
 * @param {object} [options]
 * @param {function} [options.fetchFn=fetch] - injectable fetch for tests
 * @param {number} [options.timeoutMs=10000] - per-request timeout
 * @param {number} [options.retryDelayMs=30000] - delay before the single retry
 * @returns {{dispatch: function, suppressed: boolean}}
 */
function createSinkDispatcher({
  fetchFn = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
} = {}) {
  if (typeof fetchFn !== "function") {
    throw new TypeError("fetchFn must be a function");
  }

  const suppressed = isTestDeliveryContext() && fetchFn === globalThis.fetch;

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

  /** "node=<node> task=<task>" context fragment shared by text-y sinks. */
  function alertContext(alert) {
    return [alert.node ? `node=${alert.node}` : null, alert.task ? `task=${alert.task}` : null]
      .filter(Boolean)
      .join(" ");
  }

  function dispatchToSlack(slack, alert) {
    const context = alertContext(alert);
    const text = `[${alert.severity.toUpperCase()}] ${alert.type}${context ? ` (${context})` : ""}: ${alert.message}`;
    const body = JSON.stringify({ channel: slack.channel, text });

    return postWithRetry("slack", slack.gatewayUrl, body, {
      "Content-Type": "application/json",
    });
  }

  /**
   * ntfy: POST <server>/<topic>, plain-text body, publish metadata in
   * headers. Same resilience contract as the other sinks (timeout, one
   * retry, isolated failure, never throws).
   */
  function dispatchToNtfy(ntfy, alert) {
    const server = String(ntfy.server || NTFY_DEFAULT_SERVER).replace(/\/+$/, "");
    const url = `${server}/${encodeURIComponent(String(ntfy.topic))}`;

    const context = alertContext(alert);
    const title = `${alert.type}${context ? ` (${context})` : ""}`;
    const priorityMap =
      ntfy.priorityMap && typeof ntfy.priorityMap === "object" && !Array.isArray(ntfy.priorityMap)
        ? ntfy.priorityMap
        : {};

    const headers = {
      "Content-Type": "text/plain; charset=utf-8",
      Title: title,
      Priority: priorityMap[alert.severity] || NTFY_PRIORITIES[alert.severity] || "default",
      Tags: NTFY_TAGS[alert.severity] || NTFY_TAGS.info,
    };

    return postWithRetry("ntfy", url, alert.message || title, headers);
  }

  /**
   * Dispatch an alert-shaped payload to every configured + routed sink.
   *
   * @param {object} sinks - `fleet.alerts.sinks` shape:
   *   {slack: {enabled, gatewayUrl, channel}, ntfy: {enabled, server?, topic},
   *    webhooks: [{url, secret?, events?}]}
   * @param {{type, severity, node?, task?, message, ts}} alert
   * @param {function} [routedTo] - (sinkName) => boolean filter over
   *   "webhooks"/"slack"/"ntfy" (default: all sinks)
   * @returns {Promise<{dispatched: number, delivered: number, suppressed: boolean}>}
   */
  async function dispatch(sinks, alert, routedTo = () => true) {
    if (suppressed) {
      return { dispatched: 0, delivered: 0, suppressed: true };
    }
    const effective = sinks && typeof sinks === "object" ? sinks : {};
    const dispatches = [];

    if (routedTo("webhooks")) {
      for (const webhook of Array.isArray(effective.webhooks) ? effective.webhooks : []) {
        if (webhook && webhook.url && webhookMatchesEvent(webhook, alert.type)) {
          dispatches.push(dispatchToWebhook(webhook, alert));
        }
      }
    }

    if (
      routedTo("slack") &&
      effective.slack &&
      effective.slack.enabled &&
      effective.slack.gatewayUrl
    ) {
      dispatches.push(dispatchToSlack(effective.slack, alert));
    }

    if (routedTo("ntfy") && effective.ntfy && effective.ntfy.enabled && effective.ntfy.topic) {
      dispatches.push(dispatchToNtfy(effective.ntfy, alert));
    }

    const results = await Promise.allSettled(dispatches);
    const delivered = results.filter((r) => r.status === "fulfilled" && r.value === true).length;

    return { dispatched: dispatches.length, delivered, suppressed: false };
  }

  return { dispatch, suppressed };
}

/**
 * Create the alert engine.
 *
 * @param {object} options
 * @param {object} options.config - The `fleet.alerts` config section:
 *   {enabled, rules: {nodeOffline, nodeUnreachable, nodeRecovered, taskFailed,
 *                     taskStale, lessonPending},
 *    mutes: [{rule?, node?, until?}],
 *    routing: {<rule>: ["*"] | ["slack"|"ntfy"|"webhooks", ...]},
 *    sinks: {slack: {enabled, gatewayUrl, channel},
 *            ntfy: {enabled, server?, topic, priorityMap?},
 *            webhooks: [{url, secret, events}]}}
 *   ntfy.server defaults to https://ntfy.sh; ntfy.priorityMap optionally
 *   overrides the default severity→priority mapping per severity, e.g.
 *   {critical: "max", info: "min"}.
 * @param {string} [options.logsDir] - When set, fired alerts are persisted to
 *   <logsDir>/alerts.jsonl and query() reads them back (see alerts-history.js)
 * @param {function} [options.fetchFn=fetch] - Injectable fetch for tests
 * @param {function} [options.nowFn=Date.now] - Injectable clock for tests
 * @param {number} [options.timeoutMs=10000] - Per-request timeout
 * @param {number} [options.retryDelayMs=30000] - Delay before the single retry
 * @param {number} [options.historyMaxBytes] - History rotation threshold (tests)
 * @param {number} [options.historyKeepFiles] - Rotated history files kept (tests)
 * @returns {{fire: function, getRecent: function, query: function,
 *            getMutedCount: function, analytics: function}}
 */
function createAlerts({
  config = {},
  logsDir = null,
  fetchFn = globalThis.fetch,
  nowFn = Date.now,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  historyMaxBytes = undefined,
  historyKeepFiles = undefined,
} = {}) {
  // Shared sink delivery (timeout + retry + test-mode suppression); see
  // createSinkDispatcher above. Suppression only engages when delivery
  // would go through the ambient global fetch (unit tests inject stubs).
  const dispatcher = createSinkDispatcher({ fetchFn, timeoutMs, retryDelayMs });

  const history =
    typeof logsDir === "string" && logsDir.length > 0
      ? createAlertHistory({
          logsDir,
          ...(historyMaxBytes !== undefined ? { maxBytes: historyMaxBytes } : {}),
          ...(historyKeepFiles !== undefined ? { keepFiles: historyKeepFiles } : {}),
        })
      : null;

  const dedupeLastFired = new Map();
  let recentAlerts = [];
  let mutedCount = 0;

  // Lazy cleanup so the dedupe map cannot grow unbounded.
  function sweepDedupe(now) {
    if (dedupeLastFired.size < DEDUPE_SWEEP_THRESHOLD) return;
    for (const [key, ts] of dedupeLastFired) {
      if (now - ts >= DEDUPE_WINDOW_MS) {
        dedupeLastFired.delete(key);
      }
    }
  }

  /**
   * Fire an alert event: mute-check, dedupe, record (ring + history), and
   * dispatch to matching sinks. Sink failures never propagate to the caller.
   *
   * @param {{type: string, severity?: string, node?: string, task?: string, message?: string, ts?: number}} event
   * @returns {Promise<{fired: boolean, reason?: string, dispatched?: number, delivered?: number, suppressed?: boolean}>}
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

    // Mutes run BEFORE dedupe so a muted alert does not consume the dedupe
    // slot (unmuting mid-window must not silently swallow the next event).
    if (matchesMute(config.mutes, alert, now)) {
      mutedCount++;
      return { fired: false, reason: "muted" };
    }

    sweepDedupe(now);
    const dedupeKey = `${alert.type}:${alert.node || ""}:${alert.task || ""}`;
    const lastFired = dedupeLastFired.get(dedupeKey);
    if (lastFired !== undefined && now - lastFired < DEDUPE_WINDOW_MS) {
      return { fired: false, reason: "deduped" };
    }
    dedupeLastFired.set(dedupeKey, now);

    recentAlerts = [...recentAlerts, alert].slice(-RING_BUFFER_SIZE);
    if (history) history.append(alert);

    if (dispatcher.suppressed) {
      console.log(`[Alerts] ${alert.type} delivery suppressed (test mode)`);
      return { fired: true, dispatched: 0, delivered: 0, suppressed: true };
    }

    const routes = sinkRoutesForType(config.routing, alert.type);
    const routedTo = (sinkName) => routes === null || routes.has(sinkName);
    const result = await dispatcher.dispatch(config.sinks || {}, alert, routedTo);

    return { fired: true, dispatched: result.dispatched, delivered: result.delivered };
  }

  /**
   * Last N fired alerts (ring buffer of 200), newest first, optionally
   * filtered by type/node/severity/since (since: epoch ms or ISO string).
   *
   * @param {number} [limit=50]
   * @param {{type?: string, node?: string, severity?: string, since?: string|number}} [filters]
   * @returns {Array<object>}
   */
  function getRecent(limit = DEFAULT_RECENT_LIMIT, filters = {}) {
    const parsed = Number(limit);
    const effective =
      Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_RECENT_LIMIT;
    const { type, node, severity, since } = filters || {};
    const sinceMs = parseSinceMs(since);
    const matched = recentAlerts.filter((alert) => {
      if (type && alert.type !== type) return false;
      if (node && alert.node !== node) return false;
      if (severity && alert.severity !== severity) return false;
      if (sinceMs !== null && alert.ts < sinceMs) return false;
      return true;
    });
    return matched.slice(-effective).reverse();
  }

  /**
   * Query the persistent alert history (logs/alerts.jsonl), newest first.
   * Returns [] when no logsDir was configured.
   *
   * @param {{type?: string, node?: string, severity?: string, since?: string|number, limit?: number}} [filters]
   * @returns {Array<object>}
   */
  function query(filters = {}) {
    if (!history) return [];
    return history.query(filters);
  }

  /** Number of alerts skipped by mute entries since this engine was built. */
  function getMutedCount() {
    return mutedCount;
  }

  /**
   * Analytics rollup over the persistent history (per-day counts, flap
   * cycles, top nodes/rules). Returns the zeroed shape when no logsDir was
   * configured. See alerts-history.js computeAlertAnalytics().
   *
   * @param {{now?: number, days?: number}} [options]
   * @returns {object}
   */
  function analytics(options = {}) {
    if (!history) return computeAlertAnalytics([], options);
    return history.analytics(options);
  }

  return { fire, getRecent, query, getMutedCount, analytics };
}

// ---------------------------------------------------------------------------
// Flap suppression + recovery tracking (consumed by the fleet runtime's
// mesh→alert wiring; lives here so the policy is unit-testable in isolation)
// ---------------------------------------------------------------------------

const FLAP_DEFAULT_CONSECUTIVE = 3;
const FLAP_DEFAULT_MIN_DURATION_MS = 60000;

/**
 * Normalize a `fleet.alerts.flap` config section to safe values.
 * @param {object} [flap] - {consecutive?, minDurationMs?}
 * @returns {{consecutive: number, minDurationMs: number}}
 */
function normalizeFlapConfig(flap) {
  const src = flap && typeof flap === "object" && !Array.isArray(flap) ? flap : {};
  return {
    consecutive:
      Number.isInteger(src.consecutive) && src.consecutive >= 1
        ? src.consecutive
        : FLAP_DEFAULT_CONSECUTIVE,
    minDurationMs:
      Number.isFinite(src.minDurationMs) && src.minDurationMs >= 0
        ? src.minDurationMs
        : FLAP_DEFAULT_MIN_DURATION_MS,
  };
}

/**
 * Per-node failure-streak tracker implementing flap suppression and
 * recovery alerts for mesh node health:
 *
 *   - nodeOffline / nodeUnreachable fire only once a node has accumulated
 *     >= `consecutive` consecutive failed polls AND has been failing for
 *     >= `minDurationMs` (both conditions; defaults 3 / 60s).
 *   - When a node that previously alerted comes back online, a single
 *     nodeRecovered (info) alert fires; the latch then resets.
 *   - Status flips between offline and unreachable while failing keep one
 *     streak; the alert type reflects the status at threshold-crossing time.
 *
 * observe() is fed from mesh's per-poll onHealth callback.
 *
 * @param {object} options
 * @param {object} [options.flap] - {consecutive, minDurationMs} config
 * @param {function} options.fire - fire(event) — the runtime's fireAlert
 * @param {function} [options.nowFn=Date.now] - injectable clock for tests
 * @returns {{observe: function, setFlapConfig: function}}
 */
function createNodeAlertTracker({ flap, fire, nowFn = Date.now } = {}) {
  if (typeof fire !== "function") {
    throw new TypeError("createNodeAlertTracker requires a fire function");
  }
  let cfg = normalizeFlapConfig(flap);
  const states = new Map(); // node key -> {failingSince, alerted}

  /** Hot-apply a new flap config without losing per-node streak state. */
  function setFlapConfig(flapConfig) {
    cfg = normalizeFlapConfig(flapConfig);
  }

  /**
   * Feed one health poll result for a node.
   *
   * @param {{id?: string, hostname: string}} node
   * @param {string} status - online|offline|unreachable|unknown
   * @param {{consecutiveFailures?: number}} [health]
   * @returns {object|null} the event passed to fire(), or null
   */
  function observe(node, status, health = {}) {
    const key = node && (node.id || node.hostname);
    if (!key) return null;
    const now = nowFn();
    const prev = states.get(key) || { failingSince: null, alerted: false };

    if (status === "online") {
      let event = null;
      if (prev.alerted) {
        event = {
          type: "nodeRecovered",
          severity: "info",
          node: node.hostname,
          message: `Node ${node.hostname} recovered (back online)`,
        };
        fire(event);
      }
      states.set(key, { failingSince: null, alerted: false });
      return event;
    }

    if (status !== "offline" && status !== "unreachable") return null;

    const failingSince = prev.failingSince === null ? now : prev.failingSince;
    const streak = Number.isInteger(health.consecutiveFailures) ? health.consecutiveFailures : 1;
    let event = null;
    let alerted = prev.alerted;

    if (!alerted && streak >= cfg.consecutive && now - failingSince >= cfg.minDurationMs) {
      alerted = true;
      event =
        status === "offline"
          ? {
              type: "nodeOffline",
              severity: "critical",
              node: node.hostname,
              message: `Node ${node.hostname} is offline (${streak} consecutive failed checks)`,
            }
          : {
              type: "nodeUnreachable",
              severity: "warn",
              node: node.hostname,
              message: `Node ${node.hostname} is unreachable (${streak} consecutive failed checks)`,
            };
      fire(event);
    }

    states.set(key, { failingSince, alerted });
    return event;
  }

  return { observe, setFlapConfig };
}

module.exports = {
  createAlerts,
  createNodeAlertTracker,
  createSinkDispatcher,
  normalizeFlapConfig,
};
