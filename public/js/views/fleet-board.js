/**
 * Fleet Board view — unified kanban across the local dashboard and every
 * federated remote.
 *
 * Loaded on demand by views.js, which calls init(containerEl) on EVERY
 * visit. The partial is re-injected fresh each time, so init() re-queries
 * the DOM and tears down timers / SSE / Sortable instances from the
 * previous visit (module scope persists).
 *
 * Data sources:
 *   GET  /api/fleet/federation/board                    — merged board
 *   POST /api/fleet/kanban/tasks/:id/move               — LOCAL card moves
 *   POST /api/fleet/federation/remotes/:id/actions      — REMOTE card moves
 *        ({action:"task.move"}) via the whitelisted federation write proxy
 *   SSE  /api/events ("fleet.kanban" / "fleet.federation") — live refresh
 *
 * Remote cards are READ-ONLY (locked, not draggable) unless their remote
 * connection has allowWrites — then drags proxy through the federation
 * task.move write-action under the operator's forwarded identity.
 *
 * Deliberately separate from views/kanban.js (the local board): same
 * rendering idioms, zero shared mutable state.
 */

import { t } from "../utils.js";

const SORTABLE_SRC = "/vendor/sortable.min.js";
const POLL_INTERVAL_MS = 30000;
const SSE_REFETCH_DEBOUNCE_MS = 400;

// Default (English) column labels; localized via views.kanban.columns.<status>.
const COLUMN_LABELS = {
  inbox: "Inbox",
  assigned: "Assigned",
  inprogress: "In Progress",
  review: "Review",
  done: "Done",
  failed: "Failed",
};

// Border/dot palette cycled across remote origins (local is always accent).
const ORIGIN_COLORS = [
  "var(--accent-2)",
  "var(--purple)",
  "var(--yellow)",
  "var(--red)",
  "var(--green)",
];

// --- Module-level lifecycle state (rebuilt on every init) -------------------

let refs = null;
let board = null; // last fetched { columns, origins, tasks }
let originIndex = new Map(); // origin key -> { ...origin, color }
let sortables = [];
let pollTimer = null;
let eventSource = null;
let sseDebounceTimer = null;
let fetchSeq = 0;
let dragging = false;
let pendingRefresh = false;

// SortableJS loader singleton (same UMD loading idiom as the kanban view).
let sortableLoadPromise = null;

// --- Entry point -------------------------------------------------------------

export function init(containerEl) {
  teardown();

  const root = containerEl.querySelector("#fleet-board-view-section");
  if (!root) {
    console.error("[FleetBoard] Partial markup missing #fleet-board-view-section");
    return;
  }

  refs = {
    root,
    loading: root.querySelector("#fb-loading"),
    error: root.querySelector("#fb-error"),
    body: root.querySelector("#fb-body"),
    legend: root.querySelector("#fb-legend"),
    board: root.querySelector("#fb-board"),
  };

  refresh({ initial: true });
  pollTimer = setInterval(() => {
    if (!isActive()) {
      teardown();
      return;
    }
    refresh({ initial: false });
  }, POLL_INTERVAL_MS);
  connectSSE();
}

function teardown() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (sseDebounceTimer) {
    clearTimeout(sseDebounceTimer);
    sseDebounceTimer = null;
  }
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  destroySortables();
  refs = null;
  board = null;
  dragging = false;
  pendingRefresh = false;
}

function isActive() {
  return !!(refs && refs.root && document.body.contains(refs.root));
}

// --- Live updates --------------------------------------------------------------

function connectSSE() {
  if (typeof EventSource === "undefined") return;
  try {
    eventSource = new EventSource("/api/events");
    const onFleetEvent = () => {
      if (sseDebounceTimer) clearTimeout(sseDebounceTimer);
      sseDebounceTimer = setTimeout(() => {
        sseDebounceTimer = null;
        if (!isActive()) {
          teardown();
          return;
        }
        refresh({ initial: false });
      }, SSE_REFETCH_DEBOUNCE_MS);
    };
    eventSource.addEventListener("fleet.kanban", onFleetEvent);
    eventSource.addEventListener("fleet.federation", onFleetEvent);
    eventSource.onerror = () => {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      setTimeout(() => {
        if (isActive() && !eventSource) connectSSE();
      }, 5000);
    };
  } catch (err) {
    console.error("[FleetBoard] SSE connect failed:", err);
  }
}

// --- Data ----------------------------------------------------------------------

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  let payload = null;
  try {
    payload = await response.json();
  } catch (err) {
    /* non-JSON body */
  }
  if (!response.ok) {
    throw new Error(payload && payload.error ? payload.error : `HTTP ${response.status}`);
  }
  return payload;
}

async function refresh({ initial }) {
  if (!isActive()) return;
  if (dragging) {
    pendingRefresh = true;
    return;
  }
  const seq = ++fetchSeq;
  try {
    const data = await fetchJson("/api/fleet/federation/board");
    if (seq !== fetchSeq || !isActive() || dragging) return;
    board = data;
    render();
  } catch (err) {
    if (seq !== fetchSeq || !isActive()) return;
    console.error("[FleetBoard] Failed to fetch fleet board:", err);
    refs.loading.hidden = true;
    refs.error.hidden = false;
    refs.error.textContent = t(
      "views.fleetBoard.loadError",
      { message: err.message },
      "Failed to load the fleet board: {message}. Retrying automatically...",
    );
    if (initial) refs.body.hidden = true;
  }
}

// --- Rendering -------------------------------------------------------------------

function indexOrigins(origins) {
  originIndex = new Map();
  let colorCursor = 0;
  for (const origin of Array.isArray(origins) ? origins : []) {
    const color =
      origin.kind === "local"
        ? "var(--accent)"
        : ORIGIN_COLORS[colorCursor++ % ORIGIN_COLORS.length];
    originIndex.set(origin.key, { ...origin, color });
  }
}

function render() {
  refs.loading.hidden = true;
  refs.error.hidden = true;
  refs.body.hidden = false;

  indexOrigins(board.origins);
  renderLegend();
  renderBoard();
  createSortables().catch((err) => {
    console.error("[FleetBoard] SortableJS unavailable:", err);
  });
}

function renderLegend() {
  refs.legend.replaceChildren();
  for (const origin of originIndex.values()) {
    const chip = el("span", `fb-origin-chip${origin.reachable === false ? " unreachable" : ""}`);
    chip.style.setProperty("--fb-origin-color", origin.color);
    chip.appendChild(el("span", "fb-origin-dot"));
    chip.appendChild(el("span", null, origin.label || origin.key));
    const mode = el(
      "span",
      `fb-origin-mode${origin.writable ? " writable" : ""}`,
      origin.writable
        ? t("views.fleetBoard.writable", {}, "WRITABLE")
        : t("views.fleetBoard.readOnly", {}, "read-only"),
    );
    chip.appendChild(mode);
    if (origin.kind === "remote" && origin.reachable === false) {
      chip.title = t(
        "views.fleetBoard.unreachable",
        {},
        "Remote unreachable — showing cached cards",
      );
    }
    refs.legend.appendChild(chip);
  }
}

function columnLabel(status) {
  return t(`views.kanban.columns.${status}`, {}, COLUMN_LABELS[status] || status);
}

function tasksFor(status) {
  const tasks = Array.isArray(board.tasks) ? board.tasks : [];
  return tasks
    .filter((task) => task.status === status)
    .sort(
      (a, b) =>
        // Local cards first, then remotes in legend order, then column order.
        originRank(a.origin) - originRank(b.origin) || (a.order ?? 0) - (b.order ?? 0),
    );
}

function originRank(key) {
  let rank = 0;
  for (const originKey of originIndex.keys()) {
    if (originKey === key) return rank;
    rank++;
  }
  return rank;
}

function renderBoard() {
  refs.board.replaceChildren();
  for (const status of board.columns) {
    const col = el("div", "fb-col");
    col.dataset.status = status;

    const header = el("div", "fb-col-header");
    header.appendChild(el("span", "fb-col-name", columnLabel(status)));
    const columnTasks = tasksFor(status);
    header.appendChild(el("span", "fb-count", String(columnTasks.length)));
    col.appendChild(header);

    const list = el("div", "fb-list");
    list.dataset.status = status;
    for (const task of columnTasks) {
      list.appendChild(buildCard(task));
    }
    col.appendChild(list);
    refs.board.appendChild(col);
  }
}

function buildCard(task) {
  const origin = originIndex.get(task.origin) || { label: task.origin, writable: false };
  const movable =
    origin.writable === true && (origin.kind === "local" || origin.reachable === true);

  const card = el("div", `fb-card${movable ? "" : " fb-readonly"}`);
  card.dataset.id = task.id;
  card.dataset.origin = task.origin;
  card.style.setProperty("--fb-origin-color", origin.color || "var(--border)");
  card.appendChild(el("div", "fb-card-title", task.title));

  const meta = el("div", "fb-card-meta");
  const chip = el("span", "fb-card-origin");
  chip.style.setProperty("--fb-origin-color", origin.color || "var(--border)");
  chip.appendChild(el("span", "fb-origin-dot"));
  chip.appendChild(el("span", null, origin.label || task.origin));
  meta.appendChild(chip);
  if (!movable) {
    const lock = el("span", "fb-card-lock", "🔒");
    lock.title = t(
      "views.fleetBoard.lockedTitle",
      {},
      "Read-only — enable write actions on this remote to move its cards",
    );
    meta.appendChild(lock);
  }
  if (task.assignee) meta.appendChild(el("span", "fb-card-assignee", `@${task.assignee}`));
  if (task.stale === true) {
    meta.appendChild(el("span", "fb-card-stale", t("views.fleetBoard.stale", {}, "stale")));
  }
  card.appendChild(meta);
  return card;
}

// --- Drag & drop -------------------------------------------------------------------

function loadSortable() {
  if (window.Sortable) return Promise.resolve(window.Sortable);
  if (!sortableLoadPromise) {
    sortableLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = SORTABLE_SRC;
      script.onload = () => resolve(window.Sortable);
      script.onerror = () => {
        sortableLoadPromise = null;
        script.remove();
        reject(new Error("Failed to load SortableJS"));
      };
      document.head.appendChild(script);
    });
  }
  return sortableLoadPromise;
}

async function createSortables() {
  const Sortable = await loadSortable();
  if (!isActive()) return;
  destroySortables();
  refs.board.querySelectorAll(".fb-list").forEach((list) => {
    const instance = Sortable.create(list, {
      group: "fleet-board",
      animation: 150,
      ghostClass: "sortable-ghost",
      filter: ".fb-readonly", // locked cards cannot start a drag
      onStart: () => {
        dragging = true;
      },
      onEnd: handleDragEnd,
    });
    sortables = [...sortables, instance];
  });
}

function destroySortables() {
  for (const instance of sortables) {
    try {
      instance.destroy();
    } catch (err) {
      // Instance bound to discarded DOM — safe to ignore
    }
  }
  sortables = [];
}

/** Index of a card among SAME-ORIGIN cards in its (new) list. */
function orderWithinOrigin(item) {
  const origin = item.dataset.origin;
  const siblings = Array.from(item.parentElement?.children || []).filter(
    (node) => node.dataset && node.dataset.origin === origin,
  );
  return Math.max(0, siblings.indexOf(item));
}

async function handleDragEnd(evt) {
  dragging = false;

  const taskId = evt.item?.dataset?.id;
  const origin = evt.item?.dataset?.origin;
  const toStatus = evt.to?.dataset?.status;
  const moved = evt.to !== evt.from || evt.oldIndex !== evt.newIndex;

  if (!taskId || !origin || !toStatus || !moved) {
    flushPendingRefresh();
    return;
  }

  try {
    if (origin === "local") {
      await fetchJson(`/api/fleet/kanban/tasks/${encodeURIComponent(taskId)}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: toStatus, order: orderWithinOrigin(evt.item) }),
      });
    } else {
      // Proxied through the federation write-action whitelist (requires the
      // remote's allowWrites opt-in; the server enforces it either way).
      const payload = await fetchJson(
        `/api/fleet/federation/remotes/${encodeURIComponent(origin)}/actions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "task.move", params: { taskId, status: toStatus } }),
        },
      );
      const result = payload && payload.result ? payload.result : {};
      if (!result.ok) {
        const detail =
          result.remoteBody && result.remoteBody.error ? ` — ${result.remoteBody.error}` : "";
        throw new Error(`remote HTTP ${result.remoteStatus}${detail}`);
      }
    }
    toast(
      t("views.fleetBoard.moveOk", { column: columnLabel(toStatus) }, "Card moved to {column}."),
      "success",
    );
  } catch (err) {
    toast(t("views.fleetBoard.moveFailed", { message: err.message }, "Move failed: {message}"));
  }
  // Re-sync with server truth either way (remote order is authoritative there).
  await refresh({ initial: false });
  flushPendingRefresh();
}

function flushPendingRefresh() {
  if (pendingRefresh) {
    pendingRefresh = false;
    refresh({ initial: false });
  }
}

// --- Small helpers -------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Toast using the dashboard's global .toast styles (same as kanban view). */
function toast(message, kind = "error") {
  let host = document.querySelector(".toast-container");
  if (!host) {
    host = el("div", "toast-container");
    document.body.appendChild(host);
  }
  const node = el("div", `toast ${kind === "success" ? "success" : "error"}`, message);
  host.appendChild(node);
  setTimeout(() => node.remove(), 4000);
}
