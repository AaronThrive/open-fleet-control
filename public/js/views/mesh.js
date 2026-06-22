/**
 * Mesh View — fleet node topology, reachability, and health.
 *
 * Loaded on demand by views.js, which calls init(containerEl) on EVERY
 * visit of the view. The partial HTML is re-injected fresh each visit, so
 * init() re-queries the DOM from scratch and tears down any timers / SSE
 * connections left over from a previous visit (module scope persists).
 *
 * Data sources:
 *   GET    /api/fleet/mesh            — registered nodes + self identity
 *   GET    /api/fleet/mesh/discover   — tailnet peers (registered flag)
 *   POST   /api/fleet/mesh/nodes      — register a node
 *   DELETE /api/fleet/mesh/nodes/:id  — unregister a node
 *   GET    /api/fleet/costs           — fleet-wide cost rollup
 *   GET    /api/state                 — own vitals for the self card (local)
 *   SSE    /api/events  (event "fleet.mesh") — node status transitions
 */

import { t } from "../utils.js";

const REFRESH_INTERVAL_MS = 30000;
const SSE_REFETCH_DEBOUNCE_MS = 300;

const PLATFORM_BADGES = {
  linux: "🐧 linux",
  "windows-wsl": "🪟 windows-wsl",
  macos: "🍎 macos",
  unknown: "❓ unknown",
};

// --- Module-level lifecycle state (persists across visits) -----------------

let refs = null; // DOM references for the active visit
let refreshTimer = null;
let eventSource = null;
let sseDebounceTimer = null;
let fetchSeq = 0; // guards against out-of-order responses

// Multi-select bulk operations (v2.2): node ids selected via card checkboxes,
// acted on through POST /api/fleet/bulk. Selection survives re-renders within
// a visit; ids of unregistered nodes are pruned on every render.
const selectedNodes = new Set();
const nodeNameById = new Map(); // id → hostname, for readable bulk results
let bulkRefs = null; // { bar, count, results } injected above the grid

// --- Entry point ------------------------------------------------------------

export function init(containerEl) {
  teardown();

  const root = containerEl.querySelector("#mesh-view-section");
  if (!root) {
    console.error("[Mesh] Partial markup missing #mesh-view-section");
    return;
  }

  refs = {
    root,
    loading: root.querySelector("#mesh-loading"),
    fetchError: root.querySelector("#mesh-fetch-error"),
    body: root.querySelector("#mesh-body"),
    tsWarning: root.querySelector("#mesh-ts-warning"),
    tsErrorDetail: root.querySelector("#mesh-ts-error-detail"),
    selfCard: root.querySelector("#mesh-self-card"),
    selfHostname: root.querySelector("#mesh-self-hostname"),
    selfFqdn: root.querySelector("#mesh-self-fqdn"),
    selfVitals: root.querySelector("#mesh-self-vitals"),
    costs: root.querySelector("#mesh-costs"),
    cost24h: root.querySelector("#mesh-cost-24h"),
    cost7d: root.querySelector("#mesh-cost-7d"),
    costReporting: root.querySelector("#mesh-cost-reporting"),
    grid: root.querySelector("#mesh-grid"),
    emptyState: root.querySelector("#mesh-empty-state"),
    emptyCta: root.querySelector("#mesh-empty-cta"),
    discoverBtn: root.querySelector("#mesh-discover-btn"),
    peerList: root.querySelector("#mesh-peer-list"),
    pruneBtn: root.querySelector("#mesh-prune-btn"),
  };

  refs.discoverBtn?.addEventListener("click", () => runDiscovery());
  refs.emptyCta?.addEventListener("click", () => runDiscovery());
  refs.pruneBtn?.addEventListener("click", () => pruneStaleSessions());

  refreshAll({ initial: true });

  refreshTimer = setInterval(() => {
    if (!isActive()) {
      teardown();
      return;
    }
    refreshAll({ initial: false });
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
  refs = null;
  bulkRefs = null;
  selectedNodes.clear();
}

/** The view is active while its root is still attached to the document. */
function isActive() {
  return !!(refs && refs.root && document.body.contains(refs.root));
}

// --- Live updates -----------------------------------------------------------

function connectSSE() {
  if (typeof EventSource === "undefined") return;
  try {
    eventSource = new EventSource("/api/events");
    eventSource.addEventListener("fleet.mesh", () => {
      // Debounce: several nodes can transition in one poll sweep.
      if (sseDebounceTimer) clearTimeout(sseDebounceTimer);
      sseDebounceTimer = setTimeout(() => {
        sseDebounceTimer = null;
        if (!isActive()) {
          teardown();
          return;
        }
        refreshAll({ initial: false });
      }, SSE_REFETCH_DEBOUNCE_MS);
    });
    eventSource.onerror = () => {
      // The 30s poll keeps the panel fresh; retry SSE lazily.
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      setTimeout(() => {
        if (isActive() && !eventSource) connectSSE();
      }, 5000);
    };
  } catch (err) {
    console.error("[Mesh] SSE connect failed:", err);
  }
}

// --- Data fetching ----------------------------------------------------------

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

async function refreshAll({ initial }) {
  if (!isActive()) return;
  const seq = ++fetchSeq;

  try {
    const state = await fetchJson("/api/fleet/mesh");
    if (seq !== fetchSeq || !isActive()) return;
    renderState(state);
  } catch (err) {
    if (seq !== fetchSeq || !isActive()) return;
    console.error("[Mesh] Failed to fetch mesh state:", err);
    renderFetchError(initial, err);
    return;
  }

  // Costs are best-effort: never block or break the main panel.
  try {
    const costs = await fetchJson("/api/fleet/costs");
    if (seq !== fetchSeq || !isActive()) return;
    renderCosts(costs);
  } catch (err) {
    if (seq === fetchSeq && refs) refs.costs.hidden = true;
  }

  // Self vitals are best-effort too: this dashboard's own /api/state always
  // carries a vitals block (same software), so the self card can show them
  // without any remote fetch.
  try {
    const ownState = await fetchJson("/api/state");
    if (seq !== fetchSeq || !isActive()) return;
    renderSelfVitals(ownState && ownState.vitals);
  } catch (err) {
    if (seq === fetchSeq && refs && refs.selfVitals) refs.selfVitals.hidden = true;
  }
}

// --- Rendering: top-level state ----------------------------------------------

function renderFetchError(initial, err) {
  refs.loading.hidden = true;
  refs.fetchError.hidden = false;
  refs.fetchError.textContent = t(
    "views.mesh.loadError",
    { message: err.message },
    "Failed to load mesh state: {message}. Retrying automatically...",
  );
  // Keep showing the last good render (if any) under the error banner.
  if (initial) refs.body.hidden = true;
}

function renderState(state) {
  refs.loading.hidden = true;
  refs.fetchError.hidden = true;
  refs.body.hidden = false;

  renderSelf(state);
  renderNodes(
    Array.isArray(state.nodes) ? state.nodes : [],
    Array.isArray(state.hosts) ? state.hosts : null,
  );
}

function renderSelf(state) {
  const available = !!(state.tailscale && state.tailscale.available);

  refs.tsWarning.hidden = available;
  if (!available) {
    const detail = state.tailscale && state.tailscale.error ? `(${state.tailscale.error})` : "";
    refs.tsErrorDetail.textContent = detail;
  }

  if (state.self && state.self.hostname) {
    refs.selfCard.hidden = false;
    refs.selfHostname.textContent = state.self.hostname;
    const suffix = state.self.magicDnsSuffix ? ` · ${state.self.magicDnsSuffix}` : "";
    refs.selfFqdn.textContent = (state.self.fqdn || "") + suffix;
  } else {
    refs.selfCard.hidden = true;
  }
}

function renderCosts(costs) {
  const totals = costs && costs.totals;
  const hasData =
    totals &&
    typeof totals.nodesReporting === "number" &&
    totals.nodesReporting > 0 &&
    (isFiniteNumber(totals.cost24h) || isFiniteNumber(totals.cost7d));

  if (!hasData) {
    refs.costs.hidden = true;
    return;
  }
  refs.costs.hidden = false;
  refs.cost24h.textContent = formatCost(totals.cost24h);
  refs.cost7d.textContent = formatCost(totals.cost7d);
  refs.costReporting.textContent = String(totals.nodesReporting);
}

function renderSelfVitals(rawVitals) {
  if (!refs || !refs.selfVitals) return;
  const section = buildVitalsSection(rawVitals);
  if (!section) {
    refs.selfVitals.hidden = true;
    refs.selfVitals.replaceChildren();
    return;
  }
  refs.selfVitals.hidden = false;
  refs.selfVitals.replaceChildren(...section.childNodes);
}

// --- Self quick-action: clean stale sessions (migrated from Overview) --------

/**
 * Prune stale agent-session entries on this host. Confirm first, then call the
 * legacy action endpoint (GET /api/action?action=prune-stale, which returns a
 * { success, output, error } body — not the fleet JSON envelope), then refresh
 * so the self vitals reflect any reclaimed resources.
 */
async function pruneStaleSessions() {
  if (!refs || !refs.pruneBtn) return;
  const confirmText = t(
    "views.mesh.confirmPruneStale",
    {},
    "Clean stale session entries on this host? This removes orphaned/finished session records.",
  );
  if (!window.confirm(confirmText)) return;

  const btn = refs.pruneBtn;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = t("views.mesh.pruning", {}, "Cleaning…");

  try {
    const response = await fetch("/api/action?action=prune-stale");
    let data = null;
    try {
      data = await response.json();
    } catch (err) {
      /* non-JSON body */
    }
    const ok = response.ok && data && data.success;
    if (ok) {
      window.alert(
        t(
          "views.mesh.pruneDone",
          { output: String(data.output || "Done") },
          "Stale sessions cleaned: {output}",
        ),
      );
    } else {
      const detail = (data && (data.error || data.output)) || `HTTP ${response.status}`;
      window.alert(
        t("views.mesh.pruneFailed", { message: String(detail) }, "Cleanup failed: {message}"),
      );
    }
  } catch (err) {
    window.alert(
      t("views.mesh.pruneFailed", { message: err.message }, "Cleanup failed: {message}"),
    );
  } finally {
    if (refs && refs.pruneBtn) {
      btn.disabled = false;
      btn.textContent = original;
    }
    // Refresh vitals/topology regardless of outcome (best-effort).
    if (isActive()) refreshAll({ initial: false });
  }
}

// --- Rendering: vitals ----------------------------------------------------------

/**
 * Tolerant reader: accepts both the mesh-normalized vitals shape
 * ({pct, load, percent}) and the raw /api/state shape ({percent, loadAvg,
 * usage}). Any missing leaf degrades to null.
 */
function normalizeVitals(raw) {
  if (!raw || typeof raw !== "object") return null;
  const cpu = raw.cpu && typeof raw.cpu === "object" ? raw.cpu : {};
  const memory = raw.memory && typeof raw.memory === "object" ? raw.memory : {};
  const disk = raw.disk && typeof raw.disk === "object" ? raw.disk : {};
  const num = (...vals) => {
    for (const v of vals) if (isFiniteNumber(v)) return v;
    return null;
  };
  return {
    uptime: typeof raw.uptime === "string" || isFiniteNumber(raw.uptime) ? raw.uptime : null,
    cpu: {
      load: num(cpu.load, Array.isArray(cpu.loadAvg) ? cpu.loadAvg[0] : null),
      percent: num(cpu.percent, cpu.usage, cpu.pct),
      cores: num(cpu.cores),
    },
    memory: {
      used: num(memory.used),
      total: num(memory.total),
      pct: num(memory.pct, memory.percent),
    },
    disk: {
      used: num(disk.used),
      free: num(disk.free),
      total: num(disk.total),
      pct: num(disk.pct, disk.percent),
    },
    temperature: num(raw.temperature),
  };
}

/** Percentage to display: explicit pct, else derived from used/total. */
function resolvePct(pct, used, total) {
  if (isFiniteNumber(pct)) return clampPct(pct);
  if (isFiniteNumber(used) && isFiniteNumber(total) && total > 0) {
    return clampPct((used / total) * 100);
  }
  return null;
}

function clampPct(value) {
  return Math.max(0, Math.min(100, value));
}

function pctSeverity(pct) {
  if (pct >= 90) return "crit";
  if (pct >= 75) return "warn";
  return "";
}

/** One labeled neon bar: LABEL [====  ] 72% — tooltip carries absolutes. */
function buildVitalBar(label, pct, valueText, tooltip) {
  const row = el("div", "mesh-vital");
  if (tooltip) row.title = tooltip;
  row.appendChild(el("span", "mesh-vital-label", label));
  const bar = el("span", "mesh-vital-bar");
  const fill = el("span", `mesh-vital-fill ${pctSeverity(pct)}`.trim());
  fill.style.width = `${clampPct(pct)}%`;
  bar.appendChild(fill);
  row.appendChild(bar);
  row.appendChild(el("span", "mesh-vital-value", valueText));
  return row;
}

/**
 * Compact vitals block (mem / disk / cpu bars + uptime line) for a node
 * card or the self card. Returns null when the node reports nothing —
 * older versions without a vitals block are quietly omitted.
 */
function buildVitalsSection(rawVitals) {
  const vitals = normalizeVitals(rawVitals);
  if (!vitals) return null;

  const section = el("div", "mesh-node-vitals");

  const memPct = resolvePct(vitals.memory.pct, vitals.memory.used, vitals.memory.total);
  if (memPct !== null) {
    const abs = formatUsedTotal(vitals.memory.used, vitals.memory.total);
    section.appendChild(
      buildVitalBar(
        t("views.mesh.vitalsMem", {}, "MEM"),
        memPct,
        `${Math.round(memPct)}%${abs ? ` · ${abs}` : ""}`,
        t(
          "views.mesh.vitalsMemTooltip",
          { used: formatBytes(vitals.memory.used), total: formatBytes(vitals.memory.total) },
          "Memory: {used} used of {total}",
        ),
      ),
    );
  }

  const diskPct = resolvePct(vitals.disk.pct, vitals.disk.used, vitals.disk.total);
  if (diskPct !== null) {
    const abs = formatUsedTotal(vitals.disk.used, vitals.disk.total);
    section.appendChild(
      buildVitalBar(
        t("views.mesh.vitalsDisk", {}, "DISK"),
        diskPct,
        `${Math.round(diskPct)}%${abs ? ` · ${abs}` : ""}`,
        t(
          "views.mesh.vitalsDiskTooltip",
          {
            used: formatBytes(vitals.disk.used),
            total: formatBytes(vitals.disk.total),
            free: formatBytes(vitals.disk.free),
          },
          "Disk: {used} used of {total} ({free} free)",
        ),
      ),
    );
  }

  if (vitals.cpu.percent !== null) {
    const loadPart = vitals.cpu.load !== null ? ` · load ${vitals.cpu.load.toFixed(2)}` : "";
    section.appendChild(
      buildVitalBar(
        t("views.mesh.vitalsCpu", {}, "CPU"),
        vitals.cpu.percent,
        `${Math.round(clampPct(vitals.cpu.percent))}%${loadPart}`,
        t(
          "views.mesh.vitalsCpuTooltip",
          {
            percent: Math.round(clampPct(vitals.cpu.percent)),
            load: vitals.cpu.load !== null ? vitals.cpu.load.toFixed(2) : "—",
            cores: vitals.cpu.cores !== null ? vitals.cpu.cores : "—",
          },
          "CPU: {percent}% busy · load {load} · {cores} cores",
        ),
      ),
    );
  } else if (vitals.cpu.load !== null) {
    const meta = el(
      "div",
      "mesh-vital-meta",
      t("views.mesh.vitalsLoad", { load: vitals.cpu.load.toFixed(2) }, "load {load}"),
    );
    if (vitals.cpu.cores !== null) meta.title = `load avg / ${vitals.cpu.cores} cores`;
    section.appendChild(meta);
  }

  const uptimeText = formatUptime(vitals.uptime);
  if (uptimeText || vitals.temperature !== null) {
    const parts = [];
    if (uptimeText) parts.push(t("views.mesh.vitalsUptime", { value: uptimeText }, "up {value}"));
    if (vitals.temperature !== null) parts.push(`${Math.round(vitals.temperature)}°C`);
    const meta = el("div", "mesh-vital-meta", parts.join(" · "));
    if (uptimeText) {
      meta.title = t("views.mesh.vitalsUptimeTooltip", { value: uptimeText }, "Uptime: {value}");
    }
    section.appendChild(meta);
  }

  return section.childNodes.length > 0 ? section : null;
}

function formatUsedTotal(used, total) {
  if (!isFiniteNumber(used) || !isFiniteNumber(total)) return "";
  return `${formatBytes(used)}/${formatBytes(total)}`;
}

function formatBytes(value) {
  if (!isFiniteNumber(value) || value < 0) return "—";
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (value >= GB) return `${(value / GB).toFixed(1)}G`;
  if (value >= MB) return `${(value / MB).toFixed(0)}M`;
  return `${Math.round(value / 1024)}K`;
}

/** Uptime arrives as a preformatted string ("54 days") or seconds. */
function formatUptime(uptime) {
  if (typeof uptime === "string" && uptime.trim()) return uptime.trim();
  if (!isFiniteNumber(uptime) || uptime < 0) return "";
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// --- Rendering: node grid -----------------------------------------------------

/**
 * Render the registered fleet as a two-tier topology: one whole-VPS host
 * summary card per physical host (top), with that host's individual node
 * cards grouped beneath it (bottom). `hosts` is the backend grouping
 * (state.hosts); when absent (older backend) it is derived client-side so the
 * view degrades gracefully. Multi-VPS aware — each host becomes its own group.
 */
function renderNodes(nodes, hosts) {
  const hasNodes = nodes.length > 0;
  refs.emptyState.hidden = hasNodes;
  refs.grid.hidden = !hasNodes;
  refs.grid.replaceChildren();

  // Prune selected ids that no longer correspond to a registered node.
  const liveIds = new Set(nodes.map((n) => n.id).filter(Boolean));
  for (const id of [...selectedNodes]) {
    if (!liveIds.has(id)) selectedNodes.delete(id);
  }
  nodeNameById.clear();
  for (const node of nodes) {
    if (node.id) nodeNameById.set(node.id, node.hostname || node.id);
  }
  ensureBulkBar();
  updateBulkBar();

  if (!hasNodes) return;

  // Version skew: more than one distinct known version across the fleet.
  const versions = new Set(
    nodes.map((node) => getHealth(node).version).filter((v) => typeof v === "string" && v),
  );
  const hasSkew = versions.size > 1;

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const groups = Array.isArray(hosts) && hosts.length > 0 ? hosts : deriveHostGroups(nodes);

  for (const host of groups) {
    const members = (Array.isArray(host.nodeIds) ? host.nodeIds : [])
      .map((id) => nodeById.get(id))
      .filter(Boolean);
    if (members.length === 0) continue;
    refs.grid.appendChild(buildHostGroup(host, members, hasSkew));
  }
}

/**
 * Client-side fallback grouping by reported host (vitals.hostname) when the
 * backend does not supply a `hosts` array. Mirrors the server's grouping key.
 */
function deriveHostGroups(nodes) {
  const order = [];
  const byKey = new Map();
  for (const node of nodes) {
    const reported =
      node.vitals && typeof node.vitals.hostname === "string" && node.vitals.hostname
        ? node.vitals.hostname
        : null;
    const hostId = reported || node.hostname || "unknown";
    if (!byKey.has(hostId)) {
      byKey.set(hostId, { hostId, hostname: hostId, vitals: node.vitals || null, nodeIds: [node.id] });
      order.push(hostId);
    } else {
      const host = byKey.get(hostId);
      host.nodeIds.push(node.id);
      if (!host.vitals && node.vitals) host.vitals = node.vitals;
    }
  }
  return order.map((key) => byKey.get(key));
}

/** A host group: whole-VPS summary card + its member node cards. */
function buildHostGroup(host, members, hasSkew) {
  const group = el("div", "mesh-host-group");
  group.appendChild(buildHostCard(host, members.length));

  const nodeGrid = el("div", "mesh-host-nodes");
  for (const node of members) {
    nodeGrid.appendChild(buildNodeCard(node, hasSkew));
  }
  group.appendChild(nodeGrid);
  return group;
}

/**
 * Whole-VPS summary card: host name + total memory / disk / cpu for the
 * physical host. Vitals are taken verbatim from the backend grouping (never
 * synthesized); when no member reported vitals, an honest note is shown
 * instead of fabricated numbers.
 */
function buildHostCard(host, nodeCount) {
  const card = el("div", "mesh-host-card");

  const head = el("div", "mesh-host-head");
  head.appendChild(el("span", "mesh-host-icon", "🖥️"));
  head.appendChild(el("div", "mesh-host-name", host.hostname || "unknown"));
  head.appendChild(
    el(
      "span",
      "mesh-host-count",
      t("views.mesh.hostNodeCount", { n: nodeCount }, "{n} node(s)"),
    ),
  );
  head.appendChild(el("span", "mesh-host-tag", t("views.mesh.hostTag", {}, "VPS host")));
  card.appendChild(head);

  const vitalsSection = buildVitalsSection(host.vitals);
  if (vitalsSection) {
    vitalsSection.classList.add("mesh-host-vitals");
    card.appendChild(vitalsSection);
  } else {
    card.appendChild(
      el(
        "div",
        "mesh-host-no-vitals",
        t("views.mesh.hostNoVitals", {}, "Whole-host metrics unavailable for this VPS."),
      ),
    );
  }
  return card;
}

/** Health may be nested (live API) or flattened (older shapes); handle both. */
function getHealth(node) {
  const h = node.health && typeof node.health === "object" ? node.health : node;
  return {
    status: h.status || "unknown",
    latencyMs: isFiniteNumber(h.latencyMs) ? h.latencyMs : null,
    lastChecked: h.lastChecked ?? null,
    lastOnline: h.lastOnline ?? null,
    consecutiveFailures: h.consecutiveFailures ?? 0,
    samples: Array.isArray(h.latencySamples)
      ? h.latencySamples
      : Array.isArray(h.latencyHistory)
        ? h.latencyHistory
        : [],
    version: h.version ?? null,
  };
}

function buildNodeCard(node, hasSkew) {
  const health = getHealth(node);
  const card = el("div", "mesh-node-card");

  // Head: select checkbox, status dot, hostname/label, platform badge
  const head = el("div", "mesh-node-head");
  if (node.id) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "mesh-node-select";
    checkbox.checked = selectedNodes.has(node.id);
    checkbox.title = t("views.mesh.selectNode", {}, "Select node for bulk actions");
    checkbox.setAttribute("aria-label", checkbox.title);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedNodes.add(node.id);
      else selectedNodes.delete(node.id);
      updateBulkBar();
    });
    head.appendChild(checkbox);
  }
  const dot = el("span", `mesh-status-dot ${health.status}`);
  if (health.status === "unreachable") {
    dot.title = t(
      "views.mesh.unreachableTooltip",
      {},
      "Peer online but health endpoint unreachable — check tailscale serve config",
    );
  } else {
    dot.title = t("views.mesh.statusTooltip", { status: health.status }, "Status: {status}");
  }
  head.appendChild(dot);

  const names = el("div", "mesh-node-names");
  names.appendChild(el("div", "mesh-node-hostname", node.hostname || "unknown"));
  if (node.label && node.label !== node.hostname) {
    names.appendChild(el("div", "mesh-node-label", node.label));
  }
  head.appendChild(names);

  const platform = node.platform || "unknown";
  head.appendChild(
    el("span", "mesh-platform-badge", PLATFORM_BADGES[platform] || `❓ ${platform}`),
  );
  card.appendChild(head);

  // Latency + sparkline
  const latencyRow = el("div", "mesh-node-latency");
  const latencyText = health.latencyMs !== null ? `${Math.round(health.latencyMs)} ms` : "— ms";
  latencyRow.appendChild(el("span", "mesh-latency-value", latencyText));
  const spark = buildSparkline(health.samples);
  if (spark) latencyRow.appendChild(spark);
  card.appendChild(latencyRow);

  // Vitals: mem/disk/cpu bars + uptime — quietly omitted when the node does
  // not report vitals (older versions / non-OFC services on the port).
  const vitalsSection = buildVitalsSection(node.vitals);
  if (vitalsSection) card.appendChild(vitalsSection);

  // Foot: version chip, last seen, unregister
  const foot = el("div", "mesh-node-foot");
  if (health.version) {
    const chip = el("span", "mesh-version-chip", `v${health.version}`);
    if (hasSkew) {
      chip.classList.add("skew");
      chip.title = t(
        "views.mesh.versionSkew",
        {},
        "Version skew detected — nodes in this fleet run different versions",
      );
    }
    foot.appendChild(chip);
  }
  foot.appendChild(
    el(
      "span",
      "mesh-last-seen",
      t("views.mesh.lastSeen", { value: formatLastSeen(health) }, "Last seen: {value}"),
    ),
  );

  const removeBtn = el(
    "button",
    "mesh-unregister-btn",
    t("views.mesh.unregister", {}, "Unregister"),
  );
  removeBtn.type = "button";
  removeBtn.addEventListener("click", () => unregisterNode(node, removeBtn));
  foot.appendChild(removeBtn);
  card.appendChild(foot);

  return card;
}

async function unregisterNode(node, button) {
  const name =
    node.label && node.label !== node.hostname ? `${node.hostname} (${node.label})` : node.hostname;
  const confirmText = t(
    "views.mesh.confirmUnregister",
    { name },
    'Unregister node "{name}" from the mesh?',
  );
  if (!window.confirm(confirmText)) return;
  button.disabled = true;
  try {
    await fetchJson(`/api/fleet/mesh/nodes/${encodeURIComponent(node.id || node.hostname)}`, {
      method: "DELETE",
    });
    await refreshAll({ initial: false });
  } catch (err) {
    button.disabled = false;
    window.alert(
      t(
        "views.mesh.unregisterFailed",
        { message: err.message },
        "Failed to unregister node: {message}",
      ),
    );
  }
}

/** Inline SVG sparkline (~120x28) from latency samples. No libraries. */
function buildSparkline(samples) {
  const data = samples.filter(isFiniteNumber);
  if (data.length < 2) return null;

  const width = 120;
  const height = 28;
  const pad = 2;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;

  const points = data
    .map((value, i) => {
      const x = pad + (i / (data.length - 1)) * (width - pad * 2);
      const y = height - pad - ((value - min) / range) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const SVG_NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "mesh-sparkline");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("aria-hidden", "true");

  const polyline = document.createElementNS(SVG_NS, "polyline");
  polyline.setAttribute("points", points);
  svg.appendChild(polyline);

  const title = document.createElementNS(SVG_NS, "title");
  title.textContent = t(
    "views.mesh.sparklineTitle",
    { count: data.length, min: Math.round(min), max: Math.round(max) },
    "Latency last {count} checks: min {min} ms, max {max} ms",
  );
  svg.insertBefore(title, polyline);

  return svg;
}

// --- Rendering: discovery -----------------------------------------------------

async function runDiscovery() {
  if (!refs) return;
  const btn = refs.discoverBtn;
  btn.disabled = true;
  btn.textContent = t("views.mesh.discovering", {}, "Discovering...");
  refs.peerList.replaceChildren(
    el("div", "mesh-muted", t("views.mesh.scanning", {}, "Scanning tailnet peers...")),
  );
  scrollDiscoveryIntoView();

  try {
    const result = await fetchJson("/api/fleet/mesh/discover");
    if (!isActive()) return;
    renderDiscovery(result);
  } catch (err) {
    if (!refs) return;
    refs.peerList.replaceChildren(
      el(
        "div",
        "mesh-error",
        t("views.mesh.discoveryFailed", { message: err.message }, "Discovery failed: {message}"),
      ),
    );
  } finally {
    if (refs) {
      btn.disabled = false;
      btn.textContent = t("views.mesh.discoverBtn", {}, "Discover nodes");
    }
  }
}

function scrollDiscoveryIntoView() {
  const section = refs.root.querySelector("#mesh-discovery");
  section?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderDiscovery(result) {
  refs.peerList.replaceChildren();

  if (result && result.available === false) {
    refs.peerList.appendChild(
      el(
        "div",
        "mesh-warning",
        t(
          "views.mesh.tailscaleUnavailable",
          { error: result.error || "" },
          "Tailscale unavailable — cannot discover peers. {error}",
        ),
      ),
    );
    return;
  }

  const candidates = Array.isArray(result && result.candidates) ? result.candidates : [];
  const unregistered = candidates.filter((c) => !c.registered);

  if (unregistered.length === 0) {
    refs.peerList.appendChild(
      el(
        "div",
        "mesh-muted",
        candidates.length > 0
          ? t("views.mesh.allRegistered", {}, "All tailnet peers are already registered.")
          : t("views.mesh.noPeers", {}, "No peers found on the tailnet."),
      ),
    );
    return;
  }

  for (const peer of unregistered) {
    refs.peerList.appendChild(buildPeerRow(peer));
  }
}

function buildPeerRow(peer) {
  const row = el("div", "mesh-peer-row");

  const dot = el("span", `mesh-status-dot ${peer.online ? "online" : "offline"}`);
  dot.title = peer.online
    ? t("views.mesh.peerOnline", {}, "Peer online")
    : t("views.mesh.peerOffline", {}, "Peer offline");
  row.appendChild(dot);

  const id = el("div", "mesh-peer-id");
  id.appendChild(el("div", "mesh-peer-hostname", peer.hostname || "unknown"));
  if (peer.fqdn) id.appendChild(el("div", "mesh-peer-fqdn", peer.fqdn));
  row.appendChild(id);

  if (peer.os) row.appendChild(el("span", "mesh-peer-os", peer.os));

  row.appendChild(buildRegisterForm(peer));
  return row;
}

function buildRegisterForm(peer) {
  const form = document.createElement("form");
  form.className = "mesh-register-form";

  const portInput = document.createElement("input");
  portInput.type = "number";
  portInput.className = "mesh-port-input";
  portInput.placeholder = "443";
  portInput.min = "1";
  portInput.max = "65535";
  portInput.title = t("views.mesh.portTitle", {}, "Port (default 443)");
  form.appendChild(portInput);

  const platformSelect = document.createElement("select");
  platformSelect.title = t("views.mesh.platformTitle", {}, "Platform");
  for (const value of ["linux", "windows-wsl", "macos", "unknown"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    platformSelect.appendChild(option);
  }
  platformSelect.value = guessPlatform(peer.os);
  form.appendChild(platformSelect);

  const labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.className = "mesh-label-input";
  labelInput.placeholder = t("views.mesh.labelPlaceholder", {}, "Label (optional)");
  labelInput.maxLength = 120;
  form.appendChild(labelInput);

  const submit = el("button", "mesh-register-btn", t("views.mesh.register", {}, "Register"));
  submit.type = "submit";
  form.appendChild(submit);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = t("views.mesh.registering", {}, "Registering...");

    const body = {
      hostname: normalizeHostname(peer.hostname),
      platform: platformSelect.value,
    };
    const port = parseInt(portInput.value, 10);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) body.port = port;
    const label = labelInput.value.trim();
    if (label) body.label = label;

    try {
      await fetchJson("/api/fleet/mesh/nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await refreshAll({ initial: false });
      if (refs) await runDiscovery();
    } catch (err) {
      submit.disabled = false;
      submit.textContent = t("views.mesh.register", {}, "Register");
      window.alert(
        t(
          "views.mesh.registerFailed",
          { message: err.message },
          "Failed to register node: {message}",
        ),
      );
    }
  });

  return form;
}

/** Server hostname rule: lowercase letters, digits, hyphens only. */
function normalizeHostname(hostname) {
  return String(hostname || "").toLowerCase();
}

function guessPlatform(os) {
  const value = String(os || "").toLowerCase();
  if (value.includes("linux")) return "linux";
  if (value.includes("windows")) return "windows-wsl";
  if (value.includes("mac") || value.includes("darwin")) return "macos";
  return "unknown";
}

// --- Bulk operations bar (multi-select → POST /api/fleet/bulk) ---------------

const BULK_BAR_STYLE_ID = "mesh-bulk-bar-styles";
const MESH_BULK_ACTIONS = [
  {
    action: "health-check",
    destructive: false,
    label: () => t("views.mesh.bulkHealthCheck", {}, "🩺 Health check"),
  },
  {
    action: "gateway-status",
    destructive: false,
    label: () => t("views.mesh.bulkGatewayStatus", {}, "🚪 Gateway status"),
  },
  {
    action: "kill-stale-sessions",
    destructive: true,
    label: () => t("views.mesh.bulkKillStale", {}, "🧹 Kill stale sessions"),
  },
];

function injectBulkBarStyles() {
  if (document.getElementById(BULK_BAR_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = BULK_BAR_STYLE_ID;
  style.textContent = `
.mesh-node-select{margin-right:6px;cursor:pointer}
.mesh-bulk-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;
  margin:0 0 10px;padding:8px 10px;border:1px solid var(--border,#2a3346);
  border-radius:8px;background:var(--bg-panel,rgba(20,26,38,.7));font-size:13px}
.mesh-bulk-bar[hidden]{display:none}
.mesh-bulk-count{opacity:.75}
.mesh-bulk-btn{background:transparent;border:1px solid var(--border,#2a3346);
  border-radius:6px;color:inherit;cursor:pointer;padding:4px 10px;font-size:12px}
.mesh-bulk-btn:disabled{opacity:.45;cursor:default}
.mesh-bulk-btn.danger{border-color:#a33}
.mesh-bulk-results{margin:0 0 10px;font-size:12px}
.mesh-bulk-results[hidden]{display:none}
.mesh-bulk-result-row{display:flex;gap:8px;align-items:baseline;padding:3px 2px}
.mesh-bulk-result-row .ok{color:#2ecc71}
.mesh-bulk-result-row .fail{color:#e74c3c}
.mesh-bulk-result-detail{opacity:.7;white-space:pre-wrap;word-break:break-word}
`;
  document.head.appendChild(style);
}

/** Create the bulk bar + results strip just above the node grid (once per visit). */
function ensureBulkBar() {
  if (bulkRefs || !refs || !refs.grid || !refs.grid.parentNode) return;
  injectBulkBarStyles();

  const bar = el("div", "mesh-bulk-bar");
  bar.hidden = true;
  const count = el("span", "mesh-bulk-count", "");
  bar.appendChild(count);

  const buttons = [];
  for (const entry of MESH_BULK_ACTIONS) {
    const btn = el("button", `mesh-bulk-btn${entry.destructive ? " danger" : ""}`, entry.label());
    btn.type = "button";
    btn.addEventListener("click", () => runMeshBulk(entry, buttons));
    bar.appendChild(btn);
    buttons.push(btn);
  }

  const clear = el("button", "mesh-bulk-btn", t("views.mesh.bulkClear", {}, "Clear selection"));
  clear.type = "button";
  clear.addEventListener("click", () => {
    selectedNodes.clear();
    refs.grid
      .querySelectorAll(".mesh-node-select")
      .forEach((checkbox) => (checkbox.checked = false));
    updateBulkBar();
  });
  bar.appendChild(clear);

  const results = el("div", "mesh-bulk-results");
  results.hidden = true;

  refs.grid.parentNode.insertBefore(bar, refs.grid);
  refs.grid.parentNode.insertBefore(results, refs.grid);
  bulkRefs = { bar, count, results, buttons };
}

function updateBulkBar() {
  if (!bulkRefs) return;
  const n = selectedNodes.size;
  bulkRefs.bar.hidden = n === 0;
  bulkRefs.count.textContent = t("views.mesh.bulkSelected", { n }, "{n} node(s) selected");
  if (n === 0) {
    bulkRefs.results.hidden = true;
    bulkRefs.results.replaceChildren();
  }
}

async function runMeshBulk(entry, buttons) {
  if (!bulkRefs || selectedNodes.size === 0) return;
  if (entry.destructive) {
    const confirmText = t(
      "views.mesh.bulkConfirmKillStale",
      { n: selectedNodes.size },
      "Run stale-session cleanup on {n} node(s)? This removes stale session entries.",
    );
    if (!window.confirm(confirmText)) return;
  }

  buttons.forEach((btn) => (btn.disabled = true));
  bulkRefs.results.hidden = false;
  bulkRefs.results.replaceChildren(
    el("div", "mesh-muted", t("views.mesh.bulkRunning", {}, "Running bulk action…")),
  );

  try {
    const payload = await fetchJson("/api/fleet/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: entry.action, targets: [...selectedNodes] }),
    });
    if (!bulkRefs) return;
    renderMeshBulkResults(payload);
  } catch (err) {
    if (!bulkRefs) return;
    bulkRefs.results.replaceChildren(
      el(
        "div",
        "mesh-error",
        t("views.mesh.bulkFailed", { message: err.message }, "Bulk action failed: {message}"),
      ),
    );
  } finally {
    if (bulkRefs) buttons.forEach((btn) => (btn.disabled = false));
  }
}

function renderMeshBulkResults(payload) {
  bulkRefs.results.replaceChildren();
  const results = Array.isArray(payload && payload.results) ? payload.results : [];
  if (results.length === 0) {
    bulkRefs.results.appendChild(
      el("div", "mesh-muted", t("views.mesh.bulkNoResults", {}, "No results returned")),
    );
    return;
  }
  for (const result of results) {
    const row = el("div", "mesh-bulk-result-row");
    row.appendChild(el("span", result.ok ? "ok" : "fail", result.ok ? "✓" : "✗"));
    row.appendChild(el("span", "", nodeNameById.get(result.target) || String(result.target)));
    row.appendChild(el("span", "mesh-bulk-result-detail", String(result.detail || "")));
    bulkRefs.results.appendChild(row);
  }
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

function formatCost(value) {
  if (!isFiniteNumber(value)) return "—";
  return `$${value.toFixed(2)}`;
}

function formatLastSeen(health) {
  const stamp = health.lastOnline ?? health.lastChecked;
  if (!stamp) return t("time.never", {}, "never");
  const time = typeof stamp === "number" ? stamp : Date.parse(stamp);
  if (!isFiniteNumber(time)) return t("time.never", {}, "never");

  const deltaSec = Math.max(0, Math.floor((Date.now() - time) / 1000));
  let rel;
  if (deltaSec < 10) rel = t("time.relJustNow", {}, "just now");
  else if (deltaSec < 60) rel = t("time.agoSeconds", { n: deltaSec }, "{n}s ago");
  else if (deltaSec < 3600)
    rel = t("time.agoMinutes", { n: Math.floor(deltaSec / 60) }, "{n}m ago");
  else if (deltaSec < 86400)
    rel = t("time.agoHours", { n: Math.floor(deltaSec / 3600) }, "{n}h ago");
  else rel = new Date(time).toLocaleDateString();
  return health.lastOnline ? rel : t("time.checked", { value: rel }, "checked {value}");
}
