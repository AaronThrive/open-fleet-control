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
 * All entry values are rendered via textContent — never innerHTML — so the
 * trail is XSS-safe even with hostile user/target/detail strings.
 */

const AUTO_REFRESH_MS = 60000;
const FILTER_DEBOUNCE_MS = 350;

/** Action prefix → badge CSS suffix (palette defined in the partial). */
const ACTION_CATEGORIES = {
  task: "task",
  brief: "brief",
  lesson: "lesson",
  gate: "gate",
  node: "node",
  alerts: "alerts",
  memory: "memory",
};

// Module-scope state (the module itself is cached by the browser; only
// init() re-runs on each visit).
let refreshTimer = null;
let debounceTimer = null;
let requestSeq = 0;
let currentRows = [];
const expandedIds = new Set();

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
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
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

function render(els, entries) {
  currentRows = entries;
  els.rows.replaceChildren(...entries.map(buildRow));
  els.countLine.textContent = `${entries.length} ${entries.length === 1 ? "entry" : "entries"} shown`;
  els.table.hidden = entries.length === 0;
  els.emptyState.style.display = entries.length === 0 ? "" : "none";
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
      showError(els, payload.error || `Audit query failed (HTTP ${response.status})`);
      return;
    }
    clearError(els);
    render(els, Array.isArray(payload.entries) ? payload.entries : []);
  } catch (error) {
    if (seq !== requestSeq || !els.rows.isConnected) return;
    showError(els, "Could not reach the audit API — is the server up?");
  }
}

/** Download the currently rendered rows as a JSON file (client-side blob). */
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
    action: container.querySelector("#logs-filter-action"),
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
  };
  if (Object.values(els).some((el) => !el)) {
    console.error("[Logs] Partial markup is missing expected elements; aborting init.");
    return;
  }

  const applyDebounced = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => load(els), FILTER_DEBOUNCE_MS);
  };

  els.user.addEventListener("input", applyDebounced);
  for (const el of [els.action, els.since, els.until, els.limit]) {
    el.addEventListener("change", applyDebounced);
  }

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
