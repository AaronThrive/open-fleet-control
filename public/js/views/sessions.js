/**
 * Sessions view module — dense detail-list ("neat file list") rendering.
 *
 * Loaded by views.js via dynamic import; `init(containerEl)` runs on every
 * visit of #view-sessions and must be idempotent (timers/listeners are torn
 * down and re-created on each init).
 *
 * Data sources:
 *  - GET /api/sessions?page=&pageSize=&status=   (paginated session rows,
 *    server-side status filter, statusCounts across all pages)
 *  - GET /api/subagents                          (active sub-agent strip)
 *  - GET /api/sessions/detail?key=               (per-row deep detail: token
 *    in/out + cache breakdown, est. cost, tool usage, summary)
 *
 * Rendering: the shared detail-list component (sortable columns, text filter,
 *  expandable detail panel). The legacy filter button groups (status /
 * channel / kind / source) are preserved — status stays a server-side
 * pre-filter, channel/kind are applied to the row set before list.update().
 * The expanded panel shows EVERYTHING the API exposes for the session,
 * including the raw metadata object.
 *
 * Real-time: listens for the `fleet:state` window event re-dispatched by the
 * page's single /api/events EventSource, with a polling fallback when SSE
 * updates stop arriving.
 *
 * All dynamic values are rendered via textContent — never innerHTML — so the
 * view is XSS-safe with hostile labels/topics/previews.
 */

import { t, formatTimeAgo } from "../utils.js";
import { splitByQuery } from "../transcript-search.js";
import { createDetailList } from "../components/detail-list.js";

const PAGE_SIZE = 20;
const POLL_MS = 15000;
const TERMINAL_POLL_MS = 45000;
const SSE_FRESH_MS = 20000;
const TERMINAL_MAX_ROWS = 30;
const TRANSCRIPT_POLL_MS = 3000;
const SCROLL_PIN_SLACK_PX = 30;
const SEARCH_DEBOUNCE_MS = 200;

const OPENCLAW_KILL_TOOLTIP =
  "OpenClaw doesn't expose chat-session termination yet " +
  "(gateway kill is sub-agent-only and auth-gated)";

// Module-scope state (module is cached; only init() re-runs per visit)
let pollTimer = null;
let terminalTimer = null;
let stateListener = null;
let requestSeq = 0;
let terminalSeq = 0;
let lastSseAt = 0;
const filters = { status: "all", channel: "all", kind: "all", source: "all" };
let page = 1;
let pagination = null;
// Current page of OpenClaw sessions (raw API objects) + the detail list.
let currentSessions = [];
let list = null;
// null = endpoint never answered (absent on older deployments); object = data.
let terminalData = null;
// Live claude processes with cwd (from /api/sessions/terminal/live); null
// when the endpoint is absent/unreachable.
let terminalLive = null;
// Transcript viewer state: null when closed.
let transcriptTimer = null;
let transcriptCtx = null;
let keyListener = null;
let searchDebounce = null;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
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
/* Pure helpers (exported for node:test)                                */
/* ------------------------------------------------------------------ */

/** live → active within 15m, recent → within 60m, idle → everything else. */
export function sessionStatus(session) {
  if (session && session.active) return "live";
  if (session && session.recentlyActive) return "recent";
  return "idle";
}

const STATUS_RANK = { live: 0, recent: 1, idle: 2 };

/** "120.5k" for thousands, verbatim below that, junk → "0". */
export function formatTokensCompact(value) {
  const v = Number(value) || 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${v}`;
}

/** Flatten a session onto the column keys the detail list sorts/filters by. */
export function toSessionRow(session) {
  const s = session || {};
  const status = sessionStatus(s);
  const metrics = s.metrics || {};
  const model = String(s.model || "")
    .replace("anthropic/", "")
    .replace("openai/", "")
    .replace("claude-", "");
  return {
    id: s.sessionKey || s.sessionId || "?",
    label: s.label || s.sessionKey || "?",
    channel: s.channel || "other",
    kind: s.sessionType || s.kind || "",
    model,
    status,
    statusRank: STATUS_RANK[status],
    tokens: Number(s.tokens) || 0,
    burnRate: Number(metrics.burnRate) || 0,
    minutesAgo: Number.isFinite(s.minutesAgo) ? s.minutesAgo : null,
    originatorName: s.originator?.displayName || s.originator?.username || "",
    topic: s.topic || "",
    session: s,
  };
}

/** Apply the channel/kind filter-button groups to the row set. */
export function filterSessionRows(rows, active) {
  return rows.filter((row) => {
    if (active.channel !== "all" && row.channel !== active.channel) return false;
    if (active.kind !== "all" && row.kind !== active.kind) return false;
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* Detail-list cells, per-row detail panel, and actions                 */
/* ------------------------------------------------------------------ */

function channelCell(row) {
  return el("span", "", `${channelIcon(row.channel)} ${row.channel}`);
}

function statusBadge(row) {
  const labels = {
    live: t("views.sessions.statusLive", {}, "● Live"),
    recent: t("views.sessions.statusRecent", {}, "● Recent"),
    idle: t("views.sessions.statusIdle", {}, "○ Idle"),
  };
  return el("span", `sess-status ${row.status}`, labels[row.status]);
}

function tokensCell(row) {
  const cls = row.tokens > 100000 ? " high" : row.tokens > 50000 ? " med" : "";
  return el("span", `sess-tokens${cls}`, formatTokensCompact(row.tokens));
}

function burnCell(row) {
  return el("span", "", `${formatTokensCompact(row.burnRate)}/min`);
}

function activityText(row) {
  if (row.minutesAgo === null) return "—";
  const ago = formatTimeAgo(row.minutesAgo);
  return ago === "now" ? t("views.sessions.justNow", {}, "just now") : `${ago} ago`;
}

function activityCell(row) {
  return el("span", row.status === "live" ? "sess-activity-live" : "", activityText(row));
}

function addDetailItem(host, label, value, mono) {
  const item = el("div", "sess-detail-item");
  item.appendChild(el("span", "sess-detail-label", label));
  item.appendChild(el("span", `sess-detail-value${mono ? " mono" : ""}`, value));
  host.appendChild(item);
}

/**
 * Deep detail (lazy, per expand): transcript-derived numbers from
 * /api/sessions/detail — token in/out + cache breakdown, est. cost, tool
 * usage, detected topics, and the generated summary.
 */
async function loadDeepDetail(sessionKey, host) {
  try {
    const response = await fetch(
      `/api/sessions/detail?key=${encodeURIComponent(sessionKey || "")}`,
    );
    const data = await response.json();
    if (!host.isConnected) return; // panel collapsed/re-rendered mid-flight
    if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);

    host.replaceChildren();
    const grid = el("div", "sess-detail-grid");
    addDetailItem(
      grid,
      t("views.sessions.detailTokensInOut", {}, "Tokens in / out"),
      `${(data.inputTokens || 0).toLocaleString()} / ${(data.outputTokens || 0).toLocaleString()}`,
    );
    addDetailItem(
      grid,
      t("views.sessions.detailCache", {}, "Cache read / write"),
      `${(data.cacheRead || 0).toLocaleString()} / ${(data.cacheWrite || 0).toLocaleString()}`,
    );
    addDetailItem(grid, t("views.sessions.detailCost", {}, "Est. cost"), data.estCost || "—");
    addDetailItem(
      grid,
      t("views.sessions.detailLastActive", {}, "Last active"),
      data.lastActive || "—",
    );
    if (Array.isArray(data.tools) && data.tools.length > 0) {
      addDetailItem(
        grid,
        t("views.sessions.detailTools", {}, "Top tools"),
        data.tools.map((tool) => `${tool.name} ×${tool.count}`).join(", "),
      );
    }
    if (Array.isArray(data.topics) && data.topics.length > 0) {
      addDetailItem(
        grid,
        t("views.sessions.detailTopics", {}, "Detected topics"),
        data.topics.join(", "),
      );
    }
    host.appendChild(grid);
    if (data.summary) {
      host.appendChild(el("div", "sess-detail-summary", String(data.summary)));
    }
  } catch (error) {
    if (!host.isConnected) return;
    host.textContent = t(
      "views.sessions.detailDeepError",
      { message: error.message },
      "Transcript detail unavailable: {message}",
    );
  }
}

/** Expanded panel: every field /api/sessions exposes + lazy deep detail + raw JSON. */
function buildDetail(row) {
  const s = row.session;
  const wrap = el("div", "sess-detail");

  const grid = el("div", "sess-detail-grid");
  const add = (label, value, mono) => addDetailItem(grid, label, value, mono);
  add(t("views.sessions.detailKey", {}, "Session key"), s.sessionKey || "—", true);
  add(t("views.sessions.detailId", {}, "Session id"), s.sessionId || "—", true);
  add(t("views.sessions.detailStatus", {}, "Status"), row.status);
  add(t("views.sessions.detailKind", {}, "Kind"), s.kind || "—");
  add(t("views.sessions.detailType", {}, "Type"), row.kind || "—");
  add(t("views.sessions.detailChannel", {}, "Channel"), row.channel);
  if (s.groupChannel)
    add(t("views.sessions.detailGroupChannel", {}, "Group channel"), s.groupChannel);
  if (s.displayName) add(t("views.sessions.detailDisplayName", {}, "Display name"), s.displayName);
  add(
    t("views.sessions.detailModel", {}, "Model"),
    s.model || t("views.sessions.unknownModel", {}, "unknown"),
    true,
  );
  add(t("views.sessions.detailTokens", {}, "Tokens (total)"), row.tokens.toLocaleString());
  add(t("views.sessions.detailBurn", {}, "Burn rate"), `${row.burnRate.toLocaleString()} tok/min`);
  const minutesActive = s.metrics?.minutesActive;
  add(
    t("views.sessions.detailActive", {}, "Time active"),
    Number.isFinite(minutesActive) ? `${minutesActive} min` : "—",
  );
  add(t("views.sessions.detailLastActivity", {}, "Last activity"), activityText(row));
  if (row.originatorName) {
    const role = s.originator?.role ? ` (${s.originator.role})` : "";
    add(t("views.sessions.detailOriginator", {}, "Originator"), `${row.originatorName}${role}`);
  }
  if (s.originator?.userId) {
    add(t("views.sessions.detailOriginatorId", {}, "Originator id"), s.originator.userId, true);
  }
  if (row.topic) add(t("views.sessions.detailTopic", {}, "Topics"), row.topic);
  wrap.appendChild(grid);

  const deep = el(
    "div",
    "sess-detail-deep",
    t("views.sessions.detailDeepLoading", {}, "Loading transcript detail…"),
  );
  wrap.appendChild(deep);
  loadDeepDetail(s.sessionKey, deep);

  // Raw metadata — the full session object exactly as served by the API.
  const raw = el("details", "sess-detail-raw");
  raw.appendChild(el("summary", "", t("views.sessions.detailRaw", {}, "Raw metadata")));
  raw.appendChild(el("pre", "", JSON.stringify(s, null, 2)));
  wrap.appendChild(raw);
  return wrap;
}

/** Per-row actions: 📜 live transcript + the honest disabled kill control. */
function buildRowActions(els, row) {
  const actions = el("div", "sess-actions");
  if (row.session.sessionId) {
    const viewBtn = el("button", "session-action-btn", "📜");
    viewBtn.type = "button";
    viewBtn.title = t("views.sessions.viewTranscript", {}, "View live transcript");
    viewBtn.addEventListener("click", () => {
      openTranscript(els, "openclaw", row.session.sessionId, row.label);
    });
    actions.appendChild(viewBtn);
  }
  // OpenClaw session kill: honest disabled control — the gateway only
  // exposes (auth-gated) sub-agent run kills, not chat-session termination.
  const killBtn = el("button", "session-action-btn kill", "✕");
  killBtn.type = "button";
  killBtn.disabled = true;
  killBtn.title = t("views.sessions.openclawKillUnavailable", {}, OPENCLAW_KILL_TOOLTIP);
  actions.appendChild(killBtn);
  return actions;
}

function buildList(els) {
  if (list) {
    list.destroy();
    list = null;
  }
  els.listHost.replaceChildren();
  list = createDetailList(els.listHost, {
    columns: [
      { key: "label", label: t("views.sessions.colSession", {}, "Session"), sortable: true },
      {
        key: "channel",
        label: t("views.sessions.colChannel", {}, "Channel"),
        sortable: true,
        render: channelCell,
      },
      { key: "kind", label: t("views.sessions.colKind", {}, "Kind"), sortable: true },
      { key: "model", label: t("views.sessions.colModel", {}, "Model"), sortable: true },
      {
        key: "statusRank",
        label: t("views.sessions.colStatus", {}, "Status"),
        sortable: true,
        render: statusBadge,
      },
      {
        key: "tokens",
        label: t("views.sessions.colTokens", {}, "Tokens"),
        sortable: true,
        render: tokensCell,
      },
      {
        key: "burnRate",
        label: t("views.sessions.colBurn", {}, "Burn"),
        sortable: true,
        render: burnCell,
      },
      {
        key: "minutesAgo",
        label: t("views.sessions.colActivity", {}, "Last activity"),
        sortable: true,
        render: activityCell,
      },
    ],
    getRowId: (row) => row.id,
    renderDetail: buildDetail,
    renderActions: (row) => buildRowActions(els, row),
    emptyText: t("views.sessions.empty", {}, "No sessions found"),
    filterKeys: ["label", "id", "channel", "kind", "model", "status", "originatorName", "topic"],
    filterPlaceholder: t("views.sessions.filterPlaceholder", {}, "Filter sessions…"),
    // Most recent activity first (live rows have the smallest minutesAgo).
    defaultSort: { key: "minutesAgo", dir: "asc" },
  });
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
/* Transcript viewer (read-only tail, modal)                           */
/* ------------------------------------------------------------------ */

function transcriptPinned(body) {
  return body.scrollTop + body.clientHeight >= body.scrollHeight - SCROLL_PIN_SLACK_PX;
}

/**
 * Build one transcript message node. All content is set via textContent
 * (transcript text is untrusted); query highlighting wraps match segments
 * in <mark class="tmatch"> built from text nodes — never markup.
 */
function buildMessageNode(message, query, contextClass = "") {
  const wrap = el("div", `tmsg ${message.role === "user" ? "user" : "assistant"} ${contextClass}`);
  const head = el("div", "tmsg-head");
  head.appendChild(el("span", "tmsg-role", message.role));
  if (message.ts) {
    const ts = new Date(message.ts);
    head.appendChild(
      el("span", "", Number.isFinite(ts.getTime()) ? ts.toLocaleString() : String(message.ts)),
    );
  }
  wrap.appendChild(head);
  if (message.text) {
    const textEl = el("div", "tmsg-text");
    for (const segment of splitByQuery(message.text, query)) {
      textEl.appendChild(
        segment.match ? el("mark", "tmatch", segment.text) : document.createTextNode(segment.text),
      );
    }
    wrap.appendChild(textEl);
  }
  for (const tool of message.tools || []) {
    const toolEl = el("span", "tmsg-tool");
    toolEl.appendChild(document.createTextNode("🔧 "));
    for (const segment of splitByQuery(tool, query)) {
      toolEl.appendChild(
        segment.match ? el("mark", "tmatch", segment.text) : document.createTextNode(segment.text),
      );
    }
    wrap.appendChild(toolEl);
  }
  return wrap;
}

/* ---- match navigation (shared by tail highlighting + server results) ---- */

function transcriptMatchEls(els) {
  return Array.from(els.transcriptBody.querySelectorAll(".tmatch"));
}

function updateMatchUi(els) {
  const ctx = transcriptCtx;
  const matches = ctx ? transcriptMatchEls(els) : [];
  const active = !!ctx && (ctx.query.length > 0 || ctx.serverMode);
  els.transcriptMatchCount.hidden = !active;
  els.transcriptPrev.hidden = !active;
  els.transcriptNext.hidden = !active;
  els.transcriptSearchAll.hidden = !ctx || ctx.query.length === 0 || ctx.serverMode;
  if (!active) return;
  if (ctx.current >= matches.length) ctx.current = matches.length - 1;
  matches.forEach((node, index) => node.classList.toggle("tmatch-current", index === ctx.current));
  els.transcriptMatchCount.textContent =
    matches.length === 0 ? "0/0" : `${ctx.current + 1}/${matches.length}`;
  els.transcriptPrev.disabled = matches.length === 0;
  els.transcriptNext.disabled = matches.length === 0;
}

function stepMatch(els, direction) {
  const ctx = transcriptCtx;
  if (!ctx) return;
  const matches = transcriptMatchEls(els);
  if (matches.length === 0) return;
  ctx.current = (ctx.current + direction + matches.length) % matches.length;
  updateMatchUi(els);
  matches[ctx.current].scrollIntoView({ block: "center" });
  updateJumpButton(els);
}

function updateJumpButton(els) {
  const ctx = transcriptCtx;
  els.transcriptJump.hidden = !ctx || (!ctx.serverMode && transcriptPinned(els.transcriptBody));
}

/* ---- rendering: live tail vs server search results ---- */

function renderTranscriptEmpty(els, text) {
  els.transcriptBody.replaceChildren(el("div", "sessions-transcript-empty", text));
}

/** Re-render the full tail body from ctx.messages (query may have changed). */
function renderTailBody(els) {
  const ctx = transcriptCtx;
  if (!ctx) return;
  const body = els.transcriptBody;
  const pinned = transcriptPinned(body);
  if (ctx.messages.length === 0) {
    renderTranscriptEmpty(
      els,
      t("views.sessions.transcriptEmpty", {}, "No messages in this transcript window yet."),
    );
  } else {
    body.replaceChildren(...ctx.messages.map((message) => buildMessageNode(message, ctx.query)));
  }
  if (pinned) body.scrollTop = body.scrollHeight;
  updateMatchUi(els);
  updateJumpButton(els);
}

function renderTailStatus(els) {
  const ctx = transcriptCtx;
  if (!ctx) return;
  els.transcriptStatus.textContent = t(
    "views.sessions.transcriptStatus",
    { count: ctx.messages.length },
    "{count} messages • tailing",
  );
}

function appendTranscriptMessages(els, messages) {
  const ctx = transcriptCtx;
  if (!ctx) return;
  const hadNone = ctx.messages.length === 0;
  ctx.messages.push(...messages);
  if (ctx.serverMode) return; // tail keeps accumulating silently behind results
  if (hadNone) {
    renderTailBody(els);
    return;
  }
  const body = els.transcriptBody;
  const pinned = transcriptPinned(body);
  for (const message of messages) {
    body.appendChild(buildMessageNode(message, ctx.query));
  }
  if (pinned) body.scrollTop = body.scrollHeight;
  if (ctx.query.length > 0) updateMatchUi(els);
  updateJumpButton(els);
}

async function pollTranscript(els) {
  const ctx = transcriptCtx;
  if (!ctx) return;
  let url =
    `/api/sessions/transcript?source=${encodeURIComponent(ctx.source)}` +
    `&id=${encodeURIComponent(ctx.id)}`;
  if (ctx.offset !== null) url += `&offset=${ctx.offset}`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (transcriptCtx !== ctx) return; // closed/reopened mid-flight
    if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
    ctx.offset = data.nextOffset;
    const batch = Array.isArray(data.messages) ? data.messages : [];
    if (batch.length > 0) {
      appendTranscriptMessages(els, batch);
    } else if (ctx.messages.length === 0 && !ctx.serverMode) {
      renderTranscriptEmpty(
        els,
        t("views.sessions.transcriptEmpty", {}, "No messages in this transcript window yet."),
      );
    }
    if (!ctx.serverMode) renderTailStatus(els);
  } catch (error) {
    if (transcriptCtx !== ctx) return;
    if (ctx.serverMode) return; // keep the search-results status line
    els.transcriptStatus.textContent = t(
      "views.sessions.transcriptError",
      { message: error.message },
      "error: {message}",
    );
  }
}

/* ---- in-transcript search ---- */

function setTranscriptQuery(els, value) {
  const ctx = transcriptCtx;
  if (!ctx) return;
  const query = String(value || "").trim();
  if (query === ctx.query && !ctx.serverMode) return;
  ctx.query = query;
  ctx.current = query.length > 0 ? 0 : -1;
  if (ctx.serverMode) {
    // Editing the query drops back to the live tail (client filter mode).
    ctx.serverMode = false;
    renderTailStatus(els);
  }
  renderTailBody(els);
}

/** Server-side search over the whole transcript file (content not yet paged in). */
async function runServerSearch(els) {
  const ctx = transcriptCtx;
  if (!ctx || ctx.query.length === 0) return;
  const query = ctx.query;
  els.transcriptStatus.textContent = t(
    "views.sessions.transcriptSearching",
    {},
    "searching full transcript…",
  );
  try {
    const response = await fetch(
      `/api/sessions/transcript/search?source=${encodeURIComponent(ctx.source)}` +
        `&id=${encodeURIComponent(ctx.id)}&q=${encodeURIComponent(query)}`,
    );
    const data = await response.json();
    if (transcriptCtx !== ctx || ctx.query !== query) return; // stale response
    if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);

    ctx.serverMode = true;
    ctx.current = (data.matches || []).length > 0 ? 0 : -1;
    const body = els.transcriptBody;
    body.replaceChildren();
    for (const match of data.matches || []) {
      if (match.before) body.appendChild(buildMessageNode(match.before, "", "tmsg-context"));
      body.appendChild(buildMessageNode(match.message, query));
      if (match.after) body.appendChild(buildMessageNode(match.after, "", "tmsg-context"));
      body.appendChild(el("div", "tmsg-result-sep"));
    }
    if ((data.matches || []).length === 0) {
      renderTranscriptEmpty(
        els,
        t("views.sessions.transcriptNoMatches", { query }, "No matches in the full transcript."),
      );
    }
    els.transcriptStatus.textContent = data.truncated
      ? t(
          "views.sessions.transcriptServerResultsTruncated",
          { count: data.matchCount },
          "{count}+ matches in full transcript (capped)",
        )
      : t(
          "views.sessions.transcriptServerResults",
          { count: data.matchCount },
          "{count} matches in full transcript",
        );
    body.scrollTop = 0;
    updateMatchUi(els);
    updateJumpButton(els);
  } catch (error) {
    if (transcriptCtx !== ctx) return;
    els.transcriptStatus.textContent = t(
      "views.sessions.transcriptSearchFailed",
      { message: error.message },
      "search failed: {message}",
    );
  }
}

/** Re-pin to the live tail (also exits server-search results mode). */
function jumpToBottom(els) {
  const ctx = transcriptCtx;
  if (!ctx) return;
  if (ctx.serverMode) {
    ctx.serverMode = false;
    renderTailBody(els);
    renderTailStatus(els);
  }
  els.transcriptBody.scrollTop = els.transcriptBody.scrollHeight;
  updateJumpButton(els);
}

function closeTranscript(els) {
  if (transcriptTimer) {
    clearInterval(transcriptTimer);
    transcriptTimer = null;
  }
  if (searchDebounce) {
    clearTimeout(searchDebounce);
    searchDebounce = null;
  }
  transcriptCtx = null;
  if (els) {
    els.transcriptOverlay.hidden = true;
    els.transcriptBody.replaceChildren();
    els.transcriptSearch.value = "";
    els.transcriptMatchCount.hidden = true;
    els.transcriptPrev.hidden = true;
    els.transcriptNext.hidden = true;
    els.transcriptSearchAll.hidden = true;
    els.transcriptJump.hidden = true;
    els.transcriptKill.hidden = true;
  }
}

/**
 * Open the transcript viewer. `pid` is the live claude/codex process owning
 * this transcript (terminal source only) — when known, the modal header
 * exposes the same kill flow as the terminal rows.
 */
function openTranscript(els, source, id, title, pid = null) {
  if (!id) return;
  closeTranscript(els);
  transcriptCtx = {
    source,
    id,
    offset: null,
    messages: [],
    query: "",
    serverMode: false,
    current: -1,
    pid: Number.isInteger(pid) && pid > 1 ? pid : null,
  };
  els.transcriptTitle.textContent = `${title || id} — ${source}`;
  els.transcriptStatus.textContent = t("views.sessions.transcriptLoading", {}, "loading…");
  renderTranscriptEmpty(els, t("views.sessions.transcriptLoadingBody", {}, "Loading transcript…"));
  els.transcriptKill.hidden = transcriptCtx.pid === null;
  els.transcriptKill.disabled = false;
  els.transcriptKill.textContent = "✕ Kill";
  if (transcriptCtx.pid !== null) {
    els.transcriptKill.title = t(
      "views.sessions.killTerminal",
      { pid: transcriptCtx.pid },
      "Kill claude process (pid {pid})",
    );
  }
  els.transcriptOverlay.hidden = false;
  els.transcriptSearch.focus();
  pollTranscript(els);
  transcriptTimer = setInterval(() => {
    if (!els.listHost.isConnected) {
      teardown();
      return;
    }
    if (document.hidden) return;
    pollTranscript(els);
  }, TRANSCRIPT_POLL_MS);
}

/* ------------------------------------------------------------------ */
/* Terminal session kill                                               */
/* ------------------------------------------------------------------ */

async function killTerminalPid(pid, btn, els) {
  const confirmed = window.confirm(
    t(
      "views.sessions.killConfirm",
      { pid },
      "Kill claude process {pid}?\n\nSIGTERM now; SIGKILL after 10s if it survives.",
    ),
  );
  if (!confirmed) return;
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const response = await fetch(`/api/sessions/terminal/${pid}/kill`, { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
    btn.textContent = "✓";
    setTimeout(() => {
      if (els.listHost.isConnected) loadTerminal(els);
    }, 2000);
  } catch (error) {
    btn.disabled = false;
    btn.textContent = "✕ Kill";
    window.alert(
      t("views.sessions.killFailed", { message: error.message }, "Kill failed: {message}"),
    );
  }
}

/* ------------------------------------------------------------------ */
/* Terminal Sessions (Claude Code)                                     */
/* ------------------------------------------------------------------ */

function agoFromIso(iso) {
  if (!iso) return "-";
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "-";
  const ago = formatTimeAgo(Math.max(0, Math.round((Date.now() - ts) / 60000)));
  return ago === "now" ? t("views.sessions.justNow", {}, "just now") : `${ago} ago`;
}

function buildTerminalRow(session, els, livePid) {
  const row = el("div", "sessions-terminal-row");
  if (session.live || livePid) {
    row.appendChild(el("span", "tr-live", t("views.sessions.terminalLive", {}, "● LIVE")));
  }
  if (session.subagent) {
    row.appendChild(
      el("span", "tr-subagent", t("views.sessions.terminalSubagent", {}, "↳ subagent")),
    );
  }
  const cwd = el("span", "tr-cwd", session.cwd || "?");
  cwd.title = session.file || session.cwd || "";
  row.appendChild(cwd);

  const tokens = session.tokens || {};
  const totalTok = (tokens.input || 0) + (tokens.output || 0);
  row.appendChild(
    el(
      "span",
      "tr-meta",
      t(
        "views.sessions.terminalMeta",
        {
          started: agoFromIso(session.startedAt),
          active: agoFromIso(session.lastActiveAt),
          msgs: session.messages || 0,
          tokens: `${(totalTok / 1000).toFixed(1)}k`,
        },
        "started {started} • active {active} • {msgs} msgs • {tokens} tok",
      ),
    ),
  );

  if (session.sessionId) {
    const viewBtn = el("button", "session-action-btn", "📜");
    viewBtn.type = "button";
    viewBtn.title = t("views.sessions.viewTranscript", {}, "View live transcript");
    viewBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      openTranscript(els, "terminal", session.sessionId, session.cwd || session.sessionId, livePid);
    });
    row.appendChild(viewBtn);
  }
  if (livePid) {
    const killBtn = el("button", "session-action-btn kill", "✕ Kill");
    killBtn.type = "button";
    killBtn.title = t(
      "views.sessions.killTerminal",
      { pid: livePid },
      "Kill claude process (pid {pid})",
    );
    killBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      killTerminalPid(livePid, killBtn, els);
    });
    row.appendChild(killBtn);
  }
  return row;
}

function renderTerminal(els) {
  const data = terminalData;
  const wantsTerminal = filters.source === "all" || filters.source === "terminal";

  if (!data) {
    // Endpoint absent (older deployment) or unreachable: only surface a
    // message when the user explicitly selected the Terminal source.
    els.terminalSection.hidden = filters.source !== "terminal";
    els.terminalList.replaceChildren();
    els.terminalEmpty.hidden = filters.source !== "terminal";
    els.terminalEmpty.textContent = t(
      "views.sessions.terminalUnavailable",
      {},
      "Terminal session data is unavailable on this deployment.",
    );
    els.terminalCount.textContent = "0";
    els.terminalLive.hidden = true;
    els.terminalTtys.textContent = "";
    return;
  }

  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  els.terminalFilterCount.textContent = `${sessions.length}`;
  els.terminalSection.hidden = !wantsTerminal;
  els.terminalCount.textContent = `${sessions.length}`;

  const liveCount = data.live?.count || 0;
  els.terminalLive.hidden = liveCount === 0;
  els.terminalLive.textContent = t(
    "views.sessions.terminalLiveCount",
    { count: liveCount },
    "● {count} live",
  );
  const ttys = Array.isArray(data.live?.ttys) ? data.live.ttys : [];
  els.terminalTtys.textContent = ttys.join(", ");

  if (sessions.length === 0) {
    els.terminalEmpty.hidden = false;
    els.terminalEmpty.textContent = t(
      "views.sessions.terminalEmpty",
      {},
      "No Claude Code terminal sessions found.",
    );
    els.terminalList.replaceChildren();
    return;
  }
  els.terminalEmpty.hidden = true;

  // Associate live claude processes with rows by working directory: each
  // live pid is attached to the most recently active session sharing its
  // cwd (transcripts record cwd; /proc gives the live process cwd).
  const liveProcs = (terminalLive?.processes || []).filter((proc) => proc && proc.cwd);
  const usedPids = new Set();
  const pidForCwd = (cwd) => {
    if (!cwd) return null;
    for (const proc of liveProcs) {
      if (!usedPids.has(proc.pid) && proc.cwd === cwd) {
        usedPids.add(proc.pid);
        return proc.pid;
      }
    }
    return null;
  };

  els.terminalList.replaceChildren(
    ...sessions
      .slice()
      .sort((a, b) => new Date(b.lastActiveAt || 0) - new Date(a.lastActiveAt || 0))
      .slice(0, TERMINAL_MAX_ROWS)
      .map((session) => buildTerminalRow(session, els, pidForCwd(session.cwd))),
  );
}

async function loadTerminal(els) {
  const seq = ++terminalSeq;
  const [data, live] = await Promise.all([
    fetch("/api/usage/claude-code")
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null),
    fetch("/api/sessions/terminal/live")
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null),
  ]);
  if (seq !== terminalSeq || !els.listHost.isConnected) return;
  terminalData = data && data.available !== false ? data : null;
  terminalLive = live && Array.isArray(live.processes) ? live : null;
  try {
    renderTerminal(els);
  } catch (error) {
    console.error("[Sessions] Terminal section render failed:", error);
  }
}

function applySourceVisibility(els) {
  const showOpenClaw = filters.source === "all" || filters.source === "openclaw";
  els.listHost.style.display = showOpenClaw ? "" : "none";
  els.pagination.style.display = showOpenClaw && pagination ? "" : "none";
  if (showOpenClaw) renderPagination(els);
  els.subagentStrip.style.display = showOpenClaw ? "" : "none";
  renderTerminal(els);
}

/* ------------------------------------------------------------------ */
/* Rows + pagination                                                   */
/* ------------------------------------------------------------------ */

function renderStatusCounts(els, counts) {
  if (!counts) return;
  els.countAll.textContent = counts.all || 0;
  els.countLive.textContent = counts.live || 0;
  els.countRecent.textContent = counts.recent || 0;
  els.countIdle.textContent = counts.idle || 0;
}

/** Re-apply the channel/kind groups to currentSessions and push rows in. */
function renderRows() {
  if (!list) return;
  list.update(filterSessionRows(currentSessions.map(toSessionRow), filters));
}

function renderSessions(els, sessions) {
  currentSessions = Array.isArray(sessions) ? sessions : [];
  els.headerCount.textContent = pagination?.total ?? currentSessions.length;
  renderRows();
}

function renderPagination(els) {
  if (filters.source === "terminal") {
    els.pagination.style.display = "none";
    return;
  }
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
    if (seq !== requestSeq || !els.listHost.isConnected) return;
    els.error.hidden = true;
    pagination = sessionsRes.pagination || null;
    renderStatusCounts(els, sessionsRes.statusCounts);
    renderSessions(els, sessionsRes.sessions || []);
    renderPagination(els);
    renderSubagentStrip(els, subagentsRes?.subagents, sessionsRes.sessions);
  } catch (error) {
    if (seq !== requestSeq || !els.listHost.isConnected) return;
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
  if (terminalTimer) {
    clearInterval(terminalTimer);
    terminalTimer = null;
  }
  if (transcriptTimer) {
    clearInterval(transcriptTimer);
    transcriptTimer = null;
  }
  if (searchDebounce) {
    clearTimeout(searchDebounce);
    searchDebounce = null;
  }
  transcriptCtx = null;
  if (keyListener) {
    document.removeEventListener("keydown", keyListener);
    keyListener = null;
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
 * Initialize the Sessions view. Called by views.js on every visit.
 * @param {HTMLElement} container
 */
export function init(container) {
  teardown();
  page = 1;
  filters.status = "all";
  filters.channel = "all";
  filters.kind = "all";
  filters.source = "all";
  pagination = null;
  terminalData = null;
  terminalLive = null;
  currentSessions = [];

  const els = {
    listHost: container.querySelector("#sessions-view-list"),
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
    subagentStrip: container.querySelector("#sessions-subagent-strip"),
    inlineDetail: container.querySelector("#sessions-inline-detail"),
    terminalSection: container.querySelector("#sessions-terminal-section"),
    terminalCount: container.querySelector("#sessions-terminal-count"),
    terminalLive: container.querySelector("#sessions-terminal-live"),
    terminalTtys: container.querySelector("#sessions-terminal-ttys"),
    terminalEmpty: container.querySelector("#sessions-terminal-empty"),
    terminalList: container.querySelector("#sessions-terminal-list"),
    terminalFilterCount: container.querySelector("#sessions-filter-terminal-count"),
    transcriptOverlay: container.querySelector("#sessions-transcript-overlay"),
    transcriptTitle: container.querySelector("#sessions-transcript-title"),
    transcriptStatus: container.querySelector("#sessions-transcript-status"),
    transcriptBody: container.querySelector("#sessions-transcript-body"),
    transcriptClose: container.querySelector("#sessions-transcript-close"),
    transcriptSearch: container.querySelector("#sessions-transcript-search"),
    transcriptMatchCount: container.querySelector("#sessions-transcript-matchcount"),
    transcriptPrev: container.querySelector("#sessions-transcript-prev"),
    transcriptNext: container.querySelector("#sessions-transcript-next"),
    transcriptSearchAll: container.querySelector("#sessions-transcript-searchall"),
    transcriptJump: container.querySelector("#sessions-transcript-jump"),
    transcriptKill: container.querySelector("#sessions-transcript-kill"),
  };
  if (Object.values(els).some((node) => !node)) {
    console.error("[Sessions] Partial markup is missing expected elements; aborting init.");
    return;
  }

  buildList(els);

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
        } else if (groupName === "source") {
          applySourceVisibility(els);
        } else {
          renderRows();
        }
      });
    });
  });

  // Transcript modal: close button, overlay click (outside the dialog), Esc.
  els.transcriptClose.addEventListener("click", () => closeTranscript(els));
  els.transcriptOverlay.addEventListener("click", (event) => {
    if (event.target === els.transcriptOverlay) closeTranscript(els);
  });
  keyListener = (event) => {
    if (event.key === "Escape" && transcriptCtx) closeTranscript(els);
  };
  document.addEventListener("keydown", keyListener);

  // Transcript search: debounced client-side filter; Enter (or 🔎 all)
  // searches the full transcript server-side; Esc clears before closing.
  els.transcriptSearch.placeholder = t("views.sessions.transcriptSearchPlaceholder", {}, "Search…");
  els.transcriptSearch.addEventListener("input", () => {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchDebounce = null;
      setTranscriptQuery(els, els.transcriptSearch.value);
    }, SEARCH_DEBOUNCE_MS);
  });
  els.transcriptSearch.addEventListener("keydown", (event) => {
    // Cancel any pending debounced apply so it cannot fire after Enter/Esc
    // and clobber the state these handlers just set (e.g. drop the user
    // out of server-search results right after they were rendered).
    if (searchDebounce) {
      clearTimeout(searchDebounce);
      searchDebounce = null;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      setTranscriptQuery(els, els.transcriptSearch.value);
      runServerSearch(els);
    } else if (event.key === "Escape" && els.transcriptSearch.value !== "") {
      event.stopPropagation(); // clear the query first; second Esc closes
      els.transcriptSearch.value = "";
      setTranscriptQuery(els, "");
    }
  });
  els.transcriptSearchAll.addEventListener("click", () => runServerSearch(els));
  els.transcriptPrev.addEventListener("click", () => stepMatch(els, -1));
  els.transcriptNext.addEventListener("click", () => stepMatch(els, 1));
  els.transcriptJump.addEventListener("click", () => jumpToBottom(els));
  els.transcriptBody.addEventListener("scroll", () => updateJumpButton(els));
  els.transcriptKill.addEventListener("click", () => {
    const pid = transcriptCtx?.pid;
    if (pid) killTerminalPid(pid, els.transcriptKill, els);
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
    if (!els.listHost.isConnected) {
      teardown();
      return;
    }
    lastSseAt = Date.now();
    const state = event.detail;
    if (!state) return;
    renderStatusCounts(els, state.statusCounts);
    if (page === 1 && filters.status === "all" && Array.isArray(state.sessions)) {
      pagination = state.pagination || pagination;
      renderSessions(els, state.sessions);
      renderPagination(els);
      renderSubagentStrip(els, state.subagents, state.sessions);
    }
  };
  window.addEventListener("fleet:state", stateListener);

  // Polling fallback: refresh when SSE has gone quiet.
  pollTimer = setInterval(() => {
    if (!els.listHost.isConnected) {
      teardown();
      return;
    }
    if (document.hidden) return;
    if (Date.now() - lastSseAt < SSE_FRESH_MS) return;
    load(els);
  }, POLL_MS);

  // Terminal sessions (Claude Code) poll independently — SSE does not carry
  // this slice, and the endpoint may be absent on older deployments.
  terminalTimer = setInterval(() => {
    if (!els.listHost.isConnected) {
      teardown();
      return;
    }
    if (document.hidden) return;
    loadTerminal(els);
  }, TERMINAL_POLL_MS);

  load(els);
  loadTerminal(els);
}
