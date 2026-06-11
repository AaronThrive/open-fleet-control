/**
 * Shared details-list component — the v2.1 replacement for card grids.
 *
 * Dense, sortable, filterable table rows with an expandable per-row detail
 * panel. All cell content is rendered via textContent (or caller-built DOM
 * nodes), never innerHTML with untrusted strings.
 *
 * Usage (zero-build browser ESM):
 *   import { createDetailList } from "/js/components/detail-list.js";
 *   const list = createDetailList(containerEl, {
 *     columns: [
 *       { key: "name", label: "Name", sortable: true },
 *       { key: "status", label: "Status", sortable: true,
 *         render: (row) => el("span", "badge", row.status) },
 *     ],
 *     getRowId: (row) => row.id,
 *     renderDetail: (row) => node,        // expanded panel content
 *     renderActions: (row) => node|null,  // optional trailing actions cell
 *     emptyText: "Nothing here yet.",
 *     filterKeys: ["name", "status"],     // keys searched by the filter box
 *     defaultSort: { key: "name", dir: "asc" },
 *   });
 *   list.update(rows);   // re-render with new data (preserves sort/filter/open rows)
 *   list.destroy();
 *
 * Pure helpers (sortRows/filterRows) are exported for node:test coverage.
 */

const STYLE_ID = "detail-list-styles";

const CSS = `
.dl-wrap { display: flex; flex-direction: column; gap: 8px; }
.dl-toolbar { display: flex; align-items: center; gap: 8px; }
.dl-filter {
  flex: 0 1 260px; padding: 5px 10px; font-size: 0.78rem;
  background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 6px;
}
.dl-count { font-size: 0.72rem; color: var(--text-muted); white-space: nowrap; }
.dl-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
.dl-table th {
  text-align: left; padding: 6px 10px; font-size: 0.68rem; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted);
  border-bottom: 1px solid var(--border); white-space: nowrap; user-select: none;
}
.dl-table th.dl-sortable { cursor: pointer; }
.dl-table th.dl-sortable:hover { color: var(--text); }
.dl-sort-arrow { font-size: 0.6rem; margin-left: 3px; }
.dl-row { cursor: pointer; }
.dl-row td {
  padding: 6px 10px; border-bottom: 1px solid var(--border);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px;
}
.dl-row:hover td { background: rgba(255, 255, 255, 0.025); }
.dl-row.dl-open td { background: rgba(88, 166, 255, 0.06); }
.dl-row:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.dl-detail-row td {
  padding: 10px 14px; border-bottom: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.02); white-space: normal;
}
.dl-empty { padding: 14px; font-size: 0.78rem; color: var(--text-muted); }
.dl-actions-cell { text-align: right; white-space: nowrap; }
`;

function ensureStyles() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** Stable sort by column key. Numbers sort numerically, everything else as string. */
export function sortRows(rows, sort) {
  if (!sort || !sort.key) return [...rows];
  const dir = sort.dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = a[sort.key];
    const bv = b[sort.key];
    if (av === bv) return 0;
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
  });
}

/** Case-insensitive substring filter across the given keys. */
export function filterRows(rows, query, filterKeys) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return [...rows];
  const keys = filterKeys && filterKeys.length ? filterKeys : null;
  return rows.filter((row) => {
    const haystack = keys ? keys.map((k) => row[k]) : Object.values(row);
    return haystack.some(
      (v) => v !== null && v !== undefined && String(v).toLowerCase().includes(q),
    );
  });
}

export function createDetailList(container, options) {
  const {
    columns,
    getRowId,
    renderDetail,
    renderActions,
    emptyText = "Nothing here yet.",
    filterKeys,
    filterPlaceholder = "Filter…",
    defaultSort = null,
    showFilter = true,
  } = options;

  ensureStyles();

  let rows = [];
  let sort = defaultSort ? { ...defaultSort } : null;
  let query = "";
  const openIds = new Set();

  const wrap = document.createElement("div");
  wrap.className = "dl-wrap";

  const toolbar = document.createElement("div");
  toolbar.className = "dl-toolbar";
  const filterInput = document.createElement("input");
  filterInput.className = "dl-filter";
  filterInput.type = "search";
  filterInput.placeholder = filterPlaceholder;
  filterInput.addEventListener("input", () => {
    query = filterInput.value;
    renderBody();
  });
  const count = document.createElement("span");
  count.className = "dl-count";
  if (showFilter) toolbar.append(filterInput, count);

  const table = document.createElement("table");
  table.className = "dl-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const col of columns) {
    const th = document.createElement("th");
    th.textContent = col.label;
    if (col.sortable) {
      th.classList.add("dl-sortable");
      const arrow = document.createElement("span");
      arrow.className = "dl-sort-arrow";
      th.appendChild(arrow);
      th.addEventListener("click", () => {
        if (sort && sort.key === col.key) {
          sort = { key: col.key, dir: sort.dir === "asc" ? "desc" : "asc" };
        } else {
          sort = { key: col.key, dir: "asc" };
        }
        renderHead();
        renderBody();
      });
    }
    headRow.appendChild(th);
  }
  if (renderActions) {
    const th = document.createElement("th");
    th.textContent = "";
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  const tbody = document.createElement("tbody");
  table.append(thead, tbody);

  const empty = document.createElement("div");
  empty.className = "dl-empty";
  empty.textContent = emptyText;
  empty.hidden = true;

  wrap.append(toolbar, table, empty);
  container.appendChild(wrap);

  function renderHead() {
    const ths = headRow.querySelectorAll("th.dl-sortable");
    let i = 0;
    for (const col of columns) {
      if (!col.sortable) continue;
      const arrow = ths[i++].querySelector(".dl-sort-arrow");
      arrow.textContent = sort && sort.key === col.key ? (sort.dir === "asc" ? "▲" : "▼") : "";
    }
  }

  function toggleRow(id, tr, row) {
    const detailRow = tr.nextElementSibling;
    const isDetail = detailRow && detailRow.classList.contains("dl-detail-row");
    if (openIds.has(id)) {
      openIds.delete(id);
      tr.classList.remove("dl-open");
      tr.setAttribute("aria-expanded", "false");
      if (isDetail) detailRow.remove();
    } else {
      openIds.add(id);
      tr.classList.add("dl-open");
      tr.setAttribute("aria-expanded", "true");
      if (renderDetail && !isDetail) {
        const dr = document.createElement("tr");
        dr.className = "dl-detail-row";
        const td = document.createElement("td");
        td.colSpan = columns.length + (renderActions ? 1 : 0);
        const content = renderDetail(row);
        if (content) td.appendChild(content);
        dr.appendChild(td);
        tr.after(dr);
      }
    }
  }

  function renderBody() {
    tbody.replaceChildren();
    const visible = sortRows(filterRows(rows, query, filterKeys), sort);
    count.textContent = query
      ? `${visible.length} of ${rows.length}`
      : `${rows.length} item${rows.length === 1 ? "" : "s"}`;
    empty.hidden = visible.length > 0;
    table.hidden = visible.length === 0;

    for (const row of visible) {
      const id = getRowId(row);
      const tr = document.createElement("tr");
      tr.className = "dl-row";
      tr.tabIndex = 0;
      tr.setAttribute("aria-expanded", openIds.has(id) ? "true" : "false");
      for (const col of columns) {
        const td = document.createElement("td");
        if (col.render) {
          const node = col.render(row);
          if (node) td.appendChild(node);
        } else {
          const v = row[col.key];
          td.textContent = v === null || v === undefined ? "—" : String(v);
        }
        tr.appendChild(td);
      }
      if (renderActions) {
        const td = document.createElement("td");
        td.className = "dl-actions-cell";
        const node = renderActions(row);
        if (node) td.appendChild(node);
        // Clicks on action buttons must not toggle the detail panel.
        td.addEventListener("click", (e) => e.stopPropagation());
        tr.appendChild(td);
      }
      tr.addEventListener("click", () => toggleRow(id, tr, row));
      tr.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleRow(id, tr, row);
        }
      });
      tbody.appendChild(tr);
      if (openIds.has(id) && renderDetail) {
        tr.classList.add("dl-open");
        const dr = document.createElement("tr");
        dr.className = "dl-detail-row";
        const td = document.createElement("td");
        td.colSpan = columns.length + (renderActions ? 1 : 0);
        const content = renderDetail(row);
        if (content) td.appendChild(content);
        dr.appendChild(td);
        tbody.appendChild(dr);
      }
    }
  }

  renderHead();
  renderBody();

  return {
    update(nextRows) {
      rows = Array.isArray(nextRows) ? nextRows : [];
      // Drop open state for rows that disappeared.
      const ids = new Set(rows.map((r) => getRowId(r)));
      for (const id of [...openIds]) if (!ids.has(id)) openIds.delete(id);
      renderBody();
    },
    destroy() {
      wrap.remove();
    },
  };
}
