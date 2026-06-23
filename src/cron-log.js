/**
 * OpenClaw cron RUN logger for Open Fleet Control.
 *
 * The OpenClaw scheduler runs inside a Docker container named `openclaw`. Its
 * cron RUNS (each individual execution of a job) are only surfaced to Telegram,
 * never to the fleet. This poller closes that gap: it periodically lists the
 * scheduler's jobs, pulls the recent run history of each, and emits every NEW
 * run as a normalized fleet event so all crons become visible in OFC.
 *
 * Mirrors the poller pattern in mesh.js — an injectable-dependency factory with
 * start()/stop()/getState(), a setInterval timer that is .unref()'d, and a poll
 * loop that NEVER throws (failures set lastError and the loop continues). Seen
 * run ids are persisted to a small JSON stateFile so a restart does not re-emit
 * the entire backlog.
 *
 * Container access is via `docker exec`:
 *   docker exec openclaw openclaw cron list --json
 *   docker exec openclaw openclaw cron runs --id <id> --limit 5 --json
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const DEFAULT_INTERVAL_MS = 120000; // 2 min — runs are infrequent, no need to hammer
const DEFAULT_CONTAINER = "openclaw";
const DEFAULT_RUNS_PER_JOB = 5; // recent-run window pulled per job
const EXEC_TIMEOUT_MS = 20000;
const EXEC_MAX_BUFFER = 16 * 1024 * 1024;
const KNOWN_RUNS_LIMIT = 5000; // cap the persisted dedupe set (ring-trim oldest)

/**
 * Minimal, secret-free env for the docker child process. Mirrors the env
 * hygiene in openclaw.js / cron.js — never leak API keys or cloud creds into a
 * subprocess.
 */
function safeEnv() {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    LANG: process.env.LANG,
    NO_COLOR: "1",
    TERM: "dumb",
  };
}

/**
 * Default exec implementation: run `docker <args...>` with no shell (execFile),
 * a hard timeout, and a bounded buffer. Resolves stdout; rejects on non-zero
 * exit / timeout. Injectable via createCronLog({ execImpl }) for tests.
 *
 * @param {string[]} argv - docker argument vector (each element one argv token)
 * @returns {Promise<string>} stdout
 */
function defaultExecImpl(argv) {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      argv,
      { encoding: "utf8", timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER, env: safeEnv() },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/**
 * Best-effort JSON parse of CLI stdout that may carry a non-JSON prefix
 * (banners, warnings). Returns the parsed value or null — never throws.
 */
function parseJsonLoose(stdout) {
  if (!stdout || typeof stdout !== "string") return null;
  const start = stdout.search(/[[{]/);
  if (start === -1) return null;
  try {
    return JSON.parse(stdout.slice(start));
  } catch (e) {
    return null;
  }
}

/**
 * Normalize the "jobs" payload from `cron list --json` into a flat array.
 * Tolerates either a bare array or a { jobs: [...] } envelope.
 */
function extractJobs(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.jobs)) return parsed.jobs;
  return [];
}

/**
 * Normalize the "runs" payload from `cron runs --json` into a flat array.
 * Tolerates a bare array or a { runs: [...] } envelope.
 */
function extractRuns(parsed) {
  if (Array.isArray(parsed)) return parsed;
  // `openclaw cron runs` returns a { entries: [...] } envelope (it does NOT accept
  // --json; the command is JSONL-backed and prints JSON by default).
  if (parsed && Array.isArray(parsed.entries)) return parsed.entries;
  if (parsed && Array.isArray(parsed.runs)) return parsed.runs;
  return [];
}

/** First non-empty string among candidates, else null. */
function pickString(...candidates) {
  for (const v of candidates) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * Coerce a timestamp (epoch ms, epoch seconds, or ISO string) to epoch ms.
 * Returns null when no candidate is usable.
 */
function toEpochMs(...candidates) {
  for (const v of candidates) {
    if (typeof v === "number" && Number.isFinite(v)) {
      // Heuristic: 10-digit values are seconds, 13-digit are ms.
      return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
    }
    if (typeof v === "string" && v.length > 0) {
      const parsed = Date.parse(v);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/**
 * Stable identity of a run for dedupe purposes. Prefers an explicit run id,
 * falls back to sessionId, then to a composite of jobId + finished/started
 * timestamp so runs without an id still dedupe deterministically.
 *
 * @param {object} run - raw run object
 * @param {string|null} jobId - owning job id
 * @returns {string|null} dedupe key, or null when nothing identifies the run
 */
function runDedupeKey(run, jobId) {
  const explicit = pickString(run.id, run.runId, run.sessionId);
  if (explicit) return explicit;
  const ts = toEpochMs(run.finishedAt, run.startedAt, run.ts);
  if (jobId && ts !== null) return `${jobId}:${ts}`;
  return null;
}

/**
 * Normalize a raw run + its owning job into the fleet cron event shape.
 *
 * @param {object} run - raw run object from `cron runs --json`
 * @param {object} job - raw job object from `cron list --json`
 * @param {string} dedupeKey - precomputed stable run id
 * @returns {object|null} normalized event ({source:"cron", type:"cron",
 *   task:jobName, job, jobId, status, ts, ...}), or null if no timestamp
 */
function normalizeRun(run, job, dedupeKey, container) {
  const jobId = pickString(job.id, run.jobId) || null;
  const jobName = pickString(run.jobName, job.name, jobId) || "unknown";
  const status = run.status === "error" ? "error" : "ok";
  const ts = toEpochMs(run.finishedAt, run.startedAt, run.ts);
  if (ts === null) return null; // an event with no time is not loggable

  return {
    source: "cron",
    type: "cron",
    id: dedupeKey,
    job: jobName,
    // The container the scheduler runs in (e.g. "openclaw") is the cron run's
    // node — so the Alerts Node column shows exactly where it ran, not a dash.
    node: pickString(container) || null,
    // Surface the job name as the alert `task` so the UI Task column shows
    // e.g. "Daily VPS" rather than leaving cron runs task-less. `job` is kept
    // for back-compat with existing consumers (src/fleet.js reads e.job).
    task: jobName,
    jobId,
    status,
    ts,
    model: pickString(run.model) || null,
    provider: pickString(run.provider) || null,
    delivered: typeof run.delivered === "boolean" ? run.delivered : null,
    error: status === "error" ? pickString(run.error) || "unknown error" : null,
  };
}

/**
 * Create the cron-run logger.
 *
 * @param {object} options
 * @param {number} [options.intervalMs=120000] - poll interval
 * @param {function} [options.execImpl] - async (argv:string[]) => stdout; injectable
 * @param {string} [options.stateFile] - JSON file persisting seen run ids (dedupe)
 * @param {function} [options.onRun] - callback(event) fired once per NEW run, oldest-first
 * @param {string} [options.container] - container name (default "openclaw")
 * @param {number} [options.runsPerJob] - recent runs pulled per job (default 5)
 * @param {function} [options.nowFn] - clock (default Date.now), for tests
 * @returns {{start: function, stop: function, getState: function, _pollOnce: function}}
 */
function createCronLog(options = {}) {
  const {
    intervalMs = DEFAULT_INTERVAL_MS,
    execImpl = defaultExecImpl,
    stateFile = null,
    onRun = null,
    container = DEFAULT_CONTAINER,
    runsPerJob = DEFAULT_RUNS_PER_JOB,
    nowFn = Date.now,
  } = options;

  // ---------------------------------------------------------------------
  // Dedupe set persistence — a plain JSON array of seen run keys. Kept small
  // and dependency-free on purpose (a corrupt/missing file degrades to an
  // empty set rather than throwing). Insertion order is preserved so the
  // KNOWN_RUNS_LIMIT trim drops the oldest keys first.
  // ---------------------------------------------------------------------

  const knownRuns = new Set(loadKnownRuns());

  function loadKnownRuns() {
    if (!stateFile) return [];
    try {
      const raw = fs.readFileSync(stateFile, "utf8");
      const parsed = JSON.parse(raw);
      const ids = Array.isArray(parsed) ? parsed : Array.isArray(parsed.ids) ? parsed.ids : [];
      return ids.filter((x) => typeof x === "string");
    } catch (e) {
      // Missing or corrupt — start clean; the next persist rewrites it.
      return [];
    }
  }

  function persistKnownRuns() {
    if (!stateFile) return;
    try {
      // Trim to the cap (drop oldest first), keeping the most recent keys.
      let ids = [...knownRuns];
      if (ids.length > KNOWN_RUNS_LIMIT) {
        ids = ids.slice(ids.length - KNOWN_RUNS_LIMIT);
        knownRuns.clear();
        for (const id of ids) knownRuns.add(id);
      }
      const tmp = `${stateFile}.tmp-${process.pid}`;
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ ids }), "utf8");
      fs.renameSync(tmp, stateFile); // atomic replace
    } catch (e) {
      console.error("[CronLog] Failed to persist state:", e.message);
    }
  }

  // Module state
  let pollTimer = null;
  let running = false;
  let lastPollAt = null;
  let lastError = null;

  function emit(event) {
    if (typeof onRun !== "function") return;
    try {
      onRun(event);
    } catch (e) {
      // A consumer failure must never break the poll loop.
      console.error("[CronLog] onRun callback failed:", e.message);
    }
  }

  /**
   * Pull + emit new runs for a single job. Best-effort: a failure for one job
   * sets lastError but never throws (the caller keeps polling other jobs).
   */
  async function pollJob(job) {
    const jobId = pickString(job.id);
    if (!jobId) return [];
    let parsed = null;
    try {
      const stdout = await execImpl([
        "exec",
        container,
        "openclaw",
        "cron",
        "runs",
        "--id",
        jobId,
        "--limit",
        String(runsPerJob),
      ]);
      parsed = parseJsonLoose(stdout);
    } catch (e) {
      lastError = `runs(${jobId}): ${e.message}`;
      return [];
    }

    // Normalize, drop already-seen + un-timestamped, then sort oldest-first so
    // emission order matches chronology even when the CLI returns newest-first.
    const fresh = [];
    for (const run of extractRuns(parsed)) {
      // A run logs "started" then "finished" entries — only log completions.
      if (run.action && run.action !== "finished") continue;
      const key = runDedupeKey(run, jobId);
      if (!key || knownRuns.has(key)) continue;
      const event = normalizeRun(run, job, key, container);
      if (event) fresh.push(event);
    }
    fresh.sort((a, b) => a.ts - b.ts);
    return fresh;
  }

  /**
   * Run one full poll cycle: list jobs, then pull each job's recent runs,
   * emit every new run oldest-first, and persist the dedupe set once at the
   * end. Never throws — any failure is recorded in lastError.
   * Exposed for testing (matches the repo's poller convention).
   */
  async function _pollOnce() {
    lastPollAt = nowFn();
    let jobs = [];
    try {
      const stdout = await execImpl(["exec", container, "openclaw", "cron", "list", "--json"]);
      jobs = extractJobs(parseJsonLoose(stdout));
      lastError = null;
    } catch (e) {
      // docker / openclaw unavailable — record and bail this cycle (no throw).
      lastError = `list: ${e.message}`;
      return;
    }

    // Collect all fresh events across jobs, then emit globally oldest-first so
    // the fleet timeline is chronologically ordered across the whole fleet.
    const collected = [];
    for (const job of jobs) {
      const fresh = await pollJob(job);
      collected.push(...fresh);
    }
    collected.sort((a, b) => a.ts - b.ts);

    let added = false;
    for (const event of collected) {
      if (knownRuns.has(event.id)) continue; // guard against intra-cycle dupes
      knownRuns.add(event.id);
      added = true;
      emit(event);
    }
    if (added) persistKnownRuns();
  }

  function start() {
    if (pollTimer) return;
    running = true;
    _pollOnce().catch((e) => console.error("[CronLog] Poll failed:", e.message));
    pollTimer = setInterval(() => {
      _pollOnce().catch((e) => console.error("[CronLog] Poll failed:", e.message));
    }, intervalMs);
    if (typeof pollTimer.unref === "function") pollTimer.unref();
    console.log(`[CronLog] Cron-run poller started (${intervalMs}ms interval)`);
  }

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    running = false;
    console.log("[CronLog] Cron-run poller stopped");
  }

  function getState() {
    return { running, lastPollAt, knownRuns: knownRuns.size, lastError };
  }

  return { start, stop, getState, _pollOnce };
}

module.exports = {
  createCronLog,
  normalizeRun,
  runDedupeKey,
  parseJsonLoose,
  extractJobs,
  extractRuns,
  toEpochMs,
  DEFAULT_INTERVAL_MS,
  DEFAULT_CONTAINER,
  DEFAULT_RUNS_PER_JOB,
};
