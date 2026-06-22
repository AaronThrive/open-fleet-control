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
// Recent-updates "last 30 days" window, in milliseconds.
const RECENT_WINDOW_30D_MS = 30 * 24 * 60 * 60 * 1000;

// Module-scope handles cleaned up on every init (the DOM itself is replaced
// by the view loader, so listeners die with it — only timers/aborts persist).
let abortController = null;
let searchTimer = null;
// Shared detail-list instance for the memory browser (rebuilt on every init).
let memoryList = null;

// Engine ("gauge") date-window selection. Rebuilt on every init so a fresh
// visit always starts on the lifetime ("all") view. Either a named rolling
// window or an explicit { from, to } range drives the /api/fleet/cortex query.
let engineWindow = "all";
let engineRange = { from: null, to: null };

/** Recognized rolling windows for the engine gauge filter. */
const ENGINE_WINDOWS = ["24h", "7d", "30d", "all"];

/**
 * Build the cortex state URL for the current engine-window selection. An
 * explicit from/to range takes precedence over the named window; the "all"
 * window (and an empty range) yields the bare endpoint — the lifetime default
 * — so nothing is appended and the original request shape is preserved.
 */
function cortexStateUrl() {
  const params = new URLSearchParams();
  if (engineRange.from || engineRange.to) {
    if (engineRange.from) params.set("from", engineRange.from);
    if (engineRange.to) params.set("to", engineRange.to);
  } else if (engineWindow && engineWindow !== "all") {
    params.set("window", engineWindow);
  }
  const qs = params.toString();
  return qs ? `${API_BASE}?${qs}` : API_BASE;
}

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

/**
 * Absolute local "Jun 1, 2026, 21:04" for an ISO/sqlite/epoch timestamp;
 * falls back to the raw string when unparseable, "" when empty. Used by the
 * health / mirror / recent-updates panels where the user wants an exact
 * point in time, not a relative "X ago".
 */
function formatAbsolute(value) {
  if (value === null || value === undefined || value === "") return "";
  const ms = toEpochMs(value);
  if (ms === null) return String(value);
  return new Date(ms).toLocaleString([], {
    year: "numeric",
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
    // Idle is the genuine, expected state here (lossless-claw does not hold the
    // context-engine slot). Show the absolute date plainly and frame the
    // figures as a historical snapshot — informative, not an error.
    card.appendChild(
      el(
        "div",
        "cx-eng-line",
        t(
          "views.cortex.lcmStaleMsg",
          { when: formatAbsolute(d.lastActivity) || "an earlier date" },
          "Idle since {when} — these totals are a historical snapshot, not live activity.",
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
      render: (row) => el("span", "cx-mem-time", formatAbsolute(row.updatedAt) || "—"),
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
  const when = formatAbsolute(row.updatedAt);
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
/* gbrain health badge + Obsidian mirror + recent-updates feed         */
/* ------------------------------------------------------------------ */

/** Format a "embedded / chunks" pair as "1573/1573 embedded". */
function embeddedText(embedded, chunks) {
  const e = Number(embedded);
  const c = Number(chunks);
  const eStr = Number.isFinite(e) ? formatTokens(e) : "?";
  const cStr = Number.isFinite(c) ? formatTokens(c) : "?";
  return t(
    "views.cortex.healthEmbedded",
    { embedded: eStr, chunks: cStr },
    "{embedded}/{chunks} embedded",
  );
}

/**
 * gbrain health badge: a single prominent status line.
 *   green  → reachable AND coverage 100% ("healthy")
 *   amber  → reachable but coverage < 100% (still embedding / partial)
 *   red    → unreachable
 * Health is sourced from state.health when present, falling back to the
 * memory slice's availability so the badge never renders blank.
 */
function renderHealth(root, memoryState, health) {
  const host = root.querySelector("#cx-health");
  if (!host) return;
  clearChildren(host);

  const reachable = !!memoryState?.available;
  const h = health || {};
  const coverage =
    h.embeddedCoverage === null || h.embeddedCoverage === undefined
      ? null
      : Number(h.embeddedCoverage);
  // coverage is a 0–1 ratio (1.0 = 100%). h.healthy is the authoritative flag;
  // the numeric fallback must compare against the ratio's full mark (1), not 100.
  const fullyEmbedded =
    h.healthy === true || (coverage !== null && coverage >= 1);

  let kind = "down";
  let label = t("views.cortex.healthUnreachable", {}, "gbrain unreachable");
  if (reachable && fullyEmbedded) {
    kind = "up";
    label = t("views.cortex.healthActive", {}, "gbrain active");
  } else if (reachable) {
    kind = "warn";
    label = t("views.cortex.healthDegraded", {}, "gbrain degraded");
  }

  host.style.display = "";
  const badge = el("div", `cx-health-badge ${kind}`);
  badge.appendChild(el("span", "cx-health-dot"));
  badge.appendChild(el("span", "cx-health-label", label));
  host.appendChild(badge);

  if (!reachable) {
    const reason = memoryState?.reason || h.error;
    if (reason) host.appendChild(el("div", "cx-health-line warn", String(reason)));
    return;
  }

  // Stat line: pages · chunks · embedded coverage.
  const stats = el("div", "cx-health-stats");
  const pages = h.pageCount ?? memoryState?.pageCount;
  if (pages !== undefined && pages !== null) {
    stats.appendChild(buildHealthStat(t("views.cortex.healthPages", {}, "pages"), formatTokens(pages)));
  }
  if (h.chunks !== undefined && h.chunks !== null) {
    stats.appendChild(buildHealthStat(t("views.cortex.healthChunks", {}, "chunks"), formatTokens(h.chunks)));
  }
  if (h.embedded !== undefined && h.embedded !== null) {
    stats.appendChild(
      buildHealthStat(t("views.cortex.healthEmbeddedLabel", {}, "embedded"), embeddedText(h.embedded, h.chunks)),
    );
  }
  if (stats.childNodes.length > 0) host.appendChild(stats);

  // Headline coverage verdict, e.g. "1573/1573 embedded — healthy".
  if (coverage !== null || (h.embedded !== undefined && h.embedded !== null)) {
    // coverage is a 0–1 ratio; render it as a percent (×100), so 1.0 → "100%",
    // 0.5 → "50%". Keep an integer when the percent is whole, one decimal else.
    const pct = coverage !== null ? coverage * 100 : null;
    const pctStr =
      pct !== null
        ? t("views.cortex.healthCoveragePct", { pct: pct.toFixed(pct % 1 === 0 ? 0 : 1) }, "{pct}% coverage")
        : "";
    const verdict = fullyEmbedded
      ? t("views.cortex.healthVerdictOk", {}, "healthy")
      : t("views.cortex.healthVerdictPartial", {}, "embedding in progress");
    const line = el("div", `cx-health-line ${fullyEmbedded ? "accent" : "warn"}`);
    const head = h.embedded !== undefined && h.embedded !== null ? `${embeddedText(h.embedded, h.chunks)} — ` : "";
    line.textContent = pctStr ? `${head}${verdict} · ${pctStr}` : `${head}${verdict}`;
    host.appendChild(line);
  }
}

function buildHealthStat(label, value) {
  const cell = el("span", "cx-health-stat");
  cell.append(`${label} `);
  cell.appendChild(el("b", null, value));
  return cell;
}

/**
 * Obsidian ↔ gbrain mirror sub-panel: last import / last export (absolute
 * timestamps), export summary, vault-vs-gbrain page parity, and a loud STALE
 * warning when the sync has fallen behind.
 */
function renderObsidian(root, obsidian, memoryState) {
  const host = root.querySelector("#cx-obsidian");
  if (!host) return;
  clearChildren(host);

  if (!obsidian) {
    host.style.display = "none";
    return;
  }
  host.style.display = "";

  const title = el("div", "cx-card-title");
  title.appendChild(el("span", null, t("views.cortex.obsidianTitle", {}, "Obsidian ↔ gbrain mirror")));
  if (obsidian.stale === true) {
    title.appendChild(buildBadge(t("views.cortex.obsidianStaleBadge", {}, "stale"), "stale"));
  } else {
    title.appendChild(buildBadge(t("views.cortex.obsidianSyncedBadge", {}, "in sync"), "live"));
  }
  host.appendChild(title);

  if (obsidian.stale === true) {
    host.appendChild(
      el(
        "div",
        "cx-mirror-stale",
        t(
          "views.cortex.obsidianStaleMsg",
          {},
          "STALE — the Obsidian vault and gbrain are out of sync; the nightly mirror has not completed a clean round-trip.",
        ),
      ),
    );
  }

  const grid = el("div", "cx-mirror-grid");
  const addRow = (label, value, cls) => {
    grid.appendChild(el("div", "cx-mirror-key", label));
    grid.appendChild(el("div", `cx-mirror-val${cls ? ` ${cls}` : ""}`, value));
  };

  const importWhen = formatAbsolute(obsidian.lastImportAt) || t("views.cortex.never", {}, "never");
  const importStatus =
    obsidian.lastImportOk === false
      ? t("views.cortex.importFailed", {}, " (failed)")
      : obsidian.lastImportOk === true
        ? t("views.cortex.importOk", {}, " (ok)")
        : "";
  addRow(
    t("views.cortex.lastImport", {}, "Last import"),
    `${importWhen}${importStatus}`,
    obsidian.lastImportOk === false ? "warn" : null,
  );

  addRow(
    t("views.cortex.lastExport", {}, "Last export"),
    formatAbsolute(obsidian.lastExportAt) || t("views.cortex.never", {}, "never"),
  );

  if (obsidian.lastExportSummary) {
    addRow(t("views.cortex.exportSummary", {}, "Export summary"), String(obsidian.lastExportSummary));
  }

  // Page parity: vault pages (approx) vs gbrain pages.
  const vaultPages = obsidian.vaultPagesApprox;
  const gbrainPages = memoryState?.pageCount;
  if (vaultPages !== undefined && vaultPages !== null) {
    const parityParts = [
      t("views.cortex.vaultPages", { count: formatTokens(vaultPages) }, "{count} vault (approx)"),
    ];
    if (gbrainPages !== undefined && gbrainPages !== null) {
      parityParts.push(t("views.cortex.gbrainPages", { count: formatTokens(gbrainPages) }, "{count} gbrain"));
    }
    const mismatch =
      gbrainPages !== undefined &&
      gbrainPages !== null &&
      Number.isFinite(Number(vaultPages)) &&
      Number.isFinite(Number(gbrainPages)) &&
      Number(vaultPages) !== Number(gbrainPages);
    addRow(
      t("views.cortex.pageParity", {}, "Page parity"),
      parityParts.join(" ↔ "),
      mismatch || obsidian.stale === true ? "warn" : null,
    );
  }

  host.appendChild(grid);
}

/**
 * "Recent memory updates" feed: a compact newest-first list of the latest
 * gbrain writes so the user can watch the brain being updated live. Absolute
 * timestamps only.
 */
function renderRecentUpdates(root, recentUpdates) {
  const host = root.querySelector("#cx-recent");
  if (!host) return;
  clearChildren(host);

  const list = Array.isArray(recentUpdates) ? recentUpdates : [];
  if (list.length === 0) {
    host.style.display = "none";
    return;
  }
  host.style.display = "";

  const sorted = [...list]
    .filter(Boolean)
    .sort((a, b) => (toEpochMs(b?.updatedAt) || 0) - (toEpochMs(a?.updatedAt) || 0));

  // View state is local to this render: the 30-day window toggle and a
  // client-side "cleared" flag. There is no persistence endpoint, so Clear
  // just empties the rendered feed until the next reload/refresh.
  let windowed = false;
  let cleared = false;

  const title = el("div", "cx-card-title");
  title.appendChild(el("span", null, t("views.cortex.recentTitle", {}, "Recent memory updates")));
  title.appendChild(el("span", "hint", t("views.cortex.recentHint", {}, "newest first")));

  // Controls: a 30-day window toggle and a Clear button.
  const controls = el("div", "cx-recent-controls");
  const windowBtn = el(
    "button",
    "cx-recent-toggle",
    t("views.cortex.recentWindow30d", {}, "Last 30 days"),
  );
  windowBtn.type = "button";
  const clearBtn = el("button", "cx-recent-clear", t("views.cortex.recentClear", {}, "Clear"));
  clearBtn.type = "button";
  controls.appendChild(windowBtn);
  controls.appendChild(clearBtn);
  title.appendChild(controls);
  host.appendChild(title);

  const feed = el("div", "cx-recent-list");
  host.appendChild(feed);

  const paint = () => {
    clearChildren(feed);
    if (cleared) {
      feed.appendChild(el("div", "cx-empty", t("views.cortex.recentCleared", {}, "Cleared")));
      return;
    }
    const cutoff = windowed ? Date.now() - RECENT_WINDOW_30D_MS : null;
    const shown = sorted.filter((entry) => {
      if (cutoff === null) return true;
      const ms = toEpochMs(entry.updatedAt);
      return ms !== null && ms >= cutoff;
    });
    if (shown.length === 0) {
      feed.appendChild(el("div", "cx-empty", t("views.cortex.recentEmptyWindow", {}, "No updates in this window")));
      return;
    }
    for (const entry of shown) {
      const row = el("div", "cx-recent-row");
      const main = el("div", "cx-recent-main");
      main.appendChild(
        el("span", "cx-recent-title-text", entry.title || entry.id || t("views.cortex.emptyMemory", {}, "(untitled)")),
      );
      if (entry.type) main.appendChild(el("span", "cx-chip", entry.type));
      row.appendChild(main);
      row.appendChild(el("span", "cx-recent-time", formatAbsolute(entry.updatedAt) || "—"));
      feed.appendChild(row);
    }
  };

  windowBtn.addEventListener("click", () => {
    windowed = !windowed;
    cleared = false;
    windowBtn.classList.toggle("active", windowed);
    paint();
  });
  clearBtn.addEventListener("click", () => {
    cleared = true;
    paint();
  });

  paint();
}

/* ------------------------------------------------------------------ */
/* Workspace memory stats (absorbed from the former Memory tab)         */
/* Data source: GET /api/memory → { memory: { totalFiles,              */
/* totalSizeFormatted, memoryMdSizeFormatted, memoryMdLines,           */
/* recentFiles:[{name,sizeFormatted,age}] } }. Rendered read-only here  */
/* so Cortex is the single memory/knowledge tab.                        */
/* ------------------------------------------------------------------ */

/** Date-stamped files are raw "daily" logs, everything else is "state". */
function classifyMemoryFile(name) {
  return /\d{4}-\d{2}-\d{2}/.test(String(name || "")) ? "daily" : "state";
}

function renderWorkspaceMemory(root, memory) {
  const host = root.querySelector("#cx-workspace");
  const errorEl = root.querySelector("#cx-workspace-error");
  if (!host) return;

  if (!memory) {
    host.style.display = "none";
    if (errorEl) {
      errorEl.style.display = "";
      errorEl.textContent = t(
        "views.cortex.workspaceError",
        {},
        "Could not reach the workspace memory API (/api/memory).",
      );
    }
    return;
  }
  if (errorEl) errorEl.style.display = "none";
  host.style.display = "";
  clearChildren(host);

  const title = el("div", "cx-card-title");
  const totalFiles = Number(memory.totalFiles) || 0;
  title.appendChild(el("span", null, t("views.cortex.workspaceTitle", {}, "Workspace memory")));
  title.appendChild(
    el(
      "span",
      "hint",
      t("views.cortex.workspaceCount", { n: totalFiles }, totalFiles === 1 ? "{n} file" : "{n} files"),
    ),
  );
  host.appendChild(title);

  // Stats strip: MEMORY.md size+lines, file count, total size.
  const strip = el("div", "cx-ws-strip");
  const mdLines = Number(memory.memoryMdLines);
  const mdLineText =
    Number.isFinite(mdLines) && mdLines > 0
      ? t("views.cortex.wsMdLines", { n: mdLines }, "· {n} lines")
      : "";
  strip.appendChild(
    buildWsStat(
      "📜",
      t("views.cortex.wsMemoryMd", {}, "MEMORY.md"),
      `${memory.memoryMdSizeFormatted || "—"} ${mdLineText}`.trim(),
    ),
  );
  strip.appendChild(
    buildWsStat("📅", t("views.cortex.wsFiles", {}, "files"), String(memory.totalFiles ?? "—")),
  );
  strip.appendChild(
    buildWsStat("💾", t("views.cortex.wsTotal", {}, "total"), memory.totalSizeFormatted || "—"),
  );
  host.appendChild(strip);

  // Recent files list (newest-first as the server returns them).
  const files = Array.isArray(memory.recentFiles) ? memory.recentFiles : [];
  const rows = files.filter((f) => f && f.name);
  if (rows.length > 0) {
    host.appendChild(el("div", "cx-ws-recent-title", t("views.cortex.wsRecent", {}, "Recent memory files")));
    const fileList = el("div", "cx-ws-files");
    for (const file of rows) {
      const row = el("div", "cx-ws-file");
      const type = classifyMemoryFile(file.name);
      const badge = el("span", `cx-ws-type ${type}`, type === "daily" ? `📅 ${type}` : `📊 ${type}`);
      row.appendChild(badge);
      row.appendChild(el("span", "cx-ws-name", file.name));
      row.appendChild(el("span", "cx-ws-size", file.sizeFormatted || "—"));
      row.appendChild(el("span", "cx-ws-age", file.age || "—"));
      fileList.appendChild(row);
    }
    host.appendChild(fileList);
  } else {
    host.appendChild(el("div", "cx-empty", t("views.cortex.wsEmpty", {}, "No memory files yet.")));
  }
}

function buildWsStat(icon, label, value) {
  const cell = el("span", "cx-ws-stat");
  cell.append(`${icon} ${label} `);
  cell.appendChild(el("b", null, value));
  return cell;
}

/** Fetch + render the workspace memory stats (separate /api/memory endpoint). */
async function loadWorkspaceMemory(root) {
  try {
    const payload = await fetchJson("/api/memory");
    renderWorkspaceMemory(root, payload?.memory || null);
  } catch (error) {
    if (error.name === "AbortError") return;
    renderWorkspaceMemory(root, null);
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/** Short human label for the active engine window (status line + a11y). */
function engineWindowLabel() {
  if (engineRange.from || engineRange.to) {
    const from = engineRange.from || "…";
    const to = engineRange.to || t("views.cortex.engineWindowNow", {}, "now");
    return t(
      "views.cortex.engineWindowRangeStatus",
      { from, to },
      "Showing engine totals from {from} to {to}",
    );
  }
  if (engineWindow && engineWindow !== "all") {
    return t(
      "views.cortex.engineWindowRollingStatus",
      { window: engineWindow },
      "Showing engine totals for the last {window}",
    );
  }
  return t("views.cortex.engineWindowAllStatus", {}, "Showing lifetime engine totals");
}

function setEngineWindowStatus(root) {
  const status = root.querySelector("#cx-window-status");
  if (status) status.textContent = engineWindowLabel();
}

/**
 * Fetch the cortex state for the current engine-window selection and (re)render
 * the date-dependent regions: availability dots, the active-engine strip, and
 * the gauge cards. On the first load it also renders the date-agnostic regions
 * (health, Obsidian mirror, recent updates, memory browser) — those never
 * change with the window, so subsequent window switches leave them untouched.
 */
function loadCortexState(root, isFirstLoad) {
  setEngineWindowStatus(root);
  const gaugesHost = root.querySelector("#cx-gauges");
  if (gaugesHost && !isFirstLoad) {
    clearChildren(gaugesHost);
    gaugesHost.appendChild(
      el("div", "cx-loading", t("views.cortex.loadingGauges", {}, "Loading compression gauges…")),
    );
  }

  return fetchJson(cortexStateUrl())
    .then((state) => {
      renderAvailability(root, state);
      renderEngineStrip(root, state.contextEngine);
      renderGauges(root, state.gauges, state.contextEngine);
      if (isFirstLoad) {
        renderHealth(root, state.memory, state.health);
        renderObsidian(root, state.obsidian, state.memory);
        renderRecentUpdates(root, state.recentUpdates);
        setupMemoryBrowser(root, state.memory);
      }
    })
    .catch((error) => {
      if (error.name === "AbortError") return;
      if (gaugesHost) {
        clearChildren(gaugesHost);
        gaugesHost.appendChild(
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
      if (isFirstLoad) {
        renderHealth(root, { available: false, reason: error.message }, null);
        renderObsidian(root, null, null);
        renderRecentUpdates(root, null);
        setupMemoryBrowser(root, { available: false, reason: error.message });
      }
    });
}

/**
 * Wire the engine date-window control: the rolling-window buttons and the
 * explicit from/to range. Selecting a window or applying a range re-fetches
 * only the gauge-bearing state (loadCortexState) and re-renders the engine
 * region in place; the rest of the view stays put.
 */
function setupEngineWindow(root) {
  const tabs = root.querySelector("#cx-window-tabs");
  const fromInput = root.querySelector("#cx-window-from");
  const toInput = root.querySelector("#cx-window-to");
  const applyBtn = root.querySelector("#cx-window-apply");
  const clearBtn = root.querySelector("#cx-window-clear");

  const markActiveWindow = (value) => {
    if (!tabs) return;
    tabs
      .querySelectorAll(".filter-btn")
      .forEach((btn) => btn.classList.toggle("active", btn.dataset.window === value));
  };

  if (tabs) {
    tabs.querySelectorAll(".filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const value = btn.dataset.window;
        if (!ENGINE_WINDOWS.includes(value)) return;
        // A named window supersedes any explicit range; clear the date inputs.
        engineWindow = value;
        engineRange = { from: null, to: null };
        if (fromInput) fromInput.value = "";
        if (toInput) toInput.value = "";
        markActiveWindow(value);
        loadCortexState(root, false);
      });
    });
  }

  if (applyBtn) {
    applyBtn.addEventListener("click", () => {
      const from = fromInput ? fromInput.value : "";
      const to = toInput ? toInput.value : "";
      if (!from && !to) {
        // Empty range behaves like "all".
        engineWindow = "all";
        engineRange = { from: null, to: null };
        markActiveWindow("all");
        loadCortexState(root, false);
        return;
      }
      // An explicit range wins over the rolling-window buttons.
      engineWindow = null;
      engineRange = { from: from || null, to: to || null };
      markActiveWindow(null);
      loadCortexState(root, false);
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      engineWindow = "all";
      engineRange = { from: null, to: null };
      if (fromInput) fromInput.value = "";
      if (toInput) toInput.value = "";
      markActiveWindow("all");
      loadCortexState(root, false);
    });
  }
}

export function init(container) {
  // Idempotency: cancel anything left over from a previous visit.
  if (abortController) abortController.abort();
  abortController = new AbortController();
  clearTimeout(searchTimer);
  // The view loader replaces the DOM wholesale; drop the stale list handle.
  memoryList = null;
  // A fresh visit always resets the engine window to the lifetime default.
  engineWindow = "all";
  engineRange = { from: null, to: null };

  const root = container.querySelector("#cortex-view-section");
  if (!root) return;

  // Workspace memory stats live behind a separate endpoint (/api/memory) and
  // load independently of the cortex state fetch.
  loadWorkspaceMemory(root);

  // Wire the date-window control, then do the first (lifetime) state load.
  setupEngineWindow(root);
  loadCortexState(root, true);
}
