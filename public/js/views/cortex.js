/**
 * Cortex view — compression fuel gauges, memory browser, knowledge graph.
 *
 * Loaded by views.js via dynamic import; init(container) re-runs on every
 * visit, so all state is rebuilt from scratch (idempotent). All dynamic
 * content is rendered with createElement/textContent — never innerHTML with
 * server data.
 */

import { t } from "../utils.js";

const API_BASE = "/api/fleet/cortex";
const MEMORY_LIST_LIMIT = 30;
const GRAPH_NODE_CAP = 150;
const SEARCH_DEBOUNCE_MS = 300;

const MEMORY_CATEGORIES = ["fact", "preference", "decision", "entity", "reflection", "other"];

// Module-scope handles cleaned up on every init (the DOM itself is replaced
// by the view loader, so listeners die with it — only timers/aborts persist).
let abortController = null;
let searchTimer = null;
// Memory write capabilities from the last /api/fleet/cortex state: editing
// needs CLI + readable dataset (merge reads the row), delete needs the CLI.
let memoryCaps = { cli: false, lancedb: false };

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */

/** Format a token count as 1.2k / 3.4M etc. */
function formatTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** Relative time from an epoch-ms timestamp ("3h ago"). */
function relativeTime(timestamp) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const diff = Date.now() - ts;
  if (diff < 0) return t("time.relJustNow", {}, "just now");
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t("time.relJustNow", {}, "just now");
  if (mins < 60) return t("time.agoMinutes", { n: mins }, "{n}m ago");
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("time.agoHours", { n: hours }, "{n}h ago");
  const days = Math.floor(hours / 24);
  if (days < 30) return t("time.agoDays", { n: days }, "{n}d ago");
  const months = Math.floor(days / 30);
  if (months < 12) return t("time.agoMonths", { n: months }, "{n}mo ago");
  return t("time.agoYears", { n: Math.floor(months / 12) }, "{n}y ago");
}

/** Build a short, human detail line for a gauge's `detail` object. */
function gaugeDetailLine(gauge) {
  const d = gauge.detail || {};
  if (gauge.source === "headroom") {
    const parts = [
      t(
        "views.cortex.detailHeadroom",
        {
          input: formatTokens(d.input),
          output: formatTokens(d.output),
          cacheReads: formatTokens(d.cacheReads),
        },
        "in {input} · out {output} · cache reads {cacheReads}",
      ),
    ];
    if (d.fiveHourUtilizationPct !== null && d.fiveHourUtilizationPct !== undefined) {
      parts.push(
        t(
          "views.cortex.detailHeadroomWindow",
          { pct: d.fiveHourUtilizationPct },
          "5h window {pct}%",
        ),
      );
    }
    return parts.join(" · ");
  }
  if (gauge.source === "lean-ctx") {
    return t(
      "views.cortex.detailLeanCtx",
      { commands: d.totalCommands ?? 0, days: d.daysTracked ?? 0 },
      "{commands} commands compressed · {days} days tracked",
    );
  }
  if (gauge.source === "lcm") {
    return t(
      "views.cortex.detailLcm",
      { summaries: d.summaries ?? 0, messages: d.messages ?? 0 },
      "{summaries} summaries · {messages} source messages",
    );
  }
  // Unknown source: render scalar key/value pairs generically.
  return Object.entries(d)
    .filter(([, v]) => v !== null && typeof v !== "object")
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
}

/* ------------------------------------------------------------------ */
/* DOM helpers (XSS-safe)                                              */
/* ------------------------------------------------------------------ */

/** Create an element with className and textContent. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Toast using the dashboard's global .toast styles. */
function showToast(message, kind) {
  let host = document.querySelector(".toast-container");
  if (!host) {
    host = el("div", "toast-container");
    document.body.appendChild(host);
  }
  const toast = el("div", `toast ${kind === "error" ? "error" : "success"}`, message);
  host.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

/** Styled offline/diagnostic block. */
function buildOfflineBlock(icon, title, reason, help) {
  const wrap = el("div", "cx-offline");
  wrap.appendChild(el("div", "cx-offline-icon", icon));
  wrap.appendChild(el("div", "cx-offline-title", title));
  if (reason) wrap.appendChild(el("div", "cx-offline-reason", reason));
  wrap.appendChild(el("div", "cx-offline-help", help));
  return wrap;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { signal: abortController.signal, ...options });
  let body = null;
  try {
    body = await response.json();
  } catch (e) {
    body = null;
  }
  if (!response.ok) {
    const message = body && body.error ? body.error : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

/* ------------------------------------------------------------------ */
/* Availability strip                                                  */
/* ------------------------------------------------------------------ */

function renderAvailability(root, state) {
  const entries = {
    memory: !!state.memory?.available,
    gbrain: !!state.gbrain?.available,
    gauges: (state.gauges || []).some((g) => g && g.available),
  };
  for (const [key, up] of Object.entries(entries)) {
    const dot = root.querySelector(`[data-avail="${key}"]`);
    const label = root.querySelector(`[data-avail-state="${key}"]`);
    if (dot) dot.className = `cx-avail-dot ${up ? "up" : "down"}`;
    if (label) {
      label.textContent = up
        ? t("views.cortex.online", {}, "online")
        : t("views.cortex.offline", {}, "offline");
      label.style.color = up ? "var(--cx-accent)" : "#f8a3a0";
    }
  }
}

/* ------------------------------------------------------------------ */
/* Fuel gauges                                                         */
/* ------------------------------------------------------------------ */

function buildGaugeCard(gauge) {
  const card = el("div", `cx-gauge ${gauge.available ? "available" : "unavailable"}`);

  const top = el("div", "cx-gauge-top");
  const label = el("div", "cx-gauge-label", gauge.label || gauge.source);
  label.title = gauge.label || "";
  top.appendChild(label);

  const pct = el("div", "cx-gauge-pct");
  if (gauge.available && gauge.savingsPct !== null && gauge.savingsPct !== undefined) {
    pct.textContent = `${gauge.savingsPct}%`;
    pct.appendChild(el("small", null, t("views.cortex.savedLabel", {}, "saved")));
  } else {
    pct.classList.add("na");
    pct.textContent = gauge.available ? "—" : t("views.cortex.offline", {}, "offline");
  }
  top.appendChild(pct);
  card.appendChild(top);

  const bar = el("div", "cx-gauge-bar");
  const fill = el("div", "cx-gauge-fill");
  const raw = Number(gauge.rawTokens) || 0;
  const effective = Number(gauge.effectiveTokens) || 0;
  const ratio = gauge.available && raw > 0 ? Math.max(0, Math.min(1, effective / raw)) : 0;
  fill.style.width = `${(ratio * 100).toFixed(2)}%`;
  bar.appendChild(fill);
  card.appendChild(bar);

  const counts = el("div", "cx-gauge-counts");
  const rawSpan = el("span");
  rawSpan.append(`${t("views.cortex.rawLabel", {}, "raw")} `);
  rawSpan.appendChild(el("b", null, formatTokens(raw)));
  const effSpan = el("span", "eff");
  effSpan.append(`${t("views.cortex.effectiveLabel", {}, "effective")} `);
  effSpan.appendChild(el("b", null, formatTokens(effective)));
  counts.append(rawSpan, effSpan);
  card.appendChild(counts);

  if (gauge.available) {
    card.appendChild(el("div", "cx-gauge-detail", gaugeDetailLine(gauge)));
  } else {
    const reason =
      gauge.detail?.error ||
      t("views.cortex.sourceUnavailable", {}, "source not available on this host");
    card.appendChild(el("div", "cx-gauge-reason", reason));
  }
  return card;
}

function renderGauges(root, gauges) {
  const host = root.querySelector("#cx-gauges");
  if (!host) return;
  clearChildren(host);
  const list = Array.isArray(gauges) ? gauges : [];
  if (list.length === 0) {
    host.appendChild(
      el(
        "div",
        "cx-empty",
        t("views.cortex.noGauges", {}, "No compression gauges reported by the server."),
      ),
    );
    return;
  }
  for (const gauge of list) host.appendChild(buildGaugeCard(gauge));
}

/* ------------------------------------------------------------------ */
/* Memory browser                                                      */
/* ------------------------------------------------------------------ */

/** Reload the memory list using whatever is in the search box. */
function refreshMemoryList(root) {
  loadMemories(root, root.querySelector("#cx-memory-search")?.value || "");
}

/** A labelled control for the inline editor (reuses .cx-store-row styles). */
function editorField(labelText, control) {
  const label = document.createElement("label");
  label.appendChild(el("span", null, labelText));
  label.appendChild(control);
  return label;
}

function buildCategorySelect(current) {
  const select = document.createElement("select");
  const cats = MEMORY_CATEGORIES.includes(current)
    ? MEMORY_CATEGORIES
    : [current, ...MEMORY_CATEGORIES];
  for (const cat of cats) {
    const option = document.createElement("option");
    option.value = cat;
    option.textContent = cat;
    option.selected = cat === current;
    select.appendChild(option);
  }
  return select;
}

/** Diff the editor inputs against the row — only changed fields are sent. */
function collectEditorChanges(row, inputs) {
  const changes = {};
  const text = inputs.textarea.value.trim();
  if (text && text !== (row.text || "")) changes.text = text;
  if (inputs.select.value !== (row.category || "fact")) changes.category = inputs.select.value;
  const scope = inputs.scopeInput.value.trim();
  if (scope && scope !== (row.scope || "global")) changes.scope = scope;
  const importance = Number(inputs.slider.value);
  const current = Number(row.importance);
  if (!Number.isFinite(current) || Math.abs(importance - current) > 0.001) {
    changes.importance = importance;
  }
  return changes;
}

async function submitMemoryEdit(root, row, item, form, inputs, saveBtn) {
  if (!inputs.textarea.value.trim()) {
    showToast(t("views.cortex.emptyTextError", {}, "Memory text cannot be empty."), "error");
    return;
  }
  const changes = collectEditorChanges(row, inputs);
  if (Object.keys(changes).length === 0) {
    showToast(t("views.cortex.noChanges", {}, "No changes to save."), "success");
    form.remove();
    return;
  }
  // Optimistic: show the new text immediately; the refresh below reverts it
  // if the server rejects the update.
  const textEl = item.querySelector(".cx-mem-text");
  if (changes.text && textEl) textEl.textContent = changes.text;
  saveBtn.disabled = true;
  clearChildren(saveBtn);
  saveBtn.appendChild(el("span", "cx-spinner"));
  saveBtn.append(` ${t("views.cortex.saving", {}, "Saving…")}`);
  try {
    await fetchJson(`${API_BASE}/memory/${encodeURIComponent(row.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    });
    showToast(t("views.cortex.updated", {}, "Memory updated."), "success");
    refreshMemoryList(root);
  } catch (error) {
    if (error.name === "AbortError") return;
    showToast(
      t(
        "views.cortex.updateFailed",
        { message: error.message },
        "Failed to update memory: {message}",
      ),
      "error",
    );
    refreshMemoryList(root);
  }
}

function buildEditor(root, row, item) {
  const form = document.createElement("form");
  form.className = "cx-mem-editor";

  const textarea = document.createElement("textarea");
  textarea.value = row.text || "";
  form.appendChild(textarea);

  const select = buildCategorySelect(row.category || "fact");
  const scopeInput = document.createElement("input");
  scopeInput.type = "text";
  scopeInput.value = row.scope || "global";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "1";
  slider.step = "0.05";
  const currentImp = Number(row.importance);
  slider.value = String(Number.isFinite(currentImp) ? currentImp : 0.7);
  const impValue = el("span", "cx-imp-value", Number(slider.value).toFixed(2));
  slider.addEventListener("input", () => {
    impValue.textContent = Number(slider.value).toFixed(2);
  });
  const impLabel = editorField(t("views.cortex.importance", {}, "Importance"), slider);
  impLabel.insertBefore(impValue, slider);

  const fieldsRow = el("div", "cx-store-row");
  fieldsRow.appendChild(editorField(t("views.cortex.category", {}, "Category"), select));
  fieldsRow.appendChild(editorField(t("views.cortex.scope", {}, "Scope"), scopeInput));
  fieldsRow.appendChild(impLabel);
  form.appendChild(fieldsRow);

  const actions = el("div", "cx-store-actions");
  const saveBtn = el("button", "cx-btn", t("views.cortex.saveBtn", {}, "Save"));
  saveBtn.type = "submit";
  const cancelBtn = el("button", "cx-mem-act", t("views.cortex.cancelBtn", {}, "Cancel"));
  cancelBtn.type = "button";
  cancelBtn.addEventListener("click", () => form.remove());
  actions.append(saveBtn, cancelBtn);
  form.appendChild(actions);

  const inputs = { textarea, select, scopeInput, slider };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitMemoryEdit(root, row, item, form, inputs, saveBtn);
  });
  return form;
}

function toggleEditor(root, row, item) {
  const open = item.querySelector(".cx-mem-editor");
  if (open) {
    open.remove();
    return;
  }
  item.appendChild(buildEditor(root, row, item));
}

async function deleteMemoryRow(root, row, item, btn) {
  const confirmed = window.confirm(
    t("views.cortex.deleteConfirm", {}, "Delete this memory permanently? This cannot be undone."),
  );
  if (!confirmed) return;
  btn.disabled = true;
  item.classList.add("cx-mem-removing");
  try {
    await fetchJson(`${API_BASE}/memory/${encodeURIComponent(row.id)}`, { method: "DELETE" });
    showToast(t("views.cortex.deleted", {}, "Memory deleted."), "success");
    item.remove();
    refreshMemoryList(root);
  } catch (error) {
    if (error.name === "AbortError") return;
    btn.disabled = false;
    item.classList.remove("cx-mem-removing");
    showToast(
      t(
        "views.cortex.deleteFailed",
        { message: error.message },
        "Failed to delete memory: {message}",
      ),
      "error",
    );
  }
}

function buildMemoryActions(root, row, item) {
  const actions = el("div", "cx-mem-actions");
  if (memoryCaps.cli && memoryCaps.lancedb) {
    const editBtn = el("button", "cx-mem-act", t("views.cortex.editBtn", {}, "Edit"));
    editBtn.type = "button";
    editBtn.addEventListener("click", () => toggleEditor(root, row, item));
    actions.appendChild(editBtn);
  }
  if (memoryCaps.cli) {
    const deleteBtn = el("button", "cx-mem-act danger", t("views.cortex.deleteBtn", {}, "Delete"));
    deleteBtn.type = "button";
    deleteBtn.addEventListener("click", () => deleteMemoryRow(root, row, item, deleteBtn));
    actions.appendChild(deleteBtn);
  }
  return actions;
}

function buildMemoryItem(root, row) {
  const item = el("div", "cx-mem-item");

  const text = el("div", "cx-mem-text", row.text || t("views.cortex.emptyMemory", {}, "(empty)"));
  item.appendChild(text);

  const expand = el("button", "cx-mem-expand", t("views.cortex.showMore", {}, "Show more"));
  expand.type = "button";
  let expanded = false;
  const toggle = () => {
    expanded = !expanded;
    text.classList.toggle("expanded", expanded);
    expand.textContent = expanded
      ? t("views.cortex.showLess", {}, "Show less")
      : t("views.cortex.showMore", {}, "Show more");
  };
  expand.addEventListener("click", toggle);
  text.addEventListener("click", toggle);
  // Only show the toggle when the text actually overflows three lines.
  requestAnimationFrame(() => {
    if (text.scrollHeight <= text.clientHeight + 2) expand.style.display = "none";
  });
  item.appendChild(expand);

  const meta = el("div", "cx-mem-meta");
  if (row.category) meta.appendChild(el("span", "cx-chip", row.category));
  if (row.scope) meta.appendChild(el("span", "cx-chip scope", row.scope));

  const importance = Number(row.importance);
  if (Number.isFinite(importance)) {
    const dot = el("span", "cx-imp-dot");
    dot.style.background =
      importance >= 0.8 ? "var(--cx-accent)" : importance >= 0.5 ? "#e3b341" : "#555c68";
    dot.title = t("views.cortex.importanceTitle", { value: importance }, "importance {value}");
    meta.appendChild(dot);
    meta.appendChild(el("span", null, importance.toFixed(2)));
  }
  if (typeof row.score === "number") {
    meta.appendChild(
      el("span", null, t("views.cortex.score", { value: row.score.toFixed(3) }, "score {value}")),
    );
  }
  const when = relativeTime(row.timestamp);
  if (when) meta.appendChild(el("span", "cx-mem-time", when));
  item.appendChild(meta);

  if (row.id && (memoryCaps.cli || memoryCaps.lancedb)) {
    const actions = buildMemoryActions(root, row, item);
    if (actions.childElementCount > 0) item.appendChild(actions);
  }
  return item;
}

async function loadMemories(root, query) {
  const list = root.querySelector("#cx-memory-list");
  if (!list) return;
  clearChildren(list);
  list.appendChild(
    el(
      "div",
      "cx-loading",
      query
        ? t("views.cortex.searching", {}, "Searching…")
        : t("views.cortex.loadingMemories", {}, "Loading memories…"),
    ),
  );

  try {
    const trimmed = (query || "").trim();
    const url = trimmed
      ? `${API_BASE}/memory?query=${encodeURIComponent(trimmed)}&limit=${MEMORY_LIST_LIMIT}`
      : `${API_BASE}/memory?limit=${MEMORY_LIST_LIMIT}`;
    const payload = await fetchJson(url);
    const rows = payload?.results || payload?.items || [];

    clearChildren(list);
    if (rows.length === 0) {
      list.appendChild(
        el(
          "div",
          "cx-empty",
          trimmed
            ? t("views.cortex.noSearchResults", {}, "No memories match this search.")
            : t("views.cortex.noMemories", {}, "No memories stored yet."),
        ),
      );
      return;
    }
    for (const row of rows) list.appendChild(buildMemoryItem(root, row));
  } catch (error) {
    if (error.name === "AbortError") return;
    clearChildren(list);
    list.appendChild(
      el(
        "div",
        "cx-empty",
        t(
          "views.cortex.lookupFailed",
          { message: error.message },
          "Memory lookup failed: {message}",
        ),
      ),
    );
  }
}

function setupMemoryBrowser(root, memoryState) {
  const body = root.querySelector("#cx-memory-body");
  const offline = root.querySelector("#cx-memory-offline");
  const statsEl = root.querySelector("#cx-memory-stats");
  memoryCaps = { cli: !!memoryState?.cli, lancedb: !!memoryState?.lancedb };

  if (!memoryState?.available) {
    if (body) body.style.display = "none";
    if (offline) {
      offline.style.display = "";
      clearChildren(offline);
      offline.appendChild(
        buildOfflineBlock(
          "🧠",
          t("views.cortex.memoryOfflineTitle", {}, "Memory store offline"),
          memoryState?.reason ||
            t("views.cortex.memoryOfflineReason", {}, "memory adapter unavailable"),
          t(
            "views.cortex.memoryOfflineHelp",
            {},
            "The memory browser comes back automatically once the OpenClaw CLI or the LanceDB dataset is reachable on this host.",
          ),
        ),
      );
    }
    return;
  }
  if (body) body.style.display = "";
  if (offline) offline.style.display = "none";

  const stats = memoryState.stats;
  if (statsEl && stats?.totalMemories !== undefined) {
    statsEl.textContent = t(
      "views.cortex.memoriesCount",
      { count: stats.totalMemories },
      "{count} memories",
    );
  }

  const search = root.querySelector("#cx-memory-search");
  if (search) {
    search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => loadMemories(root, search.value), SEARCH_DEBOUNCE_MS);
    });
  }
  loadMemories(root, "");
  setupStoreForm(root);
}

function setupStoreForm(root) {
  const form = root.querySelector("#cx-store-form");
  const slider = root.querySelector("#cx-store-importance");
  const sliderValue = root.querySelector("#cx-store-imp-value");
  if (slider && sliderValue) {
    slider.addEventListener("input", () => {
      sliderValue.textContent = Number(slider.value).toFixed(2);
    });
  }
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const textEl = root.querySelector("#cx-store-text");
    const text = textEl?.value.trim() || "";
    if (!text) {
      showToast(t("views.cortex.emptyTextError", {}, "Memory text cannot be empty."), "error");
      return;
    }
    const submit = root.querySelector("#cx-store-submit");
    const originalLabel = submit?.textContent || t("views.cortex.storeBtn", {}, "Store");
    if (submit) {
      submit.disabled = true;
      clearChildren(submit);
      submit.appendChild(el("span", "cx-spinner"));
      submit.append(` ${t("views.cortex.storing", {}, "Storing…")}`);
    }
    try {
      const options = {
        category: root.querySelector("#cx-store-category")?.value || "fact",
        importance: Number(slider?.value ?? 0.7),
      };
      const scope = root.querySelector("#cx-store-scope")?.value.trim();
      if (scope) options.scope = scope;

      await fetchJson(`${API_BASE}/memory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, options }),
      });
      showToast(t("views.cortex.stored", {}, "Memory stored."), "success");
      if (textEl) textEl.value = "";
      const search = root.querySelector("#cx-memory-search");
      loadMemories(root, search?.value || "");
    } catch (error) {
      if (error.name !== "AbortError") {
        showToast(
          t(
            "views.cortex.storeFailed",
            { message: error.message },
            "Failed to store memory: {message}",
          ),
          "error",
        );
      }
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = originalLabel;
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* Knowledge graph                                                     */
/* ------------------------------------------------------------------ */

const SVG_NS = "http://www.w3.org/2000/svg";
const TYPE_COLORS = ["#00ff66", "#0df5e3", "#7ce38b", "#39d2c0", "#b5f5d8", "#5ad1a5"];

function colorForType(type) {
  let hash = 0;
  const s = String(type || "page");
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return TYPE_COLORS[hash % TYPE_COLORS.length];
}

/**
 * Simple force layout, precomputed synchronously: pairwise repulsion +
 * edge springs + mild centering, ~80 iterations with cooling, then static.
 * Capped at GRAPH_NODE_CAP nodes so the O(n²) step stays cheap (<2M ops).
 */
function computeLayout(nodes, edges, width, height) {
  const count = nodes.length;
  const positions = nodes.map((node, i) => {
    const angle = (i / Math.max(1, count)) * Math.PI * 2;
    const radius = Math.min(width, height) * 0.32 * (0.6 + (0.4 * ((i * 7919) % 100)) / 100);
    return {
      x: width / 2 + Math.cos(angle) * radius,
      y: height / 2 + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
    };
  });
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const springs = edges
    .map((edge) => [index.get(edge.from), index.get(edge.to)])
    .filter(([a, b]) => a !== undefined && b !== undefined && a !== b);

  const repulsion = 5200;
  const springLength = 70;
  const springK = 0.04;
  const iterations = 80;

  for (let iter = 0; iter < iterations; iter++) {
    const cooling = 1 - iter / iterations;
    // Pairwise repulsion
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        let dx = positions[i].x - positions[j].x;
        let dy = positions[i].y - positions[j].y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 1) {
          dx = (Math.random() - 0.5) * 2;
          dy = (Math.random() - 0.5) * 2;
          distSq = dx * dx + dy * dy;
        }
        const force = repulsion / distSq;
        const dist = Math.sqrt(distSq);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        positions[i].vx += fx;
        positions[i].vy += fy;
        positions[j].vx -= fx;
        positions[j].vy -= fy;
      }
    }
    // Edge springs
    for (const [a, b] of springs) {
      const dx = positions[b].x - positions[a].x;
      const dy = positions[b].y - positions[a].y;
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const force = (dist - springLength) * springK;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      positions[a].vx += fx;
      positions[a].vy += fy;
      positions[b].vx -= fx;
      positions[b].vy -= fy;
    }
    // Centering pull + integrate with damping
    for (const p of positions) {
      p.vx += (width / 2 - p.x) * 0.005;
      p.vy += (height / 2 - p.y) * 0.005;
      p.x += Math.max(-18, Math.min(18, p.vx * 0.12 * cooling));
      p.y += Math.max(-18, Math.min(18, p.vy * 0.12 * cooling));
      p.vx *= 0.5;
      p.vy *= 0.5;
    }
  }
  return positions;
}

function renderGraph(root, graph) {
  const svg = root.querySelector("#cx-graph-svg");
  const countEl = root.querySelector("#cx-graph-count");
  const noteEl = root.querySelector("#cx-graph-note");
  if (!svg) return;
  clearChildren(svg);

  const allNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const nodes = allNodes.slice(0, GRAPH_NODE_CAP);
  const kept = new Set(nodes.map((n) => n.id));
  const edges = (Array.isArray(graph.edges) ? graph.edges : []).filter(
    (e) => kept.has(e.from) && kept.has(e.to),
  );

  if (countEl) {
    countEl.textContent =
      allNodes.length > nodes.length
        ? t(
            "views.cortex.graphCountCapped",
            { shown: nodes.length, total: allNodes.length, links: edges.length },
            "showing {shown} of {total} nodes · {links} links",
          )
        : t(
            "views.cortex.graphCount",
            { nodes: nodes.length, links: edges.length },
            "{nodes} nodes · {links} links",
          );
  }
  if (noteEl && graph.note) noteEl.textContent = graph.note;

  if (nodes.length === 0) {
    const msg = document.createElementNS(SVG_NS, "text");
    msg.setAttribute("x", "50%");
    msg.setAttribute("y", "50%");
    msg.setAttribute("text-anchor", "middle");
    msg.setAttribute("fill", "#9aa4b2");
    msg.setAttribute("font-size", "13");
    msg.textContent = t(
      "views.cortex.graphEmpty",
      {},
      "The knowledge graph is empty — no pages in gbrain yet.",
    );
    svg.appendChild(msg);
    return;
  }

  const W = 900;
  const H = 560;
  const positions = computeLayout(nodes, edges, W, H);
  const degree = new Map();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) || 0) + 1);
    degree.set(e.to, (degree.get(e.to) || 0) + 1);
  }
  const index = new Map(nodes.map((n, i) => [n.id, i]));

  // Edges
  const edgeGroup = document.createElementNS(SVG_NS, "g");
  for (const edge of edges) {
    const a = positions[index.get(edge.from)];
    const b = positions[index.get(edge.to)];
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", a.x.toFixed(1));
    line.setAttribute("y1", a.y.toFixed(1));
    line.setAttribute("x2", b.x.toFixed(1));
    line.setAttribute("y2", b.y.toFixed(1));
    line.setAttribute("stroke", "rgba(13, 245, 227, 0.22)");
    line.setAttribute("stroke-width", "1");
    edgeGroup.appendChild(line);
  }
  svg.appendChild(edgeGroup);

  // Nodes + labels
  const nodeGroup = document.createElementNS(SVG_NS, "g");
  nodes.forEach((node, i) => {
    const p = positions[i];
    const g = document.createElementNS(SVG_NS, "g");
    g.style.cursor = "pointer";

    const r = 5 + Math.min(7, (degree.get(node.id) || 0) * 1.2);
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", p.x.toFixed(1));
    circle.setAttribute("cy", p.y.toFixed(1));
    circle.setAttribute("r", String(r));
    circle.setAttribute("fill", colorForType(node.type));
    circle.setAttribute("fill-opacity", "0.85");
    circle.setAttribute("stroke", "rgba(0,0,0,0.6)");
    circle.setAttribute("stroke-width", "1");
    g.appendChild(circle);

    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", (p.x + r + 4).toFixed(1));
    label.setAttribute("y", (p.y + 3.5).toFixed(1));
    label.setAttribute("fill", "#c9d4de");
    label.setAttribute("font-size", "9");
    // Labels must never steal clicks aimed at neighboring node circles.
    label.setAttribute("pointer-events", "none");
    const title = String(node.title || node.id);
    label.textContent = title.length > 24 ? `${title.slice(0, 23)}…` : title;
    g.appendChild(label);

    g.addEventListener("click", (event) => {
      event.stopPropagation();
      showNodeCard(root, node, edges, degree.get(node.id) || 0);
    });
    nodeGroup.appendChild(g);
  });
  svg.appendChild(nodeGroup);

  setupViewport(root, svg, W, H);
}

function showNodeCard(root, node, edges, degreeCount) {
  const card = root.querySelector("#cx-node-card");
  const title = root.querySelector("#cx-node-card-title");
  const meta = root.querySelector("#cx-node-card-meta");
  const links = root.querySelector("#cx-node-card-links");
  if (!card || !title || !meta || !links) return;

  title.textContent = node.title || node.id;
  const linkCount =
    degreeCount === 1
      ? t("views.cortex.linkCountOne", { n: degreeCount }, "{n} link")
      : t("views.cortex.linkCountMany", { n: degreeCount }, "{n} links");
  meta.textContent = t(
    "views.cortex.nodeMeta",
    { type: node.type || "page", id: node.id, links: linkCount },
    "type: {type} · id: {id} · {links}",
  );

  clearChildren(links);
  const neighbors = [];
  for (const e of edges) {
    if (e.from === node.id) neighbors.push({ other: e.to, kind: e.kind, dir: "→" });
    else if (e.to === node.id) neighbors.push({ other: e.from, kind: e.kind, dir: "←" });
  }
  if (neighbors.length === 0) {
    links.appendChild(el("div", null, t("views.cortex.noLinks", {}, "No links to other pages.")));
  } else {
    for (const n of neighbors.slice(0, 12)) {
      const row = el("div");
      row.append(`${n.dir} `);
      row.appendChild(el("span", null, n.other));
      row.append(` (${n.kind || "link"})`);
      links.appendChild(row);
    }
    if (neighbors.length > 12) {
      links.appendChild(
        el(
          "div",
          null,
          t("views.cortex.andMore", { count: neighbors.length - 12 }, "…and {count} more"),
        ),
      );
    }
  }
  card.classList.add("visible");
}

/** Pan via viewBox drag; zoom via buttons. */
function setupViewport(root, svg, width, height) {
  const view = { x: 0, y: 0, w: width, h: height };
  const apply = () => {
    svg.setAttribute(
      "viewBox",
      `${view.x.toFixed(1)} ${view.y.toFixed(1)} ${view.w.toFixed(1)} ${view.h.toFixed(1)}`,
    );
  };
  apply();

  // Pan starts only after the pointer moves a few pixels — capturing on
  // pointerdown would retarget the subsequent click and break node selection.
  let armed = false;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  svg.addEventListener("pointerdown", (event) => {
    armed = true;
    lastX = event.clientX;
    lastY = event.clientY;
  });
  svg.addEventListener("pointermove", (event) => {
    if (!armed) return;
    if (!dragging) {
      if (Math.abs(event.clientX - lastX) + Math.abs(event.clientY - lastY) < 4) return;
      dragging = true;
      svg.classList.add("panning");
      svg.setPointerCapture(event.pointerId);
    }
    const rect = svg.getBoundingClientRect();
    view.x -= ((event.clientX - lastX) / rect.width) * view.w;
    view.y -= ((event.clientY - lastY) / rect.height) * view.h;
    lastX = event.clientX;
    lastY = event.clientY;
    apply();
  });
  const endDrag = () => {
    armed = false;
    dragging = false;
    svg.classList.remove("panning");
  };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);

  const zoom = (factor) => {
    const cx = view.x + view.w / 2;
    const cy = view.y + view.h / 2;
    view.w = Math.max(80, Math.min(width * 4, view.w * factor));
    view.h = Math.max(50, Math.min(height * 4, view.h * factor));
    view.x = cx - view.w / 2;
    view.y = cy - view.h / 2;
    apply();
  };
  root.querySelector("#cx-zoom-in")?.addEventListener("click", () => zoom(0.75));
  root.querySelector("#cx-zoom-out")?.addEventListener("click", () => zoom(1.33));
  root.querySelector("#cx-zoom-reset")?.addEventListener("click", () => {
    view.x = 0;
    view.y = 0;
    view.w = width;
    view.h = height;
    apply();
  });
}

function showGraphOffline(root, reason) {
  const wrap = root.querySelector("#cx-graph-wrap");
  const foot = root.querySelector(".cx-graph-foot");
  const offline = root.querySelector("#cx-graph-offline");
  if (wrap) wrap.style.display = "none";
  if (foot) foot.style.display = "none";
  if (!offline) return;
  offline.style.display = "";
  clearChildren(offline);
  offline.appendChild(
    buildOfflineBlock(
      "🕸️",
      t("views.cortex.graphOfflineTitle", {}, "Knowledge graph offline"),
      reason || t("views.cortex.graphOfflineReason", {}, "gbrain adapter unavailable"),
      t(
        "views.cortex.graphOfflineHelp",
        {},
        "The graph is built from the gbrain knowledge-graph CLI. It renders here automatically as soon as gbrain is healthy on this host — no dashboard changes needed.",
      ),
    ),
  );
}

async function loadGraph(root, gbrainState) {
  if (!gbrainState?.available) {
    showGraphOffline(root, gbrainState?.reason);
    return;
  }
  try {
    const graph = await fetchJson(`${API_BASE}/graph`);
    renderGraph(root, graph || { nodes: [], edges: [] });
    // Clicking empty space closes the node card.
    root.querySelector("#cx-graph-svg")?.addEventListener("click", () => {
      root.querySelector("#cx-node-card")?.classList.remove("visible");
    });
    root.querySelector("#cx-node-card-close")?.addEventListener("click", () => {
      root.querySelector("#cx-node-card")?.classList.remove("visible");
    });
  } catch (error) {
    if (error.name !== "AbortError") showGraphOffline(root, error.message);
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function init(container) {
  // Idempotency: cancel anything left over from a previous visit.
  if (abortController) abortController.abort();
  abortController = new AbortController();
  clearTimeout(searchTimer);

  const root = container.querySelector("#cortex-view-section");
  if (!root) return;

  fetchJson(API_BASE)
    .then((state) => {
      renderAvailability(root, state);
      renderGauges(root, state.gauges);
      setupMemoryBrowser(root, state.memory);
      loadGraph(root, state.gbrain);
    })
    .catch((error) => {
      if (error.name === "AbortError") return;
      const gauges = root.querySelector("#cx-gauges");
      if (gauges) {
        clearChildren(gauges);
        gauges.appendChild(
          el(
            "div",
            "cx-empty",
            t(
              "views.cortex.loadError",
              { message: error.message },
              "Failed to load Cortex state: {message}",
            ),
          ),
        );
      }
      setupMemoryBrowser(root, { available: false, reason: error.message });
      showGraphOffline(root, error.message);
    });
}
