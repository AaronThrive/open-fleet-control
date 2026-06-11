/**
 * LLM Usage (fuel gauges) view module.
 *
 * Loaded by views.js via dynamic import; `init(containerEl)` runs on every
 * visit of #view-llm-usage and must be idempotent.
 *
 * Data sources:
 *  - GET /api/llm-usage     → { claude: {session, weekly, sonnet}, codex,
 *                               routing, ...future adapter keys }
 *  - GET /api/routing-stats → { total_requests, by_model, avg_latency_ms }
 *
 * Unknown top-level keys in /api/llm-usage (e.g. headroom, nine-router,
 * openrouter adapters built in parallel) are rendered as generic cards and
 * never break the view when absent or oddly shaped.
 *
 * Real-time: listens for the `fleet:state` window event (llmUsage slice) with
 * a polling fallback. All dynamic values via textContent — XSS-safe.
 */

import { t } from "../utils.js";

const POLL_MS = 30000;
const SOURCES_POLL_MS = 45000;
const SSE_FRESH_MS = 20000;

// Keys of /api/llm-usage handled by the dedicated gauges above (or by the
// dedicated source sections below); everything else is treated as an extra
// usage source and auto-rendered as a generic card.
const KNOWN_KEYS = new Set([
  "timestamp",
  "source",
  "claude",
  "codex",
  "routing",
  "error",
  "errorType",
  "needsSync",
  // Sources with dedicated sections — never double-render generically.
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
let sourcesTimer = null;
let stateListener = null;
let requestSeq = 0;
let sourcesSeq = 0;
let lastSseAt = 0;

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

function setGauge(els, prefix, usedPct, remainingPct, reset) {
  const used = Number.isFinite(usedPct) ? usedPct : 0;
  setText(els, `${prefix}Pct`, `${used}%`);
  setText(
    els,
    `${prefix}Remaining`,
    `${Number.isFinite(remainingPct) ? remainingPct : 100 - used}%`,
  );
  setText(els, `${prefix}Reset`, reset || "-");
  const bar = els[`${prefix}Bar`];
  if (bar) {
    bar.style.width = `${Math.min(100, Math.max(0, used))}%`;
    bar.className = "vital-bar-fill " + (used > 80 ? "red" : used > 50 ? "yellow" : "green");
  }
}

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

/**
 * Fetch a usage-source endpoint. Returns the parsed body, or null when the
 * endpoint is absent (older deployment), unreachable, or not JSON — callers
 * keep their section hidden in that case so one source never blanks the page.
 */
async function fetchSource(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderUsage(els, data) {
  if (!data) return;

  const authError = data.errorType === "auth" || data.claude?.session?.error;
  els.auth.hidden = !authError;
  if (authError) {
    for (const prefix of ["claudeSession", "claudeWeekly", "sonnetWeekly"]) {
      setText(els, `${prefix}Pct`, "N/A");
      setText(els, `${prefix}Remaining`, "N/A");
      setText(els, `${prefix}Reset`, "-");
      if (els[`${prefix}Bar`]) els[`${prefix}Bar`].style.width = "0%";
    }
  }

  if (data.claude?.lastSynced) {
    const ago = Math.round((Date.now() - new Date(data.claude.lastSynced)) / 60000);
    setText(els, "syncTime", ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`);
  } else if (data.source === "live") {
    setText(els, "syncTime", "Live");
  } else if (data.error) {
    setText(els, "syncTime", data.needsSync ? "Needs sync" : "Error");
  }

  if (!authError) {
    setGauge(
      els,
      "claudeSession",
      data.claude?.session?.usedPct,
      data.claude?.session?.remainingPct,
      data.claude?.session?.resetsIn,
    );
    setGauge(
      els,
      "claudeWeekly",
      data.claude?.weekly?.usedPct,
      data.claude?.weekly?.remainingPct,
      data.claude?.weekly?.resets,
    );
    setGauge(
      els,
      "sonnetWeekly",
      data.claude?.sonnet?.usedPct,
      data.claude?.sonnet?.remainingPct,
      data.claude?.sonnet?.resets,
    );
  }

  // Codex
  const codex5h = data.codex?.usage5hPct || 0;
  setText(els, "codex5hPct", `${codex5h}%`);
  if (els.codex5hBar) {
    els.codex5hBar.style.width = `${Math.min(100, codex5h)}%`;
    els.codex5hBar.className =
      "vital-bar-fill " + (codex5h > 80 ? "red" : codex5h > 50 ? "yellow" : "blue");
  }
  setText(els, "codexDayPct", `${data.codex?.usageDayPct || 0}%`);
  setText(els, "codexTasks", data.codex?.tasksToday ?? "-");

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

/**
 * Render any unknown top-level usage sources (future adapters: headroom,
 * nine-router, openrouter, ...) as generic key/value cards.
 */
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
      // Percent-shaped fields get a bar for at-a-glance reading
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
  els.extraSources.replaceChildren(...cards);
}

function renderRoutingStats(els, stats) {
  if (!stats || stats.error) return;
  const total = stats.total_requests || 0;
  setText(els, "totalRouted", `${total} (24h)`);

  let llama = 0;
  let qwen = 0;
  for (const [model, count] of Object.entries(stats.by_model || {})) {
    const name = model.toLowerCase();
    if (name.includes("llama")) llama += count;
    else if (name.includes("qwen")) qwen += count;
  }
  setText(els, "llamaTasks", llama);
  setText(els, "qwenTasks", qwen);

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
  if (!data) return; // endpoint absent → keep panel hidden
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
  if (!data) return;
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
  if (!data) return;
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
  if (!data) return;
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

function renderOpenRouter(els, data) {
  if (!data) return;
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

  // Render whatever numeric credit/usage fields the adapter exposes.
  const source = data.credits || data.usage || data;
  const chips = [];
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "object" || typeof value === "boolean") continue;
    const chip = el("div", "lvx-token-chip");
    const isMoney = /usd|cost|credit|spend|limit/i.test(key);
    chip.appendChild(
      el(
        "span",
        "chip-value",
        isMoney && Number.isFinite(Number(value)) ? fmtUsd(value) : fmtNum(value),
      ),
    );
    chip.appendChild(el("span", "chip-label", key));
    chips.push(chip);
  }
  els.orBody.replaceChildren(...chips);
}

/**
 * One budget burn-down gauge card: horizontal fill = % of budget spent,
 * fixed marker at the 80% warn threshold, color shifts ok→warn→critical
 * with the evaluator's state. All values via textContent — XSS-safe.
 */
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
  barWrap.appendChild(el("div", "lvx-bg-marker")); // 80% warn threshold
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

/**
 * Render the Budgets section from /api/fleet/budgets/status. The panel is
 * hidden entirely when budgets are disabled/unconfigured ({ enabled:false })
 * or when the endpoint is absent (older deployment → null).
 */
function renderBudgets(els, data) {
  const enabled = Boolean(data && data.enabled === true && data.periods);
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

/**
 * Fetch + render the dedicated usage-source sections. Each endpoint is
 * fetched independently and each render is try/caught so a single failing
 * source never blanks the rest of the page.
 */
async function loadSources(els) {
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
      console.error("[LLM Usage] Source section render failed:", error);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Data loading                                                        */
/* ------------------------------------------------------------------ */

async function load(els) {
  const seq = ++requestSeq;
  try {
    const [usage, routing] = await Promise.all([
      fetch("/api/llm-usage").then((response) => response.json()),
      fetch("/api/routing-stats?hours=24")
        .then((response) => response.json())
        .catch(() => null),
    ]);
    if (seq !== requestSeq || !els.root.isConnected) return;
    els.error.hidden = true;
    renderUsage(els, usage);
    renderRoutingStats(els, routing);
  } catch (error) {
    if (seq !== requestSeq || !els.root.isConnected) return;
    els.error.hidden = false;
    els.error.textContent = t(
      "views.llmUsage.loadError",
      {},
      "Could not reach the LLM usage API — is the server up?",
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
  if (sourcesTimer) {
    clearInterval(sourcesTimer);
    sourcesTimer = null;
  }
  if (stateListener) {
    window.removeEventListener("fleet:state", stateListener);
    stateListener = null;
  }
}

/**
 * Initialize the LLM Usage view. Called by views.js on every visit.
 * @param {HTMLElement} container
 */
export function init(container) {
  teardown();

  const els = {
    root: container.querySelector("#llm-view-section"),
    error: container.querySelector("#llm-view-error"),
    auth: container.querySelector("#llm-view-auth"),
    syncTime: container.querySelector("#lv-sync-time"),
    routingSummary: container.querySelector("#lv-routing-summary"),
    claudeSessionPct: container.querySelector("#lv-claude-session-pct"),
    claudeSessionBar: container.querySelector("#lv-claude-session-bar"),
    claudeSessionRemaining: container.querySelector("#lv-claude-session-remaining"),
    claudeSessionReset: container.querySelector("#lv-claude-session-reset"),
    claudeWeeklyPct: container.querySelector("#lv-claude-weekly-pct"),
    claudeWeeklyBar: container.querySelector("#lv-claude-weekly-bar"),
    claudeWeeklyRemaining: container.querySelector("#lv-claude-weekly-remaining"),
    claudeWeeklyReset: container.querySelector("#lv-claude-weekly-reset"),
    sonnetWeeklyPct: container.querySelector("#lv-sonnet-weekly-pct"),
    sonnetWeeklyBar: container.querySelector("#lv-sonnet-weekly-bar"),
    sonnetWeeklyRemaining: container.querySelector("#lv-sonnet-weekly-remaining"),
    sonnetWeeklyReset: container.querySelector("#lv-sonnet-weekly-reset"),
    codex5hPct: container.querySelector("#lv-codex-5h-pct"),
    codex5hBar: container.querySelector("#lv-codex-5h-bar"),
    codexDayPct: container.querySelector("#lv-codex-day-pct"),
    codexTasks: container.querySelector("#lv-codex-tasks"),
    totalRouted: container.querySelector("#lv-total-routed"),
    claudeTasks: container.querySelector("#lv-claude-tasks"),
    codexTaskCount: container.querySelector("#lv-codex-task-count"),
    llamaTasks: container.querySelector("#lv-llama-tasks"),
    qwenTasks: container.querySelector("#lv-qwen-tasks"),
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
  };
  if (!els.root || !els.error || !els.extraSources) {
    console.error("[LLM Usage] Partial markup is missing expected elements; aborting init.");
    return;
  }

  stateListener = (event) => {
    if (!els.root.isConnected) {
      teardown();
      return;
    }
    lastSseAt = Date.now();
    if (event.detail?.llmUsage) {
      els.error.hidden = true;
      renderUsage(els, event.detail.llmUsage);
    }
  };
  window.addEventListener("fleet:state", stateListener);

  pollTimer = setInterval(() => {
    if (!els.root.isConnected) {
      teardown();
      return;
    }
    if (document.hidden) return;
    if (Date.now() - lastSseAt < SSE_FRESH_MS) return;
    load(els);
  }, POLL_MS);

  // Dedicated usage-source sections poll on their own cadence (SSE does not
  // carry these slices).
  sourcesTimer = setInterval(() => {
    if (!els.root.isConnected) {
      teardown();
      return;
    }
    if (document.hidden) return;
    loadSources(els);
  }, SOURCES_POLL_MS);

  load(els);
  loadSources(els);
}
