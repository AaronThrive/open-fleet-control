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
import { splitByQuery } from "../transcript-search.js";

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

  if (session.sessionId) {
    const viewBtn = el("button", "session-action-btn", "📜");
    viewBtn.type = "button";
    viewBtn.title = t("views.sessions.viewTranscript", {}, "View live transcript");
    viewBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      openTranscript(els, "openclaw", session.sessionId, session.label || session.sessionKey);
    });
    header.appendChild(viewBtn);
  }
  // OpenClaw session kill: honest disabled control — the gateway only
  // exposes (auth-gated) sub-agent run kills, not chat-session termination.
  const killBtn = el("button", "session-action-btn kill", "✕");
  killBtn.type = "button";
  killBtn.disabled = true;
  killBtn.title = t("views.sessions.openclawKillUnavailable", {}, OPENCLAW_KILL_TOOLTIP);
  header.appendChild(killBtn);

  card.appendChild(header);

  if (session.topic) {
    const topics = session.topic
      .split(", ")
      .map((topic) => topic.trim())
      .filter((topic) => topic);
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
    if (!els.grid.isConnected) {
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
      if (els.grid.isConnected) loadTerminal(els);
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
  if (seq !== terminalSeq || !els.grid.isConnected) return;
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
  els.grid.style.display = showOpenClaw ? "" : "none";
  els.pagination.style.display = showOpenClaw && pagination ? "" : "none";
  if (showOpenClaw) renderPagination(els);
  els.subagentStrip.style.display = showOpenClaw ? "" : "none";
  renderTerminal(els);
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
  const visible = sessions || [];
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
          applyClientFilters(els);
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

  // Terminal sessions (Claude Code) poll independently — SSE does not carry
  // this slice, and the endpoint may be absent on older deployments.
  terminalTimer = setInterval(() => {
    if (!els.grid.isConnected) {
      teardown();
      return;
    }
    if (document.hidden) return;
    loadTerminal(els);
  }, TERMINAL_POLL_MS);

  load(els);
  loadTerminal(els);
}
