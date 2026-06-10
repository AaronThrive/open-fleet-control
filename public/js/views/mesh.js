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
 *   SSE    /api/events  (event "fleet.mesh") — node status transitions
 */

const REFRESH_INTERVAL_MS = 30000;
const SSE_REFETCH_DEBOUNCE_MS = 300;

const PLATFORM_BADGES = {
  linux: "🐧 linux",
  "windows-wsl": "🪟 windows-wsl",
  macos: "🍎 macos",
  unknown: "❓ unknown",
};

const UNREACHABLE_TOOLTIP =
  "Peer online but health endpoint unreachable — check tailscale serve config";

// --- Module-level lifecycle state (persists across visits) -----------------

let refs = null; // DOM references for the active visit
let refreshTimer = null;
let eventSource = null;
let sseDebounceTimer = null;
let fetchSeq = 0; // guards against out-of-order responses

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
    costs: root.querySelector("#mesh-costs"),
    cost24h: root.querySelector("#mesh-cost-24h"),
    cost7d: root.querySelector("#mesh-cost-7d"),
    costReporting: root.querySelector("#mesh-cost-reporting"),
    grid: root.querySelector("#mesh-grid"),
    emptyState: root.querySelector("#mesh-empty-state"),
    emptyCta: root.querySelector("#mesh-empty-cta"),
    discoverBtn: root.querySelector("#mesh-discover-btn"),
    peerList: root.querySelector("#mesh-peer-list"),
  };

  refs.discoverBtn?.addEventListener("click", () => runDiscovery());
  refs.emptyCta?.addEventListener("click", () => runDiscovery());

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
}

// --- Rendering: top-level state ----------------------------------------------

function renderFetchError(initial, err) {
  refs.loading.hidden = true;
  refs.fetchError.hidden = false;
  refs.fetchError.textContent = `Failed to load mesh state: ${err.message}. Retrying automatically...`;
  // Keep showing the last good render (if any) under the error banner.
  if (initial) refs.body.hidden = true;
}

function renderState(state) {
  refs.loading.hidden = true;
  refs.fetchError.hidden = true;
  refs.body.hidden = false;

  renderSelf(state);
  renderNodes(Array.isArray(state.nodes) ? state.nodes : []);
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

// --- Rendering: node grid -----------------------------------------------------

function renderNodes(nodes) {
  const hasNodes = nodes.length > 0;
  refs.emptyState.hidden = hasNodes;
  refs.grid.hidden = !hasNodes;
  refs.grid.replaceChildren();
  if (!hasNodes) return;

  // Version skew: more than one distinct known version across the fleet.
  const versions = new Set(
    nodes.map((node) => getHealth(node).version).filter((v) => typeof v === "string" && v),
  );
  const hasSkew = versions.size > 1;

  for (const node of nodes) {
    refs.grid.appendChild(buildNodeCard(node, hasSkew));
  }
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

  // Head: status dot, hostname/label, platform badge
  const head = el("div", "mesh-node-head");
  const dot = el("span", `mesh-status-dot ${health.status}`);
  if (health.status === "unreachable") {
    dot.title = UNREACHABLE_TOOLTIP;
  } else {
    dot.title = `Status: ${health.status}`;
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

  // Foot: version chip, last seen, unregister
  const foot = el("div", "mesh-node-foot");
  if (health.version) {
    const chip = el("span", "mesh-version-chip", `v${health.version}`);
    if (hasSkew) {
      chip.classList.add("skew");
      chip.title = "Version skew detected — nodes in this fleet run different versions";
    }
    foot.appendChild(chip);
  }
  foot.appendChild(el("span", "mesh-last-seen", `Last seen: ${formatLastSeen(health)}`));

  const removeBtn = el("button", "mesh-unregister-btn", "Unregister");
  removeBtn.type = "button";
  removeBtn.addEventListener("click", () => unregisterNode(node, removeBtn));
  foot.appendChild(removeBtn);
  card.appendChild(foot);

  return card;
}

async function unregisterNode(node, button) {
  const name =
    node.label && node.label !== node.hostname ? `${node.hostname} (${node.label})` : node.hostname;
  if (!window.confirm(`Unregister node "${name}" from the mesh?`)) return;
  button.disabled = true;
  try {
    await fetchJson(`/api/fleet/mesh/nodes/${encodeURIComponent(node.id || node.hostname)}`, {
      method: "DELETE",
    });
    await refreshAll({ initial: false });
  } catch (err) {
    button.disabled = false;
    window.alert(`Failed to unregister node: ${err.message}`);
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
  title.textContent = `Latency last ${data.length} checks: min ${Math.round(min)} ms, max ${Math.round(max)} ms`;
  svg.insertBefore(title, polyline);

  return svg;
}

// --- Rendering: discovery -----------------------------------------------------

async function runDiscovery() {
  if (!refs) return;
  const btn = refs.discoverBtn;
  btn.disabled = true;
  btn.textContent = "Discovering...";
  refs.peerList.replaceChildren(el("div", "mesh-muted", "Scanning tailnet peers..."));
  scrollDiscoveryIntoView();

  try {
    const result = await fetchJson("/api/fleet/mesh/discover");
    if (!isActive()) return;
    renderDiscovery(result);
  } catch (err) {
    if (!refs) return;
    refs.peerList.replaceChildren(el("div", "mesh-error", `Discovery failed: ${err.message}`));
  } finally {
    if (refs) {
      btn.disabled = false;
      btn.textContent = "Discover nodes";
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
        `Tailscale unavailable — cannot discover peers. ${result.error || ""}`,
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
          ? "All tailnet peers are already registered."
          : "No peers found on the tailnet.",
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
  dot.title = peer.online ? "Peer online" : "Peer offline";
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
  portInput.title = "Port (default 443)";
  form.appendChild(portInput);

  const platformSelect = document.createElement("select");
  platformSelect.title = "Platform";
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
  labelInput.placeholder = "Label (optional)";
  labelInput.maxLength = 120;
  form.appendChild(labelInput);

  const submit = el("button", "mesh-register-btn", "Register");
  submit.type = "submit";
  form.appendChild(submit);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = "Registering...";

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
      submit.textContent = "Register";
      window.alert(`Failed to register node: ${err.message}`);
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
  if (!stamp) return "never";
  const time = typeof stamp === "number" ? stamp : Date.parse(stamp);
  if (!isFiniteNumber(time)) return "never";

  const deltaSec = Math.max(0, Math.floor((Date.now() - time) / 1000));
  const prefix = health.lastOnline ? "" : "checked ";
  if (deltaSec < 10) return `${prefix}just now`;
  if (deltaSec < 60) return `${prefix}${deltaSec}s ago`;
  if (deltaSec < 3600) return `${prefix}${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${prefix}${Math.floor(deltaSec / 3600)}h ago`;
  return `${prefix}${new Date(time).toLocaleDateString()}`;
}
