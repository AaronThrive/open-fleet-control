/**
 * Alert history — persistent JSONL log of every FIRED alert.
 *
 * One JSON object per line appended to `logs/alerts.jsonl` (post-dedupe,
 * post-rule, post-mute — only alerts that actually fired). Mirrors the
 * audit trail's rotation/query pattern:
 *
 *   Rotation: when alerts.jsonl reaches 20MB it is renamed to
 *   `alerts.<stamp>.jsonl` (ISO timestamp, filesystem-safe) and a fresh file
 *   is started. At most 5 rotated files are kept; older ones are deleted.
 *
 *   query() reads the active file plus rotated files newest-first, filters
 *   by type/node/severity/since, and returns newest-first entries capped at
 *   `limit` (default 200, hard max 500). Malformed lines are skipped.
 *
 * Append failures are logged and never thrown — history is best-effort and
 * must never break alert delivery.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ACTIVE_LOG = "alerts.jsonl";
const ROTATED_RE = /^alerts\..+\.jsonl$/;
const DEFAULT_MAX_LOG_BYTES = 20 * 1024 * 1024; // 20MB rotation threshold
const DEFAULT_MAX_ROTATED_FILES = 5;
const DEFAULT_QUERY_LIMIT = 200;
const MAX_QUERY_LIMIT = 500;
const SEVERITIES = new Set(["info", "warn", "critical"]);

/**
 * Convert a since value (ISO string, Date, or epoch ms) to epoch ms.
 * @param {string|number|Date} value
 * @returns {number} epoch milliseconds
 * @throws {Error} when the value cannot be parsed
 */
function toEpochMs(value) {
  let ms;
  if (value instanceof Date) {
    ms = value.getTime();
  } else if (typeof value === "number") {
    ms = value;
  } else if (typeof value === "string") {
    // Accept both epoch-ms strings ("1717…") and ISO timestamps.
    ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  } else {
    throw new Error("Invalid since: expected ISO string, Date, or epoch milliseconds");
  }
  if (!Number.isFinite(ms)) {
    throw new Error("Invalid since: could not parse as a timestamp");
  }
  return ms;
}

/**
 * Create an alert history store bound to a logs directory.
 *
 * @param {object} options
 * @param {string} options.logsDir - directory holding alerts.jsonl (+ rotated files)
 * @param {number} [options.maxBytes=20MB] - rotation threshold (injectable for tests)
 * @param {number} [options.keepFiles=5] - rotated files kept
 * @returns {{append: function, query: function}}
 */
function createAlertHistory({
  logsDir,
  maxBytes = DEFAULT_MAX_LOG_BYTES,
  keepFiles = DEFAULT_MAX_ROTATED_FILES,
} = {}) {
  if (typeof logsDir !== "string" || logsDir.length === 0) {
    throw new Error("createAlertHistory requires a logsDir option");
  }

  const activePath = path.join(logsDir, ACTIVE_LOG);

  function listRotatedFiles() {
    let entries = [];
    try {
      entries = fs.readdirSync(logsDir);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    return entries.filter((name) => name !== ACTIVE_LOG && ROTATED_RE.test(name)).sort(); // lexical = chronological (ISO stamps)
  }

  function rotateIfNeeded() {
    let size = 0;
    try {
      size = fs.statSync(activePath).size;
    } catch (e) {
      return; // No active file yet — nothing to rotate.
    }
    if (size < maxBytes) return;

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let rotatedPath = path.join(logsDir, `alerts.${stamp}.jsonl`);
    if (fs.existsSync(rotatedPath)) {
      rotatedPath = path.join(
        logsDir,
        `alerts.${stamp}-${crypto.randomBytes(3).toString("hex")}.jsonl`,
      );
    }
    fs.renameSync(activePath, rotatedPath);

    const rotated = listRotatedFiles();
    const excess = rotated.length - keepFiles;
    for (let i = 0; i < excess; i++) {
      try {
        fs.unlinkSync(path.join(logsDir, rotated[i]));
      } catch (e) {
        console.error("[AlertHistory] Failed to prune rotated log:", rotated[i], e.message);
      }
    }
  }

  /**
   * Append one fired alert. Best-effort: failures are logged, never thrown.
   * @param {object} alert - normalized alert record ({id, type, severity, node, task, message, ts})
   */
  function append(alert) {
    try {
      fs.mkdirSync(logsDir, { recursive: true });
      rotateIfNeeded();
      fs.appendFileSync(activePath, JSON.stringify(alert) + "\n", "utf8");
    } catch (e) {
      console.error("[AlertHistory] Append failed:", e.message);
    }
  }

  function readEntries(filePath) {
    let content;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch (e) {
      return [];
    }
    const entries = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && parsed.type && Number.isFinite(parsed.ts)) {
          entries.push(parsed);
        }
      } catch (e) {
        // Skip malformed lines — history must stay readable.
      }
    }
    return entries;
  }

  /**
   * Query alert history, newest-first.
   *
   * @param {object} [options]
   * @param {string} [options.type] - exact alert type match
   * @param {string} [options.node] - exact node match
   * @param {string} [options.severity] - info|warn|critical
   * @param {string|number|Date} [options.since] - inclusive lower bound on ts
   * @param {number} [options.limit=200] - max entries (hard cap 500)
   * @returns {Array<object>} matching entries, newest first
   */
  function query({ type, node, severity, since, limit = DEFAULT_QUERY_LIMIT } = {}) {
    const parsedLimit = Number(limit);
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
      throw new Error("Query limit must be a positive number");
    }
    const cap = Math.min(Math.floor(parsedLimit), MAX_QUERY_LIMIT);
    const sinceMs = since === undefined || since === null || since === "" ? null : toEpochMs(since);
    if (severity !== undefined && severity !== null && !SEVERITIES.has(severity)) {
      throw new Error(`Invalid severity filter "${String(severity)}"`);
    }

    const matches = (rec) => {
      if (type && rec.type !== type) return false;
      if (node && rec.node !== node) return false;
      if (severity && rec.severity !== severity) return false;
      if (sinceMs !== null && rec.ts < sinceMs) return false;
      return true;
    };

    // Files newest-first: active log, then rotated files in reverse order.
    // Lines within each file are chronological, so iterate them in reverse.
    const files = [
      activePath,
      ...listRotatedFiles()
        .reverse()
        .map((f) => path.join(logsDir, f)),
    ];
    const results = [];
    for (const filePath of files) {
      if (results.length >= cap) break;
      const entries = readEntries(filePath);
      for (let i = entries.length - 1; i >= 0 && results.length < cap; i--) {
        if (matches(entries[i])) results.push(entries[i]);
      }
    }

    // Defensive: guarantee newest-first ordering even with odd timestamps.
    return results.sort((a, b) => b.ts - a.ts);
  }

  return { append, query };
}

module.exports = { createAlertHistory, MAX_QUERY_LIMIT };
