/**
 * Codex CLI usage source — activity-only telemetry.
 *
 * ~/.codex/history.jsonl records command prompts ({ session_id, ts, text })
 * with no token usage, so this source is honest about its scope: it reports
 * an activity timeline, enumerates rollout session files when present
 * (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl), and detects live `codex`
 * processes via an injectable ps function. tokensAvailable is always false.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { parsePsOutput } = require("./claude-code");

const PS_TIMEOUT_MS = 5000;
const PREVIEW_LENGTH = 120;
const MAX_SESSION_SCAN_DEPTH = 5; // sessions/YYYY/MM/DD/file.jsonl

/** execFile semantics, never a shell; resolves (never rejects). */
function defaultExecFn(cmd, args, options = {}) {
  return new Promise((resolve) => {
    let execFile;
    try {
      execFile = require("child_process").execFile;
    } catch (e) {
      resolve({ error: e, stdout: "", stderr: "" });
      return;
    }
    execFile(
      cmd,
      args,
      { encoding: "utf8", timeout: options.timeoutMs || PS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ error: error || null, stdout: stdout || "", stderr: stderr || "" });
      },
    );
  });
}

/** True when the process command's executable basename is `codex`. */
function isCodexProcess(command) {
  const executable = String(command || "")
    .trim()
    .split(/\s+/)[0];
  if (!executable) return false;
  return path.basename(executable) === "codex";
}

/** history.jsonl `ts` is epoch seconds (tolerate epoch ms too). */
function historyTsToMs(ts) {
  const value = Number(ts);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value < 1e12 ? value * 1000 : value;
}

function collectJsonl(dir, depth, out) {
  if (depth > MAX_SESSION_SCAN_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsonl(full, depth + 1, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
}

/**
 * Create the Codex usage source.
 *
 * @param {object} [options]
 * @param {string} [options.codexDir] - default ~/.codex
 * @param {string} [options.historyPath] - default <codexDir>/history.jsonl
 * @param {string} [options.sessionsDir] - default <codexDir>/sessions
 * @param {function} [options.psFn] - async () => [{ pid, tty, command }]
 * @param {function} [options.execFn] - (cmd, args, opts) => Promise<{error, stdout, stderr}>
 */
function createCodexSource(options = {}) {
  const codexDir = options.codexDir || path.join(os.homedir(), ".codex");
  const historyPath = options.historyPath || path.join(codexDir, "history.jsonl");
  const sessionsDir = options.sessionsDir || path.join(codexDir, "sessions");
  const execFn = options.execFn || defaultExecFn;
  const psFn =
    options.psFn ||
    (async () => {
      const res = await execFn("ps", ["-eo", "pid=,tty=,args="], { timeoutMs: PS_TIMEOUT_MS });
      if (res.error) return [];
      return parsePsOutput(res.stdout);
    });

  function describe() {
    if (!fs.existsSync(historyPath) && !fs.existsSync(sessionsDir)) {
      return { available: false, reason: `no Codex data found under ${codexDir}` };
    }
    return { available: true };
  }

  /**
   * Activity timeline parsed from history.jsonl. Token counts are not
   * recorded in this file, so tokensAvailable is always false.
   * @param {object} [params] - { sinceMs, limit } (limit applies to `recent`)
   */
  async function getActivity(params = {}) {
    const status = describe();
    if (!status.available) {
      return { available: false, reason: status.reason, tokensAvailable: false };
    }
    if (!fs.existsSync(historyPath)) {
      return {
        available: true,
        tokensAvailable: false,
        entries: 0,
        sessions: 0,
        firstAt: null,
        lastAt: null,
        recent: [],
        note: `history file not found: ${historyPath}`,
      };
    }

    const sinceMs = Number.isFinite(params.sinceMs) ? params.sinceMs : null;
    const limit = Number.isFinite(params.limit) ? params.limit : 25;

    let content;
    try {
      content = fs.readFileSync(historyPath, "utf8");
    } catch (e) {
      return { available: false, reason: e.message, tokensAvailable: false };
    }

    const sessionIds = new Set();
    const timeline = [];
    let entries = 0;
    let firstMs = null;
    let lastMs = null;

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (e) {
        continue; // malformed line — skip
      }
      const tsMs = historyTsToMs(entry.ts);
      if (sinceMs !== null && (tsMs === null || tsMs < sinceMs)) continue;
      entries++;
      if (entry.session_id) sessionIds.add(entry.session_id);
      if (tsMs !== null) {
        if (firstMs === null || tsMs < firstMs) firstMs = tsMs;
        if (lastMs === null || tsMs > lastMs) lastMs = tsMs;
      }
      timeline.push({
        sessionId: entry.session_id || null,
        tsMs,
        cwd: typeof entry.cwd === "string" ? entry.cwd : null,
        preview: typeof entry.text === "string" ? entry.text.slice(0, PREVIEW_LENGTH) : null,
      });
    }

    // Newest first; entries without a parseable timestamp sort last.
    const recent = timeline
      .sort((a, b) => (b.tsMs ?? -Infinity) - (a.tsMs ?? -Infinity))
      .slice(0, limit)
      .map(({ tsMs, ...rest }) => ({
        ...rest,
        ts: tsMs !== null ? new Date(tsMs).toISOString() : null,
      }));

    return {
      available: true,
      tokensAvailable: false,
      entries,
      sessions: sessionIds.size,
      firstAt: firstMs !== null ? new Date(firstMs).toISOString() : null,
      lastAt: lastMs !== null ? new Date(lastMs).toISOString() : null,
      recent,
    };
  }

  /** Enumerate rollout session transcripts (count + newest), no parsing. */
  async function getSessionFiles(params = {}) {
    if (!fs.existsSync(sessionsDir)) {
      return { available: false, reason: `sessions directory not found: ${sessionsDir}`, count: 0 };
    }
    const sinceMs = Number.isFinite(params.sinceMs) ? params.sinceMs : null;
    const files = [];
    collectJsonl(sessionsDir, 0, files);

    let count = 0;
    let newest = null;
    for (const file of files) {
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch (e) {
        continue;
      }
      if (sinceMs !== null && mtimeMs < sinceMs) continue;
      count++;
      if (!newest || mtimeMs > newest.mtimeMs) {
        newest = { file: path.basename(file), mtimeMs };
      }
    }
    return {
      available: true,
      count,
      newest: newest
        ? { file: newest.file, modifiedAt: new Date(newest.mtimeMs).toISOString() }
        : null,
    };
  }

  /** Live `codex` processes: { count, ttys, pids }. Never throws. */
  async function getLive() {
    try {
      const processes = (await psFn()) || [];
      const matches = processes.filter((p) => p && isCodexProcess(p.command));
      const ttys = [...new Set(matches.map((p) => p.tty).filter((t) => t && t !== "?"))];
      return { count: matches.length, ttys, pids: matches.map((p) => p.pid) };
    } catch (e) {
      return { count: 0, ttys: [], pids: [], error: e.message };
    }
  }

  const status = describe();
  return {
    source: "codex",
    available: status.available,
    reason: status.reason,
    describe,
    getActivity,
    getSessionFiles,
    getLive,
  };
}

module.exports = { createCodexSource, isCodexProcess, historyTsToMs };
