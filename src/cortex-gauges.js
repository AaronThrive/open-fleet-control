/**
 * Cortex compression gauges — token savings telemetry from two sources:
 *
 *  - lean-ctx:  ~/.lean-ctx/stats.json (command output compression totals)
 *  - lcm:       ~/.openclaw/lcm.db (lossless-claw SQLite; historical
 *               summary compaction, read-only via node:sqlite)
 *
 * Each source is independently try/catch'd; a failure in one never affects
 * the others. Every gauge has the shape:
 *   { source, label, rawTokens, effectiveTokens, savingsPct, detail, available }
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

/** Lazy default loader for the node:sqlite builtin (may be absent on old Node). */
function defaultSqliteLoader() {
  return require("node:sqlite");
}

/** Percentage saved going from raw -> effective, one decimal (null if no raw). */
function computeSavingsPct(rawTokens, effectiveTokens) {
  const raw = Number(rawTokens);
  const effective = Number(effectiveTokens);
  if (!Number.isFinite(raw) || raw <= 0 || !Number.isFinite(effective)) return null;
  return Math.round(((raw - effective) / raw) * 1000) / 10;
}

/** Build an unavailable gauge entry for a source. */
function unavailableGauge(source, label, reason) {
  return {
    source,
    label,
    rawTokens: 0,
    effectiveTokens: 0,
    savingsPct: null,
    detail: { error: reason },
    available: false,
  };
}

function readJsonFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  return JSON.parse(content);
}

/** Days of lcm inactivity after which the gauge is flagged "historical". */
const LCM_STALE_DAYS = 7;

/**
 * Normalize a caller-supplied date range into validated epoch-ms bounds.
 *
 * Accepts { from, to } as epoch ms or ISO/date strings. Either side may be
 * omitted (open-ended). Returns { from, to } where each is epoch ms or null
 * (null = unbounded on that side). A null/undefined range, or one that
 * resolves to no bounds, means "lifetime / all" — the default behavior.
 *
 * @throws {Error} when a supplied bound is unparseable or from > to.
 */
function normalizeRange(range) {
  if (!range || typeof range !== "object") return { from: null, to: null };
  const coerce = (value, label) => {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error(`invalid ${label} bound`);
      return value;
    }
    const ms = parseSqliteUtc(String(value)) ?? Date.parse(String(value));
    if (!Number.isFinite(ms)) throw new Error(`invalid ${label} bound: ${value}`);
    return ms;
  };
  const from = coerce(range.from, "from");
  const to = coerce(range.to, "to");
  if (from !== null && to !== null && from > to) {
    throw new Error("range from must be <= to");
  }
  return { from, to };
}

/** Whether an epoch-ms instant falls within [from, to] (null bounds = open). */
function withinRange(ms, from, to) {
  if (ms === null) return false;
  if (from !== null && ms < from) return false;
  if (to !== null && ms > to) return false;
  return true;
}

/** Parse a lean-ctx daily "date" ("YYYY-MM-DD") to that day's UTC midnight ms. */
function parseDailyDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Parse a sqlite datetime ("YYYY-MM-DD HH:MM:SS", implicitly UTC) into
 * epoch ms; also accepts ISO strings. Returns null when unparseable.
 */
function parseSqliteUtc(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Format an epoch-ms instant as a sqlite UTC datetime ("YYYY-MM-DD HH:MM:SS"),
 * the inverse of parseSqliteUtc. Used to build BETWEEN bounds that compare
 * correctly against the lcm.db `created_at` column.
 */
function toSqliteUtc(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Create the gauges module.
 *
 * @param {object} [options]
 * @param {string} [options.home] - home directory override (tests only)
 * @param {object} [options.paths] - overrides: { leanCtx, lcmDb }.
 *   Empty/blank strings are ignored — CONFIG flows "" through fleet.js to
 *   mean "use the default location", and a blank override must never clobber
 *   a real default path.
 * @param {function} [options.sqliteLoader] - () => node:sqlite module (may throw)
 */
function createGauges(options = {}) {
  const home = options.home || os.homedir();
  const defaults = {
    leanCtx: path.join(home, ".lean-ctx", "stats.json"),
    lcmDb: path.join(home, ".openclaw", "lcm.db"),
    openclawConfig: path.join(home, ".openclaw", "openclaw.json"),
  };
  const overrides = {};
  for (const [key, value] of Object.entries(options.paths || {})) {
    if (typeof value === "string" && value.trim() !== "") overrides[key] = value;
  }
  const paths = { ...defaults, ...overrides };
  const sqliteLoader = options.sqliteLoader || defaultSqliteLoader;
  const now = options.now || Date.now;

  /** Top per-command token consumers from the stats.json commands map. */
  function topLeanCtxCommands(commands) {
    if (!commands || typeof commands !== "object") return [];
    return Object.entries(commands)
      .map(([command, stats]) => ({
        command,
        count: Number(stats?.count) || 0,
        tokens: Number(stats?.output_tokens) || 0,
      }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 5);
  }

  function leanCtxGauge(range) {
    const label = "lean-ctx (command output compression)";
    const { from, to } = range;
    const ranged = from !== null || to !== null;
    try {
      if (!fs.existsSync(paths.leanCtx)) {
        return unavailableGauge("lean-ctx", label, `file not found: ${paths.leanCtx}`);
      }
      const data = readJsonFile(paths.leanCtx);

      // Lifetime totals are the default. When a range is active, recompute the
      // throughput figures from the per-day `daily[]` array (the only
      // date-broken-out data lean-ctx records) and count only the days that
      // fall inside [from, to].
      const daily = Array.isArray(data.daily) ? data.daily : [];
      let tokensProcessed = Number(data.total_output_tokens) || 0;
      let totalCommands = data.total_commands ?? 0;
      let daysTracked = daily.length;
      if (ranged) {
        const inWindow = daily.filter((day) =>
          withinRange(parseDailyDate(day && day.date), from, to),
        );
        tokensProcessed = inWindow.reduce((sum, day) => sum + (Number(day.output_tokens) || 0), 0);
        totalCommands = inWindow.reduce((sum, day) => sum + (Number(day.commands) || 0), 0);
        daysTracked = inWindow.length;
      }

      const baseDetail = {
        totalCommands,
        tokensProcessed,
        // Per-command top consumers are lifetime-only — stats.json has no
        // per-day command breakdown — so this list is unaffected by the range.
        topCommands: topLeanCtxCommands(data.commands),
        firstUse: data.first_use ?? null,
        lastUse: data.last_use ?? null,
        daysTracked,
        ranged,
        // The cep savings block (below) has no per-day breakdown, so the
        // savings % always reflects lifetime sessions even under a range.
        topCommandsLifetime: ranged,
      };

      // Genuine before/after sizes only exist in the cep block. The top-level
      // total_input_tokens / total_output_tokens are the SAME measurement
      // recorded twice for nearly every command — treating them as raw vs
      // effective yields a meaningless ~0% savings figure.
      const cep = data.cep && typeof data.cep === "object" ? data.cep : {};
      const cepOriginal = Number(cep.total_tokens_original) || 0;
      if (cepOriginal > 0) {
        const cepCompressed = Number(cep.total_tokens_compressed) || 0;
        return {
          source: "lean-ctx",
          label,
          rawTokens: cepOriginal,
          effectiveTokens: cepCompressed,
          savingsPct: computeSavingsPct(cepOriginal, cepCompressed),
          detail: { ...baseDetail, savingsSource: "cep", savingsLifetime: ranged },
          available: true,
        };
      }

      return {
        source: "lean-ctx",
        label,
        rawTokens: tokensProcessed,
        effectiveTokens: tokensProcessed,
        savingsPct: null,
        detail: {
          ...baseDetail,
          note: "savings not derivable: stats.json does not record pre-compression sizes",
        },
        available: true,
      };
    } catch (e) {
      return unavailableGauge("lean-ctx", label, e.message);
    }
  }

  function lcmGauge(range) {
    const label = "lossless-claw (transcript compaction)";
    const { from, to } = range;
    const ranged = from !== null || to !== null;
    // created_at is stored as "YYYY-MM-DD HH:MM:SS" (UTC). That format sorts
    // lexicographically the same as chronologically, so a BETWEEN on the
    // equivalent string bounds is a correct date filter. Build the WHERE
    // fragment + bind params once and reuse it across the summaries aggregate,
    // the staleness MAX(created_at), and the source-message count.
    const fromStr = from !== null ? toSqliteUtc(from) : null;
    const toStr = to !== null ? toSqliteUtc(to) : null;
    let db = null;
    try {
      if (!fs.existsSync(paths.lcmDb)) {
        return unavailableGauge("lcm", label, `database not found: ${paths.lcmDb}`);
      }
      const sqlite = sqliteLoader();
      db = new sqlite.DatabaseSync(paths.lcmDb, { readOnly: true });

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name);

      // Preferred: summaries table (raw source tokens vs compacted tokens)
      if (tables.includes("summaries")) {
        const columns = db
          .prepare("PRAGMA table_info(summaries)")
          .all()
          .map((col) => col.name);
        if (columns.includes("token_count")) {
          const rawColumn = columns.includes("source_message_token_count")
            ? "source_message_token_count"
            : columns.includes("descendant_token_count")
              ? "descendant_token_count"
              : null;
          const selectRaw = rawColumn ? `, COALESCE(SUM(${rawColumn}), 0) AS raw` : "";

          // Date filter: only possible when created_at exists. Build a WHERE
          // fragment + ordered bind params; absent created_at means the range
          // cannot be honored (reported via detail.rangeApplied below).
          const hasCreatedAt = columns.includes("created_at");
          const canRange = ranged && hasCreatedAt;
          const whereParts = [];
          const whereParams = [];
          if (canRange && fromStr !== null) {
            whereParts.push("created_at >= ?");
            whereParams.push(fromStr);
          }
          if (canRange && toStr !== null) {
            whereParts.push("created_at <= ?");
            whereParams.push(toStr);
          }
          const whereSql = whereParts.length ? ` WHERE ${whereParts.join(" AND ")}` : "";

          const row = db
            .prepare(
              `SELECT COUNT(*) AS n, COALESCE(SUM(token_count), 0) AS effective${selectRaw} FROM summaries${whereSql}`,
            )
            .get(...whereParams);
          const effectiveTokens = Number(row.effective) || 0;
          const rawTokens = rawColumn ? Number(row.raw) || 0 : effectiveTokens;
          const detail = {
            summaries: Number(row.n) || 0,
            rawColumn: rawColumn || "none",
            ranged,
            // True when a range was requested AND the schema supports filtering
            // it; false signals the numbers are still lifetime despite the range.
            rangeApplied: canRange,
          };

          // Activity detection: lossless-claw may be installed but idle (its
          // contextEngine slot taken by another engine). The newest summary
          // timestamp tells the UI whether these numbers are live or history.
          // The staleness window is always computed lifetime (newest summary
          // overall) so "idle since {date}" stays accurate regardless of range.
          detail.lastActivity = null;
          detail.stale = null;
          detail.staleDays = null;
          if (hasCreatedAt) {
            const activity = db.prepare("SELECT MAX(created_at) AS last FROM summaries").get();
            detail.lastActivity = activity?.last ?? null;
            const lastMs = parseSqliteUtc(detail.lastActivity);
            if (lastMs !== null) {
              const days = Math.floor((now() - lastMs) / 86400000);
              detail.staleDays = days;
              detail.stale = days >= LCM_STALE_DAYS;
            }
          }
          if (tables.includes("messages")) {
            try {
              // Apply the same date filter to the source-message count when the
              // messages table carries created_at and a range is in effect, so
              // "source messages" tracks the windowed summaries it pairs with.
              const msgCols = db
                .prepare("PRAGMA table_info(messages)")
                .all()
                .map((col) => col.name);
              const msgRange = canRange && msgCols.includes("created_at");
              const messages = db
                .prepare(`SELECT COUNT(*) AS n FROM messages${msgRange ? whereSql : ""}`)
                .get(...(msgRange ? whereParams : []));
              detail.messages = Number(messages.n) || 0;
            } catch (e) {
              // messages table unreadable - summaries data is still valid
            }
          }
          return {
            source: "lcm",
            label,
            rawTokens,
            effectiveTokens,
            savingsPct: computeSavingsPct(rawTokens, effectiveTokens),
            detail,
            available: true,
          };
        }
      }

      // Schema surprise fallback: messages with token counts but no usable
      // summaries — report totals with zero savings rather than failing.
      if (tables.includes("messages")) {
        const columns = db
          .prepare("PRAGMA table_info(messages)")
          .all()
          .map((col) => col.name);
        if (columns.includes("token_count")) {
          const row = db
            .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(token_count), 0) AS total FROM messages")
            .get();
          const total = Number(row.total) || 0;
          return {
            source: "lcm",
            label,
            rawTokens: total,
            effectiveTokens: total,
            savingsPct: 0,
            detail: {
              messages: Number(row.n) || 0,
              note: "no usable summaries table; reporting message tokens only",
            },
            available: true,
          };
        }
      }

      return unavailableGauge("lcm", label, "no summaries/messages tables with token counts");
    } catch (e) {
      return unavailableGauge("lcm", label, e.message);
    } finally {
      if (db) {
        try {
          db.close();
        } catch (e) {
          // Already closed or never fully opened
        }
      }
    }
  }

  /**
   * All gauges; each source is isolated so one failure never hides another.
   *
   * @param {object} [opts]
   * @param {object} [opts.range] - { from, to } as epoch ms or ISO/date
   *   strings; either side may be omitted. Omitted/empty range = lifetime
   *   totals (the default, unchanged behavior). Validated here so a bad range
   *   surfaces as a thrown error to the caller rather than a silent miss.
   */
  function getGauges(opts = {}) {
    const range = normalizeRange(opts.range);
    return [leanCtxGauge(range), lcmGauge(range)];
  }

  /**
   * Which engine owns the OpenClaw contextEngine slot. The three gauge
   * sources are SEPARATE tools — only the slot holder shapes live context;
   * the others are complementary or idle. Reads plugins.slots.contextEngine
   * from the openclaw config (default ~/.openclaw/openclaw.json).
   *
   * @returns {{ engine: string|null, source: string|null, reason: string|null }}
   */
  function getContextEngine() {
    try {
      if (!fs.existsSync(paths.openclawConfig)) {
        return {
          engine: null,
          source: null,
          reason: `openclaw config not found: ${paths.openclawConfig}`,
        };
      }
      const data = readJsonFile(paths.openclawConfig);
      const engine = data?.plugins?.slots?.contextEngine;
      if (typeof engine !== "string" || !engine.trim()) {
        return {
          engine: null,
          source: null,
          reason: `no contextEngine slot configured in ${paths.openclawConfig}`,
        };
      }
      return { engine, source: "plugins.slots.contextEngine", reason: null };
    } catch (e) {
      return { engine: null, source: null, reason: e.message };
    }
  }

  return { getGauges, getContextEngine };
}

module.exports = { createGauges, computeSavingsPct };
