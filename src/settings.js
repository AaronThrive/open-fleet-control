/**
 * Settings service — read / update the EDITABLE subset of the dashboard's
 * `fleet` configuration, persisted in config/dashboard.local.json.
 *
 * ============================================================================
 * HTTP API CONTRACT (routes are wired by the orchestrator in fleet-routes.js;
 * this module is transport-agnostic and only exposes get()/update()):
 *
 *   GET /api/fleet/settings
 *     → 200, body = settings.get()  (the redacted editable subset below)
 *
 *   PATCH /api/fleet/settings
 *     body = a partial patch of the editable subset (see "PATCH SHAPE")
 *     → 200 {success: true, applied: <settings.get() result>,
 *            restartRequired: ["mesh.intervalMs", ...]}
 *     → 400 {error} on validation failure (update() throws err.statusCode=400)
 *
 *   POST /api/fleet/settings/test-alert
 *     body = {} (optional {message})
 *     The orchestrator should call:
 *       alerts.fire({type: "testAlert", severity: "info",
 *                    task: String(Date.now()),   // unique → bypasses dedupe
 *                    message: body.message || "Test alert from Settings"})
 *     → 200 {success: true, result: {fired, dispatched, delivered}}
 *
 * GET / `applied` RESPONSE SHAPE (secrets are ALWAYS redacted — webhook
 * secrets are replaced by hasSecret booleans and are never returned):
 *   {
 *     alerts: {
 *       enabled: bool,
 *       rules: {nodeOffline, nodeUnreachable, nodeRecovered, taskFailed,
 *               taskStale, lessonPending},
 *       flap:  {consecutive, minDurationMs},
 *       mutes: [{rule?, node?, until?}],
 *       routing: {<rule>: ["*"] | ["slack"|"ntfy"|"webhooks", ...]},
 *       sinks: {
 *         slack: {enabled, gatewayUrl, channel},
 *         ntfy:  {enabled, server, topic},
 *         webhooks: [{id, url, hasSecret, events}]
 *       }
 *     },
 *     mesh: {intervalMs},
 *     watchdog: {thresholdMs},
 *     validationGate: {default: bool},
 *     federation: {intervalMs},
 *     budgets: {enabled, daily: {totalUSD, perProvider: {<provider>: usd}},
 *               weekly: {...}, checkIntervalMs}
 *   }
 *   1Password refs: secret-bearing fields (slack.gatewayUrl, ntfy.topic,
 *   webhook secret) accept op://vault/item/field references; refs are not
 *   secrets, so gatewayUrl/topic refs are returned verbatim and a webhook
 *   whose stored secret is a ref additionally exposes `secretRef`.
 *
 * PATCH SHAPE — any subset of the keys above, EXCEPT webhooks which are
 * addressed by id through explicit operations (ids are generated server-side
 * on add):
 *   {
 *     alerts: {
 *       enabled?, rules?: {<rule>: bool, ...},
 *       flap?:  {consecutive?, minDurationMs?},        // merged per-field
 *       mutes?: [{rule?, node?, until?}],              // FULL replacement
 *       routing?: {<rule>: [sinks]},                   // merged per rule;
 *                                                      // each list replaces
 *       sinks: {
 *         slack?: {enabled?, gatewayUrl?, channel?},
 *         ntfy?:  {enabled?, server?, topic?},
 *         webhooks?: {
 *           add?:    [{url, secret?, events?}],
 *           update?: [{id, url?, secret?, events?}],  // secret: string sets/
 *           remove?: ["wh_..."]                       // replaces, null clears
 *         }
 *       }
 *     },
 *     mesh?: {intervalMs}, federation?: {intervalMs},
 *     watchdog?: {thresholdMs}, validationGate?: {default},
 *     budgets?: {enabled?, checkIntervalMs?,
 *                daily?: {totalUSD?, perProvider?},   // perProvider = FULL
 *                weekly?: {totalUSD?, perProvider?}}  // replacement map
 *   }
 *   Webhook `secret` is WRITE-ONLY: accepted in patches, stored in the config
 *   file, but never present in get()/applied responses.
 *
 * VALIDATION (strict — unknown keys anywhere in the patch are rejected):
 *   - URLs (slack.gatewayUrl, ntfy.server, webhook url) must be http(s).
 *   - intervals/thresholds: integers, 5s ≤ value ≤ 1h.
 *   - ntfy.topic: [A-Za-z0-9_-], ≤ 256 chars (empty allowed = sink inert).
 *   - webhook events: ["*"] or a subset of the known alert rule names.
 *   - flap.consecutive: integer 1..20; flap.minDurationMs: integer 0..1h.
 *   - routing: keys must be known rule names; values non-empty arrays of
 *     "slack"/"ntfy"/"webhooks" (or ["*"] = all sinks, the default).
 *   - mutes: ≤ 50 entries; each needs rule (known rule name) and/or node
 *     (non-empty string ≤ 120 chars); until is optional (ISO string or epoch
 *     ms, normalized to ISO on persist).
 *
 * RESTART SEMANTICS — update() returns {applied, restartRequired} where
 * restartRequired is the list of changed setting paths that only take effect
 * after `systemctl --user restart open-fleet-control`:
 *   - mesh.intervalMs / federation.intervalMs / watchdog.thresholdMs /
 *     validationGate.default ALWAYS require a restart (timers and gate
 *     defaults are bound at boot).
 *   - alerts.* CAN be hot-applied: if an `onChange` hook is provided to
 *     createSettings(), it is invoked with getAlertsConfig() (the UNREDACTED
 *     effective alerts config) after every alerts change, and those paths are
 *     omitted from restartRequired. The orchestrator should rebuild the alert
 *     engine in the hook:  onChange: (alertsCfg) => { alerts = createAlerts({config: alertsCfg}); }
 *     Without a hook, alerts changes are honestly reported as restartRequired.
 *
 * PERSISTENCE — update() deep-merges the validated patch into the `fleet`
 * section of the config file with an atomic write (tmp + rename), preserving
 * every unrelated key (cortex paths, server/auth sections, unknown keys).
 * ============================================================================
 */

const fs = require("fs");
const crypto = require("crypto");
const { isSecretRef } = require("./secrets");

const INTERVAL_MIN_MS = 5000; // 5s
const INTERVAL_MAX_MS = 3600000; // 1h
const MAX_URL_LENGTH = 2048;
const MAX_CHANNEL_LENGTH = 120;
const MAX_TOPIC_LENGTH = 256;
const MAX_SECRET_LENGTH = 512;
const MAX_WEBHOOKS = 20;
const NTFY_TOPIC_RE = /^[A-Za-z0-9_-]+$/;
const NTFY_DEFAULT_SERVER = "https://ntfy.sh";

const ALERT_RULES = [
  "nodeOffline",
  "nodeUnreachable",
  "nodeRecovered",
  "taskFailed",
  "taskStale",
  "lessonPending",
  "budgetBreach",
  "dispatchComplete",
];

// Sink names addressable from alerts.routing (see "Alert rule sink routing"
// section below). "webhooks" targets the whole webhook group; per-webhook
// `events` filters still apply on top.
const ALERT_SINK_NAMES = ["slack", "ntfy", "webhooks"];

// Budgets validation bounds (fleet.budgets — see src/budgets.js).
const BUDGET_USD_MAX = 1000000;
const BUDGET_CHECK_MIN_MS = 60000; // 1 min
const BUDGET_CHECK_MAX_MS = 86400000; // 24 h
const MAX_BUDGET_PROVIDERS = 50;
const BUDGET_PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,63}$/;

const FLAP_CONSECUTIVE_MIN = 1;
const FLAP_CONSECUTIVE_MAX = 20;
const FLAP_DURATION_MIN_MS = 0;
const FLAP_DURATION_MAX_MS = 3600000; // 1h
const MAX_MUTES = 50;
const MAX_MUTE_NODE_LENGTH = 120;

// Mirrors the relevant parts of FLEET_DEFAULTS in src/config.js so get()
// reflects effective values even before anything is persisted.
const EDITABLE_DEFAULTS = Object.freeze({
  alerts: {
    enabled: false,
    rules: {
      nodeOffline: true,
      nodeUnreachable: true,
      nodeRecovered: true,
      taskFailed: true,
      taskStale: true,
      lessonPending: true,
      budgetBreach: true,
      // Dispatch follow-through ping — opt-in, OFF by default.
      dispatchComplete: false,
    },
    flap: { consecutive: 3, minDurationMs: 60000 },
    mutes: [],
    sinks: {
      slack: { enabled: false, gatewayUrl: "", channel: "" },
      ntfy: { enabled: false, server: NTFY_DEFAULT_SERVER, topic: "" },
      webhooks: [],
    },
  },
  mesh: { intervalMs: 15000 },
  watchdog: { thresholdMs: 1800000 },
  validationGate: { default: true },
  federation: { intervalMs: 30000 },
  budgets: {
    enabled: false,
    daily: { totalUSD: 0, perProvider: {} },
    weekly: { totalUSD: 0, perProvider: {} },
    checkIntervalMs: 900000,
  },
});

// Paths whose changes always need a process restart (bound at boot).
const RESTART_PATHS = new Set([
  "mesh.intervalMs",
  "federation.intervalMs",
  "watchdog.thresholdMs",
  "validationGate.default",
]);

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireBool(value, label) {
  if (typeof value !== "boolean") throw badRequest(`${label} must be a boolean`);
  return value;
}

function requireUrl(value, label, { allowEmpty = false, allowSecretRef = false } = {}) {
  if (typeof value !== "string") throw badRequest(`${label} must be a string`);
  if (value === "") {
    if (allowEmpty) return value;
    throw badRequest(`${label} must not be empty`);
  }
  // 1Password refs (op://...) are accepted in place of literals for
  // secret-bearing fields; they are resolved server-side at apply time.
  if (allowSecretRef && isSecretRef(value)) return value;
  if (value.length > MAX_URL_LENGTH) throw badRequest(`${label} is too long`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch (err) {
    throw badRequest(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw badRequest(`${label} must use http:// or https://`);
  }
  return value;
}

function requireIntervalMs(value, label) {
  if (!Number.isInteger(value) || value < INTERVAL_MIN_MS || value > INTERVAL_MAX_MS) {
    throw badRequest(
      `${label} must be an integer between ${INTERVAL_MIN_MS} and ${INTERVAL_MAX_MS} ms`,
    );
  }
  return value;
}

function requireKnownKeys(obj, allowed, label) {
  if (!isPlainObject(obj)) throw badRequest(`${label} must be an object`);
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw badRequest(`${label}: unknown key "${key}"`);
  }
}

function validateEvents(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest(`${label} must be a non-empty array`);
  }
  for (const event of value) {
    if (event !== "*" && !ALERT_RULES.includes(event)) {
      throw badRequest(`${label}: unknown event "${event}"`);
    }
  }
  return [...value];
}

function validateNtfyTopic(value, label) {
  if (typeof value !== "string") throw badRequest(`${label} must be a string`);
  if (value === "") return value; // empty topic = sink configured but inert
  if (isSecretRef(value)) return value; // op:// ref, resolved at apply time
  if (value.length > MAX_TOPIC_LENGTH || !NTFY_TOPIC_RE.test(value)) {
    throw badRequest(`${label} must match [A-Za-z0-9_-] (max ${MAX_TOPIC_LENGTH} chars)`);
  }
  return value;
}

/** Webhook secret in patches: non-empty string sets/replaces, null clears. */
function validateSecret(value, label) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw badRequest(`${label} must be a non-empty string (or null to clear)`);
  }
  if (value.length > MAX_SECRET_LENGTH) throw badRequest(`${label} is too long`);
  return value;
}

/**
 * Validate the full PATCH document. Throws 400-style errors on anything
 * unknown or malformed; returns a normalized deep copy containing only the
 * recognized, validated leaves.
 */
function validatePatch(patch) {
  if (!isPlainObject(patch) || Object.keys(patch).length === 0) {
    throw badRequest("patch must be a non-empty object");
  }
  requireKnownKeys(
    patch,
    ["alerts", "mesh", "federation", "watchdog", "validationGate", "budgets"],
    "patch",
  );
  const result = {};

  if (patch.alerts !== undefined) {
    requireKnownKeys(
      patch.alerts,
      ["enabled", "rules", "flap", "mutes", "routing", "sinks"],
      "alerts",
    );
    const alerts = {};
    if (patch.alerts.enabled !== undefined) {
      alerts.enabled = requireBool(patch.alerts.enabled, "alerts.enabled");
    }
    if (patch.alerts.rules !== undefined) {
      requireKnownKeys(patch.alerts.rules, ALERT_RULES, "alerts.rules");
      alerts.rules = {};
      for (const [rule, value] of Object.entries(patch.alerts.rules)) {
        alerts.rules[rule] = requireBool(value, `alerts.rules.${rule}`);
      }
    }
    if (patch.alerts.flap !== undefined) {
      alerts.flap = validateFlapPatch(patch.alerts.flap);
    }
    if (patch.alerts.mutes !== undefined) {
      alerts.mutes = validateMutes(patch.alerts.mutes);
    }
    if (patch.alerts.routing !== undefined) {
      alerts.routing = validateAlertRouting(patch.alerts.routing);
    }
    if (patch.alerts.sinks !== undefined) {
      requireKnownKeys(patch.alerts.sinks, ["slack", "ntfy", "webhooks"], "alerts.sinks");
      alerts.sinks = {};
      if (patch.alerts.sinks.slack !== undefined) {
        alerts.sinks.slack = validateSlackPatch(patch.alerts.sinks.slack);
      }
      if (patch.alerts.sinks.ntfy !== undefined) {
        alerts.sinks.ntfy = validateNtfyPatch(patch.alerts.sinks.ntfy);
      }
      if (patch.alerts.sinks.webhooks !== undefined) {
        alerts.sinks.webhooks = validateWebhookOps(patch.alerts.sinks.webhooks);
      }
    }
    result.alerts = alerts;
  }

  for (const [section, field] of [
    ["mesh", "intervalMs"],
    ["federation", "intervalMs"],
    ["watchdog", "thresholdMs"],
  ]) {
    if (patch[section] !== undefined) {
      requireKnownKeys(patch[section], [field], section);
      if (patch[section][field] === undefined) throw badRequest(`${section}.${field} is required`);
      result[section] = {
        [field]: requireIntervalMs(patch[section][field], `${section}.${field}`),
      };
    }
  }

  if (patch.validationGate !== undefined) {
    requireKnownKeys(patch.validationGate, ["default"], "validationGate");
    if (patch.validationGate.default === undefined) {
      throw badRequest("validationGate.default is required");
    }
    result.validationGate = {
      default: requireBool(patch.validationGate.default, "validationGate.default"),
    };
  }

  if (patch.budgets !== undefined) {
    result.budgets = validateBudgetsPatch(patch.budgets);
  }

  return result;
}

/** budgets.<period>.totalUSD: finite number 0..1e6 (0 = no limit). */
function validateBudgetUSD(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > BUDGET_USD_MAX) {
    throw badRequest(`${label} must be a number between 0 and ${BUDGET_USD_MAX} USD`);
  }
  return value;
}

/** budgets.<period>.perProvider: FULL replacement {provider: USD > 0}. */
function validateBudgetProviders(value, label) {
  if (!isPlainObject(value)) throw badRequest(`${label} must be an object`);
  const entries = Object.entries(value);
  if (entries.length > MAX_BUDGET_PROVIDERS) {
    throw badRequest(`${label}: too many providers (max ${MAX_BUDGET_PROVIDERS})`);
  }
  const out = {};
  for (const [provider, usd] of entries) {
    if (!BUDGET_PROVIDER_RE.test(provider)) {
      throw badRequest(`${label}: invalid provider name "${provider}"`);
    }
    const amount = validateBudgetUSD(usd, `${label}.${provider}`);
    if (amount <= 0) {
      throw badRequest(`${label}.${provider} must be greater than 0 (omit the entry to remove it)`);
    }
    out[provider] = amount;
  }
  return out;
}

/** budgets.daily / budgets.weekly: {totalUSD?, perProvider?} (≥1 key). */
function validateBudgetPeriodPatch(period, label) {
  requireKnownKeys(period, ["totalUSD", "perProvider"], label);
  const out = {};
  if (period.totalUSD !== undefined) {
    out.totalUSD = validateBudgetUSD(period.totalUSD, `${label}.totalUSD`);
  }
  if (period.perProvider !== undefined) {
    out.perProvider = validateBudgetProviders(period.perProvider, `${label}.perProvider`);
  }
  if (Object.keys(out).length === 0) {
    throw badRequest(`${label} must set totalUSD and/or perProvider`);
  }
  return out;
}

/** budgets: {enabled?, daily?, weekly?, checkIntervalMs?} (≥1 key). */
function validateBudgetsPatch(budgets) {
  requireKnownKeys(budgets, ["enabled", "daily", "weekly", "checkIntervalMs"], "budgets");
  const out = {};
  if (budgets.enabled !== undefined) {
    out.enabled = requireBool(budgets.enabled, "budgets.enabled");
  }
  if (budgets.daily !== undefined) {
    out.daily = validateBudgetPeriodPatch(budgets.daily, "budgets.daily");
  }
  if (budgets.weekly !== undefined) {
    out.weekly = validateBudgetPeriodPatch(budgets.weekly, "budgets.weekly");
  }
  if (budgets.checkIntervalMs !== undefined) {
    if (
      !Number.isInteger(budgets.checkIntervalMs) ||
      budgets.checkIntervalMs < BUDGET_CHECK_MIN_MS ||
      budgets.checkIntervalMs > BUDGET_CHECK_MAX_MS
    ) {
      throw badRequest(
        `budgets.checkIntervalMs must be an integer between ${BUDGET_CHECK_MIN_MS} and ${BUDGET_CHECK_MAX_MS} ms`,
      );
    }
    out.checkIntervalMs = budgets.checkIntervalMs;
  }
  if (Object.keys(out).length === 0) {
    throw badRequest("budgets must set at least one of enabled/daily/weekly/checkIntervalMs");
  }
  return out;
}

/** flap: {consecutive?: int 1..20, minDurationMs?: int 0..1h} (≥1 key). */
function validateFlapPatch(flap) {
  requireKnownKeys(flap, ["consecutive", "minDurationMs"], "alerts.flap");
  const out = {};
  if (flap.consecutive !== undefined) {
    if (
      !Number.isInteger(flap.consecutive) ||
      flap.consecutive < FLAP_CONSECUTIVE_MIN ||
      flap.consecutive > FLAP_CONSECUTIVE_MAX
    ) {
      throw badRequest(
        `alerts.flap.consecutive must be an integer between ${FLAP_CONSECUTIVE_MIN} and ${FLAP_CONSECUTIVE_MAX}`,
      );
    }
    out.consecutive = flap.consecutive;
  }
  if (flap.minDurationMs !== undefined) {
    if (
      !Number.isInteger(flap.minDurationMs) ||
      flap.minDurationMs < FLAP_DURATION_MIN_MS ||
      flap.minDurationMs > FLAP_DURATION_MAX_MS
    ) {
      throw badRequest(
        `alerts.flap.minDurationMs must be an integer between ${FLAP_DURATION_MIN_MS} and ${FLAP_DURATION_MAX_MS} ms`,
      );
    }
    out.minDurationMs = flap.minDurationMs;
  }
  if (Object.keys(out).length === 0) {
    throw badRequest("alerts.flap must set consecutive and/or minDurationMs");
  }
  return out;
}

/**
 * mutes: FULL replacement array of {rule?, node?, until?}. Each entry must
 * target at least one of rule/node; `until` (optional) is normalized to an
 * ISO timestamp string.
 */
function validateMutes(mutes) {
  if (!Array.isArray(mutes)) throw badRequest("alerts.mutes must be an array");
  if (mutes.length > MAX_MUTES) throw badRequest(`Too many mutes (max ${MAX_MUTES})`);
  return mutes.map((entry, i) => {
    requireKnownKeys(entry, ["rule", "node", "until"], `alerts.mutes[${i}]`);
    const out = {};
    if (entry.rule !== undefined) {
      if (!ALERT_RULES.includes(entry.rule)) {
        throw badRequest(`alerts.mutes[${i}].rule: unknown rule "${String(entry.rule)}"`);
      }
      out.rule = entry.rule;
    }
    if (entry.node !== undefined) {
      if (
        typeof entry.node !== "string" ||
        entry.node.length === 0 ||
        entry.node.length > MAX_MUTE_NODE_LENGTH
      ) {
        throw badRequest(
          `alerts.mutes[${i}].node must be a non-empty string (max ${MAX_MUTE_NODE_LENGTH} chars)`,
        );
      }
      out.node = entry.node;
    }
    if (out.rule === undefined && out.node === undefined) {
      throw badRequest(`alerts.mutes[${i}] must set rule and/or node`);
    }
    if (entry.until !== undefined && entry.until !== null) {
      const ms = typeof entry.until === "number" ? entry.until : Date.parse(entry.until);
      if (!Number.isFinite(ms)) {
        throw badRequest(`alerts.mutes[${i}].until must be an ISO timestamp or epoch ms`);
      }
      out.until = new Date(ms).toISOString();
    }
    return out;
  });
}

// --- Alert rule sink routing (alerts.routing) — v2 alert-rules-ui ----------
//
// PATCH shape: alerts.routing = {<rule>: ["*"] | [<sink>, ...]} where <sink>
// is one of ALERT_SINK_NAMES. Each rule entry is a FULL replacement; rules
// absent from the patch keep their stored value. ["*"] (the default) routes
// the rule to every configured sink.

/** Validate + normalize an alerts.routing patch (per-rule full replacement). */
function validateAlertRouting(routing) {
  requireKnownKeys(routing, ALERT_RULES, "alerts.routing");
  const out = {};
  for (const [rule, sinks] of Object.entries(routing)) {
    if (!Array.isArray(sinks) || sinks.length === 0) {
      throw badRequest(`alerts.routing.${rule} must be a non-empty array of sink names`);
    }
    const seen = new Set();
    for (const sink of sinks) {
      if (sink !== "*" && !ALERT_SINK_NAMES.includes(sink)) {
        throw badRequest(`alerts.routing.${rule}: unknown sink "${String(sink)}"`);
      }
      seen.add(sink);
    }
    // "*" routes to everything — collapse mixed entries; otherwise keep a
    // deduped subset in canonical ALERT_SINK_NAMES order.
    out[rule] = seen.has("*") ? ["*"] : ALERT_SINK_NAMES.filter((sink) => seen.has(sink));
  }
  if (Object.keys(out).length === 0) {
    throw badRequest("alerts.routing must set at least one rule");
  }
  return out;
}

/**
 * Effective alerts.routing: every known rule present, defaulting to ["*"].
 * Hand-edited garbage (unknown sinks, non-arrays, empty lists, unknown
 * rules) normalizes to safe defaults instead of breaking get().
 */
function normalizeAlertRouting(raw) {
  const src = isPlainObject(raw) ? raw : {};
  return Object.fromEntries(
    ALERT_RULES.map((rule) => {
      const entry = src[rule];
      if (!Array.isArray(entry) || entry.includes("*")) return [rule, ["*"]];
      const known = ALERT_SINK_NAMES.filter((sink) => entry.includes(sink));
      return [rule, known.length > 0 ? known : ["*"]];
    }),
  );
}

// --- Sink patch validation ---------------------------------------------------

function validateSlackPatch(slack) {
  requireKnownKeys(slack, ["enabled", "gatewayUrl", "channel"], "alerts.sinks.slack");
  const out = {};
  if (slack.enabled !== undefined) {
    out.enabled = requireBool(slack.enabled, "alerts.sinks.slack.enabled");
  }
  if (slack.gatewayUrl !== undefined) {
    out.gatewayUrl = requireUrl(slack.gatewayUrl, "alerts.sinks.slack.gatewayUrl", {
      allowEmpty: true,
      allowSecretRef: true,
    });
  }
  if (slack.channel !== undefined) {
    if (typeof slack.channel !== "string" || slack.channel.length > MAX_CHANNEL_LENGTH) {
      throw badRequest(`alerts.sinks.slack.channel must be a string (max ${MAX_CHANNEL_LENGTH})`);
    }
    out.channel = slack.channel;
  }
  return out;
}

function validateNtfyPatch(ntfy) {
  requireKnownKeys(ntfy, ["enabled", "server", "topic"], "alerts.sinks.ntfy");
  const out = {};
  if (ntfy.enabled !== undefined) {
    out.enabled = requireBool(ntfy.enabled, "alerts.sinks.ntfy.enabled");
  }
  if (ntfy.server !== undefined) {
    out.server = requireUrl(ntfy.server, "alerts.sinks.ntfy.server");
  }
  if (ntfy.topic !== undefined) {
    out.topic = validateNtfyTopic(ntfy.topic, "alerts.sinks.ntfy.topic");
  }
  return out;
}

function validateWebhookOps(ops) {
  requireKnownKeys(ops, ["add", "update", "remove"], "alerts.sinks.webhooks");
  const out = {};
  if (ops.add !== undefined) {
    if (!Array.isArray(ops.add)) throw badRequest("alerts.sinks.webhooks.add must be an array");
    out.add = ops.add.map((entry, i) => {
      requireKnownKeys(entry, ["url", "secret", "events"], `webhooks.add[${i}]`);
      const item = { url: requireUrl(entry.url, `webhooks.add[${i}].url`) };
      if (entry.secret !== undefined) {
        const secret = validateSecret(entry.secret, `webhooks.add[${i}].secret`);
        if (secret !== null) item.secret = secret;
      }
      item.events =
        entry.events !== undefined
          ? validateEvents(entry.events, `webhooks.add[${i}].events`)
          : ["*"];
      return item;
    });
  }
  if (ops.update !== undefined) {
    if (!Array.isArray(ops.update)) {
      throw badRequest("alerts.sinks.webhooks.update must be an array");
    }
    out.update = ops.update.map((entry, i) => {
      requireKnownKeys(entry, ["id", "url", "secret", "events"], `webhooks.update[${i}]`);
      if (typeof entry.id !== "string" || entry.id.length === 0) {
        throw badRequest(`webhooks.update[${i}].id is required`);
      }
      const item = { id: entry.id };
      if (entry.url !== undefined) item.url = requireUrl(entry.url, `webhooks.update[${i}].url`);
      if (entry.secret !== undefined) {
        item.secret = validateSecret(entry.secret, `webhooks.update[${i}].secret`);
      }
      if (entry.events !== undefined) {
        item.events = validateEvents(entry.events, `webhooks.update[${i}].events`);
      }
      return item;
    });
  }
  if (ops.remove !== undefined) {
    if (!Array.isArray(ops.remove)) {
      throw badRequest("alerts.sinks.webhooks.remove must be an array");
    }
    out.remove = ops.remove.map((id, i) => {
      if (typeof id !== "string" || id.length === 0) {
        throw badRequest(`webhooks.remove[${i}] must be a webhook id`);
      }
      return id;
    });
  }
  return out;
}

// --- Effective config assembly ----------------------------------------------

function newWebhookId() {
  return `wh_${crypto.randomBytes(5).toString("hex")}`;
}

/** Stable fallback id for hand-edited webhooks that lack one (persisted on first update). */
function derivedWebhookId(webhook, index) {
  const material = `${webhook.url || ""}|${index}`;
  return `wh_${crypto.createHash("sha256").update(material).digest("hex").slice(0, 10)}`;
}

/** Normalize the file's mutes array: keep only well-formed targeted entries. */
function normalizeMutes(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((m) => isPlainObject(m))
    .map((m) => {
      const entry = {};
      if (typeof m.rule === "string" && m.rule.length > 0) entry.rule = m.rule;
      if (typeof m.node === "string" && m.node.length > 0) entry.node = m.node;
      if (typeof m.until === "string" || typeof m.until === "number") entry.until = m.until;
      return entry;
    })
    .filter((m) => m.rule !== undefined || m.node !== undefined);
}

/** Normalize the file's webhook array: ensure ids + well-formed fields. Keeps secrets. */
function normalizeWebhooks(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((wh) => isPlainObject(wh) && typeof wh.url === "string")
    .map((wh, index) => {
      const entry = {
        id: typeof wh.id === "string" && wh.id.length > 0 ? wh.id : derivedWebhookId(wh, index),
        url: wh.url,
        events: Array.isArray(wh.events) && wh.events.length > 0 ? [...wh.events] : ["*"],
      };
      if (typeof wh.secret === "string" && wh.secret.length > 0) entry.secret = wh.secret;
      return entry;
    });
}

/**
 * Defaults <- persisted `fleet` section, restricted to the editable subset.
 * Secrets (webhook secrets) are KEPT — callers redact for the HTTP surface.
 */
function buildEffective(fleet) {
  const src = isPlainObject(fleet) ? fleet : {};
  const alerts = isPlainObject(src.alerts) ? src.alerts : {};
  const rules = isPlainObject(alerts.rules) ? alerts.rules : {};
  const sinks = isPlainObject(alerts.sinks) ? alerts.sinks : {};
  const slack = isPlainObject(sinks.slack) ? sinks.slack : {};
  const ntfy = isPlainObject(sinks.ntfy) ? sinks.ntfy : {};
  const d = EDITABLE_DEFAULTS;

  const pickBool = (value, fallback) => (typeof value === "boolean" ? value : fallback);
  const pickStr = (value, fallback) => (typeof value === "string" ? value : fallback);
  const pickInt = (value, fallback) => (Number.isInteger(value) ? value : fallback);

  const flap = isPlainObject(alerts.flap) ? alerts.flap : {};

  return {
    alerts: {
      enabled: pickBool(alerts.enabled, d.alerts.enabled),
      rules: Object.fromEntries(
        ALERT_RULES.map((rule) => [rule, pickBool(rules[rule], d.alerts.rules[rule])]),
      ),
      flap: {
        consecutive: pickInt(flap.consecutive, d.alerts.flap.consecutive),
        minDurationMs: pickInt(flap.minDurationMs, d.alerts.flap.minDurationMs),
      },
      mutes: normalizeMutes(alerts.mutes),
      routing: normalizeAlertRouting(alerts.routing),
      sinks: {
        slack: {
          enabled: pickBool(slack.enabled, d.alerts.sinks.slack.enabled),
          gatewayUrl: pickStr(slack.gatewayUrl, d.alerts.sinks.slack.gatewayUrl),
          channel: pickStr(slack.channel, d.alerts.sinks.slack.channel),
        },
        ntfy: {
          enabled: pickBool(ntfy.enabled, d.alerts.sinks.ntfy.enabled),
          server: pickStr(ntfy.server, d.alerts.sinks.ntfy.server) || NTFY_DEFAULT_SERVER,
          topic: pickStr(ntfy.topic, d.alerts.sinks.ntfy.topic),
        },
        webhooks: normalizeWebhooks(sinks.webhooks),
      },
    },
    mesh: { intervalMs: pickInt(src.mesh && src.mesh.intervalMs, d.mesh.intervalMs) },
    watchdog: {
      thresholdMs: pickInt(src.watchdog && src.watchdog.thresholdMs, d.watchdog.thresholdMs),
    },
    validationGate: {
      default: pickBool(src.validationGate && src.validationGate.default, d.validationGate.default),
    },
    federation: {
      intervalMs: pickInt(src.federation && src.federation.intervalMs, d.federation.intervalMs),
    },
    budgets: buildEffectiveBudgets(src.budgets, d.budgets),
  };
}

/** Effective fleet.budgets: defaults <- persisted, normalized. */
function buildEffectiveBudgets(raw, defaults) {
  const src = isPlainObject(raw) ? raw : {};
  const period = (rawPeriod, dPeriod) => {
    const p = isPlainObject(rawPeriod) ? rawPeriod : {};
    const perProvider = {};
    if (isPlainObject(p.perProvider)) {
      for (const [provider, usd] of Object.entries(p.perProvider)) {
        if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) {
          perProvider[provider] = usd;
        }
      }
    }
    return {
      totalUSD:
        typeof p.totalUSD === "number" && Number.isFinite(p.totalUSD) && p.totalUSD >= 0
          ? p.totalUSD
          : dPeriod.totalUSD,
      perProvider,
    };
  };
  return {
    enabled: typeof src.enabled === "boolean" ? src.enabled : defaults.enabled,
    daily: period(src.daily, defaults.daily),
    weekly: period(src.weekly, defaults.weekly),
    checkIntervalMs: Number.isInteger(src.checkIntervalMs)
      ? src.checkIntervalMs
      : defaults.checkIntervalMs,
  };
}

/**
 * Redact secrets for the HTTP surface: webhook secret → hasSecret boolean.
 * When the stored secret is a 1Password ref (op://...), the ref itself is
 * additionally exposed as `secretRef` — refs are not secrets, and the UI
 * uses them for the "1Password" badge.
 */
function redact(effective) {
  return {
    ...effective,
    alerts: {
      ...effective.alerts,
      sinks: {
        ...effective.alerts.sinks,
        webhooks: effective.alerts.sinks.webhooks.map(({ secret, ...rest }) => ({
          ...rest,
          hasSecret: typeof secret === "string" && secret.length > 0,
          ...(isSecretRef(secret) ? { secretRef: secret } : {}),
        })),
      },
    },
  };
}

/** Collect dotted leaf paths where `before` and `after` differ. */
function changedPaths(before, after, prefix = "") {
  const paths = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const key of keys) {
    const a = before ? before[key] : undefined;
    const b = after ? after[key] : undefined;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(a) && isPlainObject(b)) {
      paths.push(...changedPaths(a, b, path));
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      paths.push(path);
    }
  }
  return paths;
}

/**
 * Create the settings service.
 *
 * @param {object} options
 * @param {string} options.configPath - Path to config/dashboard.local.json
 * @param {function} [options.onChange] - Hot-apply hook: called with the
 *   UNREDACTED effective alerts config whenever any alerts.* setting changes.
 *   Providing it marks alerts changes as hot-applied (not restartRequired).
 * @param {function} [options.onBudgetsChange] - Hot-apply hook for budgets.*
 *   changes, called with the effective fleet.budgets config. Without it,
 *   budgets changes are honestly reported as restartRequired.
 * @returns {{get: function, update: function, getAlertsConfig: function,
 *            getBudgetsConfig: function}}
 */
function createSettings({ configPath, onChange, onBudgetsChange } = {}) {
  if (typeof configPath !== "string" || configPath.length === 0) {
    throw new TypeError("configPath is required");
  }
  if (onChange !== undefined && typeof onChange !== "function") {
    throw new TypeError("onChange must be a function when provided");
  }
  if (onBudgetsChange !== undefined && typeof onBudgetsChange !== "function") {
    throw new TypeError("onBudgetsChange must be a function when provided");
  }

  /** Read the FULL config file (not just fleet) so unrelated keys survive writes. */
  function readConfigFile() {
    let raw = {};
    try {
      if (fs.existsSync(configPath)) {
        raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
      }
    } catch (err) {
      throw new Error(`Failed to read settings file ${configPath}: ${err.message}`);
    }
    if (!isPlainObject(raw)) raw = {};
    return raw;
  }

  function writeConfigFile(raw) {
    const tmpFile = `${configPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpFile, `${JSON.stringify(raw, null, 2)}\n`);
    fs.renameSync(tmpFile, configPath);
  }

  /** The redacted editable subset (defaults <- persisted file). Never contains secrets. */
  function get() {
    const raw = readConfigFile();
    return redact(buildEffective(raw.fleet));
  }

  /**
   * Effective `fleet.alerts` config WITH secrets, shaped for createAlerts().
   * For the orchestrator's hot-reload wiring ONLY — never serve over HTTP.
   */
  function getAlertsConfig() {
    const raw = readConfigFile();
    return buildEffective(raw.fleet).alerts;
  }

  /** Effective `fleet.budgets` config, shaped for createBudgets(). */
  function getBudgetsConfig() {
    const raw = readConfigFile();
    return buildEffective(raw.fleet).budgets;
  }

  /** Apply webhook add/update/remove operations to the normalized list. */
  function applyWebhookOps(webhooks, ops) {
    let next = webhooks.map((wh) => ({ ...wh }));

    for (const id of ops.remove || []) {
      const index = next.findIndex((wh) => wh.id === id);
      if (index === -1) throw badRequest(`Unknown webhook id "${id}"`);
      next = [...next.slice(0, index), ...next.slice(index + 1)];
    }

    for (const patch of ops.update || []) {
      const index = next.findIndex((wh) => wh.id === patch.id);
      if (index === -1) throw badRequest(`Unknown webhook id "${patch.id}"`);
      const current = next[index];
      const updated = { ...current };
      if (patch.url !== undefined) updated.url = patch.url;
      if (patch.events !== undefined) updated.events = patch.events;
      if (patch.secret !== undefined) {
        if (patch.secret === null) delete updated.secret;
        else updated.secret = patch.secret;
      }
      next = [...next.slice(0, index), updated, ...next.slice(index + 1)];
    }

    for (const entry of ops.add || []) {
      next = [...next, { id: newWebhookId(), ...entry }];
    }

    if (next.length > MAX_WEBHOOKS) {
      throw badRequest(`Too many webhooks (max ${MAX_WEBHOOKS})`);
    }
    return next;
  }

  /**
   * Validate + persist a settings patch.
   *
   * @param {object} patch - See PATCH SHAPE in the header comment
   * @param {string} [actor] - Identity for the log line (audit is wired by routes)
   * @returns {{applied: object, restartRequired: string[]}}
   */
  function update(patch, actor = "anonymous") {
    const validated = validatePatch(patch);

    const raw = readConfigFile();
    const fleetBefore = isPlainObject(raw.fleet) ? raw.fleet : {};
    const before = buildEffective(fleetBefore);

    // Build the next fleet section immutably, touching only patched leaves.
    const next = { ...fleetBefore };

    for (const section of ["mesh", "federation", "watchdog", "validationGate"]) {
      if (validated[section]) {
        next[section] = {
          ...(isPlainObject(fleetBefore[section]) ? fleetBefore[section] : {}),
          ...validated[section],
        };
      }
    }

    if (validated.alerts) {
      const alertsBefore = isPlainObject(fleetBefore.alerts) ? fleetBefore.alerts : {};
      const alertsNext = { ...alertsBefore };
      if (validated.alerts.enabled !== undefined) alertsNext.enabled = validated.alerts.enabled;
      if (validated.alerts.rules) {
        alertsNext.rules = {
          ...before.alerts.rules,
          ...validated.alerts.rules,
        };
      }
      if (validated.alerts.flap) {
        alertsNext.flap = { ...before.alerts.flap, ...validated.alerts.flap };
      }
      if (validated.alerts.mutes) {
        alertsNext.mutes = validated.alerts.mutes; // full replacement by contract
      }
      if (validated.alerts.routing) {
        // Merged per rule; each rule's sink list is a full replacement.
        alertsNext.routing = { ...before.alerts.routing, ...validated.alerts.routing };
      }
      if (validated.alerts.sinks) {
        const sinksBefore = isPlainObject(alertsBefore.sinks) ? alertsBefore.sinks : {};
        const sinksNext = { ...sinksBefore };
        if (validated.alerts.sinks.slack) {
          sinksNext.slack = { ...before.alerts.sinks.slack, ...validated.alerts.sinks.slack };
        }
        if (validated.alerts.sinks.ntfy) {
          sinksNext.ntfy = { ...before.alerts.sinks.ntfy, ...validated.alerts.sinks.ntfy };
        }
        if (validated.alerts.sinks.webhooks) {
          sinksNext.webhooks = applyWebhookOps(
            before.alerts.sinks.webhooks,
            validated.alerts.sinks.webhooks,
          );
        }
        alertsNext.sinks = sinksNext;
      }
      next.alerts = alertsNext;
    }

    if (validated.budgets) {
      const budgetsBefore = isPlainObject(fleetBefore.budgets) ? fleetBefore.budgets : {};
      const budgetsNext = { ...budgetsBefore };
      if (validated.budgets.enabled !== undefined) budgetsNext.enabled = validated.budgets.enabled;
      if (validated.budgets.checkIntervalMs !== undefined) {
        budgetsNext.checkIntervalMs = validated.budgets.checkIntervalMs;
      }
      for (const period of ["daily", "weekly"]) {
        if (validated.budgets[period]) {
          // totalUSD merged per-field; perProvider is a FULL replacement.
          budgetsNext[period] = {
            ...before.budgets[period],
            ...validated.budgets[period],
          };
        }
      }
      next.budgets = budgetsNext;
    }

    const after = buildEffective(next);
    const changed = changedPaths(before, after);

    if (changed.length > 0) {
      writeConfigFile({ ...raw, fleet: next });
      console.log(`[Settings] ${actor} updated: ${changed.join(", ")}`);
    }

    const alertsChanged = changed.some((p) => p === "alerts" || p.startsWith("alerts."));
    const budgetsChanged = changed.some((p) => p === "budgets" || p.startsWith("budgets."));
    const hotApplyAlerts = typeof onChange === "function";
    const hotApplyBudgets = typeof onBudgetsChange === "function";
    const restartRequired = changed.filter((p) => {
      if (RESTART_PATHS.has(p)) return true;
      if (p === "alerts" || p.startsWith("alerts.")) return !hotApplyAlerts;
      if (p === "budgets" || p.startsWith("budgets.")) return !hotApplyBudgets;
      return false;
    });

    if (alertsChanged && hotApplyAlerts) {
      try {
        onChange(after.alerts);
      } catch (err) {
        console.error("[Settings] onChange hook failed:", err.message);
      }
    }

    if (budgetsChanged && hotApplyBudgets) {
      try {
        onBudgetsChange(after.budgets);
      } catch (err) {
        console.error("[Settings] onBudgetsChange hook failed:", err.message);
      }
    }

    return { applied: redact(after), restartRequired };
  }

  return { get, update, getAlertsConfig, getBudgetsConfig };
}

module.exports = { createSettings };
