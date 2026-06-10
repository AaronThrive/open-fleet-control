/**
 * E2E suite helpers — server lifecycle, HTTP client, waiting, temp dirs,
 * and system Chrome discovery. No test framework; plain Node.
 */

"use strict";

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");

// ---------------------------------------------------------------------------
// Chrome discovery
// ---------------------------------------------------------------------------

const CHROME_CANDIDATES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
];

/**
 * Locate a system Chrome/Chromium executable on PATH.
 * @returns {string} absolute path to the executable
 * @throws {Error} when no candidate resolves
 */
function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  for (const name of CHROME_CANDIDATES) {
    try {
      const resolved = execFileSync("which", [name], { encoding: "utf8" }).trim();
      if (resolved) return resolved;
    } catch (e) {
      // not on PATH — try next candidate
    }
  }
  throw new Error(
    `No system Chrome found (tried: ${CHROME_CANDIDATES.join(", ")}). Set CHROME_PATH to override.`,
  );
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

/**
 * Reserve an ephemeral TCP port by binding to 0 and releasing it.
 * @returns {Promise<number>} a currently-free port
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/**
 * Minimal JSON HTTP client over global fetch with explicit failure messages.
 * @param {string} url - absolute URL
 * @param {object} [options] - fetch options (method/headers/body)
 * @returns {Promise<{status: number, body: object|null}>}
 */
async function httpJson(url, options = {}) {
  const init = { ...options };
  if (init.body !== undefined && typeof init.body !== "string") {
    init.body = JSON.stringify(init.body);
    init.headers = { "Content-Type": "application/json", ...(init.headers || {}) };
  }
  const response = await fetch(url, init);
  let body = null;
  try {
    body = await response.json();
  } catch (e) {
    // non-JSON body (e.g., HTML error page) — caller checks status
  }
  return { status: response.status, body };
}

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll an async predicate until it returns a truthy value.
 *
 * @param {function(): Promise<any>} predicate - returns truthy when satisfied
 * @param {object} [options]
 * @param {string} [options.label] - included in the timeout error
 * @param {number} [options.timeoutMs]
 * @param {number} [options.intervalMs]
 * @returns {Promise<any>} the truthy predicate result
 */
async function waitFor(predicate, { label = "condition", timeoutMs = 10000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (e) {
      lastError = e;
    }
    await sleep(intervalMs);
  }
  const detail = lastError ? ` (last error: ${lastError.message})` : "";
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}${detail}`);
}

// ---------------------------------------------------------------------------
// Temp dirs + fleet config
// ---------------------------------------------------------------------------

/**
 * Create the temp directory tree for one suite run (outside the repo).
 * @returns {{root: string, stateDir: string, logsDir: string, briefsDir: string, workspaceDir: string}}
 */
function makeTempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ofc-e2e-"));
  const dirs = {
    root,
    stateDir: path.join(root, "state"),
    logsDir: path.join(root, "logs"),
    briefsDir: path.join(root, "briefs"),
    workspaceDir: path.join(root, "workspace"),
  };
  for (const key of ["stateDir", "logsDir", "briefsDir", "workspaceDir"]) {
    fs.mkdirSync(dirs[key], { recursive: true });
  }
  return dirs;
}

/**
 * Build the FLEET_CONFIG_JSON blob for the e2e server.
 * Cortex disabled; fast mesh polling so SSE-driven refetches are quick.
 * @param {object} dirs - result of makeTempDirs()
 * @returns {string} JSON string
 */
function buildFleetConfigJson(dirs) {
  return JSON.stringify({
    stateDir: dirs.stateDir,
    logsDir: dirs.logsDir,
    briefsDir: dirs.briefsDir,
    workspaceDir: dirs.workspaceDir,
    mesh: { intervalMs: 1000 },
    cortex: { enabled: false },
  });
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/**
 * Boot `node lib/server.js` on the given port and wait for /api/health.
 *
 * @param {object} options
 * @param {number} options.port
 * @param {string} options.fleetConfigJson
 * @returns {Promise<{child: import('child_process').ChildProcess, stop: function(): Promise<void>}>}
 */
async function startServer({ port, fleetConfigJson }) {
  const child = spawn(process.execPath, [path.join(REPO_ROOT, "lib", "server.js")], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "localhost",
      DASHBOARD_AUTH_MODE: "none",
      FLEET_CONFIG_JSON: fleetConfigJson,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const capture = (chunk) => {
    output += chunk.toString();
    if (output.length > 20000) output = output.slice(-10000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  const exited = new Promise((resolve) => child.once("exit", resolve));

  try {
    await waitFor(
      async () => {
        if (child.exitCode !== null) {
          throw new Error(`server exited early (code ${child.exitCode})`);
        }
        const { status } = await httpJson(`http://localhost:${port}/api/health`);
        return status === 200;
      },
      { label: `server health on port ${port}`, timeoutMs: 15000 },
    );
  } catch (e) {
    child.kill("SIGKILL");
    throw new Error(`${e.message}\n--- server output ---\n${output}`);
  }

  async function stop() {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    const result = await Promise.race([exited, sleep(4000).then(() => "timeout")]);
    if (result === "timeout") {
      child.kill("SIGKILL");
      await exited;
    }
  }

  return { child, stop, getOutput: () => output };
}

module.exports = {
  REPO_ROOT,
  findChrome,
  getFreePort,
  httpJson,
  sleep,
  waitFor,
  makeTempDirs,
  buildFleetConfigJson,
  startServer,
};
