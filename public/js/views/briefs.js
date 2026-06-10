/**
 * Briefs panel — two-pane markdown SOP editor over /api/fleet/briefs.
 *
 * Loaded by views.js, which calls `init(containerEl)` on EVERY visit with a
 * freshly injected copy of /partials/briefs.html. All state and listeners
 * are scoped to that fresh DOM, so re-running init is naturally idempotent.
 *
 * Preview uses a small, safe markdown renderer defined below: all input is
 * HTML-escaped first, then markdown transforms only insert tags generated
 * here — raw HTML in brief content is never passed through.
 */

import { t } from "../utils.js";

const BRIEF_NAME_RE = /^[a-zA-Z0-9._-]+\.md$/;
const TOAST_MS = 4000;

// ---------------------------------------------------------------------------
// Safe markdown renderer (escape everything first, then transform)
// ---------------------------------------------------------------------------

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Inline transforms on already-escaped text: code, links, bold, italic. */
function renderInline(text) {
  const codeSpans = [];
  let out = text.replace(/`([^`]+)`/g, (_m, code) => {
    codeSpans.push(`<code>${code}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
    // Only http(s) links; the URL is already entity-escaped so it cannot
    // break out of the quoted attribute.
    if (!/^https?:\/\//i.test(url)) return match;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  out = out.replace(/(^|\s)_([^_]+)_(?=\s|$|[.,;:!?])/g, "$1<em>$2</em>");
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => codeSpans[Number(i)]);
}

const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BLOCK_START_RE = /^(#{1,6}[ \t]|```|\s*[-*+][ \t]|\s*\d+\.[ \t]|&gt;)/;

/** Block-level markdown renderer. Input is raw text; output is safe HTML. */
function renderMarkdown(source) {
  const lines = escapeHtml(source.replace(/\r\n?/g, "\n")).split("\n");
  const html = [];
  let listType = null;
  let inQuote = false;

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };
  const closeQuote = () => {
    if (inQuote) {
      html.push("</blockquote>");
      inQuote = false;
    }
  };
  const openList = (type) => {
    if (listType !== type) {
      closeList();
      html.push(`<${type}>`);
      listType = type;
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      closeList();
      closeQuote();
      const buffer = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        buffer.push(lines[i]);
        i += 1;
      }
      i += 1; // skip closing fence (or EOF)
      html.push(`<pre><code>${buffer.join("\n")}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})[ \t]+(.*)$/);
    if (heading) {
      closeList();
      closeQuote();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      closeList();
      closeQuote();
      html.push("<hr>");
      i += 1;
      continue;
    }

    const quote = line.match(/^&gt;[ \t]?(.*)$/);
    if (quote) {
      closeList();
      if (!inQuote) {
        html.push("<blockquote>");
        inQuote = true;
      }
      html.push(`<p>${renderInline(quote[1])}</p>`);
      i += 1;
      continue;
    }

    const unordered = line.match(/^\s*[-*+][ \t]+(.*)$/);
    if (unordered) {
      closeQuote();
      openList("ul");
      html.push(`<li>${renderInline(unordered[1])}</li>`);
      i += 1;
      continue;
    }

    const ordered = line.match(/^\s*\d+\.[ \t]+(.*)$/);
    if (ordered) {
      closeQuote();
      openList("ol");
      html.push(`<li>${renderInline(ordered[1])}</li>`);
      i += 1;
      continue;
    }

    if (line.trim() === "") {
      closeList();
      closeQuote();
      i += 1;
      continue;
    }

    // Paragraph: merge consecutive plain lines.
    closeList();
    closeQuote();
    const buffer = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !BLOCK_START_RE.test(lines[i]) &&
      !HR_RE.test(lines[i])
    ) {
      buffer.push(lines[i]);
      i += 1;
    }
    html.push(`<p>${renderInline(buffer.join(" "))}</p>`);
  }
  closeList();
  closeQuote();
  return html.join("\n");
}

// ---------------------------------------------------------------------------
// API helpers — errors surface the server's { error } message
// ---------------------------------------------------------------------------

async function apiRequest(path, options) {
  let response;
  try {
    response = await fetch(path, options);
  } catch (err) {
    throw new Error(t("views.briefs.networkError", {}, "Network error — is the server running?"));
  }
  let data = null;
  try {
    data = await response.json();
  } catch (err) {
    // Non-JSON body; fall through to the status check.
  }
  if (!response.ok) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data;
}

const fetchBriefList = async () => (await apiRequest("/api/fleet/briefs"))?.briefs || [];
const fetchBrief = (name) => apiRequest(`/api/fleet/briefs/${encodeURIComponent(name)}`);
const saveBrief = (name, content) =>
  apiRequest(`/api/fleet/briefs/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
const deleteBrief = (name) =>
  apiRequest(`/api/fleet/briefs/${encodeURIComponent(name)}`, { method: "DELETE" });

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatUpdated(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Validate + normalize a user-supplied filename; returns name or null. */
function normalizeBriefName(rawInput) {
  let name = (rawInput || "").trim();
  if (!name) return null;
  if (!name.toLowerCase().endsWith(".md")) name += ".md";
  if (name.startsWith(".") || !BRIEF_NAME_RE.test(name)) return null;
  return name;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function init(container) {
  const $ = (id) => container.querySelector(`#${id}`);
  const els = {
    emptyState: $("briefs-empty-state"),
    emptyCta: $("briefs-empty-cta"),
    layout: $("briefs-layout"),
    newBtn: $("briefs-new-btn"),
    list: $("briefs-list"),
    placeholder: $("briefs-editor-placeholder"),
    editor: $("briefs-editor"),
    filename: $("briefs-editor-filename"),
    dirtyDot: $("briefs-dirty-dot"),
    modeEdit: $("briefs-mode-edit"),
    modePreview: $("briefs-mode-preview"),
    saveBtn: $("briefs-save-btn"),
    deleteBtn: $("briefs-delete-btn"),
    textarea: $("briefs-textarea"),
    preview: $("briefs-preview"),
    toasts: $("briefs-toasts"),
  };
  if (!els.layout || !els.list || !els.textarea) return;

  const state = {
    briefs: [],
    activeName: null,
    dirty: false,
    mode: "edit",
    busy: false,
    loadToken: 0,
  };

  function toast(message, kind = "info") {
    const node = document.createElement("div");
    node.className = `briefs-toast${kind === "error" ? " error" : ""}`;
    node.textContent = message;
    els.toasts.appendChild(node);
    setTimeout(() => node.remove(), TOAST_MS);
  }

  function setDirty(dirty) {
    state.dirty = dirty;
    els.dirtyDot.hidden = !dirty;
    els.saveBtn.disabled = !dirty || state.busy;
  }

  function confirmDiscard() {
    return (
      !state.dirty ||
      window.confirm(
        t("views.briefs.confirmDiscard", {}, "You have unsaved changes. Discard them?"),
      )
    );
  }

  function renderList() {
    els.emptyState.style.display = state.briefs.length === 0 ? "" : "none";
    els.layout.hidden = state.briefs.length === 0;

    els.list.textContent = "";
    for (const brief of state.briefs) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "briefs-list-item";
      if (brief.name === state.activeName) item.classList.add("active");

      const name = document.createElement("span");
      name.className = "briefs-item-name";
      name.textContent = brief.name;
      item.appendChild(name);

      if (brief.firstHeading) {
        const heading = document.createElement("span");
        heading.className = "briefs-item-heading";
        heading.textContent = brief.firstHeading;
        item.appendChild(heading);
      }

      const meta = document.createElement("span");
      meta.className = "briefs-item-meta";
      meta.textContent = [formatUpdated(brief.updatedAt), formatSize(brief.size)]
        .filter(Boolean)
        .join(" · ");
      item.appendChild(meta);

      item.addEventListener("click", () => selectBrief(brief.name));
      els.list.appendChild(item);
    }
  }

  function setMode(mode) {
    state.mode = mode;
    els.modeEdit.classList.toggle("active", mode === "edit");
    els.modePreview.classList.toggle("active", mode === "preview");
    els.textarea.hidden = mode !== "edit";
    els.preview.hidden = mode !== "preview";
    if (mode === "preview") {
      els.preview.innerHTML = renderMarkdown(els.textarea.value);
    }
  }

  function showEditor(name, content) {
    state.activeName = name;
    els.placeholder.style.display = "none";
    els.editor.hidden = false;
    els.filename.textContent = name;
    els.textarea.value = content;
    setDirty(false);
    setMode("edit");
    renderList();
  }

  function closeEditor() {
    state.activeName = null;
    els.editor.hidden = true;
    els.placeholder.style.display = "";
    setDirty(false);
    renderList();
  }

  async function refreshList() {
    try {
      state.briefs = await fetchBriefList();
      if (state.activeName && !state.briefs.some((b) => b.name === state.activeName)) {
        closeEditor();
        return;
      }
      renderList();
    } catch (err) {
      toast(
        t("views.briefs.listFailed", { message: err.message }, "Failed to load briefs: {message}"),
        "error",
      );
    }
  }

  async function selectBrief(name) {
    if (name === state.activeName) return;
    if (!confirmDiscard()) return;
    const token = ++state.loadToken;
    try {
      const brief = await fetchBrief(name);
      if (token !== state.loadToken) return; // stale response
      showEditor(brief.name, brief.content);
    } catch (err) {
      toast(
        t(
          "views.briefs.openFailed",
          { name, message: err.message },
          'Failed to open "{name}": {message}',
        ),
        "error",
      );
    }
  }

  async function handleSave() {
    if (!state.activeName || !state.dirty || state.busy) return;
    state.busy = true;
    els.saveBtn.disabled = true;
    try {
      await saveBrief(state.activeName, els.textarea.value);
      setDirty(false);
      toast(t("views.briefs.saved", { name: state.activeName }, 'Saved "{name}"'));
      await refreshList();
    } catch (err) {
      toast(
        t("views.briefs.saveFailed", { message: err.message }, "Save failed: {message}"),
        "error",
      );
    } finally {
      state.busy = false;
      els.saveBtn.disabled = !state.dirty;
    }
  }

  async function handleDelete() {
    const name = state.activeName;
    if (!name || state.busy) return;
    const confirmText = t(
      "views.briefs.confirmDelete",
      { name },
      'Delete "{name}"? This cannot be undone.',
    );
    if (!window.confirm(confirmText)) return;
    state.busy = true;
    try {
      await deleteBrief(name);
      toast(t("views.briefs.deleted", { name }, 'Deleted "{name}"'));
      closeEditor();
      await refreshList();
    } catch (err) {
      toast(
        t("views.briefs.deleteFailed", { message: err.message }, "Delete failed: {message}"),
        "error",
      );
    } finally {
      state.busy = false;
    }
  }

  async function handleNewBrief() {
    if (!confirmDiscard()) return;
    const rawInput = window.prompt(
      t(
        "views.briefs.newPrompt",
        {},
        "New brief filename (letters, digits, dot, underscore, dash; .md is appended):",
      ),
    );
    if (rawInput === null) return;
    const name = normalizeBriefName(rawInput);
    if (!name) {
      toast(
        t(
          "views.briefs.invalidName",
          {},
          "Invalid name: only letters, digits, '.', '_', '-' are allowed, and it must not start with '.'",
        ),
        "error",
      );
      return;
    }
    if (state.briefs.some((b) => b.name === name)) {
      toast(
        t("views.briefs.alreadyExists", { name }, '"{name}" already exists — opening it instead'),
        "error",
      );
      state.dirty = false; // already confirmed discard above
      await selectBrief(name);
      return;
    }
    const title = name.replace(/\.md$/i, "").replace(/[-_]+/g, " ");
    try {
      await saveBrief(name, `# ${title}\n\n`);
      toast(t("views.briefs.created", { name }, 'Created "{name}"'));
      state.dirty = false;
      await refreshList();
      state.activeName = null; // force selectBrief to load it
      await selectBrief(name);
    } catch (err) {
      toast(
        t("views.briefs.createFailed", { message: err.message }, "Create failed: {message}"),
        "error",
      );
    }
  }

  // --- Wire events (fresh DOM each visit, so no stale listeners) -----------
  els.newBtn.addEventListener("click", handleNewBrief);
  if (els.emptyCta) els.emptyCta.addEventListener("click", handleNewBrief);
  els.saveBtn.addEventListener("click", handleSave);
  els.deleteBtn.addEventListener("click", handleDelete);
  els.modeEdit.addEventListener("click", () => setMode("edit"));
  els.modePreview.addEventListener("click", () => setMode("preview"));
  els.textarea.addEventListener("input", () => setDirty(true));
  container.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      handleSave();
    }
  });

  // --- Initial load ---------------------------------------------------------
  setDirty(false);
  refreshList();
}
