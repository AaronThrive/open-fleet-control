/**
 * Flight Recorder view module — live + archived board/chain orchestration runs.
 *
 * Loaded by views.js via dynamic import; `init(containerEl)` runs on every visit
 * of #view-flight-recorder and is idempotent: DOM lookups and bindings happen
 * fresh inside init, and previous timers/SSE are cleaned up first.
 *
 * Data sources:
 *   GET /api/fleet/flight-recorder/live                          — in-progress
 *   GET /api/fleet/flight-recorder/runs?status&agent&limit&before — archived
 *   GET /api/fleet/flight-recorder/runs/:runId                   — full detail
 *   SSE /api/events (event "fleet.orchestration")               — live refresh
 *
 * All values render via textContent — never innerHTML — so hostile agent names,
 * questions, and answers are XSS-safe.
 */

import { t } from "../utils.js";

const SSE_URL = "/api/events";
const SSE_REFRESH_DEBOUNCE_MS = 500;
const AUTO_REFRESH_MS = 30000;

// Module-scope singletons (the module is cached; only init() re-runs per visit).
let refreshTimer = null;
let sseDebounceTimer = null;
let eventSource = null;
let requestSeq = 0;
let activeEls = null;
let selectedRunId = null;
let nextBefore = null; // archive cursor for "load older"

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function relativeTime(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
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

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  return `${min}m ${rem}s`;
}

async function fetchJson(url) {
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, payload };
}

function statusPill(status) {
  const span = document.createElement("span");
  const known = [
    "done",
    "failed",
    "running",
    "ok",
    "timeout",
    "budget",
    "refused",
    "skipped",
  ].includes(status)
    ? status
    : "skipped";
  span.className = `fr-status fr-status-${known}`;
  span.textContent = status;
  return span;
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
/* Rendering — run list (master)                                       */
/* ------------------------------------------------------------------ */

function buildRunRow(els, run, isLive) {
  const row = document.createElement("div");
  row.className = "fr-run";
  if (run.runId === selectedRunId) row.classList.add("fr-run-active");
  row.dataset.runId = run.runId;

  const top = document.createElement("div");
  top.className = "fr-run-top";
  const title = document.createElement("span");
  title.className = "fr-run-title";
  title.textContent = run.title || run.runId;
  title.title = run.title || run.runId;
  top.appendChild(title);
  top.appendChild(statusPill(run.status));

  const sub = document.createElement("div");
  sub.className = "fr-run-sub";
  const mode = document.createElement("span");
  mode.className = "fr-mode";
  mode.textContent = run.mode;
  sub.appendChild(mode);

  const seats = document.createElement("span");
  const ok = Number.isFinite(run.okCount) ? run.okCount : 0;
  const total = Number.isFinite(run.seatCount) ? run.seatCount : (run.agents || []).length;
  seats.textContent = t(
    "views.flightRecorder.seatSummary",
    { ok, total },
    "{ok}/{total} seats",
  );
  sub.appendChild(seats);

  const when = document.createElement("span");
  when.textContent = isLive
    ? t("views.flightRecorder.liveNow", {}, "live")
    : relativeTime(run.endedAt || run.archivedAt || run.startedAt);
  sub.appendChild(when);

  if (run.node) {
    const node = document.createElement("span");
    node.textContent = `@${run.node}`;
    node.title = t("views.flightRecorder.nodeLabel", {}, "Instance");
    sub.appendChild(node);
  }

  row.appendChild(top);
  row.appendChild(sub);
  row.addEventListener("click", () => selectRun(els, run.runId));
  return row;
}

function renderList(els, liveRuns, archivedRuns) {
  els.list.replaceChildren();
  const hasAny = liveRuns.length > 0 || archivedRuns.length > 0;

  if (liveRuns.length > 0) {
    const head = document.createElement("div");
    head.className = "fr-list-section-title";
    head.textContent = t("views.flightRecorder.liveSection", {}, "In progress");
    els.list.appendChild(head);
    for (const run of liveRuns) els.list.appendChild(buildRunRow(els, run, true));
  }

  if (archivedRuns.length > 0) {
    const head = document.createElement("div");
    head.className = "fr-list-section-title";
    head.textContent = t("views.flightRecorder.archivedSection", {}, "Archived");
    els.list.appendChild(head);
    for (const run of archivedRuns) els.list.appendChild(buildRunRow(els, run, false));
  }

  els.list.hidden = !hasAny;
  els.empty.hidden = hasAny;
  els.loadMore.hidden = !nextBefore;

  const count = liveRuns.length + archivedRuns.length;
  els.countLine.textContent = t(
    "views.flightRecorder.countLine",
    { n: count },
    "{n} runs",
  );
}

/* ------------------------------------------------------------------ */
/* Rendering — run detail                                              */
/* ------------------------------------------------------------------ */

function buildSeat(seat) {
  const wrap = document.createElement("div");
  wrap.className = "fr-seat";

  const head = document.createElement("div");
  head.className = "fr-seat-head";
  const agent = document.createElement("span");
  agent.className = "fr-seat-agent";
  agent.textContent = seat.agent;
  head.appendChild(agent);
  head.appendChild(statusPill(seat.status));
  wrap.appendChild(head);

  const body = document.createElement("div");
  body.className = "fr-seat-body";
  if (seat.resultText) {
    body.textContent = seat.resultText;
  } else if (seat.error) {
    body.classList.add("fr-seat-muted");
    body.textContent = seat.error;
  } else if (seat.status === "running") {
    body.classList.add("fr-seat-muted");
    body.textContent = t("views.flightRecorder.seatPending", {}, "Dispatched — awaiting answer…");
  } else {
    body.classList.add("fr-seat-muted");
    body.textContent = t("views.flightRecorder.seatNoAnswer", {}, "No answer recorded.");
  }
  wrap.appendChild(body);

  if (seat.truncated) {
    const note = document.createElement("div");
    note.className = "fr-truncated-note";
    note.textContent = t("views.flightRecorder.truncated", {}, "(answer truncated)");
    wrap.appendChild(note);
  }
  return wrap;
}

function renderDetail(els, detail) {
  const { run, seats } = detail;
  els.detail.replaceChildren();

  const head = document.createElement("div");
  head.className = "fr-detail-head";
  const title = document.createElement("span");
  title.className = "fr-detail-title";
  title.textContent = run.title || run.runId;
  head.appendChild(title);
  head.appendChild(statusPill(run.status));
  if (detail.live) {
    const live = document.createElement("span");
    live.className = "fr-status fr-status-running";
    live.textContent = t("views.flightRecorder.liveNow", {}, "live");
    head.appendChild(live);
  }
  els.detail.appendChild(head);

  const meta = document.createElement("div");
  meta.className = "fr-detail-meta";
  const parts = [
    `${run.mode}`,
    run.node ? `@${run.node}` : null,
    Number.isFinite(run.durationMs) ? `${formatDuration(run.durationMs)}` : null,
    run.startedAt ? new Date(run.startedAt).toLocaleString() : null,
    run.runId,
  ].filter(Boolean);
  for (const p of parts) {
    const span = document.createElement("span");
    span.textContent = p;
    meta.appendChild(span);
  }
  els.detail.appendChild(meta);

  if (run.question) {
    const q = document.createElement("div");
    q.className = "fr-question";
    q.textContent = run.question;
    els.detail.appendChild(q);
  }

  const seatsTitle = document.createElement("div");
  seatsTitle.className = "fr-seats-title";
  seatsTitle.textContent = t("views.flightRecorder.seatsTitle", {}, "Seats");
  els.detail.appendChild(seatsTitle);

  if (!seats || seats.length === 0) {
    const none = document.createElement("div");
    none.className = "fr-detail-empty";
    none.textContent = t("views.flightRecorder.noSeats", {}, "No seats recorded for this run.");
    els.detail.appendChild(none);
    return;
  }
  for (const seat of seats) els.detail.appendChild(buildSeat(seat));
}

async function selectRun(els, runId) {
  selectedRunId = runId;
  // Reflect selection in the list without a full refetch.
  for (const row of els.list.querySelectorAll(".fr-run")) {
    row.classList.toggle("fr-run-active", row.dataset.runId === runId);
  }
  const seq = ++requestSeq;
  const { ok, payload } = await fetchJson(
    `/api/fleet/flight-recorder/runs/${encodeURIComponent(runId)}`,
  );
  if (seq !== requestSeq || els !== activeEls) return; // stale / navigated away
  if (!ok || !payload || !payload.run) {
    showError(els, t("views.flightRecorder.detailError", {}, "Could not load run detail"));
    return;
  }
  clearError(els);
  renderDetail(els, payload);
}

/* ------------------------------------------------------------------ */
/* Data load                                                           */
/* ------------------------------------------------------------------ */

function buildListUrl(els) {
  const params = new URLSearchParams();
  if (els.status.value) params.set("status", els.status.value);
  const agent = els.agent.value.trim();
  if (agent) params.set("agent", agent);
  params.set("limit", els.limit.value || "50");
  return `/api/fleet/flight-recorder/runs?${params.toString()}`;
}

async function loadRuns(els, { append = false } = {}) {
  const seq = ++requestSeq;
  try {
    // Live runs first (only when no status filter, or status=running explicitly).
    let liveRuns = [];
    const wantLive = !els.status.value || els.status.value === "running";
    if (wantLive && !append) {
      const live = await fetchJson("/api/fleet/flight-recorder/live");
      if (live.ok && Array.isArray(live.payload.runs)) {
        liveRuns = live.payload.runs.map((r) => r.run).filter(Boolean);
      }
    }

    let url = buildListUrl(els);
    if (append && nextBefore) {
      url += `&before=${encodeURIComponent(Date.parse(nextBefore) || nextBefore)}`;
    }
    const { ok, payload } = await fetchJson(url);
    if (seq !== requestSeq || els !== activeEls) return; // stale
    if (!ok) {
      showError(els, (payload && payload.error) || t("views.flightRecorder.loadError", {}, "Load failed"));
      return;
    }
    clearError(els);

    const archived = Array.isArray(payload.runs) ? payload.runs : [];
    nextBefore = payload.page && payload.page.hasMore ? payload.page.nextBefore : null;

    if (append) {
      // Append archived rows to the existing archived section.
      for (const run of archived) {
        els.list.appendChild(buildRunRow(els, run, false));
      }
      els.loadMore.hidden = !nextBefore;
    } else {
      // De-dup: a run can appear both live (just settled) and archived.
      const liveIds = new Set(liveRuns.map((r) => r.runId));
      const archivedUnique = archived.filter((r) => !liveIds.has(r.runId));
      renderList(els, liveRuns, archivedUnique);
      // Keep the open detail panel fresh if its run is in this list.
      if (selectedRunId && (liveIds.has(selectedRunId) || archived.some((r) => r.runId === selectedRunId))) {
        void selectRun(els, selectedRunId);
      }
    }
  } catch (e) {
    if (seq === requestSeq && els === activeEls) {
      showError(els, t("views.flightRecorder.loadError", {}, "Load failed"));
    }
  }
}

/* ------------------------------------------------------------------ */
/* SSE live refresh                                                    */
/* ------------------------------------------------------------------ */

function connectSSE(els) {
  if (eventSource) return; // singleton across revisits
  try {
    eventSource = new EventSource(SSE_URL);
  } catch (e) {
    setLiveBadge(els, false);
    return;
  }
  eventSource.addEventListener("open", () => setLiveBadge(activeEls, true));
  eventSource.addEventListener("error", () => setLiveBadge(activeEls, false));
  const onRunEvent = () => {
    if (!activeEls) return;
    clearTimeout(sseDebounceTimer);
    sseDebounceTimer = setTimeout(() => loadRuns(activeEls), SSE_REFRESH_DEBOUNCE_MS);
  };
  eventSource.addEventListener("fleet.orchestration", onRunEvent);
  // Board cards also move on dispatch; a kanban tick is a cheap "something changed".
  eventSource.addEventListener("fleet.kanban", onRunEvent);
}

function setLiveBadge(els, on) {
  if (!els || !els.liveBadge) return;
  els.liveBadge.classList.toggle("fr-live-on", on);
  els.liveBadge.textContent = on
    ? t("views.flightRecorder.live", {}, "LIVE")
    : t("views.flightRecorder.poll", {}, "POLL");
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

export function init(container) {
  // Clean up any prior visit's timers (SSE is a deliberate singleton).
  clearTimeout(refreshTimer);
  clearTimeout(sseDebounceTimer);

  const els = {
    status: container.querySelector("#fr-filter-status"),
    agent: container.querySelector("#fr-filter-agent"),
    limit: container.querySelector("#fr-filter-limit"),
    refresh: container.querySelector("#fr-refresh-btn"),
    list: container.querySelector("#fr-list"),
    empty: container.querySelector("#fr-empty-state"),
    detail: container.querySelector("#fr-detail"),
    loadMore: container.querySelector("#fr-load-more"),
    countLine: container.querySelector("#fr-count-line"),
    liveBadge: container.querySelector("#fr-live-badge"),
    error: container.querySelector("#fr-error"),
  };
  activeEls = els;
  nextBefore = null;

  els.refresh.addEventListener("click", () => {
    nextBefore = null;
    loadRuns(els);
  });
  els.status.addEventListener("change", () => {
    nextBefore = null;
    loadRuns(els);
  });
  els.limit.addEventListener("change", () => {
    nextBefore = null;
    loadRuns(els);
  });
  els.agent.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      nextBefore = null;
      loadRuns(els);
    }
  });
  els.loadMore.addEventListener("click", () => loadRuns(els, { append: true }));

  loadRuns(els);
  connectSSE(els);
  setLiveBadge(els, eventSource && eventSource.readyState === 1);

  // Polling fallback in case SSE is unavailable behind a proxy.
  const tick = () => {
    if (activeEls === els) {
      loadRuns(els);
      refreshTimer = setTimeout(tick, AUTO_REFRESH_MS);
    }
  };
  refreshTimer = setTimeout(tick, AUTO_REFRESH_MS);

  // Cleanup on revisit: stop the poll + null the active els so stale async
  // responses are dropped. The SSE singleton stays connected for live badges.
  return () => {
    clearTimeout(refreshTimer);
    clearTimeout(sseDebounceTimer);
    if (activeEls === els) activeEls = null;
  };
}
