/**
 * Run Archive — durable, reviewable record of board/chain orchestration runs.
 *
 * This is the PERSISTENCE backbone of the "Flight Recorder" tab. It is distinct
 * from src/flight-recorder.js (a read-only per-AGENT activity timeline that
 * collects sessions/kanban/audit/cron on the fly). This module instead records
 * one durable row per orchestration RUN — the council/chain that orchestrate.js
 * drives — so a completed run is reviewable long after it has been reaped from
 * the in-memory registry (which only lingers ~30 min, src/orchestrate.js).
 *
 * Persistence: node:sqlite DatabaseSync (the same idiom as src/fleet-chat.js and
 * src/spawn-store.js — NO better-sqlite3) at <stateDir>/flight-recorder.db.
 *
 * Two tables:
 *   runs       — one row per run. Carries a `node` column (this instance's id)
 *                FROM DAY ONE so a future multi-instance Phase 3 needs no schema
 *                change: rows already say which node produced them.
 *   run_seats  — one row per seat (board advisor) or step (chain), FK to runs.
 *                Holds {agent, status, result_text, duration_ms, error, seq}.
 *
 * Append-on-completion: archiveRun() is called once, when a run reaches a
 * terminal status (done/failed). It is idempotent on run_id (INSERT OR IGNORE)
 * so a double-emit never double-writes. Lazy prune: every archiveRun() drops
 * rows older than the retention window AND beyond the max-row cap, so the DB is
 * self-bounding without a background job.
 *
 * PRAGMAs: journal_mode=WAL, synchronous=NORMAL, busy_timeout=5000.
 */

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DB_FILE_NAME = "flight-recorder.db";

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_ROWS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

// Seat result text is the full advisor answer; cap stored length so one runaway
// answer cannot bloat the archive DB. The full answer still lives in the kanban
// attempt; this archive is a review surface, not the system of record.
const SEAT_TEXT_MAX = 20000;

const VALID_STATUSES = new Set(["running", "done", "failed"]);
const VALID_SEAT_STATUSES = new Set(["ok", "failed", "timeout", "skipped", "budget", "refused"]);

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function truncate(text, max) {
  if (typeof text !== "string") return text;
  return text.length <= max ? text : text.slice(0, max);
}

/** Epoch ms from an ISO string / epoch number, or null. */
function toMs(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Derive the per-seat rows from a settled orchestrate registry entry.
 *
 * BOARD runs expose `results[]` ({agent, taskId, text, ok, truncated}) plus
 * `missing[]` ({agent, taskId, reason}). A seat is "ok" when result.ok, else its
 * status comes from the matching missing reason (timeout/budget/dispatch refused).
 *
 * CHAIN runs expose `steps[]` ({agent, taskId, text, ok, truncated, skipped,
 * timedOut, error}). Status maps skipped→skipped, timedOut→timeout, error→refused,
 * ok→ok, else failed.
 *
 * Returns ordered seat descriptors with seq (dispatch order) preserved.
 *
 * @param {object} entry - orchestrate registry snapshot at settle time
 * @returns {Array<{seq, agent, taskId, status, resultText, error, truncated}>}
 */
function deriveSeats(entry) {
  const seats = [];
  if (!entry || typeof entry !== "object") return seats;

  if (entry.mode === "chain") {
    const steps = Array.isArray(entry.steps) ? entry.steps : [];
    steps.forEach((step, i) => {
      if (!step || typeof step !== "object") return;
      let status;
      if (step.skipped) status = "skipped";
      else if (step.timedOut) status = "timeout";
      else if (step.error) status = "refused";
      else if (step.ok) status = "ok";
      else status = "failed";
      seats.push({
        seq: i,
        agent: String(step.agent || "unknown"),
        taskId: step.taskId || null,
        status,
        resultText: typeof step.text === "string" ? step.text : null,
        error: typeof step.error === "string" ? step.error : null,
        truncated: !!step.truncated,
      });
    });
    return seats;
  }

  // BOARD (default). Merge results[] with the missing[] reasons by agent+taskId.
  const results = Array.isArray(entry.results) ? entry.results : [];
  const missing = Array.isArray(entry.missing) ? entry.missing : [];
  const reasonFor = (agent, taskId) => {
    const m = missing.find(
      (x) => x && x.agent === agent && (x.taskId === taskId || x.taskId == null),
    );
    return m ? String(m.reason || "missing") : null;
  };
  results.forEach((r, i) => {
    if (!r || typeof r !== "object") return;
    let status;
    if (r.ok) {
      status = "ok";
    } else {
      const reason = reasonFor(r.agent, r.taskId) || "";
      if (reason.startsWith("timeout")) status = "timeout";
      else if (reason.startsWith("budget")) status = "budget";
      else if (reason.startsWith("dispatch")) status = "refused";
      else status = "failed";
    }
    seats.push({
      seq: i,
      agent: String(r.agent || "unknown"),
      taskId: r.taskId || null,
      status,
      resultText: typeof r.text === "string" ? r.text : null,
      error: status === "refused" ? reasonFor(r.agent, r.taskId) : null,
      truncated: !!r.truncated,
    });
  });
  return seats;
}

/**
 * Map a settled orchestrate registry entry into a flat archive record (run +
 * seats). Pure; safe to unit-test in isolation. Derives a human title and the
 * run question from the entry where present.
 *
 * @param {object} entry - registry snapshot {runId, mode, status, agents,
 *   results|steps, missing, question, startedAt, endedAt, error, ...}
 * @param {object} [opts]
 * @param {string} [opts.node] - instance id stamped on the row
 * @param {string} [opts.title] - explicit title override
 * @returns {{run: object, seats: Array}|null}
 */
function runEntryToRecord(entry, opts = {}) {
  if (!entry || typeof entry !== "object" || !entry.runId) return null;
  const seats = deriveSeats(entry);
  const startedMs = toMs(entry.startedAt);
  const endedMs = toMs(entry.endedAt);
  const question =
    typeof entry.question === "string"
      ? entry.question
      : entry.mode === "chain" && typeof entry.title === "string"
        ? entry.title
        : null;
  const title =
    (typeof opts.title === "string" && opts.title) ||
    (typeof entry.title === "string" && entry.title) ||
    (entry.mode === "chain" ? "Chain run" : "Board run");

  const seatCount = seats.length;
  const okCount = seats.filter((s) => s.status === "ok").length;

  return {
    run: {
      runId: String(entry.runId),
      node: typeof opts.node === "string" && opts.node ? opts.node : "local",
      mode: entry.mode === "chain" ? "chain" : "board",
      title,
      question,
      status: VALID_STATUSES.has(entry.status) ? entry.status : "done",
      agents: Array.isArray(entry.agents) ? entry.agents.map(String) : [],
      seatCount,
      okCount,
      error: typeof entry.error === "string" ? entry.error : null,
      budgetHalt: entry.budgetHalt ? JSON.stringify(entry.budgetHalt) : null,
      startedAtMs: startedMs,
      endedAtMs: endedMs,
      durationMs: startedMs != null && endedMs != null ? Math.max(0, endedMs - startedMs) : null,
    },
    seats,
  };
}

/**
 * A run is considered a FAILURE worth alerting on when its overall status is
 * "failed", OR any seat timed out / failed / was refused. A clean board where
 * every advisor answered (or was only budget-skipped on purpose) does not alert.
 *
 * @param {{run: object, seats: Array}} record
 * @returns {boolean}
 */
function recordIsFailure(record) {
  if (!record || !record.run) return false;
  if (record.run.status === "failed") return true;
  return (record.seats || []).some(
    (s) => s.status === "timeout" || s.status === "failed" || s.status === "refused",
  );
}

/**
 * Create the run archive.
 *
 * @param {object} options
 * @param {string} options.stateDir - directory for the SQLite DB (beside fleet-chat.db)
 * @param {string} [options.node="local"] - this instance's id, stamped on rows
 * @param {number} [options.retentionDays=30] - rows older than this are pruned
 * @param {number} [options.maxRows=5000] - hard cap on archived runs (newest kept)
 * @param {function} [options.nowFn=Date.now] - injectable clock for tests
 * @returns {object} archive API
 */
function createRunArchive({
  stateDir,
  node = "local",
  retentionDays = DEFAULT_RETENTION_DAYS,
  maxRows = DEFAULT_MAX_ROWS,
  nowFn = Date.now,
} = {}) {
  if (typeof stateDir !== "string" || stateDir.length === 0) {
    throw new TypeError("stateDir must be a non-empty string");
  }
  const instanceNode = typeof node === "string" && node.length > 0 ? node : "local";
  const retentionMs =
    Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays * DAY_MS : null;
  const rowCap = Number.isFinite(maxRows) && maxRows > 0 ? Math.floor(maxRows) : null;

  fs.mkdirSync(stateDir, { recursive: true });
  const db = new DatabaseSync(path.join(stateDir, DB_FILE_NAME));

  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA foreign_keys=ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id       TEXT PRIMARY KEY,
      node         TEXT NOT NULL,
      mode         TEXT NOT NULL,
      title        TEXT NOT NULL,
      question     TEXT,
      status       TEXT NOT NULL,
      agents       TEXT NOT NULL,
      seat_count   INTEGER NOT NULL,
      ok_count     INTEGER NOT NULL,
      error        TEXT,
      budget_halt  TEXT,
      started_at   INTEGER,
      ended_at     INTEGER,
      duration_ms  INTEGER,
      archived_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_archived ON runs(archived_at);
    CREATE INDEX IF NOT EXISTS idx_runs_status   ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_runs_node     ON runs(node);

    CREATE TABLE IF NOT EXISTS run_seats (
      run_id       TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      agent        TEXT NOT NULL,
      task_id      TEXT,
      status       TEXT NOT NULL,
      result_text  TEXT,
      error        TEXT,
      truncated    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, seq),
      FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_seats_agent ON run_seats(agent);
  `);

  const insertRunStmt = db.prepare(`
    INSERT OR IGNORE INTO runs
      (run_id, node, mode, title, question, status, agents, seat_count, ok_count,
       error, budget_halt, started_at, ended_at, duration_ms, archived_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSeatStmt = db.prepare(`
    INSERT OR IGNORE INTO run_seats
      (run_id, seq, agent, task_id, status, result_text, error, truncated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const pruneByAgeStmt = db.prepare("DELETE FROM runs WHERE archived_at < ?");
  const pruneByCountStmt = db.prepare(
    "DELETE FROM runs WHERE run_id NOT IN (SELECT run_id FROM runs ORDER BY archived_at DESC, run_id DESC LIMIT ?)",
  );
  const getRunStmt = db.prepare("SELECT * FROM runs WHERE run_id = ?");
  const getSeatsStmt = db.prepare("SELECT * FROM run_seats WHERE run_id = ? ORDER BY seq ASC");

  function runRowToJson(row) {
    if (!row) return null;
    let agents = [];
    try {
      agents = JSON.parse(row.agents);
    } catch (e) {
      agents = [];
    }
    let budgetHalt = null;
    if (row.budget_halt) {
      try {
        budgetHalt = JSON.parse(row.budget_halt);
      } catch (e) {
        budgetHalt = null;
      }
    }
    return {
      runId: row.run_id,
      node: row.node,
      mode: row.mode,
      title: row.title,
      question: row.question,
      status: row.status,
      agents: Array.isArray(agents) ? agents : [],
      seatCount: Number(row.seat_count),
      okCount: Number(row.ok_count),
      error: row.error,
      budgetHalt,
      startedAt: row.started_at != null ? new Date(Number(row.started_at)).toISOString() : null,
      endedAt: row.ended_at != null ? new Date(Number(row.ended_at)).toISOString() : null,
      startedAtMs: row.started_at != null ? Number(row.started_at) : null,
      endedAtMs: row.ended_at != null ? Number(row.ended_at) : null,
      durationMs: row.duration_ms != null ? Number(row.duration_ms) : null,
      archivedAt: new Date(Number(row.archived_at)).toISOString(),
    };
  }

  function seatRowToJson(row) {
    return {
      seq: Number(row.seq),
      agent: row.agent,
      // Derived boolean for at-a-glance UI; `status` carries the detail
      // (ok | timeout | budget | refused | failed).
      ok: row.status === "ok",
      status: row.status,
      resultText: row.result_text,
      error: row.error,
      truncated: Number(row.truncated) === 1,
    };
  }

  /** Lazy GC: drop rows past the retention window and beyond the row cap. */
  function pruneOldRuns() {
    let removed = 0;
    const now = nowFn();
    if (retentionMs != null) {
      removed += Number(pruneByAgeStmt.run(now - retentionMs).changes);
    }
    if (rowCap != null) {
      removed += Number(pruneByCountStmt.run(rowCap).changes);
    }
    return removed;
  }

  /**
   * Archive one settled run. Accepts EITHER a raw orchestrate registry entry
   * (which is mapped via runEntryToRecord) OR an already-mapped {run, seats}
   * record. Idempotent on runId. Returns the mapped record (for the caller's
   * failure-alert decision) or null when the entry could not be mapped.
   *
   * @param {object} entryOrRecord
   * @param {object} [opts] - {title} override forwarded to runEntryToRecord
   * @returns {{run, seats}|null}
   */
  function archiveRun(entryOrRecord, opts = {}) {
    if (!entryOrRecord || typeof entryOrRecord !== "object") return null;
    const record =
      entryOrRecord.run && entryOrRecord.seats
        ? entryOrRecord
        : runEntryToRecord(entryOrRecord, { node: instanceNode, ...opts });
    if (!record || !record.run || !record.run.runId) return null;

    const r = record.run;
    const archivedAt = nowFn();
    try {
      const res = insertRunStmt.run(
        r.runId,
        typeof r.node === "string" && r.node ? r.node : instanceNode,
        r.mode,
        truncate(r.title, 500),
        r.question != null ? truncate(String(r.question), 4000) : null,
        VALID_STATUSES.has(r.status) ? r.status : "done",
        JSON.stringify(Array.isArray(r.agents) ? r.agents : []),
        Number.isFinite(r.seatCount) ? r.seatCount : (record.seats || []).length,
        Number.isFinite(r.okCount) ? r.okCount : 0,
        r.error != null ? truncate(String(r.error), 2000) : null,
        r.budgetHalt != null ? String(r.budgetHalt) : null,
        r.startedAtMs != null ? r.startedAtMs : null,
        r.endedAtMs != null ? r.endedAtMs : null,
        r.durationMs != null ? r.durationMs : null,
        archivedAt,
      );
      // changes===0 → duplicate runId (already archived). Don't re-write seats.
      if (Number(res.changes) === 0) return record;

      for (const seat of record.seats || []) {
        const seatStatus = VALID_SEAT_STATUSES.has(seat.status) ? seat.status : "failed";
        insertSeatStmt.run(
          r.runId,
          Number.isFinite(seat.seq) ? seat.seq : 0,
          String(seat.agent || "unknown"),
          seat.taskId != null ? String(seat.taskId) : null,
          seatStatus,
          seat.resultText != null ? truncate(String(seat.resultText), SEAT_TEXT_MAX) : null,
          seat.error != null ? truncate(String(seat.error), 2000) : null,
          seat.truncated ? 1 : 0,
        );
      }
    } catch (e) {
      console.error("[RunArchive] archiveRun failed:", e.message);
      return record; // still hand the record back so failure-alerting can proceed
    }

    pruneOldRuns();
    return record;
  }

  /**
   * List archived runs, newest first, with optional filters + cursor paging.
   *
   * @param {object} [filters]
   * @param {string} [filters.status] - exact status (running|done|failed)
   * @param {string} [filters.agent] - only runs that include this agent (seat)
   * @param {string} [filters.node] - exact node match
   * @param {number} [filters.limit=50] - max rows (cap 200)
   * @param {number} [filters.before] - archived_at cursor (ms); rows strictly older
   * @returns {{runs: Array, page: {limit, hasMore, nextBefore}}}
   */
  function listRuns({ status, agent, node: nodeFilter, limit, before } = {}) {
    const conditions = [];
    const params = [];

    if (status !== undefined && status !== null && status !== "") {
      if (!VALID_STATUSES.has(status)) {
        throw httpError(400, `Unknown status filter '${status}'`);
      }
      conditions.push("status = ?");
      params.push(status);
    }
    if (nodeFilter !== undefined && nodeFilter !== null && nodeFilter !== "") {
      conditions.push("node = ?");
      params.push(String(nodeFilter));
    }
    if (agent !== undefined && agent !== null && agent !== "") {
      conditions.push(
        "run_id IN (SELECT run_id FROM run_seats WHERE agent = ?)",
      );
      params.push(String(agent));
    }
    if (before !== undefined && before !== null && before !== "") {
      const beforeMs = Number(before);
      if (!Number.isFinite(beforeMs)) throw httpError(400, "before must be a number (epoch ms)");
      conditions.push("archived_at < ?");
      params.push(beforeMs);
    }

    let effectiveLimit = Number(limit);
    if (!Number.isFinite(effectiveLimit) || effectiveLimit < 1) effectiveLimit = DEFAULT_LIST_LIMIT;
    effectiveLimit = Math.min(Math.floor(effectiveLimit), MAX_LIST_LIMIT);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    // Fetch one extra to compute hasMore without a COUNT.
    const sql = `SELECT * FROM runs ${where} ORDER BY archived_at DESC, run_id DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...params, effectiveLimit + 1);

    const hasMore = rows.length > effectiveLimit;
    const page = rows.slice(0, effectiveLimit).map(runRowToJson);
    return {
      runs: page,
      page: {
        limit: effectiveLimit,
        hasMore,
        nextBefore: hasMore && page.length > 0 ? page[page.length - 1].archivedAt : null,
      },
    };
  }

  /**
   * Full detail for one run: the run row + its ordered seats.
   * @param {string} runId
   * @returns {{run, seats}|null}
   */
  function getRun(runId) {
    if (typeof runId !== "string" || runId.length === 0) return null;
    const row = getRunStmt.get(runId);
    if (!row) return null;
    const seats = getSeatsStmt.all(runId).map(seatRowToJson);
    return { run: runRowToJson(row), seats };
  }

  /** Counts for the unified state endpoint / badges. */
  function stats() {
    const totals = db
      .prepare(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM runs",
      )
      .get();
    return { total: Number(totals.total || 0), failed: Number(totals.failed || 0) };
  }

  function close() {
    try {
      db.close();
    } catch (e) {
      console.error("[RunArchive] Failed to close database:", e.message);
    }
  }

  return {
    archiveRun,
    listRuns,
    getRun,
    pruneOldRuns,
    stats,
    close,
    node: instanceNode,
  };
}

module.exports = {
  createRunArchive,
  runEntryToRecord,
  deriveSeats,
  recordIsFailure,
};
