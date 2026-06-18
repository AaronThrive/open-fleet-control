/**
 * Spawn Store — durable SQLite bits for the on-demand isolated-worker pool.
 *
 * Implements two tables (AC-13 + AC-14) using the node:sqlite DatabaseSync
 * idiom from src/fleet-chat.js — NO better-sqlite3.
 *
 *   1. slack_event_dedup  — exactly-once Slack event handling
 *      insertDedup(eventId) → { isDuplicate: boolean }
 *      pruneDedup()         → number of rows deleted
 *
 *   2. fencing_counter    — monotonic, crash-durable token
 *      nextToken()          → number (strictly increasing across restarts)
 *
 * Result-sink helper:
 *   createResultSink()     → { accept(nodeId, generation, token, result), reset() }
 *   accept() returns true when the result is accepted (token ≥ latest seen for
 *   that (nodeId, generation)) and false when it is stale/rejected.
 *
 * PRAGMAs: journal_mode=WAL, synchronous=NORMAL, busy_timeout=5000
 */

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DB_FILE_NAME = "spawn-store.db";
const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Create the spawn store.
 *
 * @param {object} options
 * @param {string} options.stateDir - directory for the SQLite database (beside fleet-chat.db)
 * @param {function} [options.nowFn=Date.now] - injectable clock for tests
 * @returns {{insertDedup: function, pruneDedup: function, nextToken: function, createResultSink: function, close: function}}
 */
function createSpawnStore({ stateDir, nowFn = Date.now } = {}) {
  if (typeof stateDir !== "string" || stateDir.length === 0) {
    throw new TypeError("stateDir must be a non-empty string");
  }

  fs.mkdirSync(stateDir, { recursive: true });

  const db = new DatabaseSync(path.join(stateDir, DB_FILE_NAME));

  // PRAGMAs — mirror fleet-chat.js
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA busy_timeout=5000");

  // -------------------------------------------------------------------------
  // Table 1: slack_event_dedup (AC-13)
  // -------------------------------------------------------------------------

  db.exec(`
    CREATE TABLE IF NOT EXISTS slack_event_dedup (
      event_id  TEXT    PRIMARY KEY,
      seen_at   INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);

  const insertDedupStmt = db.prepare(`
    INSERT INTO slack_event_dedup (event_id, seen_at, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT (event_id) DO NOTHING
  `);

  const pruneExpiredStmt = db.prepare("DELETE FROM slack_event_dedup WHERE expires_at < ?");

  /**
   * Record a Slack event_id. Uses INSERT … ON CONFLICT DO NOTHING.
   * Lazy GC: prunes expired rows on every insert.
   *
   * @param {string} eventId
   * @returns {{ isDuplicate: boolean }}
   */
  function insertDedup(eventId) {
    if (typeof eventId !== "string" || eventId.length === 0) {
      throw new TypeError("eventId must be a non-empty string");
    }
    const now = nowFn();
    const result = insertDedupStmt.run(eventId, now, now + DEDUP_TTL_MS);
    // Lazy GC — mirror fleet-chat.js prune() pattern
    pruneExpiredStmt.run(now);
    return { isDuplicate: Number(result.changes) === 0 };
  }

  /**
   * Manually prune expired dedup rows (useful for tests / explicit GC).
   * @returns {number} rows deleted
   */
  function pruneDedup() {
    const result = pruneExpiredStmt.run(nowFn());
    return Number(result.changes);
  }

  // -------------------------------------------------------------------------
  // Table 2: fencing_counter (AC-14)
  // -------------------------------------------------------------------------

  db.exec(`
    CREATE TABLE IF NOT EXISTS fencing_counter (
      id    INTEGER PRIMARY KEY CHECK(id = 1),
      value INTEGER NOT NULL
    )
  `);

  // Seed with 0 once — INSERT OR IGNORE so it is idempotent across reboots.
  db.exec("INSERT OR IGNORE INTO fencing_counter (id, value) VALUES (1, 0)");

  const nextTokenStmt = db.prepare(
    "UPDATE fencing_counter SET value = value + 1 WHERE id = 1 RETURNING value",
  );

  /**
   * Return a strictly-increasing fencing token (persisted across restarts).
   * @returns {number}
   */
  function nextToken() {
    const row = nextTokenStmt.get();
    return Number(row.value);
  }

  // -------------------------------------------------------------------------
  // Table 3: result_high_water (M-4)
  //
  // Durable per-(nodeId, generation) high-water mark of the highest accepted
  // result token. The result sink's staleness guard MUST survive a process
  // restart: an in-memory-only map resets on restart, so a post-OOM-restart
  // zombie result carrying an old-but-nonzero token would be wrongly accepted.
  // Persisting the high-water mark here means a fresh sink on the same DB still
  // rejects a token that was already superseded before the crash.
  // -------------------------------------------------------------------------

  db.exec(`
    CREATE TABLE IF NOT EXISTS result_high_water (
      node_id    TEXT    NOT NULL,
      generation INTEGER NOT NULL,
      token      INTEGER NOT NULL,
      PRIMARY KEY (node_id, generation)
    )
  `);

  const getHighWaterStmt = db.prepare(
    "SELECT token FROM result_high_water WHERE node_id = ? AND generation = ?",
  );

  // Insert-or-raise: only advances the stored token when the new one is higher.
  // The WHERE on the DO UPDATE makes a stale (lower) token a no-op write.
  const upsertHighWaterStmt = db.prepare(`
    INSERT INTO result_high_water (node_id, generation, token)
    VALUES (?, ?, ?)
    ON CONFLICT (node_id, generation) DO UPDATE SET token = excluded.token
      WHERE excluded.token > result_high_water.token
  `);

  const clearHighWaterStmt = db.prepare("DELETE FROM result_high_water");

  // -------------------------------------------------------------------------
  // Result sink (AC-14 cont.)
  // -------------------------------------------------------------------------

  /**
   * Create a result sink that rejects stale-token results.
   *
   * Tracks the highest accepted token for each (nodeId, generation) pair in a
   * DURABLE sqlite table (M-4), so the fencing guarantee survives a process
   * restart: a fresh sink on the same DB still rejects a token that was already
   * superseded before the crash. An in-memory map fronts the table purely as a
   * read cache; the table is the source of truth.
   *
   * @returns {{ accept: function, reset: function }}
   */
  function createResultSink() {
    // Hot cache: `${nodeId}:${generation}` → highest accepted token. Authoritative
    // value lives in result_high_water; the cache only avoids a read per accept.
    const highWater = new Map();

    function durableHighWater(nodeId, generation) {
      const row = getHighWaterStmt.get(nodeId, generation);
      return row && row.token != null ? Number(row.token) : undefined;
    }

    /**
     * @param {string} nodeId
     * @param {number} generation
     * @param {number} token
     * @param {*} result
     * @returns {{ accepted: boolean, reason: string|null }}
     */
    function accept(nodeId, generation, token, result) {
      if (typeof nodeId !== "string" || nodeId.length === 0) {
        throw new TypeError("nodeId must be a non-empty string");
      }
      if (!Number.isFinite(generation)) {
        throw new TypeError("generation must be a finite number");
      }
      if (!Number.isFinite(token)) {
        throw new TypeError("token must be a finite number");
      }

      const key = `${nodeId}:${generation}`;
      // Source of truth is the durable table; fall back to the cache only when
      // the table has no row yet (and reconcile the cache from the table so a
      // restart's first read is correct).
      let current = durableHighWater(nodeId, generation);
      if (current === undefined) current = highWater.get(key);

      if (current !== undefined && token < current) {
        return { accepted: false, reason: "stale_token" };
      }

      // Persist durably (monotonic: the WHERE clause ignores a non-advancing
      // token), then refresh the cache.
      upsertHighWaterStmt.run(nodeId, generation, token);
      highWater.set(key, Math.max(current === undefined ? token : current, token));
      return { accepted: true, reason: null, result };
    }

    /**
     * Reset all high-water marks — both the in-memory cache AND the durable
     * table (explicit operator/test action). NOTE: this is distinct from the
     * M-4 durability guarantee, which is about a process RESTART (a fresh sink
     * that never calls reset() still sees the persisted marks). reset() is the
     * deliberate "forget everything" escape hatch, not a restart.
     */
    function reset() {
      highWater.clear();
      clearHighWaterStmt.run();
    }

    return { accept, reset };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  function close() {
    try {
      db.close();
    } catch (e) {
      console.error("[SpawnStore] Failed to close database:", e.message);
    }
  }

  return { insertDedup, pruneDedup, nextToken, createResultSink, close };
}

module.exports = { createSpawnStore };
