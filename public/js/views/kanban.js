/**
 * Kanban view module.
 *
 * Loaded by views.js via dynamic import; `init(containerEl)` runs on EVERY
 * visit to #view-kanban. The partial HTML is re-injected before each call, so
 * all DOM references and event bindings are rebuilt from scratch here, and
 * stale SortableJS instances / timers from the previous visit are destroyed.
 *
 * Data source: /api/fleet/kanban (REST) + the `fleet.kanban` SSE event on
 * /api/events, with a 30s polling fallback.
 */

const COLUMNS = [
  { status: "inbox", label: "Inbox" },
  { status: "assigned", label: "Assigned" },
  { status: "inprogress", label: "In Progress" },
  { status: "review", label: "Review" },
  { status: "done", label: "Done" },
  { status: "failed", label: "Failed" },
];

const SORTABLE_SRC = "/vendor/sortable.min.js";
const POLL_INTERVAL_MS = 30000;
const SSE_MAX_RECONNECT_DELAY = 30000;

// ---------------------------------------------------------------------------
// Module state (reset/rebuilt on every init)
// ---------------------------------------------------------------------------

const state = {
  container: null,
  tasks: [],
  openTaskId: null,
  sortables: [],
  pollTimer: null,
  dragging: false,
  pendingRefresh: false,
  forceBoard: false, // empty-state CTA pressed: show columns even with 0 tasks
  moveModeTaskId: null, // card currently in keyboard move mode
  moveOrigin: null, // { status, index } snapshot for Escape-cancel
  drawerReturnTaskId: null, // card to refocus when the drawer closes
  refs: {},
};

// SSE singleton — survives across visits; handlers check container liveness.
let eventSource = null;
let sseRetries = 0;

// SortableJS loader singleton (UMD file → script tag → window.Sortable).
let sortableLoadPromise = null;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

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

function toast(message, type = "error") {
  let host = document.querySelector(".toast-container");
  if (!host) {
    host = document.createElement("div");
    host.className = "toast-container";
    document.body.appendChild(host);
  }
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.style.animation = "toast-out 0.3s ease forwards";
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

async function api(method, path, body) {
  const response = await fetch(`/api/fleet/kanban${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await response.json();
  } catch (err) {
    // Non-JSON body — fall through to status check
  }
  if (!response.ok) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data;
}

function isActive() {
  return Boolean(state.container && state.container.isConnected);
}

function getTask(id) {
  return state.tasks.find((t) => t.id === id) || null;
}

/** Immutable upsert of a task into local state. */
function upsertTask(task) {
  const exists = state.tasks.some((t) => t.id === task.id);
  state.tasks = exists
    ? state.tasks.map((t) => (t.id === task.id ? { ...t, ...task } : t))
    : [...state.tasks, task];
}

function removeTask(id) {
  state.tasks = state.tasks.filter((t) => t.id !== id);
}

function cssEscape(value) {
  return window.CSS?.escape ? CSS.escape(String(value)) : String(value);
}

function cardEl(taskId) {
  return state.refs.board?.querySelector(`.kb-card[data-id="${cssEscape(taskId)}"]`) || null;
}

/** Tasks of one column, in render order (shared by renderBoard + keyboard moves). */
function sortedColumn(status) {
  return state.tasks
    .filter((t) => t.status === status)
    .sort((a, b) => a.order - b.order || (a.created_at < b.created_at ? -1 : 1));
}

function columnLabel(status) {
  return COLUMNS.find((c) => c.status === status)?.label || status;
}

/** Screen-reader announcement via the aria-live region (cleared first to re-trigger). */
function announce(message) {
  const el = state.refs.live;
  if (!el) return;
  el.textContent = "";
  window.setTimeout(() => {
    if (isActive()) el.textContent = message;
  }, 30);
}

function isOverdue(task) {
  if (!task.due || task.status === "done" || task.status === "failed") return false;
  const due = new Date(task.due);
  if (Number.isNaN(due.getTime())) return false;
  // Date-only strings parse as UTC midnight; treat the whole due day as on-time
  const endOfDueDay = new Date(due.getTime() + 24 * 60 * 60 * 1000);
  return endOfDueDay.getTime() < Date.now();
}

function formatTs(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

// ---------------------------------------------------------------------------
// Board rendering (XSS-safe: all dynamic values go through textContent)
// ---------------------------------------------------------------------------

function buildColumnSkeleton(boardEl) {
  boardEl.textContent = "";
  for (const col of COLUMNS) {
    const colEl = document.createElement("div");
    colEl.className = "kb-col";
    colEl.dataset.status = col.status;

    const header = document.createElement("div");
    header.className = "kb-col-header";

    const name = document.createElement("span");
    name.className = "kb-col-name";
    name.textContent = col.label;

    const count = document.createElement("span");
    count.className = "kb-count";
    count.textContent = "0";

    const addBtn = document.createElement("button");
    addBtn.className = "kb-add-btn";
    addBtn.type = "button";
    addBtn.textContent = "+ New";
    addBtn.title = `New task in ${col.label}`;
    addBtn.addEventListener("click", () => toggleNewForm(col.status, true));

    header.append(name, count, addBtn);

    const form = document.createElement("div");
    form.className = "kb-newform";
    form.hidden = true;

    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 200;
    input.placeholder = "Task title";

    const actions = document.createElement("div");
    actions.className = "kb-newform-actions";

    const addAction = document.createElement("button");
    addAction.type = "button";
    addAction.className = "kb-newform-add";
    addAction.textContent = "Add";
    addAction.addEventListener("click", () => submitNewTask(col.status));

    const cancelAction = document.createElement("button");
    cancelAction.type = "button";
    cancelAction.className = "kb-newform-cancel";
    cancelAction.textContent = "Cancel";
    cancelAction.addEventListener("click", () => toggleNewForm(col.status, false));

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitNewTask(col.status);
      if (e.key === "Escape") toggleNewForm(col.status, false);
    });

    actions.append(addAction, cancelAction);
    form.append(input, actions);

    const list = document.createElement("div");
    list.className = "kb-list";
    list.dataset.status = col.status;
    list.setAttribute("role", "list");
    list.setAttribute("aria-label", `${col.label} column`);

    colEl.append(header, form, list);
    boardEl.appendChild(colEl);
  }
}

function buildBadge(className, text) {
  const el = document.createElement("span");
  el.className = `kb-badge ${className}`;
  el.textContent = text;
  return el;
}

function buildCard(task) {
  const card = document.createElement("div");
  card.className = "kb-card";
  card.dataset.id = task.id;
  card.tabIndex = 0;
  card.setAttribute("role", "listitem");
  card.setAttribute("aria-label", `${task.title} — ${columnLabel(task.status)}`);
  if (task.id === state.moveModeTaskId) card.classList.add("kb-move-mode");

  const title = document.createElement("div");
  title.className = "kb-card-title";
  title.textContent = task.title;
  card.appendChild(title);

  const badges = document.createElement("div");
  badges.className = "kb-card-badges";

  const prio = document.createElement("span");
  prio.className = `kb-prio kb-prio-${task.priority}`;
  prio.textContent = `P${task.priority}`;
  badges.appendChild(prio);

  if (task.assignee) badges.appendChild(buildBadge("kb-badge-assignee", task.assignee));
  if (task.node) badges.appendChild(buildBadge("kb-badge-node", task.node));
  if (task.stale) badges.appendChild(buildBadge("kb-badge-stale", "STALE"));

  if (task.due) {
    const due = document.createElement("span");
    due.className = isOverdue(task) ? "kb-due kb-overdue" : "kb-due";
    due.textContent = `Due ${task.due.slice(0, 10)}`;
    badges.appendChild(due);
  }
  card.appendChild(badges);

  if (task.progress > 0) {
    const bar = document.createElement("div");
    bar.className = "kb-progress";
    const fill = document.createElement("div");
    fill.className = "kb-progress-fill";
    fill.style.width = `${Math.min(100, Math.max(0, task.progress))}%`;
    bar.appendChild(fill);
    card.appendChild(bar);
  }

  const commentCount = Array.isArray(task.comments) ? task.comments.length : 0;
  const attemptCount = Array.isArray(task.attempts) ? task.attempts.length : 0;
  if (commentCount > 0 || attemptCount > 0) {
    const meta = document.createElement("div");
    meta.className = "kb-card-meta";
    if (commentCount > 0) {
      const c = document.createElement("span");
      c.textContent = `💬 ${commentCount}`;
      meta.appendChild(c);
    }
    if (attemptCount > 0) {
      const a = document.createElement("span");
      a.textContent = `⚙ ${attemptCount}`;
      meta.appendChild(a);
    }
    card.appendChild(meta);
  }

  card.addEventListener("click", () => {
    if (!state.dragging && state.moveModeTaskId !== task.id) openDrawer(task.id);
  });
  card.addEventListener("keydown", (e) => handleCardKeydown(e, task.id));
  return card;
}

function renderCounts() {
  for (const col of COLUMNS) {
    const colEl = state.refs.board.querySelector(`.kb-col[data-status="${col.status}"]`);
    if (!colEl) continue;
    const n = state.tasks.filter((t) => t.status === col.status).length;
    colEl.querySelector(".kb-count").textContent = String(n);
  }
}

function renderBoard() {
  if (!isActive()) return;
  if (state.dragging) {
    state.pendingRefresh = true;
    return;
  }
  const { board, emptyState, loading, kbdHint } = state.refs;
  loading.hidden = true;

  const empty = state.tasks.length === 0 && !state.forceBoard && !anyNewFormOpen();
  emptyState.hidden = !empty;
  board.hidden = empty;
  if (kbdHint) kbdHint.hidden = empty;
  if (state.tasks.length > 0) state.forceBoard = false;

  // Re-rendering destroys the focused card; remember it by id and refocus below.
  const focusedCardId = document.activeElement?.classList?.contains("kb-card")
    ? document.activeElement.dataset.id
    : null;

  for (const col of COLUMNS) {
    const list = board.querySelector(`.kb-list[data-status="${col.status}"]`);
    if (!list) continue;
    list.textContent = "";
    for (const task of sortedColumn(col.status)) list.appendChild(buildCard(task));
  }
  renderCounts();

  if (focusedCardId) cardEl(focusedCardId)?.focus();

  if (state.openTaskId) {
    const task = getTask(state.openTaskId);
    if (task) renderDrawer(task, { preserveEdits: true });
    else closeDrawer();
  }
}

function anyNewFormOpen() {
  return Boolean(state.refs.board?.querySelector(".kb-newform:not([hidden])"));
}

// ---------------------------------------------------------------------------
// Data flow
// ---------------------------------------------------------------------------

async function refreshBoard() {
  if (!isActive()) return;
  try {
    const board = await api("GET", "");
    state.tasks = Array.isArray(board.tasks) ? board.tasks : [];
    renderBoard();
  } catch (err) {
    console.error("[Kanban] Failed to fetch board:", err);
    if (state.refs.loading && !state.refs.loading.hidden) {
      state.refs.loading.textContent = "Failed to load board — retrying shortly.";
    }
  }
}

function scheduleRefresh() {
  if (!isActive()) return;
  if (state.dragging) {
    state.pendingRefresh = true;
    return;
  }
  refreshBoard();
}

function ensureEventSource() {
  if (eventSource || typeof EventSource === "undefined") return;
  eventSource = new EventSource("/api/events");
  eventSource.onopen = () => {
    sseRetries = 0;
  };
  eventSource.addEventListener("fleet.kanban", () => scheduleRefresh());
  eventSource.onerror = () => {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    sseRetries += 1;
    const delay = Math.min(1000 * 2 ** (sseRetries - 1), SSE_MAX_RECONNECT_DELAY);
    setTimeout(ensureEventSource, delay);
  };
}

// ---------------------------------------------------------------------------
// Drag & drop
// ---------------------------------------------------------------------------

async function createSortables() {
  const Sortable = await loadSortable();
  if (!isActive()) return;
  destroySortables();
  state.refs.board.querySelectorAll(".kb-list").forEach((list) => {
    const instance = Sortable.create(list, {
      group: "kanban",
      animation: 150,
      ghostClass: "sortable-ghost",
      dragClass: "sortable-drag",
      onStart: () => {
        state.dragging = true;
      },
      onEnd: handleDragEnd,
    });
    state.sortables = [...state.sortables, instance];
  });
}

function destroySortables() {
  for (const instance of state.sortables) {
    try {
      instance.destroy();
    } catch (err) {
      // Instance bound to discarded DOM — safe to ignore
    }
  }
  state.sortables = [];
}

async function handleDragEnd(evt) {
  state.dragging = false;

  const taskId = evt.item?.dataset?.id;
  const toStatus = evt.to?.dataset?.status;
  const moved = evt.to !== evt.from || evt.oldIndex !== evt.newIndex;

  if (!taskId || !toStatus || !moved) {
    if (state.pendingRefresh) {
      state.pendingRefresh = false;
      refreshBoard();
    }
    return;
  }

  // Optimistic: the card already sits in its new list; sync local state + counts
  const task = getTask(taskId);
  if (task) {
    upsertTask({ ...task, status: toStatus, order: evt.newIndex });
    renderCounts();
  }

  try {
    const result = await api("POST", `/tasks/${encodeURIComponent(taskId)}/move`, {
      status: toStatus,
      order: evt.newIndex,
    });
    if (result?.task) upsertTask(result.task);
  } catch (err) {
    toast(`Move failed: ${err.message}`);
    await refreshBoard(); // rollback to server truth
    return;
  }

  if (state.pendingRefresh) {
    state.pendingRefresh = false;
    refreshBoard();
  }
}

// ---------------------------------------------------------------------------
// Keyboard move mode (parallel input path to drag & drop; same move API)
// ---------------------------------------------------------------------------

/**
 * Immutably re-shelve a task locally: status change + dense re-index of the
 * affected column(s) so the optimistic render matches the intended order.
 */
function applyLocalMove(taskId, toStatus, toIndex) {
  const task = getTask(taskId);
  if (!task) return;
  const fromStatus = task.status;

  const source = sortedColumn(fromStatus).filter((t) => t.id !== taskId);
  const target = fromStatus === toStatus ? source : sortedColumn(toStatus);

  const targetIds = target.map((t) => t.id);
  const index = Math.max(0, Math.min(toIndex, targetIds.length));
  targetIds.splice(index, 0, taskId);

  upsertTask({ ...task, status: toStatus, order: index });
  targetIds.forEach((id, i) => {
    const t = getTask(id);
    if (t) upsertTask({ ...t, order: i });
  });
  if (fromStatus !== toStatus) {
    source.forEach((t, i) => upsertTask({ ...t, order: i }));
  }
}

/** Persist a move through the same API used by drag & drop; rollback on error. */
async function persistMove(taskId, toStatus, toIndex) {
  try {
    const result = await api("POST", `/tasks/${encodeURIComponent(taskId)}/move`, {
      status: toStatus,
      order: toIndex,
    });
    if (result?.task) upsertTask(result.task);
    return true;
  } catch (err) {
    toast(`Move failed: ${err.message}`);
    announce(`Move failed: ${err.message}`);
    await refreshBoard(); // rollback to server truth
    return false;
  }
}

function updateMoveHint(task) {
  const hint = state.refs.moveHint;
  if (!hint) return;
  if (!task) {
    hint.hidden = true;
    hint.textContent = "";
    return;
  }
  hint.hidden = false;
  hint.textContent =
    `Move mode: "${task.title}" — ` +
    "←/→ change column, ↑/↓ change position, Enter confirm, Esc cancel";
}

function enterMoveMode(taskId) {
  const task = getTask(taskId);
  if (!task) return;
  const index = sortedColumn(task.status).findIndex((t) => t.id === taskId);
  state.moveModeTaskId = taskId;
  state.moveOrigin = { status: task.status, index };
  cardEl(taskId)?.classList.add("kb-move-mode");
  updateMoveHint(task);
  announce(
    `Move mode on for task "${task.title}". Use arrow keys to move, ` +
      "Enter to confirm, Escape to cancel.",
  );
}

function exitMoveMode() {
  const taskId = state.moveModeTaskId;
  state.moveModeTaskId = null;
  state.moveOrigin = null;
  if (taskId) cardEl(taskId)?.classList.remove("kb-move-mode");
  updateMoveHint(null);
}

function confirmMoveMode(taskId) {
  const task = getTask(taskId);
  exitMoveMode();
  if (task) {
    announce(`Move confirmed: task "${task.title}" is in ${columnLabel(task.status)}.`);
  }
  cardEl(taskId)?.focus();
}

async function cancelMoveMode(taskId) {
  const origin = state.moveOrigin;
  const task = getTask(taskId);
  exitMoveMode();

  const movedAway =
    task &&
    origin &&
    (task.status !== origin.status ||
      sortedColumn(origin.status).findIndex((t) => t.id === taskId) !== origin.index);

  if (movedAway) {
    // Put the card back where move mode started, then refetch server truth.
    try {
      await api("POST", `/tasks/${encodeURIComponent(taskId)}/move`, {
        status: origin.status,
        order: origin.index,
      });
    } catch (err) {
      toast(`Cancel restore failed: ${err.message}`);
    }
    await refreshBoard();
  }
  announce(`Move cancelled: task "${task ? task.title : taskId}" restored.`);
  cardEl(taskId)?.focus();
}

/** ArrowLeft / ArrowRight — move to previous/next column (appended at the end). */
async function keyboardMoveAcross(taskId, delta) {
  const task = getTask(taskId);
  if (!task) return;
  const colIdx = COLUMNS.findIndex((c) => c.status === task.status);
  const nextIdx = colIdx + delta;
  if (nextIdx < 0 || nextIdx >= COLUMNS.length) {
    announce(`Task "${task.title}" is already in the ${delta < 0 ? "first" : "last"} column.`);
    return;
  }
  const toStatus = COLUMNS[nextIdx].status;
  const toIndex = sortedColumn(toStatus).length;
  applyLocalMove(taskId, toStatus, toIndex);
  renderBoard();
  cardEl(taskId)?.focus();
  announce(`Task "${task.title}" moved to ${COLUMNS[nextIdx].label}.`);
  await persistMove(taskId, toStatus, toIndex);
}

/** ArrowUp / ArrowDown — reorder within the current column. */
async function keyboardReorder(taskId, delta) {
  const task = getTask(taskId);
  if (!task) return;
  const column = sortedColumn(task.status);
  const fromIndex = column.findIndex((t) => t.id === taskId);
  const toIndex = fromIndex + delta;
  if (toIndex < 0 || toIndex >= column.length) {
    announce(
      `Task "${task.title}" is already at the ${delta < 0 ? "top" : "bottom"} of ` +
        `${columnLabel(task.status)}.`,
    );
    return;
  }
  applyLocalMove(taskId, task.status, toIndex);
  renderBoard();
  cardEl(taskId)?.focus();
  announce(
    `Task "${task.title}" moved to position ${toIndex + 1} of ${column.length} in ` +
      `${columnLabel(task.status)}.`,
  );
  await persistMove(taskId, task.status, toIndex);
}

function handleCardKeydown(e, taskId) {
  const inMoveMode = state.moveModeTaskId === taskId;

  switch (e.key) {
    case "Enter":
      e.preventDefault();
      if (inMoveMode) confirmMoveMode(taskId);
      else openDrawer(taskId);
      return;
    case " ":
      e.preventDefault();
      if (!inMoveMode) openDrawer(taskId);
      return;
    case "m":
    case "M":
      e.preventDefault();
      if (inMoveMode) confirmMoveMode(taskId);
      else enterMoveMode(taskId);
      return;
    case "Escape":
      if (inMoveMode) {
        e.preventDefault();
        e.stopPropagation(); // keep board-level Escape away from the drawer handler
        cancelMoveMode(taskId);
      }
      return;
    case "ArrowLeft":
    case "ArrowRight":
      if (inMoveMode) {
        e.preventDefault();
        keyboardMoveAcross(taskId, e.key === "ArrowLeft" ? -1 : 1);
      }
      return;
    case "ArrowUp":
    case "ArrowDown":
      if (inMoveMode) {
        e.preventDefault();
        keyboardReorder(taskId, e.key === "ArrowUp" ? -1 : 1);
      }
      return;
    default:
  }
}

// ---------------------------------------------------------------------------
// New-task inline form
// ---------------------------------------------------------------------------

function toggleNewForm(status, show) {
  const colEl = state.refs.board.querySelector(`.kb-col[data-status="${status}"]`);
  if (!colEl) return;
  const form = colEl.querySelector(".kb-newform");
  form.hidden = !show;
  if (show) {
    form.querySelector("input").focus();
  } else {
    form.querySelector("input").value = "";
    renderBoard(); // may need to fall back to the empty state
  }
}

async function submitNewTask(status) {
  const colEl = state.refs.board.querySelector(`.kb-col[data-status="${status}"]`);
  if (!colEl) return;
  const input = colEl.querySelector(".kb-newform input");
  const title = input.value.trim();
  if (!title) {
    input.focus();
    return;
  }
  try {
    const result = await api("POST", "/tasks", { title, status });
    if (result?.task) upsertTask(result.task);
    input.value = "";
    colEl.querySelector(".kb-newform").hidden = true;
    renderBoard();
  } catch (err) {
    toast(`Create failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

function openDrawer(taskId) {
  const task = getTask(taskId);
  if (!task) return;
  state.openTaskId = taskId;
  state.drawerReturnTaskId = taskId;
  state.refs.drawer.hidden = false;
  state.refs.backdrop.hidden = false;
  renderDrawer(task, { preserveEdits: false });
  state.refs.drawer.querySelector("#kb-drawer-close")?.focus();
}

function closeDrawer() {
  const returnTaskId = state.drawerReturnTaskId;
  state.openTaskId = null;
  state.drawerReturnTaskId = null;
  if (state.refs.drawer) state.refs.drawer.hidden = true;
  if (state.refs.backdrop) state.refs.backdrop.hidden = true;
  // Return focus to the originating card (no-op if it left the board).
  if (returnTaskId) cardEl(returnTaskId)?.focus();
}

function getDrawerFocusables() {
  const selector = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';
  return [...state.refs.drawer.querySelectorAll(selector)].filter(
    (el) => !el.disabled && el.offsetParent !== null,
  );
}

/** Focus trap + Escape-to-close while the drawer dialog is open. */
function handleDrawerKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeDrawer();
    return;
  }
  if (e.key !== "Tab") return;
  const focusables = getDrawerFocusables();
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/** "Move to column" fallback buttons — same API path as drag and move mode. */
function renderMoveButtons(task) {
  const host = state.refs.drawer.querySelector("#kb-move-row");
  if (!host) return;
  const focusedStatus =
    document.activeElement?.parentElement === host ? document.activeElement.dataset.status : null;
  host.textContent = "";
  for (const col of COLUMNS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "kb-move-btn";
    btn.dataset.status = col.status;
    btn.textContent = col.label;
    if (col.status === task.status) {
      btn.disabled = true;
      btn.setAttribute("aria-label", `${col.label} (current column)`);
    } else {
      btn.setAttribute("aria-label", `Move to ${col.label}`);
      btn.addEventListener("click", () => moveOpenTaskTo(col.status));
    }
    host.appendChild(btn);
  }
  if (focusedStatus) {
    // The previously focused button may now be the disabled "current column"
    // one; fall back to the close button so focus never escapes the dialog.
    const again = host.querySelector(`.kb-move-btn[data-status="${focusedStatus}"]`);
    if (again && !again.disabled) again.focus();
    else state.refs.drawer.querySelector("#kb-drawer-close")?.focus();
  }
}

async function moveOpenTaskTo(toStatus) {
  const taskId = state.openTaskId;
  const task = taskId ? getTask(taskId) : null;
  if (!task || task.status === toStatus) return;
  const toIndex = sortedColumn(toStatus).length;
  applyLocalMove(taskId, toStatus, toIndex);
  renderBoard(); // refreshes the board and the open drawer (incl. these buttons)
  announce(`Task "${task.title}" moved to ${columnLabel(toStatus)}.`);
  await persistMove(taskId, toStatus, toIndex);
}

/**
 * Populate drawer fields and history lists.
 * With preserveEdits=true (live refresh while open), the field currently
 * being edited (focused) is left untouched.
 */
function renderDrawer(task, { preserveEdits }) {
  const { drawer } = state.refs;
  drawer.querySelector("#kb-drawer-id").textContent = task.id;

  const focused = document.activeElement;
  drawer.querySelectorAll("[data-field]").forEach((input) => {
    if (preserveEdits && input === focused) return;
    const field = input.dataset.field;
    let value = task[field];
    if (field === "due" && value) value = String(value).slice(0, 10);
    if (value === null || value === undefined) value = "";
    input.value = String(value);
  });

  renderMoveButtons(task);
  renderAttempts(task);
  renderComments(task);
}

function renderAttempts(task) {
  const host = state.refs.drawer.querySelector("#kb-attempts");
  host.textContent = "";
  const attempts = Array.isArray(task.attempts) ? task.attempts : [];
  if (attempts.length === 0) {
    const none = document.createElement("div");
    none.className = "kb-muted";
    none.textContent = "No attempts yet.";
    host.appendChild(none);
    return;
  }
  for (const attempt of attempts) {
    const el = document.createElement("div");
    el.className = "kb-attempt";

    const head = document.createElement("div");
    head.className = "kb-attempt-head";

    const agent = document.createElement("span");
    agent.className = "kb-attempt-agent";
    agent.textContent = attempt.agent || "unknown";
    head.appendChild(agent);

    if (attempt.result) {
      const result = document.createElement("span");
      result.className = `kb-attempt-result-${attempt.result === "success" ? "success" : "failure"}`;
      result.textContent = attempt.result;
      head.appendChild(result);
    }
    if (attempt.branch) {
      const branch = document.createElement("span");
      branch.className = "kb-attempt-branch";
      branch.textContent = attempt.branch;
      head.appendChild(branch);
    }
    const ts = document.createElement("span");
    ts.className = "kb-ts";
    ts.textContent = attempt.ended_at
      ? `${formatTs(attempt.started_at)} → ${formatTs(attempt.ended_at)}`
      : formatTs(attempt.started_at);
    head.appendChild(ts);
    el.appendChild(head);

    if (attempt.note) {
      const note = document.createElement("div");
      note.textContent = attempt.note;
      el.appendChild(note);
    }
    host.appendChild(el);
  }
}

function renderComments(task) {
  const host = state.refs.drawer.querySelector("#kb-comments");
  host.textContent = "";
  const comments = Array.isArray(task.comments) ? task.comments : [];
  if (comments.length === 0) {
    const none = document.createElement("div");
    none.className = "kb-muted";
    none.textContent = "No comments yet.";
    host.appendChild(none);
    return;
  }
  for (const comment of comments) {
    const el = document.createElement("div");
    el.className = "kb-comment";

    const head = document.createElement("div");
    head.className = "kb-comment-head";
    const author = document.createElement("span");
    author.className = "kb-comment-author";
    author.textContent = comment.author || "unknown";
    const ts = document.createElement("span");
    ts.className = "kb-ts";
    ts.textContent = formatTs(comment.ts);
    head.append(author, ts);

    const text = document.createElement("div");
    text.textContent = comment.text || "";

    el.append(head, text);
    host.appendChild(el);
  }
}

async function patchOpenTask(field, rawValue) {
  const taskId = state.openTaskId;
  if (!taskId) return;

  let value = rawValue;
  if (field === "priority" || field === "progress") {
    value = parseInt(rawValue, 10);
    if (Number.isNaN(value)) {
      toast(`${field} must be a number`);
      const task = getTask(taskId);
      if (task) renderDrawer(task, { preserveEdits: false });
      return;
    }
  }
  if (field === "due" || field === "assignee" || field === "node") {
    if (typeof value === "string" && value.trim() === "") value = null;
  }

  try {
    const result = await api("PATCH", `/tasks/${encodeURIComponent(taskId)}`, { [field]: value });
    if (result?.task) {
      upsertTask(result.task);
      renderBoard();
    }
  } catch (err) {
    toast(`Update failed: ${err.message}`);
    await refreshBoard(); // restore server truth, incl. the drawer fields
  }
}

async function submitComment() {
  const taskId = state.openTaskId;
  if (!taskId) return;
  const { drawer } = state.refs;
  const authorInput = drawer.querySelector("#kb-comment-author");
  const textInput = drawer.querySelector("#kb-comment-text");
  const text = textInput.value.trim();
  if (!text) {
    textInput.focus();
    return;
  }
  const author = authorInput.value.trim() || "operator";
  try {
    const result = await api("POST", `/tasks/${encodeURIComponent(taskId)}/comments`, {
      author,
      text,
    });
    textInput.value = "";
    if (result?.task) {
      upsertTask(result.task);
      renderBoard();
    }
  } catch (err) {
    toast(`Comment failed: ${err.message}`);
  }
}

async function deleteOpenTask() {
  const taskId = state.openTaskId;
  if (!taskId) return;
  const task = getTask(taskId);
  const label = task ? `"${task.title}"` : taskId;
  if (!window.confirm(`Delete task ${label}? This cannot be undone.`)) return;
  try {
    await api("DELETE", `/tasks/${encodeURIComponent(taskId)}`);
    removeTask(taskId);
    closeDrawer();
    renderBoard();
  } catch (err) {
    toast(`Delete failed: ${err.message}`);
  }
}

function bindDrawerEvents() {
  const { drawer, backdrop } = state.refs;
  drawer.querySelector("#kb-drawer-close").addEventListener("click", closeDrawer);
  drawer.addEventListener("keydown", handleDrawerKeydown);
  backdrop.addEventListener("click", closeDrawer);
  drawer.querySelectorAll("[data-field]").forEach((input) => {
    input.addEventListener("change", () => patchOpenTask(input.dataset.field, input.value));
  });
  drawer.querySelector("#kb-comment-submit").addEventListener("click", submitComment);
  drawer.querySelector("#kb-delete").addEventListener("click", deleteOpenTask);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function teardown() {
  destroySortables();
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  state.dragging = false;
  state.pendingRefresh = false;
  state.openTaskId = null;
  state.forceBoard = false;
  state.moveModeTaskId = null;
  state.moveOrigin = null;
  state.drawerReturnTaskId = null;
}

/**
 * Entry point, called by views.js on every visit to the Kanban view.
 * @param {HTMLElement} containerEl - element holding the freshly injected partial
 */
export function init(containerEl) {
  teardown();
  state.container = containerEl;
  state.refs = {
    board: containerEl.querySelector("#kanban-board"),
    emptyState: containerEl.querySelector("#kanban-empty-state"),
    loading: containerEl.querySelector("#kb-loading"),
    drawer: containerEl.querySelector("#kb-drawer"),
    backdrop: containerEl.querySelector("#kb-backdrop"),
    live: containerEl.querySelector("#kb-live"),
    moveHint: containerEl.querySelector("#kb-move-hint"),
    kbdHint: containerEl.querySelector("#kb-kbd-hint"),
  };
  if (!state.refs.board) {
    console.error("[Kanban] Partial markup missing #kanban-board");
    return;
  }

  buildColumnSkeleton(state.refs.board);
  bindDrawerEvents();

  state.refs.emptyState.querySelector("#kb-empty-cta")?.addEventListener("click", () => {
    state.forceBoard = true;
    state.refs.emptyState.hidden = true;
    state.refs.board.hidden = false;
    toggleNewForm("inbox", true);
  });

  ensureEventSource();
  state.pollTimer = setInterval(() => scheduleRefresh(), POLL_INTERVAL_MS);

  refreshBoard();
  createSortables().catch((err) => {
    console.error("[Kanban] Drag & drop unavailable:", err);
    toast("Drag & drop unavailable: failed to load SortableJS");
  });
}
