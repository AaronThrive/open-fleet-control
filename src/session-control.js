/**
 * Session control — kill live terminal (Claude Code / Codex) processes and
 * tail session transcripts (terminal + OpenClaw) with offset paging.
 *
 * Kill safety model:
 *   - The pid is validated against the usage-source adapters' live process
 *     list (ps re-checked AT KILL TIME, not against a stale snapshot); any
 *     pid that is not a live `claude`/`codex` process responds 404.
 *   - SIGTERM first; a detached timer escalates to SIGKILL after
 *     KILL_ESCALATION_MS if the process is still alive.
 *
 * Transcript safety model:
 *   - The session id is never used to build a path directly. It must match
 *     a session in the owning adapter's known list (claude-code adapter for
 *     source=terminal, OpenClaw session store for source=openclaw); the
 *     resolved file path comes from that adapter. Unknown ids → 404.
 *
 * All dependencies (kill, ps-backed adapters, /proc reads, timers) are
 * injectable for tests. Results follow the { error, code } convention used
 * by the rest of the server (no throwing on expected failures).
 */

const fs = require("fs");

const KILL_ESCALATION_MS = 10000;
const TAIL_BYTES = 64 * 1024; // initial tail window for offset-less reads
const MAX_CHUNK_BYTES = 256 * 1024; // max bytes consumed per poll
const MAX_TEXT_EXCERPT = 600;
const TRANSCRIPT_SOURCES = ["terminal", "openclaw"];
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Parse one JSONL transcript line into a viewer message, or null when the
 * line is not a user/assistant message (or is malformed).
 *
 * Handles both transcript dialects:
 *   - Claude Code:  { type:"user"|"assistant", timestamp, message:{role,content} }
 *   - OpenClaw:     { type:"message", timestamp?, message:{role,content} }
 */
function parseTranscriptLine(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch (e) {
    return null;
  }
  if (!entry || typeof entry !== "object") return null;
  if (entry.type !== "user" && entry.type !== "assistant" && entry.type !== "message") return null;
  const msg = entry.message;
  if (!msg || typeof msg !== "object" || typeof msg.role !== "string") return null;
  if (msg.role !== "user" && msg.role !== "assistant") return null;

  let text = "";
  const tools = [];
  if (typeof msg.content === "string") {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && !text && typeof part.text === "string") text = part.text;
      if (part.type === "tool_use" || part.type === "toolCall") {
        const name = part.name || part.tool;
        if (typeof name === "string" && name) tools.push(name);
      }
    }
  }
  if (!text && tools.length === 0) return null; // tool-result / meta noise

  return {
    role: msg.role,
    text: String(text).slice(0, MAX_TEXT_EXCERPT),
    ts:
      typeof entry.timestamp === "string" || typeof entry.timestamp === "number"
        ? entry.timestamp
        : null,
    tools,
  };
}

/** Default /proc-based cwd lookup (same-user processes only). */
function defaultReadCwd(pid) {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch (e) {
    return null;
  }
}

/**
 * Create the session-control service.
 *
 * @param {object} deps
 * @param {object} deps.claudeCode - claude-code usage adapter ({ getLive, getSessions })
 * @param {object} [deps.codex] - codex usage adapter ({ getLive }), optional
 * @param {function} deps.resolveOpenClawTranscript - async (sessionId) => path|null
 * @param {function} [deps.killFn] - (pid, signal) => void (throws ESRCH when gone)
 * @param {function} [deps.readCwdFn] - (pid) => cwd string|null
 * @param {function} [deps.scheduleFn] - setTimeout-compatible scheduler
 * @param {object} [deps.fsImpl] - fs override for transcript reads (tests)
 */
function createSessionControl(deps = {}) {
  const { claudeCode, codex = null, resolveOpenClawTranscript } = deps;
  if (!claudeCode) throw new Error("createSessionControl requires a claudeCode adapter");
  if (typeof resolveOpenClawTranscript !== "function") {
    throw new Error("createSessionControl requires a resolveOpenClawTranscript function");
  }
  const killFn = deps.killFn || ((pid, signal) => process.kill(pid, signal));
  const readCwdFn = deps.readCwdFn || defaultReadCwd;
  const scheduleFn = deps.scheduleFn || setTimeout;
  const fsImpl = deps.fsImpl || fs;

  /** Signal-0 liveness probe. EPERM means alive-but-not-ours. */
  function isPidAlive(pid) {
    try {
      killFn(pid, 0);
      return true;
    } catch (e) {
      return e && e.code === "EPERM";
    }
  }

  /** Live claude/codex pids, re-checked via ps right now. Never throws. */
  async function listKillablePids() {
    const lists = await Promise.all([
      claudeCode.getLive(),
      codex && typeof codex.getLive === "function"
        ? codex.getLive()
        : Promise.resolve({ pids: [] }),
    ]);
    const pids = new Set();
    for (const live of lists) {
      for (const pid of (live && live.pids) || []) {
        if (Number.isInteger(pid) && pid > 1) pids.add(pid);
      }
    }
    return pids;
  }

  /**
   * Kill a live terminal session process: SIGTERM now, SIGKILL after
   * KILL_ESCALATION_MS if still alive. The pid is validated against the
   * live process list at call time — anything else is a 404.
   * @param {number} pid
   * @returns {Promise<object>} { success, pid } or { error, code }
   */
  async function killTerminalSession(pid) {
    if (!Number.isInteger(pid) || pid <= 1) {
      return { error: "Invalid pid", code: 400 };
    }
    const killable = await listKillablePids();
    if (!killable.has(pid)) {
      return { error: `No live claude/codex process with pid ${pid}`, code: 404 };
    }
    try {
      killFn(pid, "SIGTERM");
    } catch (e) {
      if (e && e.code === "ESRCH") {
        return { error: `Process ${pid} exited before it could be signalled`, code: 404 };
      }
      return { error: `Failed to signal pid ${pid}: ${e.message}`, code: 500 };
    }
    const timer = scheduleFn(() => {
      if (!isPidAlive(pid)) return;
      try {
        killFn(pid, "SIGKILL");
      } catch (e) {
        // Raced with exit — nothing left to do.
      }
    }, KILL_ESCALATION_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
    return { success: true, pid, signal: "SIGTERM", escalatesToSigkillAfterMs: KILL_ESCALATION_MS };
  }

  /**
   * Live claude processes with their working directories (via /proc) so the
   * UI can associate pids with transcript rows (transcripts record cwd).
   */
  async function getTerminalLive() {
    const live = await claudeCode.getLive();
    const pids = (live && live.pids) || [];
    return {
      count: live && Number.isFinite(live.count) ? live.count : pids.length,
      ttys: (live && live.ttys) || [],
      processes: pids
        .filter((pid) => Number.isInteger(pid) && pid > 1)
        .map((pid) => ({ pid, cwd: readCwdFn(pid) })),
    };
  }

  /**
   * Resolve a transcript file path for a session id, scoped to the source's
   * known session list. Returns null for unknown/malformed ids.
   */
  async function resolveTranscript(source, id) {
    if (typeof id !== "string" || !SAFE_ID_RE.test(id)) return null;
    if (source === "openclaw") {
      return resolveOpenClawTranscript(id);
    }
    // terminal: the claude-code adapter owns the id → file mapping.
    const sessions = await claudeCode.getSessions({});
    const match = (sessions || []).find((s) => s && s.sessionId === id);
    return match ? match.file : null;
  }

  /**
   * Read a transcript chunk for incremental polling.
   *
   * offset semantics:
   *   - null/absent: tail — start TAIL_BYTES from the end (aligned to the
   *     next full line) so the first response shows recent messages.
   *   - number: resume from a previous nextOffset. An offset past the file
   *     size (truncated/rotated file) resets to a fresh tail.
   *
   * Only complete lines are consumed; nextOffset always lands on a line
   * boundary so pollers never split JSON.
   *
   * @param {object} params - { source, id, offset }
   * @returns {Promise<object>} { source, id, messages, nextOffset, size, eof } or { error, code }
   */
  async function readTranscriptChunk({ source, id, offset = null } = {}) {
    if (!TRANSCRIPT_SOURCES.includes(source)) {
      return { error: `Invalid source (expected ${TRANSCRIPT_SOURCES.join("|")})`, code: 400 };
    }
    if (typeof id !== "string" || id.length === 0) {
      return { error: "Missing id", code: 400 };
    }
    if (offset !== null && (!Number.isFinite(offset) || offset < 0)) {
      return { error: "Invalid offset", code: 400 };
    }

    const filePath = await resolveTranscript(source, id);
    if (!filePath) {
      return { error: `Unknown ${source} session: ${id}`, code: 404 };
    }

    let size;
    try {
      size = fsImpl.statSync(filePath).size;
    } catch (e) {
      return { error: `Transcript unreadable: ${e.message}`, code: 404 };
    }

    let start = offset;
    let aligning = false; // skip the first (possibly partial) line
    if (start === null || start > size) {
      start = Math.max(0, size - TAIL_BYTES);
      aligning = start > 0;
    }

    const end = Math.min(size, start + MAX_CHUNK_BYTES);
    if (end <= start) {
      return { source, id, messages: [], nextOffset: start, size, eof: start >= size };
    }

    let content;
    try {
      const fd = fsImpl.openSync(filePath, "r");
      const buffer = Buffer.alloc(end - start);
      const bytesRead = fsImpl.readSync(fd, buffer, 0, buffer.length, start);
      fsImpl.closeSync(fd);
      content = buffer.toString("utf8", 0, bytesRead);
    } catch (e) {
      return { error: `Transcript read failed: ${e.message}`, code: 500 };
    }

    let consumed = 0;
    if (aligning) {
      const firstNewline = content.indexOf("\n");
      if (firstNewline === -1) {
        return { source, id, messages: [], nextOffset: size, size, eof: true };
      }
      consumed = firstNewline + 1;
    }

    const messages = [];
    while (consumed < content.length) {
      const newline = content.indexOf("\n", consumed);
      if (newline === -1) {
        // Trailing line without a newline: consume it only when the file
        // ends here AND it parses as a complete message — a writer caught
        // mid-line is retried on the next poll instead of being lost.
        if (start + content.length >= size) {
          const message = parseTranscriptLine(content.slice(consumed));
          if (message) {
            messages.push(message);
            consumed = content.length;
          }
        }
        break;
      }
      const message = parseTranscriptLine(content.slice(consumed, newline));
      if (message) messages.push(message);
      consumed = newline + 1;
    }

    const nextOffset = start + consumed;
    return { source, id, messages, nextOffset, size, eof: nextOffset >= size };
  }

  return {
    killTerminalSession,
    getTerminalLive,
    readTranscriptChunk,
    isPidAlive,
    KILL_ESCALATION_MS,
  };
}

module.exports = { createSessionControl, parseTranscriptLine };
