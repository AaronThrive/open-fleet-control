/**
 * Tokens & Cost view module.
 *
 * Loaded by views.js via dynamic import; `init(containerEl)` runs on every
 * visit of #view-tokens and must be idempotent.
 *
 * Data source: GET /api/cost-breakdown →
 *   windows.{24h,3d,7d}: { totalCost, requests, monthlyProjected,
 *     tokens: {input, output, cacheRead, cacheWrite},
 *     byModel: [{ model, input, output, cacheRead, cacheWrite, requests,
 *                 cost, estCost, reportedCost }] }
 *
 * Cost honesty: rows whose cost came from provider usage records
 * (reportedCost > 0) get a REPORTED badge; locally computed ones get EST.
 *
 * Real-time: polling only (cost aggregation is not part of the SSE state
 * payload). All dynamic values via textContent — XSS-safe.
 */

import { t } from "../utils.js";

const POLL_MS = 60000;
const WINDOW_ORDER = ["24h", "3d", "7d"];
const WINDOW_LABELS = {
  "24h": "Last 24 hours",
  "3d": "Last 3 days",
  "7d": "Last 7 days",
};

let pollTimer = null;
let requestSeq = 0;
let currentData = null;
let selectedWindow = "24h";

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

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function buildWindowCard(key, windowData) {
  const card = el("div", "vital-card tokens-window-card");
  const header = el("div", "vital-header");
  header.appendChild(el("span", "vital-label", WINDOW_LABELS[key] || key));
  card.appendChild(header);

  card.appendChild(el("div", "tw-cost", formatCost(windowData.totalCost)));

  const tokens = windowData.tokens || {};
  const total =
    (tokens.input || 0) + (tokens.output || 0) + (tokens.cacheRead || 0) + (tokens.cacheWrite || 0);
  card.appendChild(
    el(
      "div",
      "tw-meta",
      `${formatTokens(total)} tokens • ${(windowData.requests || 0).toLocaleString()} requests`,
    ),
  );
  card.appendChild(
    el("div", "tw-meta", `in ${formatTokens(tokens.input)} / out ${formatTokens(tokens.output)}`),
  );

  const cacheMeta = el("div", "tw-meta");
  cacheMeta.appendChild(
    el("span", "tokens-cache-read", `cache read ${formatTokens(tokens.cacheRead)}`),
  );
  cacheMeta.appendChild(document.createTextNode(" • "));
  cacheMeta.appendChild(
    el("span", "tokens-cache-write", `cache write ${formatTokens(tokens.cacheWrite)}`),
  );
  card.appendChild(cacheMeta);

  if (Number.isFinite(windowData.monthlyProjected)) {
    card.appendChild(
      el(
        "div",
        "tw-meta",
        t(
          "views.tokens.monthlyProjected",
          { cost: formatCost(windowData.monthlyProjected) },
          "≈ {cost}/mo projected",
        ),
      ),
    );
  }
  return card;
}

function renderWindows(els, data) {
  const cards = [];
  for (const key of WINDOW_ORDER) {
    const windowData = data.windows?.[key];
    if (windowData) cards.push(buildWindowCard(key, windowData));
  }
  if (cards.length === 0) {
    const empty = el("div", "empty-state");
    empty.appendChild(el("div", "empty-state-icon", "🎫"));
    empty.appendChild(
      el("div", "empty-state-text", t("views.tokens.empty", {}, "No token usage recorded yet")),
    );
    els.windows.replaceChildren(empty);
    return;
  }
  els.windows.replaceChildren(...cards);
}

function renderModelTable(els) {
  const byModel = currentData?.windows?.[selectedWindow]?.byModel || [];
  if (byModel.length === 0) {
    const row = el("tr");
    const cell = el("td", "", t("views.tokens.noModelData", {}, "No model data for this window"));
    cell.colSpan = 7;
    cell.style.textAlign = "center";
    cell.style.color = "var(--text-muted)";
    row.appendChild(cell);
    els.modelRows.replaceChildren(row);
    return;
  }

  els.modelRows.replaceChildren(
    ...byModel.map((model) => {
      const row = el("tr");
      row.appendChild(el("td", "", model.model || "unknown"));
      row.appendChild(el("td", "", formatTokens(model.input)));
      row.appendChild(el("td", "", formatTokens(model.output)));
      row.appendChild(el("td", "tokens-cache-read", formatTokens(model.cacheRead)));
      row.appendChild(el("td", "tokens-cache-write", formatTokens(model.cacheWrite)));
      row.appendChild(el("td", "", (model.requests || 0).toLocaleString()));

      const costCell = el("td", "", formatCost(model.cost ?? model.estCost));
      const reported = Number(model.reportedCost) > 0;
      costCell.appendChild(
        el(
          "span",
          `cost-badge ${reported ? "reported" : "est"}`,
          reported
            ? t("views.tokens.badgeReported", {}, "reported")
            : t("views.tokens.badgeEst", {}, "est"),
        ),
      );
      row.appendChild(costCell);
      return row;
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Data loading                                                        */
/* ------------------------------------------------------------------ */

async function load(els) {
  const seq = ++requestSeq;
  try {
    const response = await fetch("/api/cost-breakdown");
    const payload = await response.json();
    if (seq !== requestSeq || !els.root.isConnected) return;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    els.error.hidden = true;
    currentData = payload;
    renderWindows(els, payload);
    renderModelTable(els);
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
}

/**
 * Initialize the Tokens view. Called by views.js on every visit.
 * @param {HTMLElement} container
 */
export function init(container) {
  teardown();
  selectedWindow = "24h";

  const els = {
    root: container.querySelector("#tokens-view-section"),
    error: container.querySelector("#tokens-view-error"),
    windows: container.querySelector("#tokens-windows"),
    tabs: container.querySelector("#tokens-window-tabs"),
    modelRows: container.querySelector("#tokens-model-rows"),
    openModalBtn: container.querySelector("#tokens-open-cost-modal"),
  };
  if (Object.values(els).some((node) => !node)) {
    console.error("[Tokens] Partial markup is missing expected elements; aborting init.");
    return;
  }

  els.tabs.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedWindow = btn.dataset.window;
      els.tabs
        .querySelectorAll(".filter-btn")
        .forEach((other) => other.classList.toggle("active", other === btn));
      renderModelTable(els);
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
