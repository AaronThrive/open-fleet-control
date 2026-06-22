/**
 * Configuration loader with sensible defaults
 *
 * Priority order:
 * 1. Environment variables (highest)
 * 2. config/dashboard.json file
 * 3. Auto-detected paths
 * 4. Sensible defaults (lowest)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { defaultSecrets } = require("./secrets");

const HOME = os.homedir();

/**
 * Get the OpenClaw profile directory (e.g., ~/.openclaw or ~/.openclaw-<profile>)
 * This is the canonical source for profile-aware paths.
 */
function getOpenClawDir(profile = null) {
  const effectiveProfile = profile || process.env.OPENCLAW_PROFILE || "";
  return effectiveProfile
    ? path.join(HOME, `.openclaw-${effectiveProfile}`)
    : path.join(HOME, ".openclaw");
}

/**
 * Auto-detect OpenClaw workspace by checking common locations
 * Profile-aware: checks profile-specific paths first when OPENCLAW_PROFILE is set
 */
function detectWorkspace() {
  const profile = process.env.OPENCLAW_PROFILE || "";
  const openclawDir = getOpenClawDir();
  const defaultWorkspace = path.join(openclawDir, "workspace");

  // Build candidates list - profile-specific paths come first
  const profileCandidates = profile
    ? [
        // Profile-specific workspace in home (e.g., ~/.openclaw-<profile>-workspace)
        path.join(HOME, `.openclaw-${profile}-workspace`),
        path.join(HOME, `.${profile}-workspace`),
      ]
    : [];

  const candidates = [
    // Environment variable (highest priority)
    process.env.OPENCLAW_WORKSPACE,
    // OpenClaw's default workspace location
    process.env.OPENCLAW_HOME,
    // Gateway config workspace (check early - this is where OpenClaw actually runs)
    getWorkspaceFromGatewayConfig(),
    // Profile-specific paths (if profile is set)
    ...profileCandidates,
    // Standard OpenClaw workspace location (profile-aware: ~/.openclaw/workspace or ~/.openclaw-<profile>/workspace)
    defaultWorkspace,
    // Common custom workspace names
    path.join(HOME, "openclaw-workspace"),
    path.join(HOME, ".openclaw-workspace"),
    // Legacy/custom names
    path.join(HOME, "molty"),
    path.join(HOME, "clawd"),
    path.join(HOME, "moltbot"),
  ].filter(Boolean);

  // Find first existing candidate that looks like a workspace
  const foundWorkspace = candidates.find((candidate) => {
    if (!candidate || !fs.existsSync(candidate)) {
      return false;
    }

    // Verify it looks like a workspace (has memory/ or state/ dir)
    const hasMemory = fs.existsSync(path.join(candidate, "memory"));
    const hasState = fs.existsSync(path.join(candidate, "state"));
    const hasConfig = fs.existsSync(path.join(candidate, ".openclaw"));

    return hasMemory || hasState || hasConfig;
  });

  // Return found workspace or default (will be created on first use)
  return foundWorkspace || defaultWorkspace;
}

/**
 * Try to get workspace from OpenClaw gateway config
 * Profile-aware: checks the profile directory first when OPENCLAW_PROFILE is set
 */
function getWorkspaceFromGatewayConfig() {
  const openclawDir = getOpenClawDir();
  const configPaths = [
    path.join(openclawDir, "config.yaml"),
    path.join(openclawDir, "config.json"),
    path.join(openclawDir, "openclaw.json"),
    path.join(openclawDir, "clawdbot.json"),
    // Fallback to standard XDG location
    path.join(HOME, ".config", "openclaw", "config.yaml"),
  ];

  for (const configPath of configPaths) {
    try {
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, "utf8");
        // Simple extraction - look for workspace or workdir
        const match =
          content.match(/workspace[:\s]+["']?([^"'\n]+)/i) ||
          content.match(/workdir[:\s]+["']?([^"'\n]+)/i);
        if (match && match[1]) {
          const workspace = match[1].trim().replace(/^~/, HOME);
          if (fs.existsSync(workspace)) {
            return workspace;
          }
        }
      }
    } catch (e) {
      // Ignore errors, continue searching
    }
  }
  return null;
}

/**
 * Deep merge two objects (local overrides base)
 */
function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      override[key] &&
      typeof override[key] === "object" &&
      !Array.isArray(override[key]) &&
      base[key] &&
      typeof base[key] === "object"
    ) {
      result[key] = deepMerge(base[key], override[key]);
    } else if (override[key] !== null && override[key] !== undefined) {
      result[key] = override[key];
    }
  }
  return result;
}

/**
 * Load config files - base + local overrides
 * @param {Object} [options]
 * @param {string} [options.localPath] - override the local-overrides file path
 *   (tests use this to isolate from the developer's real dashboard.local.json)
 */
function loadConfigFile({ localPath: localPathOverride } = {}) {
  const basePath = path.join(__dirname, "..", "config", "dashboard.json");
  const localPath =
    localPathOverride || path.join(__dirname, "..", "config", "dashboard.local.json");

  let config = {};

  // Load base config
  try {
    if (fs.existsSync(basePath)) {
      const content = fs.readFileSync(basePath, "utf8");
      config = JSON.parse(content);
    }
  } catch (e) {
    console.warn(`[Config] Failed to load ${basePath}:`, e.message);
  }

  // Merge local overrides
  try {
    if (fs.existsSync(localPath)) {
      const content = fs.readFileSync(localPath, "utf8");
      const localConfig = JSON.parse(content);
      config = deepMerge(config, localConfig);
      console.log(`[Config] Loaded local overrides from ${localPath}`);
    }
  } catch (e) {
    console.warn(`[Config] Failed to load ${localPath}:`, e.message);
  }

  return config;
}

/**
 * Expand ~ and environment variables in paths
 */
function expandPath(p) {
  if (!p) return p;
  return p
    .replace(/^~/, HOME)
    .replace(/\$HOME/g, HOME)
    .replace(/\$\{HOME\}/g, HOME);
}

/**
 * Fleet defaults — see config/dashboard.example.json for documentation.
 * Alerts default OFF; cortex paths default empty (adapter unavailable until
 * the operator points them at real, user-specific locations).
 */
const FLEET_DEFAULTS = {
  stateDir: "state",
  logsDir: "logs",
  briefsDir: "briefs",
  workspaceDir: ".",
  // Session list source: "files" reads the OpenClaw session store JSON
  // directly (fast, no CLI spawn); "cli" shells out to `openclaw sessions
  // --json` via the async background worker.
  sessionsSource: "files",
  // Background sessions-cache refresh interval (ms).
  sessionsRefreshMs: 30000,
  // When false this instance never spawns the openclaw CLI nor parses
  // OpenClaw session/usage data (secondary-instance economy mode).
  openclawSources: true,
  // mesh.seed: a fleet-wide list of node records auto-registered into this
  // node's mesh registry on boot (zero-touch join — removes the manual
  // POST /api/fleet/mesh/nodes step). The SAME list ships on every node;
  // each node skips its own entry (by hostname) at seed time. Empty = no-op
  // (byte-identical to pre-seed behavior). Each entry: {hostname, port?,
  // healthPath?, platform?, label?}; OFC dashboards use healthPath
  // "/api/health" so agent-locator routes agent-run to the dashboard.
  // Deep-merges from FLEET_CONFIG_JSON / dashboard(.local).json like the
  // rest of fleet.*.
  mesh: { intervalMs: 15000, seed: [] },
  federation: { intervalMs: 30000 },
  watchdog: { thresholdMs: 1800000 },
  alerts: {
    enabled: false,
    rules: {
      nodeOffline: true,
      nodeUnreachable: true,
      taskFailed: true,
      taskStale: true,
      lessonPending: true,
      budgetBreach: true,
      // Dispatch follow-through completion ping (src/dispatch.js watcher).
      // Deliberately OFF by default — opt in via settings or the config file.
      dispatchComplete: false,
      // Dispatch watchdog reclaimed a stuck/silent in-flight lock
      // (src/dispatch-watchdog.js). ON by default — a reclaim means a dispatch
      // went silent and was retried or failed, which an operator should see.
      dispatchReclaimed: true,
      // Flight Recorder: a board/chain run failed or a seat timed out
      // (src/run-archive.js → fleet.fireAlert). ON by default so a failed
      // orchestration surfaces; routed to whichever sinks are configured (ntfy).
      orchestrationFailed: true,
    },
    sinks: {
      slack: { enabled: false, gatewayUrl: "", channel: "" },
      // ntfy push sink (src/alerts.js dispatchToNtfy). Disabled by default; set
      // {enabled:true, topic:"<secret-topic>"} (optional server, default
      // https://ntfy.sh) to receive Flight Recorder failure alerts on a phone.
      ntfy: { enabled: false, server: "", topic: "" },
      webhooks: [],
    },
    // Ingestion: alerts INTO the dashboard (not out). The ntfy poller pulls every
    // alert published to the ntfy topic (reuses sinks.ntfy server/topic); the
    // cron-log poller logs every OpenClaw-container cron RUN. Both feed the unified
    // Alerts hub tagged source:"ntfy"/"cron". Disabled by default.
    ingest: {
      ntfy: { enabled: false, intervalMs: 30000 },
      cron: { enabled: false, intervalMs: 120000 },
    },
  },
  validationGate: { default: true },
  evolution: {
    // Directory inside the gbrain-synced Obsidian vault where APPROVED lessons
    // are mirrored as one markdown file per lesson (<id>.md with YAML
    // frontmatter). The existing nightly `gbrain import "<vault>"` then ingests
    // them into the knowledge store. Empty = no vault mirror (default; the
    // lessons_learned ledger remains the sole record).
    lessonsVaultDir: "",
  },
  cortex: {
    enabled: true,
    gbrainCli: "",
    headroomStats: "",
    leanCtxStats: "",
    lcmDb: "",
  },
  docker: { portainerUrl: null },
  usage: {
    claudeProjectsDir: "~/.claude/projects",
    codexDir: "~/.codex",
    nineRouterDb: "~/.openclaw/9router/data/db/data.sqlite",
    // Empty = reuse fleet.cortex.headroomStats (single source of truth for
    // the headroom subscription stats file).
    headroomStats: "",
    // OpenRouter API key for credit/key info. OPENROUTER_API_KEY env var
    // takes precedence at wiring time (src/index.js).
    openrouterKey: "",
  },
  // Kanban → agent dispatch (src/dispatch.js). baseUrl empty = this server's
  // own http://127.0.0.1:<port>; node empty = os.hostname() (both resolved at
  // wiring time in src/index.js / the dispatch module itself).
  //
  // token: shared Bearer secret for node→node agent-run auth. When set, the
  // sender (runRemote) attaches Authorization: Bearer <token> and the receiver's
  // guardActionPost token branch accepts it — the only branch that works when
  // verifyServeOrigin is ON (the mesh-peer branch matches HOSTNAMES, but a
  // verified Serve login is a tailnet USER). Empty = header omitted (today's
  // behavior, byte-identical). Supports op:// refs (resolved at config load).
  // identity: this node's Tailscale-User-Login value on node→node calls;
  // empty = callers fall back to os.hostname().
  dispatch: {
    enabled: true,
    baseUrl: "",
    maxConcurrent: 3,
    // Per-agent run timeout (sets the agent CLI --timeout + open-attempt TTL).
    // Raised 600 -> 1200: real Codex analytical turns ran >11 min and still
    // weren't done at 600s. This is the load-bearing timeout — orchestrate's
    // own wait budget never reaches the agent process.
    timeoutSec: 1200,
    node: "",
    token: "",
    identity: "",
  },
  // Dispatch liveness watchdog + stale-lock sweeper (src/dispatch-watchdog.js).
  // Periodically reclaims in-flight dispatch locks that have gone silent past
  // staleAfterMs (e.g. a server crash mid-run left an open attempt wedged),
  // re-dispatching under the retry cap and marking failed once the cap is hit.
  //   enabled: ON by default — reclaiming a stuck lock is the only path back
  //     from a crash-wedged card; conservative defaults keep it safe on a live
  //     fleet. Set false to disable entirely (the watchdog becomes inert).
  //   checkIntervalMs: sweep cadence (default 60s).
  //   staleAfterMs: silence threshold before a lock is reclaimed. Default 25min,
  //     safely past the 20-min dispatch.timeoutSec so a legitimately running
  //     dispatch (which closes its own attempt at the timeout) is NEVER reclaimed.
  //     The watchdog ALSO hard-floors this at dispatch.timeoutSec + 60s, so even a
  //     misconfigured small value can't re-dispatch live work. Raise if turns run long.
  //   maxRetries: re-dispatch attempts before a card is marked failed (default 2).
  dispatchWatchdog: {
    enabled: true,
    checkIntervalMs: 60000,
    staleAfterMs: 1500000,
    maxRetries: 2,
  },
  // Multi-agent orchestration (src/orchestrate.js).
  // sequentialBoard: when true, board councils dispatch advisors ONE-AT-A-TIME
  // (each with its own fresh timeout) instead of in parallel — the single-box
  // reliability default, because a parallel council co-saturates the one gateway
  // event loop. A per-run `sequential` flag on POST /api/fleet/orchestrate
  // overrides this (true=force-sequential, false=force-parallel).
  // timeoutSec: the runner's per-seat WAIT budget; kept >= dispatch.timeoutSec so
  // the runner never gives up before the agent process is actually killed.
  orchestrate: {
    sequentialBoard: true,
    timeoutSec: 1200,
    // M-2 — projected USD cost of a single parallel board seat. Used ONLY by the
    // pre-dispatch budget gate when the worker pool is active and the board fans
    // seats in parallel: it refuses a board whose projected (perSeatCostUSD ×
    // seatCount) already reaches the CLOSED ceiling, BEFORE K seats fan out.
    // 0/unset disables the projection (gate behaves exactly as before).
    perSeatCostUSD: 0,
  },
  // Flight Recorder (src/run-archive.js): durable archive of board/chain runs,
  // surfaced by the "Flight Recorder" dashboard tab. Additive — when disabled,
  // no archive is built and orchestrate behaves byte-identically to today.
  //   nodeId: this instance's id stamped on every archived row (multi-instance
  //     ready from day one). Empty = resolved to dispatch.identity / dispatch.node
  //     / os.hostname() at wiring time.
  //   alertOnFailure: fire an ntfy/alert when a run fails or a seat times out.
  //   retentionDays / maxRows: lazy-prune bounds on the archive DB.
  flightRecorder: {
    enabled: true,
    nodeId: "",
    alertOnFailure: true,
    retentionDays: 30,
    maxRows: 5000,
  },
  rateLimit: { windowMs: 60000, max: 120 },
  // Cost budgets (USD) over LLM API spend — see src/budgets.js. 0 = no limit.
  // enforce.enabled gates dispatch blocking when a budget crosses 100%.
  budgets: {
    enabled: false,
    daily: { totalUSD: 0, perProvider: {} },
    weekly: { totalUSD: 0, perProvider: {} },
    checkIntervalMs: 900000,
    enforce: { enabled: false },
    // Per-provider billing mode read by the budgets evaluator (src/budgets.js):
    // "subscription" providers are excluded from per-token spend totals,
    // "per-token" providers are metered. Mirrors config.billing.providerBillingModes.
    providerBillingModes: {
      codex: "subscription",
      "claude-code": "subscription",
      openrouter: "per-token",
      gemini: "per-token",
    },
  },
  // Scheduled fleet digest (src/digest.js): compact markdown summary
  // delivered through the alert sinks. ["*"] = every configured sink.
  digest: { enabled: false, schedule: "daily", hourUtc: 8, sinks: ["*"] },
  // Per-instance agents roster source (GET /api/agents — src/agents-roster.js).
  // source: "openclaw" reads openclaw.json + per-agent session dirs (default,
  // preserves prior behavior); "hermes" enumerates Hermes-system agents from
  // hermesDir; "none" serves an empty local roster (pure aggregator).
  // openclawConfigPath/agentsDir empty = profile-aware ~/.openclaw defaults
  // wired in src/index.js.
  agents: {
    source: "openclaw",
    openclawConfigPath: "",
    agentsDir: "",
    hermesDir: "~/.hermes",
  },
  // On-demand isolated-worker pool (src/agent-spawn.js — AC-21).
  // Defaults to disabled (enabled:false) so no dispatch/orchestrate behaviour
  // changes until an operator explicitly opts in. All tunables have sane
  // defaults that match the KVM8 single-box capacity model (32 GiB RAM,
  // target 4–6 workers, hard ceiling ~8).
  //
  // env > FLEET_CONFIG_JSON > dashboard(.local).json > defaults (same
  // resolution chain as every other fleet.* block).
  spawn: {
    // Feature gate — must be explicitly set to true to activate the pool.
    enabled: false,
    // H-2 — this instance's worker-roster name prefix. Pool membership is bound
    // to a rendered container name `^<prefix>-worker-...$` (NOT the bare
    // com.ofc.pool label, which is not a trust boundary). Empty = derive from
    // fleet.dispatch.node; if BOTH are empty the controller fails closed and
    // registers nothing.
    workerNamePrefix: "",
    // H-2 — the controller's OWN authority for the worker health/dispatch port.
    // When > 0 it is pinned and any com.ofc.pool.port container label is ignored
    // (a label cannot redirect probes/dispatch). 0 = fall back to the label
    // (only ever reached after the name-pattern trust check passes).
    workerPort: 0,
    // Hard ceiling on the number of concurrent worker containers.
    poolCeiling: 8,
    // Desired steady-state pool size (target peak).
    targetPeak: 6,
    // Per-worker memory cap (bytes): 2.5 GiB, matches the container's
    // HostConfig.Memory verified at acquire time (AC-3).
    workerMemBytes: 2684354560,
    // Number of consecutive /health OKs required before a worker is
    // registered in the mesh and considered ready for leasing (AC-5).
    readinessOks: 3,
    // Maximum time (ms) to wait for a worker to pass the readiness gate.
    readinessTimeoutMs: 10000,
    // Time (ms) a worker may be idle before the reaper stops it (AC-4).
    idleReapMs: 60000,
    // Reconcile-loop interval (ms): rebuilds pool from docker ps (AC-8).
    reconcileMs: 5000,
    // Max worker lifetime before a drain-and-recycle is triggered (AC-9).
    maxLifetimeMs: 3600000,
    // Per-worker recycle jitter window (ms) to spread pool recycling (AC-9).
    recycleJitterMs: 5000,
    // Maximum in-flight requests per advisor that can wait in the queue (AC-10).
    queueMax: 100,
    // Maximum time (ms) a queued request may wait before timing out (AC-10).
    queueDeadlineMs: 30000,
    // Maximum time (ms) to wait for a Slack result before the fallback
    // "couldn't complete" message is posted (AC-16, must be >= dispatch.timeoutSec).
    slackDeadlineMs: 3000,
    // RAM budget (bytes): 80% of 32 GiB; admission refuses spawns that
    // would exceed this (AC-15).
    ramBudgetBytes: Math.floor(0.8 * 32 * 1024 * 1024 * 1024),
    // TTL (ms) for a worker's mesh registration; the controller refreshes
    // it while the worker is alive; a lapsed TTL triggers unregistration (AC-7).
    registrationTtlMs: 300000,
  },
};

/**
 * AC-18 — raise dispatch.maxConcurrent in LOCKSTEP with the spawn pool size.
 *
 * The dispatch core (src/dispatch.js) enforces a board-wide open-attempt cap:
 * once `countOpenDispatches(board) >= maxConcurrent`, the next dispatchTask
 * throws 429. A PARALLEL board of K seats opens K dispatches at once, so if
 * `maxConcurrent < K` the later seats 429. When the worker pool is enabled
 * (AC-17 flips boards to parallel and fans each seat to its OWN isolated remote
 * worker), the cap must rise WITH the pool so a parallel board at the pool
 * ceiling never trips the rail.
 *
 * The relationship is explicit and configured: when `fleet.spawn.enabled === true`,
 * the EFFECTIVE `maxConcurrent` is at least the pool ceiling
 * (`max(configured maxConcurrent, spawn.poolCeiling)`). When spawn is disabled
 * the configured value is preserved verbatim (byte-identical to today — no
 * lockstep raise, sequential boards never approach the cap).
 *
 * This is PURE so it is independently unit-testable (AC-18 test asserts BOTH
 * directions: raised when enabled, untouched when disabled).
 *
 * @param {object} fleet - a (merged) fleet config object with .dispatch + .spawn
 * @returns {number} the effective maxConcurrent
 */
function resolveDispatchConcurrency(fleet) {
  const dispatch = (fleet && fleet.dispatch) || {};
  const spawn = (fleet && fleet.spawn) || {};
  const configured = Number.isInteger(dispatch.maxConcurrent)
    ? dispatch.maxConcurrent
    : Number(dispatch.maxConcurrent) || 3;
  // Spawn disabled: preserve the configured value exactly (no lockstep raise).
  if (spawn.enabled !== true) return configured;
  // Spawn enabled: the cap must be at least the pool ceiling so a parallel
  // board at peak (one seat per worker) never hits the 429 open-attempt rail.
  const poolCeiling = Number.isInteger(spawn.poolCeiling)
    ? spawn.poolCeiling
    : Number(spawn.poolCeiling) || 8;
  return Math.max(configured, poolCeiling);
}

/**
 * AC-17 — parallel-flip GUARD for the board default.
 *
 * `fleet.orchestrate.sequentialBoard` controls whether board councils dispatch
 * advisors one-at-a-time (sequential, the single-box reliability default) or
 * fan all seats out at once (parallel). Phase 3 flips the DEFAULT to parallel —
 * but ONLY when the worker pool is enabled, because parallel only becomes safe
 * once each seat lands on its OWN isolated remote worker (AC-17) instead of
 * co-saturating the single gateway event loop, and once maxConcurrent rises in
 * lockstep so the parallel fan-out never trips the 429 cap (AC-18).
 *
 * This is a GUARD, NOT an unconditional flip:
 *   - An EXPLICIT `sequentialBoard` (true OR false) in config always wins.
 *   - With NO explicit value, the default is `false` (parallel) WHEN spawn is
 *     enabled, and `true` (sequential) WHEN spawn is disabled — byte-identical
 *     to today's single-box behaviour.
 *
 * The explicit-vs-defaulted distinction is read from the ORIGINAL file/env
 * fleet section (before defaults are merged in), so the FLEET_DEFAULTS sentinel
 * does not mask an operator's intent.
 *
 * @param {object} fleet - merged fleet config (has .spawn)
 * @param {object} [rawFleet] - the pre-merge fleet section (file/env), to detect
 *   an explicit orchestrate.sequentialBoard
 * @returns {boolean} the effective sequentialBoard default
 */
function resolveSequentialBoard(fleet, rawFleet) {
  const explicit =
    rawFleet &&
    rawFleet.orchestrate &&
    Object.prototype.hasOwnProperty.call(rawFleet.orchestrate, "sequentialBoard")
      ? rawFleet.orchestrate.sequentialBoard
      : undefined;
  if (explicit !== undefined) return explicit === true;
  const spawnEnabled = !!(fleet && fleet.spawn && fleet.spawn.enabled === true);
  // No explicit value: parallel default when spawn enabled, else sequential.
  return spawnEnabled ? false : true;
}

/**
 * Build the `fleet` config section: defaults <- dashboard(.local).json
 * <- FLEET_CONFIG_JSON env override (a JSON blob, useful for tests and
 * one-off deployments). Directory paths are expanded (~/$HOME) and resolved
 * relative to the package root so the server behaves the same regardless of
 * the working directory it was launched from.
 *
 * @param {object} [fileFleet] - `fleet` section from the config file
 * @returns {object} resolved fleet configuration
 */
function buildFleetConfig(fileFleet) {
  // Capture the PRE-DEFAULTS fleet section (file + env) so AC-17's parallel-flip
  // guard can tell an explicit operator `sequentialBoard` from the FLEET_DEFAULTS
  // sentinel. Merge env over file the same way the main merge does below.
  let rawFleet = fileFleet ? deepMerge({}, fileFleet) : {};
  if (process.env.FLEET_CONFIG_JSON) {
    try {
      rawFleet = deepMerge(rawFleet, JSON.parse(process.env.FLEET_CONFIG_JSON));
    } catch (e) {
      /* the main merge below logs the parse failure */
    }
  }

  let fleet = deepMerge(FLEET_DEFAULTS, fileFleet || {});

  if (process.env.FLEET_CONFIG_JSON) {
    try {
      fleet = deepMerge(fleet, JSON.parse(process.env.FLEET_CONFIG_JSON));
    } catch (e) {
      console.warn("[Config] Invalid FLEET_CONFIG_JSON, ignoring:", e.message);
    }
  }

  // AC-17 — apply the parallel-flip guard to the board default. The merged
  // `orchestrate.sequentialBoard` carries the FLEET_DEFAULTS sentinel (true);
  // override it with the spawn-aware resolution unless the operator set it
  // explicitly (in which case resolveSequentialBoard returns their value).
  fleet = {
    ...fleet,
    orchestrate: {
      ...fleet.orchestrate,
      sequentialBoard: resolveSequentialBoard(fleet, rawFleet),
    },
  };

  const packageRoot = path.join(__dirname, "..");
  const resolvedDirs = {};
  for (const key of ["stateDir", "logsDir", "briefsDir", "workspaceDir"]) {
    resolvedDirs[key] = path.resolve(packageRoot, expandPath(String(fleet[key])));
  }

  const resolvedCortex = { ...fleet.cortex };
  for (const key of Object.keys(resolvedCortex)) {
    if (typeof resolvedCortex[key] === "string" && resolvedCortex[key].length > 0) {
      resolvedCortex[key] = expandPath(resolvedCortex[key]);
    }
  }

  // Usage source paths get the same ~/$HOME expansion as cortex paths
  // (openrouterKey is a secret, not a path — leave it untouched).
  const resolvedUsage = { ...fleet.usage };
  for (const key of ["claudeProjectsDir", "codexDir", "nineRouterDb", "headroomStats"]) {
    if (typeof resolvedUsage[key] === "string" && resolvedUsage[key].length > 0) {
      resolvedUsage[key] = expandPath(resolvedUsage[key]);
    }
  }

  // Agents source paths get the same ~/$HOME expansion (empty = wiring-time
  // defaults in src/index.js).
  const resolvedAgents = { ...fleet.agents };
  for (const key of ["openclawConfigPath", "agentsDir", "hermesDir"]) {
    if (typeof resolvedAgents[key] === "string" && resolvedAgents[key].length > 0) {
      resolvedAgents[key] = expandPath(resolvedAgents[key]);
    }
  }

  // Dispatch token/identity honor dedicated env vars for parity with the other
  // knobs (the merged file/FLEET_CONFIG_JSON value is the fallback). token is a
  // secret, not a path — left untouched here; any op:// ref is resolved by the
  // deep secret pass in loadConfig().
  const resolvedDispatch = {
    ...fleet.dispatch,
    token: process.env.FLEET_DISPATCH_TOKEN || fleet.dispatch?.token || "",
    identity: process.env.FLEET_DISPATCH_IDENTITY || fleet.dispatch?.identity || "",
    // AC-18 — raise maxConcurrent in lockstep with the spawn pool ceiling when
    // the worker pool is enabled, so a parallel board at peak never trips the
    // dispatch 429 open-attempt cap. No-op (preserves the configured value)
    // when spawn is disabled — byte-identical to today.
    maxConcurrent: resolveDispatchConcurrency(fleet),
  };

  return {
    ...fleet,
    ...resolvedDirs,
    cortex: resolvedCortex,
    usage: resolvedUsage,
    agents: resolvedAgents,
    dispatch: resolvedDispatch,
  };
}

/**
 * Build final configuration.
 *
 * 1Password secret refs (op://vault/item/field) in ANY string value of the
 * assembled config (dashboard.json / dashboard.local.json / env overrides
 * such as FLEET_CONFIG_JSON) are resolved SYNCHRONOUSLY at the end — CONFIG
 * is a sync singleton consumed at require time, so boot-time execFileSync
 * via the shared resolver is the least invasive integration (see
 * src/secrets.js "RESOLUTION TIMING"). No-op (no process spawn) when no
 * refs are present. A failed ref logs its path+ref (never the secret) and
 * KEEPS the literal op:// string in place, so downstream code sees an
 * obviously-invalid credential while startup continues; the failure is also
 * surfaced via the secrets module status.
 *
 * @param {object} [options]
 * @param {object} [options.secrets=defaultSecrets] - secrets resolver
 *   (injectable for tests so the real op CLI is never spawned)
 */
function loadConfig({ secrets = defaultSecrets, localPath } = {}) {
  const fileConfig = loadConfigFile({ localPath });
  const workspace =
    process.env.OPENCLAW_WORKSPACE || expandPath(fileConfig.paths?.workspace) || detectWorkspace();

  const config = {
    // Server settings
    server: {
      port: parseInt(process.env.PORT || fileConfig.server?.port || "3333", 10),
      host: process.env.HOST || fileConfig.server?.host || "localhost",
      // Network interface the HTTP server binds to. Distinct from the legacy
      // `host` field (which was never honored at listen() time — the server has
      // always bound all interfaces). Default is unset → bind ALL interfaces,
      // preserving today's live behavior. Set to "127.0.0.1"/"localhost" to bind
      // loopback only (the Tailscale Serve cutover). Resolved by resolveBindHost
      // in src/index.js; "0.0.0.0"/"all"/unset all mean bind-all.
      bindHost: process.env.BIND_HOST || fileConfig.server?.bindHost || "",
    },

    // Paths - all relative to workspace unless absolute
    paths: {
      workspace: workspace,
      memory:
        expandPath(process.env.OPENCLAW_MEMORY_DIR || fileConfig.paths?.memory) ||
        path.join(workspace, "memory"),
      state:
        expandPath(process.env.OPENCLAW_STATE_DIR || fileConfig.paths?.state) ||
        path.join(workspace, "state"),
      cerebro:
        expandPath(process.env.OPENCLAW_CEREBRO_DIR || fileConfig.paths?.cerebro) ||
        path.join(workspace, "cerebro"),
      skills:
        expandPath(process.env.OPENCLAW_SKILLS_DIR || fileConfig.paths?.skills) ||
        path.join(workspace, "skills"),
      jobs:
        expandPath(process.env.OPENCLAW_JOBS_DIR || fileConfig.paths?.jobs) ||
        path.join(workspace, "jobs"),
      logs:
        expandPath(process.env.OPENCLAW_LOGS_DIR || fileConfig.paths?.logs) ||
        path.join(HOME, ".openclaw-command-center", "logs"),
    },

    // Auth settings
    auth: {
      mode: process.env.DASHBOARD_AUTH_MODE || fileConfig.auth?.mode || "none",
      token: process.env.DASHBOARD_TOKEN || fileConfig.auth?.token,
      allowedUsers: (
        process.env.DASHBOARD_ALLOWED_USERS ||
        fileConfig.auth?.allowedUsers?.join(",") ||
        ""
      )
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      allowedIPs: (
        process.env.DASHBOARD_ALLOWED_IPS ||
        fileConfig.auth?.allowedIPs?.join(",") ||
        "127.0.0.1,::1"
      )
        .split(",")
        .map((s) => s.trim()),
      publicPaths: fileConfig.auth?.publicPaths || ["/api/health", "/api/whoami", "/favicon.ico"],
      // Tailscale Serve-origin verification (security hardening). DEFAULT OFF =
      // exactly the prior behavior: the tailscale-user-login header is trusted
      // from any allowlisted caller. When verifyServeOrigin is true, that header
      // is only honored if the request arrived via a loopback Serve proxy AND a
      // `tailscale whois` lookup of the x-forwarded-for IP confirms the login
      // (fail closed). Flip this ON together with server.bindHost=127.0.0.1 at
      // the Serve cutover. tailscaledSocket overrides the default socket path.
      tailscale: {
        verifyServeOrigin:
          process.env.AUTH_TAILSCALE_VERIFY_SERVE_ORIGIN === "true" ||
          fileConfig.auth?.tailscale?.verifyServeOrigin === true,
        tailscaledSocket:
          process.env.AUTH_TAILSCALED_SOCKET || fileConfig.auth?.tailscale?.tailscaledSocket || "",
      },
    },

    // Branding
    branding: {
      name: fileConfig.branding?.name || "OpenFleetControl",
      theme: fileConfig.branding?.theme || "default",
    },

    // Integrations
    integrations: {
      linear: {
        enabled: !!(process.env.LINEAR_API_KEY || fileConfig.integrations?.linear?.apiKey),
        apiKey: process.env.LINEAR_API_KEY || fileConfig.integrations?.linear?.apiKey,
        teamId: process.env.LINEAR_TEAM_ID || fileConfig.integrations?.linear?.teamId,
      },
    },

    // Fleet (mesh / chat / kanban / briefs / evolution / cortex / alerts)
    fleet: buildFleetConfig(fileConfig.fleet),

    // Billing - for cost savings calculation
    billing: {
      claudePlanCost: parseFloat(
        process.env.CLAUDE_PLAN_COST || fileConfig.billing?.claudePlanCost || "200",
      ),
      claudePlanName:
        process.env.CLAUDE_PLAN_NAME || fileConfig.billing?.claudePlanName || "Claude Code Max",
      // How each LLM provider is billed: "subscription" (flat OAuth/plan, excluded
      // from per-token spend totals) vs "per-token" (metered API spend). Mirrored
      // into fleet.budgets.providerBillingModes for the budgets evaluator.
      providerBillingModes: fileConfig.billing?.providerBillingModes || {
        codex: "subscription",
        "claude-code": "subscription",
        openrouter: "per-token",
        gemini: "per-token",
      },
    },
  };

  // op:// secret references → resolved values (see the function docblock).
  const { value: resolved, failures } = secrets.resolveDeepSync(config);
  for (const failure of failures) {
    console.warn(
      `[Config] 1Password ref ${failure.ref} (${failure.path}) failed: ${failure.error} — keeping the reference in place`,
    );
  }
  return resolved;
}

// Export singleton config
const CONFIG = loadConfig();

// Log detected configuration on startup
console.log("[Config] Workspace:", CONFIG.paths.workspace);
console.log("[Config] Auth mode:", CONFIG.auth.mode);

module.exports = {
  CONFIG,
  loadConfig,
  detectWorkspace,
  expandPath,
  getOpenClawDir,
  resolveDispatchConcurrency,
  resolveSequentialBoard,
};
