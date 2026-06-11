/**
 * Cron write-actions — enable/disable and run-now for OPENCLAW-source jobs.
 *
 * Discovery (openclaw 2026.6.5 `cron --help`): the CLI supports add, edit,
 * rm, enable, disable, run, get, show, list, runs, status. This module
 * implements the dashboard's write surface: `cron enable|disable|run <id>`.
 *
 * Conventions:
 *   - factory/DI: ALL CLI interaction goes through the injected execFn;
 *     tests never spawn the real openclaw binary.
 *   - Hermes-source jobs are read-only (403); unknown ids are 404.
 *   - After a successful mutation the injected refreshJobs() is awaited so
 *     the 60s-TTL CLI cache reflects the change before the UI refetches.
 *     A refresh failure never fails the mutation (the CLI already applied it).
 */

const { execFile } = require("child_process");

const CLI_TIMEOUT_MS = 30000;

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/** Default production runner — same env hygiene as src/cron.js. */
function defaultExecFn(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "openclaw",
      args,
      {
        encoding: "utf8",
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
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
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || "").trim();
          reject(new Error(detail ? `${error.message}: ${detail}` : error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Create the cron actions module.
 *
 * @param {object} options
 * @param {function} [options.execFn] - async (args: string[]) => stdout;
 *   rejects on CLI failure. Defaults to spawning the openclaw binary.
 * @param {function} options.getJobs - () => mapped jobs (getCronJobs output);
 *   used to resolve a job's source before mutating.
 * @param {function} [options.refreshJobs] - async () => void; invalidates and
 *   refreshes the cached CLI job list after a successful mutation.
 * @returns {{setJobEnabled: function, runJobNow: function}}
 */
function createCronActions({ execFn = defaultExecFn, getJobs, refreshJobs = async () => {} }) {
  if (typeof getJobs !== "function") {
    throw new Error("createCronActions requires a getJobs function");
  }

  /** Validate the id, resolve the job and enforce the writable source. */
  function requireWritableJob(id) {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw httpError(400, "Job id must be a non-empty string");
    }
    let jobs;
    try {
      jobs = getJobs();
    } catch (e) {
      throw httpError(503, `Cron job list unavailable: ${e.message}`);
    }
    const job = (Array.isArray(jobs) ? jobs : []).find((j) => j && j.id === id);
    if (!job) {
      throw httpError(404, `Cron job '${id}' not found`);
    }
    if (job.source !== "openclaw") {
      throw httpError(
        403,
        `Cron job '${id}' comes from a read-only source ('${job.source}') — only OpenClaw jobs can be modified from the dashboard`,
      );
    }
    return job;
  }

  function profileArgs() {
    const profile = process.env.OPENCLAW_PROFILE || "";
    return profile ? ["--profile", profile] : [];
  }

  /** Run a cron subcommand, then refresh the cached job list (best-effort). */
  async function mutate(subcommand, id) {
    try {
      await execFn([...profileArgs(), "cron", subcommand, id]);
    } catch (e) {
      throw httpError(502, `openclaw cron ${subcommand} failed: ${e.message}`);
    }
    try {
      await refreshJobs();
    } catch (e) {
      console.error("[CronActions] Post-mutation cache refresh failed:", e.message);
    }
  }

  /**
   * Enable or disable an OpenClaw cron job.
   * @param {string} id
   * @param {boolean} enabled
   * @returns {Promise<{id: string, enabled: boolean}>}
   */
  async function setJobEnabled(id, enabled) {
    requireWritableJob(id);
    await mutate(enabled ? "enable" : "disable", id);
    return { id, enabled: Boolean(enabled) };
  }

  /**
   * Trigger an immediate run of an OpenClaw cron job (queued by the
   * scheduler; this does not wait for the run to finish).
   * @param {string} id
   * @returns {Promise<{id: string, triggered: boolean}>}
   */
  async function runJobNow(id) {
    requireWritableJob(id);
    await mutate("run", id);
    return { id, triggered: true };
  }

  return { setJobEnabled, runJobNow };
}

module.exports = { createCronActions };
