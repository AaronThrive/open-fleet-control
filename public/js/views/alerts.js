/**
 * Alerts view module — fired-alert history with live updates and mutes.
 *
 * Loaded by views.js via dynamic import; `init(containerEl)` runs on every
 * visit of #view-alerts and must be idempotent: DOM lookups and bindings
 * happen fresh inside init, and previous timers are cleared first.
 *
 * Data sources:
 *   GET   /api/fleet/alerts?history=1&type&node&severity&limit — disk history
 *   GET   /api/fleet/alerts?type&node&severity&limit           — memory ring
 *   GET   /api/fleet/alerts/analytics                          — 14d rollup
 *   GET   /api/fleet/settings                                  — rules + mutes
 *   PATCH /api/fleet/settings                                  — mute / unmute /
 *                                                                re-enable rules
 *   SSE   /api/events (event "fleet.alert")                    — live refresh
 *
 * All values are rendered via textContent — never innerHTML — so the list
 * is XSS-safe with hostile node names / messages.
 */

import { t } from "../utils.js";

const AUTO_REFRESH_MS = 60000;
const SSE_REFRESH_DEBOUNCE_MS = 400;
const SSE_URL = "/api/events";
const NODE_RULES = ["nodeOffline", "nodeUnreachable"];
const HOUR_MS = 3600000;

// Module-scope state (the module is cached by the browser; only init()
// re-runs on each visit).
let refreshTimer = null;
let sseDebounceTimer = null;
let eventSource = null; // module-level singleton, survives revisits
let requestSeq = 0;
let activeEls = null; // els of the current visit (used by SSE handler)

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Relative display like "12s ago" / "5m ago" / "3h ago" / "2d ago". */
function relativeTime(tsMs) {
  if (!Number.isFinite(tsMs)) return "—";
  const diff = Date.now() - tsMs;
  if (diff < 0) return new Date(tsMs).toLocaleString();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return t("time.agoSeconds", { n: sec }, "{n}s ago");
  const min = Math.floor(sec / 60);
  if (min < 60) return t("time.agoMinutes", { n: min }, "{n}m ago");
  const hours = Math.floor(min / 60);
  if (hours < 24) return t("time.agoHours", { n: hours }, "{n}h ago");
  const days = Math.floor(hours / 24);
  if (days < 30) return t("time.agoDays", { n: days }, "{n}d ago");
  return new Date(tsMs).toLocaleDateString();
}

function buildQuery(els) {
  const params = new URLSearchParams();
  if (els.severity.value) params.set("severity", els.severity.value);
  if (els.type.value) params.set("type", els.type.value);
  const node = els.node.value.trim();
  if (node) params.set("node", node);
  params.set("limit", els.limit.value || "100");
  if (els.source.value === "history") params.set("history", "1");
  return params.toString();
}

function showError(els, message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

function clearError(els) {
  els.error.hidden = true;
  els.error.textContent = "";
}

async function fetchJson(url, options = {}) {
  const init = { ...options };
  if (init.body !== undefined && typeof init.body !== "string") {
    init.body = JSON.stringify(init.body);
    init.headers = { "Content-Type": "application/json", ...(init.headers || {}) };
  }
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, payload };
}

/* ------------------------------------------------------------------ */
/* Rendering (DOM-built, textContent only — XSS-safe)                  */
/* ------------------------------------------------------------------ */

function buildRow(els, alert) {
  const row = document.createElement("div");
  row.className = "alerts-row";

  const time = document.createElement("span");
  time.className = "alerts-time";
  time.textContent = relativeTime(alert.ts);
  if (Number.isFinite(alert.ts)) time.title = new Date(alert.ts).toLocaleString();

  const severityCell = document.createElement("span");
  const severity = document.createElement("span");
  const level = ["critical", "warn", "info"].includes(alert.severity) ? alert.severity : "info";
  severity.className = `alerts-severity alerts-severity-${level}`;
  severity.textContent = level;
  severityCell.appendChild(severity);

  const type = document.createElement("span");
  type.className = "alerts-type";
  type.textContent = String(alert.type || "—");
  type.title = String(alert.type || "");

  const target = document.createElement("span");
  target.className = "alerts-target";
  const targetText = alert.node || alert.task || "";
  if (targetText) {
    target.textContent = targetText;
    target.title = targetText;
  } else {
    target.textContent = "—";
    target.classList.add("alerts-target-empty");
  }

  const message = document.createElement("span");
  message.className = "alerts-message";
  message.textContent = alert.message || "";
  message.title = alert.message || "";

  const actions = document.createElement("span");
  actions.className = "alerts-row-actions";
  if (alert.node) {
    for (const [labelKey, fallback, hours] of [
      ["views.alerts.mute1h", "Mute 1h", 1],
      ["views.alerts.mute24h", "Mute 24h", 24],
    ]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "alerts-mini-btn";
      btn.textContent = t(labelKey, {}, fallback);
      btn.addEventListener("click", () => muteNode(els, alert.node, hours));
      actions.appendChild(btn);
    }
  }

  row.append(time, severityCell, type, target, message, actions);
  return row;
}

function render(els, alerts) {
  els.rows.replaceChildren(...alerts.map((alert) => buildRow(els, alert)));
  els.countLine.textContent =
    alerts.length === 1
      ? t("views.alerts.countOne", { n: alerts.length }, "{n} alert shown")
      : t("views.alerts.countMany", { n: alerts.length }, "{n} alerts shown");
  els.table.hidden = alerts.length === 0;
  els.emptyState.style.display = alerts.length === 0 ? "" : "none";
}

/** Human chip label for one mute entry, e.g. "nodeOffline @ hermes-1 — until 14:00". */
function muteLabel(mute) {
  const any = t("views.alerts.muteAny", {}, "any");
  const scope = `${mute.rule || any} @ ${mute.node || any}`;
  if (!mute.until) return `${scope} — ${t("views.alerts.muteForever", {}, "indefinitely")}`;
  const when = new Date(mute.until).toLocaleString();
  return `${scope} — ${t("views.alerts.muteUntil", { time: when }, "until {time}")}`;
}

function renderBanners(els, settings) {
  const rules = settings?.alerts?.rules || {};
  const disabled = NODE_RULES.filter((rule) => rules[rule] === false);
  els.mutedRules.hidden = disabled.length === 0;
  els.mutedRulesList.textContent = disabled.join(", ");

  const now = Date.now();
  const mutes = Array.isArray(settings?.alerts?.mutes) ? settings.alerts.mutes : [];
  const active = mutes.filter((m) => !m.until || Date.parse(m.until) > now);
  els.activeMutes.hidden = active.length === 0;
  els.muteChips.replaceChildren(
    ...active.map((mute) => {
      const chip = document.createElement("span");
      chip.className = "alerts-chip";
      const label = document.createElement("span");
      label.textContent = muteLabel(mute);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = t("views.alerts.unmute", {}, "Unmute");
      btn.addEventListener("click", () => unmute(els, mute));
      chip.append(label, btn);
      return chip;
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Data loading + settings actions                                     */
/* ------------------------------------------------------------------ */

async function load(els) {
  const seq = ++requestSeq;
  try {
    const { ok, status, payload } = await fetchJson(`/api/fleet/alerts?${buildQuery(els)}`);
    if (seq !== requestSeq || !els.rows.isConnected) return; // stale response
    if (!ok) {
      showError(
        els,
        payload.error ||
          t("views.alerts.queryFailed", { status }, "Alert query failed (HTTP {status})"),
      );
      return;
    }
    clearError(els);
    render(els, Array.isArray(payload.alerts) ? payload.alerts : []);
  } catch (error) {
    if (seq !== requestSeq || !els.rows.isConnected) return;
    showError(
      els,
      t("views.alerts.networkError", {}, "Could not reach the alerts API — is the server up?"),
    );
  }
}

async function loadSettings(els) {
  try {
    const { ok, payload } = await fetchJson("/api/fleet/settings");
    if (!els.rows.isConnected) return;
    if (!ok) return; // settings module not wired — banners stay hidden
    renderBanners(els, payload);
  } catch (error) {
    // Banners are best-effort; the alert list is the primary surface.
  }
}

async function patchSettings(els, body) {
  try {
    const { ok, payload } = await fetchJson("/api/fleet/settings", { method: "PATCH", body });
    if (!ok) {
      showError(
        els,
        t(
          "views.alerts.updateFailed",
          { message: payload.error || "unknown error" },
          "Settings update failed: {message}",
        ),
      );
      return false;
    }
    clearError(els);
    renderBanners(els, payload.applied ? { alerts: payload.applied.alerts } : null);
    return true;
  } catch (error) {
    showError(
      els,
      t("views.alerts.networkError", {}, "Could not reach the alerts API — is the server up?"),
    );
    return false;
  }
}

/** Quick action: mute every alert rule for one node for N hours. */
async function muteNode(els, node, hours) {
  const { ok, payload } = await fetchJson("/api/fleet/settings");
  if (!ok) return;
  const now = Date.now();
  const existing = (payload?.alerts?.mutes || []).filter(
    (m) => !m.until || Date.parse(m.until) > now,
  );
  const until = new Date(now + hours * HOUR_MS).toISOString();
  await patchSettings(els, { alerts: { mutes: [...existing, { node, until }] } });
}

/** Remove one mute entry (full-replacement PATCH with the rest). */
async function unmute(els, target) {
  const { ok, payload } = await fetchJson("/api/fleet/settings");
  if (!ok) return;
  const key = (m) => `${m.rule || ""}|${m.node || ""}|${m.until || ""}`;
  const remaining = (payload?.alerts?.mutes || []).filter((m) => key(m) !== key(target));
  await patchSettings(els, { alerts: { mutes: remaining } });
}

/** One-click re-enable of the currently disabled node alert rules. */
async function reEnableNodeRules(els) {
  const { ok, payload } = await fetchJson("/api/fleet/settings");
  if (!ok) return;
  const rules = payload?.alerts?.rules || {};
  const patch = {};
  for (const rule of NODE_RULES) {
    if (rules[rule] === false) patch[rule] = true;
  }
  if (Object.keys(patch).length === 0) return;
  await patchSettings(els, { alerts: { rules: patch } });
}

/* ------------------------------------------------------------------ */
/* Analytics (v2 alert-rules-ui) — GET /api/fleet/alerts/analytics     */
/* ------------------------------------------------------------------ */

/** Best-effort load: the section stays hidden if the endpoint is missing. */
async function loadAnalytics(els) {
  try {
    const { ok, payload } = await fetchJson("/api/fleet/alerts/analytics");
    if (!els.rows.isConnected) return;
    if (!ok || !payload || !Array.isArray(payload.perDay)) {
      els.analytics.hidden = true;
      return;
    }
    renderAnalytics(els, payload);
  } catch (error) {
    if (els.analytics) els.analytics.hidden = true; // analytics is best-effort
  }
}

function analyticsItem(name, countText) {
  const row = document.createElement("div");
  row.className = "alerts-analytics-item";
  const nameEl = document.createElement("span");
  nameEl.className = "alerts-analytics-item-name";
  nameEl.textContent = name;
  nameEl.title = name;
  const countEl = document.createElement("span");
  countEl.className = "alerts-analytics-item-count";
  countEl.textContent = countText;
  row.append(nameEl, countEl);
  return row;
}

function renderAnalyticsList(listEl, rows) {
  if (rows.length === 0) {
    const none = document.createElement("span");
    none.className = "alerts-analytics-item-count";
    none.textContent = t("views.alerts.analyticsNone", {}, "—");
    listEl.replaceChildren(none);
    return;
  }
  listEl.replaceChildren(...rows);
}

/** Stacked per-day severity bars; column heights scale to the busiest day. */
function renderAnalyticsChart(els, perDay) {
  const max = Math.max(1, ...perDay.map((day) => day.total));
  els.analyticsChart.replaceChildren(
    ...perDay.map((day) => {
      const col = document.createElement("div");
      col.className = "alerts-analytics-col";
      col.title = t(
        "views.alerts.analyticsDayTitle",
        { date: day.date, n: day.total },
        "{date}: {n} alerts",
      );
      col.style.height = day.total > 0 ? `${Math.max(4, (day.total / max) * 100)}%` : "100%";
      for (const severity of ["info", "warn", "critical"]) {
        if (!day[severity]) continue;
        const seg = document.createElement("div");
        seg.className = `alerts-analytics-seg-${severity}`;
        seg.style.flexGrow = String(day[severity]);
        col.appendChild(seg);
      }
      return col;
    }),
  );
  els.analyticsAxisStart.textContent = perDay.length > 0 ? perDay[0].date : "";
  els.analyticsAxisEnd.textContent = perDay.length > 0 ? perDay[perDay.length - 1].date : "";
}

function renderAnalytics(els, data) {
  els.analytics.hidden = false;
  els.analyticsTitle.textContent = t(
    "views.alerts.analyticsTitle",
    { days: data.days, n: data.total },
    "Alert analytics — {n} alerts in the last {days} days",
  );
  els.analyticsRulesTitle.textContent = t("views.alerts.analyticsRules", {}, "Noisiest rules");
  els.analyticsNodesTitle.textContent = t("views.alerts.analyticsNodes", {}, "Noisiest nodes");
  els.analyticsFlapsTitle.textContent = t(
    "views.alerts.analyticsFlaps",
    {},
    "Flapping (fired → recovered cycles)",
  );
  els.analyticsEmpty.textContent = t(
    "views.alerts.analyticsEmpty",
    {},
    "No alerts in the analytics window yet.",
  );

  const isEmpty = data.total === 0;
  els.analyticsEmpty.hidden = !isEmpty;
  els.analyticsGrid.hidden = isEmpty;

  renderAnalyticsChart(els, data.perDay);
  renderAnalyticsList(
    els.analyticsRules,
    (data.topRules || []).map((row) =>
      analyticsItem(row.type, t("views.alerts.analyticsCount", { n: row.count }, "{n}×")),
    ),
  );
  renderAnalyticsList(
    els.analyticsNodes,
    (data.topNodes || []).map((row) =>
      analyticsItem(row.node, t("views.alerts.analyticsCount", { n: row.count }, "{n}×")),
    ),
  );
  renderAnalyticsList(
    els.analyticsFlaps,
    (data.flaps || []).map((row) =>
      analyticsItem(
        `${row.rule} @ ${row.node}`,
        t("views.alerts.analyticsCycles", { n: row.cycles }, "{n} cycles"),
      ),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */

function setLiveBadge(els, isLive) {
  els.liveBadge.classList.toggle("alerts-live-on", isLive);
  els.liveBadge.textContent = isLive
    ? t("views.alerts.liveBadge", {}, "LIVE")
    : t("views.alerts.pollBadge", {}, "POLL");
}

function scheduleSseRefresh() {
  if (sseDebounceTimer) clearTimeout(sseDebounceTimer);
  sseDebounceTimer = setTimeout(() => {
    sseDebounceTimer = null;
    if (activeEls && activeEls.rows.isConnected) load(activeEls);
  }, SSE_REFRESH_DEBOUNCE_MS);
}

function ensureEventSource(els) {
  setLiveBadge(els, Boolean(eventSource && eventSource.readyState === 1));
  if (eventSource) return;

  if (typeof EventSource === "undefined") {
    setLiveBadge(els, false);
    return; // 60s refresh interval covers polling-only browsers
  }

  try {
    eventSource = new EventSource(SSE_URL);
  } catch (error) {
    console.error("[Alerts] Failed to open SSE:", error);
    eventSource = null;
    return;
  }

  eventSource.addEventListener("open", () => {
    if (activeEls && activeEls.rows.isConnected) setLiveBadge(activeEls, true);
  });
  // EventSource reconnects automatically; the 60s refresh covers any gap.
  eventSource.addEventListener("error", () => {
    if (activeEls && activeEls.rows.isConnected) setLiveBadge(activeEls, false);
  });
  eventSource.addEventListener("fleet.alert", () => scheduleSseRefresh());
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

function stopTimers() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (sseDebounceTimer) {
    clearTimeout(sseDebounceTimer);
    sseDebounceTimer = null;
  }
}

/**
 * Initialize the Alerts panel. Called by views.js on every visit with the
 * container that holds the freshly injected partial HTML.
 *
 * @param {HTMLElement} container
 */
export function init(container) {
  stopTimers();

  const els = {
    severity: container.querySelector("#alerts-filter-severity"),
    type: container.querySelector("#alerts-filter-type"),
    node: container.querySelector("#alerts-filter-node"),
    source: container.querySelector("#alerts-filter-source"),
    limit: container.querySelector("#alerts-filter-limit"),
    refreshBtn: container.querySelector("#alerts-refresh-btn"),
    emptyRefreshBtn: container.querySelector("#alerts-empty-refresh"),
    countLine: container.querySelector("#alerts-count-line"),
    liveBadge: container.querySelector("#alerts-live-badge"),
    error: container.querySelector("#alerts-error"),
    table: container.querySelector("#alerts-table"),
    rows: container.querySelector("#alerts-rows"),
    emptyState: container.querySelector("#alerts-empty-state"),
    mutedRules: container.querySelector("#alerts-muted-rules"),
    mutedRulesList: container.querySelector("#alerts-muted-rules-list"),
    reEnableBtn: container.querySelector("#alerts-reenable-btn"),
    activeMutes: container.querySelector("#alerts-active-mutes"),
    muteChips: container.querySelector("#alerts-mute-chips"),
    // Analytics (v2 alert-rules-ui)
    analytics: container.querySelector("#alerts-analytics"),
    analyticsTitle: container.querySelector("#alerts-analytics-title"),
    analyticsChart: container.querySelector("#alerts-analytics-chart"),
    analyticsAxisStart: container.querySelector("#alerts-analytics-axis-start"),
    analyticsAxisEnd: container.querySelector("#alerts-analytics-axis-end"),
    analyticsEmpty: container.querySelector("#alerts-analytics-empty"),
    analyticsGrid: container.querySelector("#alerts-analytics-grid"),
    analyticsRulesTitle: container.querySelector("#alerts-analytics-rules-title"),
    analyticsRules: container.querySelector("#alerts-analytics-rules"),
    analyticsNodesTitle: container.querySelector("#alerts-analytics-nodes-title"),
    analyticsNodes: container.querySelector("#alerts-analytics-nodes"),
    analyticsFlapsTitle: container.querySelector("#alerts-analytics-flaps-title"),
    analyticsFlaps: container.querySelector("#alerts-analytics-flaps"),
  };
  if (Object.values(els).some((el) => !el)) {
    console.error("[Alerts] Partial markup is missing expected elements; aborting init.");
    return;
  }
  activeEls = els;

  const reload = () => load(els);
  for (const el of [els.severity, els.type, els.source, els.limit]) {
    el.addEventListener("change", reload);
  }
  let nodeDebounce = null;
  els.node.addEventListener("input", () => {
    if (nodeDebounce) clearTimeout(nodeDebounce);
    nodeDebounce = setTimeout(reload, 350);
  });
  els.refreshBtn.addEventListener("click", () => {
    load(els);
    loadSettings(els);
    loadAnalytics(els);
  });
  els.emptyRefreshBtn.addEventListener("click", reload);
  els.reEnableBtn.addEventListener("click", () => reEnableNodeRules(els));

  ensureEventSource(els);

  // Auto-refresh while the view stays visible. The interval self-cancels
  // once this partial's DOM is replaced and skips ticks while hidden.
  refreshTimer = setInterval(() => {
    if (!els.rows.isConnected) {
      stopTimers();
      return;
    }
    if (document.hidden) return;
    load(els);
    loadSettings(els);
    loadAnalytics(els);
  }, AUTO_REFRESH_MS);

  load(els);
  loadSettings(els);
  loadAnalytics(els);
}
