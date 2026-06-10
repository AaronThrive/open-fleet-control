/**
 * Evolution view — lessons-learned review board with validation gate.
 *
 * Loaded by views.js, which calls `init(containerEl)` on EVERY visit; this
 * module is idempotent (each init tears down the previous one). Live updates
 * arrive via the `fleet:evolution` window event (re-dispatched in index.html
 * from the shared SSE EventSource), with a 30s polling fallback.
 */

import { escapeHtml, t } from "../utils.js";

const REFRESH_INTERVAL_MS = 30000;
const STATUSES = ["pending", "approved", "rejected"];

// Module-scope handle to the active instance so re-init can clean up.
let teardown = null;

let activeTab = "pending";

function toast(message, type = "success") {
  if (typeof window.showToast === "function") {
    window.showToast(message, type);
    return;
  }
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function relativeTime(ts) {
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return t("time.unknown", {}, "unknown time");
  const diffMs = Date.now() - parsed;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return t("time.relJustNow", {}, "just now");
  if (mins < 60) return t("time.agoMinutes", { n: mins }, "{n}m ago");
  if (mins < 1440) return t("time.agoHours", { n: Math.round(mins / 60) }, "{n}h ago");
  return t("time.agoDays", { n: Math.round(mins / 1440) }, "{n}d ago");
}

async function fetchEvolution() {
  const res = await fetch("/api/fleet/evolution");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function putGate(gate) {
  const res = await fetch("/api/fleet/evolution/gate", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gate }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function postLessonAction(id, action) {
  const res = await fetch(
    `/api/fleet/evolution/lessons/${encodeURIComponent(id)}/${encodeURIComponent(action)}`,
    { method: "POST" },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function renderGateBanner(refs, gate) {
  const banner = refs.gateBanner;
  if (!banner) return;
  banner.hidden = false;
  banner.classList.toggle("on", gate);
  banner.classList.toggle("off", !gate);
  const gateTitle = gate
    ? t("views.evolution.gateOnTitle", {}, "Validation gate ON")
    : t("views.evolution.gateOffTitle", {}, "Validation gate OFF");
  const gateDesc = gate
    ? t("views.evolution.gateOnDesc", {}, "new lessons require approval before merging.")
    : t("views.evolution.gateOffDesc", {}, "autonomous merge: lessons auto-approve.");
  refs.gateText.innerHTML = `${gate ? "🛡️" : "⚡"} <strong>${escapeHtml(gateTitle)}</strong> — ${escapeHtml(gateDesc)}`;
  refs.gateToggle.textContent = gate
    ? t("views.evolution.gateTurnOff", {}, "Turn gate OFF")
    : t("views.evolution.gateTurnOn", {}, "Turn gate ON");
  refs.gateToggle.title = gate
    ? t("views.evolution.gateTitleOn", {}, "Switch to autonomous merge (lessons auto-approve)")
    : t("views.evolution.gateTitleOff", {}, "Require approval for new lessons");
}

function lessonCard(lesson) {
  const isPending = lesson.status === "pending";
  const actions = isPending
    ? `<div class="evo-card-actions">
         <button class="evo-btn approve" type="button" data-action="approve" data-id="${escapeHtml(lesson.id)}">✓ ${escapeHtml(t("views.evolution.approve", {}, "Approve"))}</button>
         <button class="evo-btn reject" type="button" data-action="reject" data-id="${escapeHtml(lesson.id)}">✗ ${escapeHtml(t("views.evolution.reject", {}, "Reject"))}</button>
       </div>`
    : "";
  return `<div class="evo-card" data-lesson-id="${escapeHtml(lesson.id)}">
    <div class="evo-card-head">
      <span class="evo-card-title">${escapeHtml(lesson.title)}</span>
      <span class="evo-card-meta">
        <span class="evo-author-chip" title="${escapeHtml(lesson.author)}">${escapeHtml(lesson.author)}</span>
        <span title="${escapeHtml(lesson.ts)}">${escapeHtml(relativeTime(lesson.ts))}</span>
      </span>
    </div>
    <pre class="evo-card-body">${escapeHtml(lesson.body)}</pre>
    ${actions}
  </div>`;
}

function malformedCard(entry) {
  const label = t(
    "views.evolution.malformed",
    {},
    "⚠️ Malformed lesson entry — could not be parsed",
  );
  const fallbackBody = t("views.evolution.unparseable", {}, "Unparseable section");
  return `<div class="evo-card malformed">
    <div class="evo-malformed-label">${escapeHtml(label)}</div>
    <pre class="evo-card-body">${escapeHtml(entry.raw || entry.parseError || fallbackBody)}</pre>
  </div>`;
}

function renderBoard(refs, state) {
  const lessons = Array.isArray(state.lessons) ? state.lessons : [];
  const valid = lessons.filter((l) => !l.parseError);
  const malformed = lessons.filter((l) => l.parseError);
  const pendingCount = valid.filter((l) => l.status === "pending").length;

  refs.pendingBadge.textContent = String(pendingCount);

  const hasAnything = lessons.length > 0;
  refs.board.hidden = !hasAnything;
  refs.emptyState.style.display = hasAnything ? "none" : "";
  if (!hasAnything) return;

  refs.tabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.status === activeTab);
    tab.setAttribute("aria-selected", tab.dataset.status === activeTab ? "true" : "false");
  });

  const visible = valid.filter((l) => l.status === activeTab);
  const parts = visible.map(lessonCard);
  // Malformed entries need operator attention — surface them on the Pending tab.
  if (activeTab === "pending") parts.push(...malformed.map(malformedCard));

  const emptyByTab = {
    pending: t("views.evolution.noPending", {}, "No pending lessons."),
    approved: t("views.evolution.noApproved", {}, "No approved lessons."),
    rejected: t("views.evolution.noRejected", {}, "No rejected lessons."),
  };
  refs.lessonsEl.innerHTML =
    parts.length > 0
      ? parts.join("")
      : `<div class="evo-tab-empty">${escapeHtml(emptyByTab[activeTab] || emptyByTab.pending)}</div>`;
}

function showError(refs, message) {
  if (!refs.errorEl) return;
  refs.errorEl.hidden = false;
  refs.errorEl.textContent = t(
    "views.evolution.loadError",
    { message },
    "Failed to load evolution data: {message}",
  );
}

function clearError(refs) {
  if (refs.errorEl) refs.errorEl.hidden = true;
}

/**
 * Entry point called by views.js on every visit of #view-evolution.
 * @param {HTMLElement} container - element holding the freshly injected partial
 */
export function init(container) {
  if (typeof teardown === "function") {
    teardown();
    teardown = null;
  }

  const refs = {
    gateBanner: container.querySelector("#evo-gate-banner"),
    gateText: container.querySelector("#evo-gate-text"),
    gateToggle: container.querySelector("#evo-gate-toggle"),
    board: container.querySelector("#evo-board"),
    lessonsEl: container.querySelector("#evo-lessons"),
    pendingBadge: container.querySelector("#evo-pending-badge"),
    emptyState: container.querySelector("#evolution-empty-state"),
    errorEl: container.querySelector("#evo-error"),
    tabs: Array.from(container.querySelectorAll(".evo-tab")),
  };
  if (!refs.board || !refs.lessonsEl) return;

  let state = { gate: true, lessons: [] };
  let destroyed = false;

  async function refresh() {
    try {
      const data = await fetchEvolution();
      if (destroyed) return;
      state = data;
      clearError(refs);
      renderGateBanner(refs, !!state.gate);
      renderBoard(refs, state);
    } catch (e) {
      if (!destroyed) showError(refs, e.message);
    }
  }

  // --- Tabs -----------------------------------------------------------
  refs.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const status = tab.dataset.status;
      if (!STATUSES.includes(status)) return;
      activeTab = status;
      renderBoard(refs, state);
    });
  });

  // --- Gate toggle (panel banner) --------------------------------------
  refs.gateToggle?.addEventListener("click", async () => {
    const next = !state.gate;
    const previous = state.gate;
    state = { ...state, gate: next };
    renderGateBanner(refs, next); // optimistic
    refs.gateToggle.disabled = true;
    try {
      await putGate(next);
      toast(
        next
          ? t("gate.toastOn", {}, "Validation gate ON — lessons require approval")
          : t("gate.toastOff", {}, "Validation gate OFF — autonomous merge"),
      );
      window.dispatchEvent(
        new CustomEvent("fleet:evolution", { detail: { type: "gate.toggle", gate: next } }),
      );
    } catch (e) {
      state = { ...state, gate: previous }; // revert
      renderGateBanner(refs, previous);
      toast(
        t("gate.updateFailed", { message: e.message }, "Gate update failed: {message}"),
        "error",
      );
    } finally {
      refs.gateToggle.disabled = false;
    }
  });

  // --- Approve / Reject (event delegation, optimistic remove) ----------
  refs.lessonsEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const { action, id } = btn.dataset;
    if (!id || (action !== "approve" && action !== "reject")) return;

    const snapshot = state;
    const card = refs.lessonsEl.querySelector(`[data-lesson-id="${CSS.escape(id)}"]`);
    btn.disabled = true;

    // Optimistic: update local state and re-render without the pending card.
    state = {
      ...state,
      lessons: state.lessons.map((l) =>
        !l.parseError && l.id === id
          ? { ...l, status: action === "approve" ? "approved" : "rejected" }
          : l,
      ),
    };
    if (card) card.remove();
    renderBoard(refs, state);

    try {
      await postLessonAction(id, action);
      toast(
        action === "approve"
          ? t("views.evolution.toastApproved", {}, "Lesson approved")
          : t("views.evolution.toastRejected", {}, "Lesson rejected"),
      );
    } catch (err) {
      state = snapshot; // rollback
      renderBoard(refs, state);
      toast(
        action === "approve"
          ? t(
              "views.evolution.toastApproveFailed",
              { message: err.message },
              "Failed to approve lesson: {message}",
            )
          : t(
              "views.evolution.toastRejectFailed",
              { message: err.message },
              "Failed to reject lesson: {message}",
            ),
        "error",
      );
    }
  });

  // --- Live updates: SSE re-dispatch + 30s fallback ---------------------
  const onEvolutionEvent = () => refresh();
  window.addEventListener("fleet:evolution", onEvolutionEvent);
  const intervalId = setInterval(refresh, REFRESH_INTERVAL_MS);

  teardown = () => {
    destroyed = true;
    window.removeEventListener("fleet:evolution", onEvolutionEvent);
    clearInterval(intervalId);
  };

  refresh();
}
