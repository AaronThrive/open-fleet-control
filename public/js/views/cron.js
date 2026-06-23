/**
 * Cron Jobs view module — dense detail-list ("neat file list") rendering.
 *
 * Loaded by views.js via dynamic import; `init(containerEl)` runs on every
 * visit of #view-cron and must be idempotent.
 *
 * Data source: GET /api/cron → { cron: [{ id, name, schedule, scheduleHuman,
 * nextRun, enabled, lastStatus, agent, node, source }] } (source is
 * 'openclaw', 'hermes', or 'host'), also mirrored in the /api/state `cron` slice
 * delivered over SSE.
 *
 * Real-time: listens for the `fleet:state` window event (fed by the page's
 * single /api/events EventSource) with a polling fallback.
 *
 * Rendering: the shared detail-list component (sortable columns, text filter,
 * expandable detail panel). The legacy filter button groups (status /
 * schedule / source / agent) are preserved and applied to the row set before
 * each list.update().
 *
 * Write actions (openclaw-source jobs only): enable/disable toggle and
 * run-now (confirm dialog) via POST /api/cron/:id/{enable|disable|run}.
 * Updates are optimistic-but-verified — the row flips immediately and a
 * re-fetch after the response is the source of truth. Hermes-source jobs
 * stay read-only.
 *
 * All dynamic values are rendered via textContent — XSS-safe.
 */

import { t } from "../utils.js";
import { createDetailList } from "../components/detail-list.js";

const POLL_MS = 30000;
const SSE_FRESH_MS = 20000;

let pollTimer = null;
let stateListener = null;
let requestSeq = 0;
let lastSseAt = 0;
let currentJobs = [];
let list = null;
const filters = { status: "all", schedule: "all", source: "all", agent: "all" };

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for node:test)                                */
/* ------------------------------------------------------------------ */

/**
 * Rough schedule classification from the cron expression for the
 * frequent/daily/weekly filter.
 */
export function classifySchedule(job) {
  const expr = String(job.schedule || "").trim();
  const parts = expr.split(/\s+/);
  if (parts.length < 5) return "other"; // "once", "—", etc.
  const [minute, hour, , , dayOfWeek] = parts.slice(-5);
  if (dayOfWeek !== "*" && dayOfWeek !== "?") return "weekly";
  if (minute.includes("*") || minute.includes(",") || hour.includes("*") || hour.includes("/")) {
    return "frequent";
  }
  return "daily";
}

/** Apply the filter-button groups (status/schedule/source/agent) to the jobs. */
export function filterCronJobs(jobs, active) {
  return jobs.filter((job) => {
    const enabled = job.enabled !== false;
    if (active.status === "enabled" && !enabled) return false;
    if (active.status === "disabled" && enabled) return false;
    if (active.schedule !== "all" && classifySchedule(job) !== active.schedule) return false;
    const source =
      job.source === "hermes" ? "hermes" : job.source === "host" ? "host" : "openclaw";
    if (active.source !== "all" && source !== active.source) return false;
    if (active.agent !== "all" && (job.agent || "") !== active.agent) return false;
    return true;
  });
}

/** Flatten a cron job onto the column keys the detail list sorts/filters by. */
export function toCronRow(job) {
  return {
    id: job.id || job.name || "?",
    name: job.name || job.id || "?",
    scheduleHuman: job.scheduleHuman || job.schedule || "—",
    schedule: job.schedule || "—",
    nextRun: job.nextRun || "—",
    nextRunAtMs: Number.isFinite(job.nextRunAtMs) ? job.nextRunAtMs : null,
    lastStatus: job.lastStatus ? String(job.lastStatus) : "",
    lastRunAtMs: Number.isFinite(job.lastRunAtMs) ? job.lastRunAtMs : null,
    agent: job.agent || "",
    node: job.node || "",
    source: job.source === "hermes" ? "hermes" : job.source === "host" ? "host" : "openclaw",
    enabled: job.enabled !== false,
    job,
  };
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

/** Toast using the dashboard's global .toast styles. */
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

/* ------------------------------------------------------------------ */
/* Write actions (openclaw-source jobs only)                           */
/* ------------------------------------------------------------------ */

/**
 * POST /api/cron/:id/{enable|disable|run}, then re-fetch to verify.
 * Optimistic UI happens at the call site (toggle only); the load() in the
 * finally block is the source of truth and reverts any failed optimism.
 */
async function performAction(els, job, action) {
  try {
    const response = await fetch(`/api/cron/${encodeURIComponent(job.id)}/${action}`, {
      method: "POST",
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch (e) {
      payload = null;
    }
    if (!response.ok) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    const name = job.name || job.id;
    if (action === "run") {
      showToast(t("views.cron.runQueued", { name }, "Run queued: {name}"), "success");
    } else if (action === "enable") {
      showToast(t("views.cron.enabledToast", { name }, "Enabled: {name}"), "success");
    } else {
      showToast(t("views.cron.disabledToast", { name }, "Disabled: {name}"), "success");
    }
  } catch (error) {
    showToast(
      t("views.cron.actionError", { message: error.message }, "Cron action failed: {message}"),
      "error",
    );
  } finally {
    // Verified update: re-fetch regardless of outcome (reverts bad optimism).
    if (els.listHost.isConnected) load(els);
  }
}

/** Per-row actions cell: enable/disable + ▶ run-now (openclaw only) + hide. */
function buildRowActions(els, row) {
  const actions = el("div", "cron-actions");

  if (row.source === "openclaw" && row.job.id) {
    const toggleBtn = el(
      "button",
      "cron-action-btn toggle",
      row.enabled
        ? t("views.cron.actionDisable", {}, "⏸ Disable")
        : t("views.cron.actionEnable", {}, "✓ Enable"),
    );
    toggleBtn.type = "button";
    toggleBtn.addEventListener("click", () => {
      const action = row.enabled ? "disable" : "enable";
      actions.querySelectorAll("button").forEach((btn) => (btn.disabled = true));
      // Optimistic: flip the row state immediately; load() verifies/reverts.
      currentJobs = currentJobs.map((job) =>
        job === row.job ? { ...job, enabled: action === "enable" } : job,
      );
      renderRows(els);
      performAction(els, row.job, action);
    });
    actions.appendChild(toggleBtn);

    const runBtn = el("button", "cron-action-btn run", t("views.cron.actionRun", {}, "▶ Run now"));
    runBtn.type = "button";
    runBtn.addEventListener("click", () => {
      const name = row.name;
      const ok = window.confirm(
        t("views.cron.runConfirm", { name }, 'Run "{name}" now? The job executes immediately.'),
      );
      if (!ok) return;
      actions.querySelectorAll("button").forEach((btn) => (btn.disabled = true));
      performAction(els, row.job, "run");
    });
    actions.appendChild(runBtn);
  }

  return actions.childElementCount > 0 ? actions : null;
}

/* ------------------------------------------------------------------ */
/* Detail-list configuration                                           */
/* ------------------------------------------------------------------ */

function statusBadge(row) {
  const status = row.lastStatus;
  // Host crontab jobs keep no exit-status record, so "no runs yet" is wrong —
  // they ARE firing. Show "host cron · last fired <date>" from the log mtime
  // when known, otherwise "host cron — not tracked". Never "no runs yet".
  if (!status && row.source === "host") {
    const last = formatAbsolute(row.lastRunAtMs);
    return el(
      "span",
      "cron-last-status host",
      last
        ? t("views.cron.hostLastFired", { when: last }, `host cron · last fired ${last}`)
        : t("views.cron.hostNotTracked", {}, "host cron — not tracked"),
    );
  }
  const cls = status === "ok" || status === "success" ? "ok" : status ? "error" : "unknown";
  return el(
    "span",
    `cron-last-status ${cls}`,
    status ? status : t("views.cron.neverRan", {}, "no runs yet"),
  );
}

// Plain text (no badge pill) — the source is already a top-level filter, so the
// decorative badge is redundant noise.
function sourceCell(row) {
  const label = row.source === "hermes" ? "Hermes" : row.source === "host" ? "Host" : "OpenClaw";
  return el("span", "cron-source-text", label);
}

/** Absolute date + time, e.g. "Jun 25, 2026, 09:00". */
function formatAbsolute(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Next-run cell: the ACTUAL next run date + time (so runs are easy to line up
// and check), with the compact relative form ("in 2d") as a small secondary.
function nextRunCell(row) {
  const wrap = el("span", "cron-nextrun");
  const abs = formatAbsolute(row.nextRunAtMs);
  if (!abs) {
    wrap.appendChild(el("span", "cron-nextrun-abs", row.nextRun || "—"));
    return wrap;
  }
  wrap.appendChild(el("span", "cron-nextrun-abs", abs));
  if (row.nextRun && row.nextRun !== "—" && row.nextRun !== "overdue") {
    wrap.appendChild(el("span", "cron-nextrun-rel", ` · in ${row.nextRun}`));
  } else if (row.nextRun === "overdue") {
    wrap.appendChild(el("span", "cron-nextrun-rel overdue", " · overdue"));
  }
  return wrap;
}

function enabledBadge(row) {
  return el(
    "span",
    `cron-status ${row.enabled ? "enabled" : "disabled"}`,
    row.enabled
      ? t("views.cron.enabled", {}, "✓ Enabled")
      : t("views.cron.disabled", {}, "○ Disabled"),
  );
}

/** Expanded panel: raw cron expression, job id, source, last status detail. */
function buildDetail(row) {
  const panel = el("div", "cron-detail");
  const add = (label, value, mono) => {
    const item = el("div", "cron-detail-item");
    item.appendChild(el("span", "cron-detail-label", label));
    item.appendChild(el("span", `cron-detail-value${mono ? " mono" : ""}`, value));
    panel.appendChild(item);
  };
  add(t("views.cron.detailExpression", {}, "Cron expression"), row.schedule, true);
  add(t("views.cron.detailJobId", {}, "Job id"), row.job.id || "—", true);
  add(
    t("views.cron.detailSource", {}, "Source"),
    row.source === "hermes" ? "Hermes" : row.source === "host" ? "Host (system crontab)" : "OpenClaw",
  );
  add(
    t("views.cron.detailLastStatus", {}, "Last status"),
    row.lastStatus || t("views.cron.neverRan", {}, "no runs yet"),
  );
  if (row.node) add(t("views.cron.detailNode", {}, "Node"), row.node);
  if (row.agent) add(t("views.cron.detailAgent", {}, "Agent"), row.agent);
  return panel;
}

function buildList(els) {
  if (list) {
    list.destroy();
    list = null;
  }
  els.listHost.replaceChildren();
  list = createDetailList(els.listHost, {
    columns: [
      { key: "name", label: t("views.cron.colName", {}, "Name"), sortable: true },
      { key: "scheduleHuman", label: t("views.cron.colSchedule", {}, "Schedule"), sortable: true },
      {
        key: "nextRunAtMs",
        label: t("views.cron.colNextRun", {}, "Next run"),
        sortable: true,
        render: nextRunCell,
      },
      {
        key: "lastStatus",
        label: t("views.cron.colLastStatus", {}, "Last status"),
        sortable: true,
        render: statusBadge,
      },
      { key: "agent", label: t("views.cron.colAgent", {}, "Agent"), sortable: true },
      { key: "node", label: t("views.cron.colNode", {}, "Node"), sortable: true },
      {
        key: "source",
        label: t("views.cron.colSource", {}, "Source"),
        sortable: true,
        render: sourceCell,
      },
      {
        key: "enabled",
        label: t("views.cron.colEnabled", {}, "Enabled"),
        sortable: true,
        render: enabledBadge,
      },
    ],
    getRowId: (row) => row.id,
    renderDetail: buildDetail,
    renderActions: (row) => buildRowActions(els, row),
    // The empty/filtered states are explained by #cron-view-filter-empty.
    emptyText: "",
    filterKeys: ["name", "scheduleHuman", "schedule", "nextRun", "agent", "node", "source"],
    filterPlaceholder: t("views.cron.filterPlaceholder", {}, "Filter jobs…"),
    defaultSort: { key: "name", dir: "asc" },
  });
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/**
 * When the active filters hide every row, explain why instead of showing a
 * silently blank list. The Hermes source slot stays selectable even when no
 * Hermes scheduled tasks exist yet — it renders empty with a note.
 */
function updateFilterEmptyNote(els, shownCount, totalCount) {
  if (!els.filterEmpty) return;
  if (shownCount > 0) {
    els.filterEmpty.hidden = true;
    return;
  }
  if (totalCount === 0) {
    els.filterEmpty.textContent = t("views.cron.empty", {}, "No scheduled jobs");
  } else if (filters.source === "hermes") {
    els.filterEmpty.textContent = t(
      "views.cron.hermesEmpty",
      {},
      "No Hermes scheduled tasks found — ~/.hermes/cron/jobs.json has no matching jobs.",
    );
  } else {
    els.filterEmpty.textContent = t(
      "views.cron.filterEmpty",
      {},
      "No cron jobs match the current filters.",
    );
  }
  els.filterEmpty.hidden = false;
}

/**
 * Rebuild the agent filter buttons from the agents present in the data,
 * preserving the active selection when possible.
 */
function syncAgentFilter(els, jobs) {
  const group = els.filtersBar.querySelector('[data-filter-group="agent"]');
  if (!group) return;

  const agents = [...new Set(jobs.map((job) => job.agent).filter(Boolean))].sort();
  if (filters.agent !== "all" && !agents.includes(filters.agent)) {
    filters.agent = "all";
  }

  group.querySelectorAll(".filter-btn").forEach((btn) => btn.remove());
  const makeButton = (value, label) => {
    const btn = el("button", `filter-btn ${filters.agent === value ? "active" : ""}`.trim(), label);
    btn.type = "button";
    btn.dataset.filter = value;
    btn.addEventListener("click", () => {
      filters.agent = value;
      group
        .querySelectorAll(".filter-btn")
        .forEach((other) => other.classList.toggle("active", other === btn));
      renderRows(els);
    });
    return btn;
  };

  group.appendChild(makeButton("all", t("views.cron.filterAll", {}, "All")));
  agents.forEach((agent) => group.appendChild(makeButton(agent, agent)));
}

/** Re-apply the filter groups to currentJobs and push rows into the list. */
function renderRows(els) {
  const filtered = filterCronJobs(currentJobs, filters);
  if (list) list.update(filtered.map(toCronRow));
  updateFilterEmptyNote(els, filtered.length, currentJobs.length);
}

function render(els, jobs) {
  currentJobs = Array.isArray(jobs) ? jobs : [];
  els.headerCount.textContent = currentJobs.length;
  syncAgentFilter(els, currentJobs);
  renderRows(els);
}

/* ------------------------------------------------------------------ */
/* Data loading                                                        */
/* ------------------------------------------------------------------ */

async function load(els) {
  const seq = ++requestSeq;
  try {
    const response = await fetch("/api/cron");
    const payload = await response.json();
    if (seq !== requestSeq || !els.listHost.isConnected) return;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    els.error.hidden = true;
    render(els, payload.cron || []);
  } catch (error) {
    if (seq !== requestSeq || !els.listHost.isConnected) return;
    els.error.hidden = false;
    els.error.textContent = t(
      "views.cron.loadError",
      {},
      "Could not reach the cron API — is the server up?",
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
  if (list) {
    list.destroy();
    list = null;
  }
}

/**
 * Initialize the Cron view. Called by views.js on every visit.
 * @param {HTMLElement} container
 */
export function init(container) {
  teardown();
  filters.status = "all";
  filters.schedule = "all";
  filters.source = "all";
  filters.agent = "all";

  const els = {
    listHost: container.querySelector("#cron-view-list"),
    headerCount: container.querySelector("#cron-view-count"),
    error: container.querySelector("#cron-view-error"),
    filtersBar: container.querySelector("#cron-view-filters"),
  };
  if (Object.values(els).some((node) => !node)) {
    console.error("[Cron] Partial markup is missing expected elements; aborting init.");
    return;
  }
  // Optional element (added with the dual-source layout); absence is fine.
  els.filterEmpty = container.querySelector("#cron-view-filter-empty");

  buildList(els);

  els.filtersBar.querySelectorAll(".filter-group").forEach((group) => {
    const groupName = group.dataset.filterGroup;
    // The agent group is rebuilt dynamically from data in syncAgentFilter().
    if (groupName === "agent") return;
    group.querySelectorAll(".filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        filters[groupName] = btn.dataset.filter;
        group
          .querySelectorAll(".filter-btn")
          .forEach((other) => other.classList.toggle("active", other === btn));
        renderRows(els);
      });
    });
  });

  stateListener = (event) => {
    if (!els.listHost.isConnected) {
      teardown();
      return;
    }
    lastSseAt = Date.now();
    if (Array.isArray(event.detail?.cron)) {
      els.error.hidden = true;
      render(els, event.detail.cron);
    }
  };
  window.addEventListener("fleet:state", stateListener);

  pollTimer = setInterval(() => {
    if (!els.listHost.isConnected) {
      teardown();
      return;
    }
    if (document.hidden) return;
    if (Date.now() - lastSseAt < SSE_FRESH_MS) return;
    load(els);
  }, POLL_MS);

  load(els);
}
