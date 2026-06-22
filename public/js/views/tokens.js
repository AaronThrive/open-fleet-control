/**
 * Tokens, Usage & Cost view module.
 *
 * Loaded by views.js via dynamic import; `init(containerEl)` runs on every
 * visit of #view-tokens and must be idempotent.
 *
 * This view is the single usage + cost tab. It absorbs the former "LLM Usage"
 * tab (fuel gauges + per-provider usage sections), and surfaces HONEST,
 * subscription-aware cost from the reworked /api/cost-breakdown.
 *
 * Data sources:
 *  - GET /api/cost-breakdown → honest, non-conflated cost fields. Top-level
 *      and per windows[k]:
 *        marginalCost / marginalMonthly       — REAL incremental spend (≈$0 on
 *                                                 OAuth/subscription usage)
 *        planCost / planName                   — flat monthly subscription
 *        actualMonthlySpend                    — plan + marginal
 *        hypotheticalCost / hypotheticalMonthly — "IF billed per-token" projection
 *      windows[k].byModel[]: { model, provider, billingMode, subscription(bool),
 *        input, output, cacheRead, cacheWrite, requests,
 *        marginalCost, hypotheticalCost }
 *      (Deprecated aliases totalCost/monthlyProjected still exist but are NOT used.)
 *  - GET /api/usage/sources?sinceMs&days → per-source adapters (9Router daily
 *      rollups + totals-by-source).
 *  - GET /api/llm-usage      → { claude, codex, routing, ...adapters } — fuel gauges.
 *  - GET /api/routing-stats  → { total_requests, by_model, avg_latency_ms }.
 *  - GET /api/usage/{subscription,claude-code,codex,nine-router,openrouter}
 *  - GET /api/fleet/budgets/status → budget burn-down gauges.
 *
 * Cost honesty: per-model rows are badged "subscription" ($0 marginal) vs
 * "per-token" (billed incrementally). The hypothetical column makes the
 * "if billed per-token" projection explicit so it is never mistaken for spend.
 *
 * Real-time: cost + sources poll on their own cadence; the fuel-gauge slice
 * also listens for the `fleet:state` window event (llmUsage). All dynamic
 * values via textContent — XSS-safe.
 */

import { t } from "../utils.js";
import { createDetailList } from "../components/detail-list.js";

const POLL_MS = 60000;
const LLM_POLL_MS = 30000;
const SOURCES_POLL_MS = 45000;
const SSE_FRESH_MS = 20000;
const DAY_MS = 86400000;
const DAILY_DAYS = 14;
const WINDOW_ORDER = ["24h", "3d", "7d", "30d"];
const WINDOW_LABELS = {
  "24h": "Last 24 hours",
  "3d": "Last 3 days",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

// Keys of /api/llm-usage handled by dedicated gauges / sections above;
// everything else is treated as an extra usage source and auto-rendered.
const KNOWN_KEYS = new Set([
  "timestamp",
  "source",
  "claude",
  "codex",
  "routing",
  "error",
  "errorType",
  "needsSync",
  "subscription",
  "headroom",
  "claudeCode",
  "claude-code",
  "nineRouter",
  "nine-router",
  "openrouter",
  "openRouter",
  "sources",
]);

let pollTimer = null;
let llmTimer = null;
let sourcesTimer = null;
let stateListener = null;
let requestSeq = 0;
let llmSeq = 0;
let sourcesSeq = 0;
let lastSseAt = 0;
let currentData = null;
let sourcesData = null;
let selectedWindow = "24h";
let selectedCostWindow = "24h";
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

function setText(els, key, value) {
  if (els[key]) els[key].textContent = value;
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
/* Honest cost summary                                                 */
/* ------------------------------------------------------------------ */

/**
 * Pure extractor of the honest cost fields for a given window (or the
 * top-level payload when no window slice exists). Exported for tests.
 *
 * Reads ONLY the honest, non-conflated fields — never the deprecated
 * totalCost / monthlyProjected aliases.
 */
export function costSummaryFrom(data, windowKey) {
  const win = data?.windows?.[windowKey];
  // Prefer the window slice for the per-window numbers; the plan is flat and
  // lives at the top level, so fall back there for plan fields.
  const src = win && typeof win === "object" ? win : {};
  const top = data && typeof data === "object" ? data : {};
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  return {
    marginalCost: num(src.marginalCost ?? top.marginalCost),
    marginalMonthly: num(src.marginalMonthly ?? top.marginalMonthly),
    planCost: num(src.planCost ?? top.planCost),
    planName: String(src.planName ?? top.planName ?? "").trim(),
    actualMonthlySpend: num(src.actualMonthlySpend ?? top.actualMonthlySpend),
    hypotheticalCost: num(src.hypotheticalCost ?? top.hypotheticalCost),
    hypotheticalMonthly: num(src.hypotheticalMonthly ?? top.hypotheticalMonthly),
  };
}

/**
 * Pure extractor of the per-plan flat-fee subscription lines for a window
 * (exported for tests). Reads windows[k].plans (the new per-plan breakdown),
 * falling back to the top-level `plans` array. Each line:
 *   { id, label, planCost, hypotheticalMonthly, marginalMonthly,
 *     actualMonthlySpend, requests }
 */
export function planLinesFrom(data, windowKey) {
  const win = data?.windows?.[windowKey];
  const source = Array.isArray(win?.plans)
    ? win.plans
    : Array.isArray(data?.plans)
      ? data.plans
      : [];
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  return source.map((plan) => ({
    id: String(plan.id ?? ""),
    label: String(plan.label ?? plan.id ?? "Subscription plan"),
    planCost: num(plan.planCost),
    hypotheticalMonthly: num(plan.hypotheticalMonthly ?? plan.hypotheticalCost),
    marginalMonthly: num(plan.marginalMonthly ?? plan.marginalCost),
    actualMonthlySpend: num(plan.actualMonthlySpend),
    requests: num(plan.requests),
  }));
}

function renderPlanLines(els) {
  if (!els.planLines || !els.planCards) return;
  const lines = planLinesFrom(currentData, selectedCostWindow);
  if (lines.length === 0) {
    els.planLines.hidden = true;
    els.planCards.replaceChildren();
    return;
  }
  els.planLines.hidden = false;
  const cards = lines.map((line) => {
    const card = el("div", "tokens-cost-card");
    card.appendChild(el("span", "tcc-label", line.label));
    card.appendChild(el("span", "tcc-value", formatCost(line.planCost)));
    // Same margin model Claude has: flat plan cost, ~$0 marginal, with the
    // hypothetical "if billed per-token" projection shown for context.
    const sub =
      line.marginalMonthly > 0
        ? t(
            "views.tokens.planLineMarginal",
            { amount: formatCost(line.marginalMonthly) },
            "+ {amount}/mo marginal",
          )
        : t("views.tokens.planLineFlat", {}, "flat fee — $0 marginal token cost");
    card.appendChild(el("span", "tcc-sub", sub));
    // hypotheticalMonthly is a RATE (cumulative / windowDays * 30), so label it
    // with its window basis so a front-loaded short window reading higher than a
    // longer one is self-explanatory.
    const windowLabel = WINDOW_LABELS[selectedCostWindow] || selectedCostWindow;
    card.appendChild(
      el(
        "span",
        "tcc-sub",
        t(
          "views.tokens.planLineHypothetical",
          { amount: formatCost(line.hypotheticalMonthly), window: windowLabel },
          "≈ {amount}/mo if billed per-token, at the {window} burn rate",
        ),
      ),
    );
    return card;
  });
  els.planCards.replaceChildren(...cards);
}

function renderCostSummary(els) {
  const s = costSummaryFrom(currentData, selectedCostWindow);
  // Marginal: real incremental spend in the window + its monthly equivalent.
  setText(els, "marginal", formatCost(s.marginalCost));
  setText(
    els,
    "marginalSub",
    s.marginalMonthly > 0
      ? t(
          "views.tokens.marginalSubMonthly",
          { amount: formatCost(s.marginalMonthly) },
          "≈ {amount}/mo of real per-token spend",
        )
      : t(
          "views.tokens.marginalSubZero",
          {},
          "$0 — usage is covered by your OAuth / subscription plan",
        ),
  );

  // Flat plan: never summed into marginal.
  setText(els, "plan", formatCost(s.planCost));
  setText(
    els,
    "planName",
    s.planName || t("views.tokens.planNameUnknown", {}, "No flat subscription plan configured"),
  );

  // Actual monthly = plan + marginal.
  setText(els, "actualMonthly", formatCost(s.actualMonthlySpend));

  // Hypothetical "if billed per-token" — explicitly NOT spend. The PRIMARY
  // figure is the CUMULATIVE cost over the selected window (monotonic: a 30d
  // window always >= a 7d window). The monthly figure is a RATE projection
  // (cumulative / windowDays * 30), so a front-loaded week can read higher
  // per-month than a quieter month — we label it as a rate with its basis so
  // 7d > 30d is self-explanatory rather than looking like a bug.
  setText(els, "hypothetical", formatCost(s.hypotheticalCost));
  const windowLabel = WINDOW_LABELS[selectedCostWindow] || selectedCostWindow;
  setText(
    els,
    "hypotheticalSub",
    s.hypotheticalMonthly > 0
      ? t(
          "views.tokens.hypotheticalRateSub",
          { amount: formatCost(s.hypotheticalMonthly), window: windowLabel },
          "≈ {amount}/mo at the {window} burn rate — projection, NOT money spent",
        )
      : t("views.tokens.hypotheticalSubZero", {}, "Projection only — NOT money you are spending"),
  );

  // Per-plan flat-fee subscription lines (Claude + Codex, each its own line).
  renderPlanLines(els);
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
      // Honest fields only — marginal is the real spend, hypothetical is the
      // "if billed per-token" projection. Never the deprecated totalCost.
      marginal: Number(windowData.marginalCost) || 0,
      hypothetical: Number(windowData.hypotheticalCost) || 0,
      tokens:
        (Number(tokens.input) || 0) +
        (Number(tokens.output) || 0) +
        (Number(tokens.cacheRead) || 0) +
        (Number(tokens.cacheWrite) || 0),
      requests: Number(windowData.requests) || 0,
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
        key: "marginal",
        label: t("views.tokens.colMarginal", {}, "Marginal (real)"),
        sortable: true,
        render: (row) => el("span", "", formatCost(row.marginal)),
      },
      {
        key: "hypothetical",
        label: t("views.tokens.colHypothetical", {}, "If per-token"),
        sortable: true,
        render: (row) => {
          const wrap = el("span", "", `≈ ${formatCost(row.hypothetical)}`);
          wrap.appendChild(
            el(
              "span",
              "cost-badge per-token",
              t("views.tokens.badgeHypothetical", {}, "hypothetical"),
            ),
          );
          return wrap;
        },
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

/** Pure row builder over a window's byModel[] (exported for tests). */
export function modelRowsFrom(data, windowKey) {
  const byModel = data?.windows?.[windowKey]?.byModel || [];
  return byModel.map((model) => {
    // `subscription` is the authoritative honesty flag; fall back to
    // billingMode / zero-marginal when the bool is absent.
    const marginal = Number(model.marginalCost) || 0;
    const isSubscription =
      typeof model.subscription === "boolean"
        ? model.subscription
        : model.billingMode === "subscription" || marginal === 0;
    return {
      model: model.model || "unknown",
      provider: model.provider || "",
      billingMode: model.billingMode || (isSubscription ? "subscription" : "per-token"),
      subscription: isSubscription,
      input: Number(model.input) || 0,
      output: Number(model.output) || 0,
      cacheRead: Number(model.cacheRead) || 0,
      cacheWrite: Number(model.cacheWrite) || 0,
      requests: Number(model.requests) || 0,
      marginalCost: marginal,
      hypotheticalCost: Number(model.hypotheticalCost) || 0,
    };
  });
}

function modelRows() {
  return modelRowsFrom(currentData, selectedWindow);
}

function billingCell(row) {
  const wrap = el("span", "");
  const sub = row.subscription;
  wrap.appendChild(
    el(
      "span",
      `cost-badge ${sub ? "subscription" : "per-token"}`,
      sub
        ? t("views.tokens.badgeSubscription", {}, "subscription")
        : t("views.tokens.badgePerToken", {}, "per-token"),
    ),
  );
  return wrap;
}

function marginalCell(row) {
  return el("span", "", formatCost(row.marginalCost));
}

function hypotheticalCell(row) {
  return el("span", "", `≈ ${formatCost(row.hypotheticalCost)}`);
}

function buildModelsList(host) {
  const tokensCell = (key, className) => (row) =>
    el("span", className || "", formatTokens(row[key]));
  return createDetailList(host, {
    columns: [
      { key: "model", label: t("views.tokens.colModel", {}, "Model"), sortable: true },
      {
        key: "subscription",
        label: t("views.tokens.colBilling", {}, "Billing"),
        sortable: true,
        render: billingCell,
      },
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
        key: "marginalCost",
        label: t("views.tokens.colMarginal", {}, "Marginal (real)"),
        sortable: true,
        render: marginalCell,
      },
      {
        key: "hypotheticalCost",
        label: t("views.tokens.colHypothetical", {}, "If per-token"),
        sortable: true,
        render: hypotheticalCell,
      },
    ],
    getRowId: (row) => row.model,
    renderDetail: (row) =>
      detailGrid([
        [t("views.tokens.detailProvider", {}, "Provider"), row.provider || "—"],
        [t("views.tokens.detailBilling", {}, "Billing mode"), row.billingMode],
        [
          t("views.tokens.detailMarginal", {}, "Marginal (real) cost"),
          formatCost(row.marginalCost),
        ],
        [
          t("views.tokens.detailHypothetical", {}, "Hypothetical (if per-token)"),
          formatCost(row.hypotheticalCost),
        ],
        [
          t("views.tokens.detailTotalTokens", {}, "Total tokens"),
          formatTokens(row.input + row.output + row.cacheRead + row.cacheWrite),
        ],
      ]),
    emptyText: t("views.tokens.noModelData", {}, "No model data for this window"),
    filterKeys: ["model", "provider"],
    filterPlaceholder: t("views.tokens.filterModels", {}, "Filter models…"),
    defaultSort: { key: "hypotheticalCost", dir: "desc" },
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

  // Headroom is a PLAN-QUOTA observation (the operator's Claude plan-limit
  // utilization), NOT a per-token spend source. Its raw token figure is a
  // weighted quota count that is not comparable to the other rows' token totals
  // and must never be summed as cost — so we keep the row for visibility but
  // null the tokens/cost columns and label it as a quota observation in the
  // note. The actual numbers live in the "Claude / Codex Plan Usage" rings.
  const headroom = src.headroom;
  const headroomRaw = headroom?.available ? Number(headroom.windowTokens?.totalRaw) || 0 : null;
  rows.push({
    id: "headroom",
    source: "Headroom (plan quota)",
    status: headroom?.available ? (headroom.stale ? "stale" : "available") : "unavailable",
    tokens: null,
    requests: null,
    cost: null,
    costKind: null,
    note:
      headroom?.reason ||
      (headroomRaw !== null
        ? `plan-quota observation — ${formatTokens(headroomRaw)} weighted tokens (see plan-usage rings; not a token cost)`
        : "plan-quota observation (see Claude / Codex Plan Usage rings)"),
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

/* ================================================================== */
/* LLM Usage fuel gauges (folded in from the former LLM Usage tab)     */
/* These render against the SAME data sources the LLM Usage view used: */
/*   /api/llm-usage, /api/routing-stats, and the /api/usage/* + budget */
/*   endpoints. Logic is replicated (not imported) so the llm-usage    */
/*   files remain untouched.                                           */
/* ================================================================== */

function fmtNum(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${n}`;
}

function fmtUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `$${n.toFixed(2)}`;
}

function fmtCountdown(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return "-";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtAgo(iso) {
  if (!iso) return "-";
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "-";
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

async function fetchSource(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function renderUsage(els, data) {
  if (!data) return;

  // The 3 Claude plan-limit gauges that read `openclaw status --usage` (which
  // 403s on the missing user:profile scope and rendered a fake 0%) were
  // RETIRED. The honest Claude/Codex plan-limit figures now come from the
  // Headroom rings (renderSubscription). So the anthropic auth error is no
  // longer a blocking banner here — keep the banner only when the whole
  // llm-usage payload is an auth error AND no honest source exists.
  els.auth.hidden = true;

  if (data.source === "live") {
    setText(els, "syncTime", "Live");
  } else if (data.claude?.lastSynced) {
    const ago = Math.round((Date.now() - new Date(data.claude.lastSynced)) / 60000);
    setText(els, "syncTime", ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`);
  } else if (data.error) {
    setText(els, "syncTime", data.needsSync ? "Needs sync" : "Error");
  }

  // Codex (5h + daily plan-limit utilization — both live). The old "tasks
  // today" sub-stat was a hardcoded 0 and has been dropped from the markup.
  const codex5h = data.codex?.usage5hPct || 0;
  setText(els, "codex5hPct", `${codex5h}%`);
  if (els.codex5hBar) {
    els.codex5hBar.style.width = `${Math.min(100, codex5h)}%`;
    els.codex5hBar.className =
      "vital-bar-fill " + (codex5h > 80 ? "red" : codex5h > 50 ? "yellow" : "blue");
  }
  setText(els, "codexDayPct", `${data.codex?.usageDayPct || 0}%`);

  // Routing summary
  if (data.routing) {
    const claudeTasks = data.routing.claudeTasks || 0;
    const codexTasks = data.routing.codexTasks || 0;
    const total = data.routing.total || 0;
    setText(
      els,
      "routingSummary",
      total > 0
        ? `${claudeTasks} Claude / ${codexTasks} Codex (${total} tasks)`
        : t("views.llmUsage.noTasks", {}, "No coding tasks yet"),
    );
    setText(els, "claudeTasks", claudeTasks);
    setText(els, "codexTaskCount", codexTasks);

    const codexPct = data.routing.codexPct || 0;
    const codexFloor = data.routing.codexFloor || 20;
    if (els.codexFloor) {
      if (total === 0) {
        els.codexFloor.className = "pressure-indicator";
        els.codexFloor.textContent = `Codex ≥${codexFloor}%: No tasks yet`;
      } else if (codexPct >= codexFloor) {
        els.codexFloor.className = "pressure-indicator normal";
        els.codexFloor.textContent = `Codex ≥${codexFloor}%: ✓ ${codexPct}%`;
      } else {
        els.codexFloor.className = "pressure-indicator warning";
        els.codexFloor.textContent = `Codex ≥${codexFloor}%: ${codexPct}% (need more)`;
      }
    }
  }

  renderExtraSources(els, data);
}

function renderExtraSources(els, data) {
  const cards = [];
  for (const [key, value] of Object.entries(data || {})) {
    if (KNOWN_KEYS.has(key)) continue;
    if (value === null || value === undefined) continue;

    const card = el("div", "vital-card llm-extra-card");
    const header = el("div", "vital-header");
    header.appendChild(el("span", "vital-label", `🔌 ${key}`));
    card.appendChild(header);

    if (typeof value !== "object") {
      const row = el("div", "llm-extra-row");
      row.appendChild(el("span", "", "value"));
      row.appendChild(el("span", "value", String(value)));
      card.appendChild(row);
    } else {
      const entries = Object.entries(value).slice(0, 10);
      const pctEntry = entries.find(
        ([k, v]) => /pct|percent/i.test(k) && Number.isFinite(Number(v)),
      );
      if (pctEntry) {
        const used = Math.min(100, Math.max(0, Number(pctEntry[1])));
        const barWrap = el("div", "vital-bar");
        const bar = el(
          "div",
          "vital-bar-fill " + (used > 80 ? "red" : used > 50 ? "yellow" : "green"),
        );
        bar.style.width = `${used}%`;
        barWrap.appendChild(bar);
        card.appendChild(barWrap);
      }
      for (const [innerKey, innerValue] of entries) {
        const row = el("div", "llm-extra-row");
        row.appendChild(el("span", "", innerKey));
        row.appendChild(
          el(
            "span",
            "value",
            typeof innerValue === "object" ? JSON.stringify(innerValue) : String(innerValue),
          ),
        );
        card.appendChild(row);
      }
    }
    cards.push(card);
  }
  if (els.extraSources) els.extraSources.replaceChildren(...cards);
}

/** A single "model · count" routing row (textContent only — XSS-safe). */
function routingModelRow(model, count) {
  const item = el("div", "vital-detail-item");
  item.appendChild(el("span", "vital-detail-value", (Number(count) || 0).toLocaleString()));
  item.appendChild(el("span", "vital-detail-label", model));
  return item;
}

function renderRoutingStats(els, stats) {
  if (!stats || stats.error) return;
  const total = stats.total_requests || 0;
  setText(els, "totalRouted", `${total} (24h)`);

  // Data-driven per-model routing: one row per key in by_model, sorted by
  // count desc. Replaces the old hardcoded Llama/Qwen rows. Shows a clear
  // "no routing data" note when the router has logged nothing.
  if (els.routingByModel) {
    const entries = Object.entries(stats.by_model || {})
      .map(([model, count]) => [model, Number(count) || 0])
      .sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
      els.routingByModel.replaceChildren();
      if (els.routingEmpty) {
        els.routingEmpty.hidden = false;
        els.routingEmpty.textContent = t(
          "views.tokens.noRoutingData",
          {},
          "No routing data — the llm_routing skill has not recorded any requests.",
        );
      }
    } else {
      if (els.routingEmpty) els.routingEmpty.hidden = true;
      els.routingByModel.replaceChildren(
        ...entries.map(([model, count]) => routingModelRow(model, count)),
      );
    }
  }

  if (els.routingLatency) {
    const avg = stats.avg_latency_ms || 0;
    if (avg > 0) {
      els.routingLatency.textContent = `Avg latency: ${(avg / 1000).toFixed(1)}s`;
      els.routingLatency.className = "pressure-indicator " + (avg > 30000 ? "warning" : "normal");
    } else {
      els.routingLatency.textContent = "Avg latency: -";
      els.routingLatency.className = "pressure-indicator";
    }
  }
}

/* ------------------------------------------------------------------ */
/* Dedicated usage-source sections                                     */
/* ------------------------------------------------------------------ */

function setRing(ringEl, pctEl, resetEl, slice) {
  const pct = Number(slice?.utilizationPct);
  const safe = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0;
  if (ringEl) {
    ringEl.style.setProperty("--pct", `${safe}`);
    ringEl.classList.toggle("crit", safe > 80);
    ringEl.classList.toggle("warn", safe > 50 && safe <= 80);
  }
  if (pctEl) pctEl.textContent = Number.isFinite(pct) ? `${pct}%` : "-%";
  if (resetEl) {
    const countdown = fmtCountdown(slice?.secondsToReset);
    resetEl.textContent =
      countdown === "-"
        ? t("views.llmUsage.noReset", {}, "no reset pending")
        : t("views.llmUsage.resetsIn", { time: countdown }, "resets in {time}");
  }
}

function renderSubscription(els, data) {
  if (!data || !els.subPanel) return;
  els.subPanel.hidden = false;

  if (data.available === false) {
    els.subStatus.hidden = false;
    els.subStatus.textContent = t(
      "views.llmUsage.subUnavailable",
      { reason: data.reason || "unknown" },
      "Subscription data unavailable: {reason}",
    );
    return;
  }
  els.subStatus.hidden = true;
  els.subStale.hidden = !data.stale;
  setText(els, "subPolled", data.polledAt ? `polled ${fmtAgo(data.polledAt)}` : "-");

  setRing(els.sub5hRing, els.sub5hPct, els.sub5hReset, data.fiveHour);
  setRing(els.sub7dRing, els.sub7dPct, els.sub7dReset, data.sevenDay);
  setRing(els.subSonnetRing, els.subSonnetPct, els.subSonnetReset, data.sevenDaySonnet);

  const extra = data.extraUsage || {};
  if (extra.isEnabled === false) {
    setText(els, "subExtraUsed", t("views.llmUsage.extraDisabled", {}, "disabled"));
    setText(els, "subExtraLimit", "-");
    setText(els, "subExtraPct", "-");
    if (els.subExtraBar) els.subExtraBar.style.width = "0%";
  } else {
    setText(els, "subExtraUsed", fmtUsd(extra.usedCreditsUsd));
    setText(
      els,
      "subExtraLimit",
      Number.isFinite(Number(extra.monthlyLimitUsd)) ? `${fmtUsd(extra.monthlyLimitUsd)}/mo` : "-",
    );
    const pct = Number(extra.utilizationPct);
    setText(els, "subExtraPct", Number.isFinite(pct) ? `${pct.toFixed(1)}%` : "-");
    if (els.subExtraBar) {
      const safe = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0;
      els.subExtraBar.style.width = `${safe}%`;
      els.subExtraBar.className =
        "vital-bar-fill " + (safe > 80 ? "red" : safe > 50 ? "yellow" : "green");
    }
  }

  const tokens = data.windowTokens || {};
  setText(els, "subTokInput", fmtNum(tokens.input));
  setText(els, "subTokOutput", fmtNum(tokens.output));
  setText(els, "subTokCacher", fmtNum(tokens.cacheReads));
  setText(els, "subTokCachew", fmtNum(tokens.cacheWritesTotal));
  setText(els, "subTokTotal", fmtNum(tokens.totalRaw));

  const models = Object.entries(data.byModel || {});
  els.subModelTable.hidden = models.length === 0;
  els.subModels.replaceChildren(
    ...models.map(([model, usage]) => {
      const row = el("tr");
      row.appendChild(el("td", "", model));
      row.appendChild(el("td", "", fmtNum(usage?.input)));
      row.appendChild(el("td", "", fmtNum(usage?.output)));
      row.appendChild(el("td", "", fmtNum(usage?.cacheReads)));
      row.appendChild(el("td", "", fmtNum(usage?.cacheWritesTotal)));
      return row;
    }),
  );
}

function renderClaudeCodeUsage(els, data) {
  if (!data || !els.ccPanel) return;
  els.ccPanel.hidden = false;

  if (data.available === false) {
    els.ccStatus.hidden = false;
    els.ccStatus.textContent = t(
      "views.llmUsage.ccUnavailable",
      { reason: data.reason || "unknown" },
      "Claude Code usage unavailable: {reason}",
    );
    return;
  }
  els.ccStatus.hidden = true;

  const liveCount = data.live?.count || 0;
  els.ccLive.hidden = liveCount === 0;
  els.ccLive.textContent = t("views.llmUsage.liveCount", { count: liveCount }, "● {count} live");
  const ttys = Array.isArray(data.live?.ttys) ? data.live.ttys : [];
  setText(els, "ccTtys", ttys.length > 0 ? ttys.join(", ") : "");

  const windows = data.windows || {};
  for (const [key, prefix] of [
    ["h24", "ccH24"],
    ["d3", "ccD3"],
    ["d7", "ccD7"],
  ]) {
    const win = windows[key] || {};
    const totalTokens =
      (win.input || 0) + (win.output || 0) + (win.cacheRead || 0) + (win.cacheWrite || 0);
    setText(els, `${prefix}Cost`, Number.isFinite(win.estCost) ? `~${fmtUsd(win.estCost)}` : "-");
    setText(els, `${prefix}Tokens`, fmtNum(totalTokens));
    setText(els, `${prefix}Req`, fmtNum(win.requests));
  }
}

function renderCodexActivity(els, data) {
  if (!data || !els.cxPanel) return;
  els.cxPanel.hidden = false;

  if (data.available === false) {
    els.cxStatus.hidden = false;
    els.cxStatus.textContent = t(
      "views.llmUsage.codexUnavailable",
      { reason: data.reason || "unknown" },
      "Codex activity unavailable: {reason}",
    );
    return;
  }
  els.cxStatus.hidden = true;

  const liveCount = data.live?.count || 0;
  els.cxLive.hidden = liveCount === 0;
  els.cxLive.textContent = t(
    "views.llmUsage.liveProcs",
    { count: liveCount },
    "● {count} processes",
  );
  setText(els, "cxProcs", `${liveCount}`);
  setText(els, "cxEntries", fmtNum(data.activity?.entries));
  setText(els, "cxSessions", fmtNum(data.activity?.sessions));
  setText(els, "cxLast", fmtAgo(data.activity?.lastAt));
}

function renderNineRouter(els, data) {
  if (!data || !els.nrPanel) return;
  els.nrPanel.hidden = false;

  if (data.available === false) {
    els.nrStatus.hidden = false;
    els.nrStatus.textContent = t(
      "views.llmUsage.nrUnavailable",
      { reason: data.reason || "unknown" },
      "Nine Router usage unavailable: {reason}",
    );
    els.nrEmpty.hidden = true;
    els.nrTable.hidden = true;
    return;
  }
  els.nrStatus.hidden = true;

  const usage = data.usage || {};
  const totals = usage.totals || {};
  setText(
    els,
    "nrTotals",
    `${fmtNum(totals.requests || 0)} req • ${fmtNum(totals.totalTokens || 0)} tok • ${fmtUsd(totals.cost || 0)}`,
  );

  const providers = Array.isArray(usage.byProvider) ? usage.byProvider : [];
  if (providers.length === 0) {
    els.nrEmpty.hidden = false;
    els.nrEmpty.textContent = t(
      "views.llmUsage.nrEmpty",
      {},
      "No routed traffic yet — the router has not logged any requests.",
    );
    els.nrTable.hidden = true;
    return;
  }
  els.nrEmpty.hidden = true;
  els.nrTable.hidden = false;
  els.nrBody.replaceChildren(
    ...providers.map((provider) => {
      const row = el("tr");
      row.appendChild(el("td", "", provider.provider || provider.name || "?"));
      row.appendChild(el("td", "", fmtNum(provider.requests)));
      row.appendChild(el("td", "", fmtNum(provider.totalTokens ?? provider.tokens)));
      row.appendChild(el("td", "", fmtUsd(provider.cost || 0)));
      return row;
    }),
  );
}

// Humanize a raw OpenRouter key into a readable chip label. Maps the known
// camelCase/snake_case keys to friendly names; falls back to splitting
// camelCase + snake_case so "totalCredits" never renders as "TOTALCREDITS".
const OPENROUTER_LABELS = {
  totalCredits: "Credits",
  totalUsage: "Total usage",
  remaining: "Remaining",
  usage: "Usage",
  limit: "Limit",
  limitRemaining: "Remaining",
  label: "Key label",
};
function humanizeOpenRouterKey(key) {
  if (OPENROUTER_LABELS[key]) return OPENROUTER_LABELS[key];
  const words = String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Build money/number chips from a flat {key:value} object (humanized labels). */
function openRouterChips(source) {
  const chips = [];
  for (const [key, value] of Object.entries(source || {})) {
    if (key === "available") continue;
    if (typeof value === "object" || typeof value === "boolean") continue;
    if (value === null || value === undefined) continue;
    const chip = el("div", "lvx-token-chip");
    const isMoney = /usd|cost|credit|spend|limit|usage|remaining/i.test(key);
    chip.appendChild(
      el(
        "span",
        "chip-value",
        isMoney && Number.isFinite(Number(value)) ? fmtUsd(value) : fmtNum(value),
      ),
    );
    chip.appendChild(el("span", "chip-label", humanizeOpenRouterKey(key)));
    chips.push(chip);
  }
  return chips;
}

function renderOpenRouter(els, data) {
  if (!data || !els.orPanel) return;
  els.orPanel.hidden = false;

  if (data.available === false) {
    els.orStatus.hidden = false;
    els.orStatus.textContent = t(
      "views.llmUsage.orUnavailable",
      { reason: data.reason || "unknown" },
      "OpenRouter unavailable: {reason} — add OPENROUTER_API_KEY to the server environment to enable credit tracking.",
    );
    els.orBody.hidden = true;
    return;
  }
  els.orStatus.hidden = true;
  els.orBody.hidden = false;

  // Account-wide credits: GET /api/v1/credits → total_credits / total_usage.
  // This is the WHOLE OpenRouter account balance, NOT this key's usage.
  const credits = data.credits && data.credits.available !== false ? data.credits : null;
  if (els.orCredits) {
    els.orCredits.replaceChildren(
      ...openRouterChips(
        credits
          ? {
              totalCredits: credits.totalCredits,
              totalUsage: credits.totalUsage,
              remaining: credits.remaining,
            }
          : {},
      ),
    );
  }

  // This specific key's metered usage: GET /api/v1/auth/key → usage / limit.
  const keyInfo = data.keyInfo && data.keyInfo.available !== false ? data.keyInfo : null;
  if (els.orKey) {
    els.orKey.replaceChildren(
      ...openRouterChips(
        keyInfo
          ? {
              usage: keyInfo.usage,
              limit: keyInfo.limit,
              limitRemaining: keyInfo.limitRemaining,
            }
          : {},
      ),
    );
  }
  if (els.orKeyNote) {
    if (keyInfo && keyInfo.limit === null) {
      els.orKeyNote.hidden = false;
      els.orKeyNote.textContent = t(
        "views.tokens.orKeyUnlimited",
        { label: keyInfo.label || "this key" },
        "{label}: no spend limit set on this key.",
      );
    } else {
      els.orKeyNote.hidden = true;
    }
  }
}

function buildBudgetGauge(scope, periodLabel, elapsedText) {
  const scopeName =
    scope.scope === "total"
      ? t("views.llmUsage.budgetTotal", {}, "Total")
      : String(scope.scope).replace(/^provider:/, "");
  const pct = Number(scope.percent);
  const safePct = Number.isFinite(pct) ? pct : 0;

  const card = el("div", "vital-card lvx-bg-card");
  const header = el("div", "vital-header");
  header.appendChild(el("span", "vital-label", `💰 ${scopeName} · ${periodLabel}`));
  header.appendChild(el("span", "vital-value", `${safePct}%`));
  card.appendChild(header);

  const barWrap = el("div", "vital-bar lvx-bg-bar");
  const color = scope.state === "critical" ? "red" : scope.state === "warn" ? "yellow" : "green";
  const fill = el("div", `vital-bar-fill ${color}`);
  fill.style.width = `${Math.min(100, Math.max(0, safePct))}%`;
  barWrap.appendChild(fill);
  barWrap.appendChild(el("div", "lvx-bg-marker"));
  card.appendChild(barWrap);

  const limit = Number(scope.limitUSD);
  const label = t(
    "views.llmUsage.budgetGauge",
    {
      spent: fmtUsd(scope.spentUSD),
      limit: Number.isInteger(limit) ? `$${limit}` : fmtUsd(limit),
      period: periodLabel,
      pct: safePct,
    },
    "{spent} / {limit} {period} ({pct}%)",
  );
  card.appendChild(el("div", "lvx-bg-text", `${label} — ${elapsedText}`));
  return card;
}

function renderBudgets(els, data) {
  const enabled = Boolean(data && data.enabled === true && data.periods);
  if (!els.bgPanel) return;
  els.bgPanel.hidden = !enabled;
  if (!enabled) return;

  const cards = [];
  for (const period of ["daily", "weekly"]) {
    const slice = data.periods[period];
    if (!slice || !Array.isArray(slice.scopes)) continue;
    const periodLabel =
      period === "daily"
        ? t("views.llmUsage.budgetDaily", {}, "daily")
        : t("views.llmUsage.budgetWeekly", {}, "weekly");
    let elapsedText =
      period === "daily"
        ? t("views.llmUsage.budgetDayElapsed", { pct: slice.elapsedPct }, "{pct}% of day elapsed")
        : t(
            "views.llmUsage.budgetWeekElapsed",
            { pct: slice.elapsedPct },
            "{pct}% of week elapsed",
          );
    if (slice.usageAvailable === false) {
      elapsedText += ` · ${t("views.llmUsage.budgetNoUsage", {}, "no usage data yet")}`;
    }
    for (const scope of slice.scopes) {
      cards.push(buildBudgetGauge(scope, periodLabel, elapsedText));
    }
  }
  els.bgGauges.replaceChildren(...cards);
}

async function loadLlmSources(els) {
  const seq = ++sourcesSeq;
  const [subscription, claudeCode, codex, nineRouter, openrouter, budgets] = await Promise.all([
    fetchSource("/api/usage/subscription"),
    fetchSource("/api/usage/claude-code"),
    fetchSource("/api/usage/codex"),
    fetchSource("/api/usage/nine-router"),
    fetchSource("/api/usage/openrouter"),
    fetchSource("/api/fleet/budgets/status"),
  ]);
  if (seq !== sourcesSeq || !els.root.isConnected) return;

  const renders = [
    () => renderBudgets(els, budgets),
    () => renderSubscription(els, subscription),
    () => renderClaudeCodeUsage(els, claudeCode),
    () => renderCodexActivity(els, codex),
    () => renderNineRouter(els, nineRouter),
    () => renderOpenRouter(els, openrouter),
  ];
  for (const render of renders) {
    try {
      render();
    } catch (error) {
      console.error("[Tokens] LLM source section render failed:", error);
    }
  }
}

async function loadLlm(els) {
  const seq = ++llmSeq;
  try {
    const [usage, routing] = await Promise.all([
      fetch("/api/llm-usage").then((response) => response.json()),
      fetch("/api/routing-stats?hours=24")
        .then((response) => response.json())
        .catch(() => null),
    ]);
    if (seq !== llmSeq || !els.root.isConnected) return;
    renderUsage(els, usage);
    renderRoutingStats(els, routing);
  } catch (error) {
    // The LLM fuel-gauge slice is best-effort; the cost API drives the main
    // error banner. Keep gauges at their placeholders on failure.
    console.error("[Tokens] LLM usage fetch failed:", error);
  }
}

/* ------------------------------------------------------------------ */
/* Cost + sources data loading                                         */
/* ------------------------------------------------------------------ */

function render(els) {
  renderCostSummary(els);
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
  for (const timer of [pollTimer, llmTimer, sourcesTimer]) {
    if (timer) clearInterval(timer);
  }
  pollTimer = null;
  llmTimer = null;
  sourcesTimer = null;
  if (stateListener) {
    window.removeEventListener("fleet:state", stateListener);
    stateListener = null;
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
  selectedCostWindow = "24h";
  currentData = null;
  sourcesData = null;
  lastSseAt = 0;

  const els = {
    root: container.querySelector("#tokens-view-section"),
    error: container.querySelector("#tokens-view-error"),
    auth: container.querySelector("#tokens-view-auth"),
    // Cost summary
    costWindowTabs: container.querySelector("#tokens-cost-window-tabs"),
    marginal: container.querySelector("#tokens-marginal"),
    marginalSub: container.querySelector("#tokens-marginal-sub"),
    plan: container.querySelector("#tokens-plan"),
    planName: container.querySelector("#tokens-plan-name"),
    actualMonthly: container.querySelector("#tokens-actual-monthly"),
    hypothetical: container.querySelector("#tokens-hypothetical"),
    hypotheticalSub: container.querySelector("#tokens-hypothetical-sub"),
    planLines: container.querySelector("#tokens-plan-lines"),
    planCards: container.querySelector("#tokens-plan-cards"),
    // Token breakdown lists
    windowsHost: container.querySelector("#tokens-windows-list"),
    tabs: container.querySelector("#tokens-window-tabs"),
    modelsHost: container.querySelector("#tokens-models-list"),
    dailyHost: container.querySelector("#tokens-daily-list"),
    dailyNote: container.querySelector("#tokens-daily-note"),
    sourcesHost: container.querySelector("#tokens-sources-list"),
    openModalBtn: container.querySelector("#tokens-open-cost-modal"),
    // ---- LLM fuel gauges (folded in) ----
    syncTime: container.querySelector("#lv-sync-time"),
    routingSummary: container.querySelector("#lv-routing-summary"),
    // (Retired Claude plan-limit gauges removed — see renderUsage note.)
    codex5hPct: container.querySelector("#lv-codex-5h-pct"),
    codex5hBar: container.querySelector("#lv-codex-5h-bar"),
    codexDayPct: container.querySelector("#lv-codex-day-pct"),
    totalRouted: container.querySelector("#lv-total-routed"),
    claudeTasks: container.querySelector("#lv-claude-tasks"),
    codexTaskCount: container.querySelector("#lv-codex-task-count"),
    routingByModel: container.querySelector("#lv-routing-by-model"),
    routingEmpty: container.querySelector("#lv-routing-empty"),
    routingLatency: container.querySelector("#lv-routing-latency"),
    codexFloor: container.querySelector("#lv-codex-floor"),
    extraSources: container.querySelector("#lv-extra-sources"),
    // Budget burn-down gauges
    bgPanel: container.querySelector("#lvx-bg-panel"),
    bgGauges: container.querySelector("#lvx-bg-gauges"),
    // Claude Max subscription
    subPanel: container.querySelector("#lvx-sub-panel"),
    subStatus: container.querySelector("#lvx-sub-status"),
    subStale: container.querySelector("#lvx-sub-stale"),
    subPolled: container.querySelector("#lvx-sub-polled"),
    sub5hRing: container.querySelector("#lvx-sub-5h-ring"),
    sub5hPct: container.querySelector("#lvx-sub-5h-pct"),
    sub5hReset: container.querySelector("#lvx-sub-5h-reset"),
    sub7dRing: container.querySelector("#lvx-sub-7d-ring"),
    sub7dPct: container.querySelector("#lvx-sub-7d-pct"),
    sub7dReset: container.querySelector("#lvx-sub-7d-reset"),
    subSonnetRing: container.querySelector("#lvx-sub-sonnet-ring"),
    subSonnetPct: container.querySelector("#lvx-sub-sonnet-pct"),
    subSonnetReset: container.querySelector("#lvx-sub-sonnet-reset"),
    subExtraUsed: container.querySelector("#lvx-sub-extra-used"),
    subExtraLimit: container.querySelector("#lvx-sub-extra-limit"),
    subExtraPct: container.querySelector("#lvx-sub-extra-pct"),
    subExtraBar: container.querySelector("#lvx-sub-extra-bar"),
    subTokInput: container.querySelector("#lvx-sub-tok-input"),
    subTokOutput: container.querySelector("#lvx-sub-tok-output"),
    subTokCacher: container.querySelector("#lvx-sub-tok-cacher"),
    subTokCachew: container.querySelector("#lvx-sub-tok-cachew"),
    subTokTotal: container.querySelector("#lvx-sub-tok-total"),
    subModelTable: container.querySelector("#lvx-sub-model-table"),
    subModels: container.querySelector("#lvx-sub-models"),
    // Terminal sessions (Claude Code)
    ccPanel: container.querySelector("#lvx-cc-panel"),
    ccStatus: container.querySelector("#lvx-cc-status"),
    ccLive: container.querySelector("#lvx-cc-live"),
    ccTtys: container.querySelector("#lvx-cc-ttys"),
    ccH24Cost: container.querySelector("#lvx-cc-h24-cost"),
    ccH24Tokens: container.querySelector("#lvx-cc-h24-tokens"),
    ccH24Req: container.querySelector("#lvx-cc-h24-req"),
    ccD3Cost: container.querySelector("#lvx-cc-d3-cost"),
    ccD3Tokens: container.querySelector("#lvx-cc-d3-tokens"),
    ccD3Req: container.querySelector("#lvx-cc-d3-req"),
    ccD7Cost: container.querySelector("#lvx-cc-d7-cost"),
    ccD7Tokens: container.querySelector("#lvx-cc-d7-tokens"),
    ccD7Req: container.querySelector("#lvx-cc-d7-req"),
    // Codex activity
    cxPanel: container.querySelector("#lvx-cx-panel"),
    cxStatus: container.querySelector("#lvx-cx-status"),
    cxLive: container.querySelector("#lvx-cx-live"),
    cxProcs: container.querySelector("#lvx-cx-procs"),
    cxEntries: container.querySelector("#lvx-cx-entries"),
    cxSessions: container.querySelector("#lvx-cx-sessions"),
    cxLast: container.querySelector("#lvx-cx-last"),
    // Nine Router
    nrPanel: container.querySelector("#lvx-nr-panel"),
    nrStatus: container.querySelector("#lvx-nr-status"),
    nrTotals: container.querySelector("#lvx-nr-totals"),
    nrEmpty: container.querySelector("#lvx-nr-empty"),
    nrTable: container.querySelector("#lvx-nr-table"),
    nrBody: container.querySelector("#lvx-nr-body"),
    // OpenRouter
    orPanel: container.querySelector("#lvx-or-panel"),
    orStatus: container.querySelector("#lvx-or-status"),
    orBody: container.querySelector("#lvx-or-body"),
    orCredits: container.querySelector("#lvx-or-credits"),
    orKey: container.querySelector("#lvx-or-key"),
    orKeyNote: container.querySelector("#lvx-or-key-note"),
  };

  // Only the core cost-tab elements are strictly required. The folded-in
  // fuel-gauge nodes are guarded individually in their render functions so a
  // partial markup mismatch never blanks the whole tab.
  const required = [
    "root",
    "error",
    "windowsHost",
    "tabs",
    "modelsHost",
    "dailyHost",
    "dailyNote",
    "sourcesHost",
  ];
  if (required.some((key) => !els[key])) {
    console.error("[Tokens] Partial markup is missing expected elements; aborting init.");
    return;
  }

  lists = {
    windows: buildWindowsList(els.windowsHost),
    models: buildModelsList(els.modelsHost),
    daily: buildDailyList(els.dailyHost),
    sources: buildSourcesList(els.sourcesHost),
  };

  // Cost-summary window selector.
  if (els.costWindowTabs) {
    els.costWindowTabs.querySelectorAll(".filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedCostWindow = btn.dataset.window;
        els.costWindowTabs
          .querySelectorAll(".filter-btn")
          .forEach((other) => other.classList.toggle("active", other === btn));
        renderCostSummary(els);
      });
    });
  }

  // Per-model window selector.
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
  if (els.openModalBtn) {
    if (typeof window.openCostModal === "function") {
      els.openModalBtn.addEventListener("click", () => window.openCostModal());
    } else {
      els.openModalBtn.style.display = "none";
    }
  }

  // The fuel-gauge slice also arrives via the shared SSE state event.
  stateListener = (event) => {
    if (!els.root.isConnected) {
      teardown();
      return;
    }
    lastSseAt = Date.now();
    if (event.detail?.llmUsage) {
      renderUsage(els, event.detail.llmUsage);
    }
  };
  window.addEventListener("fleet:state", stateListener);

  // Cost + 9Router-sources poll (drives the main tab + error banner).
  pollTimer = setInterval(() => {
    if (!els.root.isConnected) {
      teardown();
      return;
    }
    if (document.hidden) return;
    load(els);
  }, POLL_MS);

  // Fuel-gauge poll (skips when a fresh SSE frame just arrived).
  llmTimer = setInterval(() => {
    if (!els.root.isConnected) {
      teardown();
      return;
    }
    if (document.hidden) return;
    if (Date.now() - lastSseAt < SSE_FRESH_MS) return;
    loadLlm(els);
  }, LLM_POLL_MS);

  // Dedicated usage-source sections poll on their own cadence.
  sourcesTimer = setInterval(() => {
    if (!els.root.isConnected) {
      teardown();
      return;
    }
    if (document.hidden) return;
    loadLlmSources(els);
  }, SOURCES_POLL_MS);

  load(els);
  loadLlm(els);
  loadLlmSources(els);
}
