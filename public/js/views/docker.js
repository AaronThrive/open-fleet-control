/**
 * Docker View — READ-ONLY containers panel for this host.
 *
 * Loaded on demand by views.js, which calls init(containerEl) on EVERY
 * visit of the view. The partial HTML is re-injected fresh each visit, so
 * init() re-queries the DOM from scratch and tears down any timers / SSE
 * connections left over from a previous visit (module scope persists).
 *
 * Data sources:
 *   GET /api/docker — cached container snapshot (poll every 15s while visible)
 *   SSE /api/events (event "fleet.docker") — state/health transitions; the
 *   server-side wiring lands later, the listener is poll-first by design.
 *
 * All container data is rendered via textContent / createElement — no
 * innerHTML with remote strings — so hostile container names/images/ports
 * cannot inject markup.
 */

import { t, formatBytes } from "../utils.js";

const REFRESH_INTERVAL_MS = 15000;
const SSE_REFETCH_DEBOUNCE_MS = 300;
const METER_HOT_THRESHOLD_PCT = 85;

// --- Module-level lifecycle state (persists across visits) -----------------

let refs = null; // DOM references for the active visit
let refreshTimer = null;
let eventSource = null;
let sseDebounceTimer = null;
let fetchSeq = 0; // guards against out-of-order responses

// Filter state survives refreshes within a visit; reset on each init().
let activeFilter = "all"; // all | running | stopped
let searchTerm = "";
let lastState = null;

// --- Entry point ------------------------------------------------------------

export function init(containerEl) {
  teardown();
  activeFilter = "all";
  searchTerm = "";
  lastState = null;

  const root = containerEl.querySelector("#docker-view-section");
  if (!root) {
    console.error("[Docker] Partial markup missing #docker-view-section");
    return;
  }

  refs = {
    root,
    loading: root.querySelector("#docker-loading"),
    fetchError: root.querySelector("#docker-fetch-error"),
    body: root.querySelector("#docker-body"),
    unavailable: root.querySelector("#docker-unavailable"),
    unavailableDetail: root.querySelector("#docker-unavailable-detail"),
    summary: root.querySelector("#docker-summary"),
    summaryRunning: root.querySelector("#docker-summary-running"),
    summaryCpu: root.querySelector("#docker-summary-cpu"),
    summaryMem: root.querySelector("#docker-summary-mem"),
    filters: root.querySelector("#docker-filters"),
    filterButtons: [...root.querySelectorAll(".docker-filter-btn")],
    search: root.querySelector("#docker-search"),
    grid: root.querySelector("#docker-grid"),
    noMatch: root.querySelector("#docker-no-match"),
    emptyState: root.querySelector("#docker-empty-state"),
  };

  for (const button of refs.filterButtons) {
    button.addEventListener("click", () => {
      activeFilter = button.dataset.filter || "all";
      for (const other of refs.filterButtons) {
        other.classList.toggle("active", other === button);
      }
      renderContainers();
    });
  }
  refs.search?.addEventListener("input", () => {
    searchTerm = refs.search.value.trim().toLowerCase();
    renderContainers();
  });

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
  refs = null;
}

/** The view is active while its root is still attached to the document. */
function isActive() {
  return !!(refs && refs.root && document.body.contains(refs.root));
}

// --- Live updates (poll-first; fleet.docker SSE wiring lands later) ---------

function connectSSE() {
  if (typeof EventSource === "undefined") return;
  try {
    eventSource = new EventSource("/api/events");
    eventSource.addEventListener("fleet.docker", () => {
      // Debounce: several containers can transition in one poll sweep.
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
      // The 15s poll keeps the panel fresh; retry SSE lazily.
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      setTimeout(() => {
        if (isActive() && !eventSource) connectSSE();
      }, 5000);
    };
  } catch (err) {
    console.error("[Docker] SSE connect failed:", err);
  }
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
    const state = await fetchJson("/api/docker");
    if (seq !== fetchSeq || !isActive()) return;
    lastState = state;
    renderState(state);
  } catch (err) {
    if (seq !== fetchSeq || !isActive()) return;
    console.error("[Docker] Failed to fetch container state:", err);
    renderFetchError(initial, err);
  }
}

// --- Rendering: top-level state ----------------------------------------------

function renderFetchError(initial, err) {
  refs.loading.hidden = true;
  refs.fetchError.hidden = false;
  refs.fetchError.textContent = t(
    "views.docker.loadError",
    { message: err.message },
    "Failed to load container state: {message}. Retrying automatically...",
  );
  // Keep showing the last good render (if any) under the error banner.
  if (initial) refs.body.hidden = true;
}

function renderState(state) {
  refs.loading.hidden = true;
  refs.fetchError.hidden = true;
  refs.body.hidden = false;

  const available = !!(state && state.available);
  refs.unavailable.hidden = available;
  if (!available) {
    refs.unavailableDetail.textContent = state && state.error ? `(${state.error})` : "";
    refs.summary.hidden = true;
    refs.filters.hidden = true;
    refs.grid.hidden = true;
    refs.noMatch.hidden = true;
    refs.emptyState.hidden = true;
    return;
  }

  const containers = Array.isArray(state.containers) ? state.containers : [];
  const hasContainers = containers.length > 0;
  refs.summary.hidden = !hasContainers;
  refs.filters.hidden = !hasContainers;
  refs.emptyState.hidden = hasContainers;

  if (hasContainers) renderSummary(containers);
  renderContainers();
}

function renderSummary(containers) {
  const running = containers.filter((c) => c.state === "running");
  refs.summaryRunning.textContent = t(
    "views.docker.runningOfTotal",
    { running: running.length, total: containers.length },
    "{running} running / {total} total",
  );

  const cpuValues = running.map((c) => c.cpuPct).filter(isFiniteNumber);
  refs.summaryCpu.textContent =
    cpuValues.length > 0 ? `${cpuValues.reduce((a, b) => a + b, 0).toFixed(1)}%` : "—";

  const memValues = running.map((c) => c.memUsageBytes).filter(isFiniteNumber);
  refs.summaryMem.textContent =
    memValues.length > 0 ? formatBytes(memValues.reduce((a, b) => a + b, 0)) : "—";
}

// --- Rendering: container grid -------------------------------------------------

function matchesFilter(container) {
  if (activeFilter === "running" && container.state !== "running") return false;
  if (activeFilter === "stopped" && container.state === "running") return false;
  if (searchTerm) {
    const haystack = `${container.name || ""} ${container.image || ""}`.toLowerCase();
    if (!haystack.includes(searchTerm)) return false;
  }
  return true;
}

function renderContainers() {
  if (!refs || !lastState) return;
  const containers = Array.isArray(lastState.containers) ? lastState.containers : [];
  const visible = containers.filter(matchesFilter);

  refs.grid.replaceChildren();
  refs.grid.hidden = visible.length === 0;
  refs.noMatch.hidden = visible.length > 0 || containers.length === 0;

  const portainerUrl = typeof lastState.portainerUrl === "string" ? lastState.portainerUrl : null;
  for (const container of visible) {
    refs.grid.appendChild(buildCard(container, portainerUrl));
  }
}

function buildCard(container, portainerUrl) {
  const card = el("div", "docker-card");
  card.appendChild(buildHead(container, portainerUrl));
  card.appendChild(buildBadges(container));

  const meters = buildMeters(container);
  if (meters) card.appendChild(meters);

  if (Array.isArray(container.ports) && container.ports.length > 0) {
    const ports = el("div", "docker-ports");
    for (const port of container.ports) {
      ports.appendChild(el("span", "docker-port-chip", String(port)));
    }
    card.appendChild(ports);
  }

  const foot = el("div", "docker-card-foot");
  foot.appendChild(el("span", "docker-uptime", formatUptime(container)));
  card.appendChild(foot);

  return card;
}

function buildHead(container, portainerUrl) {
  const head = el("div", "docker-card-head");

  const dotState = dotClassFor(container);
  const dot = el("span", `docker-state-dot ${dotState}`);
  dot.title = t(
    "views.docker.stateTooltip",
    { state: container.status || container.state || "unknown" },
    "{state}",
  );
  head.appendChild(dot);

  const names = el("div", "docker-card-names");
  names.appendChild(el("div", "docker-card-name", container.name || container.id12 || "unknown"));
  names.appendChild(buildImageLine(container.image));
  head.appendChild(names);

  const link = buildPortainerLink(container, portainerUrl);
  if (link) head.appendChild(link);

  return head;
}

/** Dot color: unhealthy red beats raw state; restarting amber; running green. */
function dotClassFor(container) {
  if (container.health === "unhealthy") return "unhealthy";
  if (container.state === "restarting") return "restarting";
  if (container.state === "running") return "running";
  return "exited";
}

/** Tag-aware truncated image line: repo path ellipsizes, the tag stays visible. */
function buildImageLine(image) {
  const line = el("div", "docker-card-image");
  const full = String(image || "");
  line.title = full;

  // The tag is everything after the last ":" — unless that colon belongs to
  // a registry port (a "/" appears after it) or a digest reference.
  const colon = full.lastIndexOf(":");
  const hasTag = colon > -1 && !full.slice(colon).includes("/") && !full.includes("@");
  const repo = hasTag ? full.slice(0, colon) : full;
  const tag = hasTag ? full.slice(colon) : "";

  line.appendChild(document.createTextNode(repo));
  if (tag) line.appendChild(el("span", "docker-image-tag", tag));
  return line;
}

function buildPortainerLink(container, portainerUrl) {
  if (!portainerUrl) return null;
  // Derive at runtime — a ":port"-only config resolves against the host the
  // dashboard itself is being served from (never a hardcoded tailnet name).
  const base = portainerUrl.startsWith(":")
    ? `${window.location.protocol}//${window.location.hostname}${portainerUrl}`
    : portainerUrl;

  let href;
  try {
    const url = new URL(base);
    if (!["https:", "http:"].includes(url.protocol)) return null;
    const trimmed = url.href.replace(/\/+$/, "");
    href = container.id ? `${trimmed}/#!/1/docker/containers/${container.id}` : trimmed;
  } catch (err) {
    return null; // malformed config — omit the link
  }

  const link = el("a", "docker-portainer-link", "🧭");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.title = t("views.docker.openPortainer", {}, "Open in Portainer");
  return link;
}

function buildBadges(container) {
  const badges = el("div", "docker-badges");

  badges.appendChild(el("span", "docker-badge", container.state || "unknown"));

  if (container.health) {
    const labels = {
      healthy: t("views.docker.healthHealthy", {}, "healthy"),
      unhealthy: t("views.docker.healthUnhealthy", {}, "unhealthy"),
      starting: t("views.docker.healthStarting", {}, "starting"),
    };
    badges.appendChild(
      el(
        "span",
        `docker-badge health-${container.health}`,
        labels[container.health] || container.health,
      ),
    );
  }

  if (isFiniteNumber(container.restartCount)) {
    const warn = container.restartCount > 0 ? " restarts-warn" : "";
    badges.appendChild(
      el(
        "span",
        `docker-badge${warn}`,
        t("views.docker.restarts", { n: container.restartCount }, "{n} restarts"),
      ),
    );
  }

  return badges;
}

function buildMeters(container) {
  const hasCpu = isFiniteNumber(container.cpuPct);
  const hasMem = isFiniteNumber(container.memUsageBytes);
  if (!hasCpu && !hasMem) return null;

  const meters = el("div", "docker-meters");
  if (hasCpu) {
    meters.appendChild(
      buildMeterRow(t("views.docker.cpu", {}, "CPU"), container.cpuPct, {
        valueText: `${container.cpuPct.toFixed(1)}%`,
      }),
    );
  }
  if (hasMem) {
    const limitText = isFiniteNumber(container.memLimitBytes)
      ? ` / ${formatBytes(container.memLimitBytes)}`
      : "";
    meters.appendChild(
      buildMeterRow(t("views.docker.mem", {}, "MEM"), container.memPct, {
        valueText: `${formatBytes(container.memUsageBytes)}${limitText}`,
      }),
    );
  }
  return meters;
}

function buildMeterRow(label, pct, { valueText }) {
  const row = el("div", "docker-meter-row");
  row.appendChild(el("span", "docker-meter-label", label));

  const track = el("div", "docker-meter-track");
  const fill = el("div", "docker-meter-fill");
  const clamped = isFiniteNumber(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  fill.style.width = `${clamped}%`;
  if (clamped >= METER_HOT_THRESHOLD_PCT) fill.classList.add("hot");
  track.appendChild(fill);
  row.appendChild(track);

  row.appendChild(el("span", "docker-meter-value", valueText));
  return row;
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

/** Uptime from startedAt for running containers; the raw Status otherwise. */
function formatUptime(container) {
  if (container.state === "running" && container.startedAt) {
    const started = Date.parse(container.startedAt);
    if (Number.isFinite(started)) {
      const deltaSec = Math.max(0, Math.floor((Date.now() - started) / 1000));
      let span;
      if (deltaSec < 60) span = `${deltaSec}s`;
      else if (deltaSec < 3600) span = `${Math.floor(deltaSec / 60)}m`;
      else if (deltaSec < 86400)
        span = `${Math.floor(deltaSec / 3600)}h ${Math.floor((deltaSec % 3600) / 60)}m`;
      else span = `${Math.floor(deltaSec / 86400)}d ${Math.floor((deltaSec % 86400) / 3600)}h`;
      return t("views.docker.uptime", { span }, "up {span}");
    }
  }
  return container.status || container.state || "";
}
