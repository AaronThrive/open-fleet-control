/**
 * Cerebro view module — dense detail-list of conversation topics.
 *
 * Loaded by views.js via dynamic import; `init(containerEl)` runs on every
 * visit of #view-cerebro and must be idempotent.
 *
 * Data source: GET /api/cerebro?limit=N → { initialized, cerebroPath,
 * topics: { active, resolved, parked, total }, threads, orphans,
 * recentTopics: [{ name, title, status, threads, age }], lastUpdated }.
 * The same payload arrives as the `cerebro` slice of /api/state over SSE
 * (re-dispatched as the `fleet:state` window event); polling is the fallback.
 *
 * Capabilities preserved from the old home-page section:
 *  - "not initialized" fallback with mkdir init commands (path-aware)
 *  - topic status updates (resolve / park / reactivate) via
 *    POST /api/cerebro/topic/:id/status, verified by a re-fetch
 *  - privacy hide/unhide via the global window.quickHideTopic /
 *    window.isTopicHidden helpers when present
 *
 * All dynamic values render via textContent — XSS-safe.
 */

import { t } from "../utils.js";
import { createDetailList } from "../components/detail-list.js";

const POLL_MS = 30000;
const SSE_FRESH_MS = 20000;
const TOPIC_LIMIT = 200;

let pollTimer = null;
let stateListener = null;
let list = null;
let requestSeq = 0;
let lastSseAt = 0;

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for node:test)                               */
/* ------------------------------------------------------------------ */

/** Shorten a home-dir path for display ("/Users/x/cerebro" → "~/cerebro"). */
export function shortenPath(cerebroPath) {
  return String(cerebroPath || "~/cerebro").replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

/** The two mkdir commands shown in the not-initialized fallback. */
export function initCommands(cerebroPath) {
  const base = shortenPath(cerebroPath);
  return [`mkdir -p ${base}/topics`, `mkdir -p ${base}/orphans`];
}

/**
 * Flatten the API payload's recentTopics into detail-list rows, dropping
 * privacy-hidden topics. `isHidden` receives the topic name.
 */
export function buildTopicRows(cerebro, isHidden = () => false) {
  const topics = Array.isArray(cerebro?.recentTopics) ? cerebro.recentTopics : [];
  return topics
    .filter((topic) => topic && topic.name && !isHidden(topic.name))
    .map((topic) => ({
      name: topic.name,
      title: topic.title || topic.name,
      status: topic.status || "active",
      threads: Number(topic.threads) || 0,
      age: topic.age || "—",
    }));
}

/** Header count text, including the hidden breakdown when topics are hidden. */
export function countText(total, visibleCount, hiddenCount) {
  if (hiddenCount > 0) return `${total} (${visibleCount} visible, ${hiddenCount} hidden)`;
  return String(total);
}

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isTopicHidden(name) {
  return typeof window.isTopicHidden === "function" ? window.isTopicHidden(name) : false;
}

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

function formatUpdated(lastUpdated) {
  if (!lastUpdated) return "—";
  const diffMins = Math.round((Date.now() - new Date(lastUpdated).getTime()) / 60000);
  if (diffMins < 1) return t("views.cerebro.justNow", {}, "just now");
  if (diffMins < 60) return t("views.cerebro.minsAgo", { mins: diffMins }, "{mins}m ago");
  if (diffMins < 1440) {
    return t("views.cerebro.hoursAgo", { hours: Math.round(diffMins / 60) }, "{hours}h ago");
  }
  return t("views.cerebro.daysAgo", { days: Math.round(diffMins / 1440) }, "{days}d ago");
}

/* ------------------------------------------------------------------ */
/* Topic status updates                                                */
/* ------------------------------------------------------------------ */

async function updateTopicStatus(els, topicName, status) {
  try {
    const res = await fetch(`/api/cerebro/topic/${encodeURIComponent(topicName)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    let payload = null;
    try {
      payload = await res.json();
    } catch (e) {
      payload = null;
    }
    if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
    const title = payload?.topic?.title || topicName;
    showToast(
      t("views.cerebro.statusUpdated", { title, status }, 'Topic "{title}" marked as {status}'),
      "success",
    );
  } catch (error) {
    showToast(
      t("views.cerebro.statusError", { message: error.message }, "Status update failed: {message}"),
      "error",
    );
  } finally {
    // Verified update: re-fetch is the source of truth.
    if (els.root.isConnected) load(els);
  }
}

/* ------------------------------------------------------------------ */
/* Detail list                                                         */
/* ------------------------------------------------------------------ */

function statusBadge(status) {
  const cls = status === "resolved" ? "resolved" : status === "parked" ? "parked" : "active";
  const icon = status === "active" ? "🟢" : status === "resolved" ? "✅" : "⏸️";
  return el("span", `cerebro-status-badge ${cls}`, `${icon} ${status}`);
}

function buildActions(els, row) {
  const wrap = el("span");
  const addBtn = (label, title, onClick) => {
    const btn = el("button", "cerebro-topic-action", label);
    btn.type = "button";
    btn.title = title;
    btn.addEventListener("click", () => {
      wrap.querySelectorAll("button").forEach((b) => (b.disabled = true));
      onClick();
    });
    wrap.appendChild(btn);
  };

  if (row.status === "active") {
    addBtn("✓", t("views.cerebro.actionResolve", {}, "Mark as resolved"), () =>
      updateTopicStatus(els, row.name, "resolved"),
    );
    addBtn("⏸", t("views.cerebro.actionPark", {}, "Park topic"), () =>
      updateTopicStatus(els, row.name, "parked"),
    );
  } else {
    addBtn("↩", t("views.cerebro.actionReactivate", {}, "Reactivate topic"), () =>
      updateTopicStatus(els, row.name, "active"),
    );
  }
  if (typeof window.quickHideTopic === "function") {
    addBtn("👁️", t("views.cerebro.actionHide", {}, "Hide topic"), () => {
      window.quickHideTopic(row.name, row.title);
      if (els.lastData) render(els, els.lastData);
    });
  }
  return wrap;
}

function buildDetail(row) {
  const dl = el("dl", "cerebro-detail-grid");
  const add = (label, value) => {
    dl.appendChild(el("dt", null, label));
    dl.appendChild(el("dd", null, value));
  };
  add(t("views.cerebro.detailId", {}, "Topic ID"), row.name);
  add(t("views.cerebro.detailTitle", {}, "Title"), row.title);
  add(t("views.cerebro.detailStatus", {}, "Status"), row.status);
  add(t("views.cerebro.detailThreads", {}, "Threads"), String(row.threads));
  add(t("views.cerebro.detailUpdated", {}, "Last activity"), row.age);
  return dl;
}

function createList(els) {
  return createDetailList(els.listHost, {
    columns: [
      { key: "title", label: t("views.cerebro.colTopic", {}, "Topic"), sortable: true },
      {
        key: "status",
        label: t("views.cerebro.colStatus", {}, "Status"),
        sortable: true,
        render: (row) => statusBadge(row.status),
      },
      { key: "threads", label: t("views.cerebro.colThreads", {}, "Threads"), sortable: true },
      { key: "age", label: t("views.cerebro.colUpdated", {}, "Updated") },
    ],
    getRowId: (row) => row.name,
    renderDetail: (row) => buildDetail(row),
    renderActions: (row) => buildActions(els, row),
    emptyText: t("views.cerebro.empty", {}, "No topics yet."),
    filterKeys: ["name", "title", "status"],
    filterPlaceholder: t("views.cerebro.filterPlaceholder", {}, "Filter topics…"),
    defaultSort: null, // keep the server's status-priority + recency order
  });
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function render(els, cerebro) {
  els.lastData = cerebro;

  if (!cerebro || !cerebro.initialized) {
    els.notInit.hidden = false;
    els.initialized.hidden = true;
    els.count.textContent = t("views.cerebro.notInitialized", {}, "not initialized");
    const [topicsCmd, orphansCmd] = initCommands(cerebro?.cerebroPath);
    els.initTopicsCmd.textContent = topicsCmd;
    els.initOrphansCmd.textContent = orphansCmd;
    return;
  }

  els.notInit.hidden = true;
  els.initialized.hidden = false;

  const allTopics = Array.isArray(cerebro.recentTopics) ? cerebro.recentTopics : [];
  const rows = buildTopicRows(cerebro, isTopicHidden);
  const total = cerebro.topics?.total ?? allTopics.length;
  els.count.textContent = countText(total, rows.length, allTopics.length - rows.length);

  els.active.textContent = cerebro.topics?.active || 0;
  els.resolved.textContent = cerebro.topics?.resolved || 0;
  els.parked.textContent = cerebro.topics?.parked || 0;
  els.threads.textContent = cerebro.threads || 0;
  els.orphans.textContent = cerebro.orphans || 0;
  els.updated.textContent = t(
    "views.cerebro.lastUpdated",
    { age: formatUpdated(cerebro.lastUpdated) },
    "updated {age}",
  );

  list.update(rows);
}

/* ------------------------------------------------------------------ */
/* Data loading + lifecycle                                            */
/* ------------------------------------------------------------------ */

async function load(els) {
  const seq = ++requestSeq;
  try {
    const response = await fetch(`/api/cerebro?limit=${TOPIC_LIMIT}`);
    const payload = await response.json();
    if (seq !== requestSeq || !els.root.isConnected) return;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    els.error.hidden = true;
    render(els, payload);
  } catch (error) {
    if (seq !== requestSeq || !els.root.isConnected) return;
    els.error.hidden = false;
    els.error.textContent = t(
      "views.cerebro.loadError",
      {},
      "Could not reach the Cerebro API — is the server up?",
    );
  }
}

function teardown() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (stateListener) {
    window.removeEventListener("fleet:state", stateListener);
    stateListener = null;
  }
  if (list) {
    list.destroy();
    list = null;
  }
}

/**
 * Initialize the Cerebro view. Called by views.js on every visit.
 * @param {HTMLElement} container
 */
export function init(container) {
  teardown();

  const els = {
    root: container.querySelector("#cerebro-view-section"),
    count: container.querySelector("#cerebro-view-count"),
    error: container.querySelector("#cerebro-view-error"),
    notInit: container.querySelector("#cerebro-view-not-initialized"),
    initialized: container.querySelector("#cerebro-view-initialized"),
    initTopicsCmd: container.querySelector("#cerebro-view-init-topics-cmd"),
    initOrphansCmd: container.querySelector("#cerebro-view-init-orphans-cmd"),
    active: container.querySelector("#cerebro-view-active"),
    resolved: container.querySelector("#cerebro-view-resolved"),
    parked: container.querySelector("#cerebro-view-parked"),
    threads: container.querySelector("#cerebro-view-threads"),
    orphans: container.querySelector("#cerebro-view-orphans"),
    updated: container.querySelector("#cerebro-view-updated"),
    listHost: container.querySelector("#cerebro-view-list"),
    lastData: null,
  };
  if (Object.entries(els).some(([key, node]) => key !== "lastData" && !node)) {
    console.error("[Cerebro] Partial markup is missing expected elements; aborting init.");
    return;
  }

  list = createList(els);

  stateListener = (event) => {
    if (!els.root.isConnected) {
      teardown();
      return;
    }
    lastSseAt = Date.now();
    if (event.detail?.cerebro) {
      els.error.hidden = true;
      render(els, event.detail.cerebro);
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
