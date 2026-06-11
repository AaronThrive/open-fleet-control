/**
 * Federation view — fleet-of-fleets as a dense detail list (v2.1 style).
 *
 * Loaded on demand by views.js, which calls init(containerEl) on EVERY
 * visit of the view. The partial HTML is re-injected fresh each visit, so
 * init() re-queries the DOM from scratch and tears down any timers / SSE
 * connections left over from a previous visit (module scope persists).
 *
 * Data sources:
 *   GET    /api/fleet/federation              — remotes + last-known summaries
 *   POST   /api/fleet/federation/remotes      — add a remote dashboard
 *   PATCH  /api/fleet/federation/remotes/:id  — toggle per-remote allowWrites
 *   DELETE /api/fleet/federation/remotes/:id  — remove a remote
 *   POST   /api/fleet/federation/remotes/:id/actions — whitelisted write proxy
 *   GET    /api/fleet/federation/remotes/:id/detail  — cached drill-down
 *   SSE    /api/events (event "fleet.federation") — reachability transitions
 *
 * Rendering: the shared detail-list component — one row per remote (label,
 * host, reachability, writes badge, node/task counts, last sync) with an
 * expandable detail panel carrying the drill-down detail (mesh nodes, kanban
 * columns, recent alerts), the write controls (gate toggle, pending lesson
 * approve/reject), and the registry actions (toggle allowWrites, remove).
 *
 * Remotes are read-only by default: this panel only mutates the LOCAL
 * registry unless a remote is explicitly opted in (allowWrites). All remote
 * writes go through the server-side whitelisted proxy and are audited on
 * both sides. All dynamic values render via textContent — XSS-safe.
 */

import { t } from "../utils.js";
import { createDetailList } from "../components/detail-list.js";

const REFRESH_INTERVAL_MS = 60000; // fallback poll; SSE drives live updates
const SSE_REFETCH_DEBOUNCE_MS = 300;

// Mirrors the kanban column order for the per-status detail rows.
const TASK_STATUS_ORDER = ["inbox", "assigned", "inprogress", "review", "done", "failed"];

// --- Module-level lifecycle state (persists across visits) -----------------

let refs = null; // DOM references for the active visit
let list = null; // shared detail-list instance
let refreshTimer = null;
let eventSource = null;
let sseDebounceTimer = null;
let fetchSeq = 0; // guards against out-of-order list responses
const detailSeq = new Map(); // remoteId -> seq guard for detail-panel fetches

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for node:test)                                */
/* ------------------------------------------------------------------ */

/** Host (plus port, if any) of a base URL — for compact display. */
export function baseUrlHost(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch (err) {
    return String(baseUrl || "");
  }
}

/** Sum the finite per-status task counts, or null when nothing is known. */
export function sumTaskCounts(counts) {
  if (!counts || typeof counts !== "object") return null;
  let total = null;
  for (const value of Object.values(counts)) {
    if (typeof value === "number" && Number.isFinite(value)) total = (total ?? 0) + value;
  }
  return total;
}

/** Flatten a federation remote onto the column keys the list sorts/filters by. */
export function toRemoteRow(remote) {
  const status = remote.status && typeof remote.status === "object" ? remote.status : {};
  const summary = status.summary && typeof status.summary === "object" ? status.summary : null;
  const mesh = summary && summary.mesh && typeof summary.mesh === "object" ? summary.mesh : null;
  const nodes =
    mesh && isFiniteNumber(mesh.online) && isFiniteNumber(mesh.nodes)
      ? `${mesh.online}/${mesh.nodes}`
      : "—";
  return {
    id: remote.id,
    label: remote.label || "",
    host: baseUrlHost(remote.baseUrl),
    hostname: summary && typeof summary.hostname === "string" ? summary.hostname : "",
    reachable:
      status.reachable === true
        ? "reachable"
        : status.reachable === false
          ? "unreachable"
          : "unknown",
    writes: remote.allowWrites === true,
    latencyMs: isFiniteNumber(status.latencyMs) ? status.latencyMs : null,
    lastChecked: isFiniteNumber(status.lastChecked) ? status.lastChecked : null,
    nodes,
    tasks: summary && summary.kanban ? sumTaskCounts(summary.kanban.counts) : null,
    pending:
      summary && summary.evolution && isFiniteNumber(summary.evolution.pendingCount)
        ? summary.evolution.pendingCount
        : null,
    remote,
    status,
    summary,
  };
}

/* ------------------------------------------------------------------ */
/* Entry point + lifecycle                                              */
/* ------------------------------------------------------------------ */

export function init(containerEl) {
  teardown();

  const root = containerEl.querySelector("#federation-view-section");
  if (!root) {
    console.error("[Federation] Partial markup missing #federation-view-section");
    return;
  }

  refs = {
    root,
    loading: root.querySelector("#fed-loading"),
    fetchError: root.querySelector("#fed-fetch-error"),
    body: root.querySelector("#fed-body"),
    listHost: root.querySelector("#fed-list"),
    emptyState: root.querySelector("#fed-empty-state"),
    emptyCta: root.querySelector("#fed-empty-cta"),
    addForm: root.querySelector("#fed-add-form"),
    addLabel: root.querySelector("#fed-add-label"),
    addUrl: root.querySelector("#fed-add-url"),
    addToken: root.querySelector("#fed-add-token"),
    addBtn: root.querySelector("#fed-add-btn"),
    addError: root.querySelector("#fed-add-error"),
  };

  refs.emptyCta?.addEventListener("click", () => refs?.addLabel?.focus());
  refs.addForm?.addEventListener("submit", onAddSubmit);

  buildList();
  refresh({ initial: true });

  refreshTimer = setInterval(() => {
    if (!isActive()) {
      teardown();
      return;
    }
    refresh({ initial: false });
  }, REFRESH_INTERVAL_MS);

  connectSSE();
}

function teardown() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (sseDebounceTimer) {
    clearTimeout(sseDebounceTimer);
    sseDebounceTimer = null;
  }
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  if (list) {
    list.destroy();
    list = null;
  }
  detailSeq.clear();
  refs = null;
}

/** The view is active while its root is still attached to the document. */
function isActive() {
  return !!(refs && refs.root && document.body.contains(refs.root));
}

/* ------------------------------------------------------------------ */
/* Live updates                                                         */
/* ------------------------------------------------------------------ */

function connectSSE() {
  if (typeof EventSource === "undefined") return;
  try {
    eventSource = new EventSource("/api/events");
    eventSource.addEventListener("fleet.federation", () => {
      // Debounce: several remotes can transition in one poll sweep.
      if (sseDebounceTimer) clearTimeout(sseDebounceTimer);
      sseDebounceTimer = setTimeout(() => {
        sseDebounceTimer = null;
        if (!isActive()) {
          teardown();
          return;
        }
        refresh({ initial: false });
      }, SSE_REFETCH_DEBOUNCE_MS);
    });
    eventSource.onerror = () => {
      // The 60s poll keeps the panel fresh; retry SSE lazily.
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      setTimeout(() => {
        if (isActive() && !eventSource) connectSSE();
      }, 5000);
    };
  } catch (err) {
    console.error("[Federation] SSE connect failed:", err);
  }
}

/* ------------------------------------------------------------------ */
/* Data fetching                                                        */
/* ------------------------------------------------------------------ */

async function fetchJson(url, options) {
  const response = await fetch(url, options);
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

async function refresh({ initial }) {
  if (!isActive()) return;
  const seq = ++fetchSeq;

  try {
    const state = await fetchJson("/api/fleet/federation");
    if (seq !== fetchSeq || !isActive()) return;
    renderState(state);
  } catch (err) {
    if (seq !== fetchSeq || !isActive()) return;
    console.error("[Federation] Failed to fetch federation state:", err);
    renderFetchError(initial, err);
  }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                            */
/* ------------------------------------------------------------------ */

function renderFetchError(initial, err) {
  refs.loading.hidden = true;
  refs.fetchError.hidden = false;
  refs.fetchError.textContent = t(
    "views.federation.loadError",
    { message: err.message },
    "Failed to load federation state: {message}. Retrying automatically...",
  );
  // Keep showing the last good render (if any) under the error banner.
  if (initial) refs.body.hidden = true;
}

function renderState(state) {
  refs.loading.hidden = true;
  refs.fetchError.hidden = true;
  refs.body.hidden = false;

  const remotes = Array.isArray(state.remotes) ? state.remotes : [];
  const hasRemotes = remotes.length > 0;
  refs.emptyState.hidden = hasRemotes;
  refs.listHost.hidden = !hasRemotes;
  if (list) list.update(remotes.map(toRemoteRow));
}

/* ------------------------------------------------------------------ */
/* Detail-list configuration                                            */
/* ------------------------------------------------------------------ */

function reachBadge(row) {
  const badge = el("span", `fed-reach ${row.reachable}`);
  badge.appendChild(
    el(
      "span",
      `fed-status-dot ${row.reachable === "reachable" ? "reachable" : row.reachable === "unreachable" ? "unreachable" : ""}`.trim(),
    ),
  );
  badge.appendChild(
    el(
      "span",
      null,
      row.reachable === "reachable"
        ? t("views.federation.reachable", {}, "Reachable")
        : row.reachable === "unreachable"
          ? t("views.federation.unreachable", {}, "Unreachable")
          : t("views.federation.notChecked", {}, "Not checked"),
    ),
  );
  if (row.latencyMs !== null) badge.title = `${Math.round(row.latencyMs)} ms`;
  return badge;
}

function writesBadge(row) {
  return el(
    "span",
    `fed-writes-badge${row.writes ? " on" : ""}`,
    row.writes
      ? t("views.federation.writesOn", {}, "WRITES ON")
      : t("views.federation.writesOff", {}, "writes off"),
  );
}

function hostCell(row) {
  const cell = el("span", "fed-host", row.host);
  if (row.hostname) cell.title = row.hostname;
  return cell;
}

/** Per-row actions cell: writes toggle + remove. */
function buildRowActions(row) {
  const actions = el("div", "fed-row-actions");

  const toggleBtn = el(
    "button",
    "fed-action-btn",
    row.writes
      ? t("views.federation.disableWrites", {}, "Disable writes")
      : t("views.federation.enableWrites", {}, "Enable writes"),
  );
  toggleBtn.type = "button";
  toggleBtn.title = row.writes
    ? t("views.federation.writesOnTitle", {}, "Write actions enabled — click to disable")
    : t("views.federation.writesOffTitle", {}, "Read-only — click to enable write actions");
  toggleBtn.addEventListener("click", () => toggleWrites(row.remote, toggleBtn));
  actions.appendChild(toggleBtn);

  const removeBtn = el("button", "fed-remove-btn", t("actions.remove", {}, "Remove"));
  removeBtn.type = "button";
  removeBtn.addEventListener("click", () => removeRemote(row.remote, removeBtn));
  actions.appendChild(removeBtn);

  return actions;
}

function buildList() {
  if (list) {
    list.destroy();
    list = null;
  }
  refs.listHost.replaceChildren();
  list = createDetailList(refs.listHost, {
    columns: [
      { key: "label", label: t("views.federation.colLabel", {}, "Label"), sortable: true },
      {
        key: "host",
        label: t("views.federation.colHost", {}, "Host"),
        sortable: true,
        render: hostCell,
      },
      {
        key: "reachable",
        label: t("views.federation.colStatus", {}, "Status"),
        sortable: true,
        render: reachBadge,
      },
      {
        key: "writes",
        label: t("views.federation.colWrites", {}, "Writes"),
        sortable: true,
        render: writesBadge,
      },
      { key: "nodes", label: t("views.federation.colNodes", {}, "Nodes"), sortable: true },
      { key: "tasks", label: t("views.federation.colTasks", {}, "Tasks"), sortable: true },
      {
        key: "lastChecked",
        label: t("views.federation.colChecked", {}, "Last sync"),
        sortable: true,
        render: (row) => el("span", null, formatAgo(row.lastChecked)),
      },
    ],
    getRowId: (row) => row.id,
    renderDetail: buildRemoteDetail,
    renderActions: buildRowActions,
    emptyText: "",
    filterKeys: ["label", "host", "hostname", "reachable", "nodes"],
    filterPlaceholder: t("views.federation.filterPlaceholder", {}, "Filter remotes…"),
    defaultSort: { key: "label", dir: "asc" },
  });
}

/* ------------------------------------------------------------------ */
/* Detail panel (drill-down + write controls + registry actions)        */
/* ------------------------------------------------------------------ */

function buildRemoteDetail(row) {
  const panel = el("div", "fed-detail");

  if (row.reachable === "unreachable") {
    panel.appendChild(
      el(
        "div",
        "fed-detail-warning",
        t(
          "views.federation.drillUnreachable",
          {},
          "Remote currently unreachable — showing last-known cached detail.",
        ),
      ),
    );
    if (row.status.lastError) {
      panel.appendChild(
        el(
          "div",
          "fed-card-error",
          t(
            "views.federation.lastError",
            { message: row.status.lastError },
            "Last error: {message}",
          ),
        ),
      );
    }
  }

  // Write controls — only with writes enabled AND the remote reachable.
  if (row.writes && row.reachable === "reachable") {
    panel.appendChild(buildWriteControls(row.remote, row.status, row.summary));
  } else if (!row.writes) {
    panel.appendChild(
      el(
        "div",
        "fed-muted",
        t(
          "views.federation.writesHint",
          {},
          "Read-only remote. Use “Enable writes” to allow lesson approve/reject, gate toggle, and kanban task moves against this dashboard (audited on both sides).",
        ),
      ),
    );
  }

  // Drill-down detail (cached server-side) — fetched on expand.
  const drill = el("div", "fed-drill");
  drill.appendChild(
    el("div", "fed-muted", t("views.federation.drillLoading", {}, "Loading remote detail...")),
  );
  panel.appendChild(drill);
  loadDrillDown(row, drill);

  return panel;
}

async function loadDrillDown(row, host) {
  const seq = (detailSeq.get(row.id) || 0) + 1;
  detailSeq.set(row.id, seq);
  try {
    const payload = await fetchJson(
      `/api/fleet/federation/remotes/${encodeURIComponent(row.id)}/detail`,
    );
    if (detailSeq.get(row.id) !== seq || !host.isConnected) return;
    renderDrillDown(host, payload);
  } catch (err) {
    if (detailSeq.get(row.id) !== seq || !host.isConnected) return;
    host.replaceChildren(
      el(
        "div",
        "fed-card-error",
        t(
          "views.federation.drillError",
          { message: err.message },
          "Failed to load remote detail: {message}",
        ),
      ),
    );
  }
}

function renderDrillDown(host, { detail }) {
  host.replaceChildren();

  if (!detail) {
    host.appendChild(
      el(
        "div",
        "fed-muted",
        t(
          "views.federation.drillNoData",
          {},
          "No detail cached from this remote yet. It appears after the first successful poll.",
        ),
      ),
    );
    return;
  }

  host.appendChild(
    el(
      "div",
      "fed-detail-stamp",
      t(
        "views.federation.drillFetched",
        { value: formatAgo(detail.fetchedAt) },
        "Detail fetched: {value}",
      ),
    ),
  );
  host.appendChild(buildDetailNodes(detail.mesh));
  host.appendChild(buildDetailBoard(detail.kanban));
  host.appendChild(buildDetailAlerts(detail.alerts));
}

/** Helper: section wrapper with an uppercase title. */
function detailSection(titleText) {
  const section = el("div");
  section.appendChild(el("div", "fed-detail-section-title", titleText));
  return section;
}

function pct(value) {
  return isFiniteNumber(value) ? `${Math.round(value)}%` : "—";
}

function buildDetailNodes(mesh) {
  const section = detailSection(t("views.federation.drillNodes", {}, "Mesh nodes"));
  const nodes = mesh && Array.isArray(mesh.nodes) ? mesh.nodes : null;
  if (!nodes || nodes.length === 0) {
    section.appendChild(
      el("div", "fed-muted", t("views.federation.drillNoNodes", {}, "No node data.")),
    );
    return section;
  }
  for (const node of nodes) {
    const row = el("div", "fed-node-row");
    const dotClass =
      node.status === "online" ? "reachable" : node.status === "unknown" ? "" : "unreachable";
    const dot = el("span", `fed-status-dot ${dotClass}`.trim());
    dot.title = node.status;
    row.appendChild(dot);

    const name = node.hostname || node.label || node.id || "?";
    const port = isFiniteNumber(node.port) && node.port !== 443 ? `:${node.port}` : "";
    row.appendChild(el("span", "fed-node-name", `${name}${port}`));

    const vitals = el("span", "fed-node-vitals");
    if (node.vitals) {
      vitals.appendChild(el("span", null, `CPU ${pct(node.vitals.cpuPct)}`));
      vitals.appendChild(el("span", null, `MEM ${pct(node.vitals.memPct)}`));
      vitals.appendChild(el("span", null, `DISK ${pct(node.vitals.diskPct)}`));
    }
    if (isFiniteNumber(node.latencyMs)) {
      vitals.appendChild(el("span", null, `${Math.round(node.latencyMs)} ms`));
    }
    row.appendChild(vitals);
    section.appendChild(row);
  }
  return section;
}

const DRILL_TOP_CARDS = 3;

function buildDetailBoard(kanban) {
  const section = detailSection(t("views.federation.drillKanban", {}, "Kanban"));
  if (!kanban || !kanban.counts) {
    section.appendChild(
      el("div", "fed-muted", t("views.federation.drillNoKanban", {}, "No kanban data.")),
    );
    return section;
  }
  const tasks = Array.isArray(kanban.tasks) ? kanban.tasks : [];
  for (const status of TASK_STATUS_ORDER) {
    const row = el("div", "fed-detail-col");
    row.appendChild(el("span", "fed-detail-col-name", status));
    const count = isFiniteNumber(kanban.counts[status]) ? kanban.counts[status] : 0;
    row.appendChild(el("span", "fed-detail-col-count", String(count)));
    const top = tasks
      .filter((task) => task.status === status)
      .slice(0, DRILL_TOP_CARDS)
      .map((task) => (task.assignee ? `${task.title} (@${task.assignee})` : task.title));
    const cards = el("span", "fed-detail-col-cards", top.join(" · "));
    cards.title = top.join("\n");
    row.appendChild(cards);
    section.appendChild(row);
  }
  return section;
}

function buildDetailAlerts(alertsBlock) {
  const section = detailSection(t("views.federation.drillAlerts", {}, "Recent alerts"));
  const alerts = alertsBlock && Array.isArray(alertsBlock.alerts) ? alertsBlock.alerts : null;
  if (!alerts || alerts.length === 0) {
    section.appendChild(
      el("div", "fed-muted", t("views.federation.drillNoAlerts", {}, "No recent alerts.")),
    );
    return section;
  }
  for (const alert of alerts) {
    const row = el("div", "fed-alert-row");
    const severity = alert.severity || "info";
    row.appendChild(el("span", `fed-alert-sev ${severity}`, severity));
    const message = el(
      "span",
      "fed-alert-message",
      alert.message || alert.type || t("views.federation.drillAlertUnknown", {}, "(no message)"),
    );
    if (alert.node) message.title = `${alert.node}: ${alert.message || ""}`;
    row.appendChild(message);
    const ts = typeof alert.ts === "string" ? Date.parse(alert.ts) : alert.ts;
    row.appendChild(el("span", "fed-alert-when", formatAgo(ts)));
    section.appendChild(row);
  }
  return section;
}

/**
 * Gate toggle + pending lessons mini-list for a writes-enabled, reachable
 * remote. All actions go through the server's whitelisted proxy.
 */
function buildWriteControls(remote, status, summary) {
  const wrap = el("div", "fed-write-controls");
  wrap.appendChild(
    el(
      "div",
      "fed-write-controls-title",
      t("views.federation.remoteActions", {}, "Remote actions"),
    ),
  );

  // Gate control mirroring the remote gate state.
  const gate = summary && summary.evolution ? summary.evolution.gate : null;
  const gateRow = el("div", "fed-gate-row");
  gateRow.appendChild(
    el("span", null, t("views.federation.evolutionGateLabel", {}, "Evolution gate:")),
  );
  const gateClass = gate === true ? "on" : gate === false ? "off" : "unknown";
  gateRow.appendChild(
    el(
      "span",
      `fed-gate-badge ${gateClass}`,
      gate === true
        ? t("views.federation.gateGated", {}, "Gated")
        : gate === false
          ? t("views.federation.gateOpen", {}, "Open")
          : "—",
    ),
  );
  if (typeof gate === "boolean") {
    const gateBtn = el(
      "button",
      "fed-action-btn",
      gate
        ? t("views.federation.openGate", {}, "Open gate")
        : t("views.federation.closeGate", {}, "Close gate"),
    );
    gateBtn.type = "button";
    gateBtn.addEventListener("click", () =>
      proxyAction(remote, "gate.set", { gate: !gate }, gateBtn),
    );
    gateRow.appendChild(gateBtn);
  }
  wrap.appendChild(gateRow);

  // Pending lessons mini-list with per-lesson approve/reject.
  const lessons = Array.isArray(status.pendingLessons) ? status.pendingLessons : null;
  if (lessons && lessons.length > 0) {
    const lessonList = el("div", "fed-lessons");
    for (const lesson of lessons) {
      const row = el("div", "fed-lesson-row");
      const title = el("span", "fed-lesson-title", lesson.title || lesson.id);
      title.title = `${lesson.id}${lesson.ts ? ` · ${lesson.ts}` : ""}`;
      row.appendChild(title);
      if (lesson.author) row.appendChild(el("span", "fed-lesson-author", lesson.author));

      const approveBtn = el(
        "button",
        "fed-action-btn approve",
        t("views.federation.approve", {}, "Approve"),
      );
      approveBtn.type = "button";
      approveBtn.addEventListener("click", () =>
        proxyAction(remote, "lesson.approve", { lessonId: lesson.id }, approveBtn),
      );
      row.appendChild(approveBtn);

      const rejectBtn = el(
        "button",
        "fed-action-btn reject",
        t("views.federation.reject", {}, "Reject"),
      );
      rejectBtn.type = "button";
      rejectBtn.addEventListener("click", () =>
        proxyAction(remote, "lesson.reject", { lessonId: lesson.id }, rejectBtn),
      );
      row.appendChild(rejectBtn);
      lessonList.appendChild(row);
    }
    wrap.appendChild(lessonList);
  } else {
    wrap.appendChild(
      el(
        "div",
        "fed-muted",
        t("views.federation.noPendingLessons", {}, "No pending lessons on this remote."),
      ),
    );
  }

  return wrap;
}

/* ------------------------------------------------------------------ */
/* Mutations (LOCAL registry + whitelisted remote write proxy)          */
/* ------------------------------------------------------------------ */

/** Toggle the per-remote write opt-in (PATCH), confirming before enabling. */
async function toggleWrites(remote, button) {
  const name = remote.label || baseUrlHost(remote.baseUrl);
  const enabling = remote.allowWrites !== true;
  const confirmText = t(
    "views.federation.confirmEnableWrites",
    { name },
    'Enable write actions against "{name}"?\n\n' +
      "This dashboard will be able to approve/reject lessons, toggle the " +
      "evolution gate, and move tasks ON THE REMOTE dashboard. Every action " +
      "is audited on both sides under your identity. Only enable this for " +
      "remotes you operate and trust.",
  );
  if (enabling && !window.confirm(confirmText)) {
    return;
  }
  button.disabled = true;
  try {
    await fetchJson(`/api/fleet/federation/remotes/${encodeURIComponent(remote.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowWrites: enabling }),
    });
    showToast(
      enabling
        ? t("views.federation.writesEnabledToast", { name }, 'Write actions ENABLED for "{name}".')
        : t(
            "views.federation.writesDisabledToast",
            { name },
            'Write actions disabled for "{name}".',
          ),
      "success",
    );
    await refresh({ initial: false });
  } catch (err) {
    button.disabled = false;
    showToast(
      t(
        "views.federation.writesUpdateFailed",
        { message: err.message },
        "Failed to update write access: {message}",
      ),
      "error",
    );
  }
}

/**
 * Run one whitelisted write action against a remote via the server-side
 * proxy. Surfaces the remote's status clearly (403 writes-disabled, remote
 * 4xx/5xx, network failures) and optimistically refreshes the panel.
 */
async function proxyAction(remote, action, params, button) {
  const name = remote.label || baseUrlHost(remote.baseUrl);
  button.disabled = true;
  try {
    const payload = await fetchJson(
      `/api/fleet/federation/remotes/${encodeURIComponent(remote.id)}/actions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, params }),
      },
    );
    const result = payload && payload.result ? payload.result : {};
    if (result.ok) {
      showToast(
        t(
          "views.federation.actionSucceeded",
          { action, name, status: result.remoteStatus },
          '{action} succeeded on "{name}" (remote HTTP {status}).',
        ),
        "success",
      );
    } else {
      const detail =
        result.remoteBody && result.remoteBody.error ? ` — ${result.remoteBody.error}` : "";
      showToast(
        t(
          "views.federation.actionFailedRemote",
          { action, name, status: result.remoteStatus, detail },
          '{action} failed on "{name}": remote HTTP {status}{detail}',
        ),
        "error",
      );
    }
    await refresh({ initial: false });
  } catch (err) {
    // Local rejections: 403 writes-disabled, 400 validation, 502 unreachable.
    button.disabled = false;
    showToast(
      t(
        "views.federation.actionFailed",
        { action, name, message: err.message },
        '{action} failed on "{name}": {message}',
      ),
      "error",
    );
  }
}

/** Toast using the dashboard's global .toast styles (same as cortex view). */
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

async function removeRemote(remote, button) {
  const name = remote.label || baseUrlHost(remote.baseUrl);
  const confirmText = t(
    "views.federation.confirmRemove",
    { name },
    'Remove remote dashboard "{name}" from federation?',
  );
  if (!window.confirm(confirmText)) return;
  button.disabled = true;
  try {
    await fetchJson(`/api/fleet/federation/remotes/${encodeURIComponent(remote.id)}`, {
      method: "DELETE",
    });
    await refresh({ initial: false });
  } catch (err) {
    button.disabled = false;
    window.alert(
      t(
        "views.federation.removeFailed",
        { message: err.message },
        "Failed to remove remote: {message}",
      ),
    );
  }
}

async function onAddSubmit(event) {
  event.preventDefault();
  if (!refs) return;

  const body = {
    label: refs.addLabel.value.trim(),
    baseUrl: refs.addUrl.value.trim(),
  };
  const token = refs.addToken.value;
  if (token) body.token = token;

  refs.addBtn.disabled = true;
  refs.addBtn.textContent = t("views.federation.adding", {}, "Adding...");
  refs.addError.hidden = true;

  try {
    await fetchJson("/api/fleet/federation/remotes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!refs) return;
    refs.addForm.reset();
    await refresh({ initial: false });
  } catch (err) {
    if (!refs) return;
    refs.addError.hidden = false;
    refs.addError.textContent = t(
      "views.federation.addFailed",
      { message: err.message },
      "Failed to add remote: {message}",
    );
  } finally {
    if (refs) {
      refs.addBtn.disabled = false;
      refs.addBtn.textContent = t("views.federation.addBtn", {}, "Add remote");
    }
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                        */
/* ------------------------------------------------------------------ */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function formatAgo(stamp) {
  if (!isFiniteNumber(stamp)) return t("time.never", {}, "never");
  const deltaSec = Math.max(0, Math.floor((Date.now() - stamp) / 1000));
  if (deltaSec < 10) return t("time.relJustNow", {}, "just now");
  if (deltaSec < 60) return t("time.agoSeconds", { n: deltaSec }, "{n}s ago");
  if (deltaSec < 3600) return t("time.agoMinutes", { n: Math.floor(deltaSec / 60) }, "{n}m ago");
  if (deltaSec < 86400) return t("time.agoHours", { n: Math.floor(deltaSec / 3600) }, "{n}h ago");
  return new Date(stamp).toLocaleDateString();
}
