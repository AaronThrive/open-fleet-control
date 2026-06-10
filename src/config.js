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
 */
function loadConfigFile() {
  const basePath = path.join(__dirname, "..", "config", "dashboard.json");
  const localPath = path.join(__dirname, "..", "config", "dashboard.local.json");

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
  mesh: { intervalMs: 15000 },
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
    },
    sinks: {
      slack: { enabled: false, gatewayUrl: "", channel: "" },
      webhooks: [],
    },
  },
  validationGate: { default: true },
  cortex: {
    enabled: true,
    lancedbPath: "",
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
  rateLimit: { windowMs: 60000, max: 120 },
  // Cost budgets (USD) over LLM API spend — see src/budgets.js. 0 = no limit.
  budgets: {
    enabled: false,
    daily: { totalUSD: 0, perProvider: {} },
    weekly: { totalUSD: 0, perProvider: {} },
    checkIntervalMs: 900000,
  },
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
};

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
  let fleet = deepMerge(FLEET_DEFAULTS, fileFleet || {});

  if (process.env.FLEET_CONFIG_JSON) {
    try {
      fleet = deepMerge(fleet, JSON.parse(process.env.FLEET_CONFIG_JSON));
    } catch (e) {
      console.warn("[Config] Invalid FLEET_CONFIG_JSON, ignoring:", e.message);
    }
  }

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

  const assembled = {
    ...fleet,
    ...resolvedDirs,
    cortex: resolvedCortex,
    usage: resolvedUsage,
    agents: resolvedAgents,
  };

  // 1Password secret refs (op://vault/item/field) in secret-bearing fields
  // (webhook secret, slack gatewayUrl, ntfy topic, usage.openrouterKey,
  // federation token) are resolved SYNCHRONOUSLY here — CONFIG is a sync
  // singleton consumed at require time, so boot-time execFileSync via the
  // shared resolver is the least invasive integration (see src/secrets.js
  // "RESOLUTION TIMING"). No-op (no process spawn) when no refs are present.
  // A failed ref logs its path+ref (never the secret) and resolves to "",
  // leaving that one integration unavailable while startup continues.
  const { value: resolved, failures } = defaultSecrets.resolveDeepSync(assembled);
  for (const failure of failures) {
    console.warn(
      `[Config] 1Password ref ${failure.ref} (fleet.${failure.path}) failed: ${failure.error} — continuing without it`,
    );
  }
  return resolved;
}

/**
 * Build final configuration
 */
function loadConfig() {
  const fileConfig = loadConfigFile();
  const workspace =
    process.env.OPENCLAW_WORKSPACE || expandPath(fileConfig.paths?.workspace) || detectWorkspace();

  const config = {
    // Server settings
    server: {
      port: parseInt(process.env.PORT || fileConfig.server?.port || "3333", 10),
      host: process.env.HOST || fileConfig.server?.host || "localhost",
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
    },
  };

  return config;
}

// Export singleton config
const CONFIG = loadConfig();

// Log detected configuration on startup
console.log("[Config] Workspace:", CONFIG.paths.workspace);
console.log("[Config] Auth mode:", CONFIG.auth.mode);

module.exports = { CONFIG, loadConfig, detectWorkspace, expandPath, getOpenClawDir };
