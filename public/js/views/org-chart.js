/**
 * Org Chart view module — owner-defined agent hierarchy (drag & drop tree).
 *
 * Loaded by views.js via dynamic import; `init(containerEl)` runs on EVERY
 * visit to #view-org-chart. The partial HTML is re-injected before each call,
 * so all DOM references, SortableJS instances and timers are rebuilt from
 * scratch here.
 *
 * Data sources:
 *   GET /api/agents              — roster (cards: name, node, status dot)
 *   GET /api/fleet/org-chart     — persisted tree {version, roots, unassigned}
 *   PUT /api/fleet/org-chart     — full-tree replace (debounced after drop +
 *                                  explicit Save button + dirty indicator)
 *   SSE /api/events ("fleet.org"), 60s poll fallback (skipped while dirty)
 *
 * The MODEL is the source of truth: SortableJS rearranges the DOM, then the
 * tree is rebuilt from the DOM and re-rendered. Roster agents missing from
 * the roster render as ghosts with a remove affordance; removing a tree
 * ghost promotes its children into its place. Keyboard alternative mirrors
 * kanban's move mode: M toggles, arrows move (↑↓ siblings, ← promote /
 * root → tray, → nest under previous sibling / tray → root), Enter confirms,
 * Escape restores the pre-move-mode snapshot.
 */

import { t } from "../utils.js";

const SORTABLE_SRC = "/vendor/sortable.min.js";
const SAVE_DEBOUNCE_MS = 1500;
const POLL_INTERVAL_MS = 60000;
const SSE_MAX_RECONNECT_DELAY = 30000;
const TITLE_MAX = 120;

// ---------------------------------------------------------------------------
// Module state (reset/rebuilt on every init)
// ---------------------------------------------------------------------------

const state = {
  container: null,
  refs: {},
  roster: new Map(), // agentId -> roster agent record
  hostname: null, // local roster hostname (node label fallback)
  roots: [], // tree model: [{agentId, title, children: [...]}]
  tray: [], // unassigned agentIds, tray order
  titles: new Map(), // agentId -> title (survives DOM rebuilds)
  loaded: false,
  dirty: false,
  saving: false,
  saveError: null,
  savedOnce: false,
  saveTimer: null,
  pollTimer: null,
  sortables: [],
  dragging: false,
  moveModeId: null,
  moveSnapshot: null, // {roots, tray, titles, dirty} for Escape-cancel
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

function isActive() {
  return Boolean(state.container && state.container.isConnected);
}

function cssEscape(value) {
  return window.CSS?.escape ? CSS.escape(String(value)) : String(value);
}

function cardEl(agentId) {
  return state.container?.querySelector(`.org-card[data-id="${cssEscape(agentId)}"]`) || null;
}

/** Screen-reader announcement via the aria-live region. */
function announce(message) {
  const el = state.refs.live;
  if (!el) return;
  el.textContent = "";
  window.setTimeout(() => {
    if (isActive()) el.textContent = message;
  }, 30);
}

function agentLabel(agentId) {
  const agent = state.roster.get(agentId);
  return agent?.name || agentId;
}

// ---------------------------------------------------------------------------
// Tree model helpers (immutable-friendly: clones for snapshots, in-place
// splices on the working model followed by a full re-render)
// ---------------------------------------------------------------------------

function cloneTree(nodes) {
  return nodes.map((node) => ({
    agentId: node.agentId,
    title: node.title ?? null,
    children: cloneTree(Array.isArray(node.children) ? node.children : []),
  }));
}

function collectIds(nodes, into = new Set()) {
  for (const node of nodes) {
    into.add(node.agentId);
    collectIds(node.children, into);
  }
  return into;
}

/** Locate a node: {list, index, parents:[ancestor nodes]} or null. */
function findContext(list, agentId, parents = []) {
  for (let i = 0; i < list.length; i++) {
    const node = list[i];
    if (node.agentId === agentId) return { list, index: i, parents };
    const found = findContext(node.children, agentId, [...parents, node]);
    if (found) return found;
  }
  return null;
}

/** Rebuild the titles map from the current tree. */
function rebuildTitles() {
  state.titles = new Map();
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.title) state.titles.set(node.agentId, node.title);
      walk(node.children);
    }
  };
  walk(state.roots);
}

/**
 * Canonical tray: persisted/known tray order (minus anything now placed in
 * the tree), then any roster agents not yet placed anywhere. Called at
 * render time so newly discovered roster agents appear without marking the
 * chart dirty.
 */
function computeTray() {
  const placed = collectIds(state.roots);
  const seen = new Set();
  const tray = [];
  for (const id of state.tray) {
    if (!placed.has(id) && !seen.has(id)) {
      seen.add(id);
      tray.push(id);
    }
  }
  for (const id of state.roster.keys()) {
    if (!placed.has(id) && !seen.has(id)) {
      seen.add(id);
      tray.push(id);
    }
  }
  return tray;
}

// ---------------------------------------------------------------------------
// Data flow
// ---------------------------------------------------------------------------

async function fetchJson(path, options) {
  const response = await fetch(path, options);
  let data = null;
  try {
    data = await response.json();
  } catch (err) {
    // Non-JSON body — fall through to status check
  }
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}

async function fetchRoster() {
  const data = await fetchJson("/api/agents");
  const roster = new Map();
  for (const agent of Array.isArray(data?.agents) ? data.agents : []) {
    if (agent && typeof agent.id === "string" && agent.id) roster.set(agent.id, agent);
  }
  state.roster = roster;
  state.hostname = typeof data?.hostname === "string" ? data.hostname : null;
}

async function fetchChart() {
  const chart = await fetchJson("/api/fleet/org-chart");
  state.roots = cloneTree(Array.isArray(chart?.roots) ? chart.roots : []);
  state.tray = Array.isArray(chart?.unassigned) ? [...chart.unassigned] : [];
  rebuildTitles();
}

async function refreshAll() {
  if (!isActive()) return;
  try {
    await Promise.all([fetchRoster(), fetchChart()]);
    state.loaded = true;
    render();
  } catch (err) {
    console.error("[OrgChart] Failed to load:", err);
    if (state.refs.loading && !state.refs.loading.hidden) {
      state.refs.loading.textContent = t(
        "views.orgChart.loadError",
        {},
        "Failed to load org chart — retrying shortly.",
      );
    }
  }
}

/** Roster-only refresh (status dots); chart refetch only when clean. */
async function pollRefresh() {
  if (!isActive() || state.dragging || state.moveModeId) return;
  try {
    await fetchRoster();
    if (!state.dirty && !state.saving) await fetchChart();
    render();
  } catch (err) {
    console.error("[OrgChart] Poll refresh failed:", err);
  }
}

function ensureEventSource() {
  if (eventSource || typeof EventSource === "undefined") return;
  eventSource = new EventSource("/api/events");
  eventSource.onopen = () => {
    sseRetries = 0;
  };
  eventSource.addEventListener("fleet.org", () => {
    // External chart change — refetch unless local edits would be clobbered.
    if (isActive() && !state.dirty && !state.saving && !state.dragging) refreshAll();
  });
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
// Save (debounced full-tree PUT + explicit Save button + dirty indicator)
// ---------------------------------------------------------------------------

function serializeChart() {
  return JSON.stringify({ roots: state.roots, unassigned: state.tray });
}

function markDirty() {
  state.dirty = true;
  state.saveError = null;
  updateToolbar();
  scheduleSave();
}

function scheduleSave() {
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    state.saveTimer = null;
    save();
  }, SAVE_DEBOUNCE_MS);
}

async function save() {
  if (!isActive() || !state.dirty || state.saving) return;
  if (state.saveTimer) {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
  }
  const payload = serializeChart();
  state.saving = true;
  state.saveError = null;
  updateToolbar();
  try {
    await fetchJson("/api/fleet/org-chart", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roots: state.roots, unassigned: state.tray }),
    });
    state.saving = false;
    state.savedOnce = true;
    if (serializeChart() === payload) {
      state.dirty = false;
    } else {
      scheduleSave(); // edits landed mid-flight — keep dirty, save again
    }
  } catch (err) {
    // Conflict/failure: keep local state, surface a retry affordance.
    state.saving = false;
    state.saveError = err.message;
    toast(t("views.orgChart.saveFailed", { message: err.message }, "Save failed: {message}"));
  }
  updateToolbar();
}

function updateToolbar() {
  const { saveBtn, status } = state.refs;
  if (!saveBtn || !status) return;
  saveBtn.classList.toggle("org-save-retry", Boolean(state.saveError));
  if (state.saving) {
    saveBtn.disabled = true;
    saveBtn.textContent = t("views.orgChart.saving", {}, "Saving…");
    status.className = "org-status";
    status.textContent = "";
    return;
  }
  if (state.saveError) {
    saveBtn.disabled = false;
    saveBtn.textContent = t("views.orgChart.retrySave", {}, "Retry save");
    status.className = "org-status org-status-error";
    status.textContent = t(
      "views.orgChart.saveErrorStatus",
      { message: state.saveError },
      "Save failed: {message} — local changes kept",
    );
    return;
  }
  saveBtn.textContent = t("views.orgChart.save", {}, "Save");
  if (state.dirty) {
    saveBtn.disabled = false;
    status.className = "org-status org-status-dirty";
    status.textContent = t("views.orgChart.unsaved", {}, "● Unsaved changes");
  } else {
    saveBtn.disabled = true;
    status.className = "org-status org-status-saved";
    status.textContent = state.savedOnce ? t("views.orgChart.saved", {}, "All changes saved") : "";
  }
}

// ---------------------------------------------------------------------------
// Rendering (XSS-safe: all dynamic values go through textContent / value)
// ---------------------------------------------------------------------------

/** Agent card: status dot + name + node, optional title input, ghost remove. */
function buildCard(agentId, { withTitle }) {
  const agent = state.roster.get(agentId) || null;
  const ghost = agent === null;

  const card = document.createElement("div");
  card.className = ghost ? "org-card org-ghost" : "org-card";
  card.dataset.id = agentId;
  card.tabIndex = 0;
  card.setAttribute("role", "listitem");
  if (agentId === state.moveModeId) card.classList.add("org-move-mode");

  const dot = document.createElement("span");
  dot.className = agent?.active === true ? "org-dot active" : "org-dot";
  dot.title = ghost
    ? t("views.orgChart.ghostDot", {}, "Not in the roster")
    : agent.active === true
      ? t("views.orgChart.statusActive", {}, "Active")
      : t("views.orgChart.statusIdle", {}, "Idle");
  card.appendChild(dot);

  const main = document.createElement("div");
  main.className = "org-card-main";
  const name = document.createElement("div");
  name.className = "org-card-name";
  name.textContent = agent?.name || agentId;
  main.appendChild(name);
  const node = document.createElement("div");
  node.className = "org-card-node";
  node.textContent = ghost
    ? t("views.orgChart.ghostLabel", {}, "missing from roster")
    : agent.node || state.hostname || agent.source || "";
  main.appendChild(node);
  card.appendChild(main);

  const aria = ghost
    ? t("views.orgChart.ghostCardAria", { name: agentId }, "{name} — missing from roster")
    : t("views.orgChart.cardAria", { name: name.textContent }, "{name} — agent");
  card.setAttribute("aria-label", aria);

  if (withTitle && !ghost) {
    const title = document.createElement("input");
    title.className = "org-title-input";
    title.type = "text";
    title.maxLength = TITLE_MAX;
    title.value = state.titles.get(agentId) || "";
    title.placeholder = t("views.orgChart.titlePlaceholder", {}, "Title (optional)");
    title.setAttribute(
      "aria-label",
      t("views.orgChart.titleAria", { name: name.textContent }, "Role title for {name}"),
    );
    title.addEventListener("input", () => {
      const value = title.value.trim();
      if (value) state.titles.set(agentId, value);
      else state.titles.delete(agentId);
      const ctx = findContext(state.roots, agentId);
      if (ctx) ctx.list[ctx.index].title = value || null;
      markDirty();
    });
    // Keep card-level keyboard handling away from the text input.
    title.addEventListener("keydown", (e) => e.stopPropagation());
    card.appendChild(title);
  }

  if (ghost) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "org-remove";
    remove.textContent = "✕";
    remove.title = t(
      "views.orgChart.removeGhost",
      {},
      "Remove this missing agent (children move up)",
    );
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      removeGhost(agentId);
    });
    card.appendChild(remove);
  }

  card.addEventListener("keydown", (e) => handleCardKeydown(e, agentId));
  return card;
}

function buildNodeLi(node) {
  const li = document.createElement("li");
  li.className = "org-node";
  li.dataset.agentId = node.agentId;
  li.appendChild(buildCard(node.agentId, { withTitle: true }));

  const childrenUl = document.createElement("ul");
  childrenUl.className = "org-children";
  childrenUl.dataset.zone = "tree";
  for (const child of node.children) childrenUl.appendChild(buildNodeLi(child));
  li.appendChild(childrenUl);
  return li;
}

function buildTrayLi(agentId) {
  const li = document.createElement("li");
  li.className = "org-node";
  li.dataset.agentId = agentId;
  li.appendChild(buildCard(agentId, { withTitle: false }));
  return li;
}

function render() {
  if (!isActive() || !state.loaded) return;
  if (state.dragging) return; // never re-render under an active drag

  const { loading, layout, rootsUl, trayUl, trayCount, emptyHint, kbdHint } = state.refs;
  loading.hidden = true;
  layout.hidden = false;
  if (kbdHint) kbdHint.hidden = false;

  state.tray = computeTray();

  // Re-rendering destroys the focused card; remember it by id, refocus below.
  const focusedId = document.activeElement?.classList?.contains("org-card")
    ? document.activeElement.dataset.id
    : null;

  rootsUl.textContent = "";
  for (const node of state.roots) rootsUl.appendChild(buildNodeLi(node));
  emptyHint.hidden = state.roots.length > 0;

  trayUl.textContent = "";
  for (const id of state.tray) trayUl.appendChild(buildTrayLi(id));
  trayCount.textContent = String(state.tray.length);

  updateToolbar();
  if (focusedId) cardEl(focusedId)?.focus();

  createSortables().catch((err) => {
    console.error("[OrgChart] Drag & drop unavailable:", err);
  });
}

// ---------------------------------------------------------------------------
// Drag & drop (SortableJS nested lists, shared group)
// ---------------------------------------------------------------------------

async function createSortables() {
  const Sortable = await loadSortable();
  if (!isActive()) return;
  destroySortables();
  const lists = [
    state.refs.rootsUl,
    ...state.refs.rootsUl.querySelectorAll(".org-children"),
    state.refs.trayUl,
  ];
  for (const list of lists) {
    const instance = Sortable.create(list, {
      group: "org-chart",
      animation: 150,
      fallbackOnBody: true,
      swapThreshold: 0.65,
      ghostClass: "sortable-ghost",
      filter: "input,button",
      preventOnFilter: false,
      onStart: () => {
        state.dragging = true;
      },
      onEnd: handleDragEnd,
    });
    state.sortables = [...state.sortables, instance];
  }
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

/** Rebuild tree nodes from a UL (titles restored from the titles map). */
function nodesFromUl(ul) {
  const nodes = [];
  for (const li of ul.children) {
    const agentId = li.dataset?.agentId;
    if (!agentId) continue;
    const childUl = li.querySelector(":scope > .org-children");
    nodes.push({
      agentId,
      title: state.titles.get(agentId) || null,
      children: childUl ? nodesFromUl(childUl) : [],
    });
  }
  return nodes;
}

/** Tray ids from the tray UL — a dropped subtree is flattened depth-first. */
function trayIdsFromUl(ul) {
  const ids = [];
  const visit = (li) => {
    if (li.dataset?.agentId) ids.push(li.dataset.agentId);
    const childUl = li.querySelector(":scope > .org-children");
    if (childUl) for (const child of childUl.children) visit(child);
  };
  for (const li of ul.children) visit(li);
  return ids;
}

function handleDragEnd(evt) {
  state.dragging = false;
  const moved = evt.to !== evt.from || evt.oldIndex !== evt.newIndex;
  if (!moved) {
    render(); // normalize anyway (cheap) — covers cancelled drags
    return;
  }
  // The DOM now reflects the intended structure — rebuild the model from it.
  state.roots = nodesFromUl(state.refs.rootsUl);
  state.tray = trayIdsFromUl(state.refs.trayUl);
  markDirty();
  render();
  const movedId = evt.item?.dataset?.agentId;
  if (movedId) {
    announce(t("views.orgChart.movedAnnounce", { name: agentLabel(movedId) }, "{name} moved."));
  }
}

// ---------------------------------------------------------------------------
// Ghost removal (children promote into the ghost's place)
// ---------------------------------------------------------------------------

function removeGhost(agentId) {
  const ctx = findContext(state.roots, agentId);
  if (ctx) {
    const [removed] = ctx.list.splice(ctx.index, 1);
    ctx.list.splice(ctx.index, 0, ...removed.children);
  } else {
    state.tray = state.tray.filter((id) => id !== agentId);
  }
  state.titles.delete(agentId);
  markDirty();
  render();
  announce(t("views.orgChart.ghostRemoved", { name: agentId }, "Removed missing agent {name}."));
}

// ---------------------------------------------------------------------------
// Keyboard move mode (parallel input path to drag & drop; same save flow)
// ---------------------------------------------------------------------------

function updateMoveHint(agentId) {
  const hint = state.refs.moveHint;
  if (!hint) return;
  if (!agentId) {
    hint.hidden = true;
    hint.textContent = "";
    return;
  }
  hint.hidden = false;
  hint.textContent = t(
    "views.orgChart.moveHint",
    { name: agentLabel(agentId) },
    'Move mode: "{name}" — ↑/↓ among siblings, ← promote (root → tray), → nest under previous sibling (tray → root), Enter confirm, Esc cancel',
  );
}

function enterMoveMode(agentId) {
  state.moveModeId = agentId;
  state.moveSnapshot = {
    roots: cloneTree(state.roots),
    tray: [...state.tray],
    titles: new Map(state.titles),
    dirty: state.dirty,
  };
  cardEl(agentId)?.classList.add("org-move-mode");
  updateMoveHint(agentId);
  announce(
    t(
      "views.orgChart.moveModeOn",
      { name: agentLabel(agentId) },
      'Move mode on for "{name}". Use arrow keys to move, Enter to confirm, Escape to cancel.',
    ),
  );
}

function exitMoveMode() {
  const agentId = state.moveModeId;
  state.moveModeId = null;
  state.moveSnapshot = null;
  if (agentId) cardEl(agentId)?.classList.remove("org-move-mode");
  updateMoveHint(null);
}

function confirmMoveMode(agentId) {
  exitMoveMode();
  announce(
    t(
      "views.orgChart.moveConfirmed",
      { name: agentLabel(agentId) },
      'Move confirmed for "{name}".',
    ),
  );
  cardEl(agentId)?.focus();
}

function cancelMoveMode(agentId) {
  const snapshot = state.moveSnapshot;
  exitMoveMode();
  if (snapshot) {
    state.roots = snapshot.roots;
    state.tray = snapshot.tray;
    state.titles = snapshot.titles;
    if (snapshot.dirty) {
      markDirty(); // pre-move-mode state itself was unsaved
    } else {
      state.dirty = false;
      if (state.saveTimer) {
        clearTimeout(state.saveTimer);
        state.saveTimer = null;
      }
      // A debounced save may have fired mid-move-mode; persist the restore.
      if (state.savedOnce || state.saving) markDirty();
    }
  }
  render();
  announce(
    t(
      "views.orgChart.moveCancelled",
      { name: agentLabel(agentId) },
      'Move cancelled: "{name}" restored.',
    ),
  );
  cardEl(agentId)?.focus();
}

/** Where does this card currently live? {zone: "tree"|"tray", ctx} */
function locate(agentId) {
  const ctx = findContext(state.roots, agentId);
  if (ctx) return { zone: "tree", ctx };
  const index = state.tray.indexOf(agentId);
  return index === -1 ? null : { zone: "tray", index };
}

function afterKeyboardMove(agentId, message) {
  markDirty();
  render();
  cardEl(agentId)?.focus();
  updateMoveHint(agentId);
  announce(message);
}

/** ↑/↓ — reorder among siblings (tree) or within the tray. */
function keyboardReorder(agentId, delta) {
  const loc = locate(agentId);
  if (!loc) return;
  const name = agentLabel(agentId);
  if (loc.zone === "tray") {
    const to = loc.index + delta;
    if (to < 0 || to >= state.tray.length) return;
    const tray = [...state.tray];
    tray.splice(loc.index, 1);
    tray.splice(to, 0, agentId);
    state.tray = tray;
    afterKeyboardMove(
      agentId,
      t(
        "views.orgChart.movedToPosition",
        { name, position: to + 1, total: tray.length },
        '"{name}" moved to position {position} of {total}.',
      ),
    );
    return;
  }
  const { list, index } = loc.ctx;
  const to = index + delta;
  if (to < 0 || to >= list.length) return;
  const [node] = list.splice(index, 1);
  list.splice(to, 0, node);
  afterKeyboardMove(
    agentId,
    t(
      "views.orgChart.movedToPosition",
      { name, position: to + 1, total: list.length },
      '"{name}" moved to position {position} of {total}.',
    ),
  );
}

/** ← — promote one level; from root level, move to the Unassigned tray. */
function keyboardPromote(agentId) {
  const loc = locate(agentId);
  if (!loc) return;
  const name = agentLabel(agentId);
  if (loc.zone === "tray") {
    announce(t("views.orgChart.alreadyUnassigned", { name }, '"{name}" is already unassigned.'));
    return;
  }
  const { list, index, parents } = loc.ctx;
  const [node] = list.splice(index, 1);
  if (parents.length === 0) {
    // Root level → tray (children are flattened into the tray too).
    const subtreeIds = [...collectIds([node])];
    state.tray = [...state.tray, ...subtreeIds];
    afterKeyboardMove(
      agentId,
      t("views.orgChart.movedToTray", { name }, '"{name}" moved to Unassigned.'),
    );
    return;
  }
  const parent = parents[parents.length - 1];
  const grandList = parents.length > 1 ? parents[parents.length - 2].children : state.roots;
  grandList.splice(grandList.indexOf(parent) + 1, 0, node);
  afterKeyboardMove(
    agentId,
    t(
      "views.orgChart.promoted",
      { name, parent: agentLabel(parent.agentId) },
      '"{name}" promoted next to {parent}.',
    ),
  );
}

/** → — nest under the previous sibling; from the tray, append to roots. */
function keyboardDemote(agentId) {
  const loc = locate(agentId);
  if (!loc) return;
  const name = agentLabel(agentId);
  if (loc.zone === "tray") {
    state.tray = state.tray.filter((id) => id !== agentId);
    state.roots.push({ agentId, title: state.titles.get(agentId) || null, children: [] });
    afterKeyboardMove(
      agentId,
      t("views.orgChart.movedToRoots", { name }, '"{name}" placed at the top level.'),
    );
    return;
  }
  const { list, index } = loc.ctx;
  if (index === 0) {
    announce(
      t(
        "views.orgChart.needSibling",
        { name },
        'Cannot nest "{name}" — no sibling above to become its parent.',
      ),
    );
    return;
  }
  const [node] = list.splice(index, 1);
  const newParent = list[index - 1];
  newParent.children.push(node);
  afterKeyboardMove(
    agentId,
    t(
      "views.orgChart.demoted",
      { name, parent: agentLabel(newParent.agentId) },
      '"{name}" now reports to {parent}.',
    ),
  );
}

function handleCardKeydown(e, agentId) {
  const inMoveMode = state.moveModeId === agentId;
  switch (e.key) {
    case "m":
    case "M":
      e.preventDefault();
      if (inMoveMode) confirmMoveMode(agentId);
      else enterMoveMode(agentId);
      return;
    case "Enter":
      if (inMoveMode) {
        e.preventDefault();
        confirmMoveMode(agentId);
      }
      return;
    case "Escape":
      if (inMoveMode) {
        e.preventDefault();
        cancelMoveMode(agentId);
      }
      return;
    case "ArrowUp":
    case "ArrowDown":
      if (inMoveMode) {
        e.preventDefault();
        keyboardReorder(agentId, e.key === "ArrowUp" ? -1 : 1);
      }
      return;
    case "ArrowLeft":
      if (inMoveMode) {
        e.preventDefault();
        keyboardPromote(agentId);
      }
      return;
    case "ArrowRight":
      if (inMoveMode) {
        e.preventDefault();
        keyboardDemote(agentId);
      }
      return;
    default:
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function teardown() {
  destroySortables();
  if (state.saveTimer) {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
  }
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  state.loaded = false;
  state.dragging = false;
  state.dirty = false;
  state.saving = false;
  state.saveError = null;
  state.savedOnce = false;
  state.moveModeId = null;
  state.moveSnapshot = null;
  state.roots = [];
  state.tray = [];
  state.titles = new Map();
}

/**
 * Entry point, called by views.js on every visit to the Org Chart view.
 * @param {HTMLElement} containerEl - element holding the freshly injected partial
 */
export function init(containerEl) {
  teardown();
  state.container = containerEl;
  state.refs = {
    loading: containerEl.querySelector("#org-loading"),
    layout: containerEl.querySelector("#org-layout"),
    rootsUl: containerEl.querySelector("#org-roots"),
    trayUl: containerEl.querySelector("#org-tray"),
    trayCount: containerEl.querySelector("#org-tray-count"),
    emptyHint: containerEl.querySelector("#org-empty-hint"),
    saveBtn: containerEl.querySelector("#org-save"),
    status: containerEl.querySelector("#org-status"),
    live: containerEl.querySelector("#org-live"),
    moveHint: containerEl.querySelector("#org-move-hint"),
    kbdHint: containerEl.querySelector("#org-kbd-hint"),
  };
  if (!state.refs.rootsUl || !state.refs.trayUl) {
    console.error("[OrgChart] Partial markup missing #org-roots / #org-tray");
    return;
  }

  state.refs.saveBtn.addEventListener("click", () => save());

  ensureEventSource();
  state.pollTimer = setInterval(() => pollRefresh(), POLL_INTERVAL_MS);
  refreshAll();
}
