/**
 * OpenClaw Command Center Dashboard Server
 * Serves the dashboard UI and provides API endpoints for status data
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

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
const { handleJobsRequest, isJobsRoute, setCronFallback } = require("./jobs");
const { runOpenClaw, runOpenClawAsync, extractJSON } = require("./openclaw");
const {
  getSystemVitals,
  forceRefreshVitals,
  getVitalsCacheAgeMs,
  checkOptionalDeps,
  getOptionalDeps,
} = require("./vitals");
const { checkAuth, getUnauthorizedPage } = require("./auth");
const { loadPrivacySettings, savePrivacySettings } = require("./privacy");
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
const { migrateDataDir } = require("./data");
const { createStateModule } = require("./state");
const { createFleetRuntime } = require("./fleet");
const { createFleetRoutes, isFleetRoute } = require("./fleet-routes");
const { createSettings } = require("./settings");
const { createDocker } = require("./docker");
const { createUsageSources } = require("./usage-sources");
const { createAgentsRoster } = require("./agents-roster");
const { createSessionControl } = require("./session-control");
const { createRateLimiter } = require("./rate-limit");

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

// Settings service — persists the editable fleet config subset to
// config/dashboard.local.json and hot-applies alerts changes by rebuilding
// the fleet runtime's alert engine (no restart needed for alerts.*).
const settings = createSettings({
  configPath: path.join(__dirname, "..", "config", "dashboard.local.json"),
  onChange: (alertsConfig) => fleet.applyAlertsConfig(alertsConfig),
});

const fleetRoutes = createFleetRoutes({ fleet, settings });

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
// Headroom / OpenRouter usage data (paths configurable via fleet.usage).
const usageSources = createUsageSources({
  claudeProjectsDir: CONFIG.fleet.usage.claudeProjectsDir,
  codexDir: CONFIG.fleet.usage.codexDir,
  nineRouterDb: CONFIG.fleet.usage.nineRouterDb,
  headroomStats: CONFIG.fleet.usage.headroomStats || CONFIG.fleet.cortex.headroomStats,
  openrouterKey: process.env.OPENROUTER_API_KEY || CONFIG.fleet.usage.openrouterKey,
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

// ============================================================================
// STARTUP: Data migration + background tasks
// ============================================================================
process.nextTick(() => migrateDataDir(DATA_DIR, LEGACY_DATA_DIR));
fleet.start();
docker.start();
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

  // Auth check (unless public path)
  const isPublicPath = AUTH_CONFIG.publicPaths.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );

  if (!isPublicPath && AUTH_CONFIG.mode !== "none") {
    const authResult = checkAuth(req, AUTH_CONFIG);

    if (!authResult.authorized) {
      console.log(`[AUTH] Denied: ${authResult.reason} (path: ${pathname})`);
      res.writeHead(403, { "Content-Type": "text/html" });
      res.end(getUnauthorizedPage(authResult.reason, authResult.user, AUTH_CONFIG));
      return;
    }

    req.authUser = authResult.user;

    if (authResult.user?.login || authResult.user?.email) {
      console.log(
        `[AUTH] Allowed: ${authResult.user.login || authResult.user.email} (path: ${pathname})`,
      );
    } else {
      console.log(`[AUTH] Allowed: ${req.socket?.remoteAddress} (path: ${pathname})`);
    }
  }

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
  } else if (pathname === "/api/action") {
    const action = query.get("action");
    if (!action) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing action parameter" }));
      return;
    }
    const result = executeAction(action, { runOpenClaw, extractJSON, PORT });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result, null, 2));
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
    const login = req.headers["tailscale-user-login"];
    const user =
      typeof login === "string" && login.trim().length > 0
        ? login.trim().toLowerCase()
        : "anonymous";
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
          try {
            fleet.audit.record({
              user,
              action: "session.kill",
              target: String(pid),
              detail: { source: "terminal", signal: result.signal },
            });
          } catch (e) {
            console.error("[SessionControl] Audit record failed:", e.message);
          }
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
  } else if (pathname === "/api/privacy") {
    if (req.method === "GET") {
      const settings = loadPrivacySettings(DATA_DIR);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(settings, null, 2));
    } else if (req.method === "POST" || req.method === "PUT") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const updates = JSON.parse(body);
          const current = loadPrivacySettings(DATA_DIR);

          const merged = {
            version: current.version || 1,
            hiddenTopics: updates.hiddenTopics ?? current.hiddenTopics ?? [],
            hiddenSessions: updates.hiddenSessions ?? current.hiddenSessions ?? [],
            hiddenCrons: updates.hiddenCrons ?? current.hiddenCrons ?? [],
            hideHostname: updates.hideHostname ?? current.hideHostname ?? false,
          };

          if (savePrivacySettings(DATA_DIR, merged)) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, settings: merged }));
          } else {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Failed to save privacy settings" }));
          }
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON: " + e.message }));
        }
      });
      return;
    } else {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
    }
    return;
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
  } else if (isFleetRoute(pathname)) {
    fleetRoutes.handle(req, res, pathname, query);
    return;
  } else if (isJobsRoute(pathname)) {
    handleJobsRequest(req, res, pathname, query, req.method);
  } else {
    serveStatic(req, res);
  }
});

// ============================================================================
// START SERVER
// ============================================================================
server.listen(PORT, () => {
  const profile = process.env.OPENCLAW_PROFILE;
  console.log(`\u{1F99E} OpenFleetControl running at http://localhost:${PORT}`);
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
