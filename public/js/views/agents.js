/**
 * Agents View — unified fleet-wide agents roster (READ-ONLY), rendered as a
 * dense detail list ("neat file list").
 *
 * Loaded on demand by views.js, which calls init(containerEl) on EVERY visit
 * of the view. The partial HTML is re-injected fresh each visit, so init()
 * re-queries the DOM from scratch and tears down timers left over from a
 * previous visit (module scope persists).
 *
 * Data source: GET /api/agents/fleet — local agents enriched with session
 * activity plus best-effort agents from every online mesh node AND every
 * reachable federation remote (the server caches the aggregation for 60s;
 * the view polls on the same cadence). Federation-sourced agents carry a
 * "via federation" badge next to their node; every row shows its source
 * (openclaw/hermes).
 *
 * Rendering: the shared detail-list component (sortable columns, text filter,
 * expandable full-metadata panel). The node <select> and "active only"
 * toggle are preserved and applied to the row set before each list.update().
 *
 * All agent data is rendered via textContent / createElement — no innerHTML
 * with remote strings — so hostile agent names/models/workspaces from remote
 * nodes cannot inject markup.
 */

import { t } from "../utils.js";
import { createDetailList } from "../components/detail-list.js";

const REFRESH_INTERVAL_MS = 60000;

// --- Module-level lifecycle state (persists across visits) -----------------

let refs = null; // DOM references for the active visit
let refreshTimer = null;
let fetchSeq = 0; // guards against out-of-order responses
let list = null; // active detail-list instance

// Filter state survives refreshes within a visit; reset on each init().
let nodeFilter = "all";
let activeOnly = false;
let lastRoster = null;

// --- Pure helpers (exported for node:test) ----------------------------------

/**
 * Flatten the roster into detail-list rows, applying the node and
 * active-only filters. Row ids are node-scoped so the same agent id on two
 * nodes never collides.
 */
export function buildAgentRows(roster, { nodeFilter: node = "all", activeOnly: active = false }) {
  const agents = Array.isArray(roster && roster.agents) ? roster.agents : [];
  return agents
    .filter((agent) => node === "all" || agent.node === node)
    .filter((agent) => !active || agent.active === true)
    .map((agent) => ({
      id: `${agent.node || ""}/${agent.id || agent.name || ""}`,
      agentId: agent.id || "",
      name: agent.name || agent.id || "unknown",
      source: agent.source === "hermes" ? "hermes" : "openclaw",
      node: agent.node || "",
      via: agent.via === "federation" ? "federation" : "",
      model: agent.model || "",
      status: agent.active === true ? "active" : "idle",
      lastActiveAt: isFiniteNumber(agent.lastActiveAt) ? agent.lastActiveAt : null,
      agent,
    }));
}

/** Compact span ("30s"/"5m"/"3h"/"2d") from an epoch-ms timestamp. */
export function relativeSpan(epochMs, nowMs = Date.now()) {
  const deltaSec = Math.max(0, Math.floor((nowMs - epochMs) / 1000));
  if (deltaSec < 60) return `${deltaSec}s`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h`;
  return `${Math.floor(deltaSec / 86400)}d`;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// --- Entry point ------------------------------------------------------------

export function init(containerEl) {
  teardown();
  nodeFilter = "all";
  activeOnly = false;
  lastRoster = null;

  const root = containerEl.querySelector("#agents-view-section");
  if (!root) {
    console.error("[Agents] Partial markup missing #agents-view-section");
    return;
  }

  refs = {
    root,
    loading: root.querySelector("#agents-loading"),
    fetchError: root.querySelector("#agents-fetch-error"),
    body: root.querySelector("#agents-body"),
    summaryTotal: root.querySelector("#agents-summary-total"),
    summaryActive: root.querySelector("#agents-summary-active"),
    summaryNodes: root.querySelector("#agents-summary-nodes"),
    filters: root.querySelector("#agents-filters"),
    nodeSelect: root.querySelector("#agents-node-filter"),
    activeToggle: root.querySelector("#agents-active-only"),
    listHost: root.querySelector("#agents-list"),
    emptyState: root.querySelector("#agents-empty-state"),
  };

  buildList();

  refs.nodeSelect?.addEventListener("change", () => {
    nodeFilter = refs.nodeSelect.value || "all";
    renderRows();
  });
  refs.activeToggle?.addEventListener("change", () => {
    activeOnly = !!refs.activeToggle.checked;
    renderRows();
  });

  refresh({ initial: true });

  refreshTimer = setInterval(() => {
    if (!isActive()) {
      teardown();
      return;
    }
    refresh({ initial: false });
  }, REFRESH_INTERVAL_MS);
}

function teardown() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (list) {
    list.destroy();
    list = null;
  }
  refs = null;
}

/** The view is active while its root is still attached to the document. */
function isActive() {
  return !!(refs && refs.root && document.body.contains(refs.root));
}

// --- Data fetching ----------------------------------------------------------

async function fetchJson(url) {
  const response = await fetch(url);
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
    const roster = await fetchJson("/api/agents/fleet");
    if (seq !== fetchSeq || !isActive()) return;
    lastRoster = roster;
    renderRoster(roster);
  } catch (err) {
    if (seq !== fetchSeq || !isActive()) return;
    console.error("[Agents] Failed to fetch roster:", err);
    renderFetchError(initial, err);
  }
}

// --- Rendering: top-level state ----------------------------------------------

function renderFetchError(initial, err) {
  refs.loading.hidden = true;
  refs.fetchError.hidden = false;
  refs.fetchError.textContent = t(
    "views.agents.loadError",
    { message: err.message },
    "Failed to load the agents roster: {message}. Retrying automatically...",
  );
  // Keep showing the last good render (if any) under the error banner.
  if (initial) refs.body.hidden = true;
}

function renderRoster(roster) {
  refs.loading.hidden = true;
  refs.fetchError.hidden = true;
  refs.body.hidden = false;

  const agents = Array.isArray(roster && roster.agents) ? roster.agents : [];
  const counts = roster && roster.counts ? roster.counts : {};
  const hasAgents = agents.length > 0;

  refs.summaryTotal.textContent = String(isFiniteNumber(counts.total) ? counts.total : 0);
  refs.summaryActive.textContent = String(isFiniteNumber(counts.active) ? counts.active : 0);
  refs.summaryNodes.textContent = String(isFiniteNumber(counts.nodes) ? counts.nodes : 0);

  refs.filters.hidden = !hasAgents;
  refs.emptyState.hidden = hasAgents;
  refs.listHost.hidden = !hasAgents;

  if (hasAgents) renderNodeFilter(roster);
  renderRows();
}

/** Rebuild the node <select> options, preserving the current selection. */
function renderNodeFilter(roster) {
  const nodeNames = Object.keys(roster.byNode || {}).sort((a, b) => a.localeCompare(b));
  if (!nodeNames.includes(nodeFilter)) nodeFilter = "all";

  refs.nodeSelect.replaceChildren();
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = t("views.agents.filterAllNodes", {}, "All nodes");
  refs.nodeSelect.appendChild(allOption);

  for (const name of nodeNames) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    refs.nodeSelect.appendChild(option);
  }
  refs.nodeSelect.value = nodeFilter;
}

// --- Rendering: detail list ----------------------------------------------------

function renderRows() {
  if (!refs || !list) return;
  list.update(buildAgentRows(lastRoster || {}, { nodeFilter, activeOnly }));
}

function buildList() {
  if (list) {
    list.destroy();
    list = null;
  }
  refs.listHost.replaceChildren();
  list = createDetailList(refs.listHost, {
    columns: [
      {
        key: "name",
        label: t("views.agents.colAgent", {}, "Agent"),
        sortable: true,
        render: renderNameCell,
      },
      {
        key: "source",
        label: t("views.agents.colSource", {}, "Source"),
        sortable: true,
        render: (row) => el("span", `agent-source-chip agent-source-${row.source}`, row.source),
      },
      {
        key: "node",
        label: t("views.agents.colNode", {}, "Node"),
        sortable: true,
        render: renderNodeCell,
      },
      { key: "model", label: t("views.agents.colModel", {}, "Model"), sortable: true },
      {
        key: "status",
        label: t("views.agents.colStatus", {}, "Status"),
        sortable: true,
        render: renderStatusCell,
      },
      {
        key: "lastActiveAt",
        label: t("views.agents.colLastActive", {}, "Last active"),
        sortable: true,
        render: renderLastActiveCell,
      },
    ],
    getRowId: (row) => row.id,
    renderDetail: buildDetail,
    emptyText: t("views.agents.noMatch", {}, "No agents match the current filter."),
    filterKeys: ["name", "agentId", "source", "node", "model", "status"],
    filterPlaceholder: t("views.agents.filterPlaceholder", {}, "Filter agents…"),
    defaultSort: { key: "name", dir: "asc" },
  });
}

function renderNameCell(row) {
  const cell = el("span", "agents-name-cell");
  const dot = el("span", row.status === "active" ? "agent-active-dot active" : "agent-active-dot");
  dot.title =
    row.status === "active"
      ? t("views.agents.activeTooltip", {}, "Active in the last 10 minutes")
      : t("views.agents.idleTooltip", {}, "Idle");
  cell.appendChild(dot);
  cell.appendChild(el("span", "agents-name-text", row.name));
  if (row.agentId && row.agentId !== row.name) {
    cell.appendChild(el("span", "agents-id-text", row.agentId));
  }
  return cell;
}

/** Node name plus the "via federation" transport badge when applicable. */
function renderNodeCell(row) {
  const cell = el("span", "agents-node-cell", row.node || "—");
  if (row.via === "federation") {
    cell.appendChild(
      el("span", "agents-node-badge", t("views.agents.viaFederation", {}, "via federation")),
    );
  }
  return cell;
}

function renderStatusCell(row) {
  return el(
    "span",
    row.status === "active" ? "agent-stat agent-stat-active" : "agent-stat",
    row.status === "active"
      ? t("views.agents.statusActive", {}, "active")
      : t("views.agents.statusIdle", {}, "idle"),
  );
}

function renderLastActiveCell(row) {
  if (!isFiniteNumber(row.lastActiveAt)) {
    return el("span", "agents-muted", t("views.agents.never", {}, "never active"));
  }
  return el(
    "span",
    undefined,
    t("views.agents.ago", { span: relativeSpan(row.lastActiveAt) }, "{span} ago"),
  );
}

/** Expanded panel: full agent metadata. */
function buildDetail(row) {
  const agent = row.agent || {};
  const panel = el("div", "agents-detail");
  const add = (label, value, mono) => {
    if (value === undefined || value === null || value === "") return;
    const item = el("div", "agents-detail-item");
    item.appendChild(el("span", "agents-detail-label", label));
    item.appendChild(el("span", `agents-detail-value${mono ? " mono" : ""}`, String(value)));
    panel.appendChild(item);
  };

  add(t("views.agents.detailId", {}, "Agent id"), agent.id || row.name, true);
  add(t("views.agents.detailName", {}, "Name"), agent.name);
  add(t("views.agents.detailNode", {}, "Node"), row.node || "—");
  add(
    t("views.agents.detailTransport", {}, "Transport"),
    row.via === "federation"
      ? t("views.agents.viaFederation", {}, "via federation")
      : t("views.agents.viaMesh", {}, "mesh / local"),
  );
  add(t("views.agents.detailSource", {}, "Source"), row.source);
  add(t("views.agents.detailModel", {}, "Model"), agent.model, true);
  add(t("views.agents.detailWorkspace", {}, "Workspace"), agent.workspace, true);
  if (isFiniteNumber(agent.sessionCount)) {
    add(t("views.agents.detailSessions", {}, "Sessions"), agent.sessionCount);
  }
  if (isFiniteNumber(agent.subagentsMax)) {
    add(t("views.agents.detailSubagents", {}, "Subagents max"), agent.subagentsMax);
  }
  add(
    t("views.agents.detailLastActive", {}, "Last active"),
    isFiniteNumber(row.lastActiveAt)
      ? new Date(row.lastActiveAt).toLocaleString()
      : t("views.agents.never", {}, "never active"),
  );
  return panel;
}

// --- Small helpers ------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
