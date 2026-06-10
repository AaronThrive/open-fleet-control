/**
 * Nine Router usage source — READ-ONLY view over the 9router SQLite database
 * (~/.openclaw/9router/data/db/data.sqlite via node:sqlite DatabaseSync).
 *
 * The schema is inspected defensively through sqlite_master / PRAGMA before
 * any query runs; missing tables or columns degrade to partial data with a
 * note instead of failing. Sensitive columns are never selected:
 *   - usageHistory.apiKey / .tokens / .meta
 *   - providerConnections.data / .email (auth payloads + PII)
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_DB_PATH = path.join(
  os.homedir(),
  ".openclaw",
  "9router",
  "data",
  "db",
  "data.sqlite",
);
const MAX_USAGE_ROWS = 50000;
const DEFAULT_DAILY_DAYS = 14;

/** Lazy default loader for the node:sqlite builtin (absent on old Node). */
function defaultSqliteLoader() {
  return require("node:sqlite");
}

/** Parse a timestamp cell that may be ISO text, epoch seconds, or epoch ms. */
function parseTimestampMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) return num < 1e12 ? num * 1000 : num;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function emptyTotals() {
  return { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 };
}

function addRowToTotals(totals, row) {
  const prompt = Number(row.promptTokens) || 0;
  const completion = Number(row.completionTokens) || 0;
  totals.requests++;
  totals.promptTokens += prompt;
  totals.completionTokens += completion;
  totals.totalTokens += prompt + completion;
  totals.cost += Number(row.cost) || 0;
}

/** Round accumulated float cost to 6 decimals for stable JSON output. */
function roundCost(totals) {
  return { ...totals, cost: Math.round(totals.cost * 1e6) / 1e6 };
}

function groupToSortedArray(map, keyName) {
  return Object.entries(map)
    .map(([key, totals]) => ({ [keyName]: key, ...roundCost(totals) }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests);
}

/**
 * Create the Nine Router usage source.
 *
 * @param {object} [options]
 * @param {string} [options.dbPath] - default ~/.openclaw/9router/data/db/data.sqlite
 * @param {function} [options.sqliteLoader] - () => node:sqlite module (may throw)
 */
function createNineRouterSource(options = {}) {
  const dbPath = options.dbPath || DEFAULT_DB_PATH;
  const sqliteLoader = options.sqliteLoader || defaultSqliteLoader;

  function describe() {
    if (!fs.existsSync(dbPath)) {
      return { available: false, reason: `database not found: ${dbPath}` };
    }
    try {
      sqliteLoader();
    } catch (e) {
      return { available: false, reason: `sqlite unavailable: ${e.message}` };
    }
    return { available: true };
  }

  /** Open read-only and run fn(db, tables, columnsOf); always closes. */
  function withDb(fn) {
    const sqlite = sqliteLoader();
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name);
      const columnsOf = (table) =>
        db
          .prepare(`PRAGMA table_info(${JSON.stringify(table)})`)
          .all()
          .map((col) => col.name);
      return fn(db, tables, columnsOf);
    } finally {
      try {
        db.close();
      } catch (e) {
        // already closed or never fully opened
      }
    }
  }

  /**
   * Usage totals + byProvider + byModel + byStatus from usageHistory.
   * @param {object} [params] - { sinceMs }
   */
  async function getUsage(params = {}) {
    const status = describe();
    if (!status.available) return { available: false, reason: status.reason };
    const sinceMs = Number.isFinite(params.sinceMs) ? params.sinceMs : null;

    try {
      return withDb((db, tables, columnsOf) => {
        const notes = [];
        if (!tables.includes("usageHistory")) {
          return {
            available: true,
            totals: emptyTotals(),
            byProvider: [],
            byModel: [],
            byStatus: {},
            notes: ["usageHistory table missing — no request-level usage data"],
          };
        }

        const columns = columnsOf("usageHistory");
        // Whitelist only — sensitive columns (apiKey, tokens, meta) never selected.
        const wanted = [
          "timestamp",
          "createdAt",
          "created_at",
          "provider",
          "model",
          "promptTokens",
          "completionTokens",
          "cost",
          "status",
        ];
        const selected = wanted.filter((c) => columns.includes(c));
        if (selected.length === 0) {
          return {
            available: true,
            totals: emptyTotals(),
            byProvider: [],
            byModel: [],
            byStatus: {},
            notes: ["usageHistory has no recognized columns — schema drift"],
          };
        }
        for (const col of ["promptTokens", "completionTokens", "cost"]) {
          if (!columns.includes(col)) notes.push(`column missing: usageHistory.${col}`);
        }
        const tsColumn = ["timestamp", "createdAt", "created_at"].find((c) => columns.includes(c));
        if (!tsColumn && sinceMs !== null) {
          notes.push("no timestamp column — sinceMs filter not applied");
        }

        const selectList = selected.map((c) => `"${c}"`).join(", ");
        const rows = db
          .prepare(
            `SELECT ${selectList} FROM usageHistory ORDER BY rowid DESC LIMIT ${MAX_USAGE_ROWS + 1}`,
          )
          .all();
        if (rows.length > MAX_USAGE_ROWS) {
          rows.length = MAX_USAGE_ROWS;
          notes.push(`row scan capped at ${MAX_USAGE_ROWS} most recent rows`);
        }

        const totals = emptyTotals();
        const byProvider = {};
        const byModel = {};
        const byStatus = {};
        for (const row of rows) {
          if (sinceMs !== null && tsColumn) {
            const tsMs = parseTimestampMs(row[tsColumn]);
            if (tsMs !== null && tsMs < sinceMs) continue;
          }
          addRowToTotals(totals, row);
          const provider = row.provider || "unknown";
          const model = row.model || "unknown";
          if (!byProvider[provider]) byProvider[provider] = emptyTotals();
          if (!byModel[model]) byModel[model] = emptyTotals();
          addRowToTotals(byProvider[provider], row);
          addRowToTotals(byModel[model], row);
          const statusKey = row.status || "unknown";
          byStatus[statusKey] = (byStatus[statusKey] || 0) + 1;
        }

        return {
          available: true,
          totals: roundCost(totals),
          byProvider: groupToSortedArray(byProvider, "provider"),
          byModel: groupToSortedArray(byModel, "model"),
          byStatus,
          notes,
        };
      });
    } catch (e) {
      return { available: false, reason: e.message };
    }
  }

  /**
   * Daily aggregates from usageDaily (dateKey + JSON data blob), newest first.
   * @param {number} [days]
   */
  async function getDaily(days = DEFAULT_DAILY_DAYS) {
    const status = describe();
    if (!status.available) return { available: false, reason: status.reason };
    const limit =
      Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 366) : DEFAULT_DAILY_DAYS;

    try {
      return withDb((db, tables, columnsOf) => {
        if (!tables.includes("usageDaily")) {
          return { available: true, days: [], notes: ["usageDaily table missing"] };
        }
        const columns = columnsOf("usageDaily");
        if (!columns.includes("dateKey")) {
          return { available: true, days: [], notes: ["usageDaily.dateKey column missing"] };
        }
        const hasData = columns.includes("data");
        const select = hasData ? '"dateKey", "data"' : '"dateKey"';
        const rows = db
          .prepare(`SELECT ${select} FROM usageDaily ORDER BY "dateKey" DESC LIMIT ${limit}`)
          .all();

        const result = rows.map((row) => {
          const entry = { date: row.dateKey };
          if (!hasData) return { ...entry, note: "no data column" };
          try {
            const parsed = JSON.parse(row.data);
            return { ...entry, summary: parsed };
          } catch (e) {
            return { ...entry, note: "unparseable data blob" };
          }
        });
        return { available: true, days: result, notes: [] };
      });
    } catch (e) {
      return { available: false, reason: e.message };
    }
  }

  /** Provider connections with auth payloads and PII redacted. */
  async function getConnections() {
    const status = describe();
    if (!status.available) return { available: false, reason: status.reason };

    try {
      return withDb((db, tables, columnsOf) => {
        if (!tables.includes("providerConnections")) {
          return { available: true, connections: [], notes: ["providerConnections table missing"] };
        }
        const columns = columnsOf("providerConnections");
        // Whitelist only — `data` (auth payload) and `email` (PII) never selected.
        const wanted = [
          "id",
          "provider",
          "authType",
          "name",
          "priority",
          "isActive",
          "createdAt",
          "updatedAt",
        ];
        const selected = wanted.filter((c) => columns.includes(c));
        if (selected.length === 0) {
          return { available: true, connections: [], notes: ["no recognized columns"] };
        }
        const selectList = selected.map((c) => `"${c}"`).join(", ");
        const connections = db.prepare(`SELECT ${selectList} FROM providerConnections`).all();
        return { available: true, connections, notes: [] };
      });
    } catch (e) {
      return { available: false, reason: e.message };
    }
  }

  const status = describe();
  return {
    source: "nine-router",
    available: status.available,
    reason: status.reason,
    describe,
    getUsage,
    getDaily,
    getConnections,
  };
}

module.exports = { createNineRouterSource, parseTimestampMs };
