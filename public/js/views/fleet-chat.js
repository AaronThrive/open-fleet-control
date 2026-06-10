/**
 * Fleet Chat view module.
 *
 * Read-only console for inter-agent fleet chat. Renders the message stream
 * from GET /api/fleet/chat, the fired-alerts ribbon from GET /api/fleet/alerts,
 * and stays live via the dashboard SSE endpoint (/api/events) using the
 * `fleet.chat` and `fleet.alert` named events.
 *
 * NOTE: the `fleet.chat` SSE event only carries {id, sender, receiver, ts} —
 * no payload/toolCalls — so live updates trigger a coalesced incremental
 * merge-fetch against the chat API (which also applies the text filter
 * server-side).
 *
 * Contract: init(containerEl) is called on EVERY visit and must be idempotent.
 * All server data is rendered via textContent/createElement (no innerHTML).
 */

const CHAT_API = "/api/fleet/chat";
const ALERTS_API = "/api/fleet/alerts";
const SSE_URL = "/api/events";

const DEBOUNCE_MS = 300;
const REFETCH_INTERVAL_MS = 30000;
const MERGE_COALESCE_MS = 300;
const COLLAPSE_THRESHOLD = 300;
const ALERTS_SHOWN = 6;
const PIN_TOLERANCE_PX = 40;

// Module-level singletons — init() may run many times, these survive revisits.
let eventSource = null;
let refetchTimer = null;
let state = null;

export function init(container) {
  // Tear down any previous incarnation (idempotency).
  if (refetchTimer) {
    clearInterval(refetchTimer);
    refetchTimer = null;
  }
  if (state) {
    if (state.filterDebounce) clearTimeout(state.filterDebounce);
    if (state.mergeDebounce) clearTimeout(state.mergeDebounce);
    state = null;
  }

  const els = queryElements(container);
  if (!els) return;

  state = {
    els,
    filters: { sender: "", receiver: "", text: "", limit: 50 },
    messageIds: new Set(),
    messageCount: 0,
    pinned: true,
    newCount: 0,
    loadSeq: 0,
    filterDebounce: null,
    mergeDebounce: null,
    alerts: [],
  };

  bindFilterBar();
  bindConsoleScroll();
  ensureEventSource();

  loadMessages({ fullReload: true });
  loadAlerts();

  refetchTimer = setInterval(() => {
    if (isViewAlive()) scheduleMergeFetch();
  }, REFETCH_INTERVAL_MS);
}

function queryElements(container) {
  const byId = (id) => container.querySelector(`#${id}`);
  const els = {
    console: byId("fc-console"),
    consoleWrap: byId("fc-console-wrap"),
    jump: byId("fc-jump"),
    status: byId("fc-status"),
    emptyState: byId("fleet-chat-empty-state"),
    alertsBar: byId("fc-alerts"),
    alertsItems: byId("fc-alerts-items"),
    filterSender: byId("fc-filter-sender"),
    filterReceiver: byId("fc-filter-receiver"),
    filterText: byId("fc-filter-text"),
    limitSelect: byId("fc-limit"),
    liveBadge: byId("fc-live-badge"),
  };
  for (const key of Object.keys(els)) {
    if (!els[key]) {
      console.error(`[FleetChat] Missing element "${key}" in partial`);
      return null;
    }
  }
  return els;
}

function isViewAlive() {
  return Boolean(state && state.els.console.isConnected);
}

/* ------------------------------------------------------------------ */
/* Data loading                                                        */
/* ------------------------------------------------------------------ */

function buildChatUrl() {
  const { sender, receiver, text, limit } = state.filters;
  const params = new URLSearchParams();
  if (sender) params.set("sender", sender);
  if (receiver) params.set("receiver", receiver);
  if (text) params.set("text", text);
  params.set("limit", String(limit));
  return `${CHAT_API}?${params.toString()}`;
}

async function loadMessages({ fullReload }) {
  const seq = ++state.loadSeq;
  if (fullReload) showLoading();

  let messages;
  try {
    const response = await fetch(buildChatUrl());
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    messages = Array.isArray(data.messages) ? data.messages : [];
  } catch (error) {
    console.error("[FleetChat] Failed to load messages:", error);
    if (state && seq === state.loadSeq && fullReload) showError();
    return;
  }

  if (!state || seq !== state.loadSeq) return; // superseded by a newer load

  // API returns newest first; the console renders oldest -> newest.
  const ascending = messages.slice().reverse();

  if (fullReload) {
    state.messageIds = new Set();
    state.messageCount = 0;
    state.pinned = true;
    state.newCount = 0;
    clearChildren(state.els.console);
    appendMessages(ascending);
    showLoaded();
    scrollToBottom();
  } else {
    const fresh = ascending.filter((msg) => !state.messageIds.has(msg.id));
    if (fresh.length > 0) {
      const wasEmpty = state.messageCount === 0;
      if (wasEmpty) {
        clearChildren(state.els.console);
        showLoaded();
      }
      appendMessages(fresh);
      refreshEmptyState();
      if (state.pinned) {
        scrollToBottom();
      } else {
        state.newCount += fresh.length;
        updateJumpButton();
      }
    }
  }
}

async function loadAlerts() {
  const els = state.els;
  try {
    const response = await fetch(`${ALERTS_API}?limit=${ALERTS_SHOWN}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const alerts = Array.isArray(data.alerts) ? data.alerts : [];
    if (!isViewAlive() || state.els !== els) return;
    state.alerts = alerts.slice(0, ALERTS_SHOWN);
    renderAlerts();
  } catch (error) {
    // Ribbon is auxiliary — keep it hidden on failure, console still works.
    console.error("[FleetChat] Failed to load alerts:", error);
  }
}

/** Coalesced incremental fetch — used by SSE events and the 30s fallback. */
function scheduleMergeFetch() {
  if (!state) return;
  if (state.mergeDebounce) return;
  state.mergeDebounce = setTimeout(() => {
    if (state) {
      state.mergeDebounce = null;
      loadMessages({ fullReload: false });
    }
  }, MERGE_COALESCE_MS);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function formatTime(ts) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function appendMessages(messages) {
  const fragment = document.createDocumentFragment();
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || !msg.id) continue;
    if (state.messageIds.has(msg.id)) continue;
    state.messageIds.add(msg.id);
    state.messageCount += 1;
    fragment.appendChild(buildEntry(msg));
  }
  state.els.console.appendChild(fragment);
}

function buildEntry(msg) {
  const entry = document.createElement("div");
  entry.className = "fc-entry";

  const ts = document.createElement("span");
  ts.className = "fc-ts";
  ts.textContent = formatTime(msg.ts);
  entry.appendChild(ts);

  const sender = document.createElement("span");
  sender.className = "fc-sender";
  sender.textContent = String(msg.sender ?? "?");
  entry.appendChild(sender);

  const arrow = document.createElement("span");
  arrow.className = "fc-arrow";
  arrow.textContent = "→";
  entry.appendChild(arrow);

  const receiver = document.createElement("span");
  receiver.className = "fc-receiver";
  receiver.textContent = String(msg.receiver ?? "?");
  entry.appendChild(receiver);

  entry.appendChild(buildPayload(msg.payload));

  if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
    entry.appendChild(buildToolChips(msg.toolCalls));
  }

  return entry;
}

function buildPayload(rawPayload) {
  const payload = typeof rawPayload === "string" ? rawPayload : JSON.stringify(rawPayload ?? "");
  const span = document.createElement("span");
  span.className = "fc-payload";

  if (payload.length <= COLLAPSE_THRESHOLD) {
    span.textContent = payload;
    return span;
  }

  const text = document.createElement("span");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "fc-expand";

  let expanded = false;
  const render = () => {
    text.textContent = expanded ? payload : `${payload.slice(0, COLLAPSE_THRESHOLD)}…`;
    toggle.textContent = expanded ? "collapse" : `expand (${payload.length} chars)`;
  };
  toggle.addEventListener("click", () => {
    expanded = !expanded;
    render();
  });
  render();

  span.appendChild(text);
  span.appendChild(toggle);
  return span;
}

function buildToolChips(toolCalls) {
  const wrap = document.createElement("span");
  wrap.className = "fc-tools";
  for (const call of toolCalls) {
    const chip = document.createElement("span");
    chip.className = "fc-tool-chip";
    const name =
      call && typeof call === "object" ? String(call.name || call.tool || "tool") : String(call);
    chip.textContent = `⚙ ${name}`;
    chip.title = safeToolTitle(call);
    wrap.appendChild(chip);
  }
  return wrap;
}

function safeToolTitle(call) {
  try {
    return typeof call === "object" ? JSON.stringify(call) : String(call);
  } catch (error) {
    return "tool call";
  }
}

function renderAlerts() {
  const { alertsBar, alertsItems } = state.els;
  if (state.alerts.length === 0) {
    alertsBar.hidden = true;
    return;
  }
  clearChildren(alertsItems);
  for (const alert of state.alerts) {
    alertsItems.appendChild(buildAlertChip(alert));
  }
  alertsBar.hidden = false;
}

function buildAlertChip(alert) {
  const severity = String(alert.severity || "info").toLowerCase();
  const sevClass = ["critical", "warn", "info"].includes(severity) ? severity : "info";

  const chip = document.createElement("span");
  chip.className = `fc-alert fc-sev-${sevClass}`;

  const dot = document.createElement("span");
  dot.className = "fc-alert-dot";
  chip.appendChild(dot);

  const type = document.createElement("strong");
  type.textContent = String(alert.type || "alert");
  chip.appendChild(type);

  const scope = [alert.node, alert.task].filter(Boolean).map(String).join(" / ");
  const message = String(alert.message || "");
  if (scope || message) {
    const msgSpan = document.createElement("span");
    msgSpan.className = "fc-alert-msg";
    msgSpan.textContent = scope ? `${scope} — ${message}` : message;
    chip.appendChild(msgSpan);
  }

  const time = document.createElement("span");
  time.className = "fc-alert-time";
  time.textContent = formatTime(alert.ts);
  chip.appendChild(time);

  return chip;
}

/* ------------------------------------------------------------------ */
/* View states (loading / error / empty / loaded)                      */
/* ------------------------------------------------------------------ */

function showLoading() {
  const { status, consoleWrap, emptyState } = state.els;
  consoleWrap.hidden = true;
  emptyState.hidden = true;
  status.classList.remove("fc-status-error");
  clearChildren(status);
  status.appendChild(document.createTextNode("Loading fleet messages…"));
  status.hidden = false;
}

function showError() {
  const { status, consoleWrap, emptyState } = state.els;
  consoleWrap.hidden = true;
  emptyState.hidden = true;
  status.classList.add("fc-status-error");
  clearChildren(status);
  status.appendChild(document.createTextNode("Failed to load fleet chat — check the server."));
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "fc-retry";
  retry.textContent = "Retry";
  retry.addEventListener("click", () => loadMessages({ fullReload: true }));
  status.appendChild(retry);
  status.hidden = false;
}

function showLoaded() {
  const { status, consoleWrap } = state.els;
  status.hidden = true;
  status.classList.remove("fc-status-error");
  consoleWrap.hidden = false;
  refreshEmptyState();
}

function refreshEmptyState() {
  const { emptyState, consoleWrap, console: consoleEl } = state.els;
  const { sender, receiver, text } = state.filters;
  const hasFilters = Boolean(sender || receiver || text);
  const isEmpty = state.messageCount === 0;

  if (isEmpty && !hasFilters) {
    // True empty fleet — show the full empty state, hide the console.
    emptyState.hidden = false;
    consoleWrap.hidden = true;
  } else {
    emptyState.hidden = true;
    consoleWrap.hidden = false;
    if (isEmpty) {
      clearChildren(consoleEl);
      const note = document.createElement("div");
      note.className = "fc-console-note";
      note.textContent = "No messages match the current filters.";
      consoleEl.appendChild(note);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Filter bar                                                          */
/* ------------------------------------------------------------------ */

function bindFilterBar() {
  const { filterSender, filterReceiver, filterText, limitSelect } = state.els;

  const applyFilters = () => {
    if (!state) return;
    state.filters = {
      sender: filterSender.value.trim(),
      receiver: filterReceiver.value.trim(),
      text: filterText.value.trim(),
      limit: parseInt(limitSelect.value, 10) || 50,
    };
    loadMessages({ fullReload: true });
  };

  const debouncedApply = () => {
    if (!state) return;
    if (state.filterDebounce) clearTimeout(state.filterDebounce);
    state.filterDebounce = setTimeout(() => {
      if (state) {
        state.filterDebounce = null;
        applyFilters();
      }
    }, DEBOUNCE_MS);
  };

  filterSender.addEventListener("input", debouncedApply);
  filterReceiver.addEventListener("input", debouncedApply);
  filterText.addEventListener("input", debouncedApply);
  limitSelect.addEventListener("change", applyFilters);
}

/* ------------------------------------------------------------------ */
/* Scroll pinning ("pinned to live")                                   */
/* ------------------------------------------------------------------ */

function bindConsoleScroll() {
  const { console: consoleEl, jump } = state.els;

  consoleEl.addEventListener("scroll", () => {
    if (!state) return;
    const distanceFromBottom =
      consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight;
    const nowPinned = distanceFromBottom <= PIN_TOLERANCE_PX;
    if (nowPinned && !state.pinned) {
      state.pinned = true;
      state.newCount = 0;
      updateJumpButton();
    } else if (!nowPinned && state.pinned) {
      state.pinned = false;
      updateJumpButton();
    }
  });

  jump.addEventListener("click", () => {
    if (!state) return;
    state.pinned = true;
    state.newCount = 0;
    scrollToBottom();
    updateJumpButton();
  });
}

function scrollToBottom() {
  const consoleEl = state.els.console;
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function updateJumpButton() {
  const { jump } = state.els;
  if (!state.pinned && state.newCount > 0) {
    jump.textContent = `↓ ${state.newCount} new`;
    jump.hidden = false;
  } else {
    jump.hidden = true;
  }
}

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */

function ensureEventSource() {
  setLiveBadge(Boolean(eventSource && eventSource.readyState === 1));
  if (eventSource) return; // module-level singleton, survives revisits

  if (typeof EventSource === "undefined") {
    setLiveBadge(false);
    return; // 30s refetch interval covers polling-only browsers
  }

  try {
    eventSource = new EventSource(SSE_URL);
  } catch (error) {
    console.error("[FleetChat] Failed to open SSE:", error);
    eventSource = null;
    return;
  }

  eventSource.addEventListener("open", () => setLiveBadge(true));
  // EventSource reconnects automatically; the 30s refetch covers any gap.
  eventSource.addEventListener("error", () => setLiveBadge(false));

  eventSource.addEventListener("fleet.chat", (event) => {
    if (!isViewAlive()) return;
    let info;
    try {
      info = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    if (!info || state.messageIds.has(info.id)) return;
    // The event has no payload — apply sender/receiver filters client-side,
    // then merge-fetch the full message (text filter applied server-side).
    const { sender, receiver } = state.filters;
    if (sender && info.sender !== sender) return;
    if (receiver && info.receiver !== receiver) return;
    scheduleMergeFetch();
  });

  eventSource.addEventListener("fleet.alert", (event) => {
    if (!isViewAlive()) return;
    let alert;
    try {
      alert = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    if (!alert || typeof alert !== "object") return;
    state.alerts = [alert, ...state.alerts].slice(0, ALERTS_SHOWN);
    renderAlerts();
  });
}

function setLiveBadge(isLive) {
  if (!state) return;
  state.els.liveBadge.classList.toggle("fc-live-on", isLive);
  state.els.liveBadge.textContent = isLive ? "LIVE" : "POLL";
}
