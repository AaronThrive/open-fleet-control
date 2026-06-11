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
 *   POST  /api/fleet/admin/restart            — audited service restart,
 *         returns {success, restartingInMs}; systemd respawns the process
 *
 * Saves are per-section and optimistic-with-server-truth: the PATCH response's
 * `applied` object re-populates the form, so the UI always converges on what
 * the server actually persisted. Webhook secrets are write-only — the server
 * only ever reports hasSecret, never the secret itself.
 *
 * Resilience: the settings fetch carries a timeout (a hung request can no
 * longer wedge the page on "Loading settings…"), and each card populates
 * independently via applySections() — a section that fails to render shows
 * its own inline error chip while the rest of the page keeps working.
 *
 * Settings returned in `restartRequired` only take effect after a service
 * restart; they accumulate in a calm info banner ("✅ Saved. These take
 * effect after a restart: …") with a "🔄 Restart service" button that calls
 * the admin restart route, shows a "Restarting…" overlay, and polls
 * /api/health until the service answers again.
 */

import { t } from "../utils.js";
import {
  aboutModel,
  applySections,
  formatRestartPaths,
  makeHealthCheck,
  mergeRestartPaths,
  pollUntilHealthy,
} from "./settings-core.js";

const ALERT_RULES = [
  "nodeOffline",
  "nodeUnreachable",
  "taskFailed",
  "taskStale",
  "lessonPending",
  "budgetBreach",
  "dispatchComplete",
];
const WEBHOOK_EVENT_OPTIONS = ["*", ...ALERT_RULES];
const SEC = 1000;
const MIN = 60000;

// --- Module-level lifecycle state (persists across visits) -----------------

let refs = null; // DOM references for the active visit
let restartPaths = new Set(); // accumulated restartRequired paths (until restart)
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
    restartMsg: root.querySelector("#set-restart-msg"),
    restartBtn: root.querySelector("#set-restart-btn"),
    restartOverlay: root.querySelector("#set-restart-overlay"),
    restartOverlayMsg: root.querySelector("#set-restart-overlay-msg"),
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
    budgetsEnforce: root.querySelector("#set-budgets-enforce"),
    // Digest
    digestEnabled: root.querySelector("#set-digest-enabled"),
    digestSchedule: root.querySelector("#set-digest-schedule"),
    digestHour: root.querySelector("#set-digest-hour"),
    digestSinks: root.querySelector("#set-digest-sinks"),
    digestSave: root.querySelector("#set-digest-save"),
    digestTest: root.querySelector("#set-digest-test"),
    digestError: root.querySelector("#set-digest-error"),
    // Gate (live toggle + persisted default)
    gateLive: root.querySelector("#set-gate-live"),
    gateLiveLabel: root.querySelector("#set-gate-live-label"),
    gateState: root.querySelector("#set-gate-state"),
    gateExplain: root.querySelector("#set-gate-explain"),
    gateDefault: root.querySelector("#set-gate-default"),
    gateSave: root.querySelector("#set-gate-save"),
    gateError: root.querySelector("#set-gate-error"),
    // About
    aboutName: root.querySelector("#set-about-name"),
    aboutVersion: root.querySelector("#set-about-version"),
    aboutLine: root.querySelector("#set-about-line"),
  };

  buildRuleToggles();
  buildWebhookEventToggles();
  setupCollapsibles(root);
  initAlertRules(root); // "Alert rules" card (v2) — see section at end of file

  refs.alertsSave?.addEventListener("click", saveAlerts);
  refs.intervalsSave?.addEventListener("click", saveIntervals);
  refs.gateSave?.addEventListener("click", saveGate);
  refs.gateLive?.addEventListener("change", toggleLiveGate);
  refs.ntfyTest?.addEventListener("click", sendTestAlert);
  refs.whAdd?.addEventListener("click", addWebhook);
  refs.restartBtn?.addEventListener("click", restartService);
  refs.budgetsSave?.addEventListener("click", saveBudgets);
  refs.budgetDailyAdd?.addEventListener("click", () => addBudgetProvider("daily"));
  refs.budgetWeeklyAdd?.addEventListener("click", () => addBudgetProvider("weekly"));
  refs.digestSave?.addEventListener("click", saveDigest);
  refs.digestTest?.addEventListener("click", sendTestDigest);

  refs.alertsSave.textContent = t("views.settings.saveAlerts", {}, "Save alerts");
  refs.intervalsSave.textContent = t("views.settings.saveIntervals", {}, "Save intervals");
  refs.gateSave.textContent = t("views.settings.saveGate", {}, "Save gate");
  if (refs.budgetsSave) {
    refs.budgetsSave.textContent = t("views.settings.saveBudgets", {}, "Save budgets");
  }
  refs.ntfyTest.textContent = t("views.settings.ntfyTest", {}, "Send test alert");
  refs.whAdd.textContent = t("views.settings.webhookAdd", {}, "Add webhook");
  if (refs.restartMsg) {
    refs.restartMsg.textContent = t(
      "views.settings.restartInfo",
      {},
      "Saved. These take effect after a restart:",
    );
  }
  if (refs.restartBtn) {
    refs.restartBtn.textContent = t("views.settings.restartService", {}, "🔄 Restart service");
  }
  if (refs.restartOverlayMsg) {
    refs.restartOverlayMsg.textContent = t("views.settings.restarting", {}, "Restarting…");
  }
  if (refs.gateLiveLabel) {
    refs.gateLiveLabel.textContent = t("views.settings.gateLiveLabel", {}, "Validation gate");
  }
  if (refs.gateExplain) {
    refs.gateExplain.textContent = t(
      "views.settings.gateExplain",
      {},
      "When the gate is ON, new evolution lessons require manual approval before they are adopted; OFF lets lessons auto-approve (autonomous merge).",
    );
  }

  renderRestartBanner();
  refresh();
  refreshLiveGate();
  loadAbout();
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
  arRefs = null; // "Alert rules" card refs (v2)
}

// --- Data fetching ----------------------------------------------------------

// Every request is bounded: a slow or hung backend rejects after this long
// instead of leaving the page stuck on "Loading settings…" forever.
const FETCH_TIMEOUT_MS = 10000;

async function fetchJson(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error(t("views.settings.requestTimeout", {}, "Request timed out"));
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
  refs.loading.hidden = false;
  refs.fetchError.hidden = true;
  let settings;
  try {
    settings = await fetchJson("/api/fleet/settings");
  } catch (err) {
    if (!refs) return;
    console.error("[Settings] Failed to load settings:", err);
    refs.loading.hidden = true;
    showFetchError(err.message);
    return;
  }
  if (!refs) return;
  refs.loading.hidden = true;
  refs.fetchError.hidden = true;
  refs.body.hidden = false;
  populate(settings);
}

/** Top-level fetch error chip with an inline Retry button. */
function showFetchError(message) {
  refs.fetchError.hidden = false;
  refs.fetchError.replaceChildren(
    el(
      "span",
      null,
      t("views.settings.loadError", { message }, "Failed to load settings: {message}"),
    ),
  );
  const retry = el("button", "set-action-btn", t("views.settings.retry", {}, "Retry"));
  retry.type = "button";
  retry.style.marginLeft = "10px";
  retry.addEventListener("click", refresh);
  refs.fetchError.appendChild(retry);
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

/**
 * Populate every card from server truth. Sections run isolated through
 * applySections(): one failing card shows its own inline error chip while
 * the others still render — a single bad section can no longer wedge the
 * whole page.
 */
function populate(settings) {
  const results = applySections(settings || {}, [
    { name: "alerts", apply: populateAlertsSection },
    { name: "alertRules", apply: (s) => populateAlertRules(s.alerts || {}) },
    { name: "budgets", apply: (s) => populateBudgets(s.budgets || {}) },
    { name: "digest", apply: (s) => populateDigest(s.digest || {}) },
    { name: "intervals", apply: populateIntervalsSection },
    { name: "gate", apply: populateGateSection },
  ]);
  for (const result of results) {
    const errorEl = sectionErrorEl(result.name);
    if (!errorEl) continue;
    errorEl.hidden = result.ok;
    if (!result.ok) {
      console.error(`[Settings] Section "${result.name}" failed to render:`, result.error);
      errorEl.textContent = t(
        "views.settings.sectionError",
        { message: result.error },
        "This section failed to render: {message}",
      );
    }
  }
}

/** Inline error chip element for a populate section (null when missing). */
function sectionErrorEl(name) {
  switch (name) {
    case "alerts":
      return refs.alertsError;
    case "alertRules":
      return arRefs ? arRefs.error : null;
    case "budgets":
      return refs.budgetsError;
    case "digest":
      return refs.digestError;
    case "intervals":
      return refs.intervalsError;
    case "gate":
      return refs.gateError;
    default:
      return null;
  }
}

function populateAlertsSection(settings) {
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
}

function populateIntervalsSection(settings) {
  refs.meshInterval.value = String(Math.round((settings.mesh?.intervalMs ?? 15000) / SEC));
  refs.fedInterval.value = String(Math.round((settings.federation?.intervalMs ?? 30000) / SEC));
  refs.watchdogThreshold.value = String(
    Math.round((settings.watchdog?.thresholdMs ?? 1800000) / MIN),
  );
}

function populateGateSection(settings) {
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

// --- Live validation gate (GET/PUT /api/fleet/evolution/gate) -----------------
// The single control surface for the gate: it replaced both the top-bar
// switcher and the Evolution-view toggle. The Evolution banner still shows
// the state read-only.

/** Reflect the live gate state into the toggle + state line. */
function setLiveGateUI(gate) {
  if (!refs || !refs.gateLive) return;
  refs.gateLive.checked = gate === true;
  if (refs.gateState) {
    refs.gateState.textContent =
      gate === true
        ? t("views.settings.gateStateOn", {}, "ON — new lessons require approval.")
        : t("views.settings.gateStateOff", {}, "OFF — lessons auto-approve (autonomous merge).");
  }
}

async function refreshLiveGate() {
  if (!refs || !refs.gateLive) return;
  try {
    const payload = await fetchJson("/api/fleet/evolution/gate");
    if (!refs) return;
    setLiveGateUI(payload && payload.gate === true);
  } catch (err) {
    if (!refs || !refs.gateState) return;
    console.error("[Settings] Failed to load gate state:", err);
    refs.gateState.textContent = t(
      "views.settings.gateStateError",
      { message: err.message },
      "Current state unavailable: {message}",
    );
  }
}

/** Apply the toggle immediately (PUT); revert the UI when the call fails. */
async function toggleLiveGate() {
  if (!refs || !refs.gateLive) return;
  const next = refs.gateLive.checked;
  refs.gateLive.disabled = true;
  try {
    await fetchJson("/api/fleet/evolution/gate", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gate: next }),
    });
    if (!refs) return;
    setLiveGateUI(next);
    showToast(
      next
        ? t("gate.toastOn", {}, "Validation gate ON — lessons require approval")
        : t("gate.toastOff", {}, "Validation gate OFF — autonomous merge"),
      "success",
    );
    // Keep other gate consumers (Evolution banner, SSE listeners) in sync.
    window.dispatchEvent(
      new CustomEvent("fleet:evolution", { detail: { type: "gate.toggle", gate: next } }),
    );
  } catch (err) {
    if (!refs) return;
    setLiveGateUI(!next); // revert to the last known server state
    showToast(
      t("gate.updateFailed", { message: err.message }, "Gate update failed: {message}"),
      "error",
    );
  } finally {
    if (refs && refs.gateLive) refs.gateLive.disabled = false;
  }
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
  if (refs.budgetsEnforce) refs.budgetsEnforce.checked = budgets.enforce?.enabled === true;
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
        enforce: { enabled: refs.budgetsEnforce ? refs.budgetsEnforce.checked : false },
        checkIntervalMs: intervalMin * MIN,
        daily: { totalUSD: dailyTotal, perProvider: { ...budgetProviders.daily } },
        weekly: { totalUSD: weeklyTotal, perProvider: { ...budgetProviders.weekly } },
      },
    },
    { button: refs.budgetsSave, errorEl: refs.budgetsError },
  );
}

// --- Fleet digest --------------------------------------------------------------

function digestSinkInputs() {
  return refs.digestSinks ? [...refs.digestSinks.querySelectorAll("input[data-sink]")] : [];
}

function populateDigest(digest) {
  if (!refs.digestEnabled) return;
  refs.digestEnabled.checked = digest.enabled === true;
  refs.digestSchedule.value = digest.schedule === "weekly" ? "weekly" : "daily";
  refs.digestHour.value = String(digest.hourUtc ?? 8);
  const sinks = Array.isArray(digest.sinks) ? digest.sinks : ["*"];
  const all = sinks.includes("*");
  for (const input of digestSinkInputs()) {
    input.checked = !all && sinks.includes(input.dataset.sink);
  }
}

function saveDigest() {
  if (!refs.digestEnabled) return;
  const hour = Number.parseInt(refs.digestHour.value, 10);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    refs.digestError.hidden = false;
    refs.digestError.textContent = t(
      "views.settings.digestHourInvalid",
      {},
      "Hour must be 0–23 (UTC).",
    );
    return;
  }
  refs.digestError.hidden = true;
  const checked = digestSinkInputs()
    .filter((input) => input.checked)
    .map((input) => input.dataset.sink);
  patchSettings(
    {
      digest: {
        enabled: refs.digestEnabled.checked,
        schedule: refs.digestSchedule.value === "weekly" ? "weekly" : "daily",
        hourUtc: hour,
        sinks: checked.length ? checked : ["*"],
      },
    },
    { button: refs.digestSave, errorEl: refs.digestError },
  );
}

async function sendTestDigest() {
  if (!refs.digestTest) return;
  refs.digestTest.disabled = true;
  try {
    const res = await fetch("/api/fleet/digest/test", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) {
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    showToast(t("views.settings.digestTestSent", {}, "Test digest sent"), "success");
  } catch (err) {
    refs.digestError.hidden = false;
    refs.digestError.textContent = t(
      "views.settings.digestTestFailed",
      { message: err.message },
      `Test digest failed: ${err.message}`,
    );
  } finally {
    refs.digestTest.disabled = false;
  }
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

// --- Restart banner + service restart flow ------------------------------------

function noteRestartRequired(paths) {
  restartPaths = mergeRestartPaths(restartPaths, paths);
  renderRestartBanner();
}

function renderRestartBanner() {
  if (!refs) return;
  refs.restartBanner.hidden = restartPaths.size === 0;
  refs.restartPathsEl.textContent = formatRestartPaths(restartPaths);
}

/** Quick /api/health probe — every probe individually capped at 2s. */
const healthCheck = makeHealthCheck({ timeoutMs: 2000 });

/** Pause before the post-restart reload so the success toast is readable. */
const RELOAD_DELAY_MS = 1200;

/**
 * Confirm → POST /api/fleet/admin/restart → "Restarting…" overlay → poll
 * /api/health until the respawned service answers → full page reload (the
 * served assets may have changed across the restart). The server exits
 * ~300ms after responding and systemd (Restart=on-failure, RestartSec=5)
 * brings it back. The overlay ALWAYS resolves: healthy → reload + success
 * toast; 60s timeout → overlay cleared + actionable error (dev/standalone
 * runs have no supervisor, so the process simply stays down).
 */
async function restartService() {
  if (!refs) return;
  const confirmText = t(
    "views.settings.restartConfirm",
    {},
    "Restart the dashboard service now? The dashboard will be unavailable for a few seconds.",
  );
  if (!window.confirm(confirmText)) return;

  refs.restartBtn.disabled = true;
  try {
    await fetchJson("/api/fleet/admin/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  } catch (err) {
    if (!refs) return;
    refs.restartBtn.disabled = false;
    showToast(
      t("views.settings.restartFailed", { message: err.message }, "Restart failed: {message}"),
      "error",
    );
    return;
  }

  if (refs.restartOverlay) refs.restartOverlay.hidden = false;
  const healthy = await pollUntilHealthy({
    check: healthCheck,
    timeoutMs: 60000,
    intervalMs: 1000,
  });
  if (!refs) return; // user navigated away while polling

  refs.restartBtn.disabled = false;
  if (refs.restartOverlay) refs.restartOverlay.hidden = true;
  if (healthy) {
    restartPaths = new Set();
    renderRestartBanner();
    showToast(t("views.settings.restarted", {}, "Service restarted."), "success");
    setTimeout(() => window.location.reload(), RELOAD_DELAY_MS);
  } else {
    showToast(
      t(
        "views.settings.restartTimeoutAction",
        {},
        "The service did not come back — check: systemctl --user status open-fleet-control",
      ),
      "error",
    );
  }
}

// --- About card ----------------------------------------------------------------

/**
 * Fill the compact About card. Version comes from GET /api/about (single
 * source of truth: package.json); a failed fetch keeps the static fallbacks
 * so the card always renders.
 */
async function loadAbout() {
  if (!refs || !refs.aboutVersion) return;
  let payload = null;
  try {
    payload = await fetchJson("/api/about");
  } catch (err) {
    console.error("[Settings] Failed to load /api/about:", err);
  }
  if (!refs || !refs.aboutVersion) return;
  const about = aboutModel(payload);
  if (refs.aboutName) refs.aboutName.textContent = `ℹ️ ${about.name}`;
  refs.aboutVersion.textContent = about.version;
  refs.aboutVersion.hidden = about.version === "";
  if (refs.aboutLine) {
    refs.aboutLine.textContent = t(
      "views.settings.aboutLine",
      { license: about.license },
      "{license} license — built by Aaron May — based on openclaw-command-center",
    );
  }
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

// ============================================================================
// Alert rules card (v2 alert-rules-ui) — per-rule enable/disable, flap
// thresholds, and sink routing (alerts.routing). Self-contained: own refs
// (arRefs), own populate/save; wired from init() via initAlertRules() and
// from populate() via populateAlertRules() only, so merges stay clean.
// ============================================================================

const ALERT_SINK_NAMES = ["slack", "ntfy", "webhooks"];
const ALERT_SINK_LABELS = {
  slack: "Slack",
  ntfy: "ntfy",
  webhooks: "Webhooks",
};

let arRefs = null; // DOM refs for the Alert rules card (reset in teardown())
let arRuleNames = []; // rule names from the last server response

/** Wire the Alert rules card: refs, i18n labels, and the save handler. */
function initAlertRules(root) {
  arRefs = {
    rows: root.querySelector("#set-arules-rows"),
    save: root.querySelector("#set-arules-save"),
    error: root.querySelector("#set-arules-error"),
    flapConsecutive: root.querySelector("#set-arules-flap-consecutive"),
    flapDuration: root.querySelector("#set-arules-flap-duration"),
  };
  if (Object.values(arRefs).some((node) => !node)) {
    console.error("[Settings] Alert rules card markup is missing expected elements.");
    arRefs = null;
    return;
  }

  // Re-label static partial text through t() (inline English fallbacks; the
  // partial cannot use data-i18n for keys absent from the locale bundle).
  setText(root, "#set-arules-title", t("views.settings.arulesTitle", {}, "🚨 Alert rules"));
  setText(root, "#set-arules-col-rule", t("views.settings.arulesColRule", {}, "Rule"));
  setText(root, "#set-arules-col-enabled", t("views.settings.arulesColEnabled", {}, "Enabled"));
  setText(root, "#set-arules-col-sinks", t("views.settings.arulesColSinks", {}, "Sends to"));
  setText(
    root,
    "#set-arules-hint",
    t(
      "views.settings.arulesHint",
      {},
      'Per-rule delivery: enable/disable each alert rule and choose which sink(s) it fires to. "All sinks" routes through every configured sink; webhook event filters still apply.',
    ),
  );
  setText(
    root,
    "#set-arules-flap-title",
    t("views.settings.arulesFlapTitle", {}, "Flap suppression (nodeOffline / nodeUnreachable)"),
  );
  setText(
    root,
    "#set-arules-flap-consecutive-label",
    t("views.settings.arulesFlapConsecutive", {}, "Consecutive failed checks (1–20)"),
  );
  setText(
    root,
    "#set-arules-flap-duration-label",
    t("views.settings.arulesFlapDuration", {}, "Min failing duration, seconds (0–3600)"),
  );
  arRefs.save.textContent = t("views.settings.arulesSave", {}, "Save alert rules");
  arRefs.save.addEventListener("click", saveAlertRules);
}

function setText(root, selector, text) {
  const node = root.querySelector(selector);
  if (node) node.textContent = text;
}

/** Rebuild the rules table + flap inputs from server truth (settings.alerts). */
function populateAlertRules(alerts) {
  if (!arRefs) return;
  const rules = alerts.rules || {};
  const routing = alerts.routing || {};
  const flap = alerts.flap || {};
  arRuleNames = Object.keys(rules);

  arRefs.rows.replaceChildren();
  for (const rule of arRuleNames) {
    arRefs.rows.appendChild(buildAlertRuleRow(rule, rules[rule] !== false, routing[rule]));
  }

  arRefs.flapConsecutive.value = String(flap.consecutive ?? 3);
  arRefs.flapDuration.value = String(Math.round((flap.minDurationMs ?? 60000) / SEC));
}

/** One table row: rule name, enabled toggle, routing checkboxes (All + sinks). */
function buildAlertRuleRow(rule, enabled, sinkList) {
  const row = el("div", "set-arules-row");
  row.dataset.arule = rule;

  const name = el("span", "set-arules-rule", rule);
  name.title = rule;
  row.appendChild(name);

  const enabledLabel = el("label", "set-toggle");
  const enabledInput = document.createElement("input");
  enabledInput.type = "checkbox";
  enabledInput.dataset.aruleEnabled = rule;
  enabledInput.checked = enabled;
  enabledLabel.appendChild(enabledInput);
  row.appendChild(enabledLabel);

  const routesToAll = !Array.isArray(sinkList) || sinkList.includes("*");
  const sinksWrap = el("span", "set-arules-sinks");
  const boxes = [];

  const allLabel = el("label");
  const allInput = document.createElement("input");
  allInput.type = "checkbox";
  allInput.dataset.aruleSink = "*";
  allInput.checked = routesToAll;
  allLabel.appendChild(allInput);
  allLabel.appendChild(el("span", null, t("views.settings.arulesAllSinks", {}, "All sinks")));
  sinksWrap.appendChild(allLabel);

  for (const sink of ALERT_SINK_NAMES) {
    const label = el("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.aruleSink = sink;
    input.checked = !routesToAll && sinkList.includes(sink);
    label.appendChild(input);
    label.appendChild(el("span", null, ALERT_SINK_LABELS[sink] || sink));
    sinksWrap.appendChild(label);
    boxes.push(input);
  }

  // "All sinks" is exclusive with the specific-sink boxes.
  allInput.addEventListener("change", () => {
    if (allInput.checked) for (const box of boxes) box.checked = false;
  });
  for (const box of boxes) {
    box.addEventListener("change", () => {
      if (box.checked) allInput.checked = false;
      else if (boxes.every((other) => !other.checked)) allInput.checked = true;
    });
  }

  row.appendChild(sinksWrap);
  return row;
}

/** Read one rule row's routing selection back into the PATCH shape. */
function readAlertRuleRouting(row) {
  const selected = [];
  let all = false;
  for (const input of row.querySelectorAll("input[data-arule-sink]")) {
    if (!input.checked) continue;
    if (input.dataset.aruleSink === "*") all = true;
    else selected.push(input.dataset.aruleSink);
  }
  return all || selected.length === 0 ? ["*"] : selected;
}

function saveAlertRules() {
  if (!arRefs) return;
  const consecutive = readBoundedNumber(arRefs.flapConsecutive, 1, 20);
  const durationSec = readBoundedNumber(arRefs.flapDuration, 0, 3600);
  if (consecutive === null || durationSec === null) {
    arRefs.error.hidden = false;
    arRefs.error.textContent = t(
      "views.settings.arulesFlapInvalid",
      {},
      "Flap thresholds must be 1–20 consecutive checks and 0–3600 seconds.",
    );
    return;
  }

  const rules = {};
  const routing = {};
  for (const row of arRefs.rows.querySelectorAll(".set-arules-row[data-arule]")) {
    const rule = row.dataset.arule;
    const enabledInput = row.querySelector("input[data-arule-enabled]");
    rules[rule] = Boolean(enabledInput && enabledInput.checked);
    routing[rule] = readAlertRuleRouting(row);
  }
  if (Object.keys(rules).length === 0) return; // nothing loaded yet

  arRefs.error.hidden = true;
  patchSettings(
    {
      alerts: {
        rules,
        routing,
        flap: { consecutive, minDurationMs: durationSec * SEC },
      },
    },
    { button: arRefs.save, errorEl: arRefs.error },
  );
}
