const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

// ---------------------------------------------------------------------------
// Cron sources (OpenClaw 2026.6.5+):
//   1. Legacy file  — <openclawDir>/cron/jobs.json (pre-2026.6.5; read sync).
//   2. CLI          — `openclaw cron list --json`. Storage moved into
//                     ~/.openclaw/state/openclaw.sqlite (cron_jobs table);
//                     the CLI is the supported reader. It takes seconds, so a
//                     background refresh keeps a 60s-TTL cache and the request
//                     path never blocks.
//   3. Hermes       — ~/.hermes/cron/jobs.json (best-effort second source).
// Each job: { id, name, schedule, scheduleHuman, enabled, nextRun,
//             lastStatus, agent, node, source: 'openclaw'|'hermes' }
// ---------------------------------------------------------------------------

const CLI_CACHE_TTL_MS = 60000;
const CLI_TIMEOUT_MS = 30000;

// Convert cron expression to human-readable text
function cronToHuman(expr) {
  if (!expr || expr === "—") return null;

  const parts = expr.split(" ");
  if (parts.length < 5) return null;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  // Helper to format time
  function formatTime(h, m) {
    const hNum = parseInt(h, 10);
    const mNum = parseInt(m, 10);
    if (isNaN(hNum)) return null;
    const ampm = hNum >= 12 ? "pm" : "am";
    const h12 = hNum === 0 ? 12 : hNum > 12 ? hNum - 12 : hNum;
    return mNum === 0 ? `${h12}${ampm}` : `${h12}:${mNum.toString().padStart(2, "0")}${ampm}`;
  }

  // Every minute
  if (minute === "*" && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return "Every minute";
  }

  // Every X minutes
  if (minute.startsWith("*/")) {
    const interval = minute.slice(2);
    return `Every ${interval} minutes`;
  }

  // Every X hours (*/N in hour field)
  if (hour.startsWith("*/")) {
    const interval = hour.slice(2);
    const minStr = minute === "0" ? "" : `:${minute.padStart(2, "0")}`;
    return `Every ${interval} hours${minStr ? " at " + minStr : ""}`;
  }

  // Every hour at specific minute
  if (minute !== "*" && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Hourly at :${minute.padStart(2, "0")}`;
  }

  // Build time string for specific hour
  let timeStr = "";
  if (minute !== "*" && hour !== "*" && !hour.startsWith("*/")) {
    timeStr = formatTime(hour, minute);
  }

  // Daily at specific time
  if (timeStr && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Daily at ${timeStr}`;
  }

  // Weekdays (Mon-Fri) - check before generic day of week
  if ((dayOfWeek === "1-5" || dayOfWeek === "MON-FRI") && dayOfMonth === "*" && month === "*") {
    return timeStr ? `Weekdays at ${timeStr}` : "Weekdays";
  }

  // Weekends - check before generic day of week
  if ((dayOfWeek === "0,6" || dayOfWeek === "6,0") && dayOfMonth === "*" && month === "*") {
    return timeStr ? `Weekends at ${timeStr}` : "Weekends";
  }

  // Specific day of week
  if (dayOfMonth === "*" && month === "*" && dayOfWeek !== "*") {
    const days = dayOfWeek.split(",").map((d) => {
      const num = parseInt(d, 10);
      return dayNames[num] || d;
    });
    const dayStr = days.length === 1 ? days[0] : days.join(", ");
    return timeStr ? `${dayStr} at ${timeStr}` : `Every ${dayStr}`;
  }

  // Specific day of month
  if (dayOfMonth !== "*" && month === "*" && dayOfWeek === "*") {
    const day = parseInt(dayOfMonth, 10);
    const suffix =
      day === 1 || day === 21 || day === 31
        ? "st"
        : day === 2 || day === 22
          ? "nd"
          : day === 3 || day === 23
            ? "rd"
            : "th";
    return timeStr ? `${day}${suffix} of month at ${timeStr}` : `${day}${suffix} of every month`;
  }

  // Fallback: just show the time if we have it
  if (timeStr) {
    return `At ${timeStr}`;
  }

  return expr; // Return original as fallback
}

// Format a future timestamp (ms) as a compact relative string
function formatNextRun(nextRunAtMs) {
  if (!nextRunAtMs || !Number.isFinite(nextRunAtMs)) return "—";
  const diffMins = Math.round((nextRunAtMs - Date.now()) / 60000);
  if (diffMins < 0) return "overdue";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffMins < 1440) return `${Math.round(diffMins / 60)}h`;
  return `${Math.round(diffMins / 1440)}d`;
}

// Parse an OpenClaw schedule object into { schedule, scheduleHuman }
function parseOpenClawSchedule(schedule) {
  if (!schedule) return { schedule: "—", scheduleHuman: null };
  if (schedule.kind === "cron" && schedule.expr) {
    return { schedule: schedule.expr, scheduleHuman: cronToHuman(schedule.expr) };
  }
  if (schedule.kind === "once" || schedule.kind === "at") {
    return { schedule: "once", scheduleHuman: "One-time" };
  }
  if (schedule.kind === "every" && Number.isFinite(schedule.everyMs)) {
    const mins = Math.round(schedule.everyMs / 60000);
    return {
      schedule: `every ${mins}m`,
      scheduleHuman: mins >= 60 ? `Every ${Math.round(mins / 60)} hours` : `Every ${mins} minutes`,
    };
  }
  return { schedule: schedule.kind || "—", scheduleHuman: null };
}

// Map a raw OpenClaw job (identical shape in legacy file and CLI output)
function mapOpenClawJob(job, node) {
  const { schedule, scheduleHuman } = parseOpenClawSchedule(job.schedule);
  const state = job.state || {};
  return {
    id: job.id,
    name: job.name || String(job.id || "").slice(0, 8),
    schedule,
    scheduleHuman,
    enabled: job.enabled !== false,
    nextRun: formatNextRun(state.nextRunAtMs),
    lastStatus: state.lastStatus ?? state.lastRunStatus ?? null,
    // Epoch ms of the most recent run (null when the job never ran) — feeds
    // the per-agent flight-recorder timeline (cron.run events).
    lastRunAtMs: Number.isFinite(state.lastRunAtMs) ? state.lastRunAtMs : null,
    agent: job.agentId || null,
    node,
    source: "openclaw",
  };
}

// Map a Hermes job from ~/.hermes/cron/jobs.json
function mapHermesJob(job, node) {
  let schedule = "—";
  let scheduleHuman = null;
  if (job.schedule?.kind === "cron" && job.schedule.expr) {
    schedule = job.schedule.expr;
    scheduleHuman = cronToHuman(job.schedule.expr);
  } else if (job.schedule_display) {
    schedule = String(job.schedule_display);
    scheduleHuman = cronToHuman(schedule);
  }

  let nextRunAtMs = null;
  if (job.next_run_at) {
    const parsed = Date.parse(job.next_run_at);
    if (Number.isFinite(parsed)) nextRunAtMs = parsed;
  }

  let lastRunAtMs = null;
  if (job.last_run_at) {
    const parsed = Date.parse(job.last_run_at);
    if (Number.isFinite(parsed)) lastRunAtMs = parsed;
  }

  return {
    id: job.id,
    name: job.name || String(job.id || "").slice(0, 8),
    schedule,
    scheduleHuman,
    enabled: job.enabled !== false,
    nextRun: formatNextRun(nextRunAtMs),
    lastStatus: job.last_status ?? null,
    lastRunAtMs,
    agent: job.profile || null,
    node,
    source: "hermes",
  };
}

// ---------------------------------------------------------------------------
// CLI source — async cached runner. getCronJobs() stays synchronous: it
// returns whatever is cached and kicks off a background refresh when stale.
// ---------------------------------------------------------------------------

function defaultCliRunner() {
  return new Promise((resolve, reject) => {
    const profile = process.env.OPENCLAW_PROFILE || "";
    const args = [...(profile ? ["--profile", profile] : []), "cron", "list", "--json"];
    execFile(
      "openclaw",
      args,
      {
        encoding: "utf8",
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          USER: process.env.USER,
          LANG: process.env.LANG,
          NO_COLOR: "1",
          TERM: "dumb",
          OPENCLAW_PROFILE: process.env.OPENCLAW_PROFILE || "",
          OPENCLAW_HOME: process.env.OPENCLAW_HOME || "",
        },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

let cliRunner = defaultCliRunner;
let cliCache = { rawJobs: null, fetchedAt: 0, refreshing: false, promise: null };

function refreshCliCache() {
  if (cliCache.refreshing) return cliCache.promise;
  const promise = Promise.resolve()
    .then(() => cliRunner())
    .then((stdout) => {
      const parsed = JSON.parse(String(stdout));
      cliCache = {
        rawJobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
        fetchedAt: Date.now(),
        refreshing: false,
        promise: null,
      };
    })
    .catch((e) => {
      console.error("[Cron] CLI refresh failed:", e.message);
      // Keep stale data (if any) and back off for a full TTL window
      cliCache = { ...cliCache, fetchedAt: Date.now(), refreshing: false, promise: null };
    });
  cliCache = { ...cliCache, refreshing: true, promise };
  return promise;
}

function getOpenClawRawJobs(getOpenClawDir) {
  // Legacy file source (pre-2026.6.5 installs, fixtures)
  const cronPath = path.join(getOpenClawDir(), "cron", "jobs.json");
  if (fs.existsSync(cronPath)) {
    const data = JSON.parse(fs.readFileSync(cronPath, "utf8"));
    return Array.isArray(data.jobs) ? data.jobs : [];
  }

  // CLI source (cached, background-refreshed)
  if (Date.now() - cliCache.fetchedAt > CLI_CACHE_TTL_MS) {
    refreshCliCache();
  }
  return cliCache.rawJobs || [];
}

function getHermesRawJobs(hermesCronPath) {
  const target = hermesCronPath || path.join(os.homedir(), ".hermes", "cron", "jobs.json");
  if (!fs.existsSync(target)) return [];
  const data = JSON.parse(fs.readFileSync(target, "utf8"));
  return Array.isArray(data.jobs) ? data.jobs : [];
}

/**
 * Get cron jobs from all sources. Synchronous and non-blocking: the OpenClaw
 * CLI source is served from a 60s-TTL cache refreshed in the background.
 *
 * @param {function} getOpenClawDir - resolves the OpenClaw home directory
 * @param {object} [opts]
 * @param {string} [opts.hermesCronPath] - override Hermes jobs.json path (tests)
 * @returns {Array<object>} jobs
 */
function getCronJobs(getOpenClawDir, opts = {}) {
  const node = os.hostname();

  let openclawJobs = [];
  try {
    openclawJobs = getOpenClawRawJobs(getOpenClawDir).map((j) => mapOpenClawJob(j, node));
  } catch (e) {
    console.error("Failed to get cron:", e.message);
  }

  let hermesJobs = [];
  try {
    hermesJobs = getHermesRawJobs(opts.hermesCronPath).map((j) => mapHermesJob(j, node));
  } catch (e) {
    console.error("Failed to get Hermes cron:", e.message);
  }

  return [...openclawJobs, ...hermesJobs];
}

/**
 * Force a CLI cache refresh regardless of TTL — used after a successful
 * cron mutation so the next getCronJobs() reflects the change. Waits for any
 * in-flight refresh first (its data predates the mutation), then re-runs the
 * CLI. Resolves when the cache holds post-mutation data; never rejects
 * (refresh failures keep stale data, same as the background path).
 *
 * @returns {Promise<void>}
 */
function forceCliRefresh() {
  const inflight = cliCache.promise || Promise.resolve();
  return inflight.then(() => {
    cliCache = { ...cliCache, fetchedAt: 0 };
    return refreshCliCache();
  });
}

/**
 * Reset module state for testing.
 * @param {object} [options]
 * @param {function} [options.cliRunner] - replacement async runner returning CLI stdout
 */
function _resetForTesting(options = {}) {
  cliCache = { rawJobs: null, fetchedAt: 0, refreshing: false, promise: null };
  cliRunner = options.cliRunner || defaultCliRunner;
}

/** Await any in-flight background CLI refresh (tests only). */
function _waitForCliRefreshForTesting() {
  return cliCache.promise || Promise.resolve();
}

module.exports = {
  cronToHuman,
  getCronJobs,
  forceCliRefresh,
  _resetForTesting,
  _waitForCliRefreshForTesting,
};
