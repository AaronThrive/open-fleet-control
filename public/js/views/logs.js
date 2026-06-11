/**
 * Logs (audit trail) view module.
 *
 * Loaded by views.js via dynamic import; `init(containerEl)` runs on every
 * visit of #view-logs and must be idempotent: all DOM lookups and event
 * bindings happen fresh inside init (the partial HTML is re-injected each
 * visit), and the previous auto-refresh timer is cleared before a new one
 * starts.
 *
 * Data source: GET /api/fleet/audit?user=&action=&since=&until=&limit=
 * (newest-first entries: { id, ts, user, action, target, detail }).
 *
 * On top of the server-side filters the view adds:
 *   - an action-type filter populated dynamically from the entries present
 *     (accumulated across loads — never hardcoded),
 *   - actor suggestions (datalist) from the actors present,
 *   - client-side free-text search over user/action/target/detail,
 *   - client-side pagination of the (search-filtered) result set,
 *   - a count summary ("N entries, M actions, K actors").
 *
 * All entry values are rendered via textContent — never innerHTML — so the
 * trail is XSS-safe even with hostile user/target/detail strings.
 */

import { t } from "../utils.js";

const AUTO_REFRESH_MS = 60000;
const FILTER_DEBOUNCE_MS = 350;
const PAGE_SIZE = 50;

/** Action prefix → badge CSS suffix (palette defined in the partial). */
const ACTION_CATEGORIES = {
  task: "task",
  brief: "brief",
  lesson: "lesson",
  gate: "gate",
  node: "node",
  alerts: "alerts",
  alert: "alerts",
  memory: "memory",
  settings: "alerts",
  privacy: "alerts",
  chat: "brief",
  topic: "memory",
  operator: "node",
  session: "node",
  cron: "gate",
  job: "gate",
  cache: "gate",
  action: "gate",
};

// Module-scope state (the module itself is cached by the browser; only
// init() re-runs on each visit).
let refreshTimer = null;
let debounceTimer = null;
let requestSeq = 0;
let currentRows = [];
let fetchedEntries = [];
let currentPage = 1;
const expandedIds = new Set();
// Facets accumulate across loads so filter options stay stable while the
// user narrows the query (options are only ever added, never removed).
const seenActions = new Set();
const seenActors = new Set();

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for node:test)                               */
/* ------------------------------------------------------------------ */

/**
 * Case-insensitive free-text match over an entry's user, action, target,
 * timestamp and JSON-serialized detail. Empty/blank terms match everything.
 * @param {object} entry - audit entry
 * @param {string} term - raw search input
 * @returns {boolean}
 */
export function entryMatchesSearch(entry, term) {
  const needle = String(term ?? "")
    .trim()
    .toLowerCase();
  if (!needle) return true;
  if (!entry || typeof entry !== "object") return false;
  let detailText = "";
  try {
    detailText = entry.detail == null ? "" : JSON.stringify(entry.detail);
  } catch (e) {
    detailText = "";
  }
  const haystack = [entry.user, entry.action, entry.target, entry.ts, detailText]
    .map((v) => (v == null ? "" : String(v)))
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle);
}

/**
 * Slice a list into the requested page, clamping the page number into the
 * valid range (so deleting rows or tightening filters never strands the
 * user on an empty page).
 * @param {Array} list
 * @param {number} page - 1-based requested page
 * @param {number} pageSize
 * @returns {{items: Array, page: number, totalPages: number, total: number}}
 */
export function paginate(list, page, pageSize) {
  const all = Array.isArray(list) ? list : [];
  const size = Number.isFinite(pageSize) && pageSize >= 1 ? Math.floor(pageSize) : PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(all.length / size));
  const safePage = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const start = (safePage - 1) * size;
  return { items: all.slice(start, start + size), page: safePage, totalPages, total: all.length };
}

/**
 * Count summary for the visible result set.
 * @param {Array<object>} entries
 * @returns {{entries: number, actions: number, actors: number}}
 */
export function summarize(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const actions = new Set();
  const actors = new Set();
  for (const entry of list) {
    if (entry && entry.action) actions.add(String(entry.action));
    if (entry && entry.user) actors.add(String(entry.user));
  }
  return { entries: list.length, actions: actions.size, actors: actors.size };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function badgeClassFor(action) {
  const prefix = String(action).split(".")[0];
  const suffix = ACTION_CATEGORIES[prefix] || "memory";
  return `logs-action-${suffix}`;
}

/** Relative display like "12s ago" / "5m ago" / "3h ago" / "2d ago". */
function relativeTime(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso);
  const diff = Date.now() - ms;
  if (diff < 0) return new Date(ms).toLocaleString();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return t("time.agoSeconds", { n: sec }, "{n}s ago");
  const min = Math.floor(sec / 60);
  if (min < 60) return t("time.agoMinutes", { n: min }, "{n}m ago");
  const hours = Math.floor(min / 60);
  if (hours < 24) return t("time.agoHours", { n: hours }, "{n}h ago");
  const days = Math.floor(hours / 24);
  if (days < 30) return t("time.agoDays", { n: days }, "{n}d ago");
  return new Date(ms).toLocaleDateString();
}

/** Build the query string from the current filter inputs. */
function buildQuery(els) {
  const params = new URLSearchParams();
  const user = els.user.value.trim();
  if (user) params.set("user", user);
  if (els.action.value) params.set("action", els.action.value);
  // Date inputs hold a plain YYYY-MM-DD; widen them to cover the full local
  // day so "until" is inclusive of the selected date.
  if (els.since.value) params.set("since", `${els.since.value}T00:00:00`);
  if (els.until.value) params.set("until", `${els.until.value}T23:59:59.999`);
  params.set("limit", els.limit.value || "200");
  return params.toString();
}

/* ------------------------------------------------------------------ */
/* Dynamic filter options (from the entries present)                   */
/* ------------------------------------------------------------------ */

function updateFacets(entries) {
  for (const entry of entries) {
    if (entry && entry.action) seenActions.add(String(entry.action));
    if (entry && entry.user) seenActors.add(String(entry.user));
  }
}

/** Rebuild the action <select> options (after the "All actions" option). */
function rebuildActionOptions(els) {
  const selected = els.action.value;
  const known = new Set(
    Array.from(els.action.options)
      .map((opt) => opt.value)
      .filter(Boolean),
  );
  const wanted = Array.from(seenActions).sort();
  if (wanted.length === known.size && wanted.every((a) => known.has(a))) return;

  // Keep the first ("All actions") option, replace the rest.
  while (els.action.options.length > 1) els.action.remove(1);
  for (const action of wanted) {
    const opt = document.createElement("option");
    opt.value = action;
    opt.textContent = action;
    els.action.appendChild(opt);
  }
  // seenActions only grows, so a previously selected action always survives.
  els.action.value = selected;
}

/** Rebuild the actor suggestions datalist. */
function rebuildActorOptions(els) {
  const wanted = Array.from(seenActors).sort();
  const known = Array.from(els.actorOptions.children).map((opt) => opt.value);
  if (wanted.length === known.length && wanted.every((a, i) => known[i] === a)) return;
  els.actorOptions.replaceChildren(
    ...wanted.map((actor) => {
      const opt = document.createElement("option");
      opt.value = actor;
      return opt;
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Rendering (DOM-built, textContent only — XSS-safe)                  */
/* ------------------------------------------------------------------ */

function buildRow(entry) {
  const row = document.createElement("div");
  row.className = "logs-row";
  if (entry.id && expandedIds.has(entry.id)) row.classList.add("expanded");

  const main = document.createElement("div");
  main.className = "logs-row-main";

  const time = document.createElement("span");
  time.className = "logs-time";
  time.textContent = relativeTime(entry.ts);
  time.title = String(entry.ts);

  const userCell = document.createElement("span");
  const userChip = document.createElement("span");
  userChip.className = "logs-user-chip";
  userChip.textContent = entry.user || "anonymous";
  userChip.title = entry.user || "anonymous";
  userCell.appendChild(userChip);

  const actionCell = document.createElement("span");
  const badge = document.createElement("span");
  badge.className = `logs-action-badge ${badgeClassFor(entry.action)}`;
  badge.textContent = String(entry.action);
  actionCell.appendChild(badge);

  const target = document.createElement("span");
  target.className = "logs-target";
  if (entry.target) {
    target.textContent = entry.target;
    target.title = entry.target;
  } else {
    target.textContent = "—";
    target.classList.add("logs-target-empty");
  }

  const caret = document.createElement("span");
  caret.className = "logs-caret";
  caret.textContent = "▶";

  main.append(time, userCell, actionCell, target, caret);
  row.appendChild(main);

  const detail = document.createElement("div");
  detail.className = "logs-detail";
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(
    { id: entry.id, ts: entry.ts, detail: entry.detail ?? null },
    null,
    2,
  );
  detail.appendChild(pre);
  row.appendChild(detail);

  main.addEventListener("click", () => {
    const nowExpanded = row.classList.toggle("expanded");
    if (!entry.id) return;
    if (nowExpanded) {
      expandedIds.add(entry.id);
    } else {
      expandedIds.delete(entry.id);
    }
  });

  return row;
}

/**
 * Apply the client-side search + pagination to the fetched entries and
 * render the current page. Pure presentation — no refetch.
 */
function renderCurrent(els) {
  const term = els.search.value;
  const filtered = term.trim()
    ? fetchedEntries.filter((entry) => entryMatchesSearch(entry, term))
    : fetchedEntries;

  const { items, page, totalPages, total } = paginate(filtered, currentPage, PAGE_SIZE);
  currentPage = page;
  currentRows = filtered;

  els.rows.replaceChildren(...items.map(buildRow));

  const summary = summarize(filtered);
  els.countLine.textContent = t(
    "views.logs.summary",
    { n: summary.entries, m: summary.actions, k: summary.actors },
    "{n} entries, {m} actions, {k} actors",
  );

  els.table.hidden = total === 0;
  els.emptyState.style.display = total === 0 ? "" : "none";

  els.pagination.hidden = totalPages <= 1;
  els.pageInfo.textContent = t(
    "views.logs.pageInfo",
    { page, pages: totalPages },
    "Page {page} / {pages}",
  );
  els.pagePrev.disabled = page <= 1;
  els.pageNext.disabled = page >= totalPages;
}

function showError(els, message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

function clearError(els) {
  els.error.hidden = true;
  els.error.textContent = "";
}

/* ------------------------------------------------------------------ */
/* Data loading                                                        */
/* ------------------------------------------------------------------ */

async function load(els) {
  const seq = ++requestSeq;
  try {
    const response = await fetch(`/api/fleet/audit?${buildQuery(els)}`);
    const payload = await response.json().catch(() => ({}));
    if (seq !== requestSeq || !els.rows.isConnected) return; // stale response
    if (!response.ok) {
      showError(
        els,
        payload.error ||
          t(
            "views.logs.queryFailed",
            { status: response.status },
            "Audit query failed (HTTP {status})",
          ),
      );
      return;
    }
    clearError(els);
    fetchedEntries = Array.isArray(payload.entries) ? payload.entries : [];
    updateFacets(fetchedEntries);
    rebuildActionOptions(els);
    rebuildActorOptions(els);
    renderCurrent(els);
  } catch (error) {
    if (seq !== requestSeq || !els.rows.isConnected) return;
    showError(
      els,
      t("views.logs.networkError", {}, "Could not reach the audit API — is the server up?"),
    );
  }
}

/** Download the current (search-filtered) rows as a JSON file. */
function exportView() {
  const blob = new Blob([JSON.stringify(currentRows, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `audit-export-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

function stopTimers() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

/**
 * Initialize the Logs panel. Called by views.js on every visit with the
 * container that holds the freshly injected partial HTML.
 *
 * @param {HTMLElement} container
 */
export function init(container) {
  stopTimers();

  const els = {
    user: container.querySelector("#logs-filter-user"),
    actorOptions: container.querySelector("#logs-actor-options"),
    action: container.querySelector("#logs-filter-action"),
    search: container.querySelector("#logs-filter-search"),
    searchLabel: container.querySelector("#logs-filter-search-label"),
    since: container.querySelector("#logs-filter-since"),
    until: container.querySelector("#logs-filter-until"),
    limit: container.querySelector("#logs-filter-limit"),
    refreshBtn: container.querySelector("#logs-refresh-btn"),
    exportBtn: container.querySelector("#logs-export-btn"),
    emptyRefreshBtn: container.querySelector("#logs-empty-refresh"),
    countLine: container.querySelector("#logs-count-line"),
    error: container.querySelector("#logs-error"),
    table: container.querySelector("#logs-table"),
    rows: container.querySelector("#logs-rows"),
    emptyState: container.querySelector("#logs-empty-state"),
    pagination: container.querySelector("#logs-pagination"),
    pageInfo: container.querySelector("#logs-page-info"),
    pagePrev: container.querySelector("#logs-page-prev"),
    pageNext: container.querySelector("#logs-page-next"),
  };
  if (Object.values(els).some((el) => !el)) {
    console.error("[Logs] Partial markup is missing expected elements; aborting init.");
    return;
  }

  // New-element labels (keys are not in the locale files; t() falls back).
  els.searchLabel.textContent = t("views.logs.filterSearch", {}, "Search");
  els.search.placeholder = t("views.logs.searchPlaceholder", {}, "free text…");
  els.pagePrev.textContent = t("views.logs.pagePrev", {}, "← Prev");
  els.pageNext.textContent = t("views.logs.pageNext", {}, "Next →");

  const applyDebounced = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      currentPage = 1;
      load(els);
    }, FILTER_DEBOUNCE_MS);
  };

  els.user.addEventListener("input", applyDebounced);
  for (const el of [els.action, els.since, els.until, els.limit]) {
    el.addEventListener("change", applyDebounced);
  }

  // Free-text search filters client-side: instant, no refetch.
  els.search.addEventListener("input", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      currentPage = 1;
      renderCurrent(els);
    }, FILTER_DEBOUNCE_MS);
  });

  els.pagePrev.addEventListener("click", () => {
    currentPage -= 1;
    renderCurrent(els);
  });
  els.pageNext.addEventListener("click", () => {
    currentPage += 1;
    renderCurrent(els);
  });

  els.refreshBtn.addEventListener("click", () => load(els));
  els.emptyRefreshBtn.addEventListener("click", () => load(els));
  els.exportBtn.addEventListener("click", exportView);

  // Auto-refresh while the view stays visible. The interval self-cancels
  // once this partial's DOM is replaced (user navigated away) and skips
  // ticks while the tab is hidden.
  refreshTimer = setInterval(() => {
    if (!els.rows.isConnected) {
      stopTimers();
      return;
    }
    if (document.hidden) return;
    load(els);
  }, AUTO_REFRESH_MS);

  load(els);
}
