/**
 * OpenClaw Command Center Dashboard Server
 * Serves the dashboard UI and provides API endpoints for status data
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

// ============================================================================
// CLI ARGUMENT PARSING
// ============================================================================
const args = process.argv.slice(2);
let cliProfile = null;
let cliPort = null;

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case "--profile":
    case "-p":
      cliProfile = args[++i];
      break;
    case "--port":
      cliPort = parseInt(args[++i], 10);
      break;
    case "--help":
    case "-h":
      console.log(`
OpenFleetControl

Usage: node lib/server.js [options]

Options:
  --profile, -p <name>  OpenClaw profile (uses ~/.openclaw-<name>)
  --port <port>         Server port (default: 3333)
  --help, -h            Show this help

Environment:
  OPENCLAW_PROFILE      Same as --profile
  PORT                  Same as --port

Examples:
  node lib/server.js --profile production
  node lib/server.js -p dev --port 3334
`);
      process.exit(0);
  }
}

// Set profile in environment so CONFIG and all CLI calls pick it up
if (cliProfile) {
  process.env.OPENCLAW_PROFILE = cliProfile;
}
if (cliPort) {
  process.env.PORT = cliPort.toString();
}

// ============================================================================
// MODULE IMPORTS (after env vars are set)
// ============================================================================
const { getVersion } = require("./utils");
const { CONFIG, getOpenClawDir } = require("./config");
const { handleJobsRequest, isJobsRoute, setCronFallback, setAuditRecorder } = require("./jobs");
const {
  runOpenClaw,
  runOpenClawAsync,
  runOpenClawArgv,
  extractJSON,
  getSafeEnv,
} = require("./openclaw");
const {
  getSystemVitals,
  forceRefreshVitals,
  getVitalsCacheAgeMs,
  checkOptionalDeps,
  getOptionalDeps,
} = require("./vitals");
const { checkAuth, getUnauthorizedPage } = require("./auth");
const {
  loadOperators,
  saveOperators,
  getOperatorBySlackId,
  startOperatorsRefresh,
  calculateOperatorStats,
} = require("./operators");
const { createSessionsModule } = require("./sessions");
const { getCronJobs, forceCliRefresh } = require("./cron");
const { createCronActions } = require("./cron-actions");
const { createCronRoutes } = require("./cron-routes");
const { getCerebroTopics, updateTopicStatus } = require("./cerebro");
const {
  getDailyTokenUsage,
  getTokenStats,
  getCostBreakdown,
  startTokenUsageRefresh,
  refreshTokenUsageAsync,
} = require("./tokens");
const { getLlmUsage, getRoutingStats, startLlmUsageRefresh } = require("./llm-usage");
const { executeAction } = require("./actions");
const { guardActionPost, PRIVILEGED_POST_ACTIONS } = require("./action-guard");
const { createBulk } = require("./bulk");
const { migrateDataDir } = require("./data");
const { createStateModule } = require("./state");
const { createFleetRuntime } = require("./fleet");
const { createFleetRoutes, isFleetRoute } = require("./fleet-routes");
const { createDispatch } = require("./dispatch");
const { createDispatchWatchdog } = require("./dispatch-watchdog");
const { createOrchestrate } = require("./orchestrate");
const { createSettings } = require("./settings");
const { createDocker } = require("./docker");
const { createDockerPool } = require("./docker-pool");
const { createUsageSources } = require("./usage-sources");
const { createUsageProvider } = require("./budgets");
const { createTopConsumersSource } = require("./digest");
const { createAgentsRoster } = require("./agents-roster");
const { createAgentLocator } = require("./agent-locator");
const { createSpawnStore } = require("./spawn-store");
const { createAgentSpawn } = require("./agent-spawn");
const { createFlightRecorder, createStoreSessionsSource } = require("./flight-recorder");
const { createTimelineRoutes, isTimelineRoute } = require("./timeline-routes");
const { createRunArchive, runEntryToRecord, recordIsFailure } = require("./run-archive");
const { createFlightRecorderRoutes, isFlightRecorderRoute } = require("./run-archive-routes");
const { createSessionControl } = require("./session-control");
const { createRateLimiter } = require("./rate-limit");
const { resolveBindHost } = require("./bind-host");
const { createTailscaleWhois, verifyServeLogin } = require("./auth");

// ============================================================================
// CONFIGURATION
// ============================================================================
const PORT = CONFIG.server.port;
const DASHBOARD_DIR = path.join(__dirname, "../public");
const PATHS = CONFIG.paths;

const AUTH_CONFIG = {
  mode: CONFIG.auth.mode,
  token: CONFIG.auth.token,
  allowedUsers: CONFIG.auth.allowedUsers,
  allowedIPs: CONFIG.auth.allowedIPs,
  publicPaths: CONFIG.auth.publicPaths,
  // Serve-origin verification (default OFF). When enabled, checkAuth honors the
  // tailscale-user-login header only after whois confirms the Serve-injected
  // x-forwarded-for IP resolves to that login. The real whois impl is only
  // exercised when the flag is on; building it unconditionally is cheap (no I/O
  // until called).
  tailscale: {
    verifyServeOrigin: CONFIG.auth.tailscale.verifyServeOrigin,
    whoisFn: createTailscaleWhois({ socket: CONFIG.auth.tailscale.tailscaledSocket }),
  },
};

// Profile-aware data directory
const DATA_DIR = path.join(getOpenClawDir(), "command-center", "data");
const LEGACY_DATA_DIR = path.join(DASHBOARD_DIR, "data");

/** Serialize possibly-Infinity cache ages as null for JSON payloads. */
function toFiniteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

// ============================================================================
// SSE (Server-Sent Events)
// ============================================================================
const sseClients = new Set();

function sendSSE(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (e) {
    // Client disconnected
  }
}

function broadcastSSE(event, data) {
  for (const client of sseClients) {
    sendSSE(client, event, data);
  }
}

// ============================================================================
// INITIALIZE MODULES (wire up dependencies)
// ============================================================================

// Second-instance economy: when fleet.openclawSources is false this
// instance never spawns the openclaw CLI nor parses OpenClaw session/usage
// data (the primary instance owns those sources).
const OPENCLAW_SOURCES = CONFIG.fleet.openclawSources !== false;

// OpenClaw-source wrappers: in economy mode these never spawn the CLI
// (cron list / status --usage are openclaw CLI calls under the hood).
const getCronJobsSafe = () => (OPENCLAW_SOURCES ? getCronJobs(getOpenClawDir) : []);
const getLlmUsageSafe = (statePath) => getLlmUsage(statePath, { allowSpawn: OPENCLAW_SOURCES });

// When the optional jobs library is absent, /api/jobs serves the cron
// dual-source read-only instead of degrading to available:false.
setCronFallback(getCronJobsSafe);

// Sessions module (factory pattern with dependency injection)
const sessions = createSessionsModule({
  getOpenClawDir,
  getOperatorBySlackId: (slackId) => getOperatorBySlackId(DATA_DIR, slackId),
  runOpenClaw,
  runOpenClawAsync,
  extractJSON,
  sessionsSource: CONFIG.fleet.sessionsSource,
  refreshMs: CONFIG.fleet.sessionsRefreshMs,
  enabled: OPENCLAW_SOURCES,
});

// State module (factory pattern)
const state = createStateModule({
  CONFIG,
  getOpenClawDir,
  getSessions: (opts) => sessions.getSessions(opts),
  getSystemVitals,
  getCronJobs: () => getCronJobsSafe(),
  loadOperators: () => loadOperators(DATA_DIR),
  calculateOperatorStats,
  getLlmUsage: () => getLlmUsageSafe(PATHS.state),
  getDailyTokenUsage: () => getDailyTokenUsage(getOpenClawDir),
  getTokenStats,
  getCerebroTopics: (opts) => getCerebroTopics(PATHS.cerebro, opts),
  runOpenClawAsync,
  openclawEnabled: OPENCLAW_SOURCES,
  readTranscript: (sessionId) => sessions.readTranscript(sessionId),
});

// Fleet runtime (mesh, chat, kanban, briefs, evolution, cortex, alerts) +
// REST routes. SSE events: fleet.mesh, fleet.chat, fleet.kanban,
// fleet.evolution, fleet.alert (minimal payloads; clients refetch detail).
const fleet = createFleetRuntime({ config: CONFIG.fleet, broadcast: broadcastSSE });

// ----------------------------------------------------------------------
// Audit helpers for the legacy (non-fleet) mutating routes below. Same
// conventions as src/fleet-routes.js: actor identity comes from the
// Tailscale-User-Login header (fallback "anonymous") and audit writes are
// best-effort — a failed audit write never fails the mutation.
// ----------------------------------------------------------------------

/** Identity from the Tailscale Serve header (fallback "anonymous"). */
function getRequestUser(req) {
  const login = req.headers["tailscale-user-login"];
  return typeof login === "string" && login.trim().length > 0
    ? login.trim().toLowerCase()
    : "anonymous";
}

/** Best-effort audit record — an audit failure never fails the request. */
function recordAudit(user, action, target, detail) {
  try {
    fleet.audit.record({ user, action, target, detail });
  } catch (e) {
    console.error("[Audit] Record failed:", e.message);
  }
}

// Jobs routes (src/jobs.js) audit through the shared fleet trail; the
// recorder is injected so the jobs module stays decoupled from the runtime.
setAuditRecorder((entry) => fleet.audit.record(entry));

// Settings service — persists the editable fleet config subset to
// config/dashboard.local.json and hot-applies alerts changes by rebuilding
// the fleet runtime's alert engine (no restart needed for alerts.*).
const settings = createSettings({
  configPath: path.join(__dirname, "..", "config", "dashboard.local.json"),
  onChange: (alertsConfig) => fleet.applyAlertsConfig(alertsConfig),
  onBudgetsChange: (budgetsConfig) => fleet.applyBudgetsConfig(budgetsConfig),
  onDigestChange: (digestConfig) => fleet.applyDigestConfig(digestConfig),
});

// Kanban → agent dispatch + follow-through watcher (src/dispatch.js):
// fires `openclaw agent --json` runs, then closes the loop when they settle
// (attempt result, auto-move review/failed, optional dispatchComplete alert).
// Board mutations flow through fleet.kanban, whose onChange already fans out
// the fleet.kanban SSE event; dispatch lifecycle events are broadcast here.
// Lazy agent→node resolver: agentsRoster is constructed further down, so the
// closure defers to a module-level binding only invoked at dispatch time (long
// after evaluation). When the resolver is absent (it never is here), dispatch
// falls back to its legacy local-only behaviour.
let agentLocator = null;
const dispatch = createDispatch({
  kanban: fleet.kanban,
  briefsDir: CONFIG.fleet.briefsDir,
  config: {
    ...CONFIG.fleet.dispatch,
    baseUrl: CONFIG.fleet.dispatch.baseUrl || `http://127.0.0.1:${PORT}`,
  },
  onEvent: (event) =>
    broadcastSSE("fleet.kanban", { type: event.type, taskId: event.taskId || null }),
  fireAlert: (event) => fleet.fireAlert(event),
  // Remote dispatch (Phase 2): route an agent to the node that hosts it.
  resolveAgentNode: (agentRef) => agentLocator.resolve(agentRef),
  fetchFn: (...a) => globalThis.fetch(...a),
  meshIdentity: CONFIG.fleet.dispatch.identity || os.hostname(),
  // Shared Bearer token for node→node agent-run auth (guardActionPost token
  // branch). null = header omitted (today's behavior).
  dispatchToken: CONFIG.fleet.dispatch.token || null,
});

// Dispatch liveness watchdog + stale-lock sweeper (Phase E,
// src/dispatch-watchdog.js). Periodically reclaims in-flight dispatch locks
// that have gone silent past a threshold (e.g. a server crash mid-run left an
// open attempt wedged), with bounded retries and a snooze/re-arm. GATED by
// fleet.dispatchWatchdog.enabled — mirrors the budgets/ntfy NOOP-poller idiom:
// when disabled the stand-in is inert and boot never depends on the feature.
// Enabled by default with conservative defaults (60s / 25min / 2 retries):
// reclaiming a stuck lock is the only path back from a crash-wedged card, and
// the 25min threshold (hard-floored at dispatch.timeoutSec + 60s) sits beyond
// the 20min dispatch timeout so a legitimately long-running dispatch is not
// disturbed.
const dispatchWatchdogCfg = CONFIG.fleet.dispatchWatchdog || {};
const dispatchWatchdogEnabled = dispatchWatchdogCfg.enabled !== false;
const NOOP_DISPATCH_WATCHDOG = {
  check: () => [],
  start() {},
  stop() {},
  getState: () => ({ running: false }),
};
const dispatchWatchdog = dispatchWatchdogEnabled
  ? createDispatchWatchdog({
      kanban: fleet.kanban,
      config: dispatchWatchdogCfg,
      dispatchConfig: CONFIG.fleet.dispatch,
      // Re-run a reclaimed card under the retry cap. Best-effort: dispatchTask
      // throws on its own guards (409/429/503) — the watchdog logs and the card
      // is left freed for the next manual/orchestrated dispatch.
      redispatch: (taskId, { agent }) => {
        dispatch.dispatchTask(taskId, { agent, actor: "dispatch-watchdog" });
      },
      fireAlert: (event) => fleet.fireAlert(event),
    })
  : NOOP_DISPATCH_WATCHDOG;

// Multi-agent orchestration (src/orchestrate.js) — fan-in councils + chains
// composed over the dispatch primitive. Reuses dispatch's attempt model,
// concurrency cap, and completion promises; LOCAL-only for now (dispatch
// refuses remote nodes). Lifecycle events broadcast as fleet.kanban so the
// board view refetches like any other card change.
// AC-17 — late-binding spawn-controller ref for caller-side remote routing.
// The agentSpawn controller is only constructed when fleet.spawn.enabled (further
// down). Orchestrate is wired with a thin proxy that forwards lease/release/drain
// to the live controller once it exists; when spawn is disabled the proxy stays
// null and orchestrate's routeToPool gate is off (byte-identical to today).
const spawnControllerRef = { controller: null };
const spawnEnabled = !!(CONFIG.fleet.spawn && CONFIG.fleet.spawn.enabled === true);
const orchestrateSpawnProxy = spawnEnabled
  ? {
      lease: (advisorId) => spawnControllerRef.controller?.lease(advisorId) ?? null,
      release: (workerId, generation) =>
        spawnControllerRef.controller?.release(workerId, generation),
      beginDrain: (workerId) => spawnControllerRef.controller?.beginDrain(workerId) ?? false,
      settleAndRemove: (workerId) => spawnControllerRef.controller?.settleAndRemove(workerId),
    }
  : null;

// Flight Recorder — durable archive of board/chain runs (src/run-archive.js),
// surfaced by the dashboard's "Flight Recorder" tab. Additive: built only when
// fleet.flightRecorder.enabled (default true). The `node` column is stamped from
// flightRecorder.nodeId, falling back to dispatch identity / dispatch node /
// hostname — present from day one so a Phase 3 multi-instance roll-up needs no
// schema change. A late-binding ref lets the orchestrate onEvent handler reach
// the (already-constructed) orchestrate module at event time to pull the full
// settled registry entry — the SSE payload itself is counts-only.
const flightRecorderCfg = CONFIG.fleet.flightRecorder || {};
const flightRecorderEnabled = flightRecorderCfg.enabled !== false;
const flightRecorderNodeId =
  (typeof flightRecorderCfg.nodeId === "string" && flightRecorderCfg.nodeId) ||
  CONFIG.fleet.dispatch?.identity ||
  CONFIG.fleet.dispatch?.node ||
  os.hostname();
const orchestrateRef = { mod: null };
let runArchive = null;
if (flightRecorderEnabled) {
  try {
    runArchive = createRunArchive({
      stateDir: CONFIG.fleet.stateDir,
      node: flightRecorderNodeId,
      retentionDays: flightRecorderCfg.retentionDays,
      maxRows: flightRecorderCfg.maxRows,
    });
  } catch (e) {
    console.error("[FlightRecorder] archive init failed (continuing without it):", e.message);
    runArchive = null;
  }
}

// Throttle: at most one failure alert per run, and a short global cool-down so a
// burst of failed runs does not spam the ntfy sink (the alert engine also dedupes
// type+task within 5 min, but we add a cheap run-level guard here too).
const FLIGHT_REC_ALERT_COOLDOWN_MS = 60 * 1000;
const flightRecAlertedRuns = new Set();
let flightRecLastAlertMs = 0;

/**
 * Archive a settled run and, when it failed, fire a throttled ntfy/alert. Pulls
 * the FULL registry entry (results/steps/missing) from orchestrate.getRun — the
 * SSE event payload is intentionally light. Never throws: a recorder failure
 * must never break orchestration.
 *
 * @param {string} runId
 */
function recordOrchestrationRun(runId) {
  if (!runArchive || !runId) return;
  const entry =
    orchestrateRef.mod && typeof orchestrateRef.mod.getRun === "function"
      ? orchestrateRef.mod.getRun(runId)
      : null;
  if (!entry || entry.status === "running") return; // not terminal yet
  let record;
  try {
    record = runArchive.archiveRun(entry, { node: flightRecorderNodeId });
  } catch (e) {
    console.error("[FlightRecorder] archiveRun threw:", e.message);
    return;
  }
  if (!record) return;

  if (flightRecorderCfg.alertOnFailure !== false && recordIsFailure(record)) {
    if (flightRecAlertedRuns.has(runId)) return; // already alerted this run
    const now = Date.now();
    if (now - flightRecLastAlertMs < FLIGHT_REC_ALERT_COOLDOWN_MS) {
      // Within the cool-down: skip the push but still mark it so a later retry
      // of the same event does not fire once the window reopens.
      flightRecAlertedRuns.add(runId);
      return;
    }
    flightRecLastAlertMs = now;
    flightRecAlertedRuns.add(runId);
    if (flightRecAlertedRuns.size > 500) {
      // Bound the dedupe set — drop the oldest half (insertion order).
      const keep = Array.from(flightRecAlertedRuns).slice(-250);
      flightRecAlertedRuns.clear();
      for (const k of keep) flightRecAlertedRuns.add(k);
    }
    const r = record.run;
    const failedSeats = (record.seats || [])
      .filter((s) => s.status === "timeout" || s.status === "failed" || s.status === "refused")
      .map((s) => `${s.agent}:${s.status}`);
    try {
      fleet.fireAlert({
        type: "orchestrationFailed",
        severity: "warn",
        node: r.node,
        task: r.runId,
        message:
          `Flight Recorder: ${r.mode} run "${r.title}" ${r.status} ` +
          `(${r.okCount}/${r.seatCount} ok` +
          (failedSeats.length ? `; failed: ${failedSeats.join(", ")}` : "") +
          ")",
      });
    } catch (e) {
      console.error("[FlightRecorder] failure alert failed:", e.message);
    }
  }
}

// Post a single thread-parent to the board channel so council advisors reply
// IN-THREAD (#ceo-boardroom shows one collapsible item, not N top-level posts).
// Returns the Slack ts (messageId) or null. Null on any failure (no board channel
// configured, post error, unparseable output) → advisors fall back to top-level
// posts (prior behavior); the board itself is never blocked by this.
async function postBoardThreadParent({ title, question }) {
  const slack = (CONFIG.fleet.dispatch && CONFIG.fleet.dispatch.slack) || {};
  const target = slack.boardChannel;
  if (!target) return null;
  const chiefMention = slack.chiefUserId ? `<@${slack.chiefUserId}> ` : "";
  const text = `🧑‍⚖️ ${chiefMention}*Board:* ${title}\n> ${question}\n_Advisors are replying in this thread…_`;
  const out = await runOpenClawArgv(
    [
      "message",
      "send",
      "--channel",
      "slack",
      "--account",
      "default",
      "--target",
      target,
      "--message",
      text,
      "--json",
    ],
    { timeout: 15000 },
  );
  if (!out) return null;
  try {
    const parsed = JSON.parse(extractJSON(out) || "null");
    return (
      (parsed && parsed.messageId) ||
      (parsed &&
        parsed.payload &&
        parsed.payload.result &&
        parsed.payload.result.receipt &&
        parsed.payload.result.receipt.primaryPlatformMessageId) ||
      null
    );
  } catch (e) {
    console.error("[Orchestrate] thread-parent ts parse failed:", e.message);
    return null;
  }
}

const orchestrate = createOrchestrate({
  kanban: fleet.kanban,
  dispatch,
  config: CONFIG.fleet.orchestrate || {},
  postBoardParent: postBoardThreadParent,
  // AC-17: pool routing + parallel flip engage ONLY when spawn is enabled.
  spawn: orchestrateSpawnProxy,
  spawnEnabled,
  onEvent: (event) => {
    // Card-lifecycle events keep going to fleet.kanban so the board refetches.
    broadcastSSE("fleet.kanban", { type: event.type, taskId: event.taskId || null });
    // Run-completion → dedicated channel so the UI can flip a run badge live
    // without re-reading the whole board. SSE is a live-update nicety; polling
    // GET :runId remains the correctness path.
    if (event.type === "orchestration.completed") {
      broadcastSSE("fleet.orchestration", {
        type: event.type,
        runId: event.runId,
        mode: event.mode,
        status: event.status,
        collected: event.collected,
        missing: event.missing,
      });
      // Persist the settled run to the Flight Recorder archive + fire a
      // throttled failure alert. Pulls the full entry from the registry below.
      recordOrchestrationRun(event.runId);
    }
  },
});
// Publish the constructed module to the late-binding ref so the onEvent handler
// (which fires strictly after this assignment) can read the full registry entry.
orchestrateRef.mod = orchestrate;

// Quick-action runner deps (src/actions.js): async CLI runner + the cached
// sessions backend for stale counting. Shared by /api/action and bulk ops.
const actionDeps = {
  runOpenClawAsync,
  extractJSON,
  PORT,
  getRawSessions: () => sessions.getRawSessionsCached(),
  // Long-timeout agent runner for the agent-run verb (an agent turn needs
  // minutes, not the 20s runOpenClawAsync budget). Mirrors dispatch's
  // defaultExecFn: openclaw via execFile (no shell — injection-safe), returns
  // stdout or null on failure/timeout so the verb maps cleanly to an error.
  runAgent: (args, { timeoutMs }) =>
    new Promise((resolve) =>
      execFile(
        "openclaw",
        args,
        { encoding: "utf8", timeout: timeoutMs, env: getSafeEnv(), maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => resolve(err && !stdout ? null : stdout),
      ),
    ),
};

// Fleet bulk operations (src/bulk.js): POST /api/fleet/bulk fans quick
// actions / dispatches / chat publishes across N targets with per-target
// results. Local node work reuses the quick-action runner above.
const bulk = createBulk({
  mesh: fleet.mesh,
  chat: fleet.chat,
  dispatch,
  // Validate dispatch targets against the FLEET roster (local + mesh + federation)
  // so remote-only and "id@node"-qualified agents pass validation and reach the
  // node-aware resolver. Lazy closure: agentsRoster is constructed further down.
  rosterFn: () => agentsRoster.getRoster(),
  runAction: (name, opts) => executeAction(name, actionDeps, opts),
});

// AC-11 / AC-22 — late-binding spawn-store ref for dedup at the orchestrate
// entry. The spawnStore is only constructed when spawn is enabled (further
// down). This ref object is filled before any HTTP request arrives, so the
// lazy getter passed to createFleetRoutes always sees the live store.
const spawnStoreRef = { store: null };

const fleetRoutes = createFleetRoutes({
  fleet,
  settings,
  dispatch,
  orchestrate,
  bulk,
  // Validate dispatch targets against the FLEET roster (local + mesh + federation)
  // so "id@node"-qualified and remote-only agents pass and reach the node-aware
  // resolver (src/agent-locator.js). Lazy closure: agentsRoster is constructed
  // further down; routes only call this at request time, long after module
  // evaluation completed.
  rosterFn: () => agentsRoster.getRoster(),
  // AC-11: lazy getter — evaluated at request time, after spawnStoreRef.store
  // is filled by the spawn block below. Returns null when spawn is disabled.
  spawnStoreFn: () => spawnStoreRef.store,
});

// Cron write-actions — enable/disable/run-now for OPENCLAW-source jobs via
// the openclaw CLI; Hermes jobs stay read-only. After a successful mutation
// the 60s-TTL CLI job cache is force-refreshed so the UI's verifying refetch
// sees the change. Shares the fleet audit trail + per-user rate limiter.
const cronActions = createCronActions({
  getJobs: getCronJobsSafe,
  refreshJobs: forceCliRefresh,
});
const cronRoutes = createCronRoutes({
  actions: cronActions,
  audit: fleet.audit,
  rateLimiter: fleet.rateLimiter,
  enabled: OPENCLAW_SOURCES,
});

// Usage sources — read-only adapters over Claude Code / Codex / 9Router /
// plan-usage poller / OpenRouter usage data (paths configurable via fleet.usage).
//
// Back-compat: the plan-usage stats path was historically named `headroomStats`
// (under both fleet.usage and fleet.cortex). Existing dashboard.local.json files
// may still carry that key, so we honor either name (planUsageStats preferred).
const planUsageStats =
  CONFIG.fleet.usage.planUsageStats ||
  CONFIG.fleet.usage.headroomStats ||
  CONFIG.fleet.cortex.planUsageStats ||
  CONFIG.fleet.cortex.headroomStats;
const usageSources = createUsageSources({
  claudeProjectsDir: CONFIG.fleet.usage.claudeProjectsDir,
  codexDir: CONFIG.fleet.usage.codexDir,
  nineRouterDb: CONFIG.fleet.usage.nineRouterDb,
  planUsageStats,
  openrouterKey: process.env.OPENROUTER_API_KEY || CONFIG.fleet.usage.openrouterKey,
});

// Budgets spend source: the evaluator reads REAL spend through the usage
// adapters (9Router SQLite cost rows + the OpenRouter credits window delta;
// claude-code estimates as the informative/fallback signal). Without this
// wiring getUsage() stays null and the budget gauges report
// usageAvailable:false — the guardrails would never see actual spend.
fleet.setUsageProvider(createUsageProvider({ usageSources }));

// Subscription / rate-limit alerting source (src/subscription-limit-watcher.js):
// flatten the plan-usage subscription windows (Claude 5h / 7d / Sonnet sub-limit)
// into plan-utilization rows so the watcher can alert near plan caps. The
// `stale` flag is propagated truthfully — when the plan-usage snapshot is stale
// the watcher SKIPS the window rather than firing a false critical off old data.
// No-op unless fleet.subscriptionLimits.enabled is true.
fleet.setSubscriptionWindowsProvider(async () => {
  const planUsage = usageSources.sources && usageSources.sources.planUsage;
  if (!planUsage || !planUsage.available || typeof planUsage.getSubscription !== "function") {
    return [];
  }
  let sub;
  try {
    sub = await planUsage.getSubscription();
  } catch {
    return [];
  }
  if (!sub || !sub.available) return [];
  const stale = !!sub.stale;
  const windows = [
    ["claude", "5h", sub.fiveHour],
    ["claude", "7d", sub.sevenDay],
    ["claude", "7d-sonnet", sub.sevenDaySonnet],
  ];
  return windows
    .filter(([, , w]) => w && Number.isFinite(w.utilizationPct))
    .map(([provider, window, w]) => ({
      provider,
      window,
      utilizationPct: w.utilizationPct,
      capPct: 100,
      resetsAt: w.resetsAt || null,
      stale,
    }));
});

// Fleet digest sources that live outside the fleet runtime: cron job status
// (openclaw CLI dual-source read) and the top-token-consumer rollup over the
// usage adapters.
fleet.setDigestSources({
  getCronJobs: () => getCronJobsSafe(),
  getTopConsumers: createTopConsumersSource({ usageSources }),
});

// Docker containers — read-only poller over the local Docker socket.
// State/health transitions broadcast as SSE "fleet.docker" (minimal payload;
// the docker view refetches GET /api/docker for detail).
const docker = createDocker({
  onChange: ({ container, previousState, previousHealth }) =>
    broadcastSSE("fleet.docker", {
      id12: container.id12 || null,
      name: container.name || null,
      state: container.state,
      health: container.health,
      previousState,
      previousHealth,
      ts: Date.now(),
    }),
  portainerUrl: CONFIG.fleet.docker?.portainerUrl ?? null,
});

// Session control — kill live terminal (claude/codex) processes and tail
// session transcripts. Kill pid validation re-checks ps via the usage-source
// adapters at call time; transcript ids resolve only through the adapters'
// known session lists (path-traversal safe).
const sessionControl = createSessionControl({
  claudeCode: usageSources.sources.claudeCode,
  codex: usageSources.sources.codex,
  resolveOpenClawTranscript: (sessionId) => sessions.resolveTranscriptForId(sessionId),
});
// Kills are destructive: a deliberately tight bucket per user+ip.
const killRateLimiter = createRateLimiter({ windowMs: 60000, max: 6 });
const TERMINAL_KILL_RE = /^\/api\/sessions\/terminal\/(\d+)\/kill$/;

// Agents roster — local openclaw.json agents enriched with session activity,
// plus best-effort fleet-wide aggregation over online mesh nodes.
const agentsRoster = createAgentsRoster({
  openclawConfigPath: path.join(getOpenClawDir(), "openclaw.json"),
  agentsDir: path.join(getOpenClawDir(), "agents"),
  mesh: fleet.mesh,
});

// Agent→node resolver for remote dispatch (Phase 2). Built once agentsRoster +
// fleet.mesh exist; the dispatch module holds a lazy closure over this binding
// (see createDispatch above), so it is only ever invoked at dispatch time.
agentLocator = createAgentLocator({
  rosterFn: () => agentsRoster.getRoster(),
  meshFn: () => fleet.mesh.getState(),
  selfNode: CONFIG.fleet.dispatch.node || os.hostname(),
});

// On-demand isolated-worker pool controller (src/agent-spawn.js — Phase 3,
// PRD-001). GATED by CONFIG.fleet.spawn.enabled: when disabled (the default),
// the controller is constructed as a no-op that never touches docker or mesh,
// so dispatch/orchestrate behaviour stays byte-identical to today (AC-1). The
// spawn store (dedup + fencing) and a docker iface adapter are only built when
// the feature is enabled.
//
// AC-11 / AC-22: spawnStoreRef is declared early (before fleetRoutes is
// constructed above) and filled here so the lazy spawnStoreFn getter passed to
// createFleetRoutes always sees the live store once enabled. When spawn is
// disabled, the getter returns null and dedup degrades to no-op.
let agentSpawn = null;
if (CONFIG.fleet.spawn && CONFIG.fleet.spawn.enabled === true) {
  const spawnStore = createSpawnStore({ stateDir: CONFIG.fleet.stateDir });
  // Wire the store into the route handler via the late-binding ref (set after
  // createFleetRoutes was called — the getter is evaluated at request time).
  spawnStoreRef.store = spawnStore;
  // Build the real Docker pool adapter (src/docker-pool.js). Uses the same
  // unix-socket idiom as src/docker.js but adds the write operations
  // (start/stop) and streaming events the spawn controller needs.
  // Only constructed when spawn is enabled — preserves AC-1 (disabled = inert).
  const dockerIface = createDockerPool({
    socketPath: CONFIG.fleet.docker?.socketPath,
  });

  // W-1 — Real readiness probe (AC-5). GETs http://127.0.0.1:<port><healthPath>
  // over loopback (workers expose their mapped port on the host) and resolves
  // true on HTTP 200. Timeout is short (3 s) so the readiness loop stays
  // responsive. Injectable at call-site (unit tests pass their own probeFn via
  // opts.probeFn); this function is the constructor-injected default used when
  // spawn.enabled === true and no per-call override is supplied.
  const spawnCfgLive = CONFIG.fleet.spawn;
  const probePort = Number(spawnCfgLive.workerPort) || 443;
  const probeHealthPath = "/api/health";
  const probeTimeoutMs = 3000;
  const probeHealthFn = (worker) =>
    new Promise((resolve) => {
      let settled = false;
      const settle = (ok) => {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      };
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: probePort,
          path: probeHealthPath,
          method: "GET",
        },
        (res) => {
          res.resume(); // drain to free socket
          settle(res.statusCode === 200);
        },
      );
      req.setTimeout(probeTimeoutMs, () => {
        req.destroy();
        settle(false);
      });
      req.on("error", () => settle(false));
      req.end();
    });

  // W-2 — Real MemAvailable reader (AC-15). Reads /proc/meminfo and parses the
  // MemAvailable line (KiB → bytes). Synchronous: /proc/meminfo is an in-kernel
  // virtual file — no disk I/O — and the capacity governor calls it inline
  // before any docker operation, so sync is the right idiom here (mirrors the
  // os.totalmem() pattern). Injectable at call-site for unit tests; this is the
  // constructor-injected default used when spawn.enabled === true.
  const readMemAvailableFn = () => {
    const raw = fs.readFileSync("/proc/meminfo", "utf8");
    const m = raw.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (!m) throw new Error("[AgentSpawn] MemAvailable not found in /proc/meminfo");
    return Number(m[1]) * 1024; // KiB → bytes
  };

  agentSpawn = createAgentSpawn({
    config: CONFIG,
    mesh: fleet.mesh,
    roster: agentsRoster,
    store: spawnStore,
    docker: dockerIface,
    logger: console,
    probeHealthFn,
    readMemAvailableFn,
  });
  // AC-17 — publish the live controller to the late-binding ref so orchestrate's
  // spawn proxy (wired above, before this block) routes seats to leased workers.
  spawnControllerRef.controller = agentSpawn;
  agentSpawn.start();
}

// Agent flight recorder — read-only per-agent activity timeline aggregated
// from sources the dashboard already collects (sessions store, kanban
// attempts/comments, audit trail, cron last-runs). No new collection.
const flightRecorder = createFlightRecorder({
  readAgentSessions: createStoreSessionsSource({
    agentsDir: path.join(getOpenClawDir(), "agents"),
  }),
  getBoard: () => fleet.kanban.getBoard(),
  queryAudit: (filters) => fleet.audit.query(filters),
  getCronJobs: getCronJobsSafe,
});
const timelineRoutes = createTimelineRoutes({ recorder: flightRecorder });

// Flight Recorder read routes (src/run-archive-routes.js): the durable run
// archive + live in-progress runs from the orchestrate registry. Built only
// when the archive was constructed; index.js dispatches it BEFORE the generic
// fleet routes (which 404 unknown paths). Read-only — no rate-limit / audit.
const flightRecorderRoutes = runArchive
  ? createFlightRecorderRoutes({
      archive: runArchive,
      orchestrate,
      runEntryToRecord,
      listLiveRuns: () => orchestrate.listRuns(),
    })
  : null;

// ============================================================================
// STARTUP: Data migration + background tasks
// ============================================================================
process.nextTick(() => migrateDataDir(DATA_DIR, LEGACY_DATA_DIR));
fleet.start();
docker.start();
dispatchWatchdog.start(); // NOOP stand-in when fleet.dispatchWatchdog.enabled=false
// OpenClaw-sourced background workers only run when this instance owns the
// openclaw CLI/data sources (fleet.openclawSources, default true).
if (OPENCLAW_SOURCES) {
  startOperatorsRefresh(DATA_DIR, getOpenClawDir);
  startLlmUsageRefresh();
  startTokenUsageRefresh(getOpenClawDir);
}

// ============================================================================
// STATIC FILE SERVER
// ============================================================================
function serveStatic(req, res) {
  // Parse URL to safely extract pathname (ignoring query/hash)
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;

  // Reject any path containing ".." segments (path traversal)
  if (pathname.includes("..")) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  // Normalize and resolve to ensure path stays within DASHBOARD_DIR
  const normalizedPath = path.normalize(pathname).replace(/^[/\\]+/, "");
  const filePath = path.join(DASHBOARD_DIR, normalizedPath);

  const resolvedDashboardDir = path.resolve(DASHBOARD_DIR);
  const resolvedFilePath = path.resolve(filePath);
  if (
    !resolvedFilePath.startsWith(resolvedDashboardDir + path.sep) &&
    resolvedFilePath !== resolvedDashboardDir
  ) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const ext = path.extname(filePath);
  const contentTypes = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  };

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const headers = { "Content-Type": contentTypes[ext] || "text/plain" };

    // Avoid stale dashboards (users frequently hard-refresh while iterating)
    if ([".html", ".css", ".js", ".json"].includes(ext)) {
      headers["Cache-Control"] = "no-store";
    }

    res.writeHead(200, headers);
    res.end(content);
  });
}

// ============================================================================
// LEGACY API HANDLER
// ============================================================================
function handleApi(req, res) {
  const sessionsList = sessions.getSessions();
  const capacity = state.getCapacity();
  const tokenStats = getTokenStats(sessionsList, capacity, CONFIG);

  const data = {
    sessions: sessionsList,
    cron: getCronJobsSafe(),
    system: state.getSystemStatus(),
    activity: state.getRecentActivity(),
    tokenStats,
    capacity,
    timestamp: new Date().toISOString(),
  };

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

// ============================================================================
// HTTP SERVER
// ============================================================================
const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");

  const urlParts = req.url.split("?");
  const pathname = urlParts[0];
  const query = new URLSearchParams(urlParts[1] || "");

  // Fast path for health check
  if (pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", port: PORT, timestamp: new Date().toISOString() }));
    return;
  }

  // Auth check (unless public path). checkAuth normally returns a plain result
  // synchronously; with auth.tailscale.verifyServeOrigin enabled it returns a
  // Promise (whois lookup). applyAuthResult sends the 403 on denial and returns
  // true; on success it sets req.authUser and returns false so routing proceeds.
  const isPublicPath = AUTH_CONFIG.publicPaths.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );

  function applyAuthResult(authResult) {
    if (!authResult.authorized) {
      console.log(`[AUTH] Denied: ${authResult.reason} (path: ${pathname})`);
      res.writeHead(403, { "Content-Type": "text/html" });
      res.end(getUnauthorizedPage(authResult.reason, authResult.user, AUTH_CONFIG));
      return true;
    }
    req.authUser = authResult.user;
    if (authResult.user?.login || authResult.user?.email) {
      console.log(
        `[AUTH] Allowed: ${authResult.user.login || authResult.user.email} (path: ${pathname})`,
      );
    } else {
      console.log(`[AUTH] Allowed: ${req.socket?.remoteAddress} (path: ${pathname})`);
    }
    return false;
  }

  if (!isPublicPath && AUTH_CONFIG.mode !== "none") {
    const authResult = checkAuth(req, AUTH_CONFIG);
    if (authResult && typeof authResult.then === "function") {
      authResult.then((resolved) => {
        if (!applyAuthResult(resolved)) routeRequest(req, res, pathname, query);
      });
      return;
    }
    if (applyAuthResult(authResult)) return;
  }

  routeRequest(req, res, pathname, query);
});

// ============================================================================
// REQUEST ROUTING (post-auth)
// ============================================================================
function routeRequest(req, res, pathname, query) {
  // ---- API Routes ----

  if (pathname === "/api/status") {
    handleApi(req, res);
  } else if (pathname === "/api/session" || pathname === "/api/sessions/detail") {
    const sessionKey = query.get("key");
    if (!sessionKey) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing session key" }));
      return;
    }
    Promise.resolve(sessions.getSessionDetail(sessionKey))
      .then((detail) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(detail, null, 2));
      })
      .catch((e) => {
        console.error("[Sessions] Detail failed:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal error" }));
      });
    return;
  } else if (pathname === "/api/cerebro") {
    const offset = parseInt(query.get("offset") || "0", 10);
    const limit = parseInt(query.get("limit") || "20", 10);
    const statusFilter = query.get("status") || "all";

    const data = getCerebroTopics(PATHS.cerebro, { offset, limit, status: statusFilter });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data, null, 2));
  } else if (
    pathname.startsWith("/api/cerebro/topic/") &&
    pathname.endsWith("/status") &&
    req.method === "POST"
  ) {
    const topicId = decodeURIComponent(
      pathname.replace("/api/cerebro/topic/", "").replace("/status", ""),
    );

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const { status: newStatus } = JSON.parse(body);

        if (!newStatus || !["active", "resolved", "parked"].includes(newStatus)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ error: "Invalid status. Must be: active, resolved, or parked" }),
          );
          return;
        }

        const result = updateTopicStatus(PATHS.cerebro, topicId, newStatus);

        if (result.error) {
          res.writeHead(result.code || 500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: result.error }));
          return;
        }

        recordAudit(getRequestUser(req), "topic.status", topicId, { status: newStatus });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result, null, 2));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
      }
    });
    return;
  } else if (pathname === "/api/llm-quota") {
    const data = getLlmUsageSafe(PATHS.state);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data, null, 2));
  } else if (pathname === "/api/cost-breakdown") {
    const data = getCostBreakdown(CONFIG, (opts) => sessions.getSessions(opts), getOpenClawDir);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data, null, 2));
  } else if (pathname === "/api/subagents") {
    const data = state.getSubagentStatus();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ subagents: data }, null, 2));
  } else if (pathname === "/api/action" && req.method === "POST") {
    // Privileged verbs (agent-run) carry a structured body too big for a query
    // string, and run an arbitrary LOCAL agent — so they come in as POST and
    // are gated by the fail-closed node→node guard (localhost / mesh peer /
    // dispatch token). The GET branch (param-less quick actions) is unchanged.
    let rawBody = "";
    let bodyTooLarge = false;
    req.on("data", (chunk) => {
      rawBody += chunk;
      if (rawBody.length > 64 * 1024) {
        bodyTooLarge = true;
        req.destroy();
      }
    });
    req.on("end", () => {
      if (bodyTooLarge) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Request body too large" }));
        return;
      }
      let body;
      try {
        body = rawBody ? JSON.parse(rawBody) : {};
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Invalid JSON body" }));
        return;
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Request body must be a JSON object" }));
        return;
      }
      const action = typeof body.action === "string" ? body.action : "";
      // Only known privileged verbs are accepted over POST; everything else
      // 400s (GET remains the path for the param-less quick actions).
      if (!PRIVILEGED_POST_ACTIONS.has(action)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ success: false, action, error: `Unknown POST action: ${action}` }),
        );
        return;
      }

      // Resolve the guard inputs (mesh peer logins are async), then authorise.
      // When Serve-origin verification is on, also resolve the whois-verified
      // identity so the mesh-peer branch trusts that — not the raw header.
      const token = CONFIG.fleet.dispatch.token || null;
      const verifyServeOrigin = AUTH_CONFIG.tailscale.verifyServeOrigin === true;
      Promise.resolve(fleet.mesh.getState())
        .then((state) => {
          const nodes = Array.isArray(state && state.nodes) ? state.nodes : [];
          return new Set(
            nodes
              .filter((n) => n && typeof n.hostname === "string")
              .map((n) => n.hostname.trim().toLowerCase()),
          );
        })
        .catch(() => new Set())
        .then(async (meshLogins) => {
          let verifiedLogin = null;
          if (verifyServeOrigin) {
            const claimed = getRequestUser(req);
            verifiedLogin =
              claimed !== "anonymous"
                ? await verifyServeLogin(req, claimed, AUTH_CONFIG.tailscale.whoisFn)
                : null;
          }
          const verdict = guardActionPost(req, {
            token,
            meshLogins,
            verifyServeOrigin,
            verifiedLogin,
          });
          if (!verdict.allowed) {
            recordAudit(getRequestUser(req), "action.execute", action, {
              success: false,
              kind: "remote-dispatch",
              denied: verdict.reason,
            });
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, action, error: "Forbidden" }));
            return;
          }
          // Rate-limit agent-run through the shared fleet limiter, keyed by the
          // caller login (same limiter the mutating fleet routes use). Localhost
          // is exempt — internal/loopback dispatch must not be throttled.
          if (verdict.reason !== "localhost" && fleet.rateLimiter) {
            const rlKey = `agent-run|${getRequestUser(req)}`;
            const rl = fleet.rateLimiter.check(rlKey);
            if (!rl.allowed) {
              recordAudit(getRequestUser(req), "action.execute", action, {
                success: false,
                kind: "remote-dispatch",
                denied: "rate-limited",
              });
              res.writeHead(429, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  success: false,
                  action,
                  error: "Rate limit exceeded",
                  retryAfterMs: rl.retryAfterMs,
                }),
              );
              return;
            }
          }
          const opts = {
            agent: body.agent,
            message: body.message,
            sessionKey: body.sessionKey,
            timeoutSec: body.timeoutSec,
            staleMinutes: body.staleMinutes,
          };
          executeAction(action, actionDeps, opts)
            .then((result) => {
              recordAudit(getRequestUser(req), "action.execute", action, {
                success: result.success,
                kind: "remote-dispatch",
                agent: typeof body.agent === "string" ? body.agent : null,
              });
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(result, null, 2));
            })
            .catch((e) => {
              console.error("[Action] POST execute failed:", e.message);
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: false, action, error: "Internal error" }));
            });
        });
    });
    return;
  } else if (pathname === "/api/action") {
    const action = query.get("action");
    if (!action) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing action parameter" }));
      return;
    }
    // executeAction is async (CLI runs through the 20s async runner so slow
    // maintenance like `sessions cleanup --enforce` cannot time out silently).
    executeAction(action, actionDeps)
      .then((result) => {
        // Unknown/rejected actions are logged too (success:false) — attempted
        // actions are part of the trail.
        recordAudit(getRequestUser(req), "action.execute", action, { success: result.success });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result, null, 2));
      })
      .catch((e) => {
        console.error("[Action] Execute failed:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, action, error: "Internal error" }));
      });
    return;
  } else if (pathname === "/api/events") {
    // SSE endpoint
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    sseClients.add(res);
    console.log(`[SSE] Client connected (total: ${sseClients.size})`);

    sendSSE(res, "connected", { message: "Connected to OpenFleetControl", timestamp: Date.now() });

    const cachedState = state.getFullState();
    if (cachedState) {
      sendSSE(res, "update", cachedState);
    } else {
      sendSSE(res, "update", { sessions: [], loading: true });
    }

    req.on("close", () => {
      sseClients.delete(res);
      console.log(`[SSE] Client disconnected (total: ${sseClients.size})`);
    });

    return;
  } else if (pathname === "/api/whoami") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          authMode: AUTH_CONFIG.mode,
          user: req.authUser || null,
        },
        null,
        2,
      ),
    );
  } else if (pathname === "/api/about") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          name: "OpenFleetControl",
          version: getVersion(),
          description: "A Starcraft-inspired dashboard for AI agent orchestration",
          license: "MIT",
          repository: "https://github.com/AaronThrive/open-fleet-control",
          builtWith: ["OpenClaw", "Node.js", "Vanilla JS"],
          inspirations: ["Starcraft", "Inside Out", "iStatMenus", "DaisyDisk", "Gmail"],
        },
        null,
        2,
      ),
    );
  } else if (pathname === "/api/state") {
    // Attach the fleet summary (mesh.getState is async, so resolve first)
    const fullState = state.getFullState();
    fleet
      .getSummary()
      .catch((e) => {
        console.error("[Fleet] Summary failed:", e.message);
        return null;
      })
      .then((fleetSummary) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            {
              ...(fullState || {}),
              fleet: fleetSummary,
              cacheAgeMs: fullState?.timestamp ? Date.now() - fullState.timestamp : null,
              sessionsCacheAgeMs: toFiniteOrNull(sessions.getCacheAgeMs()),
            },
            null,
            2,
          ),
        );
      });
    return;
  } else if (pathname === "/api/vitals") {
    const wantsRefresh = query.get("refresh") === "1";
    const respond = () => {
      const vitals = getSystemVitals();
      const optionalDeps = getOptionalDeps();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          { vitals, optionalDeps, cacheAgeMs: toFiniteOrNull(getVitalsCacheAgeMs()) },
          null,
          2,
        ),
      );
    };
    if (wantsRefresh) {
      // Force a fresh collection (async-safe: coalesced with any in-flight
      // collection; the event loop is never blocked).
      forceRefreshVitals()
        .then(respond)
        .catch((e) => {
          console.error("[Vitals] Forced refresh failed:", e.message);
          respond();
        });
      return;
    }
    respond();
  } else if (pathname === "/api/capacity") {
    const capacity = state.getCapacity();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(capacity, null, 2));
  } else if (pathname === "/api/sessions") {
    const page = parseInt(query.get("page")) || 1;
    const pageSize = parseInt(query.get("pageSize")) || 20;
    const statusFilter = query.get("status");

    const allSessions = sessions.getSessions({ limit: null });

    const statusCounts = {
      all: allSessions.length,
      live: allSessions.filter((s) => s.active).length,
      recent: allSessions.filter((s) => !s.active && s.recentlyActive).length,
      idle: allSessions.filter((s) => !s.active && !s.recentlyActive).length,
    };

    let filteredSessions = allSessions;
    if (statusFilter === "live") {
      filteredSessions = allSessions.filter((s) => s.active);
    } else if (statusFilter === "recent") {
      filteredSessions = allSessions.filter((s) => !s.active && s.recentlyActive);
    } else if (statusFilter === "idle") {
      filteredSessions = allSessions.filter((s) => !s.active && !s.recentlyActive);
    }

    const total = filteredSessions.length;
    const totalPages = Math.ceil(total / pageSize);
    const offset = (page - 1) * pageSize;
    const displaySessions = filteredSessions.slice(offset, offset + pageSize);

    const capacity = state.getCapacity();
    const tokenStats = getTokenStats(allSessions, capacity, CONFIG);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          sessions: displaySessions,
          pagination: {
            page,
            pageSize,
            total,
            totalPages,
            hasPrev: page > 1,
            hasNext: page < totalPages,
          },
          statusCounts,
          tokenStats,
          capacity,
          cacheAgeMs: toFiniteOrNull(sessions.getCacheAgeMs()),
        },
        null,
        2,
      ),
    );
  } else if (pathname === "/api/sessions/transcript") {
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    const offsetRaw = query.get("offset");
    sessionControl
      .readTranscriptChunk({
        source: query.get("source"),
        id: query.get("id"),
        offset: offsetRaw === null || offsetRaw === "" ? null : Number(offsetRaw),
      })
      .then((result) => {
        res.writeHead(result.error ? result.code || 500 : 200, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(result, null, 2));
      })
      .catch((e) => {
        console.error("[SessionControl] Transcript failed:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal error" }));
      });
    return;
  } else if (pathname === "/api/sessions/transcript/search") {
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    const maxRaw = query.get("max");
    sessionControl
      .searchTranscript({
        source: query.get("source"),
        id: query.get("id"),
        query: query.get("q"),
        ...(maxRaw !== null && maxRaw !== "" ? { maxResults: Number(maxRaw) } : {}),
      })
      .then((result) => {
        res.writeHead(result.error ? result.code || 500 : 200, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(result, null, 2));
      })
      .catch((e) => {
        console.error("[SessionControl] Transcript search failed:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal error" }));
      });
    return;
  } else if (pathname === "/api/sessions/terminal/live") {
    sessionControl
      .getTerminalLive()
      .then((live) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(live, null, 2));
      })
      .catch((e) => {
        console.error("[SessionControl] Live lookup failed:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal error" }));
      });
    return;
  } else if (TERMINAL_KILL_RE.test(pathname)) {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    const pid = parseInt(pathname.match(TERMINAL_KILL_RE)[1], 10);
    const user = getRequestUser(req);
    const verdict = killRateLimiter.check(`${user}|${req.socket?.remoteAddress || "unknown"}`);
    if (!verdict.allowed) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Rate limit exceeded", retryAfterMs: verdict.retryAfterMs }));
      return;
    }
    sessionControl
      .killTerminalSession(pid)
      .then((result) => {
        if (result.success) {
          recordAudit(user, "session.kill", String(pid), {
            source: "terminal",
            signal: result.signal,
          });
        }
        res.writeHead(result.error ? result.code || 500 : 200, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(result, null, 2));
      })
      .catch((e) => {
        console.error("[SessionControl] Kill failed:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal error" }));
      });
    return;
  } else if (cronRoutes.isCronActionRoute(pathname)) {
    // POST /api/cron/:id/{enable|disable|run} — handler sends all responses.
    cronRoutes.handle(req, res, pathname).catch((e) => {
      console.error("[Cron] Action route failed:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error" }));
    });
    return;
  } else if (pathname === "/api/cron") {
    const cron = getCronJobsSafe();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ cron }, null, 2));
  } else if (pathname === "/api/operators") {
    const method = req.method;
    const data = loadOperators(DATA_DIR);

    if (method === "GET") {
      const allSessions = sessions.getSessions({ limit: null });
      const operatorsWithStats = calculateOperatorStats(data, allSessions);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          {
            ...operatorsWithStats,
            timestamp: Date.now(),
          },
          null,
          2,
        ),
      );
    } else if (method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const newOp = JSON.parse(body);
          const existingIdx = data.operators.findIndex((op) => op.id === newOp.id);
          if (existingIdx >= 0) {
            data.operators[existingIdx] = { ...data.operators[existingIdx], ...newOp };
          } else {
            data.operators.push({
              ...newOp,
              createdAt: new Date().toISOString(),
            });
          }
          if (saveOperators(DATA_DIR, data)) {
            // Field NAMES only — operator records may carry contact details.
            recordAudit(
              getRequestUser(req),
              "operator.save",
              newOp.id != null ? String(newOp.id) : null,
              { op: existingIdx >= 0 ? "update" : "create", fields: Object.keys(newOp) },
            );
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, operator: newOp }));
          } else {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Failed to save" }));
          }
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
      });
      return;
    } else {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
    }
    return;
  } else if (pathname === "/api/llm-usage") {
    const usage = getLlmUsageSafe(PATHS.state);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(usage, null, 2));
  } else if (pathname === "/api/routing-stats") {
    const hours = parseInt(query.get("hours") || "24", 10);
    const stats = getRoutingStats(PATHS.skills, PATHS.state, hours);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(stats, null, 2));
  } else if (pathname === "/api/memory") {
    const memory = state.getMemoryStats();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ memory }, null, 2));
  } else if (pathname === "/api/docker") {
    // Docker route handlers write the full JSON response themselves.
    const dockerHandler = docker.routes[`${req.method} ${pathname}`];
    if (!dockerHandler) {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    dockerHandler(req, res).catch((e) => {
      console.error("[Docker] Route failed:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error" }));
    });
    return;
  } else if (pathname === "/api/agents" || pathname === "/api/agents/fleet") {
    // Agents roster handlers write the full JSON response themselves.
    const agentsHandler = agentsRoster.routes[`${req.method} ${pathname}`];
    if (!agentsHandler) {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    agentsHandler(req, res).catch((e) => {
      console.error("[Agents] Route failed:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error" }));
    });
    return;
  } else if (pathname.startsWith("/api/usage/")) {
    // Usage-source handlers are async (ctx) => jsonObject and never throw
    // by contract; the catch is belt and braces.
    const usageHandler = usageSources.routes[`${req.method} ${pathname}`];
    if (!usageHandler) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Unknown usage route: ${req.method} ${pathname}` }));
      return;
    }
    usageHandler({ query })
      .then((payload) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload, null, 2));
      })
      .catch((e) => {
        console.error("[Usage] Route failed:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal error" }));
      });
    return;
  } else if (isTimelineRoute(pathname)) {
    // GET /api/fleet/agents/:id/timeline — agent flight recorder (read-only).
    // Must dispatch before the generic fleet routes, which 404 unknown paths.
    timelineRoutes.handle(req, res, pathname, query).catch((e) => {
      console.error("[Timeline] Route failed:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error" }));
    });
    return;
  } else if (flightRecorderRoutes && isFlightRecorderRoute(pathname)) {
    // GET /api/fleet/flight-recorder/{runs,runs/:id,live,stats} — durable run
    // archive + live in-progress runs (read-only). Must dispatch before the
    // generic fleet routes, which 404 unknown paths.
    flightRecorderRoutes.handle(req, res, pathname, query).catch((e) => {
      console.error("[FlightRecorder] Route failed:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error" }));
    });
    return;
  } else if (isFleetRoute(pathname)) {
    fleetRoutes.handle(req, res, pathname, query);
    return;
  } else if (isJobsRoute(pathname)) {
    handleJobsRequest(req, res, pathname, query, req.method);
  } else {
    serveStatic(req, res);
  }
}

// ============================================================================
// START SERVER
// ============================================================================
// Resolve the bind interface. Default (unset/"0.0.0.0"/"all") → null = bind ALL
// interfaces, preserving today's live behavior. An operator sets
// CONFIG.server.bindHost to "127.0.0.1" (the Serve cutover) to bind loopback.
const BIND_HOST = resolveBindHost(CONFIG.server.bindHost);
const listenArgs = BIND_HOST ? [PORT, BIND_HOST] : [PORT];
server.listen(...listenArgs, () => {
  const profile = process.env.OPENCLAW_PROFILE;
  const boundTo = BIND_HOST ? `${BIND_HOST}:${PORT}` : `:${PORT} (all interfaces)`;
  console.log(`\u{1F99E} OpenFleetControl running at http://localhost:${PORT} (bound ${boundTo})`);
  if (profile) {
    console.log(`   Profile: ${profile} (~/.openclaw-${profile})`);
  }
  console.log(`   Press Ctrl+C to stop`);

  // Pre-warm caches in background
  setTimeout(async () => {
    console.log("[Startup] Pre-warming caches in background...");
    try {
      if (OPENCLAW_SOURCES) {
        // startSessionsRefresh performs an immediate refresh, then keeps the
        // cache fresh every CONFIG.fleet.sessionsRefreshMs (request paths
        // always serve the cache — stale-while-revalidate).
        sessions.startSessionsRefresh();
        await refreshTokenUsageAsync(getOpenClawDir);
      }
      getSystemVitals();
      console.log("[Startup] Caches warmed.");
    } catch (e) {
      console.log("[Startup] Cache warming error:", e.message);
    }
    // Warm the cortex state cache in the background. getState() itself
    // never blocks on a cold cache anymore (it serves { warming: true }
    // immediately) — warmup() forces the real collection and resolves when
    // the cache is actually populated.
    if (CONFIG.fleet.cortex?.enabled && fleet.cortex?.warmup) {
      fleet.cortex
        .warmup()
        .then(() => console.log("[Startup] Cortex state cache warmed."))
        .catch((e) => console.log("[Startup] Cortex warming error:", e.message));
    }
    // Check for optional system dependencies (once at startup)
    checkOptionalDeps();
  }, 100);
});

// SSE heartbeat
let sseRefreshing = false;
setInterval(() => {
  if (sseClients.size > 0 && !sseRefreshing) {
    sseRefreshing = true;
    try {
      const fullState = state.refreshState();
      broadcastSSE("update", fullState);
      broadcastSSE("heartbeat", { clients: sseClients.size, timestamp: Date.now() });
    } catch (e) {
      console.error("[SSE] Broadcast error:", e.message);
    }
    sseRefreshing = false;
  }
}, 15000);
