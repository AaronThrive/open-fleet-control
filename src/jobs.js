/**
 * Jobs Dashboard API Handler
 *
 * Wraps the jobs API for the dashboard server.
 * Uses dynamic imports to bridge CommonJS server with ESM jobs modules.
 */

const path = require("path");
const { CONFIG } = require("./config");

// Jobs directory (from config with auto-detection)
const JOBS_DIR = CONFIG.paths.jobs;
const JOBS_STATE_DIR = path.join(CONFIG.paths.state, "jobs");

let apiInstance = null;
let forceApiUnavailable = false; // For testing
let cronFallbackFn = null; // () => cron jobs; injected by index.js (see setCronFallback)
let auditRecordFn = null; // (entry) => void; injected by index.js (see setAuditRecorder)

const IDENTITY_HEADER = "tailscale-user-login";

/** Identity from the Tailscale Serve header (fallback "anonymous"). */
function getUser(req) {
  const login = req && req.headers ? req.headers[IDENTITY_HEADER] : undefined;
  return typeof login === "string" && login.trim().length > 0
    ? login.trim().toLowerCase()
    : "anonymous";
}

/** Best-effort audit record — an audit failure never fails the request. */
function recordAudit(req, action, target, detail) {
  if (typeof auditRecordFn !== "function") return;
  try {
    auditRecordFn({ user: getUser(req), action, target, detail });
  } catch (e) {
    console.error("[Jobs] Audit record failed:", e.message);
  }
}

/**
 * Inject the audit recorder (the fleet runtime's audit.record). Mutating
 * jobs routes (run/pause/resume/skip/kill + cache clear) record entries
 * through it; when absent, auditing is silently skipped.
 * @param {(entry: object) => void} fn
 */
function setAuditRecorder(fn) {
  auditRecordFn = fn;
}

/**
 * Initialize the jobs API (lazy-loaded due to ESM)
 */
async function getAPI() {
  if (forceApiUnavailable) return null;
  if (apiInstance) return apiInstance;

  try {
    const { createJobsAPI } = await import(path.join(JOBS_DIR, "lib/api.js"));
    apiInstance = createJobsAPI({
      definitionsDir: path.join(JOBS_DIR, "definitions"),
      stateDir: JOBS_STATE_DIR,
    });
    return apiInstance;
  } catch (e) {
    console.error("Failed to load jobs API:", e.message);
    return null;
  }
}

/**
 * Reset API state for testing purposes
 * @param {Object} options - Reset options
 * @param {boolean} options.forceUnavailable - If true, getAPI() will return null
 * @param {Object} options.api - Inject a fake jobs API instance
 */
function _resetForTesting(options = {}) {
  apiInstance = options.api || null;
  forceApiUnavailable = options.forceUnavailable || false;
  cronFallbackFn = null;
  auditRecordFn = null;
}

/**
 * Inject a cron jobs source used when the optional jobs library is absent.
 * The fallback presents scheduled cron jobs (OpenClaw/Hermes dual-source) as
 * read-only jobs so the AI Jobs page works without the library.
 * @param {() => Array<Object>} fn - returns cron jobs (see src/cron.js shape)
 */
function setCronFallback(fn) {
  cronFallbackFn = fn;
}

/** Map a cron job (src/cron.js shape) to the jobs-page job shape. */
function cronJobToJob(job) {
  const failing = job.lastStatus === "error";
  return {
    id: job.id,
    name: job.name,
    description: [job.agent, job.node].filter(Boolean).join(" @ "),
    schedule: job.schedule,
    scheduleHuman: job.scheduleHuman || null,
    paused: !job.enabled,
    nextRunRelative: job.nextRun || null,
    lastRun: null,
    lane: job.source,
    tags: [job.source, job.agent].filter(Boolean),
    readOnly: true,
    ...(failing ? { stats: { streak: { type: "failed", count: 2 } } } : {}),
  };
}

/** Cron jobs mapped for the jobs page, or null when unavailable/empty. */
function getCronBackedJobs() {
  if (!cronFallbackFn) return null;
  try {
    const cronJobs = cronFallbackFn();
    if (!Array.isArray(cronJobs) || cronJobs.length === 0) return null;
    return cronJobs.map(cronJobToJob);
  } catch (e) {
    console.error("Jobs cron fallback failed:", e.message);
    return null;
  }
}

/** Serve /api/jobs/* from the cron source (read-only). Returns true if handled. */
function handleCronBackedRequest(res, pathname, method, jobs) {
  const json = (code, payload) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload, null, 2));
  };

  if (method !== "GET") {
    json(405, { error: "Jobs are backed by the read-only cron source — manage them in Cron." });
    return true;
  }

  if (pathname === "/api/jobs") {
    json(200, { available: true, source: "cron", readOnly: true, jobs, timestamp: Date.now() });
    return true;
  }

  if (pathname === "/api/jobs/stats") {
    json(200, {
      available: true,
      source: "cron",
      stats: {
        totalJobs: jobs.length,
        activeJobs: jobs.filter((j) => !j.paused).length,
        pausedJobs: jobs.filter((j) => j.paused).length,
      },
      timestamp: Date.now(),
    });
    return true;
  }

  if (pathname === "/api/jobs/scheduler/status") {
    json(200, { available: true, source: "cron", running: true, readOnly: true });
    return true;
  }

  const historyMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/history$/);
  if (historyMatch) {
    json(200, { available: true, source: "cron", history: [] });
    return true;
  }

  const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobMatch) {
    const job = jobs.find((j) => j.id === decodeURIComponent(jobMatch[1]));
    if (!job) {
      json(404, { error: "Job not found" });
      return true;
    }
    json(200, { available: true, source: "cron", readOnly: true, job });
    return true;
  }

  json(404, { error: "Not found" });
  return true;
}

/**
 * Format relative time
 */
function formatRelativeTime(isoString) {
  if (!isoString) return null;
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.round(diffMs / 60000);

  if (diffMins < 0) {
    const futureMins = Math.abs(diffMins);
    if (futureMins < 60) return `in ${futureMins}m`;
    if (futureMins < 1440) return `in ${Math.round(futureMins / 60)}h`;
    return `in ${Math.round(futureMins / 1440)}d`;
  }

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffMins < 1440) return `${Math.round(diffMins / 60)}h ago`;
  return `${Math.round(diffMins / 1440)}d ago`;
}

/**
 * Handle jobs API requests
 */
async function handleJobsRequest(req, res, pathname, query, method) {
  const api = await getAPI();

  if (!api) {
    // The optional jobs library is absent — present cron jobs (OpenClaw +
    // Hermes dual-source) as read-only jobs so the page still works.
    const cronJobs = getCronBackedJobs();
    if (cronJobs) {
      handleCronBackedRequest(res, pathname, method, cronJobs);
      return;
    }

    // Graceful degradation: the optional jobs library is not installed.
    // Return 200 with an availability flag so clients can hide the feature
    // instead of surfacing a server error.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        available: false,
        reason: "Jobs library not installed",
        jobs: [],
        timestamp: Date.now(),
      }),
    );
    return;
  }

  try {
    // Scheduler status: GET /api/jobs/scheduler/status (before single job route)
    if (pathname === "/api/jobs/scheduler/status" && method === "GET") {
      const status = await api.getSchedulerStatus();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status, null, 2));
      return;
    }

    // Aggregate stats: GET /api/jobs/stats (before single job route)
    if (pathname === "/api/jobs/stats" && method === "GET") {
      const stats = await api.getAggregateStats();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(stats, null, 2));
      return;
    }

    // Clear cache: POST /api/jobs/cache/clear (before single job route)
    if (pathname === "/api/jobs/cache/clear" && method === "POST") {
      api.clearCache();
      recordAudit(req, "cache.clear", "jobs", null);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, message: "Cache cleared" }));
      return;
    }

    // List all jobs: GET /api/jobs
    if (pathname === "/api/jobs" && method === "GET") {
      const jobs = await api.listJobs();

      // Enhance with relative times
      const enhanced = jobs.map((job) => ({
        ...job,
        lastRunRelative: formatRelativeTime(job.lastRun),
        nextRunRelative: formatRelativeTime(job.nextRun),
      }));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ available: true, jobs: enhanced, timestamp: Date.now() }, null, 2));
      return;
    }

    // Get single job: GET /api/jobs/:id
    const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobMatch && method === "GET") {
      const jobId = decodeURIComponent(jobMatch[1]);
      const job = await api.getJob(jobId);

      if (!job) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Job not found" }));
        return;
      }

      // Enhance with relative times
      job.lastRunRelative = formatRelativeTime(job.lastRun);
      job.nextRunRelative = formatRelativeTime(job.nextRun);
      if (job.recentRuns) {
        job.recentRuns = job.recentRuns.map((run) => ({
          ...run,
          startedAtRelative: formatRelativeTime(run.startedAt),
          completedAtRelative: formatRelativeTime(run.completedAt),
        }));
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(job, null, 2));
      return;
    }

    // Get job history: GET /api/jobs/:id/history
    const historyMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/history$/);
    if (historyMatch && method === "GET") {
      const jobId = decodeURIComponent(historyMatch[1]);
      const limit = parseInt(query.get("limit") || "50", 10);
      const runs = await api.getJobHistory(jobId, limit);

      const enhanced = runs.map((run) => ({
        ...run,
        startedAtRelative: formatRelativeTime(run.startedAt),
        completedAtRelative: formatRelativeTime(run.completedAt),
      }));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ runs: enhanced, timestamp: Date.now() }, null, 2));
      return;
    }

    // Run job: POST /api/jobs/:id/run
    const runMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/run$/);
    if (runMatch && method === "POST") {
      const jobId = decodeURIComponent(runMatch[1]);
      const result = await api.runJob(jobId);
      recordAudit(req, "job.run", jobId, { success: !!result.success });

      res.writeHead(result.success ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result, null, 2));
      return;
    }

    // Pause job: POST /api/jobs/:id/pause
    const pauseMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/pause$/);
    if (pauseMatch && method === "POST") {
      const jobId = decodeURIComponent(pauseMatch[1]);

      // Parse body for reason
      let body = "";
      await new Promise((resolve) => {
        req.on("data", (chunk) => (body += chunk));
        req.on("end", resolve);
      });

      let reason = null;
      try {
        const parsed = JSON.parse(body || "{}");
        reason = parsed.reason;
      } catch (_e) {
        /* ignore parse errors */
      }

      const result = await api.pauseJob(jobId, {
        by: req.authUser?.login || "dashboard",
        reason,
      });
      recordAudit(req, "job.update", jobId, { op: "pause" });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result, null, 2));
      return;
    }

    // Resume job: POST /api/jobs/:id/resume
    const resumeMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/resume$/);
    if (resumeMatch && method === "POST") {
      const jobId = decodeURIComponent(resumeMatch[1]);
      const result = await api.resumeJob(jobId);
      recordAudit(req, "job.update", jobId, { op: "resume" });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result, null, 2));
      return;
    }

    // Skip job: POST /api/jobs/:id/skip
    const skipMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/skip$/);
    if (skipMatch && method === "POST") {
      const jobId = decodeURIComponent(skipMatch[1]);
      const result = await api.skipJob(jobId);
      recordAudit(req, "job.update", jobId, { op: "skip" });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result, null, 2));
      return;
    }

    // Kill job: POST /api/jobs/:id/kill
    const killMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/kill$/);
    if (killMatch && method === "POST") {
      const jobId = decodeURIComponent(killMatch[1]);
      const result = await api.killJob(jobId);
      recordAudit(req, "job.update", jobId, { op: "kill" });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result, null, 2));
      return;
    }

    // Not found
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (e) {
    console.error("Jobs API error:", e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

/**
 * Check if a request should be handled by jobs API
 */
function isJobsRoute(pathname) {
  return pathname.startsWith("/api/jobs");
}

module.exports = {
  handleJobsRequest,
  isJobsRoute,
  setCronFallback,
  setAuditRecorder,
  _resetForTesting,
};
