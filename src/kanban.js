/**
 * Kanban board engine — task lifecycle management on top of the safe store.
 *
 * The board lives in <stateDir>/kanban.json and may also be edited directly
 * by agents, so every operation reads through the safe store (which
 * quarantines corrupt files and auto-restores backups) instead of caching
 * state in memory. All mutations are immutable: a new board object is built,
 * validated, written atomically, and then an onChange event is fired.
 */

const path = require("path");
const schema = require("./kanban-schema");
const { createSafeStore } = require("./state-safety");

const DEFAULT_STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute
const WATCHED_STATUSES = Object.freeze([schema.STATUS.ASSIGNED, schema.STATUS.INPROGRESS]);

/**
 * Create a kanban board engine.
 *
 * @param {object} options
 * @param {string} options.stateDir - directory holding kanban.json (+ backups)
 * @param {function} [options.onChange] - (eventDetail) => void, fired after every mutation
 * @param {number} [options.debounceMs] - watch debounce override (passed to safe store)
 * @returns {object} kanban API
 */
function createKanban(options = {}) {
  const { stateDir, onChange, debounceMs } = options;
  if (!stateDir) throw new Error("createKanban: stateDir is required");

  const store = createSafeStore({
    filePath: path.join(stateDir, "kanban.json"),
    backupDir: path.join(stateDir, "backups"),
    validate: schema.validateBoard,
    createDefault: () => schema.createEmptyBoard(),
    debounceMs,
  });

  // Derived staleness (set by the watchdog, never persisted).
  const staleTaskIds = new Set();

  function nowIso() {
    return new Date().toISOString();
  }

  function emit(type, detail) {
    if (typeof onChange === "function") {
      onChange({ type, ts: nowIso(), ...detail });
    }
  }

  /** Read the raw persisted board (recovering from corruption if needed). */
  function readBoard() {
    return store.read().data;
  }

  function requireTask(board, id) {
    const task = board.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    return task;
  }

  /** Build a new board with one task replaced (immutable). */
  function withTask(board, updatedTask) {
    return {
      ...board,
      updated_at: nowIso(),
      tasks: board.tasks.map((t) => (t.id === updatedTask.id ? updatedTask : t)),
    };
  }

  /**
   * Get the board with derived `stale` flags on each task (not persisted).
   * @returns {object} board
   */
  function getBoard() {
    const board = readBoard();
    return {
      ...board,
      tasks: board.tasks.map((t) => ({ ...t, stale: staleTaskIds.has(t.id) })),
    };
  }

  /**
   * Create a task (defaults applied, id generated).
   * @param {object} fields - partial task fields (title required)
   * @param {string} actor - who performed the action
   * @returns {object} the created task
   */
  function createTask(fields, actor) {
    const task = schema.createTask(fields);
    const board = readBoard();
    store.write({ ...board, updated_at: nowIso(), tasks: [...board.tasks, task] });
    emit("task.created", { taskId: task.id, actor, task });
    return task;
  }

  /**
   * Patch a task. Bumps updated_at; unknown patch fields are rejected by
   * schema validation before anything is written.
   * @param {string} id - task id
   * @param {object} patch - fields to change
   * @param {string} actor - who performed the action
   * @returns {object} the updated task
   */
  function updateTask(id, patch, actor) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("updateTask: patch must be an object");
    }
    for (const key of ["id", "created_at"]) {
      if (key in patch) throw new Error(`updateTask: '${key}' cannot be patched`);
    }
    const board = readBoard();
    const current = requireTask(board, id);
    const clean = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) clean[key] = value;
    }
    const updated = { ...current, ...clean, updated_at: nowIso() };
    store.write(withTask(board, updated)); // throws if patch produced an invalid task
    emit("task.updated", {
      taskId: id,
      actor,
      task: updated,
      changes: Object.keys(clean),
      previousStatus: current.status,
    });
    return updated;
  }

  /**
   * Move a task to a column (status) at a given order.
   * @param {string} id - task id
   * @param {string} status - target status (must be a known column)
   * @param {number} order - position within the column
   * @param {string} actor - who performed the action
   * @returns {object} the moved task
   */
  function moveTask(id, status, order, actor) {
    if (!schema.COLUMN_ORDER.includes(status)) {
      throw new Error(`moveTask: unknown status '${status}'`);
    }
    if (!Number.isInteger(order)) {
      throw new Error("moveTask: order must be an integer");
    }
    const board = readBoard();
    const current = requireTask(board, id);
    const updated = { ...current, status, order, updated_at: nowIso() };
    store.write(withTask(board, updated));
    emit("task.moved", {
      taskId: id,
      actor,
      from: current.status,
      to: status,
      order,
      task: updated,
    });
    return updated;
  }

  /**
   * Append a comment to a task.
   * @param {string} id - task id
   * @param {{author: string, text: string}} comment
   * @returns {object} the updated task
   */
  function addComment(id, { author, text } = {}) {
    const board = readBoard();
    const current = requireTask(board, id);
    const comment = { author, ts: nowIso(), text };
    const updated = {
      ...current,
      comments: [...current.comments, comment],
      updated_at: nowIso(),
    };
    store.write(withTask(board, updated));
    emit("comment.added", { taskId: id, actor: author, task: updated, comment });
    return updated;
  }

  /**
   * Append an attempt record to a task.
   * @param {string} id - task id
   * @param {object} attempt - {agent, started_at?, ended_at?, result?, branch?, note?, result_text?}
   * @returns {object} the updated task
   */
  function addAttempt(id, attempt = {}) {
    const board = readBoard();
    const current = requireTask(board, id);
    const full = {
      agent: attempt.agent,
      started_at: attempt.started_at ?? nowIso(),
      ended_at: attempt.ended_at ?? null,
      result: attempt.result ?? null,
      branch: attempt.branch ?? null,
      note: attempt.note ?? null,
      result_text: attempt.result_text ?? null,
    };
    for (const key of Object.keys(attempt)) {
      if (!(key in full)) throw new Error(`addAttempt: unknown attempt field '${key}'`);
    }
    const updated = {
      ...current,
      attempts: [...current.attempts, full],
      updated_at: nowIso(),
    };
    store.write(withTask(board, updated));
    emit("attempt.added", { taskId: id, actor: full.agent, task: updated, attempt: full });
    return updated;
  }

  /**
   * Atomically claim a task for dispatch by appending a "claim" attempt, but
   * ONLY if the supplied compare-and-set precondition still holds at write
   * time. This is the correctness primitive that makes double-dispatch
   * impossible across concurrent ticks / concurrent HTTP requests.
   *
   * Why this is atomic: the safe store's read() and write() are SYNCHRONOUS
   * (fs sync calls) and Node is single-threaded, so the precondition check and
   * the write happen with NO await boundary between them — no other JS on this
   * instance can interleave. Two concurrent claimers therefore serialize: the
   * first re-reads, sees the precondition holds, and writes its claim; the
   * second re-reads (now seeing the first claim already persisted), the
   * precondition fails, and it gets `{claimed:false}` without writing. This is
   * the in-process equivalent of paperclip's
   * `UPDATE … WHERE claim IS NULL RETURNING`.
   *
   * Guarantee boundary (documented honestly): atomicity holds within a SINGLE
   * server instance. It does NOT coordinate two separate OS processes writing
   * the same kanban.json concurrently — that would need file locking and is out
   * of scope (OFC runs one writer per board: the :3333 instance). External
   * agent edits to kanban.json are already quarantined/validated by the safe
   * store, not raced through this path.
   *
   * @param {string} id - task id
   * @param {object} params
   * @param {string} params.agent - claimant agent id (recorded on the attempt)
   * @param {function} params.precondition - (task) => boolean; the CAS guard,
   *   re-evaluated against the freshly-read task immediately before the write.
   *   Return false to refuse the claim (already claimed / not eligible).
   * @param {string} [params.note] - attempt note (defaults to the caller's tag)
   * @returns {{claimed: boolean, task?: object, attemptIndex?: number, reason?: string}}
   */
  function claimTask(id, { agent, precondition, note } = {}) {
    if (typeof agent !== "string" || agent.length === 0) {
      throw new Error("claimTask: agent must be a non-empty string");
    }
    if (typeof precondition !== "function") {
      throw new Error("claimTask: precondition must be a function");
    }
    // --- begin atomic section: read → check → write, no await in between ---
    const board = readBoard();
    const current = requireTask(board, id);
    let ok;
    try {
      ok = precondition(current) === true;
    } catch (e) {
      return { claimed: false, reason: `precondition threw: ${e.message}` };
    }
    if (!ok) {
      return { claimed: false, reason: "precondition not satisfied (already claimed?)" };
    }
    const attempt = {
      agent,
      started_at: nowIso(),
      ended_at: null,
      result: null,
      branch: null,
      note: note ?? null,
      result_text: null,
    };
    const updated = {
      ...current,
      attempts: [...current.attempts, attempt],
      updated_at: nowIso(),
    };
    store.write(withTask(board, updated)); // throws if the claim produced an invalid task
    // --- end atomic section ---
    emit("attempt.added", { taskId: id, actor: agent, task: updated, attempt });
    return { claimed: true, task: updated, attemptIndex: updated.attempts.length - 1 };
  }

  /**
   * Patch one existing attempt in place (by index). Attempts are append-only
   * for agents, so an index captured at addAttempt time stays stable. Used by
   * the dispatch module to close its attempt when the agent run settles.
   * @param {string} id - task id
   * @param {number} index - attempt index within task.attempts
   * @param {object} patch - subset of {ended_at, result, branch, note, result_text}
   * @returns {object} the updated task
   */
  function updateAttempt(id, index, patch = {}) {
    const board = readBoard();
    const current = requireTask(board, id);
    if (!Number.isInteger(index) || index < 0 || index >= current.attempts.length) {
      throw new Error(`updateAttempt: no attempt at index ${index}`);
    }
    const allowed = ["ended_at", "result", "branch", "note", "result_text"];
    const clean = {};
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed.includes(key)) throw new Error(`updateAttempt: '${key}' cannot be patched`);
      if (value !== undefined) clean[key] = value;
    }
    const attempt = { ...current.attempts[index], ...clean };
    const updated = {
      ...current,
      attempts: current.attempts.map((a, i) => (i === index ? attempt : a)),
      updated_at: nowIso(),
    };
    store.write(withTask(board, updated)); // throws if the patch produced an invalid attempt
    emit("attempt.updated", { taskId: id, actor: attempt.agent, task: updated, attempt, index });
    return updated;
  }

  /**
   * Delete a task from the board.
   * @param {string} id - task id
   * @param {string} actor - who performed the action
   * @returns {object} the removed task
   */
  function deleteTask(id, actor) {
    const board = readBoard();
    const removed = requireTask(board, id);
    store.write({
      ...board,
      updated_at: nowIso(),
      tasks: board.tasks.filter((t) => t.id !== id),
    });
    staleTaskIds.delete(id);
    emit("task.deleted", { taskId: id, actor, task: removed });
    return removed;
  }

  /**
   * Clear every task in the Done column in a single write.
   *
   * Hard-delete: matching tasks are filtered out (recoverable via the safe
   * store's timestamped backups). One immutable store.write, one SSE event.
   * @param {string} actor - who performed the action
   * @returns {number} the number of tasks removed
   */
  function clearDone(actor) {
    const board = readBoard();
    const removed = board.tasks.filter((t) => t.status === schema.STATUS.DONE);
    if (removed.length === 0) return 0;
    store.write({
      ...board,
      updated_at: nowIso(),
      tasks: board.tasks.filter((t) => t.status !== schema.STATUS.DONE),
    });
    for (const task of removed) staleTaskIds.delete(task.id);
    emit("board.done_cleared", { actor, count: removed.length });
    return removed.length;
  }

  /** Replace the derived stale set (used by the watchdog; not persisted). */
  function setStaleTaskIds(ids) {
    staleTaskIds.clear();
    for (const id of ids) staleTaskIds.add(id);
  }

  /**
   * Watch kanban.json for direct edits by agents. Invalid writes are
   * quarantined + restored by the safe store; either way an event fires.
   * @returns {{close: function}}
   */
  function watch() {
    return store.watch((result) => {
      emit("board.external_change", {
        restored: result.restored,
        quarantinedPath: result.quarantinedPath,
        usedDefault: result.usedDefault,
      });
    });
  }

  return {
    getBoard,
    createTask,
    updateTask,
    moveTask,
    addComment,
    addAttempt,
    claimTask,
    updateAttempt,
    deleteTask,
    clearDone,
    setStaleTaskIds,
    watch,
  };
}

/**
 * Stale-task watchdog. Flags tasks in assigned/inprogress whose latest
 * activity (max of updated_at, last comment ts, last attempt started_at) is
 * older than thresholdMs. Fires onStale(task) once per staleness episode and
 * re-arms when the task shows activity again.
 *
 * @param {object} options
 * @param {object} options.kanban - kanban engine from createKanban()
 * @param {number} [options.thresholdMs=1800000] - staleness threshold (30 min)
 * @param {number} [options.checkIntervalMs=60000] - polling interval
 * @param {function} [options.onStale] - (task) => void
 * @param {function} [options.now] - injectable clock, returns epoch ms
 * @returns {{check: function, start: function, stop: function}}
 */
function createWatchdog(options = {}) {
  const {
    kanban,
    thresholdMs = DEFAULT_STALE_THRESHOLD_MS,
    checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
    onStale,
    now = () => Date.now(),
  } = options;
  if (!kanban) throw new Error("createWatchdog: kanban is required");

  let timer = null;
  const firedIds = new Set(); // tasks already notified in the current episode

  function lastActivityMs(task) {
    const times = [Date.parse(task.updated_at)];
    for (const comment of task.comments) times.push(Date.parse(comment.ts));
    for (const attempt of task.attempts) times.push(Date.parse(attempt.started_at));
    return Math.max(...times.filter((t) => !Number.isNaN(t)));
  }

  /** Run one staleness sweep. Returns the ids flagged as stale. */
  function check() {
    const board = kanban.getBoard();
    const staleIds = [];
    const currentMs = now();
    const liveIds = new Set();

    for (const task of board.tasks) {
      liveIds.add(task.id);
      const eligible = WATCHED_STATUSES.includes(task.status);
      const isStale = eligible && currentMs - lastActivityMs(task) > thresholdMs;
      if (isStale) {
        staleIds.push(task.id);
        if (!firedIds.has(task.id)) {
          firedIds.add(task.id);
          if (typeof onStale === "function") onStale(task);
        }
      } else {
        firedIds.delete(task.id); // re-arm: activity resumed or left watched status
      }
    }

    // Drop bookkeeping for deleted tasks.
    for (const id of firedIds) {
      if (!liveIds.has(id)) firedIds.delete(id);
    }

    kanban.setStaleTaskIds(staleIds);
    return staleIds;
  }

  function start() {
    if (timer) return;
    timer = setInterval(check, checkIntervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { check, start, stop };
}

module.exports = { createKanban, createWatchdog };
