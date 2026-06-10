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
const SSE_FRESH_MS = 20000;

// Keys of /api/llm-usage handled by the dedicated gauges above; everything
// else is treated as an extra usage source.
const KNOWN_KEYS = new Set([
  "timestamp",
  "source",
  "claude",
  "codex",
  "routing",
  "error",
  "errorType",
  "needsSync",
]);

let pollTimer = null;
let stateListener = null;
let requestSeq = 0;
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

  load(els);
}
