/**
 * Settings View — edit the dashboard's persisted fleet settings.
 *
 * Loaded on demand by views.js, which calls init(containerEl) on EVERY
 * visit of the view. The partial HTML is re-injected fresh each visit, so
 * init() re-queries the DOM from scratch (module scope persists).
 *
 * API (wired by the orchestrator to src/settings.js + src/alerts.js):
 *   GET   /api/fleet/settings                 — redacted editable settings
 *   PATCH /api/fleet/settings                 — partial patch, returns
 *         {success, applied, restartRequired: ["mesh.intervalMs", ...]}
 *   POST  /api/fleet/settings/test-alert      — fires a test alert through
 *         the saved sink config, returns {success, result: {dispatched, delivered}}
 *   GET   /api/privacy                        — privacy settings (src/privacy.js):
 *         {hiddenTopics, hiddenSessions, hiddenCrons, hideHostname}
 *   POST  /api/privacy                        — merge-update privacy settings,
 *         returns {success, settings}
 *
 * Saves are per-section and optimistic-with-server-truth: the PATCH response's
 * `applied` object re-populates the form, so the UI always converges on what
 * the server actually persisted. Webhook secrets are write-only — the server
 * only ever reports hasSecret, never the secret itself.
 *
 * Settings returned in `restartRequired` only take effect after
 * `systemctl --user restart open-fleet-control`; they accumulate in an amber
 * banner until the page is reloaded against a restarted service.
 */

import { t } from "../utils.js";

const ALERT_RULES = [
  "nodeOffline",
  "nodeUnreachable",
  "taskFailed",
  "taskStale",
  "lessonPending",
  "budgetBreach",
];
const WEBHOOK_EVENT_OPTIONS = ["*", ...ALERT_RULES];
const SEC = 1000;
const MIN = 60000;

// --- Module-level lifecycle state (persists across visits) -----------------

let refs = null; // DOM references for the active visit
let restartPaths = new Set(); // accumulated restartRequired paths (until restart)
let privacySettings = null; // last privacy settings fetched from the server
// Editable per-provider budget maps ({provider: usd}); rows mutate this local
// state and "Save budgets" submits it as a FULL replacement.
let budgetProviders = { daily: {}, weekly: {} };

// --- Entry point ------------------------------------------------------------

export function init(containerEl) {
  teardown();

  const root = containerEl.querySelector("#settings-view-section");
  if (!root) {
    console.error("[Settings] Partial markup missing #settings-view-section");
    return;
  }

  refs = {
    root,
    loading: root.querySelector("#set-loading"),
    fetchError: root.querySelector("#set-fetch-error"),
    body: root.querySelector("#set-body"),
    restartBanner: root.querySelector("#set-restart-banner"),
    restartPathsEl: root.querySelector("#set-restart-paths"),
    // Alerts section
    alertsEnabled: root.querySelector("#set-alerts-enabled"),
    rules: root.querySelector("#set-rules"),
    slackEnabled: root.querySelector("#set-slack-enabled"),
    slackUrl: root.querySelector("#set-slack-url"),
    slackUrlBadge: root.querySelector("#set-slack-url-badge"),
    slackChannel: root.querySelector("#set-slack-channel"),
    ntfyEnabled: root.querySelector("#set-ntfy-enabled"),
    ntfyServer: root.querySelector("#set-ntfy-server"),
    ntfyTopic: root.querySelector("#set-ntfy-topic"),
    ntfyTopicBadge: root.querySelector("#set-ntfy-topic-badge"),
    ntfyTest: root.querySelector("#set-ntfy-test"),
    alertsSave: root.querySelector("#set-alerts-save"),
    alertsError: root.querySelector("#set-alerts-error"),
    // Webhooks
    webhooksList: root.querySelector("#set-webhooks-list"),
    webhooksEmpty: root.querySelector("#set-webhooks-empty"),
    whUrl: root.querySelector("#set-wh-url"),
    whSecret: root.querySelector("#set-wh-secret"),
    whEvents: root.querySelector("#set-wh-events"),
    whAdd: root.querySelector("#set-wh-add"),
    whError: root.querySelector("#set-wh-error"),
    // Intervals
    meshInterval: root.querySelector("#set-mesh-interval"),
    fedInterval: root.querySelector("#set-fed-interval"),
    watchdogThreshold: root.querySelector("#set-watchdog-threshold"),
    intervalsSave: root.querySelector("#set-intervals-save"),
    intervalsError: root.querySelector("#set-intervals-error"),
    // Budgets
    budgetsEnabled: root.querySelector("#set-budgets-enabled"),
    budgetsInterval: root.querySelector("#set-budgets-interval"),
    budgetDailyTotal: root.querySelector("#set-budget-daily-total"),
    budgetWeeklyTotal: root.querySelector("#set-budget-weekly-total"),
    budgetDailyList: root.querySelector("#set-budget-daily-list"),
    budgetDailyEmpty: root.querySelector("#set-budget-daily-empty"),
    budgetDailyProvider: root.querySelector("#set-budget-daily-provider"),
    budgetDailyUsd: root.querySelector("#set-budget-daily-usd"),
    budgetDailyAdd: root.querySelector("#set-budget-daily-add"),
    budgetWeeklyList: root.querySelector("#set-budget-weekly-list"),
    budgetWeeklyEmpty: root.querySelector("#set-budget-weekly-empty"),
    budgetWeeklyProvider: root.querySelector("#set-budget-weekly-provider"),
    budgetWeeklyUsd: root.querySelector("#set-budget-weekly-usd"),
    budgetWeeklyAdd: root.querySelector("#set-budget-weekly-add"),
    budgetsSave: root.querySelector("#set-budgets-save"),
    budgetsError: root.querySelector("#set-budgets-error"),
    // Gate
    gateDefault: root.querySelector("#set-gate-default"),
    gateSave: root.querySelector("#set-gate-save"),
    gateError: root.querySelector("#set-gate-error"),
    // Privacy
    privHideHostname: root.querySelector("#set-priv-hide-hostname"),
    privTopics: root.querySelector("#set-priv-topics"),
    privTopicsEmpty: root.querySelector("#set-priv-topics-empty"),
    privSessions: root.querySelector("#set-priv-sessions"),
    privSessionsEmpty: root.querySelector("#set-priv-sessions-empty"),
    privCrons: root.querySelector("#set-priv-crons"),
    privCronsEmpty: root.querySelector("#set-priv-crons-empty"),
    privacySave: root.querySelector("#set-privacy-save"),
    privacyError: root.querySelector("#set-privacy-error"),
  };

  buildRuleToggles();
  buildWebhookEventToggles();
  setupCollapsibles(root);

  refs.alertsSave?.addEventListener("click", saveAlerts);
  refs.intervalsSave?.addEventListener("click", saveIntervals);
  refs.gateSave?.addEventListener("click", saveGate);
  refs.ntfyTest?.addEventListener("click", sendTestAlert);
  refs.whAdd?.addEventListener("click", addWebhook);
  refs.privacySave?.addEventListener("click", savePrivacy);
  refs.budgetsSave?.addEventListener("click", saveBudgets);
  refs.budgetDailyAdd?.addEventListener("click", () => addBudgetProvider("daily"));
  refs.budgetWeeklyAdd?.addEventListener("click", () => addBudgetProvider("weekly"));

  refs.alertsSave.textContent = t("views.settings.saveAlerts", {}, "Save alerts");
  refs.intervalsSave.textContent = t("views.settings.saveIntervals", {}, "Save intervals");
  refs.gateSave.textContent = t("views.settings.saveGate", {}, "Save gate");
  if (refs.budgetsSave) {
    refs.budgetsSave.textContent = t("views.settings.saveBudgets", {}, "Save budgets");
  }
  refs.ntfyTest.textContent = t("views.settings.ntfyTest", {}, "Send test alert");
  refs.whAdd.textContent = t("views.settings.webhookAdd", {}, "Add webhook");
  if (refs.privacySave) {
    refs.privacySave.textContent = t("views.settings.savePrivacy", {}, "Save privacy");
  }

  renderRestartBanner();
  refresh();
  refreshPrivacy();
}

/** Wire collapsible section headers (chevron + title toggles the card body). */
function setupCollapsibles(root) {
  for (const toggle of root.querySelectorAll("[data-collapse-toggle]")) {
    toggle.addEventListener("click", () => {
      const card = toggle.closest(".set-card");
      if (!card) return;
      const collapsed = card.classList.toggle("collapsed");
      toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    });
  }
}

function teardown() {
  refs = null;
}

// --- Data fetching ----------------------------------------------------------

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  let payload = null;
  try {
    payload = await response.json();
  } catch (err) {
    /* non-JSON body */
  }
  if (!response.ok) {
    const message = payload && payload.error ? payload.error : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

async function refresh() {
  if (!refs) return;
  try {
    const settings = await fetchJson("/api/fleet/settings");
    if (!refs) return;
    refs.loading.hidden = true;
    refs.fetchError.hidden = true;
    refs.body.hidden = false;
    populate(settings);
  } catch (err) {
    if (!refs) return;
    console.error("[Settings] Failed to load settings:", err);
    refs.loading.hidden = true;
    refs.fetchError.hidden = false;
    refs.fetchError.textContent = t(
      "views.settings.loadError",
      { message: err.message },
      "Failed to load settings: {message}",
    );
  }
}

// --- Form population (server truth → inputs) ---------------------------------

function buildRuleToggles() {
  refs.rules.replaceChildren();
  for (const rule of ALERT_RULES) {
    const label = el("label", "set-toggle");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.rule = rule;
    label.appendChild(input);
    label.appendChild(el("span", null, rule));
    refs.rules.appendChild(label);
  }
}

function buildWebhookEventToggles() {
  refs.whEvents.replaceChildren();
  for (const event of WEBHOOK_EVENT_OPTIONS) {
    const label = el("label", "set-toggle");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.event = event;
    if (event === "*") input.checked = true;
    label.appendChild(input);
    label.appendChild(
      el("span", null, event === "*" ? t("views.settings.allEvents", {}, "all events") : event),
    );
    refs.whEvents.appendChild(label);
  }
}

function populate(settings) {
  const alerts = settings.alerts || {};
  const sinks = alerts.sinks || {};
  const slack = sinks.slack || {};
  const ntfy = sinks.ntfy || {};

  refs.alertsEnabled.checked = alerts.enabled === true;
  for (const input of refs.rules.querySelectorAll("input[data-rule]")) {
    input.checked = (alerts.rules || {})[input.dataset.rule] !== false;
  }

  refs.slackEnabled.checked = slack.enabled === true;
  refs.slackUrl.value = slack.gatewayUrl || "";
  refs.slackChannel.value = slack.channel || "";
  setOpBadge(refs.slackUrlBadge, slack.gatewayUrl);

  refs.ntfyEnabled.checked = ntfy.enabled === true;
  refs.ntfyServer.value = ntfy.server || "https://ntfy.sh";
  refs.ntfyTopic.value = ntfy.topic || "";
  setOpBadge(refs.ntfyTopicBadge, ntfy.topic);

  renderWebhooks(Array.isArray(sinks.webhooks) ? sinks.webhooks : []);

  populateBudgets(settings.budgets || {});

  refs.meshInterval.value = String(Math.round((settings.mesh?.intervalMs ?? 15000) / SEC));
  refs.fedInterval.value = String(Math.round((settings.federation?.intervalMs ?? 30000) / SEC));
  refs.watchdogThreshold.value = String(
    Math.round((settings.watchdog?.thresholdMs ?? 1800000) / MIN),
  );

  refs.gateDefault.checked = settings.validationGate?.default !== false;
}

function renderWebhooks(webhooks) {
  refs.webhooksList.replaceChildren();
  refs.webhooksEmpty.hidden = webhooks.length > 0;

  for (const webhook of webhooks) {
    const row = el("div", "set-webhook-row");
    const url = el("span", "set-webhook-url", webhook.url);
    url.title = webhook.url;
    row.appendChild(url);

    const events = Array.isArray(webhook.events) ? webhook.events : ["*"];
    row.appendChild(
      el(
        "span",
        "set-webhook-chip",
        events.includes("*") ? t("views.settings.allEvents", {}, "all events") : events.join(", "),
      ),
    );

    row.appendChild(
      el(
        "span",
        `set-webhook-chip${webhook.hasSecret ? " secret" : ""}`,
        webhook.hasSecret
          ? t("views.settings.signed", {}, "🔑 signed")
          : t("views.settings.unsigned", {}, "unsigned"),
      ),
    );

    // Secret stored as a 1Password ref → badge with the (non-secret) ref.
    if (webhook.secretRef) {
      const opChip = el("span", "set-op-badge", "🔐 1Password");
      opChip.title = webhook.secretRef;
      row.appendChild(opChip);
    }

    const secretBtn = el(
      "button",
      "set-action-btn",
      webhook.hasSecret
        ? t("views.settings.replaceSecret", {}, "Replace secret")
        : t("views.settings.setSecret", {}, "Set secret"),
    );
    secretBtn.type = "button";
    secretBtn.addEventListener("click", () => replaceWebhookSecret(webhook, secretBtn));
    row.appendChild(secretBtn);

    const removeBtn = el("button", "set-action-btn danger", t("actions.remove", {}, "Remove"));
    removeBtn.type = "button";
    removeBtn.addEventListener("click", () => removeWebhook(webhook, removeBtn));
    row.appendChild(removeBtn);

    refs.webhooksList.appendChild(row);
  }
}

// --- Saving (PATCH /api/fleet/settings, per section) -------------------------

/** PATCH a settings subset; on success re-populate from server truth. */
async function patchSettings(patch, { button, errorEl }) {
  if (button) button.disabled = true;
  if (errorEl) errorEl.hidden = true;
  try {
    const payload = await fetchJson("/api/fleet/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!refs) return null;
    if (payload && payload.applied) populate(payload.applied);
    noteRestartRequired(payload && payload.restartRequired);
    showToast(t("views.settings.saved", {}, "Settings saved."), "success");
    return payload;
  } catch (err) {
    if (refs && errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = t(
        "views.settings.saveFailed",
        { message: err.message },
        "Save failed: {message}",
      );
    }
    return null;
  } finally {
    if (refs && button) button.disabled = false;
  }
}

function saveAlerts() {
  const rules = {};
  for (const input of refs.rules.querySelectorAll("input[data-rule]")) {
    rules[input.dataset.rule] = input.checked;
  }
  patchSettings(
    {
      alerts: {
        enabled: refs.alertsEnabled.checked,
        rules,
        sinks: {
          slack: {
            enabled: refs.slackEnabled.checked,
            gatewayUrl: refs.slackUrl.value.trim(),
            channel: refs.slackChannel.value.trim(),
          },
          ntfy: {
            enabled: refs.ntfyEnabled.checked,
            server: refs.ntfyServer.value.trim() || "https://ntfy.sh",
            topic: refs.ntfyTopic.value.trim(),
          },
        },
      },
    },
    { button: refs.alertsSave, errorEl: refs.alertsError },
  );
}

function saveIntervals() {
  const meshSec = readBoundedNumber(refs.meshInterval, 5, 3600);
  const fedSec = readBoundedNumber(refs.fedInterval, 5, 3600);
  const watchdogMin = readBoundedNumber(refs.watchdogThreshold, 1, 60);
  if (meshSec === null || fedSec === null || watchdogMin === null) {
    refs.intervalsError.hidden = false;
    refs.intervalsError.textContent = t(
      "views.settings.intervalInvalid",
      {},
      "Intervals must be 5–3600 seconds (watchdog: 1–60 minutes).",
    );
    return;
  }
  patchSettings(
    {
      mesh: { intervalMs: meshSec * SEC },
      federation: { intervalMs: fedSec * SEC },
      watchdog: { thresholdMs: watchdogMin * MIN },
    },
    { button: refs.intervalsSave, errorEl: refs.intervalsError },
  );
}

function saveGate() {
  patchSettings(
    { validationGate: { default: refs.gateDefault.checked } },
    { button: refs.gateSave, errorEl: refs.gateError },
  );
}

// --- Budgets (fleet.budgets — warn at 80%, critical at 100%) ------------------

const BUDGET_PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,63}$/;
const BUDGET_USD_MAX = 1000000;

function populateBudgets(budgets) {
  const daily = budgets.daily || {};
  const weekly = budgets.weekly || {};
  budgetProviders = {
    daily: { ...(daily.perProvider || {}) },
    weekly: { ...(weekly.perProvider || {}) },
  };
  refs.budgetsEnabled.checked = budgets.enabled === true;
  refs.budgetsInterval.value = String(Math.round((budgets.checkIntervalMs ?? 900000) / MIN));
  refs.budgetDailyTotal.value = String(daily.totalUSD ?? 0);
  refs.budgetWeeklyTotal.value = String(weekly.totalUSD ?? 0);
  renderBudgetProviders("daily");
  renderBudgetProviders("weekly");
}

function budgetPeriodRefs(period) {
  return period === "daily"
    ? { list: refs.budgetDailyList, empty: refs.budgetDailyEmpty }
    : { list: refs.budgetWeeklyList, empty: refs.budgetWeeklyEmpty };
}

function renderBudgetProviders(period) {
  const { list, empty } = budgetPeriodRefs(period);
  if (!list || !empty) return;
  const entries = Object.entries(budgetProviders[period]);
  list.replaceChildren();
  empty.hidden = entries.length > 0;

  for (const [provider, usd] of entries) {
    const row = el("div", "set-priv-row");
    const name = el("span", "set-priv-value", provider);
    name.title = provider;
    row.appendChild(name);
    row.appendChild(el("span", "set-budget-usd", `$${Number(usd).toFixed(2)}`));

    const removeBtn = el("button", "set-action-btn danger", t("actions.remove", {}, "Remove"));
    removeBtn.type = "button";
    removeBtn.addEventListener("click", () => {
      const { [provider]: removed, ...rest } = budgetProviders[period];
      void removed;
      budgetProviders = { ...budgetProviders, [period]: rest };
      renderBudgetProviders(period);
    });
    row.appendChild(removeBtn);
    list.appendChild(row);
  }
}

function addBudgetProvider(period) {
  const providerInput = period === "daily" ? refs.budgetDailyProvider : refs.budgetWeeklyProvider;
  const usdInput = period === "daily" ? refs.budgetDailyUsd : refs.budgetWeeklyUsd;
  const provider = providerInput.value.trim();
  const usd = Number(usdInput.value);

  if (!BUDGET_PROVIDER_RE.test(provider)) {
    showBudgetsError(
      t("views.settings.budgetProviderInvalid", {}, "Provider name must be 1–64 safe characters."),
    );
    return;
  }
  if (!Number.isFinite(usd) || usd <= 0 || usd > BUDGET_USD_MAX) {
    showBudgetsError(
      t("views.settings.budgetUsdInvalid", {}, "Limit must be a positive USD amount."),
    );
    return;
  }
  refs.budgetsError.hidden = true;
  budgetProviders = {
    ...budgetProviders,
    [period]: { ...budgetProviders[period], [provider]: usd },
  };
  providerInput.value = "";
  usdInput.value = "";
  renderBudgetProviders(period);
}

function showBudgetsError(message) {
  refs.budgetsError.hidden = false;
  refs.budgetsError.textContent = message;
}

function saveBudgets() {
  const intervalMin = readBoundedNumber(refs.budgetsInterval, 1, 1440);
  const dailyTotal = Number(refs.budgetDailyTotal.value);
  const weeklyTotal = Number(refs.budgetWeeklyTotal.value);

  if (intervalMin === null) {
    showBudgetsError(
      t("views.settings.budgetIntervalInvalid", {}, "Check interval must be 1–1440 minutes."),
    );
    return;
  }
  for (const total of [dailyTotal, weeklyTotal]) {
    if (!Number.isFinite(total) || total < 0 || total > BUDGET_USD_MAX) {
      showBudgetsError(
        t("views.settings.budgetTotalInvalid", {}, "Totals must be 0 (off) or a USD amount."),
      );
      return;
    }
  }

  refs.budgetsError.hidden = true;
  patchSettings(
    {
      budgets: {
        enabled: refs.budgetsEnabled.checked,
        checkIntervalMs: intervalMin * MIN,
        daily: { totalUSD: dailyTotal, perProvider: { ...budgetProviders.daily } },
        weekly: { totalUSD: weeklyTotal, perProvider: { ...budgetProviders.weekly } },
      },
    },
    { button: refs.budgetsSave, errorEl: refs.budgetsError },
  );
}

// --- Privacy (GET/POST /api/privacy, src/privacy.js schema) -------------------

const PRIVACY_LISTS = [
  { key: "hiddenTopics", listRef: "privTopics", emptyRef: "privTopicsEmpty" },
  { key: "hiddenSessions", listRef: "privSessions", emptyRef: "privSessionsEmpty" },
  { key: "hiddenCrons", listRef: "privCrons", emptyRef: "privCronsEmpty" },
];

async function refreshPrivacy() {
  if (!refs || !refs.privHideHostname) return;
  try {
    const settings = await fetchJson("/api/privacy");
    if (!refs) return;
    privacySettings = settings;
    populatePrivacy(settings);
  } catch (err) {
    if (!refs || !refs.privacyError) return;
    console.error("[Settings] Failed to load privacy settings:", err);
    refs.privacyError.hidden = false;
    refs.privacyError.textContent = t(
      "views.settings.privacyLoadError",
      { message: err.message },
      "Failed to load privacy settings: {message}",
    );
  }
}

function populatePrivacy(settings) {
  refs.privHideHostname.checked = settings.hideHostname === true;
  for (const { key, listRef, emptyRef } of PRIVACY_LISTS) {
    const items = Array.isArray(settings[key]) ? settings[key] : [];
    renderPrivacyList(key, refs[listRef], refs[emptyRef], items);
  }
}

function renderPrivacyList(key, listEl, emptyEl, items) {
  if (!listEl || !emptyEl) return;
  listEl.replaceChildren();
  emptyEl.hidden = items.length > 0;

  for (const item of items) {
    const row = el("div", "set-priv-row");
    const value = el("span", "set-priv-value", String(item));
    value.title = String(item);
    row.appendChild(value);

    const removeBtn = el("button", "set-action-btn danger", t("actions.remove", {}, "Remove"));
    removeBtn.type = "button";
    removeBtn.addEventListener("click", () => removePrivacyItem(key, item, removeBtn));
    row.appendChild(removeBtn);

    listEl.appendChild(row);
  }
}

/** POST a privacy update; the server merges and returns the persisted settings. */
async function postPrivacy(update, { button, successMessage }) {
  if (button) button.disabled = true;
  if (refs.privacyError) refs.privacyError.hidden = true;
  try {
    const payload = await fetchJson("/api/privacy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
    if (!refs) return null;
    if (payload && payload.settings) {
      privacySettings = payload.settings;
      populatePrivacy(payload.settings);
    }
    showToast(successMessage, "success");
    return payload;
  } catch (err) {
    if (refs && refs.privacyError) {
      refs.privacyError.hidden = false;
      refs.privacyError.textContent = t(
        "views.settings.saveFailed",
        { message: err.message },
        "Save failed: {message}",
      );
    }
    return null;
  } finally {
    if (refs && button) button.disabled = false;
  }
}

function savePrivacy() {
  postPrivacy(
    { hideHostname: refs.privHideHostname.checked },
    {
      button: refs.privacySave,
      successMessage: t("views.settings.privacySaved", {}, "Privacy settings saved."),
    },
  );
}

/** Remove one hidden item (unhide) — applies immediately, like webhooks. */
async function removePrivacyItem(key, item, button) {
  const current =
    privacySettings && Array.isArray(privacySettings[key]) ? privacySettings[key] : [];
  await postPrivacy(
    { [key]: current.filter((entry) => entry !== item) },
    {
      button,
      successMessage: t("views.settings.privacyUnhidden", {}, "Item is visible again."),
    },
  );
}

// --- Webhook mutations (applied immediately) ----------------------------------

function selectedWebhookEvents() {
  const events = [];
  for (const input of refs.whEvents.querySelectorAll("input[data-event]")) {
    if (input.checked) events.push(input.dataset.event);
  }
  return events.includes("*") || events.length === 0 ? ["*"] : events;
}

async function addWebhook() {
  const url = refs.whUrl.value.trim();
  if (!url) {
    refs.whError.hidden = false;
    refs.whError.textContent = t("views.settings.webhookUrlRequired", {}, "Webhook URL required.");
    return;
  }
  const entry = { url, events: selectedWebhookEvents() };
  const secret = refs.whSecret.value;
  if (secret) entry.secret = secret;

  refs.whError.hidden = true;
  const payload = await patchSettings(
    { alerts: { sinks: { webhooks: { add: [entry] } } } },
    { button: refs.whAdd, errorEl: refs.whError },
  );
  if (payload && refs) {
    refs.whUrl.value = "";
    refs.whSecret.value = "";
  }
}

async function removeWebhook(webhook, button) {
  const confirmText = t(
    "views.settings.confirmRemoveWebhook",
    { url: webhook.url },
    "Remove webhook {url}?",
  );
  if (!window.confirm(confirmText)) return;
  await patchSettings(
    { alerts: { sinks: { webhooks: { remove: [webhook.id] } } } },
    { button, errorEl: refs.whError },
  );
}

async function replaceWebhookSecret(webhook, button) {
  const secret = window.prompt(
    t(
      "views.settings.secretPrompt",
      { url: webhook.url },
      "New HMAC secret for {url} (write-only, never displayed again):",
    ),
  );
  if (secret === null) return; // cancelled
  if (secret === "") {
    showToast(t("views.settings.secretEmpty", {}, "Secret unchanged (empty input)."), "error");
    return;
  }
  await patchSettings(
    { alerts: { sinks: { webhooks: { update: [{ id: webhook.id, secret }] } } } },
    { button, errorEl: refs.whError },
  );
}

// --- Test alert ---------------------------------------------------------------

async function sendTestAlert() {
  refs.ntfyTest.disabled = true;
  try {
    const payload = await fetchJson("/api/fleet/settings/test-alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const result = payload && payload.result ? payload.result : {};
    showToast(
      t(
        "views.settings.testAlertSent",
        { dispatched: result.dispatched ?? 0, delivered: result.delivered ?? 0 },
        "Test alert fired: {delivered}/{dispatched} sinks delivered.",
      ),
      "success",
    );
  } catch (err) {
    showToast(
      t("views.settings.testAlertFailed", { message: err.message }, "Test alert failed: {message}"),
      "error",
    );
  } finally {
    if (refs) refs.ntfyTest.disabled = false;
  }
}

// --- Restart banner -----------------------------------------------------------

function noteRestartRequired(paths) {
  if (!Array.isArray(paths)) return;
  restartPaths = new Set([...restartPaths, ...paths]);
  renderRestartBanner();
}

function renderRestartBanner() {
  if (!refs) return;
  const list = [...restartPaths].sort();
  refs.restartBanner.hidden = list.length === 0;
  refs.restartPathsEl.textContent = list.join(", ");
}

// --- Small helpers ------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Show/hide a "1Password" badge for a field whose stored value is an op://
 * ref. Refs are not secrets — the input shows the ref verbatim and the badge
 * title repeats it for hover.
 */
function setOpBadge(badgeEl, value) {
  if (!badgeEl) return;
  const isRef = typeof value === "string" && value.startsWith("op://");
  badgeEl.hidden = !isRef;
  badgeEl.title = isRef ? value : "";
}

/** Parse an <input type="number"> within [min, max]; null when invalid. */
function readBoundedNumber(input, min, max) {
  const value = Number(input.value);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    return null;
  }
  return value;
}

/** Toast using the dashboard's global .toast styles (same as other views). */
function showToast(message, kind) {
  let host = document.querySelector(".toast-container");
  if (!host) {
    host = el("div", "toast-container");
    document.body.appendChild(host);
  }
  const toast = el("div", `toast ${kind === "error" ? "error" : "success"}`, message);
  host.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}
