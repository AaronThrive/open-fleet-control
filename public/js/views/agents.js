/**
 * Agents View — unified fleet-wide agents roster (READ-ONLY).
 *
 * Loaded on demand by views.js, which calls init(containerEl) on EVERY visit
 * of the view. The partial HTML is re-injected fresh each visit, so init()
 * re-queries the DOM from scratch and tears down timers left over from a
 * previous visit (module scope persists).
 *
 * Data source: GET /api/agents/fleet — local agents enriched with session
 * activity plus best-effort agents from every online mesh node AND every
 * reachable federation remote (the server caches the aggregation for 60s;
 * the view polls on the same cadence). Federation-sourced node groups carry
 * a "via federation" badge; every card shows its source (openclaw/hermes).
 *
 * All agent data is rendered via textContent / createElement — no innerHTML
 * with remote strings — so hostile agent names/models/workspaces from remote
 * nodes cannot inject markup.
 */

import { t } from "../utils.js";

const REFRESH_INTERVAL_MS = 60000;

// --- Module-level lifecycle state (persists across visits) -----------------

let refs = null; // DOM references for the active visit
let refreshTimer = null;
let fetchSeq = 0; // guards against out-of-order responses

// Filter state survives refreshes within a visit; reset on each init().
let nodeFilter = "all";
let activeOnly = false;
let lastRoster = null;

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
    groups: root.querySelector("#agents-groups"),
    noMatch: root.querySelector("#agents-no-match"),
    emptyState: root.querySelector("#agents-empty-state"),
  };

  refs.nodeSelect?.addEventListener("change", () => {
    nodeFilter = refs.nodeSelect.value || "all";
    renderGroups();
  });
  refs.activeToggle?.addEventListener("change", () => {
    activeOnly = !!refs.activeToggle.checked;
    renderGroups();
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

  if (hasAgents) renderNodeFilter(roster);
  renderGroups();
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

// --- Rendering: node groups + agent cards -------------------------------------

function matchesFilter(agent) {
  if (activeOnly && !agent.active) return false;
  return true;
}

function renderGroups() {
  if (!refs || !lastRoster) return;
  const byNode =
    lastRoster.byNode && typeof lastRoster.byNode === "object" ? lastRoster.byNode : {};
  const nodeNames = Object.keys(byNode)
    .filter((name) => nodeFilter === "all" || name === nodeFilter)
    .sort((a, b) => a.localeCompare(b));

  refs.groups.replaceChildren();
  let visibleTotal = 0;

  for (const name of nodeNames) {
    const agents = (Array.isArray(byNode[name]) ? byNode[name] : []).filter(matchesFilter);
    if (agents.length === 0) continue;
    visibleTotal += agents.length;
    refs.groups.appendChild(buildNodeGroup(name, agents));
  }

  const totalAgents = Array.isArray(lastRoster.agents) ? lastRoster.agents.length : 0;
  refs.noMatch.hidden = visibleTotal > 0 || totalAgents === 0;
}

function buildNodeGroup(nodeName, agents) {
  const group = el("div", "agents-node-group");

  const header = el("div", "agents-node-header");
  header.appendChild(el("span", "agents-node-icon", "🖥️"));
  header.appendChild(el("span", "agents-node-name", nodeName));
  header.appendChild(
    el(
      "span",
      "agents-node-count",
      t("views.agents.nodeCount", { n: agents.length }, "{n} agents"),
    ),
  );
  // Federation-sourced nodes (reached via a registered federation remote
  // rather than the mesh) are flagged so operators know the transport.
  if (agents.some((agent) => agent.via === "federation")) {
    header.appendChild(
      el("span", "agents-node-badge", t("views.agents.viaFederation", {}, "via federation")),
    );
  }
  group.appendChild(header);

  const grid = el("div", "agents-grid");
  for (const agent of agents) {
    grid.appendChild(buildCard(agent));
  }
  group.appendChild(grid);

  return group;
}

function buildCard(agent) {
  const card = el("div", "agent-card");

  // Head: active dot, name/id, model chip
  const head = el("div", "agent-card-head");

  const dot = el("span", agent.active ? "agent-active-dot active" : "agent-active-dot");
  dot.title = agent.active
    ? t("views.agents.activeTooltip", {}, "Active in the last 10 minutes")
    : t("views.agents.idleTooltip", {}, "Idle");
  head.appendChild(dot);

  const names = el("div", "agent-card-names");
  names.appendChild(el("div", "agent-card-name", agent.name || agent.id || "unknown"));
  if (agent.name && agent.name !== agent.id) {
    names.appendChild(el("div", "agent-card-id", agent.id));
  }
  head.appendChild(names);

  if (agent.model) {
    const chip = el("span", "agent-model-chip", agent.model);
    chip.title = agent.model;
    head.appendChild(chip);
  }
  card.appendChild(head);

  // Stats: source chip, sessions, last active, subagents cap
  const stats = el("div", "agent-card-stats");
  const source = agent.source === "hermes" ? "hermes" : "openclaw";
  stats.appendChild(el("span", `agent-source-chip agent-source-${source}`, source));
  stats.appendChild(
    el(
      "span",
      "agent-stat",
      t("views.agents.sessions", { n: agent.sessionCount ?? 0 }, "{n} sessions"),
    ),
  );
  stats.appendChild(
    el(
      "span",
      agent.active ? "agent-stat agent-stat-active" : "agent-stat",
      isFiniteNumber(agent.lastActiveAt)
        ? t("views.agents.lastActive", { ago: formatRelative(agent.lastActiveAt) }, "active {ago}")
        : t("views.agents.never", {}, "never active"),
    ),
  );
  if (isFiniteNumber(agent.subagentsMax)) {
    stats.appendChild(
      el(
        "span",
        "agent-stat",
        t("views.agents.subagents", { n: agent.subagentsMax }, "{n} subagents max"),
      ),
    );
  }
  card.appendChild(stats);

  // Foot: workspace (truncated, full path in tooltip)
  if (agent.workspace) {
    const foot = el("div", "agent-card-foot");
    const workspace = el("span", "agent-workspace", agent.workspace);
    workspace.title = agent.workspace;
    foot.appendChild(workspace);
    card.appendChild(foot);
  }

  return card;
}

// --- Small helpers ------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** Compact "Ns/Nm/Nh/Nd ago" from an epoch-ms timestamp. */
function formatRelative(epochMs) {
  const deltaSec = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  let span;
  if (deltaSec < 60) span = `${deltaSec}s`;
  else if (deltaSec < 3600) span = `${Math.floor(deltaSec / 60)}m`;
  else if (deltaSec < 86400) span = `${Math.floor(deltaSec / 3600)}h`;
  else span = `${Math.floor(deltaSec / 86400)}d`;
  return t("views.agents.ago", { span }, "{span} ago");
}
