/**
 * Timeline drawer — right-side drawer showing one agent's flight-recorder
 * timeline (GET /api/fleet/agents/:id/timeline).
 *
 * Self-contained zero-build browser ESM: injects its own styles once, builds
 * all DOM via createElement/textContent (never innerHTML with remote
 * strings), and cleans up fully on close (ESC, backdrop click, ✕ button).
 *
 * Features: date-range chips (today / 24h / 7d / custom), per-type filter
 * chips, summary strip (events, sessions, dispatches, tokens, cost), events
 * grouped by day (newest first), lazy "load more" via the page.nextUntil
 * cursor.
 *
 * Pure helpers (groupEventsByDay, typeIcon, rangeToWindow, buildTimelineUrl)
 * are exported for node:test coverage.
 */

import { t } from "../utils.js";

const STYLE_ID = "timeline-drawer-styles";
const DRAWER_ID = "timeline-drawer-root";

export const EVENT_TYPES = [
  "session.start",
  "session.end",
  "dispatch",
  "dispatch.result",
  "cron.run",
  "audit",
  "note",
];

const TYPE_ICONS = {
  "session.start": "▶️",
  "session.end": "⏹️",
  dispatch: "🚀",
  "dispatch.result": "🏁",
  "cron.run": "⏰",
  audit: "📋",
  note: "💬",
};

const CSS = `
.tld-backdrop {
  position: fixed; inset: 0; z-index: 900;
  background: rgba(0, 0, 0, 0.45);
}
.tld-drawer {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 901;
  width: min(480px, 92vw); display: flex; flex-direction: column;
  background: var(--bg, #0d1117); border-left: 1px solid var(--border, #30363d);
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.4);
}
.tld-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 14px; border-bottom: 1px solid var(--border, #30363d);
}
.tld-title { font-size: 0.9rem; font-weight: 700; color: var(--text, #e6edf3); }
.tld-close {
  background: none; border: none; cursor: pointer; font-size: 1rem;
  color: var(--text-muted, #8b949e); padding: 4px 8px; border-radius: 6px;
}
.tld-close:hover { color: var(--text, #e6edf3); background: rgba(255,255,255,0.06); }
.tld-controls {
  display: flex; flex-direction: column; gap: 8px;
  padding: 10px 14px; border-bottom: 1px solid var(--border, #30363d);
}
.tld-chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
.tld-chip {
  font-size: 0.68rem; padding: 3px 9px; border-radius: 999px; cursor: pointer;
  background: transparent; color: var(--text-muted, #8b949e);
  border: 1px solid var(--border, #30363d);
}
.tld-chip.tld-on {
  color: var(--text, #e6edf3); border-color: var(--accent, #58a6ff);
  background: rgba(88, 166, 255, 0.12);
}
.tld-custom { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.tld-custom input {
  font-size: 0.7rem; padding: 3px 6px; background: var(--bg, #0d1117);
  color: var(--text, #e6edf3); border: 1px solid var(--border, #30363d);
  border-radius: 6px;
}
.tld-summary {
  display: flex; flex-wrap: wrap; gap: 6px 14px; padding: 8px 14px;
  font-size: 0.7rem; color: var(--text-muted, #8b949e);
  border-bottom: 1px solid var(--border, #30363d);
}
.tld-summary b { color: var(--text, #e6edf3); font-weight: 700; }
.tld-body { flex: 1; overflow-y: auto; padding: 10px 14px 20px; }
.tld-status { font-size: 0.75rem; color: var(--text-muted, #8b949e); padding: 12px 0; }
.tld-status.tld-error { color: var(--danger, #f85149); }
.tld-day {
  font-size: 0.66rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--text-muted, #8b949e);
  margin: 14px 0 6px; padding-bottom: 4px;
  border-bottom: 1px solid var(--border, #30363d);
}
.tld-event { display: flex; gap: 8px; padding: 5px 0; align-items: baseline; }
.tld-time {
  flex: 0 0 44px; font-size: 0.66rem; color: var(--text-muted, #8b949e);
  font-variant-numeric: tabular-nums;
}
.tld-icon { flex: 0 0 18px; font-size: 0.72rem; }
.tld-event-main { flex: 1; min-width: 0; }
.tld-event-title { font-size: 0.74rem; color: var(--text, #e6edf3); overflow-wrap: anywhere; }
.tld-event-detail {
  font-size: 0.66rem; color: var(--text-muted, #8b949e);
  overflow-wrap: anywhere; margin-top: 1px;
}
.tld-ref {
  display: inline-block; font-size: 0.62rem; margin-top: 2px; margin-right: 4px;
  padding: 1px 6px; border-radius: 4px; border: 1px solid var(--border, #30363d);
  color: var(--text-muted, #8b949e); font-family: monospace;
}
.tld-more {
  display: block; width: 100%; margin-top: 12px; padding: 7px;
  font-size: 0.72rem; cursor: pointer; border-radius: 6px;
  background: transparent; color: var(--accent, #58a6ff);
  border: 1px solid var(--border, #30363d);
}
.tld-more:hover { background: rgba(88, 166, 255, 0.08); }
`;

// --- Pure helpers (exported for node:test) ----------------------------------

/** Icon for an event type (generic fallback for unknown types). */
export function typeIcon(type) {
  return TYPE_ICONS[type] || "•";
}

/**
 * Group events (assumed newest-first) into day buckets, preserving order.
 * @param {Array<{ts: string}>} events
 * @returns {Array<{day: string, events: Array}>} day is the local YYYY-MM-DD
 */
export function groupEventsByDay(events) {
  const groups = [];
  let current = null;
  for (const event of Array.isArray(events) ? events : []) {
    const date = new Date(event.ts);
    const day = Number.isFinite(date.getTime())
      ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
          date.getDate(),
        ).padStart(2, "0")}`
      : "unknown";
    if (!current || current.day !== day) {
      current = { day, events: [] };
      groups.push(current);
    }
    current.events.push(event);
  }
  return groups;
}

/**
 * Resolve a named range to a {sinceMs, untilMs} window.
 * @param {"today"|"24h"|"7d"} range
 * @param {number} [nowMs]
 */
export function rangeToWindow(range, nowMs = Date.now()) {
  const now = new Date(nowMs);
  if (range === "today") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { sinceMs: start.getTime(), untilMs: nowMs };
  }
  if (range === "7d") return { sinceMs: nowMs - 7 * 24 * 3600 * 1000, untilMs: nowMs };
  return { sinceMs: nowMs - 24 * 3600 * 1000, untilMs: nowMs };
}

/** Compose the timeline API URL for an agent + window + filters. */
export function buildTimelineUrl(agentId, { sinceMs, untilMs, types, limit } = {}) {
  const params = new URLSearchParams();
  if (Number.isFinite(sinceMs)) params.set("since", String(sinceMs));
  if (Number.isFinite(untilMs)) params.set("until", String(untilMs));
  if (Array.isArray(types) && types.length > 0 && types.length < EVENT_TYPES.length) {
    params.set("types", types.join(","));
  }
  if (Number.isFinite(limit)) params.set("limit", String(limit));
  const qs = params.toString();
  return `/api/fleet/agents/${encodeURIComponent(agentId)}/timeline${qs ? `?${qs}` : ""}`;
}

// --- Drawer -----------------------------------------------------------------

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtTime(ts) {
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) return "—";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function fmtTokens(tokens) {
  if (!Number.isFinite(tokens)) return "0";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

/** One compact human line out of an event's detail object. */
function detailLine(event) {
  const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
  const parts = [];
  if (typeof detail.text === "string" && detail.text) parts.push(detail.text);
  if (typeof detail.note === "string" && detail.note) parts.push(detail.note);
  if (typeof detail.result === "string" && detail.result) parts.push(detail.result);
  if (typeof detail.status === "string" && detail.status) parts.push(detail.status);
  if (typeof detail.model === "string" && detail.model) parts.push(detail.model);
  if (Number.isFinite(detail.tokens)) parts.push(`${fmtTokens(detail.tokens)} tok`);
  if (event.type === "audit" && typeof detail.role === "string") parts.push(detail.role);
  return parts.join(" · ").slice(0, 220);
}

/**
 * Open the timeline drawer for an agent. Any existing drawer is replaced.
 * @param {{agentId: string, agentName?: string}} options
 */
export function openTimelineDrawer({ agentId, agentName } = {}) {
  if (!agentId) return;
  closeTimelineDrawer();
  ensureStyles();

  // --- per-drawer state ---
  let range = "today"; // today | 24h | 7d | custom
  let customWindow = null; // {sinceMs, untilMs} when range === "custom"
  let activeTypes = new Set(EVENT_TYPES);
  let events = [];
  let summary = null;
  let nextUntil = null;
  let fetchSeq = 0;

  const root = el("div");
  root.id = DRAWER_ID;
  const backdrop = el("div", "tld-backdrop");
  const drawer = el("aside", "tld-drawer");
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-label", t("components.timeline.title", {}, "Agent timeline"));

  // Header
  const header = el("div", "tld-header");
  const title = el(
    "span",
    "tld-title",
    t("components.timeline.heading", { agent: agentName || agentId }, "🕘 Timeline — {agent}"),
  );
  const closeBtn = el("button", "tld-close", "✕");
  closeBtn.title = t("components.timeline.close", {}, "Close");
  header.append(title, closeBtn);

  // Controls: range chips + custom inputs + type chips
  const controls = el("div", "tld-controls");
  const rangeRow = el("div", "tld-chip-row");
  const rangeDefs = [
    ["today", t("components.timeline.rangeToday", {}, "Today")],
    ["24h", t("components.timeline.range24h", {}, "24h")],
    ["7d", t("components.timeline.range7d", {}, "7 days")],
    ["custom", t("components.timeline.rangeCustom", {}, "Custom")],
  ];
  const rangeChips = new Map();
  for (const [key, label] of rangeDefs) {
    const chip = el("button", "tld-chip", label);
    chip.addEventListener("click", () => {
      range = key;
      renderRangeChips();
      if (key === "custom") {
        customRow.hidden = false;
      } else {
        customRow.hidden = true;
        reload();
      }
    });
    rangeChips.set(key, chip);
    rangeRow.appendChild(chip);
  }

  const customRow = el("div", "tld-custom");
  customRow.hidden = true;
  const fromInput = el("input");
  fromInput.type = "datetime-local";
  const toInput = el("input");
  toInput.type = "datetime-local";
  const applyBtn = el("button", "tld-chip", t("components.timeline.apply", {}, "Apply"));
  applyBtn.addEventListener("click", () => {
    const sinceMs = fromInput.value ? new Date(fromInput.value).getTime() : NaN;
    const untilMs = toInput.value ? new Date(toInput.value).getTime() : Date.now();
    if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs > untilMs) return;
    customWindow = { sinceMs, untilMs };
    reload();
  });
  customRow.append(fromInput, toInput, applyBtn);

  const typeRow = el("div", "tld-chip-row");
  const typeChips = new Map();
  for (const type of EVENT_TYPES) {
    const chip = el("button", "tld-chip tld-on", `${typeIcon(type)} ${type}`);
    chip.addEventListener("click", () => {
      if (activeTypes.has(type)) activeTypes.delete(type);
      else activeTypes.add(type);
      // Never allow an empty filter — that would mean "show nothing".
      if (activeTypes.size === 0) activeTypes = new Set(EVENT_TYPES);
      renderTypeChips();
      reload();
    });
    typeChips.set(type, chip);
    typeRow.appendChild(chip);
  }
  controls.append(rangeRow, customRow, typeRow);

  // Summary strip + body
  const summaryStrip = el("div", "tld-summary");
  const body = el("div", "tld-body");

  drawer.append(header, controls, summaryStrip, body);
  root.append(backdrop, drawer);
  document.body.appendChild(root);

  // --- lifecycle ---
  function onKeydown(e) {
    if (e.key === "Escape") closeTimelineDrawer();
  }
  closeBtn.addEventListener("click", closeTimelineDrawer);
  backdrop.addEventListener("click", closeTimelineDrawer);
  document.addEventListener("keydown", onKeydown);
  root._tldCleanup = () => document.removeEventListener("keydown", onKeydown);

  // --- rendering ---
  function renderRangeChips() {
    for (const [key, chip] of rangeChips) chip.classList.toggle("tld-on", key === range);
  }

  function renderTypeChips() {
    for (const [type, chip] of typeChips) chip.classList.toggle("tld-on", activeTypes.has(type));
  }

  function renderSummary() {
    summaryStrip.replaceChildren();
    if (!summary) return;
    const counts = summary.counts || {};
    const stat = (label, value) => {
      const span = el("span");
      span.appendChild(el("b", undefined, String(value)));
      span.appendChild(document.createTextNode(` ${label}`));
      return span;
    };
    const sessions = (counts["session.start"] || 0) + (counts["session.end"] || 0);
    const dispatches = (counts.dispatch || 0) + (counts["dispatch.result"] || 0);
    summaryStrip.append(
      stat(t("components.timeline.sumEvents", {}, "events"), summary.total || 0),
      stat(t("components.timeline.sumSessions", {}, "session events"), sessions),
      stat(t("components.timeline.sumDispatches", {}, "dispatch events"), dispatches),
      stat(t("components.timeline.sumCron", {}, "cron runs"), counts["cron.run"] || 0),
      stat(t("components.timeline.sumTokens", {}, "tokens"), fmtTokens(summary.tokens)),
      stat(
        t("components.timeline.sumCost", {}, "cost"),
        summary.cost === null || summary.cost === undefined ? "—" : summary.cost,
      ),
    );
  }

  function renderEvent(event) {
    const row = el("div", "tld-event");
    row.appendChild(el("span", "tld-time", fmtTime(event.ts)));
    row.appendChild(el("span", "tld-icon", typeIcon(event.type)));
    const main = el("div", "tld-event-main");
    main.appendChild(el("div", "tld-event-title", event.title || event.type));
    const detail = detailLine(event);
    if (detail) main.appendChild(el("div", "tld-event-detail", detail));
    const refs = event.refs && typeof event.refs === "object" ? event.refs : {};
    if (refs.taskId) main.appendChild(el("span", "tld-ref", `task ${refs.taskId}`));
    if (refs.sessionKey) main.appendChild(el("span", "tld-ref", refs.sessionKey));
    row.appendChild(main);
    return row;
  }

  function renderEvents() {
    body.replaceChildren();
    if (events.length === 0) {
      body.appendChild(
        el(
          "div",
          "tld-status",
          t("components.timeline.empty", {}, "No activity recorded in this window."),
        ),
      );
      return;
    }
    for (const group of groupEventsByDay(events)) {
      body.appendChild(el("div", "tld-day", group.day));
      for (const event of group.events) body.appendChild(renderEvent(event));
    }
    if (nextUntil !== null) {
      const more = el("button", "tld-more", t("components.timeline.loadMore", {}, "Load more"));
      more.addEventListener("click", () => loadMore(more));
      body.appendChild(more);
    }
  }

  function renderError(message) {
    body.replaceChildren();
    body.appendChild(
      el(
        "div",
        "tld-status tld-error",
        t("components.timeline.error", { message }, "Failed to load timeline: {message}"),
      ),
    );
  }

  // --- data ---
  function currentWindow() {
    if (range === "custom" && customWindow) return customWindow;
    return rangeToWindow(range === "custom" ? "24h" : range);
  }

  async function fetchTimeline({ untilMs }) {
    const { sinceMs } = currentWindow();
    const url = buildTimelineUrl(agentId, {
      sinceMs,
      untilMs,
      types: [...activeTypes],
      limit: 100,
    });
    const response = await fetch(url);
    let payload = null;
    try {
      payload = await response.json();
    } catch (e) {
      /* non-JSON body */
    }
    if (!response.ok) {
      throw new Error(payload && payload.error ? payload.error : `HTTP ${response.status}`);
    }
    return payload;
  }

  async function reload() {
    const seq = ++fetchSeq;
    body.replaceChildren(
      el("div", "tld-status", t("components.timeline.loading", {}, "Loading timeline…")),
    );
    try {
      const payload = await fetchTimeline({ untilMs: currentWindow().untilMs });
      if (seq !== fetchSeq || !document.getElementById(DRAWER_ID)) return;
      events = Array.isArray(payload.events) ? payload.events : [];
      summary = payload.summary || null;
      nextUntil = payload.page && payload.page.hasMore ? payload.page.nextUntil : null;
      renderSummary();
      renderEvents();
    } catch (err) {
      if (seq !== fetchSeq) return;
      console.error("[Timeline] Fetch failed:", err);
      renderError(err.message);
    }
  }

  async function loadMore(button) {
    if (nextUntil === null) return;
    const seq = ++fetchSeq;
    button.disabled = true;
    try {
      const payload = await fetchTimeline({ untilMs: nextUntil });
      if (seq !== fetchSeq || !document.getElementById(DRAWER_ID)) return;
      events = [...events, ...(Array.isArray(payload.events) ? payload.events : [])];
      nextUntil = payload.page && payload.page.hasMore ? payload.page.nextUntil : null;
      renderEvents();
    } catch (err) {
      if (seq !== fetchSeq) return;
      console.error("[Timeline] Load more failed:", err);
      button.disabled = false;
    }
  }

  renderRangeChips();
  renderTypeChips();
  reload();
}

/** Close (and fully remove) the drawer if it is open. */
export function closeTimelineDrawer() {
  const existing = document.getElementById(DRAWER_ID);
  if (!existing) return;
  if (typeof existing._tldCleanup === "function") existing._tldCleanup();
  existing.remove();
}
