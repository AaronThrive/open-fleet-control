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
 * @param {object} [options.paths] - overrides: { headroom, leanCtx, lcmDb }
 * @param {function} [options.sqliteLoader] - () => node:sqlite module (may throw)
 */
function createGauges(options = {}) {
  const home = os.homedir();
  const paths = {
    headroom: path.join(home, ".headroom", "subscription_state.json"),
    leanCtx: path.join(home, ".lean-ctx", "stats.json"),
    lcmDb: path.join(home, ".openclaw", "lcm.db"),
    ...(options.paths || {}),
  };
  const sqliteLoader = options.sqliteLoader || defaultSqliteLoader;

  function headroomGauge() {
    const label = "Headroom (subscription window)";
    try {
      if (!fs.existsSync(paths.headroom)) {
        return unavailableGauge("headroom", label, `file not found: ${paths.headroom}`);
      }
      const data = readJsonFile(paths.headroom);
      const window = data.window_tokens || {};
      const rawTokens =
        Number(window.total_raw) ||
        Number(window.input || 0) +
          Number(window.output || 0) +
          Number(window.cache_reads || 0) +
          Number(window.cache_writes_total || 0);
      const effectiveTokens = Number(window.weighted_token_equivalent ?? rawTokens) || 0;
      return {
        source: "headroom",
        label,
        rawTokens,
        effectiveTokens,
        savingsPct: computeSavingsPct(rawTokens, effectiveTokens),
        detail: {
          input: window.input ?? 0,
          output: window.output ?? 0,
          cacheReads: window.cache_reads ?? 0,
          cacheWritesTotal: window.cache_writes_total ?? 0,
          fiveHourUtilizationPct: data.latest?.five_hour?.utilization_pct ?? null,
          sevenDayUtilizationPct: data.latest?.seven_day?.utilization_pct ?? null,
          polledAt: data.latest?.polled_at ?? null,
        },
        available: true,
      };
    } catch (e) {
      return unavailableGauge("headroom", label, e.message);
    }
  }

  function leanCtxGauge() {
    const label = "lean-ctx (command output compression)";
    try {
      if (!fs.existsSync(paths.leanCtx)) {
        return unavailableGauge("lean-ctx", label, `file not found: ${paths.leanCtx}`);
      }
      const data = readJsonFile(paths.leanCtx);
      const rawTokens = Number(data.total_input_tokens) || 0;
      const effectiveTokens = Number(data.total_output_tokens) || 0;
      return {
        source: "lean-ctx",
        label,
        rawTokens,
        effectiveTokens,
        savingsPct: computeSavingsPct(rawTokens, effectiveTokens),
        detail: {
          totalCommands: data.total_commands ?? 0,
          firstUse: data.first_use ?? null,
          lastUse: data.last_use ?? null,
          daysTracked: Array.isArray(data.daily) ? data.daily.length : 0,
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
