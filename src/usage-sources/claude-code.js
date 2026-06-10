/**
 * Claude Code usage source — reads terminal/XRDP session transcripts from
 * ~/.claude/projects/<slugged-cwd>/<session-uuid>.jsonl (plus subagents/
 * subdirectories) and detects live `claude` processes via an injectable ps
 * function.
 *
 * Every public method is graceful: a missing directory or unreadable file
 * never throws to the caller. Lines that are not user/assistant messages
 * (file-history-snapshot, mode, etc.) and malformed JSON lines are skipped.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { TOKEN_RATES, calculateCostForBucket } = require("../tokens");

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SCAN_DEPTH = 4; // project dir -> subagents -> nested transcripts
const PS_TIMEOUT_MS = 5000;

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

/** Parse `ps -eo pid=,tty=,args=` output into [{ pid, tty, command }]. */
function parsePsOutput(stdout) {
  return String(stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) return null;
      return { pid: Number(match[1]), tty: match[2], command: match[3] };
    })
    .filter(Boolean);
}

/** True when the process command's executable basename is `claude`. */
function isClaudeProcess(command) {
  const executable = String(command || "")
    .trim()
    .split(/\s+/)[0];
  if (!executable) return false;
  const base = path.basename(executable);
  return base === "claude" || base === "claude-code";
}

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function addUsage(tokens, usage) {
  tokens.input += Number(usage.input_tokens) || 0;
  tokens.output += Number(usage.output_tokens) || 0;
  tokens.cacheRead += Number(usage.cache_read_input_tokens) || 0;
  tokens.cacheWrite += Number(usage.cache_creation_input_tokens) || 0;
}

/** Recursively collect .jsonl transcript files under a project directory. */
function collectJsonlFiles(dir, depth, out) {
  if (depth > MAX_SCAN_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return; // unreadable directory — skip silently
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonlFiles(full, depth + 1, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
}

/** Parse one transcript file into a session summary (null when empty). */
function parseSessionFile(filePath, mtimeMs) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return null;
  }

  const tokens = emptyTokens();
  let sessionId = null;
  let cwd = null;
  let model = null;
  let messages = 0;
  let firstTs = null;
  let lastTs = null;

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (e) {
      continue; // malformed line — skip
    }
    if (!sessionId && typeof entry.sessionId === "string") sessionId = entry.sessionId;
    if (entry.type !== "user" && entry.type !== "assistant") continue;

    messages++;
    if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
    }
    const message = entry.message;
    if (entry.type === "assistant" && message) {
      if (typeof message.model === "string" && message.model && message.model !== "<synthetic>") {
        model = message.model;
      }
      if (message.usage && typeof message.usage === "object") addUsage(tokens, message.usage);
    }
  }

  if (messages === 0) return null;
  return {
    sessionId: sessionId || path.basename(filePath, ".jsonl"),
    file: filePath,
    subagent: filePath.includes(`${path.sep}subagents${path.sep}`),
    cwd,
    startedAt: firstTs !== null ? new Date(firstTs).toISOString() : null,
    lastActiveAt: new Date(lastTs !== null ? lastTs : mtimeMs).toISOString(),
    messages,
    tokens,
    model,
    live: false,
  };
}

/** Per-message usage entries for window bucketing: [{ ts, usage }]. */
function parseUsageEntries(filePath, sinceMs) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return [];
  }
  const entries = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (entry.type !== "assistant" || !entry.message?.usage) continue;
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    entries.push({ ts, usage: entry.message.usage });
  }
  return entries;
}

/**
 * Create the Claude Code usage source.
 *
 * @param {object} [options]
 * @param {string} [options.projectsDir] - default ~/.claude/projects
 * @param {function} [options.psFn] - async () => [{ pid, tty, command }]
 * @param {function} [options.execFn] - (cmd, args, opts) => Promise<{error, stdout, stderr}>
 * @param {function} [options.nowFn] - () => epoch ms
 */
function createClaudeCodeSource(options = {}) {
  const projectsDir = options.projectsDir || path.join(os.homedir(), ".claude", "projects");
  const nowFn = options.nowFn || Date.now;
  const execFn = options.execFn || defaultExecFn;
  const psFn =
    options.psFn ||
    (async () => {
      const res = await execFn("ps", ["-eo", "pid=,tty=,args="], { timeoutMs: PS_TIMEOUT_MS });
      if (res.error) return [];
      return parsePsOutput(res.stdout);
    });

  function describe() {
    if (!fs.existsSync(projectsDir)) {
      return { available: false, reason: `directory not found: ${projectsDir}` };
    }
    return { available: true };
  }

  /** All transcript files with mtime, newest first. */
  function listFiles() {
    const files = [];
    collectJsonlFiles(projectsDir, 0, files);
    return files
      .map((file) => {
        try {
          return { file, mtimeMs: fs.statSync(file).mtimeMs };
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /**
   * Session summaries (newest first). Never throws; [] when unavailable.
   * @param {object} [params] - { sinceMs, limit }
   */
  async function getSessions(params = {}) {
    const status = describe();
    if (!status.available) return [];
    const sinceMs = Number.isFinite(params.sinceMs) ? params.sinceMs : null;
    const limit = Number.isFinite(params.limit) ? params.limit : null;

    const sessions = [];
    for (const { file, mtimeMs } of listFiles()) {
      if (sinceMs !== null && mtimeMs < sinceMs) continue;
      const session = parseSessionFile(file, mtimeMs);
      if (!session) continue;
      if (sinceMs !== null && Date.parse(session.lastActiveAt) < sinceMs) continue;
      sessions.push(session);
      if (limit !== null && sessions.length >= limit) break;
    }
    return sessions.sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
  }

  /**
   * Token usage windows (24h / 3d / 7d) with per-token-type totals and
   * estimated API cost at Opus rates.
   */
  async function getUsageWindows() {
    const status = describe();
    if (!status.available) return { available: false, reason: status.reason };

    const now = nowFn();
    const cutoff7d = now - 7 * DAY_MS;
    const buckets = {
      h24: { ...emptyTokens(), requests: 0 },
      d3: { ...emptyTokens(), requests: 0 },
      d7: { ...emptyTokens(), requests: 0 },
    };

    for (const { file, mtimeMs } of listFiles()) {
      if (mtimeMs < cutoff7d) continue;
      for (const { ts, usage } of parseUsageEntries(file, cutoff7d)) {
        if (ts >= now - DAY_MS) {
          addUsage(buckets.h24, usage);
          buckets.h24.requests++;
        }
        if (ts >= now - 3 * DAY_MS) {
          addUsage(buckets.d3, usage);
          buckets.d3.requests++;
        }
        addUsage(buckets.d7, usage);
        buckets.d7.requests++;
      }
    }

    const finalize = (bucket) => ({
      ...bucket,
      estCost: Math.round(calculateCostForBucket(bucket, TOKEN_RATES).totalCost * 10000) / 10000,
    });
    return {
      available: true,
      h24: finalize(buckets.h24),
      d3: finalize(buckets.d3),
      d7: finalize(buckets.d7),
    };
  }

  /** Live `claude` processes: { count, ttys, pids }. Never throws. */
  async function getLive() {
    try {
      const processes = (await psFn()) || [];
      const matches = processes.filter((p) => p && isClaudeProcess(p.command));
      const ttys = [...new Set(matches.map((p) => p.tty).filter((t) => t && t !== "?"))];
      return { count: matches.length, ttys, pids: matches.map((p) => p.pid) };
    } catch (e) {
      return { count: 0, ttys: [], pids: [], error: e.message };
    }
  }

  const status = describe();
  return {
    source: "claude-code",
    available: status.available,
    reason: status.reason,
    describe,
    getSessions,
    getUsageWindows,
    getLive,
  };
}

module.exports = { createClaudeCodeSource, parsePsOutput, isClaudeProcess };
