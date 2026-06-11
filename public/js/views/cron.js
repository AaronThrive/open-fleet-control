/**
 * Cron Jobs view module.
 *
 * Loaded by views.js via dynamic import; `init(containerEl)` runs on every
 * visit of #view-cron and must be idempotent.
 *
 * Data source: GET /api/cron → { cron: [{ id, name, schedule, scheduleHuman,
 * nextRun, enabled, lastStatus, agent, node, source }] } (source is
 * 'openclaw' or 'hermes'), also mirrored in the /api/state `cron` slice
 * delivered over SSE.
 *
 * Real-time: listens for the `fleet:state` window event (fed by the page's
 * single /api/events EventSource) with a polling fallback.
 *
 * Write actions (openclaw-source jobs only): enable/disable toggle and
 * run-now (confirm dialog) via POST /api/cron/:id/{enable|disable|run}.
 * Updates are optimistic-but-verified — the card flips immediately and a
 * re-fetch after the response is the source of truth. Hermes-source jobs
 * stay read-only.
 *
 * All dynamic values are rendered via textContent — XSS-safe.
 */

import { t } from "../utils.js";

const POLL_MS = 30000;
const SSE_FRESH_MS = 20000;

let pollTimer = null;
let stateListener = null;
let requestSeq = 0;
let lastSseAt = 0;
let currentJobs = [];
const filters = { status: "all", schedule: "all", source: "all", agent: "all" };

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isCronHidden(job) {
  return typeof window.isCronHidden === "function" ? window.isCronHidden(job) : false;
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

/**
 * Rough schedule classification from the cron expression for the
 * frequent/daily/weekly filter.
 */
function classifySchedule(job) {
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
    if (els.grid.isConnected) load(els);
  }
}

/** Build the per-job action buttons (openclaw-source jobs only). */
function buildActions(els, job, card) {
  const actions = el("div", "cron-actions");

  const toggleBtn = el(
    "button",
    "cron-action-btn toggle",
    job.enabled !== false
      ? t("views.cron.actionDisable", {}, "⏸ Disable")
      : t("views.cron.actionEnable", {}, "✓ Enable"),
  );
  toggleBtn.type = "button";
  toggleBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const action = job.enabled !== false ? "disable" : "enable";
    actions.querySelectorAll("button").forEach((btn) => (btn.disabled = true));
    // Optimistic: flip the card state immediately; load() verifies/reverts.
    card.classList.toggle("disabled", action === "disable");
    card.dataset.enabled = action === "enable" ? "true" : "false";
    performAction(els, job, action);
  });
  actions.appendChild(toggleBtn);

  const runBtn = el("button", "cron-action-btn run", t("views.cron.actionRun", {}, "▶ Run now"));
  runBtn.type = "button";
  runBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const name = job.name || job.id;
    const ok = window.confirm(
      t("views.cron.runConfirm", { name }, 'Run "{name}" now? The job executes immediately.'),
    );
    if (!ok) return;
    actions.querySelectorAll("button").forEach((btn) => (btn.disabled = true));
    performAction(els, job, "run");
  });
  actions.appendChild(runBtn);

  return actions;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function buildCard(els, job) {
  const card = el("div", `cron-card ${job.enabled === false ? "disabled" : ""}`);
  const source = job.source === "hermes" ? "hermes" : "openclaw";
  card.dataset.enabled = job.enabled !== false ? "true" : "false";
  card.dataset.schedule = classifySchedule(job);
  card.dataset.source = source;
  card.dataset.agent = job.agent || "";

  card.appendChild(el("div", "cron-icon", "⏰"));

  const info = el("div", "cron-info");
  info.appendChild(el("div", "cron-name", job.name || job.id || "?"));
  info.appendChild(el("div", "cron-schedule", job.schedule || "—"));
  if (job.scheduleHuman) {
    info.appendChild(el("div", "cron-schedule-human", job.scheduleHuman));
  }

  const badges = el("div", "cron-badges");
  if (job.agent) badges.appendChild(el("span", "cron-badge agent", job.agent));
  if (job.node) badges.appendChild(el("span", "cron-badge node", job.node));
  badges.appendChild(el("span", "cron-badge source", source === "hermes" ? "Hermes" : "OpenClaw"));
  info.appendChild(badges);
  card.appendChild(info);

  const meta = el("div", "cron-meta");
  meta.appendChild(
    el(
      "span",
      `cron-status ${job.enabled !== false ? "enabled" : "disabled"}`,
      job.enabled !== false
        ? t("views.cron.enabled", {}, "✓ Enabled")
        : t("views.cron.disabled", {}, "○ Disabled"),
    ),
  );

  const lastStatus = job.lastStatus ? String(job.lastStatus) : "";
  const statusClass =
    lastStatus === "ok" || lastStatus === "success" ? "ok" : lastStatus ? "error" : "unknown";
  meta.appendChild(
    el(
      "span",
      `cron-last-status ${statusClass}`,
      lastStatus
        ? t("views.cron.lastStatus", { status: lastStatus }, "last: {status}")
        : t("views.cron.neverRan", {}, "no runs yet"),
    ),
  );
  meta.appendChild(el("div", "cron-next", `⏭ ${job.nextRun || "—"}`));

  if (typeof window.quickHideCron === "function") {
    const hideBtn = el("button", "hide-btn", "👁️");
    hideBtn.type = "button";
    hideBtn.title = t("views.cron.hideJob", {}, "Hide cron job");
    hideBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      window.quickHideCron(job.id || job.name || "", job.name || "");
      card.remove();
    });
    meta.appendChild(hideBtn);
  }
  card.appendChild(meta);

  // Write actions are openclaw-source only; Hermes jobs are read-only.
  if (source === "openclaw" && job.id) {
    card.appendChild(buildActions(els, job, card));
  }
  return card;
}

function applyFilters(els) {
  let shown = 0;
  els.grid.querySelectorAll(".cron-card").forEach((card) => {
    const enabled = card.dataset.enabled === "true";
    const showStatus =
      filters.status === "all" ||
      (filters.status === "enabled" && enabled) ||
      (filters.status === "disabled" && !enabled);
    const showSchedule = filters.schedule === "all" || card.dataset.schedule === filters.schedule;
    const showSource = filters.source === "all" || card.dataset.source === filters.source;
    const showAgent = filters.agent === "all" || card.dataset.agent === filters.agent;
    const show = showStatus && showSchedule && showSource && showAgent;
    if (show) shown += 1;
    card.classList.toggle("hidden-by-filter", !show);
  });
  updateFilterEmptyNote(els, shown);
}

/**
 * When the active filters hide every card, explain why instead of showing a
 * silently blank grid. The Hermes source slot stays selectable even when no
 * Hermes scheduled tasks exist yet — it renders empty with a note.
 */
function updateFilterEmptyNote(els, shownCount) {
  if (!els.filterEmpty) return;
  const hasCards = els.grid.querySelector(".cron-card") !== null;
  if (!hasCards || shownCount > 0) {
    els.filterEmpty.hidden = true;
    return;
  }
  if (filters.source === "hermes") {
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
      applyFilters(els);
    });
    return btn;
  };

  group.appendChild(makeButton("all", t("views.cron.filterAll", {}, "All")));
  agents.forEach((agent) => group.appendChild(makeButton(agent, agent)));
}

function render(els, jobs) {
  currentJobs = Array.isArray(jobs) ? jobs : [];
  const visible = currentJobs.filter((job) => !isCronHidden(job));
  els.headerCount.textContent = visible.length;
  syncAgentFilter(els, visible);

  if (visible.length === 0) {
    const empty = el("div", "empty-state");
    empty.appendChild(el("div", "empty-state-icon", "⏰"));
    empty.appendChild(
      el("div", "empty-state-text", t("views.cron.empty", {}, "No scheduled jobs")),
    );
    els.grid.replaceChildren(empty);
    updateFilterEmptyNote(els, 0);
    return;
  }
  els.grid.replaceChildren(...visible.map((job) => buildCard(els, job)));
  applyFilters(els);
}

/* ------------------------------------------------------------------ */
/* Data loading                                                        */
/* ------------------------------------------------------------------ */

async function load(els) {
  const seq = ++requestSeq;
  try {
    const response = await fetch("/api/cron");
    const payload = await response.json();
    if (seq !== requestSeq || !els.grid.isConnected) return;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    els.error.hidden = true;
    render(els, payload.cron || []);
  } catch (error) {
    if (seq !== requestSeq || !els.grid.isConnected) return;
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
    grid: container.querySelector("#cron-view-grid"),
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
        applyFilters(els);
      });
    });
  });

  stateListener = (event) => {
    if (!els.grid.isConnected) {
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
    if (!els.grid.isConnected) {
      teardown();
      return;
    }
    if (document.hidden) return;
    if (Date.now() - lastSseAt < SSE_FRESH_MS) return;
    load(els);
  }, POLL_MS);

  load(els);
}
