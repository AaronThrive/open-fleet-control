/**
 * Tokens & Cost view module.
 *
 * Loaded by views.js via dynamic import; `init(containerEl)` runs on every
 * visit of #view-tokens and must be idempotent.
 *
 * Data sources:
 *  - GET /api/cost-breakdown →
 *      windows.{24h,3d,7d}: { totalCost, requests, monthlyProjected,
 *        tokens: {input, output, cacheRead, cacheWrite},
 *        byModel: [{ model, input, output, cacheRead, cacheWrite, requests,
 *                    cost, estCost, reportedCost }] }
 *  - GET /api/usage/sources?sinceMs&days → per-source adapters
 *      (claude-code windows, codex activity, 9Router usage + DAILY rollups,
 *       headroom subscription, OpenRouter credits)
 *
 * v2.2: every breakdown renders through the shared detail-list component
 * (windows, per-model, per-day, totals-by-source) — no card grids.
 *
 * Cost honesty: rows whose cost came from provider usage records
 * (reportedCost > 0) get a REPORTED badge; locally computed ones get EST.
 *
 * Real-time: polling only (cost aggregation is not part of the SSE state
 * payload). All dynamic values via textContent — XSS-safe.
 */

import { t } from "../utils.js";
import { createDetailList } from "../components/detail-list.js";

const POLL_MS = 60000;
const DAY_MS = 86400000;
const DAILY_DAYS = 14;
const WINDOW_ORDER = ["24h", "3d", "7d"];
const WINDOW_LABELS = {
  "24h": "Last 24 hours",
  "3d": "Last 3 days",
  "7d": "Last 7 days",
};

let pollTimer = null;
let requestSeq = 0;
let currentData = null;
let sourcesData = null;
let selectedWindow = "24h";
let lists = {};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function formatCost(value) {
  return `$${(Number(value) || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** key/value pairs as a compact detail grid (textContent only). */
function detailGrid(pairs) {
  const grid = el("div", "tokens-detail-grid");
  for (const [label, value] of pairs) {
    if (value === null || value === undefined) continue;
    const cell = el("div");
    cell.appendChild(el("span", "label", label));
    cell.appendChild(document.createTextNode(String(value)));
    grid.appendChild(cell);
  }
  return grid;
}

/* ------------------------------------------------------------------ */
/* Windows list                                                        */
/* ------------------------------------------------------------------ */

/** Pure row builder over the /api/cost-breakdown payload (exported for tests). */
export function windowRows(data) {
  const rows = [];
  for (const key of WINDOW_ORDER) {
    const windowData = data?.windows?.[key];
    if (!windowData) continue;
    const tokens = windowData.tokens || {};
    rows.push({
      key,
      window: WINDOW_LABELS[key] || key,
      cost: Number(windowData.totalCost) || 0,
      tokens:
        (Number(tokens.input) || 0) +
        (Number(tokens.output) || 0) +
        (Number(tokens.cacheRead) || 0) +
        (Number(tokens.cacheWrite) || 0),
      requests: Number(windowData.requests) || 0,
      projected: Number.isFinite(windowData.monthlyProjected) ? windowData.monthlyProjected : null,
      detail: tokens,
    });
  }
  return rows;
}

function buildWindowsList(host) {
  return createDetailList(host, {
    columns: [
      { key: "window", label: t("views.tokens.colWindow", {}, "Window") },
      {
        key: "cost",
        label: t("views.tokens.colCost", {}, "Cost"),
        sortable: true,
        render: (row) => el("span", "", formatCost(row.cost)),
      },
      {
        key: "tokens",
        label: t("views.tokens.colTokens", {}, "Tokens"),
        sortable: true,
        render: (row) => el("span", "", formatTokens(row.tokens)),
      },
      {
        key: "requests",
        label: t("views.tokens.colRequests", {}, "Requests"),
        sortable: true,
        render: (row) => el("span", "", (row.requests || 0).toLocaleString()),
      },
      {
        key: "projected",
        label: t("views.tokens.colProjected", {}, "Projected / mo"),
        render: (row) =>
          el("span", "", row.projected === null ? "—" : `≈ ${formatCost(row.projected)}`),
      },
    ],
    getRowId: (row) => row.key,
    renderDetail: (row) =>
      detailGrid([
        [t("views.tokens.detailInput", {}, "Input"), formatTokens(row.detail.input)],
        [t("views.tokens.detailOutput", {}, "Output"), formatTokens(row.detail.output)],
        [t("views.tokens.detailCacheRead", {}, "Cache read"), formatTokens(row.detail.cacheRead)],
        [
          t("views.tokens.detailCacheWrite", {}, "Cache write"),
          formatTokens(row.detail.cacheWrite),
        ],
      ]),
    emptyText: t("views.tokens.empty", {}, "No token usage recorded yet"),
    showFilter: false,
  });
}

/* ------------------------------------------------------------------ */
/* Per-model list                                                      */
/* ------------------------------------------------------------------ */

function modelRows() {
  const byModel = currentData?.windows?.[selectedWindow]?.byModel || [];
  return byModel.map((model) => ({
    model: model.model || "unknown",
    input: Number(model.input) || 0,
    output: Number(model.output) || 0,
    cacheRead: Number(model.cacheRead) || 0,
    cacheWrite: Number(model.cacheWrite) || 0,
    requests: Number(model.requests) || 0,
    cost: Number(model.cost ?? model.estCost) || 0,
    estCost: Number(model.estCost) || 0,
    reportedCost: Number(model.reportedCost) || 0,
  }));
}

function modelCostCell(row) {
  const wrap = el("span", "", formatCost(row.cost));
  const reported = row.reportedCost > 0;
  wrap.appendChild(
    el(
      "span",
      `cost-badge ${reported ? "reported" : "est"}`,
      reported
        ? t("views.tokens.badgeReported", {}, "reported")
        : t("views.tokens.badgeEst", {}, "est"),
    ),
  );
  return wrap;
}

function buildModelsList(host) {
  const tokensCell = (key, className) => (row) =>
    el("span", className || "", formatTokens(row[key]));
  return createDetailList(host, {
    columns: [
      { key: "model", label: t("views.tokens.colModel", {}, "Model"), sortable: true },
      {
        key: "input",
        label: t("views.tokens.colInput", {}, "Input"),
        sortable: true,
        render: tokensCell("input"),
      },
      {
        key: "output",
        label: t("views.tokens.colOutput", {}, "Output"),
        sortable: true,
        render: tokensCell("output"),
      },
      {
        key: "cacheRead",
        label: t("views.tokens.colCacheRead", {}, "Cache Read"),
        sortable: true,
        render: tokensCell("cacheRead", "tokens-cache-read"),
      },
      {
        key: "cacheWrite",
        label: t("views.tokens.colCacheWrite", {}, "Cache Write"),
        sortable: true,
        render: tokensCell("cacheWrite", "tokens-cache-write"),
      },
      {
        key: "requests",
        label: t("views.tokens.colRequests", {}, "Requests"),
        sortable: true,
        render: (row) => el("span", "", (row.requests || 0).toLocaleString()),
      },
      {
        key: "cost",
        label: t("views.tokens.colCost", {}, "Cost"),
        sortable: true,
        render: modelCostCell,
      },
    ],
    getRowId: (row) => row.model,
    renderDetail: (row) =>
      detailGrid([
        [t("views.tokens.detailEstCost", {}, "Est. cost"), formatCost(row.estCost)],
        [
          t("views.tokens.detailReportedCost", {}, "Reported cost"),
          row.reportedCost > 0 ? formatCost(row.reportedCost) : "—",
        ],
        [
          t("views.tokens.detailTotalTokens", {}, "Total tokens"),
          formatTokens(row.input + row.output + row.cacheRead + row.cacheWrite),
        ],
      ]),
    emptyText: t("views.tokens.noModelData", {}, "No model data for this window"),
    filterKeys: ["model"],
    filterPlaceholder: t("views.tokens.filterModels", {}, "Filter models…"),
    defaultSort: { key: "cost", dir: "desc" },
  });
}

/* ------------------------------------------------------------------ */
/* Per-day list (9Router daily rollups)                                */
/* ------------------------------------------------------------------ */

/** Defensive extraction over the usageDaily JSON blob shapes (exported for tests). */
export function dailySummaryNumbers(summary) {
  const src = summary && typeof summary === "object" ? summary : {};
  const totals = src.totals && typeof src.totals === "object" ? src.totals : src;
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
  return {
    requests: num(totals.requests),
    tokens: num(totals.totalTokens ?? totals.tokens),
    cost: num(totals.cost),
  };
}

/** Pure row builder over the /api/usage/sources payload (exported for tests). */
export function dailyRowsFrom(sources) {
  const days = sources?.nineRouter?.daily?.days;
  if (!Array.isArray(days)) return [];
  return days
    .filter((day) => day && typeof day.date === "string")
    .map((day) => ({ date: day.date, ...dailySummaryNumbers(day.summary) }));
}

function buildDailyList(host) {
  const numCell = (key, format) => (row) =>
    el("span", "", row[key] === null ? "—" : format(row[key]));
  return createDetailList(host, {
    columns: [
      { key: "date", label: t("views.tokens.colDate", {}, "Date"), sortable: true },
      {
        key: "requests",
        label: t("views.tokens.colRequests", {}, "Requests"),
        sortable: true,
        render: numCell("requests", (v) => v.toLocaleString()),
      },
      {
        key: "tokens",
        label: t("views.tokens.colTokens", {}, "Tokens"),
        sortable: true,
        render: numCell("tokens", formatTokens),
      },
      {
        key: "cost",
        label: t("views.tokens.colCost", {}, "Cost"),
        sortable: true,
        render: numCell("cost", formatCost),
      },
    ],
    getRowId: (row) => row.date,
    emptyText: t("views.tokens.noDailyData", {}, "No 9Router daily data available"),
    filterKeys: ["date"],
    filterPlaceholder: t("views.tokens.filterDays", {}, "Filter days…"),
    defaultSort: { key: "date", dir: "desc" },
  });
}

/* ------------------------------------------------------------------ */
/* Totals-by-source list                                               */
/* ------------------------------------------------------------------ */

/** Pure row builder over the /api/usage/sources payload (exported for tests). */
export function sourceRowsFrom(sources) {
  const src = sources || {};
  const rows = [];

  const claudeWindows = src.claudeCode?.windows;
  rows.push({
    id: "claude-code",
    source: "Claude Code",
    status: src.claudeCode?.available ? "available" : "unavailable",
    tokens:
      claudeWindows?.available && claudeWindows.h24
        ? (Number(claudeWindows.h24.input) || 0) +
          (Number(claudeWindows.h24.output) || 0) +
          (Number(claudeWindows.h24.cacheRead) || 0) +
          (Number(claudeWindows.h24.cacheWrite) || 0)
        : null,
    requests: claudeWindows?.available ? Number(claudeWindows.h24?.requests) || 0 : null,
    cost: claudeWindows?.available ? Number(claudeWindows.h24?.estCost) || 0 : null,
    costKind: "est",
    note: src.claudeCode?.reason || null,
  });

  const codexActivity = src.codex?.activity;
  rows.push({
    id: "codex",
    source: "Codex",
    status: src.codex?.available ? "available" : "unavailable",
    tokens: null, // codex history carries no token counts (tokensAvailable:false)
    requests: codexActivity ? Number(codexActivity.entries) || 0 : null,
    cost: null,
    costKind: null,
    note:
      src.codex?.reason ||
      (codexActivity ? `${Number(codexActivity.sessions) || 0} sessions in window` : null),
  });

  const nineUsage = src.nineRouter?.usage;
  rows.push({
    id: "nine-router",
    source: "9Router",
    status: src.nineRouter?.available ? "available" : "unavailable",
    tokens: nineUsage?.totals ? Number(nineUsage.totals.totalTokens) || 0 : null,
    requests: nineUsage?.totals ? Number(nineUsage.totals.requests) || 0 : null,
    cost: nineUsage?.totals ? Number(nineUsage.totals.cost) || 0 : null,
    costKind: "reported",
    note: src.nineRouter?.reason || null,
  });

  const headroom = src.headroom;
  rows.push({
    id: "headroom",
    source: "Headroom",
    status: headroom?.available ? (headroom.stale ? "stale" : "available") : "unavailable",
    tokens: headroom?.available ? Number(headroom.windowTokens?.totalRaw) || 0 : null,
    requests: null,
    cost: null,
    costKind: null,
    note: headroom?.reason || null,
  });

  const credits = src.openrouter?.credits;
  rows.push({
    id: "openrouter",
    source: "OpenRouter",
    status: src.openrouter?.available ? "available" : "unavailable",
    tokens: null,
    requests: null,
    cost: credits && Number.isFinite(credits.totalUsage) ? credits.totalUsage : null,
    costKind: "lifetime",
    note:
      src.openrouter?.reason ||
      (credits && Number.isFinite(credits.remaining)
        ? `${formatCost(credits.remaining)} credits remaining`
        : null),
  });

  return rows;
}

function sourceStatusCell(row) {
  const colors = { available: "var(--green, #3fb950)", stale: "var(--yellow, #ffb224)" };
  const cell = el("span", "", row.status);
  cell.style.color = colors[row.status] || "var(--text-muted)";
  return cell;
}

function buildSourcesList(host) {
  return createDetailList(host, {
    columns: [
      { key: "source", label: t("views.tokens.colSource", {}, "Source"), sortable: true },
      {
        key: "status",
        label: t("views.tokens.colStatus", {}, "Status"),
        sortable: true,
        render: sourceStatusCell,
      },
      {
        key: "tokens",
        label: t("views.tokens.colTokens", {}, "Tokens"),
        sortable: true,
        render: (row) => el("span", "", row.tokens === null ? "—" : formatTokens(row.tokens)),
      },
      {
        key: "requests",
        label: t("views.tokens.colRequests", {}, "Requests"),
        sortable: true,
        render: (row) =>
          el("span", "", row.requests === null ? "—" : row.requests.toLocaleString()),
      },
      {
        key: "cost",
        label: t("views.tokens.colCost", {}, "Cost"),
        sortable: true,
        render: (row) =>
          el(
            "span",
            "",
            row.cost === null
              ? "—"
              : `${formatCost(row.cost)}${row.costKind ? ` (${row.costKind})` : ""}`,
          ),
      },
    ],
    getRowId: (row) => row.id,
    renderDetail: (row) =>
      detailGrid([
        [t("views.tokens.detailStatus", {}, "Status"), row.status],
        [t("views.tokens.detailNote", {}, "Note"), row.note || "—"],
      ]),
    emptyText: t("views.tokens.noSources", {}, "Usage sources unavailable"),
    showFilter: false,
  });
}

/* ------------------------------------------------------------------ */
/* Data loading                                                        */
/* ------------------------------------------------------------------ */

function render(els) {
  lists.windows?.update(windowRows(currentData));
  lists.models?.update(modelRows());
  const daily = dailyRowsFrom(sourcesData);
  lists.daily?.update(daily);
  const dailyReason =
    sourcesData && sourcesData.nineRouter && !sourcesData.nineRouter.available
      ? sourcesData.nineRouter.reason
      : null;
  els.dailyNote.hidden = !dailyReason;
  if (dailyReason) els.dailyNote.textContent = String(dailyReason);
  lists.sources?.update(sourcesData ? sourceRowsFrom(sourcesData) : []);
}

async function load(els) {
  const seq = ++requestSeq;
  try {
    const sinceMs = Date.now() - DAY_MS;
    const [costResponse, sourcesResponse] = await Promise.all([
      fetch("/api/cost-breakdown"),
      fetch(`/api/usage/sources?sinceMs=${sinceMs}&days=${DAILY_DAYS}`).catch(() => null),
    ]);
    const payload = await costResponse.json();
    let sourcesPayload = null;
    if (sourcesResponse && sourcesResponse.ok) {
      sourcesPayload = await sourcesResponse.json().catch(() => null);
    }
    if (seq !== requestSeq || !els.root.isConnected) return;
    if (!costResponse.ok) throw new Error(`HTTP ${costResponse.status}`);
    els.error.hidden = true;
    currentData = payload;
    sourcesData = sourcesPayload;
    render(els);
  } catch (error) {
    if (seq !== requestSeq || !els.root.isConnected) return;
    els.error.hidden = false;
    els.error.textContent = t(
      "views.tokens.loadError",
      {},
      "Could not reach the cost-breakdown API — is the server up?",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

function teardown() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  for (const list of Object.values(lists)) list?.destroy();
  lists = {};
}

/**
 * Initialize the Tokens view. Called by views.js on every visit.
 * @param {HTMLElement} container
 */
export function init(container) {
  teardown();
  selectedWindow = "24h";
  currentData = null;
  sourcesData = null;

  const els = {
    root: container.querySelector("#tokens-view-section"),
    error: container.querySelector("#tokens-view-error"),
    windowsHost: container.querySelector("#tokens-windows-list"),
    tabs: container.querySelector("#tokens-window-tabs"),
    modelsHost: container.querySelector("#tokens-models-list"),
    dailyHost: container.querySelector("#tokens-daily-list"),
    dailyNote: container.querySelector("#tokens-daily-note"),
    sourcesHost: container.querySelector("#tokens-sources-list"),
    openModalBtn: container.querySelector("#tokens-open-cost-modal"),
  };
  if (Object.values(els).some((node) => !node)) {
    console.error("[Tokens] Partial markup is missing expected elements; aborting init.");
    return;
  }

  lists = {
    windows: buildWindowsList(els.windowsHost),
    models: buildModelsList(els.modelsHost),
    daily: buildDailyList(els.dailyHost),
    sources: buildSourcesList(els.sourcesHost),
  };

  els.tabs.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedWindow = btn.dataset.window;
      els.tabs
        .querySelectorAll(".filter-btn")
        .forEach((other) => other.classList.toggle("active", other === btn));
      lists.models?.update(modelRows());
    });
  });

  // The global cost modal lives in index.html; hide the button if absent.
  if (typeof window.openCostModal === "function") {
    els.openModalBtn.addEventListener("click", () => window.openCostModal());
  } else {
    els.openModalBtn.style.display = "none";
  }

  pollTimer = setInterval(() => {
    if (!els.root.isConnected) {
      teardown();
      return;
    }
    if (document.hidden) return;
    load(els);
  }, POLL_MS);

  load(els);
}
