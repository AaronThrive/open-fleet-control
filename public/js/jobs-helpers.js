/**
 * Pure helpers for the AI Jobs page (public/jobs.html).
 *
 * DOM-free so node:test can import them directly; jobs.html imports this
 * module from its inline <script type="module">.
 */

/** A no-op translator with the t(key, params, fallback) shape. */
const identityTranslate = (key, params, fallback) => fallback;

/**
 * Job status for badges and filtering: paused beats failed; a job is only
 * "failed" after two or more consecutive failed runs.
 * @returns {"paused"|"failed"|"enabled"}
 */
export function getJobStatus(job) {
  if (job.paused) return "paused";
  if (job.stats?.streak?.type === "failed" && job.stats.streak.count >= 2) return "failed";
  return "enabled";
}

/** Filter jobs by the page-level status filter ("all"|"active"|"paused"|"failed"). */
export function filterJobsByStatus(jobs, filter) {
  if (filter === "all") return [...jobs];
  return jobs.filter((job) => {
    const status = getJobStatus(job);
    if (filter === "active") return status === "enabled";
    return status === filter;
  });
}

/** Aggregate counts + overall success rate for the stats bar. */
export function summarizeJobs(jobs) {
  let totalRuns = 0;
  let totalSuccess = 0;
  for (const job of jobs) {
    totalRuns += job.stats?.totalRuns || 0;
    totalSuccess += job.stats?.totalSuccess || 0;
  }
  return {
    total: jobs.length,
    active: jobs.filter((job) => !job.paused).length,
    paused: jobs.filter((job) => job.paused).length,
    failed: jobs.filter((job) => getJobStatus(job) === "failed").length,
    successRate: totalRuns > 0 ? Math.round((totalSuccess / totalRuns) * 100) : 100,
  };
}

/**
 * Human-readable schedule from the job definition's schedule field
 * (string | {cron} | {interval} | {at}). Pass the page's t() so interval/at
 * phrasing stays localizable.
 */
export function formatSchedule(schedule, translate = identityTranslate) {
  if (!schedule) return "—";
  if (typeof schedule === "string") return schedule;
  if (schedule.cron) return schedule.cron;
  if (schedule.interval) {
    return translate("jobs.every", { value: schedule.interval }, `Every ${schedule.interval}`);
  }
  if (schedule.at) {
    return translate("jobs.at", { value: schedule.at }, `At ${schedule.at}`);
  }
  return JSON.stringify(schedule);
}
