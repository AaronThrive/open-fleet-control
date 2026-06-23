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
//   4. Host crontab — the running user's own crontab (`crontab -l`). Plain
//                     cron lines with no scheduler metadata; surfaced
//                     read-only. Best-effort: failures contribute nothing.
// Each job: { id, name, schedule, scheduleHuman, enabled, nextRun,
//             lastStatus, lastRunAtMs, agent, node,
//             source: 'openclaw'|'hermes'|'host' }
// Host-source records additionally carry { command, readOnly: true }.
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
    // Raw epoch ms of the next run so the UI can show the actual date + time
    // (not just the compact "5d" relative form).
    nextRunAtMs: Number.isFinite(state.nextRunAtMs) ? state.nextRunAtMs : null,
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
    nextRunAtMs,
    lastStatus: job.last_status ?? null,
    lastRunAtMs,
    agent: job.profile || null,
    node,
    source: "hermes",
  };
}

// ---------------------------------------------------------------------------
// Host crontab source — the broclaw2 user's own crontab (`crontab -l`).
// These are plain cron lines (5 schedule fields + command), with no scheduler
// metadata: no ids, no last/next-run state, no enable/disable. They are
// surfaced read-only. Env/PATH assignment lines, comments, and blank lines are
// skipped. Read synchronously with a tight timeout; any failure contributes
// nothing (never throws).
// ---------------------------------------------------------------------------

const HOST_CRONTAB_TIMEOUT_MS = 5000;

// Parse one 5-field cron value (minute/hour/dom/month/dow) into the sorted set
// of integers it matches within [min,max]. Handles `*`, `*/n`, lists `a,b`,
// ranges `a-b`, and `a-b/n`. Returns null on anything it can't parse so the
// caller can bail (no next-run rather than a wrong one).
function cronFieldValues(field, min, max) {
  const out = new Set();
  for (const part of String(field).split(",")) {
    let [range, stepRaw] = part.split("/");
    const step = stepRaw ? parseInt(stepRaw, 10) : 1;
    if (!Number.isInteger(step) || step < 1) return null;
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const [a, b] = range.split("-");
      lo = parseInt(a, 10);
      hi = b !== undefined ? parseInt(b, 10) : a !== undefined ? parseInt(a, 10) : NaN;
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
      if (lo < min || hi > max || lo > hi) return null;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : null;
}

// Compute the next fire time (epoch ms) for a 5-field cron expression, at or
// after `fromMs`. Minute-stepping evaluator (bounded to ~366 days) — covers
// every expression a host crontab uses without a dependency. Returns null when
// the expression can't be parsed or doesn't fire within the horizon.
function cronNextRunMs(expr, fromMs) {
  const parts = String(expr || "").trim().split(/\s+/);
  if (parts.length < 5) return null;
  const minutes = cronFieldValues(parts[0], 0, 59);
  const hours = cronFieldValues(parts[1], 0, 23);
  const doms = cronFieldValues(parts[2], 1, 31);
  const months = cronFieldValues(parts[3], 1, 12);
  const dows = cronFieldValues(parts[4], 0, 7); // 0 and 7 both = Sunday
  if (!minutes || !hours || !doms || !months || !dows) return null;
  const domRestricted = parts[2] !== "*";
  const dowRestricted = parts[4] !== "*";

  // Start at the next whole minute (cron fires on minute boundaries).
  const d = new Date(fromMs);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const horizon = fromMs + 366 * 24 * 60 * 60 * 1000;

  while (d.getTime() <= horizon) {
    const dow = d.getDay(); // 0=Sun..6=Sat
    const dowMatch = dows.has(dow) || (dow === 0 && dows.has(7));
    const domMatch = doms.has(d.getDate());
    // Standard cron rule: when BOTH dom and dow are restricted, either matches.
    const dayMatch =
      domRestricted && dowRestricted
        ? domMatch || dowMatch
        : (!domRestricted || domMatch) && (!dowRestricted || dowMatch);
    if (
      months.has(d.getMonth() + 1) &&
      dayMatch &&
      hours.has(d.getHours()) &&
      minutes.has(d.getMinutes())
    ) {
      return d.getTime();
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// A host cron line often redirects output to a log: `… >> /path/log 2>&1`.
// Use that log's mtime as a best-effort "last fired" timestamp (host cron keeps
// no run history of its own). Guarded to $HOME, never throws.
function hostCronLastRunMs(command) {
  const m = String(command || "").match(/>>?\s*("([^"]+)"|'([^']+)'|(\S+))/);
  if (!m) return null;
  let target = m[2] || m[3] || m[4] || "";
  if (target.startsWith("~/")) target = path.join(os.homedir(), target.slice(2));
  if (!path.isAbsolute(target)) return null;
  const resolved = path.resolve(target);
  // Only read paths under the user's home — never follow a redirect elsewhere.
  if (!resolved.startsWith(os.homedir() + path.sep)) return null;
  try {
    const st = fs.statSync(resolved);
    return st.isFile() ? Math.round(st.mtimeMs) : null;
  } catch {
    return null;
  }
}

// Derive a readable name from a cron command line. Picks the basename of the
// first path-like token (skipping leading `VAR=val` env assignments), strips a
// common script extension, and falls back to the first token or a truncated
// command when nothing better is available.
function hostCronName(command) {
  const tokens = String(command || "").trim().split(/\s+/);
  let i = 0;
  // Skip inline `VAR=value` env assignments that can precede the command.
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  const cmd = tokens[i] || "";
  if (!cmd) return String(command || "").slice(0, 40) || "cron job";
  // Basename of the executable, minus a trailing shell/script extension.
  const base = cmd.split("/").pop() || cmd;
  const cleaned = base.replace(/\.(sh|py|js|ts|rb|pl)$/i, "") || base || cmd;
  // Append the first non-flag argument so multiple invocations of the same
  // script (e.g. `vps-ntfy-monitor hourly` vs `… daily`) are distinguishable
  // instead of collapsing to one ambiguous name. Stop at a redirect/pipe.
  const arg = tokens[i + 1];
  if (arg && !arg.startsWith("-") && !/^[>|&]/.test(arg) && !arg.includes("/")) {
    return `${cleaned} ${arg}`;
  }
  return cleaned;
}

// Map a single raw host crontab line into a job record matching the
// openclaw/hermes shape. Returns null for lines that are not real jobs
// (blank, comment, or `VAR=value` environment assignments).
function mapHostCronLine(line, index, node) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const parts = trimmed.split(/\s+/);
  if (parts.length < 6) return null;

  // Environment / PATH assignment lines: `NAME=value ...` with no schedule.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[0])) return null;

  const schedule = parts.slice(0, 5).join(" ");
  const command = parts.slice(5).join(" ");
  if (!command) return null;

  // Compute the next fire time from the cron expression (host crontab carries
  // no next-run of its own) so host jobs reach parity with OpenClaw/Hermes.
  const nextRunAtMs = cronNextRunMs(schedule, Date.now());
  // Best-effort last-fired from the redirect log's mtime (host cron tracks no
  // run history; exit status is genuinely unknowable, so lastStatus stays null
  // and the UI labels host jobs "host cron — not tracked" rather than implying
  // they never ran).
  const lastRunAtMs = hostCronLastRunMs(command);

  return {
    id: `host-${index}`,
    name: hostCronName(command),
    schedule,
    scheduleHuman: cronToHuman(schedule),
    enabled: true,
    nextRun: formatNextRun(nextRunAtMs),
    nextRunAtMs,
    lastStatus: null,
    lastRunAtMs,
    command,
    agent: null,
    node,
    source: "host",
    readOnly: true,
  };
}

// Default reader for the host crontab. Returns the raw stdout of `crontab -l`,
// or "" when the user has no crontab / the command is unavailable.
function defaultHostCrontabReader() {
  const { execFileSync } = require("child_process");
  try {
    return execFileSync("crontab", ["-l"], {
      encoding: "utf8",
      timeout: HOST_CRONTAB_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // No crontab for user, crontab not installed, or timeout — contribute nothing.
    return "";
  }
}

let hostCrontabReader = defaultHostCrontabReader;

// Parse the host crontab into mapped job records. Defensive: never throws.
function getHostCronJobs(node) {
  let raw = "";
  try {
    raw = hostCrontabReader() || "";
  } catch {
    return [];
  }
  return String(raw)
    .split("\n")
    .map((line, i) => mapHostCronLine(line, i, node))
    .filter((job) => job !== null);
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

  let hostJobs = [];
  try {
    hostJobs = getHostCronJobs(node);
  } catch (e) {
    console.error("Failed to get host cron:", e.message);
  }

  return [...openclawJobs, ...hermesJobs, ...hostJobs];
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
 * @param {function} [options.hostCrontabReader] - replacement sync reader returning `crontab -l` stdout
 */
function _resetForTesting(options = {}) {
  cliCache = { rawJobs: null, fetchedAt: 0, refreshing: false, promise: null };
  cliRunner = options.cliRunner || defaultCliRunner;
  hostCrontabReader = options.hostCrontabReader || defaultHostCrontabReader;
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
  // Exported for unit tests — the host-crontab next-run calculator + mapper.
  cronFieldValues,
  cronNextRunMs,
  hostCronLastRunMs,
  mapHostCronLine,
};
