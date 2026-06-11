/**
 * Federation View — fleet-of-fleets monitoring + opt-in write actions.
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
 *   SSE    /api/events (event "fleet.federation") — reachability transitions
 *
 * Remotes are read-only by default: this panel only mutates the LOCAL
 * registry unless a remote is explicitly opted in (allowWrites). With writes
 * enabled, the card exposes the remote's pending lessons (approve/reject)
 * and a gate toggle — all proxied through the server-side whitelist.
 *
 * Drill-down: clicking a card opens a drawer backed by the cached detail at
 *   GET /api/fleet/federation/remotes/:id/detail
 * showing the remote's mesh nodes (with vitals), kanban column counts with
 * the top cards, and recent alerts. A dead remote serves its last-known
 * cached detail with an "unreachable" notice.
 */

import { t } from "../utils.js";

const REFRESH_INTERVAL_MS = 60000; // fallback poll; SSE drives live updates
const SSE_REFETCH_DEBOUNCE_MS = 300;

// Mirrors the kanban column order for the per-status mini-bars.
const TASK_STATUS_ORDER = ["inbox", "assigned", "inprogress", "review", "done", "failed"];

// --- Module-level lifecycle state (persists across visits) -----------------

let refs = null; // DOM references for the active visit
let refreshTimer = null;
let eventSource = null;
let sseDebounceTimer = null;
let fetchSeq = 0; // guards against out-of-order responses
let drawerFetchSeq = 0; // guards the drill-down drawer's fetch
let drawerKeyHandler = null; // document-level Escape handler while open

// --- Entry point ------------------------------------------------------------

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
    grid: root.querySelector("#fed-grid"),
    emptyState: root.querySelector("#fed-empty-state"),
    emptyCta: root.querySelector("#fed-empty-cta"),
    addForm: root.querySelector("#fed-add-form"),
    addLabel: root.querySelector("#fed-add-label"),
    addUrl: root.querySelector("#fed-add-url"),
    addToken: root.querySelector("#fed-add-token"),
    addBtn: root.querySelector("#fed-add-btn"),
    addError: root.querySelector("#fed-add-error"),
    drawer: root.querySelector("#fed-drawer"),
    drawerBackdrop: root.querySelector("#fed-drawer-backdrop"),
    drawerTitle: root.querySelector("#fed-drawer-title"),
    drawerSub: root.querySelector("#fed-drawer-sub"),
    drawerBody: root.querySelector("#fed-drawer-body"),
    drawerClose: root.querySelector("#fed-drawer-close"),
  };

  refs.emptyCta?.addEventListener("click", () => refs?.addLabel?.focus());
  refs.addForm?.addEventListener("submit", onAddSubmit);
  refs.drawerClose?.addEventListener("click", closeDrillDown);
  refs.drawerBackdrop?.addEventListener("click", closeDrillDown);

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
  if (drawerKeyHandler) {
    document.removeEventListener("keydown", drawerKeyHandler);
    drawerKeyHandler = null;
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

// --- Rendering ----------------------------------------------------------------

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
  refs.grid.hidden = !hasRemotes;
  refs.grid.replaceChildren();
  for (const remote of remotes) {
    refs.grid.appendChild(buildRemoteCard(remote));
  }
}

function buildRemoteCard(remote) {
  const status = remote.status && typeof remote.status === "object" ? remote.status : {};
  const summary = status.summary && typeof status.summary === "object" ? status.summary : null;
  const card = el("div", "fed-card");
  // Click-to-drill-down (buttons inside the card keep their own actions).
  card.title = t("views.federation.drillDownTitle", {}, "Click for remote detail");
  card.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    openDrillDown(remote);
  });

  // Head: reachability dot, label + host, latency
  const head = el("div", "fed-card-head");
  const reachClass =
    status.reachable === true ? "reachable" : status.reachable === false ? "unreachable" : "";
  const dot = el("span", `fed-status-dot ${reachClass}`.trim());
  dot.title =
    status.reachable === true
      ? t("views.federation.reachable", {}, "Reachable")
      : status.reachable === false
        ? t("views.federation.unreachable", {}, "Unreachable")
        : t("views.federation.notChecked", {}, "Not checked yet");
  head.appendChild(dot);

  const names = el("div", "fed-card-names");
  names.appendChild(
    el("div", "fed-card-label", remote.label || t("views.federation.unnamed", {}, "unnamed")),
  );
  const hostLine = baseUrlHost(remote.baseUrl);
  const hostname = summary && summary.hostname ? ` · ${summary.hostname}` : "";
  names.appendChild(el("div", "fed-card-host", hostLine + hostname));
  head.appendChild(names);

  const latency = isFiniteNumber(status.latencyMs) ? `${Math.round(status.latencyMs)} ms` : "—";
  head.appendChild(el("span", "fed-latency", latency));

  // Writes opt-in badge (OFF by default) — click to toggle.
  const writesOn = remote.allowWrites === true;
  const writesBadge = el(
    "button",
    `fed-writes-badge${writesOn ? " on" : ""}`,
    writesOn
      ? t("views.federation.writesOn", {}, "WRITES ON")
      : t("views.federation.writesOff", {}, "writes off"),
  );
  writesBadge.type = "button";
  writesBadge.title = writesOn
    ? t("views.federation.writesOnTitle", {}, "Write actions enabled — click to disable")
    : t("views.federation.writesOffTitle", {}, "Read-only — click to enable write actions");
  writesBadge.addEventListener("click", () => toggleWrites(remote, writesBadge));
  head.appendChild(writesBadge);
  card.appendChild(head);

  // Last-known summary tiles
  if (summary) {
    card.appendChild(buildSummaryTiles(summary));
  } else {
    card.appendChild(
      el("div", "fed-muted", t("views.federation.noData", {}, "No data from this remote yet.")),
    );
  }

  // Write controls (gate toggle + pending lessons) — only with writes
  // enabled AND the remote currently reachable.
  if (writesOn && status.reachable === true) {
    card.appendChild(buildWriteControls(remote, status, summary));
  }

  // Last error (when unreachable)
  if (status.reachable === false && status.lastError) {
    card.appendChild(
      el(
        "div",
        "fed-card-error",
        t("views.federation.lastError", { message: status.lastError }, "Last error: {message}"),
      ),
    );
  }

  // Foot: added-by line, last checked, remove
  const foot = el("div", "fed-card-foot");
  foot.appendChild(
    el(
      "span",
      null,
      t("views.federation.checked", { value: formatAgo(status.lastChecked) }, "Checked: {value}"),
    ),
  );
  if (remote.hasToken) {
    foot.appendChild(el("span", null, t("views.federation.tokenChip", {}, "🔑 token")));
  }

  const removeBtn = el("button", "fed-remove-btn", t("actions.remove", {}, "Remove"));
  removeBtn.type = "button";
  removeBtn.addEventListener("click", () => removeRemote(remote, removeBtn));
  foot.appendChild(removeBtn);
  card.appendChild(foot);

  return card;
}

function buildSummaryTiles(summary) {
  const tiles = el("div", "fed-tiles");

  // Mesh nodes online/total
  const meshTile = el("div", "fed-tile");
  meshTile.appendChild(
    el("span", "fed-tile-label", t("views.federation.tileNodes", {}, "Nodes online")),
  );
  const mesh = summary.mesh;
  meshTile.appendChild(
    el(
      "span",
      "fed-tile-value",
      mesh && isFiniteNumber(mesh.online) && isFiniteNumber(mesh.nodes)
        ? `${mesh.online}/${mesh.nodes}`
        : "—",
    ),
  );
  tiles.appendChild(meshTile);

  // Tasks by status mini-bars
  const taskTile = el("div", "fed-tile");
  taskTile.appendChild(el("span", "fed-tile-label", t("views.federation.tileTasks", {}, "Tasks")));
  const counts = summary.kanban && summary.kanban.counts ? summary.kanban.counts : null;
  const taskBars = buildTaskBars(counts);
  if (taskBars) {
    taskTile.appendChild(taskBars);
  } else {
    taskTile.appendChild(el("span", "fed-tile-value", "—"));
  }
  tiles.appendChild(taskTile);

  // Stale count
  const staleTile = el("div", "fed-tile");
  staleTile.appendChild(el("span", "fed-tile-label", t("views.federation.tileStale", {}, "Stale")));
  staleTile.appendChild(
    el(
      "span",
      "fed-tile-value",
      summary.kanban && isFiniteNumber(summary.kanban.staleCount)
        ? String(summary.kanban.staleCount)
        : "—",
    ),
  );
  tiles.appendChild(staleTile);

  // Evolution gate badge
  const gateTile = el("div", "fed-tile");
  gateTile.appendChild(el("span", "fed-tile-label", t("views.federation.tileGate", {}, "Gate")));
  const gate = summary.evolution ? summary.evolution.gate : null;
  const gateClass = gate === true ? "on" : gate === false ? "off" : "unknown";
  const gateText =
    gate === true
      ? t("views.federation.gateGated", {}, "Gated")
      : gate === false
        ? t("views.federation.gateOpen", {}, "Open")
        : "—";
  gateTile.appendChild(el("span", `fed-gate-badge ${gateClass}`, gateText));
  tiles.appendChild(gateTile);

  // Pending lessons
  const pendingTile = el("div", "fed-tile");
  pendingTile.appendChild(
    el("span", "fed-tile-label", t("views.federation.tilePending", {}, "Pending lessons")),
  );
  pendingTile.appendChild(
    el(
      "span",
      "fed-tile-value",
      summary.evolution && isFiniteNumber(summary.evolution.pendingCount)
        ? String(summary.evolution.pendingCount)
        : "—",
    ),
  );
  tiles.appendChild(pendingTile);

  // Recent alerts
  const alertsTile = el("div", "fed-tile");
  alertsTile.appendChild(
    el("span", "fed-tile-label", t("views.federation.tileAlerts", {}, "Alerts")),
  );
  alertsTile.appendChild(
    el(
      "span",
      "fed-tile-value",
      summary.alerts && isFiniteNumber(summary.alerts.recent) ? String(summary.alerts.recent) : "—",
    ),
  );
  tiles.appendChild(alertsTile);

  return tiles;
}

/** Mini bar chart of task counts by status. Returns null without data. */
function buildTaskBars(counts) {
  if (!counts || typeof counts !== "object") return null;
  const values = TASK_STATUS_ORDER.map((status) => ({
    status,
    count: isFiniteNumber(counts[status]) ? counts[status] : 0,
  }));
  const max = Math.max(...values.map((v) => v.count));
  if (max <= 0) return null;

  const wrap = el("div", "fed-taskbars");
  for (const { status, count } of values) {
    const bar = el("div", `fed-taskbar ${status}`);
    bar.style.height = `${Math.max(8, Math.round((count / max) * 100))}%`;
    if (count === 0) bar.style.opacity = "0.25";
    bar.title = `${status}: ${count}`;
    wrap.appendChild(bar);
  }
  return wrap;
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
    const list = el("div", "fed-lessons");
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
      list.appendChild(row);
    }
    wrap.appendChild(list);
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

// --- Drill-down drawer (read-only remote detail) ------------------------------

async function openDrillDown(remote) {
  if (!refs || !refs.drawer) return;
  const seq = ++drawerFetchSeq;

  refs.drawer.hidden = false;
  refs.drawerBackdrop.hidden = false;
  refs.drawerTitle.textContent = remote.label || baseUrlHost(remote.baseUrl);
  refs.drawerSub.textContent = baseUrlHost(remote.baseUrl);
  refs.drawerBody.replaceChildren(
    el("div", "fed-muted", t("views.federation.drillLoading", {}, "Loading remote detail...")),
  );

  if (!drawerKeyHandler) {
    drawerKeyHandler = (event) => {
      if (event.key === "Escape") closeDrillDown();
    };
    document.addEventListener("keydown", drawerKeyHandler);
  }

  try {
    const payload = await fetchJson(
      `/api/fleet/federation/remotes/${encodeURIComponent(remote.id)}/detail`,
    );
    if (seq !== drawerFetchSeq || !refs || refs.drawer.hidden) return;
    renderDrillDown(payload);
  } catch (err) {
    if (seq !== drawerFetchSeq || !refs || refs.drawer.hidden) return;
    refs.drawerBody.replaceChildren(
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

function closeDrillDown() {
  drawerFetchSeq++; // invalidate any in-flight fetch
  if (drawerKeyHandler) {
    document.removeEventListener("keydown", drawerKeyHandler);
    drawerKeyHandler = null;
  }
  if (!refs || !refs.drawer) return;
  refs.drawer.hidden = true;
  refs.drawerBackdrop.hidden = true;
  refs.drawerBody.replaceChildren();
}

function renderDrillDown({ status, detail }) {
  const body = refs.drawerBody;
  body.replaceChildren();

  if (status && status.reachable === false) {
    body.appendChild(
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
  }

  if (!detail) {
    body.appendChild(
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

  body.appendChild(
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
  body.appendChild(buildDetailNodes(detail.mesh));
  body.appendChild(buildDetailBoard(detail.kanban));
  body.appendChild(buildDetailAlerts(detail.alerts));
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

// --- Mutations (LOCAL registry + whitelisted remote write proxy) -------------

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

/** Host (plus port, if any) of an https base URL — for compact display. */
function baseUrlHost(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch (err) {
    return String(baseUrl || "");
  }
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
