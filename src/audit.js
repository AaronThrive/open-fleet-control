/**
 * Audit — append-only audit trail (JSONL).
 *
 * Records who did what, when: one JSON object per line appended to
 * `logs/audit.jsonl`. The `user` value comes from the Tailscale identity
 * header (the caller passes it through); it defaults to "anonymous".
 *
 * Allowed actions (the documented enum — anything else is rejected):
 *   task.create, task.move, task.update, task.delete, task.comment,
 *   brief.write, brief.delete,
 *   lesson.add, lesson.approve, lesson.reject, gate.toggle,
 *   node.register, node.unregister,
 *   alerts.config, memory.write, session.kill,
 *   cron.update, cron.run, org.update,
 *   settings.update, chat.publish, topic.status, operator.save,
 *   action.execute, alert.test, cache.clear,
 *   job.run, job.update, service.restart,
 *   digest.test, budgets.ack
 *
 * Rotation: when audit.jsonl reaches 50MB it is renamed to
 * `audit.<date>.jsonl` (ISO timestamp, filesystem-safe) and a fresh file is
 * started. At most 10 rotated files are kept; older ones are deleted.
 *
 * query() reads the active file plus rotated files newest-first, filters by
 * user/action/since/until, and returns newest-first entries capped at
 * `limit` (default 200, hard max 1000). Malformed lines are skipped.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const AUDIT_ACTIONS = [
  "task.create",
  "task.move",
  "task.update",
  "task.delete",
  "task.comment",
  "brief.write",
  "brief.delete",
  "lesson.add",
  "lesson.approve",
  "lesson.reject",
  "gate.toggle",
  "node.register",
  "node.unregister",
  "alerts.config",
  "memory.write",
  "session.kill",
  "cron.update",
  "cron.run",
  "org.update",
  "settings.update",
  "chat.publish",
  "topic.status",
  "operator.save",
  "action.execute",
  "alert.test",
  "cache.clear",
  "job.run",
  "job.update",
  "service.restart",
  "digest.test",
  "budgets.ack",
];

const ACTIVE_LOG = "audit.jsonl";
const ROTATED_RE = /^audit\..+\.jsonl$/;
const MAX_LOG_BYTES = 50 * 1024 * 1024; // 50MB rotation threshold
const MAX_ROTATED_FILES = 10;
const DEFAULT_QUERY_LIMIT = 200;
const MAX_QUERY_LIMIT = 1000;

/**
 * Convert a since/until value (ISO string, Date, or epoch ms) to epoch ms.
 * @param {string|number|Date} value
 * @param {string} label - parameter name for error messages
 * @returns {number} epoch milliseconds
 */
function toEpochMs(value, label) {
  let ms;
  if (value instanceof Date) {
    ms = value.getTime();
  } else if (typeof value === "number") {
    ms = value;
  } else if (typeof value === "string") {
    ms = Date.parse(value);
  } else {
    throw new Error(`Invalid ${label}: expected ISO string, Date, or epoch milliseconds`);
  }
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid ${label}: could not parse as a timestamp`);
  }
  return ms;
}

/**
 * Creates an audit trail bound to a logs directory.
 *
 * @param {object} options
 * @param {string} options.logsDir - directory holding audit.jsonl (+ rotated files)
 * @returns {{record: function, query: function}}
 */
function createAudit({ logsDir } = {}) {
  if (typeof logsDir !== "string" || logsDir.length === 0) {
    throw new Error("createAudit requires a logsDir option");
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
    if (size < MAX_LOG_BYTES) return;

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let rotatedPath = path.join(logsDir, `audit.${stamp}.jsonl`);
    if (fs.existsSync(rotatedPath)) {
      rotatedPath = path.join(
        logsDir,
        `audit.${stamp}-${crypto.randomBytes(3).toString("hex")}.jsonl`,
      );
    }
    fs.renameSync(activePath, rotatedPath);

    // Keep only the newest MAX_ROTATED_FILES rotated files.
    const rotated = listRotatedFiles();
    const excess = rotated.length - MAX_ROTATED_FILES;
    for (let i = 0; i < excess; i++) {
      try {
        fs.unlinkSync(path.join(logsDir, rotated[i]));
      } catch (e) {
        console.error("[Audit] Failed to prune rotated log:", rotated[i], e.message);
      }
    }
  }

  /**
   * Append an audit entry. Validates the action against AUDIT_ACTIONS.
   * @param {object} entry
   * @param {string} [entry.user] - Tailscale identity (default "anonymous")
   * @param {string} entry.action - one of AUDIT_ACTIONS
   * @param {string} [entry.target] - object the action applied to
   * @param {object|string} [entry.detail] - extra JSON-serializable context
   * @returns {object} the recorded entry (with id + server ts)
   */
  function record(entry) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Audit entry must be an object");
    }
    const { user, action, target, detail } = entry;
    if (typeof action !== "string" || !AUDIT_ACTIONS.includes(action)) {
      throw new Error(
        `Invalid audit action "${String(action)}". Allowed: ${AUDIT_ACTIONS.join(", ")}`,
      );
    }
    if (user !== undefined && user !== null && typeof user !== "string") {
      throw new Error("Audit user must be a string when provided");
    }
    if (target !== undefined && target !== null && typeof target !== "string") {
      throw new Error("Audit target must be a string when provided");
    }

    const rec = {
      id: `aud_${crypto.randomBytes(8).toString("hex")}`,
      ts: new Date().toISOString(),
      user: user && user.trim().length > 0 ? user.trim() : "anonymous",
      action,
      target: target || null,
      detail: detail === undefined ? null : detail,
    };

    let line;
    try {
      line = JSON.stringify(rec);
    } catch (e) {
      throw new Error("Audit detail must be JSON-serializable");
    }

    fs.mkdirSync(logsDir, { recursive: true });
    rotateIfNeeded();
    fs.appendFileSync(activePath, line + "\n", "utf8");
    return rec;
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
        if (parsed && typeof parsed === "object" && parsed.ts && parsed.action) {
          entries.push(parsed);
        }
      } catch (e) {
        // Skip malformed lines — the trail must stay readable.
      }
    }
    return entries;
  }

  /**
   * Query the audit trail, newest-first.
   * @param {object} [options]
   * @param {string} [options.user] - exact user match
   * @param {string} [options.action] - exact action match
   * @param {string|number|Date} [options.since] - inclusive lower bound on ts
   * @param {string|number|Date} [options.until] - inclusive upper bound on ts
   * @param {number} [options.limit=200] - max entries (hard cap 1000)
   * @returns {Array<object>} matching entries, newest first
   */
  function query({ user, action, since, until, limit = DEFAULT_QUERY_LIMIT } = {}) {
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) {
      throw new Error("Query limit must be a positive number");
    }
    const cap = Math.min(Math.floor(limit), MAX_QUERY_LIMIT);
    const sinceMs = since === undefined || since === null ? null : toEpochMs(since, "since");
    const untilMs = until === undefined || until === null ? null : toEpochMs(until, "until");
    if (action !== undefined && action !== null && !AUDIT_ACTIONS.includes(action)) {
      throw new Error(`Invalid audit action filter "${String(action)}"`);
    }

    const matches = (rec) => {
      if (user && rec.user !== user) return false;
      if (action && rec.action !== action) return false;
      if (sinceMs !== null || untilMs !== null) {
        const tsMs = Date.parse(rec.ts);
        if (!Number.isFinite(tsMs)) return false;
        if (sinceMs !== null && tsMs < sinceMs) return false;
        if (untilMs !== null && tsMs > untilMs) return false;
      }
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
    return results.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  }

  return { record, query };
}

module.exports = { createAudit, AUDIT_ACTIONS };
