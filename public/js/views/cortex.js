/**
 * Cortex view — compression fuel gauges + read-only gbrain memory browser.
 *
 * Loaded by views.js via dynamic import; init(container) re-runs on every
 * visit, so all state is rebuilt from scratch (idempotent). All dynamic
 * content is rendered with createElement/textContent — never innerHTML with
 * server data.
 */

import { t } from "../utils.js";
import { createDetailList } from "../components/detail-list.js";

const API_BASE = "/api/fleet/cortex";
// gbrain pages: pull a large page so the browser lists everything. The list
// scrolls (max-height on .cx-mem-list) rather than capping at a small number.
const MEMORY_LIST_LIMIT = 1000;
const MEMORY_CELL_PREVIEW_CHARS = 110;
const SEARCH_DEBOUNCE_MS = 300;

// Module-scope handles cleaned up on every init (the DOM itself is replaced
// by the view loader, so listeners die with it — only timers/aborts persist).
let abortController = null;
let searchTimer = null;
// Shared detail-list instance for the memory browser (rebuilt on every init).
let memoryList = null;

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

/**
 * Local "Jun 1, 21:04" for an ISO or sqlite ("YYYY-MM-DD HH:MM:SS", UTC)
 * timestamp; falls back to the raw string when unparseable.
 */
function formatWhen(value) {
  if (!value) return "";
  const normalized =
    typeof value === "string" && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) return String(value);
  return new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Coerce an ISO/sqlite/epoch timestamp to epoch-ms (or null). */
function toEpochMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized =
    typeof value === "string" && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
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
/* Engine gauge cards                                                  */
/*                                                                     */
/* The sources are SEPARATE tools, not readings of one compressor, so  */
/* each gets a purpose-built card instead of a one-size-fits-all       */
/* "% saved" bar:                                                      */
/*   lean-ctx     → command output throughput                          */
/*   lossless-claw→ transcript compaction (may be idle/historical)     */
/* ------------------------------------------------------------------ */

function buildBadge(text, kind) {
  return el("span", `cx-badge ${kind}`, text);
}

/** Card shell with a title row; per-engine bodies are appended by callers. */
function buildEngineCardShell(gauge, title, badges) {
  const card = el("div", `cx-gauge ${gauge.available ? "available" : "unavailable"}`);
  const top = el("div", "cx-gauge-top");
  const label = el("div", "cx-gauge-label", title);
  label.title = title;
  top.appendChild(label);
  for (const badge of badges) if (badge) top.appendChild(badge);
  card.appendChild(top);
  return card;
}

/** Two-column key/value grid for token breakdowns. */
function buildKvGrid(pairs) {
  const grid = el("div", "cx-kv");
  for (const [label, value] of pairs) {
    const cell = el("span");
    cell.append(`${label} `);
    cell.appendChild(el("b", null, value));
    grid.appendChild(cell);
  }
  return grid;
}

function appendUnavailableBody(card, gauge) {
  const reason =
    gauge.detail?.error ||
    t("views.cortex.sourceUnavailable", {}, "source not available on this host");
  card.appendChild(el("div", "cx-gauge-reason", reason));
  return card;
}

/**
 * lean-ctx = CLI output throughput. stats.json records totals only; genuine
 * before/after sizes exist only in the cep block — show a savings % ONLY
 * when that block has data, never a fabricated 0%.
 */
function buildLeanCtxCard(gauge, activeEngine) {
  const badges = [];
  if (activeEngine === "lean-ctx") {
    badges.push(buildBadge(t("views.cortex.badgeActiveEngine", {}, "active engine"), "live"));
  }
  const card = buildEngineCardShell(
    gauge,
    t("views.cortex.lcCardTitle", {}, "lean-ctx · command throughput"),
    badges,
  );
  if (!gauge.available) return appendUnavailableBody(card, gauge);
  const d = gauge.detail || {};

  const big = el("div", "cx-stat-big", String(d.totalCommands ?? 0));
  big.appendChild(el("small", null, t("views.cortex.lcCommands", {}, "commands processed")));
  card.appendChild(big);

  card.appendChild(
    buildKvGrid([
      [t("views.cortex.lcTokens", {}, "tokens through"), formatTokens(d.tokensProcessed)],
      [t("views.cortex.lcDays", {}, "days tracked"), String(d.daysTracked ?? 0)],
    ]),
  );

  const top = Array.isArray(d.topCommands) ? d.topCommands.slice(0, 3) : [];
  if (top.length > 0) {
    const list = el("div", "cx-top-cmds");
    for (const entry of top) {
      const row = el("div");
      row.appendChild(el("span", "cmd", entry.command));
      row.append(` — ${formatTokens(entry.tokens)}`);
      list.appendChild(row);
    }
    card.appendChild(list);
  }

  if (gauge.savingsPct !== null && gauge.savingsPct !== undefined && d.savingsSource === "cep") {
    card.appendChild(
      el(
        "div",
        "cx-eng-line accent",
        t(
          "views.cortex.lcSavings",
          {
            pct: gauge.savingsPct,
            raw: formatTokens(gauge.rawTokens),
            effective: formatTokens(gauge.effectiveTokens),
          },
          "session compression: {pct}% saved ({raw} → {effective} tokens)",
        ),
      ),
    );
  } else {
    card.appendChild(
      el(
        "div",
        "cx-eng-line",
        t(
          "views.cortex.lcNoSavings",
          {},
          "no savings % — stats.json records totals only, no before/after sizes yet",
        ),
      ),
    );
  }

  if (d.lastUse) {
    const ms = Date.parse(d.lastUse);
    if (Number.isFinite(ms)) {
      card.appendChild(
        el(
          "div",
          "cx-eng-line",
          t("views.cortex.lcLastUse", { when: relativeTime(ms) }, "last used {when}"),
        ),
      );
    }
  }
  return card;
}

/**
 * lossless-claw = transcript compaction. The engine may be installed but
 * idle (another engine holds the contextEngine slot) — when the newest
 * summary is old, badge the card "historical" and say so.
 */
function buildLcmCard(gauge, activeEngine) {
  const d = gauge.detail || {};
  const badges = [];
  if (activeEngine === "lossless-claw") {
    badges.push(buildBadge(t("views.cortex.badgeActiveEngine", {}, "active engine"), "live"));
  }
  if (gauge.available && d.stale === true) {
    badges.push(buildBadge(t("views.cortex.badgeHistorical", {}, "historical"), "hist"));
  }
  const card = buildEngineCardShell(
    gauge,
    t("views.cortex.lcmCardTitle", {}, "lossless-claw · transcript compaction"),
    badges,
  );
  if (!gauge.available) return appendUnavailableBody(card, gauge);

  if (gauge.savingsPct !== null && gauge.savingsPct !== undefined) {
    const big = el("div", "cx-stat-big", `${gauge.savingsPct}%`);
    big.appendChild(el("small", null, t("views.cortex.savedLabel", {}, "saved")));
    card.appendChild(big);
  }
  card.appendChild(
    buildKvGrid([
      [t("views.cortex.lcmSummaries", {}, "summaries"), String(d.summaries ?? 0)],
      [t("views.cortex.lcmMessages", {}, "source messages"), String(d.messages ?? 0)],
      [t("views.cortex.rawLabel", {}, "raw"), formatTokens(gauge.rawTokens)],
      [t("views.cortex.effectiveLabel", {}, "effective"), formatTokens(gauge.effectiveTokens)],
    ]),
  );

  if (d.stale === true) {
    card.appendChild(
      el(
        "div",
        "cx-eng-line warn",
        t(
          "views.cortex.lcmStaleMsg",
          { when: formatWhen(d.lastActivity) || "?" },
          "no compaction since {when} — engine idle, numbers are historical",
        ),
      ),
    );
  } else if (d.lastActivity) {
    card.appendChild(
      el(
        "div",
        "cx-eng-line",
        t(
          "views.cortex.lcmLastActivity",
          { when: formatWhen(d.lastActivity) },
          "last compaction {when}",
        ),
      ),
    );
  }
  if (d.note) card.appendChild(el("div", "cx-eng-line", d.note));
  return card;
}

/** Fallback for unknown future sources: scalar detail key/values. */
function buildGenericGaugeCard(gauge) {
  const card = buildEngineCardShell(gauge, gauge.label || gauge.source, []);
  if (!gauge.available) return appendUnavailableBody(card, gauge);
  if (gauge.savingsPct !== null && gauge.savingsPct !== undefined) {
    const big = el("div", "cx-stat-big", `${gauge.savingsPct}%`);
    big.appendChild(el("small", null, t("views.cortex.savedLabel", {}, "saved")));
    card.appendChild(big);
  }
  const detailText = Object.entries(gauge.detail || {})
    .filter(([, v]) => v !== null && typeof v !== "object")
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
  if (detailText) card.appendChild(el("div", "cx-eng-line", detailText));
  return card;
}

const ENGINE_CARD_BUILDERS = {
  "lean-ctx": buildLeanCtxCard,
  lcm: buildLcmCard,
};

/**
 * "Working in conjunction" strip: exactly one engine owns the OpenClaw
 * contextEngine slot; the other gauges are complementary tools. Saying this
 * explicitly is what makes the different cards legible together.
 */
function renderEngineStrip(root, contextEngine) {
  const host = root.querySelector("#cx-engine-strip");
  if (!host) return;
  clearChildren(host);
  host.style.display = "";
  host.append(t("views.cortex.engineStripLabel", {}, "Active context engine:"));
  if (contextEngine?.engine) {
    host.appendChild(el("b", null, contextEngine.engine));
    host.appendChild(
      el(
        "span",
        null,
        t(
          "views.cortex.engineStripNote",
          {},
          "— one engine shapes live context; the others are separate tools (lean-ctx compresses command output, lossless-claw compacts transcripts) and sit idle unless they hold the slot.",
        ),
      ),
    );
  } else {
    host.appendChild(
      el(
        "span",
        null,
        t(
          "views.cortex.engineStripUnknown",
          { message: contextEngine?.reason || "no engine configured" },
          "unknown — {message}",
        ),
      ),
    );
  }
}

function renderGauges(root, gauges, contextEngine) {
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
  const activeEngine = contextEngine?.engine || null;
  for (const gauge of list) {
    const builder = ENGINE_CARD_BUILDERS[gauge.source] || buildGenericGaugeCard;
    host.appendChild(builder(gauge, activeEngine));
  }
}

/* ------------------------------------------------------------------ */
/* Memory browser (read-only, gbrain-backed)                           */
/* ------------------------------------------------------------------ */

/** Columns for the memory detail list (labels resolved via t() at build time). */
function memoryColumns() {
  return [
    {
      key: "title",
      label: t("views.cortex.colMemory", {}, "Page"),
      render: (row) => {
        const full = row.title || row.id || t("views.cortex.emptyMemory", {}, "(untitled)");
        const preview =
          full.length > MEMORY_CELL_PREVIEW_CHARS
            ? `${full.slice(0, MEMORY_CELL_PREVIEW_CHARS - 1)}…`
            : full;
        return el("span", null, preview);
      },
    },
    {
      key: "type",
      label: t("views.cortex.colType", {}, "Type"),
      sortable: true,
      render: (row) => (row.type ? el("span", "cx-chip", row.type) : el("span", null, "—")),
    },
    {
      key: "updatedAt",
      label: t("views.cortex.colWhen", {}, "Updated"),
      sortable: true,
      render: (row) => el("span", "cx-mem-time", relativeTime(toEpochMs(row.updatedAt)) || "—"),
    },
  ];
}

/**
 * Expanded panel for a memory row. The list endpoint only carries the page
 * stub (id/title/type/updatedAt); the body lives behind the GET-one endpoint,
 * so this panel mounts a placeholder and fetches {id, content} lazily.
 */
function buildMemoryDetail(row) {
  const panel = el("div");
  const heading = el("div", "cx-mem-detail-title", row.title || row.id || "");
  panel.appendChild(heading);

  const meta = el("div", "cx-mem-meta");
  if (row.type) meta.appendChild(el("span", "cx-chip", row.type));
  const when = relativeTime(toEpochMs(row.updatedAt));
  if (when) meta.appendChild(el("span", "cx-mem-time", when));
  panel.appendChild(meta);

  const content = el("div", "cx-mem-text expanded");
  content.textContent = t("views.cortex.loadingPage", {}, "Loading page…");
  panel.appendChild(content);

  if (!row.id) {
    content.textContent = t("views.cortex.emptyMemory", {}, "(empty)");
    return panel;
  }

  fetchJson(`${API_BASE}/memory/${encodeURIComponent(row.id)}`)
    .then((page) => {
      content.textContent = page?.content || t("views.cortex.emptyMemory", {}, "(empty)");
    })
    .catch((error) => {
      if (error.name === "AbortError") return;
      content.textContent = t(
        "views.cortex.pageLoadFailed",
        { message: error.message },
        "Failed to load page: {message}",
      );
    });

  return panel;
}

function setMemoryStatus(root, message) {
  const status = root.querySelector("#cx-memory-status");
  if (status) status.textContent = message || "";
}

async function loadMemories(root, query) {
  if (!memoryList) return;
  const trimmed = (query || "").trim();
  setMemoryStatus(
    root,
    trimmed
      ? t("views.cortex.searching", {}, "Searching…")
      : t("views.cortex.loadingMemories", {}, "Loading pages…"),
  );

  try {
    const url = trimmed
      ? `${API_BASE}/memory?query=${encodeURIComponent(trimmed)}&limit=${MEMORY_LIST_LIMIT}`
      : `${API_BASE}/memory?limit=${MEMORY_LIST_LIMIT}`;
    const payload = await fetchJson(url);
    const rows = (payload?.items || []).map((row, i) => ({
      ...row,
      _rid: row.id || `mem-${i}`,
    }));
    memoryList.update(rows);
    setMemoryStatus(
      root,
      rows.length === 0 && trimmed
        ? t("views.cortex.noSearchResults", {}, "No pages match this search.")
        : "",
    );
  } catch (error) {
    if (error.name === "AbortError") return;
    memoryList.update([]);
    setMemoryStatus(
      root,
      t("views.cortex.lookupFailed", { message: error.message }, "Memory lookup failed: {message}"),
    );
  }
}

function setupMemoryBrowser(root, memoryState) {
  const body = root.querySelector("#cx-memory-body");
  const offline = root.querySelector("#cx-memory-offline");
  const statsEl = root.querySelector("#cx-memory-stats");

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
            t("views.cortex.memoryOfflineReason", {}, "gbrain adapter unavailable"),
          t(
            "views.cortex.memoryOfflineHelp",
            {},
            "The memory browser comes back automatically once gbrain is reachable on this host.",
          ),
        ),
      );
    }
    return;
  }
  if (body) body.style.display = "";
  if (offline) offline.style.display = "none";

  // gbrain page stats: header shows total pages + last update.
  if (statsEl) {
    const parts = [];
    if (memoryState.pageCount !== undefined && memoryState.pageCount !== null) {
      parts.push(
        t("views.cortex.pagesCount", { count: memoryState.pageCount }, "{count} gbrain pages"),
      );
    }
    if (memoryState.lastUpdated) {
      parts.push(
        t(
          "views.cortex.lastUpdated",
          { when: formatWhen(memoryState.lastUpdated) },
          "updated {when}",
        ),
      );
    }
    statsEl.textContent = parts.join(" · ");
  }

  const listHost = root.querySelector("#cx-memory-list");
  if (listHost) {
    clearChildren(listHost);
    // Dense detail list (shared v2.1 component). Filtering is server-side via
    // the search box above, so the component's own filter box stays hidden.
    // Read-only: a row click expands a panel that fetches the page body; there
    // are no row actions.
    memoryList = createDetailList(listHost, {
      columns: memoryColumns(),
      getRowId: (row) => row._rid,
      renderDetail: (row) => buildMemoryDetail(row),
      emptyText: t("views.cortex.noMemories", {}, "No gbrain pages yet."),
      filterKeys: ["title", "type"],
      defaultSort: { key: "updatedAt", dir: "desc" },
      showFilter: false,
    });
  }

  const search = root.querySelector("#cx-memory-search");
  if (search) {
    search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => loadMemories(root, search.value), SEARCH_DEBOUNCE_MS);
    });
  }
  loadMemories(root, "");
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function init(container) {
  // Idempotency: cancel anything left over from a previous visit.
  if (abortController) abortController.abort();
  abortController = new AbortController();
  clearTimeout(searchTimer);
  // The view loader replaces the DOM wholesale; drop the stale list handle.
  memoryList = null;

  const root = container.querySelector("#cortex-view-section");
  if (!root) return;

  fetchJson(API_BASE)
    .then((state) => {
      renderAvailability(root, state);
      renderEngineStrip(root, state.contextEngine);
      renderGauges(root, state.gauges, state.contextEngine);
      setupMemoryBrowser(root, state.memory);
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
    });
}
