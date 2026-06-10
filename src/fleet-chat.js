/**
 * Fleet Chat — agent-to-agent message bus.
 *
 * In-memory pub/sub with a durable trail:
 *  - every message is appended as one JSON line to logs/fleet-chat.jsonl
 *    (rotated when it exceeds 50MB, keeping the last 5 rotated files)
 *  - full history lives in SQLite (node:sqlite DatabaseSync) at
 *    state/fleet-chat.db for filtered querying and retention pruning
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const MAX_NAME_CHARS = 128;
const MAX_PAYLOAD_BYTES = 32 * 1024;
const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_LIMIT = 500;
const DEFAULT_MAX_LOG_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_ROTATED_FILES = 5;
const DEFAULT_PRUNE_MAX_AGE_DAYS = 30;
const DEFAULT_PRUNE_MAX_ROWS = 100000;
const RECENT_STATE_LIMIT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_FILE_NAME = "fleet-chat.jsonl";
const DB_FILE_NAME = "fleet-chat.db";

/**
 * Validate an incoming message shape, throwing descriptive errors.
 * @param {object} msg
 */
function validateMessage(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    throw new TypeError("message must be an object");
  }
  if (typeof msg.sender !== "string" || msg.sender.length === 0) {
    throw new TypeError("sender must be a non-empty string");
  }
  if (msg.sender.length > MAX_NAME_CHARS) {
    throw new TypeError(`sender must be at most ${MAX_NAME_CHARS} characters`);
  }
  if (typeof msg.receiver !== "string" || msg.receiver.length === 0) {
    throw new TypeError("receiver must be a non-empty string");
  }
  if (msg.receiver.length > MAX_NAME_CHARS) {
    throw new TypeError(`receiver must be at most ${MAX_NAME_CHARS} characters`);
  }
  if (typeof msg.payload !== "string") {
    throw new TypeError("payload must be a string");
  }
  if (Buffer.byteLength(msg.payload, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new TypeError(`payload must be at most ${MAX_PAYLOAD_BYTES} bytes`);
  }
  if (msg.toolCalls !== undefined && !Array.isArray(msg.toolCalls)) {
    throw new TypeError("toolCalls must be an array when provided");
  }
}

// Short prefixed id, e.g. msg_a1b2c3d4e5f6
function generateMessageId() {
  return `msg_${crypto.randomBytes(6).toString("hex")}`;
}

// Escape LIKE wildcards so user text is matched literally.
function escapeLikePattern(text) {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Create the fleet chat message bus.
 *
 * @param {object} options
 * @param {string} options.stateDir - Directory for the SQLite database
 * @param {string} options.logsDir - Directory for the JSONL message log
 * @param {number} [options.maxLogBytes=52428800] - JSONL rotation threshold
 * @param {number} [options.maxRotatedFiles=5] - Rotated JSONL files to keep
 * @param {function} [options.nowFn=Date.now] - Injectable clock for tests
 * @returns {{publish: function, onMessage: function, query: function, prune: function, getState: function, close: function}}
 */
function createFleetChat({
  stateDir,
  logsDir,
  maxLogBytes = DEFAULT_MAX_LOG_BYTES,
  maxRotatedFiles = DEFAULT_MAX_ROTATED_FILES,
  nowFn = Date.now,
} = {}) {
  if (typeof stateDir !== "string" || stateDir.length === 0) {
    throw new TypeError("stateDir must be a non-empty string");
  }
  if (typeof logsDir !== "string" || logsDir.length === 0) {
    throw new TypeError("logsDir must be a non-empty string");
  }

  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  const logFile = path.join(logsDir, LOG_FILE_NAME);
  const db = new DatabaseSync(path.join(stateDir, DB_FILE_NAME));

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender TEXT NOT NULL,
      receiver TEXT NOT NULL,
      payload TEXT NOT NULL,
      tool_calls TEXT,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
    CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver);
    CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
  `);

  const insertStmt = db.prepare(
    "INSERT INTO messages (id, sender, receiver, payload, tool_calls, ts) VALUES (?, ?, ?, ?, ?, ?)",
  );

  const subscribers = new Set();

  function rowToMessage(row) {
    const message = {
      id: row.id,
      sender: row.sender,
      receiver: row.receiver,
      payload: row.payload,
      ts: Number(row.ts),
    };
    if (row.tool_calls != null) {
      try {
        message.toolCalls = JSON.parse(row.tool_calls);
      } catch (e) {
        console.error("[FleetChat] Failed to parse stored tool_calls:", e.message);
      }
    }
    return message;
  }

  // Delete oldest rotated logs beyond the retention count.
  function pruneRotatedLogs() {
    let rotated = [];
    try {
      rotated = fs
        .readdirSync(logsDir)
        .filter((f) => f.startsWith("fleet-chat.") && f.endsWith(".jsonl") && f !== LOG_FILE_NAME)
        .map((f) => {
          const fullPath = path.join(logsDir, f);
          return { name: f, mtime: fs.statSync(fullPath).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
    } catch (e) {
      console.error("[FleetChat] Failed to list rotated logs:", e.message);
      return;
    }

    for (const old of rotated.slice(maxRotatedFiles)) {
      try {
        fs.unlinkSync(path.join(logsDir, old.name));
      } catch (e) {
        console.error(`[FleetChat] Failed to delete rotated log ${old.name}:`, e.message);
      }
    }
  }

  // Rotate fleet-chat.jsonl to fleet-chat.<ISO-date>.jsonl when oversized.
  function rotateLogIfNeeded() {
    let size = 0;
    try {
      size = fs.statSync(logFile).size;
    } catch (e) {
      return; // No log file yet — nothing to rotate
    }
    if (size <= maxLogBytes) return;

    const stamp = new Date(nowFn()).toISOString().replace(/[:.]/g, "-");
    let target = path.join(logsDir, `fleet-chat.${stamp}.jsonl`);
    let counter = 1;
    while (fs.existsSync(target)) {
      target = path.join(logsDir, `fleet-chat.${stamp}-${counter}.jsonl`);
      counter += 1;
    }

    try {
      fs.renameSync(logFile, target);
    } catch (e) {
      console.error("[FleetChat] Log rotation failed:", e.message);
      return;
    }
    pruneRotatedLogs();
  }

  function appendToLog(record) {
    fs.appendFileSync(logFile, `${JSON.stringify(record)}\n`, "utf8");
    rotateLogIfNeeded();
  }

  /**
   * Publish a message to the bus. Persists to SQLite + JSONL, then fans out
   * to all subscribers. Returns the stored record (with assigned id/ts).
   *
   * @param {{sender: string, receiver: string, payload: string, toolCalls?: Array}} msg
   * @returns {object} The stored message record
   */
  function publish(msg) {
    validateMessage(msg);

    const record = {
      id: generateMessageId(),
      sender: msg.sender,
      receiver: msg.receiver,
      payload: msg.payload,
      ts: nowFn(),
    };
    if (msg.toolCalls !== undefined) {
      record.toolCalls = msg.toolCalls;
    }

    insertStmt.run(
      record.id,
      record.sender,
      record.receiver,
      record.payload,
      record.toolCalls !== undefined ? JSON.stringify(record.toolCalls) : null,
      record.ts,
    );

    appendToLog(record);

    for (const cb of subscribers) {
      try {
        cb(record);
      } catch (e) {
        console.error("[FleetChat] Subscriber callback failed:", e.message);
      }
    }

    return record;
  }

  /**
   * Subscribe to published messages (for SSE fan-out).
   *
   * @param {function} cb - Called with each published message record
   * @returns {function} Unsubscribe function
   */
  function onMessage(cb) {
    if (typeof cb !== "function") {
      throw new TypeError("callback must be a function");
    }
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  }

  /**
   * Query message history with optional filters. Always parameterized.
   *
   * @param {object} [filters]
   * @param {string} [filters.sender] - Exact sender match
   * @param {string} [filters.receiver] - Exact receiver match
   * @param {string} [filters.text] - Substring match on payload (LIKE)
   * @param {number} [filters.limit=100] - Max rows (capped at 500)
   * @param {number} [filters.before] - Only messages with ts < before
   * @returns {Array<object>} Messages, newest first
   */
  function query({ sender, receiver, text, limit = DEFAULT_QUERY_LIMIT, before } = {}) {
    const conditions = [];
    const params = [];

    if (sender !== undefined) {
      if (typeof sender !== "string") throw new TypeError("sender filter must be a string");
      conditions.push("sender = ?");
      params.push(sender);
    }
    if (receiver !== undefined) {
      if (typeof receiver !== "string") throw new TypeError("receiver filter must be a string");
      conditions.push("receiver = ?");
      params.push(receiver);
    }
    if (text !== undefined) {
      if (typeof text !== "string") throw new TypeError("text filter must be a string");
      conditions.push("payload LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLikePattern(text)}%`);
    }
    if (before !== undefined) {
      if (!Number.isFinite(before)) throw new TypeError("before filter must be a number");
      conditions.push("ts < ?");
      params.push(before);
    }

    const parsedLimit = Number(limit);
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
      throw new TypeError("limit must be a positive number");
    }
    const effectiveLimit = Math.min(Math.floor(parsedLimit), MAX_QUERY_LIMIT);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT id, sender, receiver, payload, tool_calls, ts FROM messages ${where} ORDER BY ts DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...params, effectiveLimit);

    return rows.map(rowToMessage);
  }

  /**
   * Retention: delete messages older than maxAgeDays and keep at most
   * maxRows newest rows. Also enforces JSONL rotation retention.
   *
   * @param {object} [options]
   * @param {number} [options.maxAgeDays=30]
   * @param {number} [options.maxRows=100000]
   * @returns {{removedByAge: number, removedByCount: number, removed: number}}
   */
  function prune({
    maxAgeDays = DEFAULT_PRUNE_MAX_AGE_DAYS,
    maxRows = DEFAULT_PRUNE_MAX_ROWS,
  } = {}) {
    if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
      throw new TypeError("maxAgeDays must be a non-negative number");
    }
    if (!Number.isFinite(maxRows) || maxRows < 0) {
      throw new TypeError("maxRows must be a non-negative number");
    }

    const cutoff = nowFn() - maxAgeDays * DAY_MS;
    const byAge = db.prepare("DELETE FROM messages WHERE ts < ?").run(cutoff);
    const byCount = db
      .prepare(
        "DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY ts DESC, id DESC LIMIT ?)",
      )
      .run(Math.floor(maxRows));

    rotateLogIfNeeded();
    pruneRotatedLogs();

    const removedByAge = Number(byAge.changes);
    const removedByCount = Number(byCount.changes);
    return { removedByAge, removedByCount, removed: removedByAge + removedByCount };
  }

  /**
   * Recent messages + counts for the unified state endpoint.
   * @returns {{messages: Array<object>, counts: {total: number, senders: number, receivers: number}, subscribers: number}}
   */
  function getState() {
    const totals = db
      .prepare(
        "SELECT COUNT(*) AS total, COUNT(DISTINCT sender) AS senders, COUNT(DISTINCT receiver) AS receivers FROM messages",
      )
      .get();

    return {
      messages: query({ limit: RECENT_STATE_LIMIT }),
      counts: {
        total: Number(totals.total),
        senders: Number(totals.senders),
        receivers: Number(totals.receivers),
      },
      subscribers: subscribers.size,
    };
  }

  // Close the underlying SQLite database (for tests/shutdown).
  function close() {
    try {
      db.close();
    } catch (e) {
      console.error("[FleetChat] Failed to close database:", e.message);
    }
  }

  return { publish, onMessage, query, prune, getState, close };
}

module.exports = { createFleetChat };
