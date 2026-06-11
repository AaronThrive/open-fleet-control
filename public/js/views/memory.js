/**
 * Memory view module — workspace memory stats + recent-files detail list.
 *
 * Loaded by views.js via dynamic import; `init(containerEl)` runs on every
 * visit of #view-memory and must be idempotent.
 *
 * Data source: GET /api/memory → { memory: { totalFiles, totalSizeFormatted,
 * memoryMdSizeFormatted, memoryMdLines, recentFiles: [{ name, sizeFormatted,
 * age }] } }. The same payload arrives as the `memory` slice of /api/state
 * over SSE (re-dispatched as the `fleet:state` window event); polling is the
 * fallback.
 *
 * The long-term memory summary (cortex stats) is fetched once per init from
 * GET /api/fleet/cortex and fails quietly to "offline".
 *
 * All dynamic values render via textContent — XSS-safe.
 */

import { t } from "../utils.js";
import { createDetailList } from "../components/detail-list.js";

const POLL_MS = 30000;
const SSE_FRESH_MS = 20000;

let pollTimer = null;
let stateListener = null;
let list = null;
let requestSeq = 0;
let lastSseAt = 0;

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for node:test)                               */
/* ------------------------------------------------------------------ */

/**
 * Classify a memory file by name: date-stamped files (daily notes / raw
 * session logs) are "daily", everything else is a "state" file.
 */
export function classifyFileType(name) {
  return /\d{4}-\d{2}-\d{2}/.test(String(name || "")) ? "daily" : "state";
}

/** Flatten the API payload's recentFiles into detail-list rows. */
export function buildFileRows(memory) {
  const files = Array.isArray(memory?.recentFiles) ? memory.recentFiles : [];
  return files
    .filter((file) => file && file.name)
    .map((file) => ({
      name: file.name,
      type: classifyFileType(file.name),
      size: file.sizeFormatted || "—",
      age: file.age || "—",
    }));
}

/** Header count text: "12 files" (or "1 file"). */
export function countText(totalFiles) {
  const n = Number(totalFiles) || 0;
  return `${n} file${n === 1 ? "" : "s"}`;
}

/** "184 lines" suffix for the MEMORY.md stat (em dash when unknown). */
export function linesText(lines) {
  const n = Number(lines);
  return Number.isFinite(n) && n > 0 ? `· ${n} lines` : "· —";
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

function typeBadge(type) {
  const icon = type === "daily" ? "📅" : "📊";
  return el("span", `memory-type-badge ${type}`, `${icon} ${type}`);
}

function buildDetail(row) {
  const dl = el("dl", "memory-detail-grid");
  const add = (label, value) => {
    dl.appendChild(el("dt", null, label));
    dl.appendChild(el("dd", null, value));
  };
  add(t("views.memory.detailFile", {}, "File"), row.name);
  add(t("views.memory.detailType", {}, "Type"), row.type);
  add(t("views.memory.detailSize", {}, "Size"), row.size);
  add(t("views.memory.detailModified", {}, "Modified"), row.age);
  return dl;
}

function createList(els) {
  return createDetailList(els.listHost, {
    columns: [
      { key: "name", label: t("views.memory.colFile", {}, "File"), sortable: true },
      {
        key: "type",
        label: t("views.memory.colType", {}, "Type"),
        sortable: true,
        render: (row) => typeBadge(row.type),
      },
      { key: "size", label: t("views.memory.colSize", {}, "Size") },
      { key: "age", label: t("views.memory.colModified", {}, "Modified"), sortable: true },
    ],
    getRowId: (row) => row.name,
    renderDetail: (row) => buildDetail(row),
    emptyText: t("views.memory.empty", {}, "No memory files yet."),
    filterKeys: ["name", "type"],
    filterPlaceholder: t("views.memory.filterPlaceholder", {}, "Filter memory files…"),
    defaultSort: null, // keep the server's newest-first order
  });
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function render(els, memory) {
  if (!memory) return;

  els.count.textContent = countText(memory.totalFiles);
  els.mdSize.textContent = memory.memoryMdSizeFormatted || "—";
  els.mdLines.textContent = linesText(memory.memoryMdLines);
  els.totalFiles.textContent = memory.totalFiles ?? "—";
  els.totalSize.textContent = memory.totalSizeFormatted || "—";

  list.update(buildFileRows(memory));
}

/** One-shot long-term memory summary (cortex stats); fails to "offline". */
async function loadCortexSummary(els) {
  try {
    const res = await fetch("/api/fleet/cortex");
    const state = res.ok ? await res.json() : null;
    if (!els.root.isConnected) return;
    const stats = state?.memory?.stats;
    if (!stats || typeof stats.totalMemories !== "number") {
      els.cortexTotal.textContent = t("views.memory.cortexOffline", {}, "offline");
      els.cortexTotal.style.color = "var(--text-muted)";
      return;
    }
    els.cortexTotal.style.color = "";
    els.cortexTotal.textContent = t(
      "views.memory.cortexTotal",
      { total: stats.totalMemories },
      "{total} memories",
    );
    els.cortexScopes.replaceChildren();
    const scopes = Object.entries(stats.byScope || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);
    for (const [scope, count] of scopes) {
      els.cortexScopes.appendChild(el("span", "memory-cortex-scope-chip", `${scope} · ${count}`));
    }
  } catch (error) {
    if (!els.root.isConnected) return;
    els.cortexTotal.textContent = t("views.memory.cortexOffline", {}, "offline");
    els.cortexTotal.style.color = "var(--text-muted)";
  }
}

/* ------------------------------------------------------------------ */
/* Data loading + lifecycle                                            */
/* ------------------------------------------------------------------ */

async function load(els) {
  const seq = ++requestSeq;
  try {
    const response = await fetch("/api/memory");
    const payload = await response.json();
    if (seq !== requestSeq || !els.root.isConnected) return;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    els.error.hidden = true;
    render(els, payload.memory);
  } catch (error) {
    if (seq !== requestSeq || !els.root.isConnected) return;
    els.error.hidden = false;
    els.error.textContent = t(
      "views.memory.loadError",
      {},
      "Could not reach the memory API — is the server up?",
    );
  }
}

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
 * Initialize the Memory view. Called by views.js on every visit.
 * @param {HTMLElement} container
 */
export function init(container) {
  teardown();

  const els = {
    root: container.querySelector("#memory-view-section"),
    count: container.querySelector("#memory-view-count"),
    error: container.querySelector("#memory-view-error"),
    mdSize: container.querySelector("#memory-view-md-size"),
    mdLines: container.querySelector("#memory-view-md-lines"),
    totalFiles: container.querySelector("#memory-view-total-files"),
    totalSize: container.querySelector("#memory-view-total-size"),
    listHost: container.querySelector("#memory-view-list"),
    cortexTotal: container.querySelector("#memory-view-cortex-total"),
    cortexScopes: container.querySelector("#memory-view-cortex-scopes"),
  };
  if (Object.values(els).some((node) => !node)) {
    console.error("[Memory] Partial markup is missing expected elements; aborting init.");
    return;
  }

  list = createList(els);

  stateListener = (event) => {
    if (!els.root.isConnected) {
      teardown();
      return;
    }
    lastSseAt = Date.now();
    if (event.detail?.memory) {
      els.error.hidden = true;
      render(els, event.detail.memory);
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
  loadCortexSummary(els);
}
