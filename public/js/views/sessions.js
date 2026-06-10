/**
 * Sessions view module.
 *
 * Loaded by views.js via dynamic import; `init(containerEl)` runs on every
 * visit of #view-sessions and must be idempotent (timers/listeners are torn
 * down and re-created on each init).
 *
 * Data sources:
 *  - GET /api/sessions?page=&pageSize=&status=   (paginated session cards,
 *    server-side status filter, statusCounts across all pages)
 *  - GET /api/subagents                          (active sub-agent strip)
 *  - GET /api/sessions/detail?key=               (inline fallback detail)
 *
 * Real-time: listens for the `fleet:state` window event re-dispatched by the
 * page's single /api/events EventSource, with a polling fallback when SSE
 * updates stop arriving.
 *
 * All dynamic values are rendered via textContent — never innerHTML — so the
 * view is XSS-safe with hostile labels/topics/previews.
 */

import { t, formatTimeAgo } from "../utils.js";

const PAGE_SIZE = 20;
const POLL_MS = 15000;
const SSE_FRESH_MS = 20000;

// Module-scope state (module is cached; only init() re-runs per visit)
let pollTimer = null;
let stateListener = null;
let requestSeq = 0;
let lastSseAt = 0;
const filters = { status: "all", channel: "all", kind: "all" };
let page = 1;
let pagination = null;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isSessionHidden(session) {
  return typeof window.isSessionHidden === "function" ? window.isSessionHidden(session) : false;
}

function channelIcon(channel) {
  const icons = {
    slack: "💬",
    telegram: "📱",
    discord: "🎮",
    signal: "🔒",
    whatsapp: "📲",
  };
  return icons[channel] || "🏠";
}

/* ------------------------------------------------------------------ */
/* Card rendering (DOM-built, textContent only)                        */
/* ------------------------------------------------------------------ */

function buildCard(session, els) {
  const status = session.active ? "live" : session.recentlyActive ? "recent" : "idle";
  const card = el(
    "div",
    `session-card ${session.active ? "active" : session.recentlyActive ? "recent-active" : ""}`,
  );
  card.dataset.status = status;
  card.dataset.channel = session.channel || "other";
  card.dataset.kind = session.sessionType || session.kind || "";

  const header = el("div", "card-header");
  const iconClass =
    session.channel === "slack" ? "slack" : session.channel === "telegram" ? "telegram" : "main";
  header.appendChild(el("div", `card-icon ${iconClass}`, channelIcon(session.channel)));

  const titleArea = el("div", "card-title-area");
  titleArea.appendChild(el("div", "card-title", session.label || session.sessionKey || "?"));
  const model =
    (session.model || "").replace("claude-", "").replace("anthropic/", "") ||
    t("views.sessions.unknownModel", {}, "unknown");
  titleArea.appendChild(el("div", "card-subtitle", `${session.kind || "-"} • ${model}`));
  if (session.originator) {
    const name = session.originator.displayName || session.originator.username || "Unknown";
    const orig = el("div", "session-originator");
    orig.appendChild(el("span", "originator-avatar", name.charAt(0).toUpperCase()));
    orig.appendChild(el("span", "", name));
    titleArea.appendChild(orig);
  }
  header.appendChild(titleArea);

  const activity = session.activityState || { state: "idle", icon: "💤", label: "Idle" };
  const activityWrap = el("div", "activity-wrapper");
  activityWrap.title = activity.label || "";
  activityWrap.appendChild(el("span", `activity-indicator ${activity.state}`, activity.icon));
  activityWrap.appendChild(el("span", "activity-label", activity.label));
  header.appendChild(activityWrap);

  const badgeClass = session.active
    ? "badge-live"
    : session.recentlyActive
      ? "badge-recent"
      : "badge-idle";
  header.appendChild(
    el(
      "span",
      `card-badge ${badgeClass}`,
      session.active ? "● Live" : formatTimeAgo(session.minutesAgo || 0),
    ),
  );

  if (typeof window.quickHideSession === "function") {
    const hideBtn = el("button", "hide-btn", "👁️");
    hideBtn.type = "button";
    hideBtn.title = t("views.sessions.hideSession", {}, "Hide session");
    hideBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      window.quickHideSession(session.sessionKey || "", session.label || "");
      card.remove();
    });
    header.appendChild(hideBtn);
  }
  card.appendChild(header);

  if (session.topic) {
    const topics = session.topic
      .split(", ")
      .map((topic) => topic.trim())
      .filter(
        (topic) =>
          topic && !(typeof window.isTopicHidden === "function" && window.isTopicHidden(topic)),
      );
    if (topics.length > 0) {
      const wrap = el("div", "card-topics");
      for (const topic of topics) {
        wrap.appendChild(
          el("span", `topic-pill ${topic.toLowerCase().replace(/[^a-z]/g, "")}`, topic),
        );
      }
      card.appendChild(wrap);
    }
  }
  if (session.preview) card.appendChild(el("div", "card-preview", session.preview));

  const stats = el("div", "card-stats");
  const tokenClass = session.tokens > 100000 ? "high" : session.tokens > 50000 ? "med" : "";
  const stat = el("div", `card-stat ${tokenClass}`);
  stat.appendChild(el("span", "", "🎫"));
  stat.appendChild(el("span", "card-stat-value", `${((session.tokens || 0) / 1000).toFixed(1)}k`));
  stats.appendChild(stat);
  card.appendChild(stats);

  const metrics = session.metrics || { burnRate: 0, toolCalls: 0, minutesActive: 0 };
  const bar = el("div", "metrics-bar");
  const burn = el("div", `metric-ring burn ${metrics.burnRate > 5000 ? "hot" : ""}`);
  burn.title = `Token burn rate: ${metrics.burnRate} tokens/min`;
  burn.appendChild(el("span", "metric-icon", "🔥"));
  burn.appendChild(
    el(
      "span",
      "metric-value",
      metrics.burnRate > 1000 ? `${(metrics.burnRate / 1000).toFixed(1)}k` : `${metrics.burnRate}`,
    ),
  );
  burn.appendChild(el("span", "metric-label", "tok/min"));
  bar.appendChild(burn);

  const timeRing = el("div", "metric-ring time");
  timeRing.title = `Time active: ${metrics.minutesActive} minutes`;
  timeRing.appendChild(el("span", "metric-icon", "⏱️"));
  timeRing.appendChild(
    el(
      "span",
      "metric-value",
      metrics.minutesActive > 60
        ? `${Math.floor(metrics.minutesActive / 60)}h ${metrics.minutesActive % 60}m`
        : `${metrics.minutesActive}m`,
    ),
  );
  timeRing.appendChild(el("span", "metric-label", "active"));
  bar.appendChild(timeRing);
  card.appendChild(bar);

  card.addEventListener("click", () => openSessionDetail(session, els));
  return card;
}

/* ------------------------------------------------------------------ */
/* Detail: reuse the global panel, else inline fallback                */
/* ------------------------------------------------------------------ */

function openSessionDetail(session, els) {
  if (typeof window.openDetail === "function") {
    window.openDetail(session.sessionKey, session.label || session.sessionKey);
    return;
  }
  renderInlineDetail(session, els);
}

async function renderInlineDetail(session, els) {
  const panel = els.inlineDetail;
  panel.hidden = false;
  panel.replaceChildren(
    el("div", "", t("views.sessions.detailLoading", {}, "Loading session detail...")),
  );
  try {
    const response = await fetch(
      `/api/sessions/detail?key=${encodeURIComponent(session.sessionKey || "")}`,
    );
    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    panel.replaceChildren();

    const closeBtn = el("button", "btn-secondary", "✕ Close");
    closeBtn.type = "button";
    closeBtn.style.float = "right";
    closeBtn.addEventListener("click", () => {
      panel.hidden = true;
    });
    panel.appendChild(closeBtn);
    panel.appendChild(el("h3", "", data.groupChannel || data.channel || session.label || ""));

    const overview = el("pre");
    overview.textContent = [
      `Channel: ${data.channel || "-"}`,
      `Model: ${data.model || "-"}`,
      `Tokens: ${(data.tokens || 0).toLocaleString()} (in ${(data.inputTokens || 0).toLocaleString()} / out ${(data.outputTokens || 0).toLocaleString()})`,
      `Cache R/W: ${(data.cacheRead || 0).toLocaleString()} / ${(data.cacheWrite || 0).toLocaleString()}`,
      `Last active: ${data.lastActive || "-"}`,
    ].join("\n");
    panel.appendChild(overview);

    if (data.summary) {
      panel.appendChild(el("h3", "", t("views.sessions.detailSummary", {}, "Summary")));
      const summary = el("pre");
      summary.textContent = String(data.summary);
      panel.appendChild(summary);
    }
    if (Array.isArray(data.messages) && data.messages.length > 0) {
      panel.appendChild(el("h3", "", t("views.sessions.detailMessages", {}, "Recent messages")));
      const messages = el("pre");
      messages.textContent = data.messages
        .map((message) => `[${message.role}] ${(message.text || "").slice(0, 300)}`)
        .join("\n\n");
      panel.appendChild(messages);
    }
  } catch (error) {
    panel.replaceChildren(
      el(
        "div",
        "sessions-error",
        t("views.sessions.detailError", { message: error.message }, "Detail failed: {message}"),
      ),
    );
  }
}

/* ------------------------------------------------------------------ */
/* Sub-agent strip                                                     */
/* ------------------------------------------------------------------ */

function renderSubagentStrip(els, subagents, sessions) {
  const chips = [];
  for (const agent of subagents || []) {
    chips.push({
      key: `agent:main:subagent:${agent.id}`,
      label: agent.task || `Sub-agent ${agent.shortId || agent.id}`,
      meta: `${agent.tokens || 0} tok • ${Math.round((agent.ageMs || 0) / 60000)}m`,
    });
  }
  if (chips.length === 0) {
    // Fall back to the sessions slice: sub-agent sessions are flagged with
    // sessionType === "subagent".
    for (const session of sessions || []) {
      if (session.sessionType === "subagent" && (session.active || session.recentlyActive)) {
        chips.push({
          key: session.sessionKey,
          label: session.label || session.sessionKey,
          meta: `${((session.tokens || 0) / 1000).toFixed(1)}k tok`,
        });
      }
    }
  }

  els.subagentEmpty.style.display = chips.length === 0 ? "" : "none";
  els.subagentChips.replaceChildren(
    ...chips.slice(0, 12).map((chip) => {
      const node = el("span", "sessions-subagent-chip");
      node.appendChild(el("span", "", chip.label));
      node.appendChild(el("span", "chip-meta", chip.meta));
      node.title = chip.label;
      node.addEventListener("click", () =>
        openSessionDetail({ sessionKey: chip.key, label: chip.label }, els),
      );
      return node;
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Grid + pagination                                                   */
/* ------------------------------------------------------------------ */

function applyClientFilters(els) {
  els.grid.querySelectorAll(".session-card").forEach((card) => {
    const showChannel = filters.channel === "all" || card.dataset.channel === filters.channel;
    const showKind = filters.kind === "all" || card.dataset.kind === filters.kind;
    card.classList.toggle("hidden-by-filter", !(showChannel && showKind));
  });
}

function renderStatusCounts(els, counts) {
  if (!counts) return;
  els.countAll.textContent = counts.all || 0;
  els.countLive.textContent = counts.live || 0;
  els.countRecent.textContent = counts.recent || 0;
  els.countIdle.textContent = counts.idle || 0;
}

function renderGrid(els, sessions) {
  const visible = (sessions || []).filter((session) => !isSessionHidden(session));
  const total = pagination?.total ?? visible.length;
  els.headerCount.textContent = total;

  if (visible.length === 0) {
    const empty = el("div", "empty-state");
    empty.appendChild(el("div", "empty-state-icon", "📡"));
    empty.appendChild(
      el("div", "empty-state-text", t("views.sessions.empty", {}, "No sessions found")),
    );
    els.grid.replaceChildren(empty);
    return;
  }

  els.grid.replaceChildren(
    ...visible
      .slice()
      .sort((a, b) => (a.minutesAgo || 0) - (b.minutesAgo || 0))
      .map((session) => buildCard(session, els)),
  );
  applyClientFilters(els);
}

function renderPagination(els) {
  if (!pagination || pagination.total <= pagination.pageSize) {
    els.pagination.style.display = "none";
    return;
  }
  els.pagination.style.display = "flex";
  els.prevBtn.disabled = !pagination.hasPrev;
  els.nextBtn.disabled = !pagination.hasNext;
  const start = (pagination.page - 1) * pagination.pageSize + 1;
  const end = Math.min(pagination.page * pagination.pageSize, pagination.total);
  els.info.textContent = `${start}-${end} of ${pagination.total}`;

  const totalPages = pagination.totalPages;
  const current = pagination.page;
  const pages = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    pages.push(1);
    if (current > 3) pages.push("...");
    for (let i = Math.max(2, current - 1); i <= Math.min(totalPages - 1, current + 1); i++) {
      pages.push(i);
    }
    if (current < totalPages - 2) pages.push("...");
    pages.push(totalPages);
  }

  els.pages.replaceChildren(
    ...pages.map((value) => {
      if (value === "...") return el("span", "pagination-ellipsis", "...");
      const btn = el("button", `pagination-page ${value === current ? "active" : ""}`, `${value}`);
      btn.type = "button";
      btn.addEventListener("click", () => {
        page = value;
        load(els);
      });
      return btn;
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Data loading                                                        */
/* ------------------------------------------------------------------ */

async function load(els) {
  const seq = ++requestSeq;
  let url = `/api/sessions?page=${page}&pageSize=${PAGE_SIZE}`;
  if (filters.status !== "all") url += `&status=${encodeURIComponent(filters.status)}`;

  try {
    const [sessionsRes, subagentsRes] = await Promise.all([
      fetch(url).then((response) => response.json()),
      fetch("/api/subagents")
        .then((response) => response.json())
        .catch(() => null),
    ]);
    if (seq !== requestSeq || !els.grid.isConnected) return;
    els.error.hidden = true;
    pagination = sessionsRes.pagination || null;
    renderStatusCounts(els, sessionsRes.statusCounts);
    renderGrid(els, sessionsRes.sessions || []);
    renderPagination(els);
    renderSubagentStrip(els, subagentsRes?.subagents, sessionsRes.sessions);
  } catch (error) {
    if (seq !== requestSeq || !els.grid.isConnected) return;
    els.error.hidden = false;
    els.error.textContent = t(
      "views.sessions.loadError",
      {},
      "Could not reach the sessions API — is the server up?",
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
}

/**
 * Initialize the Sessions view. Called by views.js on every visit.
 * @param {HTMLElement} container
 */
export function init(container) {
  teardown();
  page = 1;
  filters.status = "all";
  filters.channel = "all";
  filters.kind = "all";
  pagination = null;

  const els = {
    grid: container.querySelector("#sessions-view-grid"),
    headerCount: container.querySelector("#sessions-view-count"),
    error: container.querySelector("#sessions-view-error"),
    filtersBar: container.querySelector("#sessions-view-filters"),
    pagination: container.querySelector("#sessions-view-pagination"),
    pages: container.querySelector("#sessions-view-pages"),
    prevBtn: container.querySelector("#sessions-view-prev"),
    nextBtn: container.querySelector("#sessions-view-next"),
    info: container.querySelector("#sessions-view-info"),
    countAll: container.querySelector("#sessions-filter-all-count"),
    countLive: container.querySelector("#sessions-filter-live-count"),
    countRecent: container.querySelector("#sessions-filter-recent-count"),
    countIdle: container.querySelector("#sessions-filter-idle-count"),
    subagentChips: container.querySelector("#sessions-subagent-chips"),
    subagentEmpty: container.querySelector("#sessions-subagent-empty"),
    inlineDetail: container.querySelector("#sessions-inline-detail"),
  };
  if (Object.values(els).some((node) => !node)) {
    console.error("[Sessions] Partial markup is missing expected elements; aborting init.");
    return;
  }

  // Filter buttons (event delegation per group)
  els.filtersBar.querySelectorAll(".filter-group").forEach((group) => {
    const groupName = group.dataset.filterGroup;
    group.querySelectorAll(".filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        filters[groupName] = btn.dataset.filter;
        group
          .querySelectorAll(".filter-btn")
          .forEach((other) => other.classList.toggle("active", other === btn));
        if (groupName === "status") {
          page = 1;
          load(els);
        } else {
          applyClientFilters(els);
        }
      });
    });
  });

  els.prevBtn.addEventListener("click", () => {
    if (pagination?.hasPrev) {
      page -= 1;
      load(els);
    }
  });
  els.nextBtn.addEventListener("click", () => {
    if (pagination?.hasNext) {
      page += 1;
      load(els);
    }
  });

  // SSE updates: the dashboard re-dispatches /api/events state on window.
  // Only the default slice (page 1, no status filter) matches the SSE
  // payload, so re-render from it only in that configuration.
  stateListener = (event) => {
    if (!els.grid.isConnected) {
      teardown();
      return;
    }
    lastSseAt = Date.now();
    const state = event.detail;
    if (!state) return;
    renderStatusCounts(els, state.statusCounts);
    if (page === 1 && filters.status === "all" && Array.isArray(state.sessions)) {
      pagination = state.pagination || pagination;
      renderGrid(els, state.sessions);
      renderPagination(els);
      renderSubagentStrip(els, state.subagents, state.sessions);
    }
  };
  window.addEventListener("fleet:state", stateListener);

  // Polling fallback: refresh when SSE has gone quiet.
  pollTimer = setInterval(() => {
    if (!els.grid.isConnected) {
      teardown();
      return;
    }
    if (document.hidden) return;
    if (Date.now() - lastSseAt < SSE_FRESH_MS) return;
    load(els);
  }, POLL_MS);

  load(els);
}
