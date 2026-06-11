/**
 * Operators view module — dense detail-list of fleet operators.
 *
 * Loaded by views.js via dynamic import; `init(containerEl)` runs on every
 * visit of #view-operators and must be idempotent.
 *
 * Data sources:
 *  - GET /api/operators → { operators: [{ id, username, name, displayName,
 *    role, source, firstSeen, metadata: { slackId }, stats: { activeSessions,
 *    totalSessions, lastSeen } }] }
 *  - GET /api/sessions?pageSize=N → { sessions: [{ sessionKey, label, active,
 *    tokens, originator: { userId, displayName } }] } — used to compute
 *    per-operator token totals and the recent-session breakdown, exactly like
 *    the old home-page operator modal did.
 *
 * Real-time: listens for the `fleet:state` window event (operators + sessions
 * slices) with a polling fallback.
 *
 * All dynamic values render via textContent — XSS-safe.
 */

import { t } from "../utils.js";
import { createDetailList } from "../components/detail-list.js";

const POLL_MS = 30000;
const SSE_FRESH_MS = 20000;
const SESSIONS_PAGE_SIZE = 500;
const RECENT_SESSIONS_SHOWN = 5;

let pollTimer = null;
let stateListener = null;
let list = null;
let requestSeq = 0;
let lastSseAt = 0;
let lastOperators = [];
let lastSessions = [];

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for node:test)                               */
/* ------------------------------------------------------------------ */

/** Sessions originated by the given operator (id / slack id / display name). */
export function sessionsForOperator(operator, sessions) {
  const displayName = operator.displayName || operator.username;
  return (Array.isArray(sessions) ? sessions : []).filter(
    (s) =>
      (s.originator?.userId &&
        (s.originator.userId === operator.id ||
          s.originator.userId === operator.metadata?.slackId)) ||
      (displayName && s.originator?.displayName === displayName),
  );
}

/** Compact token formatting: 1234 → "1.2k", 2500000 → "2.5M". */
export function formatTokens(total) {
  const n = Number(total) || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

/**
 * Flatten operators + sessions into detail-list rows. Token totals and the
 * per-operator session list come from the sessions slice; active/total
 * session counts prefer the server-computed stats and fall back to the
 * session match.
 */
export function buildOperatorRows(operators, sessions) {
  return (Array.isArray(operators) ? operators : [])
    .filter((op) => op && (op.id || op.username))
    .map((op) => {
      const matched = sessionsForOperator(op, sessions);
      const tokens = matched.reduce((sum, s) => sum + (Number(s.tokens) || 0), 0);
      const lastSeen = op.stats?.lastSeen || op.lastSeen || null;
      return {
        id: op.id || op.username,
        name: op.name || op.displayName || op.username || "Unknown",
        username: op.username || op.id || "—",
        role: op.role || "user",
        slackId: op.metadata?.slackId || "—",
        source: op.source || "—",
        firstSeen: op.firstSeen || null,
        lastSeenMs: lastSeen ? new Date(lastSeen).getTime() : 0,
        active: op.stats?.activeSessions ?? matched.filter((s) => s.active).length,
        sessions: op.stats?.totalSessions ?? matched.length,
        tokens,
        recentSessions: matched.slice(0, RECENT_SESSIONS_SHOWN).map((s) => ({
          label: s.label || s.sessionKey || "Unknown",
          active: !!s.active,
          tokens: Number(s.tokens) || 0,
        })),
      };
    });
}

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatLastSeen(lastSeenMs) {
  if (!lastSeenMs) return t("views.operators.never", {}, "Never");
  const mins = Math.floor((Date.now() - lastSeenMs) / 60000);
  if (mins < 1) return t("views.operators.justNow", {}, "Just now");
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

function roleBadge(role) {
  const cls = role === "owner" ? "owner" : role === "admin" ? "admin" : "user";
  const icon = role === "owner" ? "👑" : role === "admin" ? "⭐" : "👤";
  return el("span", `operators-role-badge ${cls}`, `${icon} ${role}`);
}

function buildDetail(row) {
  const wrap = el("div");

  const dl = el("dl", "operators-detail-grid");
  const add = (label, value) => {
    dl.appendChild(el("dt", null, label));
    dl.appendChild(el("dd", null, value));
  };
  add(t("views.operators.detailName", {}, "Name"), row.name);
  add(t("views.operators.detailUsername", {}, "Username"), `@${row.username}`);
  add(t("views.operators.detailRole", {}, "Role"), row.role);
  add(t("views.operators.detailSlackId", {}, "Slack ID"), row.slackId);
  add(t("views.operators.detailSource", {}, "Source"), row.source);
  add(
    t("views.operators.detailFirstSeen", {}, "First seen"),
    row.firstSeen ? new Date(row.firstSeen).toLocaleDateString() : "—",
  );
  add(t("views.operators.detailActive", {}, "Active sessions"), String(row.active));
  add(t("views.operators.detailSessions", {}, "Total sessions"), String(row.sessions));
  add(t("views.operators.detailTokens", {}, "Total tokens"), formatTokens(row.tokens));
  wrap.appendChild(dl);

  wrap.appendChild(
    el(
      "div",
      "operators-sessions-title",
      t("views.operators.recentSessions", {}, "Recent sessions"),
    ),
  );
  if (row.recentSessions.length === 0) {
    wrap.appendChild(el("em", null, t("views.operators.noSessions", {}, "No sessions found")));
  } else {
    for (const session of row.recentSessions) {
      const line = el("div", "operators-session-row");
      line.appendChild(el("span", null, `${session.active ? "🟢" : "⚪"} ${session.label}`));
      line.appendChild(el("span", "tokens", formatTokens(session.tokens)));
      wrap.appendChild(line);
    }
  }
  return wrap;
}

function createList(els) {
  return createDetailList(els.listHost, {
    columns: [
      { key: "name", label: t("views.operators.colOperator", {}, "Operator"), sortable: true },
      {
        key: "role",
        label: t("views.operators.colRole", {}, "Role"),
        sortable: true,
        render: (row) => roleBadge(row.role),
      },
      { key: "slackId", label: t("views.operators.colSlackId", {}, "Slack ID"), sortable: true },
      {
        key: "active",
        label: t("views.operators.colActive", {}, "Active"),
        sortable: true,
        render: (row) =>
          el("span", `operators-active-count${row.active > 0 ? " live" : ""}`, String(row.active)),
      },
      { key: "sessions", label: t("views.operators.colSessions", {}, "Sessions"), sortable: true },
      {
        key: "tokens",
        label: t("views.operators.colTokens", {}, "Tokens"),
        sortable: true,
        render: (row) => el("span", null, formatTokens(row.tokens)),
      },
      {
        key: "lastSeenMs",
        label: t("views.operators.colLastSeen", {}, "Last Seen"),
        sortable: true,
        render: (row) => el("span", null, formatLastSeen(row.lastSeenMs)),
      },
    ],
    getRowId: (row) => row.id,
    renderDetail: (row) => buildDetail(row),
    emptyText: t(
      "views.operators.empty",
      {},
      "No operators configured — operators are auto-detected from session activity.",
    ),
    filterKeys: ["name", "username", "role", "slackId", "source"],
    filterPlaceholder: t("views.operators.filterPlaceholder", {}, "Filter operators…"),
    defaultSort: { key: "name", dir: "asc" },
  });
}

/* ------------------------------------------------------------------ */
/* Rendering + data loading                                            */
/* ------------------------------------------------------------------ */

function render(els) {
  const rows = buildOperatorRows(lastOperators, lastSessions);
  els.count.textContent = rows.length;
  list.update(rows);
}

async function load(els) {
  const seq = ++requestSeq;
  try {
    const [operatorsRes, sessionsRes] = await Promise.all([
      fetch("/api/operators"),
      fetch(`/api/sessions?pageSize=${SESSIONS_PAGE_SIZE}`).catch(() => null),
    ]);
    if (seq !== requestSeq || !els.root.isConnected) return;
    if (!operatorsRes.ok) throw new Error(`HTTP ${operatorsRes.status}`);
    const operatorsPayload = await operatorsRes.json();
    lastOperators = operatorsPayload.operators || [];
    if (sessionsRes && sessionsRes.ok) {
      try {
        const sessionsPayload = await sessionsRes.json();
        lastSessions = sessionsPayload.sessions || [];
      } catch (e) {
        // Token stats are best-effort; the operators list still renders.
      }
    }
    if (seq !== requestSeq || !els.root.isConnected) return;
    els.error.hidden = true;
    render(els);
  } catch (error) {
    if (seq !== requestSeq || !els.root.isConnected) return;
    els.error.hidden = false;
    els.error.textContent = t(
      "views.operators.loadError",
      {},
      "Could not reach the operators API — is the server up?",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

function teardown() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (stateListener) {
    window.removeEventListener("fleet:state", stateListener);
    stateListener = null;
  }
  if (list) {
    list.destroy();
    list = null;
  }
}

/**
 * Initialize the Operators view. Called by views.js on every visit.
 * @param {HTMLElement} container
 */
export function init(container) {
  teardown();

  const els = {
    root: container.querySelector("#operators-view-section"),
    count: container.querySelector("#operators-view-count"),
    error: container.querySelector("#operators-view-error"),
    listHost: container.querySelector("#operators-view-list"),
  };
  if (Object.values(els).some((node) => !node)) {
    console.error("[Operators] Partial markup is missing expected elements; aborting init.");
    return;
  }

  list = createList(els);

  stateListener = (event) => {
    if (!els.root.isConnected) {
      teardown();
      return;
    }
    lastSseAt = Date.now();
    const detail = event.detail || {};
    let changed = false;
    if (detail.operators?.operators) {
      lastOperators = detail.operators.operators;
      changed = true;
    }
    if (Array.isArray(detail.sessions)) {
      lastSessions = detail.sessions;
      changed = true;
    }
    if (changed) {
      els.error.hidden = true;
      render(els);
    }
  };
  window.addEventListener("fleet:state", stateListener);

  pollTimer = setInterval(() => {
    if (!els.root.isConnected) {
      teardown();
      return;
    }
    if (document.hidden) return;
    if (Date.now() - lastSseAt < SSE_FRESH_MS) return;
    load(els);
  }, POLL_MS);

  load(els);
}
