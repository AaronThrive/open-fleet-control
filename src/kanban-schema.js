/**
 * Kanban board schema (v1) + hand-rolled validation.
 *
 * Board shape:
 *   { version: 1, updated_at: ISO datetime, tasks: [Task] }
 *
 * Columns are a fixed status enum aligned with the agent-team-orchestration
 * task lifecycle: inbox → assigned → inprogress → review → done | failed.
 *
 * No external dependencies — all validators are hand-rolled so this module
 * can be reused anywhere (server, CLI, tests) without a build step.
 */

const crypto = require("crypto");

const BOARD_VERSION = 1;

// Status enum (thematic lifecycle of a drone's task)
const STATUS = Object.freeze({
  INBOX: "inbox",
  ASSIGNED: "assigned",
  INPROGRESS: "inprogress",
  REVIEW: "review",
  DONE: "done",
  FAILED: "failed",
});

// Column rendering order (left → right on the board)
const COLUMN_ORDER = Object.freeze([
  STATUS.INBOX,
  STATUS.ASSIGNED,
  STATUS.INPROGRESS,
  STATUS.REVIEW,
  STATUS.DONE,
  STATUS.FAILED,
]);

const TASK_ID_PATTERN = /^tsk_[0-9a-f]{6}$/;
const TITLE_MAX = 200;
const DESCRIPTION_MAX_BYTES = 10 * 1024;
const NAME_MAX = 128;
const COMMENT_MAX_BYTES = 4 * 1024;
const RESULT_TEXT_MAX_BYTES = 16 * 1024; // attempt.result_text upper bound
const PRIORITIES = Object.freeze([1, 2, 3]);
const ATTEMPT_RESULTS = Object.freeze(["success", "failure"]);

// Every key a task object is allowed to carry. Anything else is rejected to
// protect the board from garbage written by misbehaving agents.
const TASK_FIELDS = Object.freeze([
  "id",
  "title",
  "description",
  "status",
  "assignee",
  "node",
  "priority",
  "due",
  "progress",
  "order",
  "parent_id",
  "attempts",
  "comments",
  "created_at",
  "updated_at",
]);

const ATTEMPT_FIELDS = Object.freeze([
  "agent",
  "started_at",
  "ended_at",
  "result",
  "branch",
  "note",
  "result_text",
]);

const COMMENT_FIELDS = Object.freeze(["author", "ts", "text"]);

// ---------------------------------------------------------------------------
// Primitive validators
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isIsoDateTime(v) {
  return (
    typeof v === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v) &&
    !Number.isNaN(Date.parse(v))
  );
}

// Accepts a date-only ISO string ("2026-06-10") or a full ISO datetime.
function isIsoDate(v) {
  return (
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(v) && !Number.isNaN(Date.parse(v))
  );
}

function byteLength(v) {
  return Buffer.byteLength(v, "utf8");
}

// ---------------------------------------------------------------------------
// Field validators (each pushes {path, reason} entries into `errors`)
// ---------------------------------------------------------------------------

function checkAttempt(attempt, basePath, errors) {
  if (!isPlainObject(attempt)) {
    errors.push({ path: basePath, reason: "attempt must be an object" });
    return;
  }
  for (const key of Object.keys(attempt)) {
    if (!ATTEMPT_FIELDS.includes(key)) {
      errors.push({ path: `${basePath}.${key}`, reason: "unknown attempt field" });
    }
  }
  if (typeof attempt.agent !== "string" || attempt.agent.length === 0) {
    errors.push({ path: `${basePath}.agent`, reason: "agent must be a non-empty string" });
  }
  if (!isIsoDateTime(attempt.started_at)) {
    errors.push({ path: `${basePath}.started_at`, reason: "started_at must be an ISO datetime" });
  }
  if (attempt.ended_at !== null && !isIsoDateTime(attempt.ended_at)) {
    errors.push({
      path: `${basePath}.ended_at`,
      reason: "ended_at must be an ISO datetime or null",
    });
  }
  if (attempt.result !== null && !ATTEMPT_RESULTS.includes(attempt.result)) {
    errors.push({
      path: `${basePath}.result`,
      reason: "result must be 'success', 'failure', or null",
    });
  }
  if (attempt.branch !== null && typeof attempt.branch !== "string") {
    errors.push({ path: `${basePath}.branch`, reason: "branch must be a string or null" });
  }
  if (attempt.note !== null && typeof attempt.note !== "string") {
    errors.push({ path: `${basePath}.note`, reason: "note must be a string or null" });
  }
  if (
    attempt.result_text !== undefined &&
    attempt.result_text !== null &&
    (typeof attempt.result_text !== "string" ||
      byteLength(attempt.result_text) > RESULT_TEXT_MAX_BYTES)
  ) {
    errors.push({
      path: `${basePath}.result_text`,
      reason: `result_text must be null or a string of at most ${RESULT_TEXT_MAX_BYTES} bytes`,
    });
  }
}

function checkComment(comment, basePath, errors) {
  if (!isPlainObject(comment)) {
    errors.push({ path: basePath, reason: "comment must be an object" });
    return;
  }
  for (const key of Object.keys(comment)) {
    if (!COMMENT_FIELDS.includes(key)) {
      errors.push({ path: `${basePath}.${key}`, reason: "unknown comment field" });
    }
  }
  if (typeof comment.author !== "string" || comment.author.length === 0) {
    errors.push({ path: `${basePath}.author`, reason: "author must be a non-empty string" });
  }
  if (!isIsoDateTime(comment.ts)) {
    errors.push({ path: `${basePath}.ts`, reason: "ts must be an ISO datetime" });
  }
  if (typeof comment.text !== "string" || byteLength(comment.text) > COMMENT_MAX_BYTES) {
    errors.push({
      path: `${basePath}.text`,
      reason: `text must be a string of at most ${COMMENT_MAX_BYTES} bytes`,
    });
  }
}

function collectTaskErrors(task, basePath, errors) {
  if (!isPlainObject(task)) {
    errors.push({ path: basePath, reason: "task must be an object" });
    return;
  }
  for (const key of Object.keys(task)) {
    if (!TASK_FIELDS.includes(key)) {
      errors.push({ path: `${basePath}.${key}`, reason: "unknown task field" });
    }
  }
  if (typeof task.id !== "string" || !TASK_ID_PATTERN.test(task.id)) {
    errors.push({
      path: `${basePath}.id`,
      reason: "id must match 'tsk_' followed by 6 lowercase hex characters",
    });
  }
  if (typeof task.title !== "string" || task.title.length < 1 || task.title.length > TITLE_MAX) {
    errors.push({
      path: `${basePath}.title`,
      reason: `title must be a string of 1-${TITLE_MAX} characters`,
    });
  }
  if (
    typeof task.description !== "string" ||
    byteLength(task.description) > DESCRIPTION_MAX_BYTES
  ) {
    errors.push({
      path: `${basePath}.description`,
      reason: `description must be a string of at most ${DESCRIPTION_MAX_BYTES} bytes`,
    });
  }
  if (!COLUMN_ORDER.includes(task.status)) {
    errors.push({
      path: `${basePath}.status`,
      reason: `status must be one of: ${COLUMN_ORDER.join(", ")}`,
    });
  }
  if (
    task.assignee !== null &&
    (typeof task.assignee !== "string" || task.assignee.length > NAME_MAX)
  ) {
    errors.push({
      path: `${basePath}.assignee`,
      reason: `assignee must be null or a string of at most ${NAME_MAX} characters`,
    });
  }
  if (task.node !== null && (typeof task.node !== "string" || task.node.length > NAME_MAX)) {
    errors.push({
      path: `${basePath}.node`,
      reason: `node must be null or a string of at most ${NAME_MAX} characters`,
    });
  }
  if (!PRIORITIES.includes(task.priority)) {
    errors.push({ path: `${basePath}.priority`, reason: "priority must be 1, 2, or 3" });
  }
  if (task.due !== null && !isIsoDate(task.due)) {
    errors.push({ path: `${basePath}.due`, reason: "due must be an ISO date or null" });
  }
  if (!Number.isInteger(task.progress) || task.progress < 0 || task.progress > 100) {
    errors.push({
      path: `${basePath}.progress`,
      reason: "progress must be an integer between 0 and 100",
    });
  }
  if (!Number.isInteger(task.order)) {
    errors.push({ path: `${basePath}.order`, reason: "order must be an integer" });
  }
  if (
    task.parent_id !== null &&
    (typeof task.parent_id !== "string" || !TASK_ID_PATTERN.test(task.parent_id))
  ) {
    errors.push({ path: `${basePath}.parent_id`, reason: "parent_id must be a task id or null" });
  }
  if (!Array.isArray(task.attempts)) {
    errors.push({ path: `${basePath}.attempts`, reason: "attempts must be an array" });
  } else {
    task.attempts.forEach((attempt, i) => {
      checkAttempt(attempt, `${basePath}.attempts[${i}]`, errors);
    });
  }
  if (!Array.isArray(task.comments)) {
    errors.push({ path: `${basePath}.comments`, reason: "comments must be an array" });
  } else {
    task.comments.forEach((comment, i) => {
      checkComment(comment, `${basePath}.comments[${i}]`, errors);
    });
  }
  if (!isIsoDateTime(task.created_at)) {
    errors.push({ path: `${basePath}.created_at`, reason: "created_at must be an ISO datetime" });
  }
  if (!isIsoDateTime(task.updated_at)) {
    errors.push({ path: `${basePath}.updated_at`, reason: "updated_at must be an ISO datetime" });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a single task object.
 * @param {object} obj - candidate task
 * @returns {{valid: boolean, errors: Array<{path: string, reason: string}>}}
 */
function validateTask(obj) {
  const errors = [];
  collectTaskErrors(obj, "task", errors);
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a full board object (version, updated_at, tasks).
 * @param {object} obj - candidate board
 * @returns {{valid: boolean, errors: Array<{path: string, reason: string}>}}
 */
function validateBoard(obj) {
  const errors = [];
  if (!isPlainObject(obj)) {
    return { valid: false, errors: [{ path: "board", reason: "board must be an object" }] };
  }
  if (obj.version !== BOARD_VERSION) {
    errors.push({ path: "version", reason: `version must be ${BOARD_VERSION}` });
  }
  if (!isIsoDateTime(obj.updated_at)) {
    errors.push({ path: "updated_at", reason: "updated_at must be an ISO datetime" });
  }
  if (!Array.isArray(obj.tasks)) {
    errors.push({ path: "tasks", reason: "tasks must be an array" });
  } else {
    const seen = new Set();
    obj.tasks.forEach((task, i) => {
      collectTaskErrors(task, `tasks[${i}]`, errors);
      if (isPlainObject(task) && typeof task.id === "string") {
        if (seen.has(task.id)) {
          errors.push({ path: `tasks[${i}].id`, reason: `duplicate task id '${task.id}'` });
        }
        seen.add(task.id);
      }
    });
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Generate a task id: 'tsk_' + 6 lowercase hex characters.
 * @returns {string}
 */
function generateTaskId() {
  return "tsk_" + crypto.randomBytes(3).toString("hex");
}

/**
 * Create an empty, valid board.
 * @returns {object} board
 */
function createEmptyBoard() {
  return { version: BOARD_VERSION, updated_at: new Date().toISOString(), tasks: [] };
}

/**
 * Create a new task from partial fields, applying defaults and generating an
 * id. Throws (with an `errors` property) on unknown fields or invalid values.
 * @param {object} fields - partial task fields (title is required)
 * @returns {object} fully-populated valid task
 */
function createTask(fields = {}) {
  if (!isPlainObject(fields)) {
    const err = new Error("createTask: fields must be an object");
    err.errors = [{ path: "task", reason: "fields must be an object" }];
    throw err;
  }
  for (const key of Object.keys(fields)) {
    if (key === "id") {
      const err = new Error("createTask: id is generated and cannot be supplied");
      err.errors = [{ path: "task.id", reason: "id is generated and cannot be supplied" }];
      throw err;
    }
    if (!TASK_FIELDS.includes(key)) {
      const err = new Error(`createTask: unknown task field '${key}'`);
      err.errors = [{ path: `task.${key}`, reason: "unknown task field" }];
      throw err;
    }
  }

  const now = new Date().toISOString();
  const task = {
    id: generateTaskId(),
    title: fields.title,
    description: fields.description ?? "",
    status: fields.status ?? STATUS.INBOX,
    assignee: fields.assignee ?? null,
    node: fields.node ?? null,
    priority: fields.priority ?? 2,
    due: fields.due ?? null,
    progress: fields.progress ?? 0,
    order: fields.order ?? 0,
    parent_id: fields.parent_id ?? null,
    attempts: fields.attempts ?? [],
    comments: fields.comments ?? [],
    created_at: fields.created_at ?? now,
    updated_at: fields.updated_at ?? now,
  };

  const result = validateTask(task);
  if (!result.valid) {
    const summary = result.errors.map((e) => `${e.path}: ${e.reason}`).join("; ");
    const err = new Error(`createTask: invalid task — ${summary}`);
    err.errors = result.errors;
    throw err;
  }
  return task;
}

module.exports = {
  BOARD_VERSION,
  STATUS,
  COLUMN_ORDER,
  TASK_ID_PATTERN,
  TASK_FIELDS,
  validateBoard,
  validateTask,
  createTask,
  createEmptyBoard,
  generateTaskId,
};
