/**
 * Cortex compression gauges — token savings telemetry from three sources:
 *
 *  - headroom:  ~/.headroom/subscription_state.json (window token totals,
 *               raw vs weighted equivalent + cache metrics)
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

/**
 * Create the gauges module.
 *
 * @param {object} [options]
 * @param {string} [options.home] - home directory override (tests only)
 * @param {object} [options.paths] - overrides: { headroom, leanCtx, lcmDb }.
 *   Empty/blank strings are ignored — CONFIG flows "" through fleet.js to
 *   mean "use the default location", and a blank override must never clobber
 *   a real default path.
 * @param {function} [options.sqliteLoader] - () => node:sqlite module (may throw)
 */
function createGauges(options = {}) {
  const home = options.home || os.homedir();
  const defaults = {
    headroom: path.join(home, ".headroom", "subscription_state.json"),
    leanCtx: path.join(home, ".lean-ctx", "stats.json"),
    lcmDb: path.join(home, ".openclaw", "lcm.db"),
  };
  const overrides = {};
  for (const [key, value] of Object.entries(options.paths || {})) {
    if (typeof value === "string" && value.trim() !== "") overrides[key] = value;
  }
  const paths = { ...defaults, ...overrides };
  const sqliteLoader = options.sqliteLoader || defaultSqliteLoader;

  function headroomGauge() {
    const label = "Headroom (subscription window)";
    try {
      if (!fs.existsSync(paths.headroom)) {
        return unavailableGauge("headroom", label, `file not found: ${paths.headroom}`);
      }
      const data = readJsonFile(paths.headroom);
      // After a restart or failed poll, headroom writes the state file with
      // `latest: null` and `window_tokens: null`. Reporting that as an
      // available gauge full of zeros is misleading — call it out instead.
      const window = data.window_tokens || null;
      const latest = data.latest || null;
      if (!window && !latest) {
        return unavailableGauge(
          "headroom",
          label,
          `headroom state has no poll data yet (latest/window_tokens are null in ${paths.headroom})`,
        );
      }
      const w = window || {};
      const rawTokens =
        Number(w.total_raw) ||
        Number(w.input || 0) +
          Number(w.output || 0) +
          Number(w.cache_reads || 0) +
          Number(w.cache_writes_total || 0);
      const effectiveTokens = Number(w.weighted_token_equivalent ?? rawTokens) || 0;
      const extra = latest?.extra_usage;
      const extraEnabled = !!(extra && extra.is_enabled);
      return {
        source: "headroom",
        label,
        rawTokens,
        effectiveTokens,
        savingsPct: computeSavingsPct(rawTokens, effectiveTokens),
        detail: {
          input: w.input ?? 0,
          output: w.output ?? 0,
          cacheReads: w.cache_reads ?? 0,
          cacheWritesTotal: w.cache_writes_total ?? 0,
          fiveHourUtilizationPct: latest?.five_hour?.utilization_pct ?? null,
          sevenDayUtilizationPct: latest?.seven_day?.utilization_pct ?? null,
          extraUsageUsd: extraEnabled ? (extra.used_credits_usd ?? null) : null,
          extraUsageLimitUsd: extraEnabled ? (extra.monthly_limit_usd ?? null) : null,
          polledAt: latest?.polled_at ?? null,
        },
        available: true,
      };
    } catch (e) {
      return unavailableGauge("headroom", label, e.message);
    }
  }

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

  function leanCtxGauge() {
    const label = "lean-ctx (command output compression)";
    try {
      if (!fs.existsSync(paths.leanCtx)) {
        return unavailableGauge("lean-ctx", label, `file not found: ${paths.leanCtx}`);
      }
      const data = readJsonFile(paths.leanCtx);
      const tokensProcessed = Number(data.total_output_tokens) || 0;
      const baseDetail = {
        totalCommands: data.total_commands ?? 0,
        tokensProcessed,
        topCommands: topLeanCtxCommands(data.commands),
        firstUse: data.first_use ?? null,
        lastUse: data.last_use ?? null,
        daysTracked: Array.isArray(data.daily) ? data.daily.length : 0,
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
          detail: { ...baseDetail, savingsSource: "cep" },
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

  function lcmGauge() {
    const label = "lossless-claw (transcript compaction)";
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
          const row = db
            .prepare(
              `SELECT COUNT(*) AS n, COALESCE(SUM(token_count), 0) AS effective${selectRaw} FROM summaries`,
            )
            .get();
          const effectiveTokens = Number(row.effective) || 0;
          const rawTokens = rawColumn ? Number(row.raw) || 0 : effectiveTokens;
          const detail = { summaries: Number(row.n) || 0, rawColumn: rawColumn || "none" };
          if (tables.includes("messages")) {
            try {
              const messages = db.prepare("SELECT COUNT(*) AS n FROM messages").get();
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

  /** All gauges; each source is isolated so one failure never hides another. */
  function getGauges() {
    return [headroomGauge(), leanCtxGauge(), lcmGauge()];
  }

  return { getGauges };
}

module.exports = { createGauges, computeSavingsPct };
