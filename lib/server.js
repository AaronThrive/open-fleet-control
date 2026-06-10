#!/usr/bin/env node
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// src/utils.js
var require_utils = __commonJS({
  "src/utils.js"(exports2, module2) {
    var { exec } = require("child_process");
    var path2 = require("path");
    var { promisify } = require("util");
    var execAsync = promisify(exec);
    var pkg = require(path2.join(__dirname, "..", "package.json"));
    function getVersion2() {
      return pkg.version;
    }
    async function runCmd(cmd, options = {}) {
      const systemPath = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
      const envPath = process.env.PATH || "";
      const opts = {
        encoding: "utf8",
        timeout: 1e4,
        env: {
          ...process.env,
          PATH: envPath.includes("/usr/sbin") ? envPath : `${systemPath}:${envPath}`
        },
        ...options
      };
      try {
        const { stdout } = await execAsync(cmd, opts);
        return stdout.trim();
      } catch (e) {
        if (options.fallback !== void 0) return options.fallback;
        throw e;
      }
    }
    function formatBytes(bytes) {
      if (bytes >= 1099511627776) return (bytes / 1099511627776).toFixed(1) + " TB";
      if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + " GB";
      if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
      if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
      return bytes + " B";
    }
    function formatTimeAgo(date) {
      const now = /* @__PURE__ */ new Date();
      const diffMs = now - date;
      const diffMins = Math.round(diffMs / 6e4);
      if (diffMins < 1) return "just now";
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffMins < 1440) return `${Math.round(diffMins / 60)}h ago`;
      return `${Math.round(diffMins / 1440)}d ago`;
    }
    function formatNumber(n) {
      return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function formatTokens(n) {
      if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
      return n.toString();
    }
    module2.exports = {
      getVersion: getVersion2,
      runCmd,
      formatBytes,
      formatTimeAgo,
      formatNumber,
      formatTokens
    };
  }
});

// src/config.js
var require_config = __commonJS({
  "src/config.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var os = require("os");
    var HOME = os.homedir();
    function getOpenClawDir2(profile = null) {
      const effectiveProfile = profile || process.env.OPENCLAW_PROFILE || "";
      return effectiveProfile ? path2.join(HOME, `.openclaw-${effectiveProfile}`) : path2.join(HOME, ".openclaw");
    }
    function detectWorkspace() {
      const profile = process.env.OPENCLAW_PROFILE || "";
      const openclawDir = getOpenClawDir2();
      const defaultWorkspace = path2.join(openclawDir, "workspace");
      const profileCandidates = profile ? [
        // Profile-specific workspace in home (e.g., ~/.openclaw-<profile>-workspace)
        path2.join(HOME, `.openclaw-${profile}-workspace`),
        path2.join(HOME, `.${profile}-workspace`)
      ] : [];
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
        path2.join(HOME, "openclaw-workspace"),
        path2.join(HOME, ".openclaw-workspace"),
        // Legacy/custom names
        path2.join(HOME, "molty"),
        path2.join(HOME, "clawd"),
        path2.join(HOME, "moltbot")
      ].filter(Boolean);
      const foundWorkspace = candidates.find((candidate) => {
        if (!candidate || !fs2.existsSync(candidate)) {
          return false;
        }
        const hasMemory = fs2.existsSync(path2.join(candidate, "memory"));
        const hasState = fs2.existsSync(path2.join(candidate, "state"));
        const hasConfig = fs2.existsSync(path2.join(candidate, ".openclaw"));
        return hasMemory || hasState || hasConfig;
      });
      return foundWorkspace || defaultWorkspace;
    }
    function getWorkspaceFromGatewayConfig() {
      const openclawDir = getOpenClawDir2();
      const configPaths = [
        path2.join(openclawDir, "config.yaml"),
        path2.join(openclawDir, "config.json"),
        path2.join(openclawDir, "openclaw.json"),
        path2.join(openclawDir, "clawdbot.json"),
        // Fallback to standard XDG location
        path2.join(HOME, ".config", "openclaw", "config.yaml")
      ];
      for (const configPath of configPaths) {
        try {
          if (fs2.existsSync(configPath)) {
            const content = fs2.readFileSync(configPath, "utf8");
            const match = content.match(/workspace[:\s]+["']?([^"'\n]+)/i) || content.match(/workdir[:\s]+["']?([^"'\n]+)/i);
            if (match && match[1]) {
              const workspace = match[1].trim().replace(/^~/, HOME);
              if (fs2.existsSync(workspace)) {
                return workspace;
              }
            }
          }
        } catch (e) {
        }
      }
      return null;
    }
    function deepMerge(base, override) {
      const result = { ...base };
      for (const key of Object.keys(override)) {
        if (override[key] && typeof override[key] === "object" && !Array.isArray(override[key]) && base[key] && typeof base[key] === "object") {
          result[key] = deepMerge(base[key], override[key]);
        } else if (override[key] !== null && override[key] !== void 0) {
          result[key] = override[key];
        }
      }
      return result;
    }
    function loadConfigFile() {
      const basePath = path2.join(__dirname, "..", "config", "dashboard.json");
      const localPath = path2.join(__dirname, "..", "config", "dashboard.local.json");
      let config = {};
      try {
        if (fs2.existsSync(basePath)) {
          const content = fs2.readFileSync(basePath, "utf8");
          config = JSON.parse(content);
        }
      } catch (e) {
        console.warn(`[Config] Failed to load ${basePath}:`, e.message);
      }
      try {
        if (fs2.existsSync(localPath)) {
          const content = fs2.readFileSync(localPath, "utf8");
          const localConfig = JSON.parse(content);
          config = deepMerge(config, localConfig);
          console.log(`[Config] Loaded local overrides from ${localPath}`);
        }
      } catch (e) {
        console.warn(`[Config] Failed to load ${localPath}:`, e.message);
      }
      return config;
    }
    function expandPath(p) {
      if (!p) return p;
      return p.replace(/^~/, HOME).replace(/\$HOME/g, HOME).replace(/\$\{HOME\}/g, HOME);
    }
    var FLEET_DEFAULTS = {
      stateDir: "state",
      logsDir: "logs",
      briefsDir: "briefs",
      workspaceDir: ".",
      mesh: { intervalMs: 15e3 },
      federation: { intervalMs: 3e4 },
      watchdog: { thresholdMs: 18e5 },
      alerts: {
        enabled: false,
        rules: {
          nodeOffline: true,
          nodeUnreachable: true,
          taskFailed: true,
          taskStale: true,
          lessonPending: true
        },
        sinks: {
          slack: { enabled: false, gatewayUrl: "", channel: "" },
          webhooks: []
        }
      },
      validationGate: { default: true },
      cortex: {
        enabled: true,
        lancedbPath: "",
        gbrainCli: "",
        headroomStats: "",
        leanCtxStats: "",
        lcmDb: ""
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
        openrouterKey: ""
      },
      rateLimit: { windowMs: 6e4, max: 120 }
    };
    function buildFleetConfig(fileFleet) {
      let fleet2 = deepMerge(FLEET_DEFAULTS, fileFleet || {});
      if (process.env.FLEET_CONFIG_JSON) {
        try {
          fleet2 = deepMerge(fleet2, JSON.parse(process.env.FLEET_CONFIG_JSON));
        } catch (e) {
          console.warn("[Config] Invalid FLEET_CONFIG_JSON, ignoring:", e.message);
        }
      }
      const packageRoot = path2.join(__dirname, "..");
      const resolvedDirs = {};
      for (const key of ["stateDir", "logsDir", "briefsDir", "workspaceDir"]) {
        resolvedDirs[key] = path2.resolve(packageRoot, expandPath(String(fleet2[key])));
      }
      const resolvedCortex = { ...fleet2.cortex };
      for (const key of Object.keys(resolvedCortex)) {
        if (typeof resolvedCortex[key] === "string" && resolvedCortex[key].length > 0) {
          resolvedCortex[key] = expandPath(resolvedCortex[key]);
        }
      }
      const resolvedUsage = { ...fleet2.usage };
      for (const key of ["claudeProjectsDir", "codexDir", "nineRouterDb", "headroomStats"]) {
        if (typeof resolvedUsage[key] === "string" && resolvedUsage[key].length > 0) {
          resolvedUsage[key] = expandPath(resolvedUsage[key]);
        }
      }
      return { ...fleet2, ...resolvedDirs, cortex: resolvedCortex, usage: resolvedUsage };
    }
    function loadConfig() {
      const fileConfig = loadConfigFile();
      const workspace = process.env.OPENCLAW_WORKSPACE || expandPath(fileConfig.paths?.workspace) || detectWorkspace();
      const config = {
        // Server settings
        server: {
          port: parseInt(process.env.PORT || fileConfig.server?.port || "3333", 10),
          host: process.env.HOST || fileConfig.server?.host || "localhost"
        },
        // Paths - all relative to workspace unless absolute
        paths: {
          workspace,
          memory: expandPath(process.env.OPENCLAW_MEMORY_DIR || fileConfig.paths?.memory) || path2.join(workspace, "memory"),
          state: expandPath(process.env.OPENCLAW_STATE_DIR || fileConfig.paths?.state) || path2.join(workspace, "state"),
          cerebro: expandPath(process.env.OPENCLAW_CEREBRO_DIR || fileConfig.paths?.cerebro) || path2.join(workspace, "cerebro"),
          skills: expandPath(process.env.OPENCLAW_SKILLS_DIR || fileConfig.paths?.skills) || path2.join(workspace, "skills"),
          jobs: expandPath(process.env.OPENCLAW_JOBS_DIR || fileConfig.paths?.jobs) || path2.join(workspace, "jobs"),
          logs: expandPath(process.env.OPENCLAW_LOGS_DIR || fileConfig.paths?.logs) || path2.join(HOME, ".openclaw-command-center", "logs")
        },
        // Auth settings
        auth: {
          mode: process.env.DASHBOARD_AUTH_MODE || fileConfig.auth?.mode || "none",
          token: process.env.DASHBOARD_TOKEN || fileConfig.auth?.token,
          allowedUsers: (process.env.DASHBOARD_ALLOWED_USERS || fileConfig.auth?.allowedUsers?.join(",") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
          allowedIPs: (process.env.DASHBOARD_ALLOWED_IPS || fileConfig.auth?.allowedIPs?.join(",") || "127.0.0.1,::1").split(",").map((s) => s.trim()),
          publicPaths: fileConfig.auth?.publicPaths || ["/api/health", "/api/whoami", "/favicon.ico"]
        },
        // Branding
        branding: {
          name: fileConfig.branding?.name || "OpenFleetControl",
          theme: fileConfig.branding?.theme || "default"
        },
        // Integrations
        integrations: {
          linear: {
            enabled: !!(process.env.LINEAR_API_KEY || fileConfig.integrations?.linear?.apiKey),
            apiKey: process.env.LINEAR_API_KEY || fileConfig.integrations?.linear?.apiKey,
            teamId: process.env.LINEAR_TEAM_ID || fileConfig.integrations?.linear?.teamId
          }
        },
        // Fleet (mesh / chat / kanban / briefs / evolution / cortex / alerts)
        fleet: buildFleetConfig(fileConfig.fleet),
        // Billing - for cost savings calculation
        billing: {
          claudePlanCost: parseFloat(
            process.env.CLAUDE_PLAN_COST || fileConfig.billing?.claudePlanCost || "200"
          ),
          claudePlanName: process.env.CLAUDE_PLAN_NAME || fileConfig.billing?.claudePlanName || "Claude Code Max"
        }
      };
      return config;
    }
    var CONFIG2 = loadConfig();
    console.log("[Config] Workspace:", CONFIG2.paths.workspace);
    console.log("[Config] Auth mode:", CONFIG2.auth.mode);
    module2.exports = { CONFIG: CONFIG2, loadConfig, detectWorkspace, expandPath, getOpenClawDir: getOpenClawDir2 };
  }
});

// src/jobs.js
var require_jobs = __commonJS({
  "src/jobs.js"(exports2, module2) {
    var path2 = require("path");
    var { CONFIG: CONFIG2 } = require_config();
    var JOBS_DIR = CONFIG2.paths.jobs;
    var JOBS_STATE_DIR = path2.join(CONFIG2.paths.state, "jobs");
    var apiInstance = null;
    var forceApiUnavailable = false;
    async function getAPI() {
      if (forceApiUnavailable) return null;
      if (apiInstance) return apiInstance;
      try {
        const { createJobsAPI } = await import(path2.join(JOBS_DIR, "lib/api.js"));
        apiInstance = createJobsAPI({
          definitionsDir: path2.join(JOBS_DIR, "definitions"),
          stateDir: JOBS_STATE_DIR
        });
        return apiInstance;
      } catch (e) {
        console.error("Failed to load jobs API:", e.message);
        return null;
      }
    }
    function _resetForTesting(options = {}) {
      apiInstance = null;
      forceApiUnavailable = options.forceUnavailable || false;
    }
    function formatRelativeTime(isoString) {
      if (!isoString) return null;
      const date = new Date(isoString);
      const now = /* @__PURE__ */ new Date();
      const diffMs = now - date;
      const diffMins = Math.round(diffMs / 6e4);
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
    async function handleJobsRequest2(req, res, pathname, query, method) {
      const api = await getAPI();
      if (!api) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Jobs API not available" }));
        return;
      }
      try {
        if (pathname === "/api/jobs/scheduler/status" && method === "GET") {
          const status = await api.getSchedulerStatus();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(status, null, 2));
          return;
        }
        if (pathname === "/api/jobs/stats" && method === "GET") {
          const stats = await api.getAggregateStats();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(stats, null, 2));
          return;
        }
        if (pathname === "/api/jobs/cache/clear" && method === "POST") {
          api.clearCache();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, message: "Cache cleared" }));
          return;
        }
        if (pathname === "/api/jobs" && method === "GET") {
          const jobs = await api.listJobs();
          const enhanced = jobs.map((job) => ({
            ...job,
            lastRunRelative: formatRelativeTime(job.lastRun),
            nextRunRelative: formatRelativeTime(job.nextRun)
          }));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jobs: enhanced, timestamp: Date.now() }, null, 2));
          return;
        }
        const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
        if (jobMatch && method === "GET") {
          const jobId = decodeURIComponent(jobMatch[1]);
          const job = await api.getJob(jobId);
          if (!job) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Job not found" }));
            return;
          }
          job.lastRunRelative = formatRelativeTime(job.lastRun);
          job.nextRunRelative = formatRelativeTime(job.nextRun);
          if (job.recentRuns) {
            job.recentRuns = job.recentRuns.map((run) => ({
              ...run,
              startedAtRelative: formatRelativeTime(run.startedAt),
              completedAtRelative: formatRelativeTime(run.completedAt)
            }));
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(job, null, 2));
          return;
        }
        const historyMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/history$/);
        if (historyMatch && method === "GET") {
          const jobId = decodeURIComponent(historyMatch[1]);
          const limit = parseInt(query.get("limit") || "50", 10);
          const runs = await api.getJobHistory(jobId, limit);
          const enhanced = runs.map((run) => ({
            ...run,
            startedAtRelative: formatRelativeTime(run.startedAt),
            completedAtRelative: formatRelativeTime(run.completedAt)
          }));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ runs: enhanced, timestamp: Date.now() }, null, 2));
          return;
        }
        const runMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/run$/);
        if (runMatch && method === "POST") {
          const jobId = decodeURIComponent(runMatch[1]);
          const result = await api.runJob(jobId);
          res.writeHead(result.success ? 200 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result, null, 2));
          return;
        }
        const pauseMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/pause$/);
        if (pauseMatch && method === "POST") {
          const jobId = decodeURIComponent(pauseMatch[1]);
          let body = "";
          await new Promise((resolve) => {
            req.on("data", (chunk) => body += chunk);
            req.on("end", resolve);
          });
          let reason = null;
          try {
            const parsed = JSON.parse(body || "{}");
            reason = parsed.reason;
          } catch (_e) {
          }
          const result = await api.pauseJob(jobId, {
            by: req.authUser?.login || "dashboard",
            reason
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result, null, 2));
          return;
        }
        const resumeMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/resume$/);
        if (resumeMatch && method === "POST") {
          const jobId = decodeURIComponent(resumeMatch[1]);
          const result = await api.resumeJob(jobId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result, null, 2));
          return;
        }
        const skipMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/skip$/);
        if (skipMatch && method === "POST") {
          const jobId = decodeURIComponent(skipMatch[1]);
          const result = await api.skipJob(jobId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result, null, 2));
          return;
        }
        const killMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/kill$/);
        if (killMatch && method === "POST") {
          const jobId = decodeURIComponent(killMatch[1]);
          const result = await api.killJob(jobId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result, null, 2));
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      } catch (e) {
        console.error("Jobs API error:", e);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
    function isJobsRoute2(pathname) {
      return pathname.startsWith("/api/jobs");
    }
    module2.exports = { handleJobsRequest: handleJobsRequest2, isJobsRoute: isJobsRoute2, _resetForTesting };
  }
});

// src/openclaw.js
var require_openclaw = __commonJS({
  "src/openclaw.js"(exports2, module2) {
    var { execFileSync, execFile } = require("child_process");
    var { promisify } = require("util");
    var execFileAsync = promisify(execFile);
    function getSafeEnv() {
      return {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USER: process.env.USER,
        SHELL: process.env.SHELL,
        LANG: process.env.LANG,
        NO_COLOR: "1",
        TERM: "dumb",
        OPENCLAW_PROFILE: process.env.OPENCLAW_PROFILE || "",
        OPENCLAW_WORKSPACE: process.env.OPENCLAW_WORKSPACE || "",
        OPENCLAW_HOME: process.env.OPENCLAW_HOME || ""
      };
    }
    function buildArgs(args2) {
      const profile = process.env.OPENCLAW_PROFILE || "";
      const profileArgs = profile ? ["--profile", profile] : [];
      const cleanArgs = args2.replace(/\s*2>&1\s*/g, " ").replace(/\s*2>\/dev\/null\s*/g, " ").trim();
      return [...profileArgs, ...cleanArgs.split(/\s+/).filter(Boolean)];
    }
    function runOpenClaw2(args2) {
      try {
        const result = execFileSync("openclaw", buildArgs(args2), {
          encoding: "utf8",
          timeout: 3e3,
          env: getSafeEnv(),
          stdio: ["pipe", "pipe", "pipe"]
        });
        return result;
      } catch (e) {
        return null;
      }
    }
    async function runOpenClawAsync2(args2) {
      try {
        const { stdout } = await execFileAsync("openclaw", buildArgs(args2), {
          encoding: "utf8",
          timeout: 2e4,
          env: getSafeEnv()
        });
        return stdout;
      } catch (e) {
        console.error("[OpenClaw Async] Error:", e.message);
        return null;
      }
    }
    function extractJSON2(output) {
      if (!output) return null;
      const jsonStart = output.search(/[[{]/);
      if (jsonStart === -1) return null;
      return output.slice(jsonStart);
    }
    module2.exports = {
      runOpenClaw: runOpenClaw2,
      runOpenClawAsync: runOpenClawAsync2,
      extractJSON: extractJSON2,
      getSafeEnv
    };
  }
});

// src/vitals.js
var require_vitals = __commonJS({
  "src/vitals.js"(exports2, module2) {
    var { runCmd, formatBytes } = require_utils();
    var cachedVitals = null;
    var lastVitalsUpdate = 0;
    var VITALS_CACHE_TTL = 3e4;
    var vitalsRefreshing = false;
    async function refreshVitalsAsync() {
      if (vitalsRefreshing) return;
      vitalsRefreshing = true;
      const vitals = {
        hostname: "",
        uptime: "",
        disk: { used: 0, free: 0, total: 0, percent: 0, kbPerTransfer: 0, iops: 0, throughputMBps: 0 },
        cpu: { loadAvg: [0, 0, 0], cores: 0, usage: 0 },
        memory: { used: 0, free: 0, total: 0, percent: 0, pressure: "normal" },
        temperature: null
      };
      const isLinux = process.platform === "linux";
      const isMacOS = process.platform === "darwin";
      try {
        const coresCmd = isLinux ? "nproc" : "sysctl -n hw.ncpu";
        const memCmd = isLinux ? "cat /proc/meminfo | grep MemTotal | awk '{print $2}'" : "sysctl -n hw.memsize";
        const topCmd = isLinux ? "top -bn1 | head -3 | grep -E '^%?Cpu|^  ?CPU' || echo ''" : 'top -l 1 -n 0 2>/dev/null | grep "CPU usage" || echo ""';
        const mpstatCmd = isLinux ? "(command -v mpstat >/dev/null 2>&1 && mpstat 1 1 | tail -1 | sed 's/^Average: *//') || echo ''" : "";
        const [hostname, uptimeRaw, coresRaw, memTotalRaw, memInfoRaw, dfRaw, topOutput, mpstatOutput] = await Promise.all([
          runCmd("hostname", { fallback: "unknown" }),
          runCmd("uptime", { fallback: "" }),
          runCmd(coresCmd, { fallback: "1" }),
          runCmd(memCmd, { fallback: "0" }),
          isLinux ? runCmd("cat /proc/meminfo", { fallback: "" }) : runCmd("vm_stat", { fallback: "" }),
          runCmd("df -k ~ | tail -1", { fallback: "" }),
          runCmd(topCmd, { fallback: "" }),
          isLinux ? runCmd(mpstatCmd, { fallback: "" }) : Promise.resolve("")
        ]);
        vitals.hostname = hostname;
        const uptimeMatch = uptimeRaw.match(/up\s+([^,]+)/);
        if (uptimeMatch) vitals.uptime = uptimeMatch[1].trim();
        const loadMatch = uptimeRaw.match(/load averages?:\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
        if (loadMatch)
          vitals.cpu.loadAvg = [
            parseFloat(loadMatch[1]),
            parseFloat(loadMatch[2]),
            parseFloat(loadMatch[3])
          ];
        vitals.cpu.cores = parseInt(coresRaw, 10) || 1;
        vitals.cpu.usage = Math.min(100, Math.round(vitals.cpu.loadAvg[0] / vitals.cpu.cores * 100));
        if (isLinux) {
          if (mpstatOutput) {
            const parts = mpstatOutput.trim().split(/\s+/);
            const user = parts.length > 1 ? parseFloat(parts[1]) : NaN;
            const sys = parts.length > 3 ? parseFloat(parts[3]) : NaN;
            const idle = parts.length ? parseFloat(parts[parts.length - 1]) : NaN;
            if (!Number.isNaN(user)) vitals.cpu.userPercent = user;
            if (!Number.isNaN(sys)) vitals.cpu.sysPercent = sys;
            if (!Number.isNaN(idle)) {
              vitals.cpu.idlePercent = idle;
              vitals.cpu.usage = Math.max(0, Math.min(100, Math.round(100 - idle)));
            }
          }
          if (topOutput && (vitals.cpu.idlePercent === null || vitals.cpu.idlePercent === void 0)) {
            const userMatch = topOutput.match(/([\d.]+)\s*us/);
            const sysMatch = topOutput.match(/([\d.]+)\s*sy/);
            const idleMatch = topOutput.match(/([\d.]+)\s*id/);
            vitals.cpu.userPercent = userMatch ? parseFloat(userMatch[1]) : null;
            vitals.cpu.sysPercent = sysMatch ? parseFloat(sysMatch[1]) : null;
            vitals.cpu.idlePercent = idleMatch ? parseFloat(idleMatch[1]) : null;
            if (vitals.cpu.userPercent !== null && vitals.cpu.sysPercent !== null) {
              vitals.cpu.usage = Math.round(vitals.cpu.userPercent + vitals.cpu.sysPercent);
            }
          }
        } else if (topOutput) {
          const userMatch = topOutput.match(/([\d.]+)%\s*user/);
          const sysMatch = topOutput.match(/([\d.]+)%\s*sys/);
          const idleMatch = topOutput.match(/([\d.]+)%\s*idle/);
          vitals.cpu.userPercent = userMatch ? parseFloat(userMatch[1]) : null;
          vitals.cpu.sysPercent = sysMatch ? parseFloat(sysMatch[1]) : null;
          vitals.cpu.idlePercent = idleMatch ? parseFloat(idleMatch[1]) : null;
          if (vitals.cpu.userPercent !== null && vitals.cpu.sysPercent !== null) {
            vitals.cpu.usage = Math.round(vitals.cpu.userPercent + vitals.cpu.sysPercent);
          }
        }
        const dfParts = dfRaw.split(/\s+/);
        if (dfParts.length >= 4) {
          vitals.disk.total = parseInt(dfParts[1], 10) * 1024;
          vitals.disk.used = parseInt(dfParts[2], 10) * 1024;
          vitals.disk.free = parseInt(dfParts[3], 10) * 1024;
          vitals.disk.percent = Math.round(parseInt(dfParts[2], 10) / parseInt(dfParts[1], 10) * 100);
        }
        if (isLinux) {
          const memTotalKB = parseInt(memTotalRaw, 10) || 0;
          const memAvailableMatch = memInfoRaw.match(/MemAvailable:\s+(\d+)/);
          const memFreeMatch = memInfoRaw.match(/MemFree:\s+(\d+)/);
          vitals.memory.total = memTotalKB * 1024;
          const memAvailable = parseInt(memAvailableMatch?.[1] || memFreeMatch?.[1] || 0, 10) * 1024;
          vitals.memory.used = vitals.memory.total - memAvailable;
          vitals.memory.free = memAvailable;
          vitals.memory.percent = vitals.memory.total > 0 ? Math.round(vitals.memory.used / vitals.memory.total * 100) : 0;
        } else {
          const pageSizeMatch = memInfoRaw.match(/page size of (\d+) bytes/);
          const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 4096;
          const activePages = parseInt((memInfoRaw.match(/Pages active:\s+(\d+)/) || [])[1] || 0, 10);
          const wiredPages = parseInt(
            (memInfoRaw.match(/Pages wired down:\s+(\d+)/) || [])[1] || 0,
            10
          );
          const compressedPages = parseInt(
            (memInfoRaw.match(/Pages occupied by compressor:\s+(\d+)/) || [])[1] || 0,
            10
          );
          vitals.memory.total = parseInt(memTotalRaw, 10) || 0;
          vitals.memory.used = (activePages + wiredPages + compressedPages) * pageSize;
          vitals.memory.free = vitals.memory.total - vitals.memory.used;
          vitals.memory.percent = vitals.memory.total > 0 ? Math.round(vitals.memory.used / vitals.memory.total * 100) : 0;
        }
        vitals.memory.pressure = vitals.memory.percent > 90 ? "critical" : vitals.memory.percent > 75 ? "warning" : "normal";
        const timeoutPrefix = isLinux ? "timeout 5" : "$(command -v gtimeout >/dev/null 2>&1 && echo gtimeout 5)";
        const iostatArgs = isLinux ? "-d -o JSON 1 2" : "-d -c 2 2";
        const iostatCmd = `${timeoutPrefix} iostat ${iostatArgs} 2>/dev/null || echo ''`;
        const [perfCores, effCores, chip, iostatRaw] = await Promise.all([
          isMacOS ? runCmd("sysctl -n hw.perflevel0.logicalcpu 2>/dev/null || echo 0", { fallback: "0" }) : Promise.resolve("0"),
          isMacOS ? runCmd("sysctl -n hw.perflevel1.logicalcpu 2>/dev/null || echo 0", { fallback: "0" }) : Promise.resolve("0"),
          isMacOS ? runCmd(
            'system_profiler SPHardwareDataType 2>/dev/null | grep "Chip:" | cut -d: -f2 || echo ""',
            { fallback: "" }
          ) : Promise.resolve(""),
          runCmd(iostatCmd, { fallback: "", timeout: 5e3 })
        ]);
        if (isLinux) {
          const cpuBrand = await runCmd(
            "cat /proc/cpuinfo | grep 'model name' | head -1 | cut -d: -f2",
            { fallback: "" }
          );
          if (cpuBrand) vitals.cpu.brand = cpuBrand.trim();
        }
        vitals.cpu.pCores = parseInt(perfCores, 10) || null;
        vitals.cpu.eCores = parseInt(effCores, 10) || null;
        if (chip) vitals.cpu.chip = chip;
        if (isLinux) {
          try {
            const iostatJson = JSON.parse(iostatRaw);
            const samples = iostatJson.sysstat.hosts[0].statistics;
            const disks = samples[samples.length - 1].disk;
            const disk = disks.filter((d) => !d.disk_device.startsWith("loop")).sort((a, b) => b.tps - a.tps)[0];
            if (disk) {
              const kbReadPerSec = disk["kB_read/s"] || 0;
              const kbWrtnPerSec = disk["kB_wrtn/s"] || 0;
              vitals.disk.iops = disk.tps || 0;
              vitals.disk.throughputMBps = (kbReadPerSec + kbWrtnPerSec) / 1024;
              vitals.disk.kbPerTransfer = disk.tps > 0 ? (kbReadPerSec + kbWrtnPerSec) / disk.tps : 0;
            }
          } catch {
          }
        } else {
          const iostatLines = iostatRaw.split("\n").filter((l) => l.trim());
          const lastLine = iostatLines.length > 0 ? iostatLines[iostatLines.length - 1] : "";
          const iostatParts = lastLine.split(/\s+/).filter(Boolean);
          if (iostatParts.length >= 3) {
            vitals.disk.kbPerTransfer = parseFloat(iostatParts[0]) || 0;
            vitals.disk.iops = parseFloat(iostatParts[1]) || 0;
            vitals.disk.throughputMBps = parseFloat(iostatParts[2]) || 0;
          }
        }
        vitals.temperature = null;
        vitals.temperatureNote = null;
        const isAppleSilicon = vitals.cpu.chip && /apple/i.test(vitals.cpu.chip);
        if (isAppleSilicon) {
          vitals.temperatureNote = "Apple Silicon (requires elevated access)";
          try {
            const pmOutput = await runCmd(
              'sudo -n powermetrics --samplers smc -i 1 -n 1 2>/dev/null | grep -i "die temp" | head -1',
              { fallback: "", timeout: 5e3 }
            );
            const tempMatch = pmOutput.match(/([\d.]+)/);
            if (tempMatch) {
              vitals.temperature = parseFloat(tempMatch[1]);
              vitals.temperatureNote = null;
            }
          } catch (e) {
          }
        } else if (isMacOS) {
          const home = require("os").homedir();
          try {
            const temp = await runCmd(
              `osx-cpu-temp 2>/dev/null || ${home}/bin/osx-cpu-temp 2>/dev/null`,
              { fallback: "" }
            );
            if (temp && temp.includes("\xB0")) {
              const tempMatch = temp.match(/([\d.]+)/);
              if (tempMatch && parseFloat(tempMatch[1]) > 0) {
                vitals.temperature = parseFloat(tempMatch[1]);
              }
            }
          } catch (e) {
          }
          if (!vitals.temperature) {
            try {
              const ioregRaw = await runCmd(
                "ioreg -r -n AppleSmartBattery 2>/dev/null | grep Temperature",
                { fallback: "" }
              );
              const tempMatch = ioregRaw.match(/"Temperature"\s*=\s*(\d+)/);
              if (tempMatch) {
                vitals.temperature = Math.round(parseInt(tempMatch[1], 10) / 100);
              }
            } catch (e) {
            }
          }
        } else if (isLinux) {
          try {
            const temp = await runCmd("cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null", {
              fallback: ""
            });
            if (temp) {
              vitals.temperature = Math.round(parseInt(temp, 10) / 1e3);
            }
          } catch (e) {
          }
        }
      } catch (e) {
        console.error("[Vitals] Async refresh failed:", e.message);
      }
      vitals.memory.usedFormatted = formatBytes(vitals.memory.used);
      vitals.memory.totalFormatted = formatBytes(vitals.memory.total);
      vitals.memory.freeFormatted = formatBytes(vitals.memory.free);
      vitals.disk.usedFormatted = formatBytes(vitals.disk.used);
      vitals.disk.totalFormatted = formatBytes(vitals.disk.total);
      vitals.disk.freeFormatted = formatBytes(vitals.disk.free);
      cachedVitals = vitals;
      lastVitalsUpdate = Date.now();
      vitalsRefreshing = false;
      console.log("[Vitals] Cache refreshed async");
    }
    setTimeout(() => refreshVitalsAsync(), 500);
    setInterval(() => refreshVitalsAsync(), VITALS_CACHE_TTL);
    function getSystemVitals2() {
      const now = Date.now();
      if (!cachedVitals || now - lastVitalsUpdate > VITALS_CACHE_TTL) {
        refreshVitalsAsync();
      }
      if (cachedVitals) return cachedVitals;
      return {
        hostname: "loading...",
        uptime: "",
        disk: {
          used: 0,
          free: 0,
          total: 0,
          percent: 0,
          usedFormatted: "-",
          totalFormatted: "-",
          freeFormatted: "-"
        },
        cpu: { loadAvg: [0, 0, 0], cores: 0, usage: 0 },
        memory: {
          used: 0,
          free: 0,
          total: 0,
          percent: 0,
          pressure: "normal",
          usedFormatted: "-",
          totalFormatted: "-",
          freeFormatted: "-"
        },
        temperature: null
      };
    }
    var cachedDeps = null;
    async function checkOptionalDeps2() {
      const isLinux = process.platform === "linux";
      const isMacOS = process.platform === "darwin";
      const platform = isLinux ? "linux" : isMacOS ? "darwin" : null;
      const results = [];
      if (!platform) {
        cachedDeps = results;
        return results;
      }
      const fs2 = require("fs");
      const path2 = require("path");
      const depsFile = path2.join(__dirname, "..", "config", "system-deps.json");
      let depsConfig;
      try {
        depsConfig = JSON.parse(fs2.readFileSync(depsFile, "utf8"));
      } catch {
        cachedDeps = results;
        return results;
      }
      const deps = depsConfig[platform] || [];
      const home = require("os").homedir();
      let pkgManager = null;
      if (isLinux) {
        for (const pm of ["apt", "dnf", "yum", "pacman", "apk"]) {
          const has = await runCmd(`which ${pm}`, { fallback: "" });
          if (has) {
            pkgManager = pm;
            break;
          }
        }
      } else if (isMacOS) {
        const hasBrew = await runCmd("which brew", { fallback: "" });
        if (hasBrew) pkgManager = "brew";
      }
      let isAppleSilicon = false;
      if (isMacOS) {
        const chip = await runCmd("sysctl -n machdep.cpu.brand_string", { fallback: "" });
        isAppleSilicon = /apple/i.test(chip);
      }
      for (const dep of deps) {
        if (dep.condition === "intel" && isAppleSilicon) continue;
        let installed = false;
        const hasBinary = await runCmd(`which ${dep.binary} 2>/dev/null`, { fallback: "" });
        if (hasBinary) {
          installed = true;
        } else if (isMacOS && dep.binary === "osx-cpu-temp") {
          const homebin = await runCmd(`test -x ${home}/bin/osx-cpu-temp && echo ok`, {
            fallback: ""
          });
          if (homebin) installed = true;
        }
        const installCmd = dep.install[pkgManager] || null;
        results.push({
          id: dep.id,
          name: dep.name,
          purpose: dep.purpose,
          affects: dep.affects,
          installed,
          installCmd,
          url: dep.url || null
        });
      }
      cachedDeps = results;
      const missing = results.filter((d) => !d.installed);
      if (missing.length > 0) {
        console.log("[Startup] Optional dependencies for enhanced vitals:");
        for (const dep of missing) {
          const action = dep.installCmd || dep.url || "see docs";
          console.log(`   \u{1F4A1} ${dep.name} \u2014 ${dep.purpose}: ${action}`);
        }
      }
      return results;
    }
    function getOptionalDeps2() {
      return cachedDeps;
    }
    module2.exports = {
      refreshVitalsAsync,
      getSystemVitals: getSystemVitals2,
      checkOptionalDeps: checkOptionalDeps2,
      getOptionalDeps: getOptionalDeps2,
      VITALS_CACHE_TTL
    };
  }
});

// src/auth.js
var require_auth = __commonJS({
  "src/auth.js"(exports2, module2) {
    var AUTH_HEADERS = {
      tailscale: {
        login: "tailscale-user-login",
        name: "tailscale-user-name",
        pic: "tailscale-user-profile-pic"
      },
      cloudflare: {
        email: "cf-access-authenticated-user-email"
      }
    };
    function checkAuth2(req, authConfig) {
      const mode = authConfig.mode;
      const remoteAddr = req.socket?.remoteAddress || "";
      const isLocalhost = remoteAddr === "127.0.0.1" || remoteAddr === "::1" || remoteAddr === "::ffff:127.0.0.1";
      if (isLocalhost) {
        return { authorized: true, user: { type: "localhost", login: "localhost" } };
      }
      if (mode === "none") {
        return { authorized: true, user: null };
      }
      if (mode === "token") {
        const authHeader = req.headers["authorization"] || "";
        const token = authHeader.replace(/^Bearer\s+/i, "");
        if (token && token === authConfig.token) {
          return { authorized: true, user: { type: "token" } };
        }
        return { authorized: false, reason: "Invalid or missing token" };
      }
      if (mode === "tailscale") {
        const login = (req.headers[AUTH_HEADERS.tailscale.login] || "").toLowerCase();
        const name = req.headers[AUTH_HEADERS.tailscale.name] || "";
        const pic = req.headers[AUTH_HEADERS.tailscale.pic] || "";
        if (!login) {
          return { authorized: false, reason: "Not accessed via Tailscale Serve" };
        }
        const isAllowed = authConfig.allowedUsers.some((allowed) => {
          if (allowed === "*") return true;
          if (allowed === login) return true;
          if (allowed.startsWith("*@")) {
            const domain = allowed.slice(2);
            return login.endsWith("@" + domain);
          }
          return false;
        });
        if (isAllowed) {
          return { authorized: true, user: { type: "tailscale", login, name, pic } };
        }
        return { authorized: false, reason: `User ${login} not in allowlist`, user: { login } };
      }
      if (mode === "cloudflare") {
        const email = (req.headers[AUTH_HEADERS.cloudflare.email] || "").toLowerCase();
        if (!email) {
          return { authorized: false, reason: "Not accessed via Cloudflare Access" };
        }
        const isAllowed = authConfig.allowedUsers.some((allowed) => {
          if (allowed === "*") return true;
          if (allowed === email) return true;
          if (allowed.startsWith("*@")) {
            const domain = allowed.slice(2);
            return email.endsWith("@" + domain);
          }
          return false;
        });
        if (isAllowed) {
          return { authorized: true, user: { type: "cloudflare", email } };
        }
        return { authorized: false, reason: `User ${email} not in allowlist`, user: { email } };
      }
      if (mode === "allowlist") {
        const clientIP = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "";
        const isAllowed = authConfig.allowedIPs.some((allowed) => {
          if (allowed === clientIP) return true;
          if (allowed.endsWith("/24")) {
            const prefix = allowed.slice(0, -3).split(".").slice(0, 3).join(".");
            return clientIP.startsWith(prefix + ".");
          }
          return false;
        });
        if (isAllowed) {
          return { authorized: true, user: { type: "ip", ip: clientIP } };
        }
        return { authorized: false, reason: `IP ${clientIP} not in allowlist` };
      }
      return { authorized: false, reason: "Unknown auth mode" };
    }
    function getUnauthorizedPage2(reason, user, authConfig) {
      const userInfo = user ? `<p class="user-info">Detected: ${user.login || user.email || user.ip || "unknown"}</p>` : "";
      return `<!DOCTYPE html>
<html>
<head>
    <title>Access Denied - OpenFleetControl</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #e8e8e8;
        }
        .container {
            text-align: center;
            padding: 3rem;
            background: rgba(255,255,255,0.05);
            border-radius: 16px;
            border: 1px solid rgba(255,255,255,0.1);
            max-width: 500px;
        }
        .icon { font-size: 4rem; margin-bottom: 1rem; }
        h1 { font-size: 1.8rem; margin-bottom: 1rem; color: #ff6b6b; }
        .reason { color: #aaa; margin-bottom: 1.5rem; font-size: 0.95rem; }
        .user-info { color: #ffeb3b; margin: 1rem 0; font-size: 0.9rem; }
        .instructions { color: #ccc; font-size: 0.85rem; line-height: 1.5; }
        .auth-mode { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid rgba(255,255,255,0.1); color: #888; font-size: 0.75rem; }
        code { background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">\u{1F510}</div>
        <h1>Access Denied</h1>
        <div class="reason">${reason}</div>
        ${userInfo}
        <div class="instructions">
            <p>This dashboard requires authentication via <strong>${authConfig.mode}</strong>.</p>
            ${authConfig.mode === "tailscale" ? `<p style="margin-top:1rem">Make sure you're accessing via your Tailscale URL and your account is in the allowlist.</p>` : ""}
            ${authConfig.mode === "cloudflare" ? `<p style="margin-top:1rem">Make sure you're accessing via Cloudflare Access and your email is in the allowlist.</p>` : ""}
        </div>
        <div class="auth-mode">Auth mode: <code>${authConfig.mode}</code></div>
    </div>
</body>
</html>`;
    }
    module2.exports = { AUTH_HEADERS, checkAuth: checkAuth2, getUnauthorizedPage: getUnauthorizedPage2 };
  }
});

// src/privacy.js
var require_privacy = __commonJS({
  "src/privacy.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    function getPrivacyFilePath(dataDir) {
      return path2.join(dataDir, "privacy-settings.json");
    }
    function loadPrivacySettings2(dataDir) {
      try {
        const privacyFile = getPrivacyFilePath(dataDir);
        if (fs2.existsSync(privacyFile)) {
          return JSON.parse(fs2.readFileSync(privacyFile, "utf8"));
        }
      } catch (e) {
        console.error("Failed to load privacy settings:", e.message);
      }
      return {
        version: 1,
        hiddenTopics: [],
        hiddenSessions: [],
        hiddenCrons: [],
        hideHostname: false,
        updatedAt: null
      };
    }
    function savePrivacySettings2(dataDir, data) {
      try {
        if (!fs2.existsSync(dataDir)) {
          fs2.mkdirSync(dataDir, { recursive: true });
        }
        data.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        fs2.writeFileSync(getPrivacyFilePath(dataDir), JSON.stringify(data, null, 2));
        return true;
      } catch (e) {
        console.error("Failed to save privacy settings:", e.message);
        return false;
      }
    }
    module2.exports = {
      loadPrivacySettings: loadPrivacySettings2,
      savePrivacySettings: savePrivacySettings2
    };
  }
});

// src/operators.js
var require_operators = __commonJS({
  "src/operators.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    function loadOperators2(dataDir) {
      const operatorsFile = path2.join(dataDir, "operators.json");
      try {
        if (fs2.existsSync(operatorsFile)) {
          return JSON.parse(fs2.readFileSync(operatorsFile, "utf8"));
        }
      } catch (e) {
        console.error("Failed to load operators:", e.message);
      }
      return { version: 1, operators: [], roles: {} };
    }
    function saveOperators2(dataDir, data) {
      try {
        if (!fs2.existsSync(dataDir)) {
          fs2.mkdirSync(dataDir, { recursive: true });
        }
        const operatorsFile = path2.join(dataDir, "operators.json");
        fs2.writeFileSync(operatorsFile, JSON.stringify(data, null, 2));
        return true;
      } catch (e) {
        console.error("Failed to save operators:", e.message);
        return false;
      }
    }
    function getOperatorBySlackId2(dataDir, slackId) {
      const data = loadOperators2(dataDir);
      return data.operators.find((op) => op.id === slackId || op.metadata?.slackId === slackId);
    }
    var operatorsRefreshing = false;
    async function refreshOperatorsAsync(dataDir, getOpenClawDir2) {
      if (operatorsRefreshing) return;
      operatorsRefreshing = true;
      const toMs = (ts, fallback) => {
        if (typeof ts === "number" && Number.isFinite(ts)) return ts;
        if (typeof ts === "string") {
          const parsed = Date.parse(ts);
          if (Number.isFinite(parsed)) return parsed;
        }
        return fallback;
      };
      try {
        const openclawDir = getOpenClawDir2();
        const sessionsDir = path2.join(openclawDir, "agents", "main", "sessions");
        if (!fs2.existsSync(sessionsDir)) {
          operatorsRefreshing = false;
          return;
        }
        const files = fs2.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
        const operatorsMap = /* @__PURE__ */ new Map();
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1e3;
        for (const file of files) {
          const filePath = path2.join(sessionsDir, file);
          try {
            const stat = fs2.statSync(filePath);
            if (stat.mtimeMs < sevenDaysAgo) continue;
            const fd = fs2.openSync(filePath, "r");
            const buffer = Buffer.alloc(10240);
            const bytesRead = fs2.readSync(fd, buffer, 0, 10240, 0);
            fs2.closeSync(fd);
            const content = buffer.toString("utf8", 0, bytesRead);
            const lines = content.split("\n").slice(0, 20);
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const entry = JSON.parse(line);
                if (entry.type !== "message" || !entry.message) continue;
                const msg = entry.message;
                if (msg.role !== "user") continue;
                let text = "";
                if (typeof msg.content === "string") {
                  text = msg.content;
                } else if (Array.isArray(msg.content)) {
                  const textPart = msg.content.find((c) => c.type === "text");
                  if (textPart) text = textPart.text || "";
                }
                if (!text) continue;
                const slackMatch = text.match(/\[Slack[^\]]*\]\s*([\w.-]+)\s*\(([A-Z0-9]+)\):/);
                if (slackMatch) {
                  const username = slackMatch[1];
                  const userId = slackMatch[2];
                  if (!operatorsMap.has(userId)) {
                    operatorsMap.set(userId, {
                      id: userId,
                      name: username,
                      username,
                      source: "slack",
                      firstSeen: toMs(entry.timestamp, stat.mtimeMs),
                      lastSeen: toMs(entry.timestamp, stat.mtimeMs),
                      sessionCount: 1
                    });
                  } else {
                    const op = operatorsMap.get(userId);
                    op.lastSeen = Math.max(op.lastSeen, toMs(entry.timestamp, stat.mtimeMs));
                    op.sessionCount++;
                  }
                  break;
                }
                const telegramMatch = text.match(/\[Telegram[^\]]*\]\s*([\w.-]+):/);
                if (telegramMatch) {
                  const username = telegramMatch[1];
                  const operatorId = `telegram:${username}`;
                  if (!operatorsMap.has(operatorId)) {
                    operatorsMap.set(operatorId, {
                      id: operatorId,
                      name: username,
                      username,
                      source: "telegram",
                      firstSeen: toMs(entry.timestamp, stat.mtimeMs),
                      lastSeen: toMs(entry.timestamp, stat.mtimeMs),
                      sessionCount: 1
                    });
                  } else {
                    const op = operatorsMap.get(operatorId);
                    op.lastSeen = Math.max(op.lastSeen, toMs(entry.timestamp, stat.mtimeMs));
                    op.sessionCount++;
                  }
                  break;
                }
                const discordSenderMatch = text.match(/"sender":\s*"(\d+)"/);
                const discordLabelMatch = text.match(/"label":\s*"([^"]+)"/);
                const discordUsernameMatch = text.match(/"username":\s*"([^"]+)"/);
                if (discordSenderMatch) {
                  const userId = discordSenderMatch[1];
                  const label = discordLabelMatch ? discordLabelMatch[1] : userId;
                  const username = discordUsernameMatch ? discordUsernameMatch[1] : label;
                  const opId = `discord:${userId}`;
                  if (!operatorsMap.has(opId)) {
                    operatorsMap.set(opId, {
                      id: opId,
                      discordId: userId,
                      name: label,
                      username,
                      source: "discord",
                      firstSeen: toMs(entry.timestamp, stat.mtimeMs),
                      lastSeen: toMs(entry.timestamp, stat.mtimeMs),
                      sessionCount: 1
                    });
                  } else {
                    const op = operatorsMap.get(opId);
                    op.lastSeen = Math.max(op.lastSeen, toMs(entry.timestamp, stat.mtimeMs));
                    op.sessionCount++;
                  }
                  break;
                }
              } catch (e) {
              }
            }
          } catch (e) {
          }
        }
        const existing = loadOperators2(dataDir);
        const existingMap = new Map(existing.operators.map((op) => [op.id, op]));
        for (const [id, autoOp] of operatorsMap) {
          if (existingMap.has(id)) {
            const manual = existingMap.get(id);
            manual.lastSeen = Math.max(manual.lastSeen || 0, autoOp.lastSeen);
            manual.sessionCount = (manual.sessionCount || 0) + autoOp.sessionCount;
          } else {
            existingMap.set(id, autoOp);
          }
        }
        const merged = {
          version: 1,
          operators: Array.from(existingMap.values()).sort(
            (a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)
          ),
          roles: existing.roles || {},
          lastRefreshed: Date.now()
        };
        saveOperators2(dataDir, merged);
        console.log(`[Operators] Refreshed: ${merged.operators.length} operators detected`);
      } catch (e) {
        console.error("[Operators] Refresh failed:", e.message);
      }
      operatorsRefreshing = false;
    }
    function startOperatorsRefresh2(dataDir, getOpenClawDir2) {
      setTimeout(() => refreshOperatorsAsync(dataDir, getOpenClawDir2), 2e3);
      setInterval(() => refreshOperatorsAsync(dataDir, getOpenClawDir2), 5 * 60 * 1e3);
    }
    function calculateOperatorStats2(operatorData, allSessions) {
      const operatorsWithStats = operatorData.operators.map((op) => {
        const userSessions = allSessions.filter((s) => {
          const userId = s.originator?.userId;
          if (!userId) return false;
          return userId === op.id || userId === op.metadata?.slackId;
        });
        return {
          ...op,
          stats: {
            activeSessions: userSessions.filter((s) => s.active).length,
            totalSessions: userSessions.length,
            lastSeen: userSessions.length > 0 ? new Date(
              Date.now() - Math.min(...userSessions.map((s) => s.minutesAgo)) * 6e4
            ).toISOString() : op.lastSeen
          }
        };
      });
      return { ...operatorData, operators: operatorsWithStats };
    }
    module2.exports = {
      loadOperators: loadOperators2,
      saveOperators: saveOperators2,
      getOperatorBySlackId: getOperatorBySlackId2,
      refreshOperatorsAsync,
      startOperatorsRefresh: startOperatorsRefresh2,
      calculateOperatorStats: calculateOperatorStats2
    };
  }
});

// src/topics.js
var require_topics = __commonJS({
  "src/topics.js"(exports2, module2) {
    var TOPIC_PATTERNS = {
      dashboard: ["dashboard", "command center", "ui", "interface", "status page"],
      scheduling: ["cron", "schedule", "timer", "reminder", "alarm", "periodic", "interval"],
      heartbeat: [
        "heartbeat",
        "heartbeat_ok",
        "poll",
        "health check",
        "ping",
        "keepalive",
        "monitoring"
      ],
      memory: ["memory", "remember", "recall", "notes", "journal", "log", "context"],
      Slack: ["slack", "channel", "#cc-", "thread", "mention", "dm", "workspace"],
      email: ["email", "mail", "inbox", "gmail", "send email", "unread", "compose"],
      calendar: ["calendar", "event", "meeting", "appointment", "schedule", "gcal"],
      coding: [
        "code",
        "script",
        "function",
        "debug",
        "error",
        "bug",
        "implement",
        "refactor",
        "programming"
      ],
      git: [
        "git",
        "commit",
        "branch",
        "merge",
        "push",
        "pull",
        "repository",
        "pr",
        "pull request",
        "github"
      ],
      "file editing": ["file", "edit", "write", "read", "create", "delete", "modify", "save"],
      API: ["api", "endpoint", "request", "response", "webhook", "integration", "rest", "graphql"],
      research: ["search", "research", "lookup", "find", "investigate", "learn", "study"],
      browser: ["browser", "webpage", "website", "url", "click", "navigate", "screenshot", "web_fetch"],
      "Quip export": ["quip", "export", "document", "spreadsheet"],
      finance: ["finance", "investment", "stock", "money", "budget", "bank", "trading", "portfolio"],
      home: ["home", "automation", "lights", "thermostat", "smart home", "iot", "homekit"],
      health: ["health", "fitness", "workout", "exercise", "weight", "sleep", "nutrition"],
      travel: ["travel", "flight", "hotel", "trip", "vacation", "booking", "airport"],
      food: ["food", "recipe", "restaurant", "cooking", "meal", "order", "delivery"],
      subagent: ["subagent", "spawn", "sub-agent", "delegate", "worker", "parallel"],
      tools: ["tool", "exec", "shell", "command", "terminal", "bash", "run"]
    };
    function detectTopics(text) {
      if (!text) return [];
      const lowerText = text.toLowerCase();
      const scores = {};
      for (const [topic, keywords] of Object.entries(TOPIC_PATTERNS)) {
        let score = 0;
        for (const keyword of keywords) {
          if (keyword.length <= 3) {
            const regex = new RegExp(`\\b${keyword}\\b`, "i");
            if (regex.test(lowerText)) score++;
          } else if (lowerText.includes(keyword)) {
            score++;
          }
        }
        if (score > 0) {
          scores[topic] = score;
        }
      }
      if (Object.keys(scores).length === 0) return [];
      const bestScore = Math.max(...Object.values(scores));
      const threshold = Math.max(2, bestScore * 0.5);
      return Object.entries(scores).filter(([_, score]) => score >= threshold || score >= 1 && bestScore <= 2).sort((a, b) => b[1] - a[1]).map(([topic, _]) => topic);
    }
    module2.exports = { TOPIC_PATTERNS, detectTopics };
  }
});

// src/sessions.js
var require_sessions = __commonJS({
  "src/sessions.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var { detectTopics } = require_topics();
    var CHANNEL_MAP = {
      c0aax7y80np: "#cc-meta",
      c0ab9f8sdfe: "#cc-research",
      c0aan4rq7v5: "#cc-finance",
      c0abxulk1qq: "#cc-properties",
      c0ab5nz8mkl: "#cc-ai",
      c0aan38tzv5: "#cc-dev",
      c0ab7wwhqvc: "#cc-home",
      c0ab1pjhxef: "#cc-health",
      c0ab7txvcqd: "#cc-legal",
      c0aay2g3n3r: "#cc-social",
      c0aaxrw2wqp: "#cc-business",
      c0ab19f3lae: "#cc-random",
      c0ab0r74y33: "#cc-food",
      c0ab0qrq3r9: "#cc-travel",
      c0ab0sbqqlg: "#cc-family",
      c0ab0slqdba: "#cc-games",
      c0ab1ps7ef2: "#cc-music",
      c0absbnrsbe: "#cc-dashboard"
    };
    function parseSessionLabel(key) {
      const parts = key.split(":");
      if (parts.includes("slack")) {
        const channelIdx = parts.indexOf("channel");
        if (channelIdx >= 0 && parts[channelIdx + 1]) {
          const channelId = parts[channelIdx + 1].toLowerCase();
          const channelName = CHANNEL_MAP[channelId] || `#${channelId}`;
          if (parts.includes("thread")) {
            const threadTs = parts[parts.indexOf("thread") + 1];
            const ts = parseFloat(threadTs);
            const date = new Date(ts * 1e3);
            const timeStr = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
            return `${channelName} thread @ ${timeStr}`;
          }
          return channelName;
        }
      }
      if (key.includes("telegram")) {
        return "\u{1F4F1} Telegram";
      }
      if (key === "agent:main:main") {
        return "\u{1F3E0} Main Session";
      }
      return key.length > 40 ? key.slice(0, 37) + "..." : key;
    }
    function createSessionsModule2(deps) {
      const { getOpenClawDir: getOpenClawDir2, getOperatorBySlackId: getOperatorBySlackId2, runOpenClaw: runOpenClaw2, runOpenClawAsync: runOpenClawAsync2, extractJSON: extractJSON2 } = deps;
      let sessionsCache = { sessions: [], timestamp: 0, refreshing: false };
      const SESSIONS_CACHE_TTL = 1e4;
      function findTranscriptPath(sessionId) {
        if (!sessionId) return null;
        const openclawDir = getOpenClawDir2();
        const sessionsDir = path2.join(openclawDir, "agents", "main", "sessions");
        const exactPath = path2.join(sessionsDir, `${sessionId}.jsonl`);
        if (fs2.existsSync(exactPath)) return exactPath;
        try {
          const files = fs2.readdirSync(sessionsDir);
          const prefix = `${sessionId}-`;
          const match = files.find(
            (f) => f.startsWith(prefix) && f.endsWith(".jsonl") && !f.includes(".deleted.")
          );
          if (match) return path2.join(sessionsDir, match);
        } catch (e) {
        }
        return null;
      }
      function getSessionOriginator(sessionId) {
        try {
          if (!sessionId) return null;
          const transcriptPath = findTranscriptPath(sessionId);
          if (!transcriptPath) return null;
          const content = fs2.readFileSync(transcriptPath, "utf8");
          const lines = content.trim().split("\n");
          for (let i = 0; i < Math.min(lines.length, 10); i++) {
            try {
              const entry = JSON.parse(lines[i]);
              if (entry.type !== "message" || !entry.message) continue;
              const msg = entry.message;
              if (msg.role !== "user") continue;
              let text = "";
              if (typeof msg.content === "string") {
                text = msg.content;
              } else if (Array.isArray(msg.content)) {
                const textPart = msg.content.find((c) => c.type === "text");
                if (textPart) text = textPart.text || "";
              }
              if (!text) continue;
              const slackUserMatch = text.match(/\]\s*([\w.-]+)\s*\(([A-Z0-9]+)\):/);
              if (slackUserMatch) {
                const username = slackUserMatch[1];
                const userId = slackUserMatch[2];
                const operator = getOperatorBySlackId2(userId);
                return {
                  userId,
                  username,
                  displayName: operator?.name || username,
                  role: operator?.role || "user",
                  avatar: operator?.avatar || null
                };
              }
              const senderIdMatch = text.match(/"sender_id":\s*"([A-Z0-9]+)"/);
              const senderMatch = text.match(/"sender":\s*"([^"]+)"/);
              if (senderIdMatch) {
                const userId = senderIdMatch[1];
                const username = senderMatch ? senderMatch[1] : userId;
                const operator = getOperatorBySlackId2(userId);
                return {
                  userId,
                  username,
                  displayName: operator?.name || username,
                  role: operator?.role || "user",
                  avatar: operator?.avatar || null
                };
              }
            } catch (e) {
            }
          }
          return null;
        } catch (e) {
          return null;
        }
      }
      function getSessionTopic(sessionId) {
        if (!sessionId) return null;
        try {
          const transcriptPath = findTranscriptPath(sessionId);
          if (!transcriptPath) return null;
          const fd = fs2.openSync(transcriptPath, "r");
          const buffer = Buffer.alloc(5e4);
          const bytesRead = fs2.readSync(fd, buffer, 0, 5e4, 0);
          fs2.closeSync(fd);
          if (bytesRead === 0) return null;
          const content = buffer.toString("utf8", 0, bytesRead);
          const lines = content.split("\n").filter((l) => l.trim());
          let textSamples = [];
          for (const line of lines.slice(0, 30)) {
            try {
              const entry = JSON.parse(line);
              if (entry.type === "message" && entry.message?.content) {
                const msgContent = entry.message.content;
                if (Array.isArray(msgContent)) {
                  msgContent.forEach((c) => {
                    if (c.type === "text" && c.text) {
                      textSamples.push(c.text.slice(0, 500));
                    }
                  });
                } else if (typeof msgContent === "string") {
                  textSamples.push(msgContent.slice(0, 500));
                }
              }
            } catch (e) {
            }
          }
          if (textSamples.length === 0) return null;
          const topics = detectTopics(textSamples.join(" "));
          return topics.length > 0 ? topics.slice(0, 2).join(", ") : null;
        } catch (e) {
          return null;
        }
      }
      function mapSession(s) {
        const minutesAgo = s.ageMs ? s.ageMs / 6e4 : Infinity;
        let channel = "other";
        if (s.key.includes("slack")) channel = "slack";
        else if (s.key.includes("telegram")) channel = "telegram";
        else if (s.key.includes("discord")) channel = "discord";
        else if (s.key.includes("signal")) channel = "signal";
        else if (s.key.includes("whatsapp")) channel = "whatsapp";
        let sessionType = "channel";
        if (s.key.includes(":subagent:")) sessionType = "subagent";
        else if (s.key.includes(":cron:")) sessionType = "cron";
        else if (s.key === "agent:main:main") sessionType = "main";
        const originator = getSessionOriginator(s.sessionId);
        const label = s.groupChannel || s.displayName || parseSessionLabel(s.key);
        const topic = getSessionTopic(s.sessionId);
        const totalTokens = s.totalTokens || 0;
        const sessionAgeMinutes = Math.max(1, Math.min(minutesAgo, 24 * 60));
        const burnRate = Math.round(totalTokens / sessionAgeMinutes);
        return {
          sessionKey: s.key,
          sessionId: s.sessionId,
          label,
          groupChannel: s.groupChannel || null,
          displayName: s.displayName || null,
          kind: s.kind,
          channel,
          sessionType,
          active: minutesAgo < 15,
          recentlyActive: minutesAgo < 60,
          minutesAgo: Math.round(minutesAgo),
          tokens: s.totalTokens || 0,
          model: s.model,
          originator,
          topic,
          metrics: {
            burnRate,
            toolCalls: 0,
            minutesActive: Math.max(1, Math.min(Math.round(minutesAgo), 24 * 60))
          }
        };
      }
      async function refreshSessionsCache() {
        if (sessionsCache.refreshing) return;
        sessionsCache.refreshing = true;
        try {
          const output = await runOpenClawAsync2("sessions --json 2>/dev/null");
          const jsonStr = extractJSON2(output);
          if (jsonStr) {
            const data = JSON.parse(jsonStr);
            const sessions2 = data.sessions || [];
            const mapped = sessions2.map((s) => mapSession(s));
            const withOriginator = mapped.filter((s) => s.originator != null);
            sessionsCache = {
              sessions: mapped,
              timestamp: Date.now(),
              refreshing: false
            };
            console.log(
              `[Sessions Cache] Refreshed: ${mapped.length} sessions (${withOriginator.length} with originator)`
            );
          }
        } catch (e) {
          console.error("[Sessions Cache] Refresh error:", e.message);
        }
        sessionsCache.refreshing = false;
      }
      function getSessionsCached() {
        const now = Date.now();
        const isStale = now - sessionsCache.timestamp > SESSIONS_CACHE_TTL;
        if (isStale && !sessionsCache.refreshing) {
          refreshSessionsCache();
        }
        return sessionsCache.sessions;
      }
      function getSessions(options = {}) {
        const limit = Object.prototype.hasOwnProperty.call(options, "limit") ? options.limit : 20;
        const returnCount = options.returnCount || false;
        if (limit === null) {
          const cached = getSessionsCached();
          const totalCount = cached.length;
          return returnCount ? { sessions: cached, totalCount } : cached;
        }
        try {
          const output = runOpenClaw2("sessions --json 2>/dev/null");
          const jsonStr = extractJSON2(output);
          if (jsonStr) {
            const data = JSON.parse(jsonStr);
            const totalCount = data.count || data.sessions?.length || 0;
            let sessions2 = data.sessions || [];
            if (limit != null) {
              sessions2 = sessions2.slice(0, limit);
            }
            const mapped = sessions2.map((s) => mapSession(s));
            return returnCount ? { sessions: mapped, totalCount } : mapped;
          }
        } catch (e) {
          console.error("Failed to get sessions:", e.message);
        }
        return returnCount ? { sessions: [], totalCount: 0 } : [];
      }
      function readTranscript(sessionId) {
        const transcriptPath = findTranscriptPath(sessionId);
        try {
          if (!transcriptPath) return [];
          const content = fs2.readFileSync(transcriptPath, "utf8");
          return content.trim().split("\n").map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          }).filter(Boolean);
        } catch (e) {
          console.error("Failed to read transcript:", e.message);
          return [];
        }
      }
      function getSessionDetail(sessionKey) {
        try {
          const listOutput = runOpenClaw2("sessions --json 2>/dev/null");
          let sessionInfo = null;
          const jsonStr = extractJSON2(listOutput);
          if (jsonStr) {
            const data = JSON.parse(jsonStr);
            sessionInfo = data.sessions?.find((s) => s.key === sessionKey);
          }
          if (!sessionInfo) {
            return { error: "Session not found" };
          }
          const transcript = readTranscript(sessionInfo.sessionId);
          let messages = [];
          let tools = {};
          let facts = [];
          let needsAttention = [];
          let totalInputTokens = 0;
          let totalOutputTokens = 0;
          let totalCacheRead = 0;
          let totalCacheWrite = 0;
          let totalCost = 0;
          let detectedModel = sessionInfo.model || null;
          transcript.forEach((entry) => {
            if (entry.type !== "message" || !entry.message) return;
            const msg = entry.message;
            if (!msg.role) return;
            if (msg.usage) {
              totalInputTokens += msg.usage.input || msg.usage.inputTokens || 0;
              totalOutputTokens += msg.usage.output || msg.usage.outputTokens || 0;
              totalCacheRead += msg.usage.cacheRead || msg.usage.cacheReadTokens || 0;
              totalCacheWrite += msg.usage.cacheWrite || msg.usage.cacheWriteTokens || 0;
              if (msg.usage.cost?.total) totalCost += msg.usage.cost.total;
            }
            if (msg.role === "assistant" && msg.model && !detectedModel) {
              detectedModel = msg.model;
            }
            let text = "";
            if (typeof msg.content === "string") {
              text = msg.content;
            } else if (Array.isArray(msg.content)) {
              const textPart = msg.content.find((c) => c.type === "text");
              if (textPart) text = textPart.text || "";
              msg.content.filter((c) => c.type === "toolCall" || c.type === "tool_use").forEach((tc) => {
                const name = tc.name || tc.tool || "unknown";
                tools[name] = (tools[name] || 0) + 1;
              });
            }
            if (text && msg.role !== "toolResult") {
              messages.push({ role: msg.role, text, timestamp: entry.timestamp });
            }
            if (msg.role === "user" && text) {
              const lowerText = text.toLowerCase();
              if (text.includes("?")) {
                const questions = text.match(/[^.!?\n]*\?/g) || [];
                questions.slice(0, 2).forEach((q) => {
                  if (q.length > 15 && q.length < 200) {
                    needsAttention.push(`\u2753 ${q.trim()}`);
                  }
                });
              }
              if (lowerText.includes("todo") || lowerText.includes("remind") || lowerText.includes("need to")) {
                const match = text.match(/(?:todo|remind|need to)[^.!?\n]*/i);
                if (match) needsAttention.push(`\u{1F4CB} ${match[0].slice(0, 100)}`);
              }
            }
            if (msg.role === "assistant" && text) {
              const lowerText = text.toLowerCase();
              ["\u2705", "done", "created", "updated", "fixed", "deployed"].forEach((keyword) => {
                if (lowerText.includes(keyword)) {
                  const lines = text.split("\n").filter((l) => l.toLowerCase().includes(keyword));
                  lines.slice(0, 2).forEach((line) => {
                    if (line.length > 5 && line.length < 150) {
                      facts.push(line.trim().slice(0, 100));
                    }
                  });
                }
              });
            }
          });
          let summary = "No activity yet.";
          const userMessages = messages.filter((m) => m.role === "user");
          const assistantMessages = messages.filter((m) => m.role === "assistant");
          let topics = [];
          if (messages.length > 0) {
            summary = `${messages.length} messages (${userMessages.length} user, ${assistantMessages.length} assistant). `;
            const allText = messages.map((m) => m.text).join(" ");
            topics = detectTopics(allText);
            if (topics.length > 0) {
              summary += `Topics: ${topics.join(", ")}.`;
            }
          }
          const toolsArray = Object.entries(tools).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
          const ageMs = sessionInfo.ageMs || 0;
          const lastActive = ageMs < 6e4 ? "Just now" : ageMs < 36e5 ? `${Math.round(ageMs / 6e4)} minutes ago` : ageMs < 864e5 ? `${Math.round(ageMs / 36e5)} hours ago` : `${Math.round(ageMs / 864e5)} days ago`;
          let channelDisplay = "Other";
          if (sessionInfo.groupChannel) {
            channelDisplay = sessionInfo.groupChannel;
          } else if (sessionInfo.displayName) {
            channelDisplay = sessionInfo.displayName;
          } else if (sessionKey.includes("slack")) {
            const parts = sessionKey.split(":");
            const channelIdx = parts.indexOf("channel");
            if (channelIdx >= 0 && parts[channelIdx + 1]) {
              const channelId = parts[channelIdx + 1].toLowerCase();
              channelDisplay = CHANNEL_MAP[channelId] || `#${channelId}`;
            } else {
              channelDisplay = "Slack";
            }
          } else if (sessionKey.includes("telegram")) {
            channelDisplay = "Telegram";
          }
          const finalTotalTokens = totalInputTokens + totalOutputTokens || sessionInfo.totalTokens || 0;
          const finalInputTokens = totalInputTokens || sessionInfo.inputTokens || 0;
          const finalOutputTokens = totalOutputTokens || sessionInfo.outputTokens || 0;
          const modelDisplay = (detectedModel || sessionInfo.model || "-").replace("anthropic/", "").replace("openai/", "");
          return {
            key: sessionKey,
            kind: sessionInfo.kind,
            channel: channelDisplay,
            groupChannel: sessionInfo.groupChannel || channelDisplay,
            model: modelDisplay,
            tokens: finalTotalTokens,
            inputTokens: finalInputTokens,
            outputTokens: finalOutputTokens,
            cacheRead: totalCacheRead,
            cacheWrite: totalCacheWrite,
            estCost: totalCost > 0 ? `$${totalCost.toFixed(4)}` : null,
            lastActive,
            summary,
            topics,
            // Array of detected topics
            facts: [...new Set(facts)].slice(0, 8),
            needsAttention: [...new Set(needsAttention)].slice(0, 5),
            tools: toolsArray.slice(0, 10),
            messages: messages.slice(-15).reverse().map((m) => ({
              role: m.role,
              text: m.text.slice(0, 500)
            }))
          };
        } catch (e) {
          console.error("Failed to get session detail:", e.message);
          return { error: e.message };
        }
      }
      return {
        findTranscriptPath,
        getSessionOriginator,
        getSessionTopic,
        mapSession,
        refreshSessionsCache,
        getSessionsCached,
        getSessions,
        readTranscript,
        getSessionDetail,
        parseSessionLabel
      };
    }
    module2.exports = { createSessionsModule: createSessionsModule2, CHANNEL_MAP };
  }
});

// src/cron.js
var require_cron = __commonJS({
  "src/cron.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    function cronToHuman(expr) {
      if (!expr || expr === "\u2014") return null;
      const parts = expr.split(" ");
      if (parts.length < 5) return null;
      const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
      const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      function formatTime(h, m) {
        const hNum = parseInt(h, 10);
        const mNum = parseInt(m, 10);
        if (isNaN(hNum)) return null;
        const ampm = hNum >= 12 ? "pm" : "am";
        const h12 = hNum === 0 ? 12 : hNum > 12 ? hNum - 12 : hNum;
        return mNum === 0 ? `${h12}${ampm}` : `${h12}:${mNum.toString().padStart(2, "0")}${ampm}`;
      }
      if (minute === "*" && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
        return "Every minute";
      }
      if (minute.startsWith("*/")) {
        const interval = minute.slice(2);
        return `Every ${interval} minutes`;
      }
      if (hour.startsWith("*/")) {
        const interval = hour.slice(2);
        const minStr = minute === "0" ? "" : `:${minute.padStart(2, "0")}`;
        return `Every ${interval} hours${minStr ? " at " + minStr : ""}`;
      }
      if (minute !== "*" && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
        return `Hourly at :${minute.padStart(2, "0")}`;
      }
      let timeStr = "";
      if (minute !== "*" && hour !== "*" && !hour.startsWith("*/")) {
        timeStr = formatTime(hour, minute);
      }
      if (timeStr && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
        return `Daily at ${timeStr}`;
      }
      if ((dayOfWeek === "1-5" || dayOfWeek === "MON-FRI") && dayOfMonth === "*" && month === "*") {
        return timeStr ? `Weekdays at ${timeStr}` : "Weekdays";
      }
      if ((dayOfWeek === "0,6" || dayOfWeek === "6,0") && dayOfMonth === "*" && month === "*") {
        return timeStr ? `Weekends at ${timeStr}` : "Weekends";
      }
      if (dayOfMonth === "*" && month === "*" && dayOfWeek !== "*") {
        const days = dayOfWeek.split(",").map((d) => {
          const num = parseInt(d, 10);
          return dayNames[num] || d;
        });
        const dayStr = days.length === 1 ? days[0] : days.join(", ");
        return timeStr ? `${dayStr} at ${timeStr}` : `Every ${dayStr}`;
      }
      if (dayOfMonth !== "*" && month === "*" && dayOfWeek === "*") {
        const day = parseInt(dayOfMonth, 10);
        const suffix = day === 1 || day === 21 || day === 31 ? "st" : day === 2 || day === 22 ? "nd" : day === 3 || day === 23 ? "rd" : "th";
        return timeStr ? `${day}${suffix} of month at ${timeStr}` : `${day}${suffix} of every month`;
      }
      if (timeStr) {
        return `At ${timeStr}`;
      }
      return expr;
    }
    function getCronJobs2(getOpenClawDir2) {
      try {
        const cronPath = path2.join(getOpenClawDir2(), "cron", "jobs.json");
        if (fs2.existsSync(cronPath)) {
          const data = JSON.parse(fs2.readFileSync(cronPath, "utf8"));
          return (data.jobs || []).map((j) => {
            let scheduleStr = "\u2014";
            let scheduleHuman = null;
            if (j.schedule) {
              if (j.schedule.kind === "cron" && j.schedule.expr) {
                scheduleStr = j.schedule.expr;
                scheduleHuman = cronToHuman(j.schedule.expr);
              } else if (j.schedule.kind === "once") {
                scheduleStr = "once";
                scheduleHuman = "One-time";
              }
            }
            let nextRunStr = "\u2014";
            if (j.state?.nextRunAtMs) {
              const next = new Date(j.state.nextRunAtMs);
              const now = /* @__PURE__ */ new Date();
              const diffMs = next - now;
              const diffMins = Math.round(diffMs / 6e4);
              if (diffMins < 0) {
                nextRunStr = "overdue";
              } else if (diffMins < 60) {
                nextRunStr = `${diffMins}m`;
              } else if (diffMins < 1440) {
                nextRunStr = `${Math.round(diffMins / 60)}h`;
              } else {
                nextRunStr = `${Math.round(diffMins / 1440)}d`;
              }
            }
            return {
              id: j.id,
              name: j.name || j.id.slice(0, 8),
              schedule: scheduleStr,
              scheduleHuman,
              nextRun: nextRunStr,
              enabled: j.enabled !== false,
              lastStatus: j.state?.lastStatus
            };
          });
        }
      } catch (e) {
        console.error("Failed to get cron:", e.message);
      }
      return [];
    }
    module2.exports = {
      cronToHuman,
      getCronJobs: getCronJobs2
    };
  }
});

// src/cerebro.js
var require_cerebro = __commonJS({
  "src/cerebro.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var { formatTimeAgo } = require_utils();
    function getCerebroTopics2(cerebroDir, options = {}) {
      const { offset = 0, limit = 20, status: filterStatus = "all" } = options;
      const topicsDir = path2.join(cerebroDir, "topics");
      const orphansDir = path2.join(cerebroDir, "orphans");
      const topics = [];
      const result = {
        initialized: false,
        cerebroPath: cerebroDir,
        topics: { active: 0, resolved: 0, parked: 0, total: 0 },
        threads: 0,
        orphans: 0,
        recentTopics: [],
        lastUpdated: null
      };
      try {
        if (!fs2.existsSync(cerebroDir)) {
          return result;
        }
        result.initialized = true;
        let latestModified = null;
        if (!fs2.existsSync(topicsDir)) {
          return result;
        }
        const topicNames = fs2.readdirSync(topicsDir).filter((name) => {
          const topicPath = path2.join(topicsDir, name);
          return fs2.statSync(topicPath).isDirectory() && !name.startsWith("_");
        });
        topicNames.forEach((name) => {
          const topicMdPath = path2.join(topicsDir, name, "topic.md");
          const topicDirPath = path2.join(topicsDir, name);
          let stat;
          let content = "";
          if (fs2.existsSync(topicMdPath)) {
            stat = fs2.statSync(topicMdPath);
            content = fs2.readFileSync(topicMdPath, "utf8");
          } else {
            stat = fs2.statSync(topicDirPath);
          }
          try {
            const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
            let title = name;
            let topicStatus = "active";
            let category = "general";
            let created = null;
            if (frontmatterMatch) {
              const frontmatter = frontmatterMatch[1];
              const titleMatch = frontmatter.match(/title:\s*(.+)/);
              const statusMatch = frontmatter.match(/status:\s*(.+)/);
              const categoryMatch = frontmatter.match(/category:\s*(.+)/);
              const createdMatch = frontmatter.match(/created:\s*(.+)/);
              if (titleMatch) title = titleMatch[1].trim();
              if (statusMatch) topicStatus = statusMatch[1].trim().toLowerCase();
              if (categoryMatch) category = categoryMatch[1].trim();
              if (createdMatch) created = createdMatch[1].trim();
            }
            const threadsDir = path2.join(topicsDir, name, "threads");
            let threadCount = 0;
            if (fs2.existsSync(threadsDir)) {
              threadCount = fs2.readdirSync(threadsDir).filter((f) => f.endsWith(".md") || f.endsWith(".json")).length;
            }
            result.threads += threadCount;
            if (topicStatus === "active") result.topics.active++;
            else if (topicStatus === "resolved") result.topics.resolved++;
            else if (topicStatus === "parked") result.topics.parked++;
            if (!latestModified || stat.mtime > latestModified) {
              latestModified = stat.mtime;
            }
            topics.push({
              name,
              title,
              status: topicStatus,
              category,
              created,
              threads: threadCount,
              lastModified: stat.mtimeMs
            });
          } catch (e) {
            console.error(`Failed to parse topic ${name}:`, e.message);
          }
        });
        result.topics.total = topics.length;
        const statusPriority = { active: 0, resolved: 1, parked: 2 };
        topics.sort((a, b) => {
          const statusDiff = (statusPriority[a.status] || 3) - (statusPriority[b.status] || 3);
          if (statusDiff !== 0) return statusDiff;
          return b.lastModified - a.lastModified;
        });
        let filtered = topics;
        if (filterStatus !== "all") {
          filtered = topics.filter((t) => t.status === filterStatus);
        }
        const paginated = filtered.slice(offset, offset + limit);
        result.recentTopics = paginated.map((t) => ({
          name: t.name,
          title: t.title,
          status: t.status,
          threads: t.threads,
          age: formatTimeAgo(new Date(t.lastModified))
        }));
        if (fs2.existsSync(orphansDir)) {
          try {
            result.orphans = fs2.readdirSync(orphansDir).filter((f) => f.endsWith(".md")).length;
          } catch (e) {
          }
        }
        result.lastUpdated = latestModified ? latestModified.toISOString() : null;
      } catch (e) {
        console.error("Failed to get Cerebro topics:", e.message);
      }
      return result;
    }
    function updateTopicStatus2(cerebroDir, topicId, newStatus) {
      const topicDir = path2.join(cerebroDir, "topics", topicId);
      const topicFile = path2.join(topicDir, "topic.md");
      if (!fs2.existsSync(topicDir)) {
        return { error: `Topic '${topicId}' not found`, code: 404 };
      }
      if (!fs2.existsSync(topicFile)) {
        const content2 = `---
title: ${topicId}
status: ${newStatus}
category: general
created: ${(/* @__PURE__ */ new Date()).toISOString().split("T")[0]}
---

# ${topicId}

## Overview
*Topic tracking file.*

## Notes
`;
        fs2.writeFileSync(topicFile, content2, "utf8");
        return {
          topic: {
            id: topicId,
            name: topicId,
            title: topicId,
            status: newStatus
          }
        };
      }
      let content = fs2.readFileSync(topicFile, "utf8");
      let title = topicId;
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (frontmatterMatch) {
        let frontmatter = frontmatterMatch[1];
        const titleMatch = frontmatter.match(/title:\s*["']?([^"'\n]+)["']?/i);
        if (titleMatch) title = titleMatch[1];
        if (frontmatter.includes("status:")) {
          frontmatter = frontmatter.replace(
            /status:\s*(active|resolved|parked)/i,
            `status: ${newStatus}`
          );
        } else {
          frontmatter = frontmatter.trim() + `
status: ${newStatus}`;
        }
        content = content.replace(/^---\n[\s\S]*?\n---/, `---
${frontmatter}
---`);
      } else {
        const headerMatch = content.match(/^#\s*(.+)/m);
        if (headerMatch) title = headerMatch[1];
        const frontmatter = `---
title: ${title}
status: ${newStatus}
category: general
created: ${(/* @__PURE__ */ new Date()).toISOString().split("T")[0]}
---

`;
        content = frontmatter + content;
      }
      fs2.writeFileSync(topicFile, content, "utf8");
      return {
        topic: {
          id: topicId,
          name: topicId,
          title,
          status: newStatus
        }
      };
    }
    module2.exports = {
      getCerebroTopics: getCerebroTopics2,
      updateTopicStatus: updateTopicStatus2
    };
  }
});

// src/tokens.js
var require_tokens = __commonJS({
  "src/tokens.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var { formatNumber, formatTokens } = require_utils();
    var TOKEN_RATES = {
      input: 15,
      // $15/1M input tokens
      output: 75,
      // $75/1M output tokens
      cacheRead: 1.5,
      // $1.50/1M (90% discount from input)
      cacheWrite: 18.75
      // $18.75/1M (25% premium on input)
    };
    var tokenUsageCache = { data: null, timestamp: 0, refreshing: false };
    var TOKEN_USAGE_CACHE_TTL = 3e4;
    var refreshInterval = null;
    function emptyUsageBucket() {
      return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0 };
    }
    function addUsageToBucket(bucket, usage) {
      bucket.input += usage.input || 0;
      bucket.output += usage.output || 0;
      bucket.cacheRead += usage.cacheRead || 0;
      bucket.cacheWrite += usage.cacheWrite || 0;
      bucket.cost += usage.cost?.total || 0;
      bucket.requests++;
    }
    function addUsageToModelMap(modelMap, model, usage) {
      const key = model || "unknown";
      if (!modelMap[key]) modelMap[key] = emptyUsageBucket();
      addUsageToBucket(modelMap[key], usage);
    }
    async function refreshTokenUsageAsync2(getOpenClawDir2) {
      if (tokenUsageCache.refreshing) return;
      tokenUsageCache.refreshing = true;
      try {
        const sessionsDir = path2.join(getOpenClawDir2(), "agents", "main", "sessions");
        const files = await fs2.promises.readdir(sessionsDir);
        const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
        const now = Date.now();
        const oneDayAgo = now - 24 * 60 * 60 * 1e3;
        const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1e3;
        const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1e3;
        const usage24h = emptyUsageBucket();
        const usage3d = emptyUsageBucket();
        const usage7d = emptyUsageBucket();
        const byModel24h = {};
        const byModel3d = {};
        const byModel7d = {};
        const batchSize = 50;
        for (let i = 0; i < jsonlFiles.length; i += batchSize) {
          const batch = jsonlFiles.slice(i, i + batchSize);
          await Promise.all(
            batch.map(async (file) => {
              const filePath = path2.join(sessionsDir, file);
              try {
                const stat = await fs2.promises.stat(filePath);
                if (stat.mtimeMs < sevenDaysAgo) return;
                const content = await fs2.promises.readFile(filePath, "utf8");
                const lines = content.trim().split("\n");
                for (const line of lines) {
                  if (!line) continue;
                  try {
                    const entry = JSON.parse(line);
                    const entryTime = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
                    if (entryTime < sevenDaysAgo) continue;
                    if (entry.message?.usage) {
                      const u = entry.message.usage;
                      const model = entry.message.model || "unknown";
                      if (entryTime >= oneDayAgo) {
                        addUsageToBucket(usage24h, u);
                        addUsageToModelMap(byModel24h, model, u);
                      }
                      if (entryTime >= threeDaysAgo) {
                        addUsageToBucket(usage3d, u);
                        addUsageToModelMap(byModel3d, model, u);
                      }
                      addUsageToBucket(usage7d, u);
                      addUsageToModelMap(byModel7d, model, u);
                    }
                  } catch (e) {
                  }
                }
              } catch (e) {
              }
            })
          );
          await new Promise((resolve) => setImmediate(resolve));
        }
        const finalizeBucket = (bucket, byModel) => ({
          ...bucket,
          tokensNoCache: bucket.input + bucket.output,
          tokensWithCache: bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite,
          ...byModel ? { byModel } : {}
        });
        const result = {
          // Primary (24h) for backward compatibility
          ...finalizeBucket(usage24h),
          // All three windows (with per-model breakdowns)
          windows: {
            "24h": finalizeBucket(usage24h, byModel24h),
            "3d": finalizeBucket(usage3d, byModel3d),
            "7d": finalizeBucket(usage7d, byModel7d)
          }
        };
        tokenUsageCache = { data: result, timestamp: Date.now(), refreshing: false };
        console.log(
          `[Token Usage] Cached: 24h=${usage24h.requests} 3d=${usage3d.requests} 7d=${usage7d.requests} requests`
        );
      } catch (e) {
        console.error("[Token Usage] Refresh error:", e.message);
        tokenUsageCache.refreshing = false;
      }
    }
    function getDailyTokenUsage2(getOpenClawDir2) {
      const now = Date.now();
      const isStale = now - tokenUsageCache.timestamp > TOKEN_USAGE_CACHE_TTL;
      if (isStale && !tokenUsageCache.refreshing && getOpenClawDir2) {
        refreshTokenUsageAsync2(getOpenClawDir2);
      }
      const emptyResult = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        requests: 0,
        tokensNoCache: 0,
        tokensWithCache: 0,
        windows: {
          "24h": {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            requests: 0,
            tokensNoCache: 0,
            tokensWithCache: 0
          },
          "3d": {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            requests: 0,
            tokensNoCache: 0,
            tokensWithCache: 0
          },
          "7d": {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            requests: 0,
            tokensNoCache: 0,
            tokensWithCache: 0
          }
        }
      };
      return tokenUsageCache.data || emptyResult;
    }
    function calculateCostForBucket(bucket, rates = TOKEN_RATES) {
      const inputCost = bucket.input / 1e6 * rates.input;
      const outputCost = bucket.output / 1e6 * rates.output;
      const cacheReadCost = bucket.cacheRead / 1e6 * rates.cacheRead;
      const cacheWriteCost = bucket.cacheWrite / 1e6 * rates.cacheWrite;
      return {
        inputCost,
        outputCost,
        cacheReadCost,
        cacheWriteCost,
        totalCost: inputCost + outputCost + cacheReadCost + cacheWriteCost
      };
    }
    function summarizeModelUsage(byModel = {}, rates = TOKEN_RATES) {
      return Object.entries(byModel).map(([model, bucket]) => {
        const estCost = calculateCostForBucket(bucket, rates).totalCost;
        const reportedCost = bucket.cost || 0;
        return {
          model,
          input: bucket.input,
          output: bucket.output,
          cacheRead: bucket.cacheRead,
          cacheWrite: bucket.cacheWrite,
          requests: bucket.requests,
          reportedCost,
          estCost,
          cost: reportedCost > 0 ? reportedCost : estCost
        };
      }).sort((a, b) => b.cost - a.cost);
    }
    function getCostBreakdown2(config, getSessions, getOpenClawDir2) {
      const usage = getDailyTokenUsage2(getOpenClawDir2);
      if (!usage) {
        return { error: "Failed to get usage data" };
      }
      const costs = calculateCostForBucket(usage);
      const planCost = config.billing?.claudePlanCost || 200;
      const planName = config.billing?.claudePlanName || "Claude Code Max";
      const windowConfigs = {
        "24h": { days: 1, label: "24h" },
        "3d": { days: 3, label: "3dma" },
        "7d": { days: 7, label: "7dma" }
      };
      const windows = {};
      for (const [key, windowConfig] of Object.entries(windowConfigs)) {
        const bucket = usage.windows?.[key] || usage;
        const bucketCosts = calculateCostForBucket(bucket);
        const dailyAvg = bucketCosts.totalCost / windowConfig.days;
        const monthlyProjected = dailyAvg * 30;
        const monthlySavings = monthlyProjected - planCost;
        windows[key] = {
          label: windowConfig.label,
          days: windowConfig.days,
          totalCost: bucketCosts.totalCost,
          dailyAvg,
          monthlyProjected,
          monthlySavings,
          savingsPercent: monthlySavings > 0 ? Math.round(monthlySavings / monthlyProjected * 100) : 0,
          requests: bucket.requests,
          tokens: {
            input: bucket.input,
            output: bucket.output,
            cacheRead: bucket.cacheRead,
            cacheWrite: bucket.cacheWrite
          },
          byModel: summarizeModelUsage(bucket.byModel)
        };
      }
      return {
        // Raw token counts (24h for backward compatibility)
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        requests: usage.requests,
        // Pricing rates
        rates: {
          input: TOKEN_RATES.input.toFixed(2),
          output: TOKEN_RATES.output.toFixed(2),
          cacheRead: TOKEN_RATES.cacheRead.toFixed(2),
          cacheWrite: TOKEN_RATES.cacheWrite.toFixed(2)
        },
        // Cost calculation breakdown (24h)
        calculation: {
          inputCost: costs.inputCost,
          outputCost: costs.outputCost,
          cacheReadCost: costs.cacheReadCost,
          cacheWriteCost: costs.cacheWriteCost
        },
        // Totals (24h for backward compatibility)
        totalCost: costs.totalCost,
        planCost,
        planName,
        // Period
        period: "24 hours",
        // Multi-window data for moving averages
        windows,
        // Top sessions by tokens
        topSessions: getTopSessionsByTokens(5, getSessions)
      };
    }
    function getTopSessionsByTokens(limit = 5, getSessions) {
      try {
        const sessions2 = getSessions({ limit: null });
        return sessions2.filter((s) => s.tokens > 0).sort((a, b) => b.tokens - a.tokens).slice(0, limit).map((s) => ({
          label: s.label,
          tokens: s.tokens,
          channel: s.channel,
          active: s.active
        }));
      } catch (e) {
        console.error("[TopSessions] Error:", e.message);
        return [];
      }
    }
    function getTokenStats2(sessions2, capacity, config = {}) {
      let activeMainCount = capacity?.main?.active ?? 0;
      let activeSubagentCount = capacity?.subagent?.active ?? 0;
      let activeCount = activeMainCount + activeSubagentCount;
      let mainLimit = capacity?.main?.max ?? 12;
      let subagentLimit = capacity?.subagent?.max ?? 24;
      if (!capacity && sessions2 && sessions2.length > 0) {
        activeCount = 0;
        activeMainCount = 0;
        activeSubagentCount = 0;
        sessions2.forEach((s) => {
          if (s.active) {
            activeCount++;
            if (s.key && s.key.includes(":subagent:")) {
              activeSubagentCount++;
            } else {
              activeMainCount++;
            }
          }
        });
      }
      const usage = getDailyTokenUsage2();
      const totalInput = usage?.input || 0;
      const totalOutput = usage?.output || 0;
      const total = totalInput + totalOutput;
      const costs = calculateCostForBucket(usage);
      const estCost = costs.totalCost;
      const planCost = config?.billing?.claudePlanCost ?? 200;
      const planName = config?.billing?.claudePlanName ?? "Claude Code Max";
      const monthlyApiCost = estCost * 30;
      const monthlySavings = monthlyApiCost - planCost;
      const savingsPositive = monthlySavings > 0;
      const sessionCount = sessions2?.length || 1;
      const avgTokensPerSession = Math.round(total / sessionCount);
      const avgCostPerSession = estCost / sessionCount;
      const windowConfigs = {
        "24h": { days: 1, label: "24h" },
        "3dma": { days: 3, label: "3dma" },
        "7dma": { days: 7, label: "7dma" }
      };
      const savingsWindows = {};
      for (const [key, windowConfig] of Object.entries(windowConfigs)) {
        const bucketKey = key.replace("dma", "d").replace("24h", "24h");
        const bucket = usage.windows?.[bucketKey === "24h" ? "24h" : bucketKey] || usage;
        const bucketCosts = calculateCostForBucket(bucket);
        const dailyAvg = bucketCosts.totalCost / windowConfig.days;
        const monthlyProjected = dailyAvg * 30;
        const windowSavings = monthlyProjected - planCost;
        const windowSavingsPositive = windowSavings > 0;
        savingsWindows[key] = {
          label: windowConfig.label,
          estCost: `$${formatNumber(dailyAvg)}`,
          estMonthlyCost: `$${Math.round(monthlyProjected).toLocaleString()}`,
          estSavings: windowSavingsPositive ? `$${formatNumber(windowSavings)}/mo` : null,
          savingsPercent: windowSavingsPositive ? Math.round(windowSavings / monthlyProjected * 100) : 0,
          requests: bucket.requests
        };
      }
      return {
        total: formatTokens(total),
        input: formatTokens(totalInput),
        output: formatTokens(totalOutput),
        cacheRead: formatTokens(usage?.cacheRead || 0),
        cacheWrite: formatTokens(usage?.cacheWrite || 0),
        requests: usage?.requests || 0,
        activeCount,
        activeMainCount,
        activeSubagentCount,
        mainLimit,
        subagentLimit,
        estCost: `$${formatNumber(estCost)}`,
        planCost: `$${planCost.toFixed(0)}`,
        planName,
        // 24h savings (backward compatible)
        estSavings: savingsPositive ? `$${formatNumber(monthlySavings)}/mo` : null,
        savingsPercent: savingsPositive ? Math.round(monthlySavings / monthlyApiCost * 100) : 0,
        estMonthlyCost: `$${Math.round(monthlyApiCost).toLocaleString()}`,
        // Multi-window savings (24h, 3da, 7da)
        savingsWindows,
        // Per-session averages
        avgTokensPerSession: formatTokens(avgTokensPerSession),
        avgCostPerSession: `$${avgCostPerSession.toFixed(2)}`,
        sessionCount
      };
    }
    function startTokenUsageRefresh2(getOpenClawDir2) {
      refreshTokenUsageAsync2(getOpenClawDir2);
      if (refreshInterval) {
        clearInterval(refreshInterval);
      }
      refreshInterval = setInterval(() => {
        refreshTokenUsageAsync2(getOpenClawDir2);
      }, TOKEN_USAGE_CACHE_TTL);
      return refreshInterval;
    }
    module2.exports = {
      TOKEN_RATES,
      emptyUsageBucket,
      addUsageToBucket,
      addUsageToModelMap,
      summarizeModelUsage,
      refreshTokenUsageAsync: refreshTokenUsageAsync2,
      getDailyTokenUsage: getDailyTokenUsage2,
      calculateCostForBucket,
      getCostBreakdown: getCostBreakdown2,
      getTopSessionsByTokens,
      getTokenStats: getTokenStats2,
      startTokenUsageRefresh: startTokenUsageRefresh2
    };
  }
});

// src/llm-usage.js
var require_llm_usage = __commonJS({
  "src/llm-usage.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var { execFile } = require("child_process");
    var { getSafeEnv } = require_openclaw();
    var llmUsageCache = { data: null, timestamp: 0, refreshing: false };
    var LLM_CACHE_TTL_MS = 6e4;
    function refreshLlmUsageAsync() {
      if (llmUsageCache.refreshing) return;
      llmUsageCache.refreshing = true;
      const profile = process.env.OPENCLAW_PROFILE || "";
      const args2 = profile ? ["--profile", profile, "status", "--usage", "--json"] : ["status", "--usage", "--json"];
      execFile(
        "openclaw",
        args2,
        { encoding: "utf8", timeout: 2e4, env: getSafeEnv() },
        (err, stdout) => {
          llmUsageCache.refreshing = false;
          if (err) {
            console.error("[LLM Usage] Async refresh failed:", err.message);
            return;
          }
          try {
            const jsonStart = stdout.indexOf("{");
            const jsonStr = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;
            const parsed = JSON.parse(jsonStr);
            if (parsed.usage) {
              const result = transformLiveUsageData(parsed.usage);
              llmUsageCache.data = result;
              llmUsageCache.timestamp = Date.now();
              console.log("[LLM Usage] Cache refreshed");
            }
          } catch (e) {
            console.error("[LLM Usage] Parse error:", e.message);
          }
        }
      );
    }
    function transformLiveUsageData(usage) {
      const anthropic = usage.providers?.find((p) => p.provider === "anthropic");
      const codexProvider = usage.providers?.find((p) => p.provider === "openai-codex");
      if (anthropic?.error) {
        return {
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          source: "error",
          error: anthropic.error,
          errorType: anthropic.error.includes("403") ? "auth" : "unknown",
          claude: {
            session: { usedPct: null, remainingPct: null, resetsIn: null, error: anthropic.error },
            weekly: { usedPct: null, remainingPct: null, resets: null, error: anthropic.error },
            sonnet: { usedPct: null, remainingPct: null, resets: null, error: anthropic.error },
            lastSynced: null
          },
          codex: { sessionsToday: 0, tasksToday: 0, usage5hPct: 0, usageDayPct: 0 },
          routing: {
            total: 0,
            claudeTasks: 0,
            codexTasks: 0,
            claudePct: 0,
            codexPct: 0,
            codexFloor: 20
          }
        };
      }
      const session5h = anthropic?.windows?.find((w) => w.label === "5h");
      const weekAll = anthropic?.windows?.find((w) => w.label === "Week");
      const sonnetWeek = anthropic?.windows?.find((w) => w.label === "Sonnet");
      const codex5h = codexProvider?.windows?.find((w) => w.label === "5h");
      const codexDay = codexProvider?.windows?.find((w) => w.label === "Day");
      const formatReset = (resetAt) => {
        if (!resetAt) return "?";
        const diff = resetAt - Date.now();
        if (diff < 0) return "now";
        if (diff < 36e5) return Math.round(diff / 6e4) + "m";
        if (diff < 864e5) return Math.round(diff / 36e5) + "h";
        return Math.round(diff / 864e5) + "d";
      };
      return {
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        source: "live",
        claude: {
          session: {
            usedPct: Math.round(session5h?.usedPercent || 0),
            remainingPct: Math.round(100 - (session5h?.usedPercent || 0)),
            resetsIn: formatReset(session5h?.resetAt)
          },
          weekly: {
            usedPct: Math.round(weekAll?.usedPercent || 0),
            remainingPct: Math.round(100 - (weekAll?.usedPercent || 0)),
            resets: formatReset(weekAll?.resetAt)
          },
          sonnet: {
            usedPct: Math.round(sonnetWeek?.usedPercent || 0),
            remainingPct: Math.round(100 - (sonnetWeek?.usedPercent || 0)),
            resets: formatReset(sonnetWeek?.resetAt)
          },
          lastSynced: (/* @__PURE__ */ new Date()).toISOString()
        },
        codex: {
          sessionsToday: 0,
          tasksToday: 0,
          usage5hPct: Math.round(codex5h?.usedPercent || 0),
          usageDayPct: Math.round(codexDay?.usedPercent || 0)
        },
        routing: { total: 0, claudeTasks: 0, codexTasks: 0, claudePct: 0, codexPct: 0, codexFloor: 20 }
      };
    }
    function getLlmUsage2(statePath) {
      const now = Date.now();
      if (!llmUsageCache.data || now - llmUsageCache.timestamp > LLM_CACHE_TTL_MS) {
        refreshLlmUsageAsync();
      }
      if (llmUsageCache.data && llmUsageCache.data.source !== "error") {
        return llmUsageCache.data;
      }
      const stateFile = path2.join(statePath, "llm-routing.json");
      try {
        if (fs2.existsSync(stateFile)) {
          const data = JSON.parse(fs2.readFileSync(stateFile, "utf8"));
          const sessionValid = data.claude?.session?.resets_in && data.claude.session.resets_in !== "unknown";
          const weeklyValid = data.claude?.weekly_all_models?.resets && data.claude.weekly_all_models.resets !== "unknown";
          if (sessionValid || weeklyValid) {
            return {
              timestamp: (/* @__PURE__ */ new Date()).toISOString(),
              source: "file",
              claude: {
                session: {
                  usedPct: Math.round((data.claude?.session?.used_pct || 0) * 100),
                  remainingPct: Math.round((data.claude?.session?.remaining_pct || 1) * 100),
                  resetsIn: data.claude?.session?.resets_in || "?"
                },
                weekly: {
                  usedPct: Math.round((data.claude?.weekly_all_models?.used_pct || 0) * 100),
                  remainingPct: Math.round((data.claude?.weekly_all_models?.remaining_pct || 1) * 100),
                  resets: data.claude?.weekly_all_models?.resets || "?"
                },
                sonnet: {
                  usedPct: Math.round((data.claude?.weekly_sonnet?.used_pct || 0) * 100),
                  remainingPct: Math.round((data.claude?.weekly_sonnet?.remaining_pct || 1) * 100),
                  resets: data.claude?.weekly_sonnet?.resets || "?"
                },
                lastSynced: data.claude?.last_synced || null
              },
              codex: {
                sessionsToday: data.codex?.sessions_today || 0,
                tasksToday: data.codex?.tasks_today || 0,
                usage5hPct: data.codex?.usage_5h_pct || 0,
                usageDayPct: data.codex?.usage_day_pct || 0
              },
              routing: {
                total: data.routing?.total_tasks || 0,
                claudeTasks: data.routing?.claude_tasks || 0,
                codexTasks: data.routing?.codex_tasks || 0,
                claudePct: data.routing?.total_tasks > 0 ? Math.round(data.routing.claude_tasks / data.routing.total_tasks * 100) : 0,
                codexPct: data.routing?.total_tasks > 0 ? Math.round(data.routing.codex_tasks / data.routing.total_tasks * 100) : 0,
                codexFloor: Math.round((data.routing?.codex_floor_pct || 0.2) * 100)
              }
            };
          }
        }
      } catch (e) {
        console.error("[LLM Usage] File fallback failed:", e.message);
      }
      return {
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        source: "error",
        error: "API key lacks user:profile OAuth scope",
        errorType: "auth",
        claude: {
          session: { usedPct: null, remainingPct: null, resetsIn: null, error: "Auth required" },
          weekly: { usedPct: null, remainingPct: null, resets: null, error: "Auth required" },
          sonnet: { usedPct: null, remainingPct: null, resets: null, error: "Auth required" },
          lastSynced: null
        },
        codex: { sessionsToday: 0, tasksToday: 0, usage5hPct: 0, usageDayPct: 0 },
        routing: { total: 0, claudeTasks: 0, codexTasks: 0, claudePct: 0, codexPct: 0, codexFloor: 20 }
      };
    }
    function getRoutingStats2(skillsPath, statePath, hours = 24) {
      const safeHours = parseInt(hours, 10) || 24;
      try {
        const { execFileSync } = require("child_process");
        const skillDir = path2.join(skillsPath, "llm_routing");
        const output = execFileSync(
          "python",
          ["-m", "llm_routing", "stats", "--hours", String(safeHours), "--json"],
          {
            encoding: "utf8",
            timeout: 1e4,
            cwd: skillDir,
            env: getSafeEnv()
          }
        );
        return JSON.parse(output);
      } catch (e) {
        try {
          const logFile = path2.join(statePath, "routing-log.jsonl");
          if (!fs2.existsSync(logFile)) {
            return { total_requests: 0, by_model: {}, by_task_type: {} };
          }
          const cutoff = Date.now() - hours * 3600 * 1e3;
          const lines = fs2.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
          const stats = {
            total_requests: 0,
            by_model: {},
            by_task_type: {},
            escalations: 0,
            avg_latency_ms: 0,
            success_rate: 0
          };
          let latencies = [];
          let successes = 0;
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              const ts = new Date(entry.timestamp).getTime();
              if (ts < cutoff) continue;
              stats.total_requests++;
              const model = entry.selected_model || "unknown";
              stats.by_model[model] = (stats.by_model[model] || 0) + 1;
              const tt = entry.task_type || "unknown";
              stats.by_task_type[tt] = (stats.by_task_type[tt] || 0) + 1;
              if (entry.escalation_reason) stats.escalations++;
              if (entry.latency_ms) latencies.push(entry.latency_ms);
              if (entry.success === true) successes++;
            } catch {
            }
          }
          if (latencies.length > 0) {
            stats.avg_latency_ms = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
          }
          if (stats.total_requests > 0) {
            stats.success_rate = Math.round(successes / stats.total_requests * 100);
          }
          return stats;
        } catch (e2) {
          console.error("Failed to read routing stats:", e2.message);
          return { error: e2.message };
        }
      }
    }
    function startLlmUsageRefresh2() {
      setTimeout(() => refreshLlmUsageAsync(), 1e3);
      setInterval(() => refreshLlmUsageAsync(), LLM_CACHE_TTL_MS);
    }
    module2.exports = {
      refreshLlmUsageAsync,
      transformLiveUsageData,
      getLlmUsage: getLlmUsage2,
      getRoutingStats: getRoutingStats2,
      startLlmUsageRefresh: startLlmUsageRefresh2
    };
  }
});

// src/actions.js
var require_actions = __commonJS({
  "src/actions.js"(exports2, module2) {
    var ALLOWED_ACTIONS = /* @__PURE__ */ new Set([
      "gateway-status",
      "gateway-restart",
      "sessions-list",
      "cron-list",
      "health-check",
      "clear-stale-sessions"
    ]);
    function executeAction2(action, deps) {
      const { runOpenClaw: runOpenClaw2, extractJSON: extractJSON2, PORT: PORT2 } = deps;
      const results = { success: false, action, output: "", error: null };
      if (!ALLOWED_ACTIONS.has(action)) {
        results.error = `Unknown action: ${action}`;
        return results;
      }
      try {
        switch (action) {
          case "gateway-status":
            results.output = runOpenClaw2("gateway status 2>&1") || "Unknown";
            results.success = true;
            break;
          case "gateway-restart":
            results.output = "To restart gateway, run: openclaw gateway restart";
            results.success = true;
            results.note = "Dashboard cannot restart gateway for safety";
            break;
          case "sessions-list":
            results.output = runOpenClaw2("sessions 2>&1") || "No sessions";
            results.success = true;
            break;
          case "cron-list":
            results.output = runOpenClaw2("cron list 2>&1") || "No cron jobs";
            results.success = true;
            break;
          case "health-check": {
            const gateway = runOpenClaw2("gateway status 2>&1");
            const sessions2 = runOpenClaw2("sessions --json 2>&1");
            let sessionCount = 0;
            try {
              const data = JSON.parse(sessions2);
              sessionCount = data.sessions?.length || 0;
            } catch (e) {
            }
            results.output = [
              `Gateway: ${gateway?.includes("running") ? "OK Running" : "NOT Running"}`,
              `Sessions: ${sessionCount}`,
              `Dashboard: OK Running on port ${PORT2}`
            ].join("\n");
            results.success = true;
            break;
          }
          case "clear-stale-sessions": {
            const staleOutput = runOpenClaw2("sessions --json 2>&1");
            let staleCount = 0;
            try {
              const staleJson = extractJSON2(staleOutput);
              if (staleJson) {
                const data = JSON.parse(staleJson);
                staleCount = (data.sessions || []).filter((s) => s.ageMs > 24 * 60 * 60 * 1e3).length;
              }
            } catch (e) {
            }
            results.output = `Found ${staleCount} stale sessions (>24h old).
To clean: openclaw sessions prune`;
            results.success = true;
            break;
          }
        }
      } catch (e) {
        results.error = e.message;
      }
      return results;
    }
    module2.exports = { executeAction: executeAction2, ALLOWED_ACTIONS };
  }
});

// src/data.js
var require_data = __commonJS({
  "src/data.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    function migrateDataDir2(dataDir, legacyDataDir) {
      try {
        if (!fs2.existsSync(legacyDataDir)) return;
        if (!fs2.existsSync(dataDir)) {
          fs2.mkdirSync(dataDir, { recursive: true });
        }
        const legacyFiles = fs2.readdirSync(legacyDataDir);
        if (legacyFiles.length === 0) return;
        let migrated = 0;
        for (const file of legacyFiles) {
          const srcPath = path2.join(legacyDataDir, file);
          const destPath = path2.join(dataDir, file);
          if (fs2.existsSync(destPath)) continue;
          const stat = fs2.statSync(srcPath);
          if (stat.isFile()) {
            fs2.copyFileSync(srcPath, destPath);
            migrated++;
            console.log(`[Migration] Copied ${file} to profile-aware data dir`);
          }
        }
        if (migrated > 0) {
          console.log(`[Migration] Migrated ${migrated} file(s) to ${dataDir}`);
          console.log(`[Migration] Legacy data preserved at ${legacyDataDir}`);
        }
      } catch (e) {
        console.error("[Migration] Failed to migrate data:", e.message);
      }
    }
    module2.exports = { migrateDataDir: migrateDataDir2 };
  }
});

// src/state.js
var require_state = __commonJS({
  "src/state.js"(exports2, module2) {
    var fs2 = require("fs");
    var os = require("os");
    var path2 = require("path");
    var { execFileSync } = require("child_process");
    var { formatBytes, formatTimeAgo } = require_utils();
    function createStateModule2(deps) {
      const {
        CONFIG: CONFIG2,
        getOpenClawDir: getOpenClawDir2,
        getSessions,
        getSystemVitals: getSystemVitals2,
        getCronJobs: getCronJobs2,
        loadOperators: loadOperators2,
        calculateOperatorStats: calculateOperatorStats2,
        getLlmUsage: getLlmUsage2,
        getDailyTokenUsage: getDailyTokenUsage2,
        getTokenStats: getTokenStats2,
        getCerebroTopics: getCerebroTopics2,
        runOpenClaw: runOpenClaw2,
        extractJSON: extractJSON2,
        readTranscript
      } = deps;
      const PATHS2 = CONFIG2.paths;
      let cachedState = null;
      let lastStateUpdate = 0;
      const STATE_CACHE_TTL = 3e4;
      let stateRefreshInterval = null;
      function getSystemStatus() {
        const hostname = os.hostname();
        let uptime = "\u2014";
        try {
          const uptimeRaw = execFileSync("uptime", [], { encoding: "utf8" });
          const match = uptimeRaw.match(/up\s+([^,]+)/);
          if (match) uptime = match[1].trim();
        } catch (e) {
        }
        let gateway = "Unknown";
        try {
          const status = runOpenClaw2("gateway status 2>/dev/null");
          if (status && status.includes("running")) {
            gateway = "Running";
          } else if (status && status.includes("stopped")) {
            gateway = "Stopped";
          }
        } catch (e) {
        }
        return {
          hostname,
          gateway,
          model: "claude-opus-4-5",
          uptime
        };
      }
      function getRecentActivity() {
        const activities = [];
        const today = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
        const memoryFile = path2.join(PATHS2.memory, `${today}.md`);
        try {
          if (fs2.existsSync(memoryFile)) {
            const content = fs2.readFileSync(memoryFile, "utf8");
            const lines = content.split("\n").filter((l) => l.startsWith("- "));
            lines.slice(-5).forEach((line) => {
              const text = line.replace(/^- /, "").slice(0, 80);
              activities.push({
                icon: text.includes("\u2705") ? "\u2705" : text.includes("\u274C") ? "\u274C" : "\u{1F4DD}",
                text: text.replace(/[\u2705\u274C\uD83D\uDCDD\uD83D\uDD27]/g, "").trim(),
                time: today
              });
            });
          }
        } catch (e) {
          console.error("Failed to read activity:", e.message);
        }
        return activities.reverse();
      }
      function getCapacity() {
        const result = {
          main: { active: 0, max: 12 },
          subagent: { active: 0, max: 24 }
        };
        const openclawDir = getOpenClawDir2();
        try {
          const configPath = path2.join(openclawDir, "openclaw.json");
          if (fs2.existsSync(configPath)) {
            const config = JSON.parse(fs2.readFileSync(configPath, "utf8"));
            if (config?.agents?.defaults?.maxConcurrent) {
              result.main.max = config.agents.defaults.maxConcurrent;
            }
            if (config?.agents?.defaults?.subagents?.maxConcurrent) {
              result.subagent.max = config.agents.defaults.subagents.maxConcurrent;
            }
          }
        } catch (e) {
        }
        try {
          const output = runOpenClaw2("sessions --json 2>/dev/null");
          const jsonStr = extractJSON2(output);
          if (jsonStr) {
            const data = JSON.parse(jsonStr);
            const sessions2 = data.sessions || [];
            const fiveMinMs = 5 * 60 * 1e3;
            for (const s of sessions2) {
              if (s.ageMs > fiveMinMs) continue;
              const key = s.key || "";
              if (key.includes(":subagent:") || key.includes(":cron:")) {
                result.subagent.active++;
              } else {
                result.main.active++;
              }
            }
            return result;
          }
        } catch (e) {
          console.error("Failed to get capacity from sessions, falling back to filesystem:", e.message);
        }
        try {
          const sessionsDir = path2.join(openclawDir, "agents", "main", "sessions");
          if (fs2.existsSync(sessionsDir)) {
            const fiveMinAgo = Date.now() - 5 * 60 * 1e3;
            const files = fs2.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
            let mainActive = 0;
            let subActive = 0;
            for (const file of files) {
              try {
                const filePath = path2.join(sessionsDir, file);
                const stat = fs2.statSync(filePath);
                if (stat.mtimeMs < fiveMinAgo) continue;
                let isSubagent = false;
                try {
                  const fd = fs2.openSync(filePath, "r");
                  const buffer = Buffer.alloc(512);
                  fs2.readSync(fd, buffer, 0, 512, 0);
                  fs2.closeSync(fd);
                  const firstLine = buffer.toString("utf8").split("\n")[0];
                  const parsed = JSON.parse(firstLine);
                  const key = parsed.key || parsed.id || "";
                  isSubagent = key.includes(":subagent:") || key.includes(":cron:");
                } catch (parseErr) {
                  isSubagent = file.includes("subagent");
                }
                if (isSubagent) {
                  subActive++;
                } else {
                  mainActive++;
                }
              } catch (e) {
              }
            }
            result.main.active = mainActive;
            result.subagent.active = subActive;
          }
        } catch (e) {
          console.error("Failed to count active sessions from filesystem:", e.message);
        }
        return result;
      }
      function getMemoryStats() {
        const memoryDir = PATHS2.memory;
        const memoryFile = path2.join(PATHS2.workspace, "MEMORY.md");
        const stats = {
          totalFiles: 0,
          totalSize: 0,
          totalSizeFormatted: "0 B",
          memoryMdSize: 0,
          memoryMdSizeFormatted: "0 B",
          memoryMdLines: 0,
          recentFiles: [],
          oldestFile: null,
          newestFile: null
        };
        try {
          const collectMemoryFiles = (dir, baseDir) => {
            const entries = fs2.readdirSync(dir, { withFileTypes: true });
            const files = [];
            for (const entry of entries) {
              const entryPath = path2.join(dir, entry.name);
              if (entry.isDirectory()) {
                files.push(...collectMemoryFiles(entryPath, baseDir));
              } else if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".json"))) {
                const stat = fs2.statSync(entryPath);
                const relativePath = path2.relative(baseDir, entryPath);
                files.push({
                  name: relativePath,
                  size: stat.size,
                  sizeFormatted: formatBytes(stat.size),
                  modified: stat.mtime
                });
              }
            }
            return files;
          };
          if (fs2.existsSync(memoryFile)) {
            const memStat = fs2.statSync(memoryFile);
            stats.memoryMdSize = memStat.size;
            stats.memoryMdSizeFormatted = formatBytes(memStat.size);
            const content = fs2.readFileSync(memoryFile, "utf8");
            stats.memoryMdLines = content.split("\n").length;
            stats.totalSize += memStat.size;
            stats.totalFiles++;
          }
          if (fs2.existsSync(memoryDir)) {
            const files = collectMemoryFiles(memoryDir, memoryDir).sort(
              (a, b) => b.modified - a.modified
            );
            stats.totalFiles += files.length;
            files.forEach((f) => stats.totalSize += f.size);
            stats.recentFiles = files.slice(0, 5).map((f) => ({
              name: f.name,
              sizeFormatted: f.sizeFormatted,
              age: formatTimeAgo(f.modified)
            }));
            if (files.length > 0) {
              stats.newestFile = files[0].name;
              stats.oldestFile = files[files.length - 1].name;
            }
          }
          stats.totalSizeFormatted = formatBytes(stats.totalSize);
        } catch (e) {
          console.error("Failed to get memory stats:", e.message);
        }
        return stats;
      }
      function getData() {
        const allSessions = getSessions({ limit: null });
        const pageSize = 20;
        const displaySessions = allSessions.slice(0, pageSize);
        const tokenStats = getTokenStats2(allSessions);
        const capacity = getCapacity();
        const memory = getMemoryStats();
        const statusCounts = {
          all: allSessions.length,
          live: allSessions.filter((s) => s.active).length,
          recent: allSessions.filter((s) => !s.active && s.recentlyActive).length,
          idle: allSessions.filter((s) => !s.active && !s.recentlyActive).length
        };
        const totalPages = Math.ceil(allSessions.length / pageSize);
        return {
          sessions: displaySessions,
          tokenStats,
          capacity,
          memory,
          pagination: {
            page: 1,
            pageSize,
            total: allSessions.length,
            totalPages,
            hasPrev: false,
            hasNext: totalPages > 1
          },
          statusCounts
        };
      }
      function getFullState() {
        const now = Date.now();
        if (cachedState && now - lastStateUpdate < STATE_CACHE_TTL) {
          return cachedState;
        }
        let sessions2 = [];
        let tokenStats = {};
        let statusCounts = { all: 0, live: 0, recent: 0, idle: 0 };
        let vitals = {};
        let capacity = {};
        let operators = { operators: [], roles: {} };
        let llmUsage = {};
        let cron = [];
        let memory = {};
        let cerebro = {};
        let subagents = [];
        let allSessions = [];
        let totalSessionCount = 0;
        try {
          allSessions = getSessions({ limit: null });
          totalSessionCount = allSessions.length;
          sessions2 = allSessions.slice(0, 20);
        } catch (e) {
          console.error("[State] sessions:", e.message);
        }
        try {
          vitals = getSystemVitals2();
        } catch (e) {
          console.error("[State] vitals:", e.message);
        }
        try {
          capacity = getCapacity();
        } catch (e) {
          console.error("[State] capacity:", e.message);
        }
        try {
          tokenStats = getTokenStats2(allSessions, capacity, CONFIG2);
        } catch (e) {
          console.error("[State] tokenStats:", e.message);
        }
        try {
          const liveSessions = allSessions.filter((s) => s.active);
          const recentSessions = allSessions.filter((s) => !s.active && s.recentlyActive);
          const idleSessions = allSessions.filter((s) => !s.active && !s.recentlyActive);
          statusCounts = {
            all: totalSessionCount,
            live: liveSessions.length,
            recent: recentSessions.length,
            idle: idleSessions.length
          };
        } catch (e) {
          console.error("[State] statusCounts:", e.message);
        }
        try {
          const operatorData = loadOperators2();
          operators = calculateOperatorStats2(operatorData, allSessions);
        } catch (e) {
          console.error("[State] operators:", e.message);
        }
        try {
          llmUsage = getLlmUsage2();
        } catch (e) {
          console.error("[State] llmUsage:", e.message);
        }
        try {
          cron = getCronJobs2();
        } catch (e) {
          console.error("[State] cron:", e.message);
        }
        try {
          memory = getMemoryStats();
        } catch (e) {
          console.error("[State] memory:", e.message);
        }
        try {
          cerebro = getCerebroTopics2();
        } catch (e) {
          console.error("[State] cerebro:", e.message);
        }
        try {
          const retentionHours = parseInt(process.env.SUBAGENT_RETENTION_HOURS || "12", 10);
          const retentionMs = retentionHours * 60 * 60 * 1e3;
          subagents = allSessions.filter((s) => s.sessionKey && s.sessionKey.includes(":subagent:")).filter((s) => (s.minutesAgo || 0) * 6e4 < retentionMs).map((s) => {
            const match = s.sessionKey.match(/:subagent:([a-f0-9-]+)$/);
            const subagentId = match ? match[1] : s.sessionId;
            return {
              id: subagentId,
              shortId: subagentId.slice(0, 8),
              task: s.label || s.displayName || "Sub-agent task",
              tokens: s.tokens || 0,
              ageMs: (s.minutesAgo || 0) * 6e4,
              active: s.active,
              recentlyActive: s.recentlyActive
            };
          });
        } catch (e) {
          console.error("[State] subagents:", e.message);
        }
        cachedState = {
          vitals,
          sessions: sessions2,
          tokenStats,
          statusCounts,
          capacity,
          operators,
          llmUsage,
          cron,
          memory,
          cerebro,
          subagents,
          pagination: {
            page: 1,
            pageSize: 20,
            total: totalSessionCount,
            totalPages: Math.max(1, Math.ceil(totalSessionCount / 20)),
            hasPrev: false,
            hasNext: totalSessionCount > 20
          },
          timestamp: now
        };
        lastStateUpdate = now;
        return cachedState;
      }
      function refreshState() {
        lastStateUpdate = 0;
        return getFullState();
      }
      function startStateRefresh(broadcastSSE2, intervalMs = 3e4) {
        if (stateRefreshInterval) return;
        stateRefreshInterval = setInterval(() => {
          try {
            const newState = refreshState();
            broadcastSSE2("update", newState);
          } catch (e) {
            console.error("[State] Refresh error:", e.message);
          }
        }, intervalMs);
        console.log(`[State] Background refresh started (${intervalMs}ms interval)`);
      }
      function stopStateRefresh() {
        if (stateRefreshInterval) {
          clearInterval(stateRefreshInterval);
          stateRefreshInterval = null;
          console.log("[State] Background refresh stopped");
        }
      }
      function getSubagentStatus() {
        const subagents = [];
        try {
          const output = runOpenClaw2("sessions --json 2>/dev/null");
          const jsonStr = extractJSON2(output);
          if (jsonStr) {
            const data = JSON.parse(jsonStr);
            const subagentSessions = (data.sessions || []).filter(
              (s) => s.key && s.key.includes(":subagent:")
            );
            for (const s of subagentSessions) {
              const ageMs = s.ageMs || Infinity;
              const isActive = ageMs < 5 * 60 * 1e3;
              const isRecent = ageMs < 30 * 60 * 1e3;
              const match = s.key.match(/:subagent:([a-f0-9-]+)$/);
              const subagentId = match ? match[1] : s.sessionId;
              const shortId = subagentId.slice(0, 8);
              let taskSummary = "Unknown task";
              let label = null;
              const transcript = readTranscript(s.sessionId);
              for (const entry of transcript.slice(0, 15)) {
                if (entry.type === "message" && entry.message?.role === "user") {
                  const content = entry.message.content;
                  let text = "";
                  if (typeof content === "string") {
                    text = content;
                  } else if (Array.isArray(content)) {
                    const textPart = content.find((c) => c.type === "text");
                    if (textPart) text = textPart.text || "";
                  }
                  if (!text) continue;
                  const labelMatch = text.match(/Label:\s*([^\n]+)/i);
                  if (labelMatch) {
                    label = labelMatch[1].trim();
                  }
                  let taskMatch = text.match(/You were created to handle:\s*\*\*([^*]+)\*\*/i);
                  if (taskMatch) {
                    taskSummary = taskMatch[1].trim();
                    break;
                  }
                  taskMatch = text.match(/\*\*([A-Z]{2,5}-\d+:\s*[^*]+)\*\*/);
                  if (taskMatch) {
                    taskSummary = taskMatch[1].trim();
                    break;
                  }
                  const firstLine = text.split("\n")[0].replace(/^\*\*|\*\*$/g, "").trim();
                  if (firstLine.length > 10 && firstLine.length < 100) {
                    taskSummary = firstLine;
                    break;
                  }
                }
              }
              const messageCount = transcript.filter(
                (e) => e.type === "message" && e.message?.role
              ).length;
              subagents.push({
                id: subagentId,
                shortId,
                sessionId: s.sessionId,
                label: label || shortId,
                task: taskSummary,
                model: s.model?.replace("anthropic/", "") || "unknown",
                status: isActive ? "active" : isRecent ? "idle" : "stale",
                ageMs,
                ageFormatted: ageMs < 6e4 ? "Just now" : ageMs < 36e5 ? `${Math.round(ageMs / 6e4)}m ago` : `${Math.round(ageMs / 36e5)}h ago`,
                messageCount,
                tokens: s.totalTokens || 0
              });
            }
          }
        } catch (e) {
          console.error("Failed to get subagent status:", e.message);
        }
        return subagents.sort((a, b) => a.ageMs - b.ageMs);
      }
      return {
        getSystemStatus,
        getRecentActivity,
        getCapacity,
        getMemoryStats,
        getFullState,
        refreshState,
        startStateRefresh,
        stopStateRefresh,
        getData,
        getSubagentStatus
      };
    }
    module2.exports = { createStateModule: createStateModule2 };
  }
});

// src/tailscale.js
var require_tailscale = __commonJS({
  "src/tailscale.js"(exports2, module2) {
    var { runCmd } = require_utils();
    var DEFAULT_LOCAL_API_ENDPOINT = "http://127.0.0.1:9002/api/status";
    var STATUS_CACHE_TTL = 1e4;
    var NEGATIVE_STATUS_CACHE_TTL = 3e3;
    var EXEC_TIMEOUT_MS = 1e4;
    var LOCALAPI_MAX_CONSECUTIVE_FAILURES = 3;
    var LOCALAPI_REPROBE_INTERVAL_MS = 60 * 60 * 1e3;
    function stripTrailingDot(name) {
      if (typeof name !== "string") return "";
      return name.endsWith(".") ? name.slice(0, -1) : name;
    }
    function deriveMagicDnsSuffix(dnsName) {
      const fqdn = stripTrailingDot(dnsName || "");
      const firstDot = fqdn.indexOf(".");
      if (firstDot === -1) return "";
      return fqdn.slice(firstDot + 1);
    }
    function normalizePeer(peer) {
      return {
        id: peer.ID || peer.PublicKey || "",
        hostname: peer.HostName || "",
        fqdn: stripTrailingDot(peer.DNSName || ""),
        ips: Array.isArray(peer.TailscaleIPs) ? [...peer.TailscaleIPs] : [],
        online: peer.Online === true,
        lastSeen: peer.LastSeen || null,
        os: peer.OS || "unknown"
      };
    }
    function normalizeStatus(raw) {
      if (!raw || typeof raw !== "object" || !raw.Self || typeof raw.Self !== "object") {
        throw new Error("Unrecognized tailscale status payload (missing Self)");
      }
      const self = raw.Self;
      const magicDnsSuffix = deriveMagicDnsSuffix(self.DNSName) || stripTrailingDot(raw.MagicDNSSuffix || "");
      const rawPeers = raw.Peer && typeof raw.Peer === "object" ? Object.values(raw.Peer) : [];
      return {
        available: true,
        self: {
          hostname: self.HostName || "",
          fqdn: stripTrailingDot(self.DNSName || ""),
          tailscaleIPs: Array.isArray(self.TailscaleIPs) ? [...self.TailscaleIPs] : [],
          magicDnsSuffix
        },
        peers: rawPeers.map(normalizePeer)
      };
    }
    function createTailscaleAdapter(deps = {}) {
      const {
        execFn = (cmd) => runCmd(cmd, { timeout: EXEC_TIMEOUT_MS }),
        fetchFn = (...args2) => globalThis.fetch(...args2),
        cacheTtlMs = STATUS_CACHE_TTL,
        negativeCacheTtlMs = NEGATIVE_STATUS_CACHE_TTL,
        localApiEndpoint = null,
        nowFn = Date.now,
        warnFn = (...args2) => console.warn(...args2)
      } = deps;
      let cachedStatus = null;
      let lastStatusUpdate = 0;
      let lastAvailable = null;
      let preferredPath = "cli";
      let localApiConsecutiveFailures = 0;
      let localApiDisabledUntil = 0;
      function getLocalApiEndpoint() {
        return localApiEndpoint || process.env.TAILSCALE_LOCAL_API_ENDPOINT || DEFAULT_LOCAL_API_ENDPOINT;
      }
      async function fetchViaCli() {
        const stdout = await execFn("tailscale status --json");
        return normalizeStatus(JSON.parse(stdout));
      }
      async function fetchViaLocalApi() {
        const res = await fetchFn(getLocalApiEndpoint());
        if (!res || res.ok !== true) {
          throw new Error(`LocalAPI returned HTTP ${res ? res.status : "no response"}`);
        }
        return normalizeStatus(await res.json());
      }
      function isLocalApiCircuitOpen(now) {
        return localApiConsecutiveFailures >= LOCALAPI_MAX_CONSECUTIVE_FAILURES && now < localApiDisabledUntil;
      }
      function recordLocalApiFailure(now) {
        localApiConsecutiveFailures++;
        if (localApiConsecutiveFailures >= LOCALAPI_MAX_CONSECUTIVE_FAILURES) {
          localApiDisabledUntil = now + LOCALAPI_REPROBE_INTERVAL_MS;
          if (localApiConsecutiveFailures === LOCALAPI_MAX_CONSECUTIVE_FAILURES) {
            warnFn(
              `[tailscale] LocalAPI fallback disabled after ${localApiConsecutiveFailures} consecutive failures; re-probing in ${LOCALAPI_REPROBE_INTERVAL_MS / 6e4} minutes`
            );
          }
        }
      }
      async function tryPath(pathName, errors, now) {
        if (pathName === "localapi") {
          if (isLocalApiCircuitOpen(now)) {
            errors.push({ path: "localapi", message: "skipped (circuit open)" });
            return null;
          }
          try {
            const status = await fetchViaLocalApi();
            localApiConsecutiveFailures = 0;
            localApiDisabledUntil = 0;
            preferredPath = "localapi";
            return status;
          } catch (e) {
            errors.push({ path: "localapi", message: e.message });
            recordLocalApiFailure(now);
            return null;
          }
        }
        try {
          const status = await fetchViaCli();
          preferredPath = "cli";
          return status;
        } catch (e) {
          errors.push({ path: "cli", message: e.message });
          return null;
        }
      }
      async function getStatus() {
        const now = nowFn();
        if (cachedStatus) {
          const ttl = cachedStatus.available ? cacheTtlMs : negativeCacheTtlMs;
          if (now - lastStatusUpdate < ttl) {
            return cachedStatus;
          }
        }
        const order = preferredPath === "localapi" ? ["localapi", "cli"] : ["cli", "localapi"];
        const errors = [];
        let status = null;
        for (const pathName of order) {
          status = await tryPath(pathName, errors, now);
          if (status) break;
        }
        if (!status) {
          const detail = errors.map((e) => `${e.path}: ${e.message}`).join("; ");
          status = {
            available: false,
            error: `tailscale unavailable (${detail})`,
            self: null,
            peers: []
          };
        }
        if (status.available === false && lastAvailable !== false) {
          warnFn(`[tailscale] mesh status unavailable: ${status.error}`);
        }
        lastAvailable = status.available;
        cachedStatus = status;
        lastStatusUpdate = now;
        return status;
      }
      return { getStatus };
    }
    module2.exports = {
      createTailscaleAdapter,
      normalizeStatus,
      stripTrailingDot,
      deriveMagicDnsSuffix,
      DEFAULT_LOCAL_API_ENDPOINT,
      STATUS_CACHE_TTL,
      NEGATIVE_STATUS_CACHE_TTL,
      EXEC_TIMEOUT_MS,
      LOCALAPI_MAX_CONSECUTIVE_FAILURES,
      LOCALAPI_REPROBE_INTERVAL_MS
    };
  }
});

// src/mesh.js
var require_mesh = __commonJS({
  "src/mesh.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var crypto = require("crypto");
    var { createTailscaleAdapter } = require_tailscale();
    var REGISTRY_FILENAME = "mesh-nodes.json";
    var DEFAULT_INTERVAL_MS = 15e3;
    var DEFAULT_HEALTH_TIMEOUT_MS = 5e3;
    var LATENCY_SAMPLE_LIMIT = 60;
    var STATE_REFRESH_EVERY_N_POLLS = 4;
    var VALID_PLATFORMS = ["linux", "windows-wsl", "macos", "unknown"];
    var HOSTNAME_PATTERN = /^[a-z0-9-]+$/;
    var MAX_LABEL_LENGTH = 120;
    function composeNodeUrl(node, magicDnsSuffix, pathOverride) {
      const host = magicDnsSuffix ? `${node.hostname}.${magicDnsSuffix}` : node.hostname;
      const portPart = node.port === 443 ? "" : `:${node.port}`;
      const urlPath = pathOverride !== void 0 ? pathOverride : node.healthPath;
      return `${node.protocol}://${host}${portPart}${urlPath}`;
    }
    function validateNodeInput(input) {
      if (!input || typeof input !== "object") {
        throw new Error("registerNode requires an options object");
      }
      const { hostname, port = 443, healthPath = "/health", platform = "unknown" } = input;
      if (typeof hostname !== "string" || !HOSTNAME_PATTERN.test(hostname)) {
        throw new Error(
          `Invalid hostname: must be lowercase letters, digits, and hyphens only (got ${JSON.stringify(hostname)})`
        );
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port: must be an integer between 1 and 65535 (got ${port})`);
      }
      if (typeof healthPath !== "string" || !healthPath.startsWith("/")) {
        throw new Error(`Invalid healthPath: must be a string starting with "/" (got ${healthPath})`);
      }
      if (!VALID_PLATFORMS.includes(platform)) {
        throw new Error(
          `Invalid platform: must be one of ${VALID_PLATFORMS.join(", ")} (got ${platform})`
        );
      }
      if (input.label !== void 0 && typeof input.label !== "string") {
        throw new Error("Invalid label: must be a string");
      }
      if (input.label && input.label.length > MAX_LABEL_LENGTH) {
        throw new Error(`Invalid label: must be at most ${MAX_LABEL_LENGTH} characters`);
      }
      if (input.registeredBy !== void 0 && typeof input.registeredBy !== "string") {
        throw new Error("Invalid registeredBy: must be a string");
      }
      return {
        hostname,
        port,
        protocol: "https",
        healthPath,
        platform,
        label: input.label || hostname,
        registeredBy: input.registeredBy || "unknown"
      };
    }
    function pickNumber(...candidates) {
      for (const value of candidates) {
        if (typeof value === "number" && Number.isFinite(value)) return value;
      }
      return null;
    }
    function extractNodeCosts(state2) {
      if (!state2 || typeof state2 !== "object") return null;
      const llmUsage = state2.llmUsage && typeof state2.llmUsage === "object" ? state2.llmUsage : {};
      const tokenStats = state2.tokenStats && typeof state2.tokenStats === "object" ? state2.tokenStats : {};
      return {
        cost24h: pickNumber(llmUsage.usage24h?.cost, llmUsage.cost24h, tokenStats.cost24h),
        cost7d: pickNumber(llmUsage.usage7d?.cost, llmUsage.cost7d, tokenStats.cost7d),
        totalTokens: pickNumber(tokenStats.totalTokens, tokenStats.total, llmUsage.totalTokens),
        version: typeof state2.version === "string" ? state2.version : null
      };
    }
    function extractNodeVitals(state2) {
      if (!state2 || typeof state2 !== "object") return null;
      const vitals = state2.vitals;
      if (!vitals || typeof vitals !== "object") return null;
      const cpu = vitals.cpu && typeof vitals.cpu === "object" ? vitals.cpu : {};
      const memory = vitals.memory && typeof vitals.memory === "object" ? vitals.memory : {};
      const disk = vitals.disk && typeof vitals.disk === "object" ? vitals.disk : {};
      const load = Array.isArray(cpu.loadAvg) ? pickNumber(cpu.loadAvg[0]) : pickNumber(cpu.load);
      const uptimeOk = typeof vitals.uptime === "string" || typeof vitals.uptime === "number" && Number.isFinite(vitals.uptime);
      return {
        hostname: typeof vitals.hostname === "string" ? vitals.hostname : null,
        uptime: uptimeOk ? vitals.uptime : null,
        cpu: {
          load,
          percent: pickNumber(cpu.usage, cpu.percent, cpu.pct),
          cores: pickNumber(cpu.cores)
        },
        memory: {
          used: pickNumber(memory.used),
          total: pickNumber(memory.total),
          pct: pickNumber(memory.percent, memory.pct)
        },
        disk: {
          used: pickNumber(disk.used),
          free: pickNumber(disk.free),
          total: pickNumber(disk.total),
          pct: pickNumber(disk.percent, disk.pct)
        },
        temperature: pickNumber(vitals.temperature)
      };
    }
    function createInitialHealth() {
      return {
        status: "unknown",
        latencyMs: null,
        lastChecked: null,
        lastOnline: null,
        consecutiveFailures: 0,
        latencySamples: [],
        version: null
      };
    }
    function createMesh(options = {}) {
      const {
        stateDir,
        intervalMs = DEFAULT_INTERVAL_MS,
        healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
        fetchFn = (...args2) => globalThis.fetch(...args2),
        tailscale = createTailscaleAdapter(),
        onChange = null,
        nowFn = Date.now
      } = options;
      if (!stateDir || typeof stateDir !== "string") {
        throw new Error("createMesh requires a stateDir string");
      }
      const registryFile = path2.join(stateDir, REGISTRY_FILENAME);
      let nodes = loadRegistry();
      const health = {};
      const nodeStats = {};
      let pollTimer = null;
      let pollCycle = 0;
      function loadRegistry() {
        try {
          if (!fs2.existsSync(registryFile)) return [];
          const raw = JSON.parse(fs2.readFileSync(registryFile, "utf8"));
          const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.nodes) ? raw.nodes : [];
          return list.filter((n) => n && typeof n === "object" && typeof n.hostname === "string");
        } catch (e) {
          console.error(`[Mesh] Failed to load registry from ${registryFile}:`, e.message);
          return [];
        }
      }
      function saveRegistry() {
        fs2.mkdirSync(stateDir, { recursive: true });
        const tmpFile = `${registryFile}.tmp-${process.pid}`;
        fs2.writeFileSync(tmpFile, JSON.stringify({ nodes }, null, 2));
        fs2.renameSync(tmpFile, registryFile);
      }
      function registerNode(input) {
        const validated = validateNodeInput(input);
        if (nodes.some((n) => n.hostname === validated.hostname)) {
          throw new Error(`Node already registered: ${validated.hostname}`);
        }
        const record = {
          id: crypto.randomUUID(),
          ...validated,
          registeredAt: new Date(nowFn()).toISOString()
        };
        nodes = [...nodes, record];
        saveRegistry();
        return record;
      }
      function unregisterNode(idOrHostname) {
        const target = nodes.find((n) => n.id === idOrHostname || n.hostname === idOrHostname);
        if (!target) {
          throw new Error(`Unknown node: ${idOrHostname}`);
        }
        nodes = nodes.filter((n) => n.id !== target.id);
        delete health[target.id];
        delete nodeStats[target.id];
        saveRegistry();
        return target;
      }
      function timeoutSignal(ms) {
        if (globalThis.AbortSignal && typeof globalThis.AbortSignal.timeout === "function") {
          return globalThis.AbortSignal.timeout(ms);
        }
        return void 0;
      }
      function emitChange(node, previousStatus, nextHealth) {
        if (typeof onChange !== "function") return;
        try {
          onChange({ node, previousStatus, status: nextHealth.status, health: nextHealth });
        } catch (e) {
          console.error("[Mesh] onChange callback failed:", e.message);
        }
      }
      async function fetchNodeState(node, magicDnsSuffix) {
        try {
          const url = composeNodeUrl(node, magicDnsSuffix, "/api/state");
          const res = await fetchFn(url, { signal: timeoutSignal(healthTimeoutMs) });
          if (!res || res.ok !== true) return null;
          return await res.json();
        } catch (e) {
          return null;
        }
      }
      function updateNodeStatsCache(node, remoteState) {
        if (!remoteState) return;
        const vitals = extractNodeVitals(remoteState);
        nodeStats[node.id] = {
          costs: extractNodeCosts(remoteState),
          vitals,
          vitalsAt: vitals ? nowFn() : null
        };
      }
      function failureHealth(prev, peer, checkedAt) {
        const status = peer && peer.online === false ? "offline" : "unreachable";
        return {
          status,
          latencyMs: null,
          lastChecked: checkedAt,
          lastOnline: prev.lastOnline,
          consecutiveFailures: prev.consecutiveFailures + 1,
          latencySamples: prev.latencySamples,
          version: prev.version
        };
      }
      async function pollNode(node, tsStatus, cycle) {
        const suffix = tsStatus.available && tsStatus.self ? tsStatus.self.magicDnsSuffix : "";
        const peer = tsStatus.available && Array.isArray(tsStatus.peers) ? tsStatus.peers.find((p) => p.hostname === node.hostname) : null;
        const prev = health[node.id] || createInitialHealth();
        const startedAt = nowFn();
        let next;
        try {
          const url = composeNodeUrl(node, suffix);
          const res = await fetchFn(url, { signal: timeoutSignal(healthTimeoutMs) });
          const latencyMs = nowFn() - startedAt;
          if (res && res.ok === true) {
            let version = prev.version;
            let body = null;
            try {
              body = await res.json();
            } catch (e) {
            }
            if (body && typeof body.version === "string") {
              version = body.version;
            }
            const stateDue = cycle % STATE_REFRESH_EVERY_N_POLLS === 0 || !nodeStats[node.id] || version === null;
            if (stateDue) {
              const remoteState = await fetchNodeState(node, suffix);
              updateNodeStatsCache(node, remoteState);
              if (remoteState && typeof remoteState.version === "string") {
                version = remoteState.version;
              }
            }
            next = {
              status: "online",
              latencyMs,
              lastChecked: startedAt,
              lastOnline: startedAt,
              consecutiveFailures: 0,
              latencySamples: [...prev.latencySamples, latencyMs].slice(-LATENCY_SAMPLE_LIMIT),
              version
            };
          } else {
            next = failureHealth(prev, peer, startedAt);
          }
        } catch (e) {
          next = failureHealth(prev, peer, startedAt);
        }
        health[node.id] = next;
        if (prev.status !== next.status) {
          emitChange(node, prev.status, next);
        }
      }
      async function _pollOnce() {
        const tsStatus = await tailscale.getStatus();
        const cycle = pollCycle++;
        await Promise.all(nodes.map((node) => pollNode(node, tsStatus, cycle)));
      }
      function start() {
        if (pollTimer) return;
        _pollOnce().catch((e) => console.error("[Mesh] Poll failed:", e.message));
        pollTimer = setInterval(() => {
          _pollOnce().catch((e) => console.error("[Mesh] Poll failed:", e.message));
        }, intervalMs);
        if (typeof pollTimer.unref === "function") pollTimer.unref();
        console.log(`[Mesh] Health poller started (${intervalMs}ms interval)`);
      }
      function stop() {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
          console.log("[Mesh] Health poller stopped");
        }
      }
      async function discoverPeers() {
        const tsStatus = await tailscale.getStatus();
        if (!tsStatus.available) {
          return {
            available: false,
            error: tsStatus.error || "tailscale unavailable",
            candidates: nodes.map((n) => ({
              hostname: n.hostname,
              fqdn: null,
              ips: [],
              online: null,
              os: n.platform,
              lastSeen: null,
              registered: true,
              nodeId: n.id
            }))
          };
        }
        const candidates = tsStatus.peers.map((peer) => {
          const registeredNode = nodes.find((n) => n.hostname === peer.hostname);
          return {
            hostname: peer.hostname,
            fqdn: peer.fqdn,
            ips: peer.ips,
            online: peer.online,
            os: peer.os,
            lastSeen: peer.lastSeen,
            registered: !!registeredNode,
            nodeId: registeredNode ? registeredNode.id : null
          };
        });
        const peerHostnames = new Set(tsStatus.peers.map((p) => p.hostname));
        const orphans = nodes.filter((n) => !peerHostnames.has(n.hostname)).map((n) => ({
          hostname: n.hostname,
          fqdn: null,
          ips: [],
          online: null,
          os: n.platform,
          lastSeen: null,
          registered: true,
          nodeId: n.id
        }));
        return { available: true, candidates: [...candidates, ...orphans] };
      }
      async function collectNodeStats(node) {
        const tsStatus = await tailscale.getStatus();
        const suffix = tsStatus.available && tsStatus.self ? tsStatus.self.magicDnsSuffix : "";
        const remoteState = await fetchNodeState(node, suffix);
        updateNodeStatsCache(node, remoteState);
        return extractNodeCosts(remoteState);
      }
      async function getFleetCosts() {
        const results = await Promise.all(
          nodes.map(async (node) => ({ node, stats: await collectNodeStats(node) }))
        );
        const byNode = {};
        let cost24h = 0;
        let cost7d = 0;
        let nodesReporting = 0;
        for (const { node, stats } of results) {
          byNode[node.id] = { hostname: node.hostname, label: node.label, stats };
          if (stats && (stats.cost24h !== null || stats.cost7d !== null)) {
            nodesReporting++;
            if (stats.cost24h !== null) cost24h += stats.cost24h;
            if (stats.cost7d !== null) cost7d += stats.cost7d;
          }
        }
        return { byNode, totals: { cost24h, cost7d, nodesReporting } };
      }
      async function getState() {
        const [tsStatus, discovery] = await Promise.all([tailscale.getStatus(), discoverPeers()]);
        const suffix = tsStatus.available && tsStatus.self ? tsStatus.self.magicDnsSuffix : "";
        return {
          self: tsStatus.available ? tsStatus.self : null,
          tailscale: {
            available: tsStatus.available,
            error: tsStatus.available ? null : tsStatus.error
          },
          nodes: nodes.map((node) => {
            const stats = nodeStats[node.id];
            return {
              ...node,
              url: composeNodeUrl(node, suffix),
              health: health[node.id] || createInitialHealth(),
              vitals: stats ? stats.vitals : null,
              vitalsAt: stats ? stats.vitalsAt : null
            };
          }),
          candidates: discovery.candidates,
          intervalMs,
          timestamp: nowFn()
        };
      }
      return {
        start,
        stop,
        getState,
        registerNode,
        unregisterNode,
        discoverPeers,
        getFleetCosts,
        collectNodeStats,
        _pollOnce
      };
    }
    module2.exports = {
      createMesh,
      composeNodeUrl,
      validateNodeInput,
      extractNodeCosts,
      extractNodeVitals,
      LATENCY_SAMPLE_LIMIT,
      STATE_REFRESH_EVERY_N_POLLS,
      VALID_PLATFORMS,
      DEFAULT_INTERVAL_MS,
      DEFAULT_HEALTH_TIMEOUT_MS
    };
  }
});

// src/federation.js
var require_federation = __commonJS({
  "src/federation.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var crypto = require("crypto");
    var REGISTRY_FILENAME = "federation.json";
    var DEFAULT_INTERVAL_MS = 3e4;
    var DEFAULT_TIMEOUT_MS = 5e3;
    var DEFAULT_WRITE_TIMEOUT_MS = 1e4;
    var MAX_LABEL_LENGTH = 120;
    var MAX_TOKEN_LENGTH = 512;
    var MAX_REMOTE_BODY_CHARS = 4096;
    var MAX_PENDING_LESSONS = 10;
    var LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]"]);
    var REMOTE_ID_RE = /^[a-z]+_[0-9a-f]+$/i;
    var KANBAN_STATUSES = ["inbox", "assigned", "inprogress", "review", "done", "failed"];
    function badRequest(message) {
      const err = new Error(message);
      err.statusCode = 400;
      return err;
    }
    function requireRemoteEntityId(value, label) {
      if (typeof value !== "string" || !REMOTE_ID_RE.test(value)) {
        throw badRequest(`Invalid ${label}: expected an id like les_a1b2c3`);
      }
      return value;
    }
    var WRITE_ACTIONS = {
      "lesson.approve": {
        validate(params) {
          return { lessonId: requireRemoteEntityId(params.lessonId, "lessonId") };
        },
        request(baseUrl, params) {
          return {
            method: "POST",
            url: `${baseUrl}/api/fleet/evolution/lessons/${encodeURIComponent(params.lessonId)}/approve`
          };
        }
      },
      "lesson.reject": {
        validate(params) {
          return { lessonId: requireRemoteEntityId(params.lessonId, "lessonId") };
        },
        request(baseUrl, params) {
          return {
            method: "POST",
            url: `${baseUrl}/api/fleet/evolution/lessons/${encodeURIComponent(params.lessonId)}/reject`
          };
        }
      },
      "gate.set": {
        validate(params) {
          if (typeof params.gate !== "boolean") {
            throw badRequest("Invalid gate: must be a boolean");
          }
          return { gate: params.gate };
        },
        request(baseUrl, params) {
          return {
            method: "PUT",
            url: `${baseUrl}/api/fleet/evolution/gate`,
            body: { gate: params.gate }
          };
        }
      },
      "task.move": {
        validate(params) {
          const out = {
            taskId: requireRemoteEntityId(params.taskId, "taskId")
          };
          if (typeof params.status !== "string" || !KANBAN_STATUSES.includes(params.status)) {
            throw badRequest(`Invalid status: must be one of ${KANBAN_STATUSES.join(", ")}`);
          }
          out.status = params.status;
          if (params.order !== void 0) {
            if (typeof params.order !== "number" || !Number.isFinite(params.order)) {
              throw badRequest("Invalid order: must be a finite number");
            }
            out.order = params.order;
          }
          return out;
        },
        request(baseUrl, params) {
          const body = { status: params.status };
          if (params.order !== void 0) body.order = params.order;
          return {
            method: "POST",
            url: `${baseUrl}/api/fleet/kanban/tasks/${encodeURIComponent(params.taskId)}/move`,
            body
          };
        }
      }
    };
    function validateBaseUrl(baseUrl) {
      if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
        throw new Error("Invalid baseUrl: must be a non-empty string");
      }
      let parsed;
      try {
        parsed = new URL(baseUrl.trim());
      } catch (e) {
        throw new Error(`Invalid baseUrl: not a parseable URL (${baseUrl})`);
      }
      const isLoopbackHttp = parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
      if (parsed.protocol !== "https:" && !isLoopbackHttp) {
        throw new Error(`Invalid baseUrl: only https:// URLs are allowed (got ${parsed.protocol}//)`);
      }
      if (parsed.username || parsed.password) {
        throw new Error("Invalid baseUrl: credentials in the URL are not allowed");
      }
      const pathname = parsed.pathname.replace(/\/+$/, "");
      return `${parsed.origin}${pathname}`;
    }
    function validateRemoteInput(input) {
      if (!input || typeof input !== "object") {
        throw new Error("addRemote requires an options object");
      }
      if (typeof input.label !== "string" || input.label.trim().length === 0) {
        throw new Error("Invalid label: must be a non-empty string");
      }
      if (input.label.length > MAX_LABEL_LENGTH) {
        throw new Error(`Invalid label: must be at most ${MAX_LABEL_LENGTH} characters`);
      }
      const baseUrl = validateBaseUrl(input.baseUrl);
      if (input.token !== void 0 && input.token !== null && typeof input.token !== "string") {
        throw new Error("Invalid token: must be a string when provided");
      }
      if (input.token && input.token.length > MAX_TOKEN_LENGTH) {
        throw new Error(`Invalid token: must be at most ${MAX_TOKEN_LENGTH} characters`);
      }
      if (input.addedBy !== void 0 && typeof input.addedBy !== "string") {
        throw new Error("Invalid addedBy: must be a string");
      }
      if (input.allowWrites !== void 0 && typeof input.allowWrites !== "boolean") {
        throw new Error("Invalid allowWrites: must be a boolean when provided");
      }
      return {
        label: input.label.trim(),
        baseUrl,
        token: input.token && input.token.length > 0 ? input.token : null,
        addedBy: input.addedBy || "unknown",
        allowWrites: input.allowWrites === true
        // writes are OPT-IN, default off
      };
    }
    function pickNumber(...candidates) {
      for (const value of candidates) {
        if (typeof value === "number" && Number.isFinite(value)) return value;
      }
      return null;
    }
    function extractRemoteSummary(state2) {
      if (!state2 || typeof state2 !== "object") return null;
      const fleet2 = state2.fleet && typeof state2.fleet === "object" ? state2.fleet : {};
      const vitals = state2.vitals && typeof state2.vitals === "object" ? state2.vitals : {};
      const mesh = fleet2.mesh && typeof fleet2.mesh === "object" ? { nodes: pickNumber(fleet2.mesh.nodes), online: pickNumber(fleet2.mesh.online) } : null;
      const kanban = fleet2.kanban && typeof fleet2.kanban === "object" ? {
        counts: fleet2.kanban.counts && typeof fleet2.kanban.counts === "object" ? fleet2.kanban.counts : {},
        staleCount: pickNumber(fleet2.kanban.staleCount)
      } : null;
      const evolution = fleet2.evolution && typeof fleet2.evolution === "object" ? {
        gate: typeof fleet2.evolution.gate === "boolean" ? fleet2.evolution.gate : null,
        pendingCount: pickNumber(fleet2.evolution.pendingCount)
      } : null;
      const alerts = fleet2.alerts && typeof fleet2.alerts === "object" ? { recent: pickNumber(fleet2.alerts.recent) } : null;
      return {
        hostname: typeof vitals.hostname === "string" && vitals.hostname ? vitals.hostname : null,
        mesh,
        kanban,
        evolution,
        alerts
      };
    }
    function extractPendingLessons(body) {
      if (!body || typeof body !== "object" || !Array.isArray(body.lessons)) return null;
      return body.lessons.filter((l) => l && typeof l === "object" && l.status === "pending" && typeof l.id === "string").slice(0, MAX_PENDING_LESSONS).map((l) => ({
        id: l.id,
        title: typeof l.title === "string" ? l.title : "",
        author: typeof l.author === "string" ? l.author : "",
        ts: typeof l.ts === "string" ? l.ts : ""
      }));
    }
    function createInitialStatus() {
      return {
        reachable: null,
        // null = never checked yet
        lastChecked: null,
        lastError: null,
        latencyMs: null,
        summary: null,
        // last-known summary survives outages
        pendingLessons: null
        // null = unknown (enrichment unavailable)
      };
    }
    function redactRemote(remote) {
      const { token, ...rest } = remote;
      return { ...rest, hasToken: !!token };
    }
    function createFederation(options = {}) {
      const {
        stateDir,
        intervalMs = DEFAULT_INTERVAL_MS,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        writeTimeoutMs = DEFAULT_WRITE_TIMEOUT_MS,
        fetchFn = (...args2) => globalThis.fetch(...args2),
        onChange = null,
        nowFn = Date.now
      } = options;
      if (!stateDir || typeof stateDir !== "string") {
        throw new Error("createFederation requires a stateDir string");
      }
      const registryFile = path2.join(stateDir, REGISTRY_FILENAME);
      let remotes = loadRegistry();
      const statuses = {};
      let pollTimer = null;
      function loadRegistry() {
        try {
          if (!fs2.existsSync(registryFile)) return [];
          const raw = JSON.parse(fs2.readFileSync(registryFile, "utf8"));
          const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.remotes) ? raw.remotes : [];
          return list.filter(
            (r) => r && typeof r === "object" && typeof r.baseUrl === "string" && typeof r.id === "string"
          ).map((r) => ({ ...r, allowWrites: r.allowWrites === true }));
        } catch (e) {
          console.error(`[Federation] Failed to load registry from ${registryFile}:`, e.message);
          return [];
        }
      }
      function saveRegistry() {
        fs2.mkdirSync(stateDir, { recursive: true });
        const tmpFile = `${registryFile}.tmp-${process.pid}`;
        fs2.writeFileSync(tmpFile, JSON.stringify({ remotes }, null, 2));
        fs2.renameSync(tmpFile, registryFile);
      }
      function addRemote(input) {
        const validated = validateRemoteInput(input);
        if (remotes.some((r) => r.baseUrl === validated.baseUrl)) {
          throw new Error(`Remote already registered: ${validated.baseUrl}`);
        }
        const record = {
          id: crypto.randomUUID(),
          label: validated.label,
          baseUrl: validated.baseUrl,
          token: validated.token,
          addedAt: new Date(nowFn()).toISOString(),
          addedBy: validated.addedBy,
          allowWrites: validated.allowWrites
        };
        remotes = [...remotes, record];
        saveRegistry();
        pollRemote(record).catch((e) => {
          console.error("[Federation] Initial probe failed:", e.message);
        });
        return redactRemote(record);
      }
      function removeRemote(id) {
        const target = remotes.find((r) => r.id === id);
        if (!target) {
          throw new Error(`Unknown remote: ${id}`);
        }
        remotes = remotes.filter((r) => r.id !== target.id);
        delete statuses[target.id];
        saveRegistry();
        return redactRemote(target);
      }
      function setRemoteWrites(id, allowWrites) {
        if (typeof allowWrites !== "boolean") {
          throw badRequest("Invalid allowWrites: must be a boolean");
        }
        const target = remotes.find((r) => r.id === id);
        if (!target) {
          throw new Error(`Unknown remote: ${id}`);
        }
        const updated = { ...target, allowWrites };
        remotes = remotes.map((r) => r.id === id ? updated : r);
        saveRegistry();
        return redactRemote(updated);
      }
      async function readRemoteBody(res) {
        try {
          if (res && typeof res.text === "function") {
            const text = await res.text();
            if (text.length <= MAX_REMOTE_BODY_CHARS) {
              try {
                return JSON.parse(text);
              } catch (e) {
                return text;
              }
            }
            return text.slice(0, MAX_REMOTE_BODY_CHARS);
          }
          if (res && typeof res.json === "function") {
            const body = await res.json();
            const text = JSON.stringify(body) ?? "";
            return text.length <= MAX_REMOTE_BODY_CHARS ? body : text.slice(0, MAX_REMOTE_BODY_CHARS);
          }
        } catch (e) {
          return null;
        }
        return null;
      }
      async function performRemoteAction(remoteId, action, params, options2 = {}) {
        const remote = remotes.find((r) => r.id === remoteId);
        if (!remote) {
          throw new Error(`Unknown remote: ${remoteId}`);
        }
        const spec = Object.prototype.hasOwnProperty.call(WRITE_ACTIONS, action) ? WRITE_ACTIONS[action] : null;
        if (!spec) {
          throw badRequest(
            `Unsupported federation action "${String(action)}". Allowed: ${Object.keys(WRITE_ACTIONS).join(", ")}`
          );
        }
        if (remote.allowWrites !== true) {
          const err = new Error(
            `Write actions are disabled for remote "${remote.label}" \u2014 enable allowWrites first`
          );
          err.statusCode = 403;
          throw err;
        }
        const safeParams = spec.validate(params && typeof params === "object" ? params : {});
        const request = spec.request(remote.baseUrl, safeParams);
        const actor = typeof options2.actor === "string" && options2.actor.trim().length > 0 ? options2.actor.trim() : "anonymous";
        const headers = {
          "Content-Type": "application/json",
          // Forward the LOCAL operator so the remote audits the real human, not
          // this server's machine identity.
          "Tailscale-User-Login": actor
        };
        if (remote.token) headers.Authorization = `Bearer ${remote.token}`;
        let res;
        try {
          res = await fetchFn(request.url, {
            method: request.method,
            headers,
            body: request.body !== void 0 ? JSON.stringify(request.body) : void 0,
            signal: timeoutSignal(writeTimeoutMs)
          });
        } catch (e) {
          const err = new Error(`Remote request failed: ${e && e.message ? e.message : "unknown"}`);
          err.statusCode = 502;
          throw err;
        }
        return {
          ok: !!(res && res.ok === true),
          action,
          remoteId: remote.id,
          remoteStatus: res && Number.isFinite(res.status) ? res.status : null,
          remoteBody: await readRemoteBody(res)
        };
      }
      function timeoutSignal(ms) {
        if (globalThis.AbortSignal && typeof globalThis.AbortSignal.timeout === "function") {
          return globalThis.AbortSignal.timeout(ms);
        }
        return void 0;
      }
      function emitChange(remote, previousReachable, status) {
        if (typeof onChange !== "function") return;
        try {
          onChange({
            remote: redactRemote(remote),
            previousReachable,
            reachable: status.reachable,
            status
          });
        } catch (e) {
          console.error("[Federation] onChange callback failed:", e.message);
        }
      }
      async function fetchPendingLessons(remote, headers) {
        try {
          const res = await fetchFn(`${remote.baseUrl}/api/fleet/evolution`, {
            headers,
            signal: timeoutSignal(timeoutMs)
          });
          if (!res || res.ok !== true) return null;
          return extractPendingLessons(await res.json());
        } catch (e) {
          return null;
        }
      }
      async function pollRemote(remote) {
        const prev = statuses[remote.id] || createInitialStatus();
        const startedAt = nowFn();
        let next;
        try {
          const headers = {};
          if (remote.token) headers.Authorization = `Bearer ${remote.token}`;
          const res = await fetchFn(`${remote.baseUrl}/api/state`, {
            headers,
            signal: timeoutSignal(timeoutMs)
          });
          const latencyMs = nowFn() - startedAt;
          if (res && res.ok === true) {
            let summary = prev.summary;
            try {
              summary = extractRemoteSummary(await res.json());
            } catch (e) {
            }
            next = {
              reachable: true,
              lastChecked: startedAt,
              lastError: null,
              latencyMs,
              summary,
              pendingLessons: await fetchPendingLessons(remote, headers)
            };
          } else {
            next = {
              reachable: false,
              lastChecked: startedAt,
              lastError: res ? `HTTP ${res.status}` : "No response",
              latencyMs: null,
              summary: prev.summary,
              pendingLessons: prev.pendingLessons ?? null
            };
          }
        } catch (e) {
          next = {
            reachable: false,
            lastChecked: startedAt,
            lastError: e && e.message ? e.message : "Request failed",
            latencyMs: null,
            summary: prev.summary,
            pendingLessons: prev.pendingLessons ?? null
          };
        }
        if (!remotes.some((r) => r.id === remote.id)) return;
        statuses[remote.id] = next;
        if (prev.reachable !== next.reachable) {
          emitChange(remote, prev.reachable, next);
        }
      }
      async function _pollOnce() {
        await Promise.all(remotes.map((remote) => pollRemote(remote)));
      }
      function start() {
        if (pollTimer) return;
        _pollOnce().catch((e) => console.error("[Federation] Poll failed:", e.message));
        pollTimer = setInterval(() => {
          _pollOnce().catch((e) => console.error("[Federation] Poll failed:", e.message));
        }, intervalMs);
        if (typeof pollTimer.unref === "function") pollTimer.unref();
        console.log(`[Federation] Remote dashboard poller started (${intervalMs}ms interval)`);
      }
      function stop() {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
          console.log("[Federation] Remote dashboard poller stopped");
        }
      }
      function getState() {
        return {
          remotes: remotes.map((remote) => ({
            ...redactRemote(remote),
            status: statuses[remote.id] || createInitialStatus()
          })),
          counts: {
            remotes: remotes.length,
            reachable: remotes.filter((r) => statuses[r.id] && statuses[r.id].reachable === true).length
          },
          intervalMs,
          timestamp: nowFn()
        };
      }
      return {
        start,
        stop,
        getState,
        addRemote,
        removeRemote,
        setRemoteWrites,
        performRemoteAction,
        _pollOnce
      };
    }
    module2.exports = {
      createFederation,
      validateBaseUrl,
      validateRemoteInput,
      extractRemoteSummary,
      extractPendingLessons,
      WRITE_ACTIONS,
      DEFAULT_INTERVAL_MS,
      DEFAULT_TIMEOUT_MS,
      DEFAULT_WRITE_TIMEOUT_MS
    };
  }
});

// src/fleet-chat.js
var require_fleet_chat = __commonJS({
  "src/fleet-chat.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var crypto = require("crypto");
    var { DatabaseSync } = require("node:sqlite");
    var MAX_NAME_CHARS = 128;
    var MAX_PAYLOAD_BYTES = 32 * 1024;
    var DEFAULT_QUERY_LIMIT = 100;
    var MAX_QUERY_LIMIT = 500;
    var DEFAULT_MAX_LOG_BYTES = 50 * 1024 * 1024;
    var DEFAULT_MAX_ROTATED_FILES = 5;
    var DEFAULT_PRUNE_MAX_AGE_DAYS = 30;
    var DEFAULT_PRUNE_MAX_ROWS = 1e5;
    var RECENT_STATE_LIMIT = 20;
    var DAY_MS = 24 * 60 * 60 * 1e3;
    var LOG_FILE_NAME = "fleet-chat.jsonl";
    var DB_FILE_NAME = "fleet-chat.db";
    function validateMessage(msg) {
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
        throw new TypeError("message must be an object");
      }
      if (typeof msg.sender !== "string" || msg.sender.length === 0) {
        throw new TypeError("sender must be a non-empty string");
      }
      if (msg.sender.length > MAX_NAME_CHARS) {
        throw new TypeError(`sender must be at most ${MAX_NAME_CHARS} characters`);
      }
      if (typeof msg.receiver !== "string" || msg.receiver.length === 0) {
        throw new TypeError("receiver must be a non-empty string");
      }
      if (msg.receiver.length > MAX_NAME_CHARS) {
        throw new TypeError(`receiver must be at most ${MAX_NAME_CHARS} characters`);
      }
      if (typeof msg.payload !== "string") {
        throw new TypeError("payload must be a string");
      }
      if (Buffer.byteLength(msg.payload, "utf8") > MAX_PAYLOAD_BYTES) {
        throw new TypeError(`payload must be at most ${MAX_PAYLOAD_BYTES} bytes`);
      }
      if (msg.toolCalls !== void 0 && !Array.isArray(msg.toolCalls)) {
        throw new TypeError("toolCalls must be an array when provided");
      }
    }
    function generateMessageId() {
      return `msg_${crypto.randomBytes(6).toString("hex")}`;
    }
    function escapeLikePattern(text) {
      return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    }
    function createFleetChat({
      stateDir,
      logsDir,
      maxLogBytes = DEFAULT_MAX_LOG_BYTES,
      maxRotatedFiles = DEFAULT_MAX_ROTATED_FILES,
      nowFn = Date.now
    } = {}) {
      if (typeof stateDir !== "string" || stateDir.length === 0) {
        throw new TypeError("stateDir must be a non-empty string");
      }
      if (typeof logsDir !== "string" || logsDir.length === 0) {
        throw new TypeError("logsDir must be a non-empty string");
      }
      fs2.mkdirSync(stateDir, { recursive: true });
      fs2.mkdirSync(logsDir, { recursive: true });
      const logFile = path2.join(logsDir, LOG_FILE_NAME);
      const db = new DatabaseSync(path2.join(stateDir, DB_FILE_NAME));
      db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender TEXT NOT NULL,
      receiver TEXT NOT NULL,
      payload TEXT NOT NULL,
      tool_calls TEXT,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
    CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver);
    CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
  `);
      const insertStmt = db.prepare(
        "INSERT INTO messages (id, sender, receiver, payload, tool_calls, ts) VALUES (?, ?, ?, ?, ?, ?)"
      );
      const subscribers = /* @__PURE__ */ new Set();
      function rowToMessage(row) {
        const message = {
          id: row.id,
          sender: row.sender,
          receiver: row.receiver,
          payload: row.payload,
          ts: Number(row.ts)
        };
        if (row.tool_calls != null) {
          try {
            message.toolCalls = JSON.parse(row.tool_calls);
          } catch (e) {
            console.error("[FleetChat] Failed to parse stored tool_calls:", e.message);
          }
        }
        return message;
      }
      function pruneRotatedLogs() {
        let rotated = [];
        try {
          rotated = fs2.readdirSync(logsDir).filter((f) => f.startsWith("fleet-chat.") && f.endsWith(".jsonl") && f !== LOG_FILE_NAME).map((f) => {
            const fullPath = path2.join(logsDir, f);
            return { name: f, mtime: fs2.statSync(fullPath).mtimeMs };
          }).sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
        } catch (e) {
          console.error("[FleetChat] Failed to list rotated logs:", e.message);
          return;
        }
        for (const old of rotated.slice(maxRotatedFiles)) {
          try {
            fs2.unlinkSync(path2.join(logsDir, old.name));
          } catch (e) {
            console.error(`[FleetChat] Failed to delete rotated log ${old.name}:`, e.message);
          }
        }
      }
      function rotateLogIfNeeded() {
        let size = 0;
        try {
          size = fs2.statSync(logFile).size;
        } catch (e) {
          return;
        }
        if (size <= maxLogBytes) return;
        const stamp = new Date(nowFn()).toISOString().replace(/[:.]/g, "-");
        let target = path2.join(logsDir, `fleet-chat.${stamp}.jsonl`);
        let counter = 1;
        while (fs2.existsSync(target)) {
          target = path2.join(logsDir, `fleet-chat.${stamp}-${counter}.jsonl`);
          counter += 1;
        }
        try {
          fs2.renameSync(logFile, target);
        } catch (e) {
          console.error("[FleetChat] Log rotation failed:", e.message);
          return;
        }
        pruneRotatedLogs();
      }
      function appendToLog(record) {
        fs2.appendFileSync(logFile, `${JSON.stringify(record)}
`, "utf8");
        rotateLogIfNeeded();
      }
      function publish(msg) {
        validateMessage(msg);
        const record = {
          id: generateMessageId(),
          sender: msg.sender,
          receiver: msg.receiver,
          payload: msg.payload,
          ts: nowFn()
        };
        if (msg.toolCalls !== void 0) {
          record.toolCalls = msg.toolCalls;
        }
        insertStmt.run(
          record.id,
          record.sender,
          record.receiver,
          record.payload,
          record.toolCalls !== void 0 ? JSON.stringify(record.toolCalls) : null,
          record.ts
        );
        appendToLog(record);
        for (const cb of subscribers) {
          try {
            cb(record);
          } catch (e) {
            console.error("[FleetChat] Subscriber callback failed:", e.message);
          }
        }
        return record;
      }
      function onMessage(cb) {
        if (typeof cb !== "function") {
          throw new TypeError("callback must be a function");
        }
        subscribers.add(cb);
        return () => {
          subscribers.delete(cb);
        };
      }
      function query({ sender, receiver, text, limit = DEFAULT_QUERY_LIMIT, before } = {}) {
        const conditions = [];
        const params = [];
        if (sender !== void 0) {
          if (typeof sender !== "string") throw new TypeError("sender filter must be a string");
          conditions.push("sender = ?");
          params.push(sender);
        }
        if (receiver !== void 0) {
          if (typeof receiver !== "string") throw new TypeError("receiver filter must be a string");
          conditions.push("receiver = ?");
          params.push(receiver);
        }
        if (text !== void 0) {
          if (typeof text !== "string") throw new TypeError("text filter must be a string");
          conditions.push("payload LIKE ? ESCAPE '\\'");
          params.push(`%${escapeLikePattern(text)}%`);
        }
        if (before !== void 0) {
          if (!Number.isFinite(before)) throw new TypeError("before filter must be a number");
          conditions.push("ts < ?");
          params.push(before);
        }
        const parsedLimit = Number(limit);
        if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
          throw new TypeError("limit must be a positive number");
        }
        const effectiveLimit = Math.min(Math.floor(parsedLimit), MAX_QUERY_LIMIT);
        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const sql = `SELECT id, sender, receiver, payload, tool_calls, ts FROM messages ${where} ORDER BY ts DESC LIMIT ?`;
        const rows = db.prepare(sql).all(...params, effectiveLimit);
        return rows.map(rowToMessage);
      }
      function prune({
        maxAgeDays = DEFAULT_PRUNE_MAX_AGE_DAYS,
        maxRows = DEFAULT_PRUNE_MAX_ROWS
      } = {}) {
        if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
          throw new TypeError("maxAgeDays must be a non-negative number");
        }
        if (!Number.isFinite(maxRows) || maxRows < 0) {
          throw new TypeError("maxRows must be a non-negative number");
        }
        const cutoff = nowFn() - maxAgeDays * DAY_MS;
        const byAge = db.prepare("DELETE FROM messages WHERE ts < ?").run(cutoff);
        const byCount = db.prepare(
          "DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY ts DESC, id DESC LIMIT ?)"
        ).run(Math.floor(maxRows));
        rotateLogIfNeeded();
        pruneRotatedLogs();
        const removedByAge = Number(byAge.changes);
        const removedByCount = Number(byCount.changes);
        return { removedByAge, removedByCount, removed: removedByAge + removedByCount };
      }
      function getState() {
        const totals = db.prepare(
          "SELECT COUNT(*) AS total, COUNT(DISTINCT sender) AS senders, COUNT(DISTINCT receiver) AS receivers FROM messages"
        ).get();
        return {
          messages: query({ limit: RECENT_STATE_LIMIT }),
          counts: {
            total: Number(totals.total),
            senders: Number(totals.senders),
            receivers: Number(totals.receivers)
          },
          subscribers: subscribers.size
        };
      }
      function close() {
        try {
          db.close();
        } catch (e) {
          console.error("[FleetChat] Failed to close database:", e.message);
        }
      }
      return { publish, onMessage, query, prune, getState, close };
    }
    module2.exports = { createFleetChat };
  }
});

// src/kanban-schema.js
var require_kanban_schema = __commonJS({
  "src/kanban-schema.js"(exports2, module2) {
    var crypto = require("crypto");
    var BOARD_VERSION = 1;
    var STATUS = Object.freeze({
      INBOX: "inbox",
      ASSIGNED: "assigned",
      INPROGRESS: "inprogress",
      REVIEW: "review",
      DONE: "done",
      FAILED: "failed"
    });
    var COLUMN_ORDER = Object.freeze([
      STATUS.INBOX,
      STATUS.ASSIGNED,
      STATUS.INPROGRESS,
      STATUS.REVIEW,
      STATUS.DONE,
      STATUS.FAILED
    ]);
    var TASK_ID_PATTERN = /^tsk_[0-9a-f]{6}$/;
    var TITLE_MAX = 200;
    var DESCRIPTION_MAX_BYTES = 10 * 1024;
    var NAME_MAX = 128;
    var COMMENT_MAX_BYTES = 4 * 1024;
    var PRIORITIES = Object.freeze([1, 2, 3]);
    var ATTEMPT_RESULTS = Object.freeze(["success", "failure"]);
    var TASK_FIELDS = Object.freeze([
      "id",
      "title",
      "description",
      "status",
      "assignee",
      "node",
      "priority",
      "due",
      "progress",
      "order",
      "parent_id",
      "attempts",
      "comments",
      "created_at",
      "updated_at"
    ]);
    var ATTEMPT_FIELDS = Object.freeze([
      "agent",
      "started_at",
      "ended_at",
      "result",
      "branch",
      "note"
    ]);
    var COMMENT_FIELDS = Object.freeze(["author", "ts", "text"]);
    function isPlainObject(v) {
      return v !== null && typeof v === "object" && !Array.isArray(v);
    }
    function isIsoDateTime(v) {
      return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v));
    }
    function isIsoDate(v) {
      return typeof v === "string" && /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(v) && !Number.isNaN(Date.parse(v));
    }
    function byteLength(v) {
      return Buffer.byteLength(v, "utf8");
    }
    function checkAttempt(attempt, basePath, errors) {
      if (!isPlainObject(attempt)) {
        errors.push({ path: basePath, reason: "attempt must be an object" });
        return;
      }
      for (const key of Object.keys(attempt)) {
        if (!ATTEMPT_FIELDS.includes(key)) {
          errors.push({ path: `${basePath}.${key}`, reason: "unknown attempt field" });
        }
      }
      if (typeof attempt.agent !== "string" || attempt.agent.length === 0) {
        errors.push({ path: `${basePath}.agent`, reason: "agent must be a non-empty string" });
      }
      if (!isIsoDateTime(attempt.started_at)) {
        errors.push({ path: `${basePath}.started_at`, reason: "started_at must be an ISO datetime" });
      }
      if (attempt.ended_at !== null && !isIsoDateTime(attempt.ended_at)) {
        errors.push({
          path: `${basePath}.ended_at`,
          reason: "ended_at must be an ISO datetime or null"
        });
      }
      if (attempt.result !== null && !ATTEMPT_RESULTS.includes(attempt.result)) {
        errors.push({
          path: `${basePath}.result`,
          reason: "result must be 'success', 'failure', or null"
        });
      }
      if (attempt.branch !== null && typeof attempt.branch !== "string") {
        errors.push({ path: `${basePath}.branch`, reason: "branch must be a string or null" });
      }
      if (attempt.note !== null && typeof attempt.note !== "string") {
        errors.push({ path: `${basePath}.note`, reason: "note must be a string or null" });
      }
    }
    function checkComment(comment, basePath, errors) {
      if (!isPlainObject(comment)) {
        errors.push({ path: basePath, reason: "comment must be an object" });
        return;
      }
      for (const key of Object.keys(comment)) {
        if (!COMMENT_FIELDS.includes(key)) {
          errors.push({ path: `${basePath}.${key}`, reason: "unknown comment field" });
        }
      }
      if (typeof comment.author !== "string" || comment.author.length === 0) {
        errors.push({ path: `${basePath}.author`, reason: "author must be a non-empty string" });
      }
      if (!isIsoDateTime(comment.ts)) {
        errors.push({ path: `${basePath}.ts`, reason: "ts must be an ISO datetime" });
      }
      if (typeof comment.text !== "string" || byteLength(comment.text) > COMMENT_MAX_BYTES) {
        errors.push({
          path: `${basePath}.text`,
          reason: `text must be a string of at most ${COMMENT_MAX_BYTES} bytes`
        });
      }
    }
    function collectTaskErrors(task, basePath, errors) {
      if (!isPlainObject(task)) {
        errors.push({ path: basePath, reason: "task must be an object" });
        return;
      }
      for (const key of Object.keys(task)) {
        if (!TASK_FIELDS.includes(key)) {
          errors.push({ path: `${basePath}.${key}`, reason: "unknown task field" });
        }
      }
      if (typeof task.id !== "string" || !TASK_ID_PATTERN.test(task.id)) {
        errors.push({
          path: `${basePath}.id`,
          reason: "id must match 'tsk_' followed by 6 lowercase hex characters"
        });
      }
      if (typeof task.title !== "string" || task.title.length < 1 || task.title.length > TITLE_MAX) {
        errors.push({
          path: `${basePath}.title`,
          reason: `title must be a string of 1-${TITLE_MAX} characters`
        });
      }
      if (typeof task.description !== "string" || byteLength(task.description) > DESCRIPTION_MAX_BYTES) {
        errors.push({
          path: `${basePath}.description`,
          reason: `description must be a string of at most ${DESCRIPTION_MAX_BYTES} bytes`
        });
      }
      if (!COLUMN_ORDER.includes(task.status)) {
        errors.push({
          path: `${basePath}.status`,
          reason: `status must be one of: ${COLUMN_ORDER.join(", ")}`
        });
      }
      if (task.assignee !== null && (typeof task.assignee !== "string" || task.assignee.length > NAME_MAX)) {
        errors.push({
          path: `${basePath}.assignee`,
          reason: `assignee must be null or a string of at most ${NAME_MAX} characters`
        });
      }
      if (task.node !== null && (typeof task.node !== "string" || task.node.length > NAME_MAX)) {
        errors.push({
          path: `${basePath}.node`,
          reason: `node must be null or a string of at most ${NAME_MAX} characters`
        });
      }
      if (!PRIORITIES.includes(task.priority)) {
        errors.push({ path: `${basePath}.priority`, reason: "priority must be 1, 2, or 3" });
      }
      if (task.due !== null && !isIsoDate(task.due)) {
        errors.push({ path: `${basePath}.due`, reason: "due must be an ISO date or null" });
      }
      if (!Number.isInteger(task.progress) || task.progress < 0 || task.progress > 100) {
        errors.push({
          path: `${basePath}.progress`,
          reason: "progress must be an integer between 0 and 100"
        });
      }
      if (!Number.isInteger(task.order)) {
        errors.push({ path: `${basePath}.order`, reason: "order must be an integer" });
      }
      if (task.parent_id !== null && (typeof task.parent_id !== "string" || !TASK_ID_PATTERN.test(task.parent_id))) {
        errors.push({ path: `${basePath}.parent_id`, reason: "parent_id must be a task id or null" });
      }
      if (!Array.isArray(task.attempts)) {
        errors.push({ path: `${basePath}.attempts`, reason: "attempts must be an array" });
      } else {
        task.attempts.forEach((attempt, i) => {
          checkAttempt(attempt, `${basePath}.attempts[${i}]`, errors);
        });
      }
      if (!Array.isArray(task.comments)) {
        errors.push({ path: `${basePath}.comments`, reason: "comments must be an array" });
      } else {
        task.comments.forEach((comment, i) => {
          checkComment(comment, `${basePath}.comments[${i}]`, errors);
        });
      }
      if (!isIsoDateTime(task.created_at)) {
        errors.push({ path: `${basePath}.created_at`, reason: "created_at must be an ISO datetime" });
      }
      if (!isIsoDateTime(task.updated_at)) {
        errors.push({ path: `${basePath}.updated_at`, reason: "updated_at must be an ISO datetime" });
      }
    }
    function validateTask(obj) {
      const errors = [];
      collectTaskErrors(obj, "task", errors);
      return { valid: errors.length === 0, errors };
    }
    function validateBoard(obj) {
      const errors = [];
      if (!isPlainObject(obj)) {
        return { valid: false, errors: [{ path: "board", reason: "board must be an object" }] };
      }
      if (obj.version !== BOARD_VERSION) {
        errors.push({ path: "version", reason: `version must be ${BOARD_VERSION}` });
      }
      if (!isIsoDateTime(obj.updated_at)) {
        errors.push({ path: "updated_at", reason: "updated_at must be an ISO datetime" });
      }
      if (!Array.isArray(obj.tasks)) {
        errors.push({ path: "tasks", reason: "tasks must be an array" });
      } else {
        const seen = /* @__PURE__ */ new Set();
        obj.tasks.forEach((task, i) => {
          collectTaskErrors(task, `tasks[${i}]`, errors);
          if (isPlainObject(task) && typeof task.id === "string") {
            if (seen.has(task.id)) {
              errors.push({ path: `tasks[${i}].id`, reason: `duplicate task id '${task.id}'` });
            }
            seen.add(task.id);
          }
        });
      }
      return { valid: errors.length === 0, errors };
    }
    function generateTaskId() {
      return "tsk_" + crypto.randomBytes(3).toString("hex");
    }
    function createEmptyBoard() {
      return { version: BOARD_VERSION, updated_at: (/* @__PURE__ */ new Date()).toISOString(), tasks: [] };
    }
    function createTask(fields = {}) {
      if (!isPlainObject(fields)) {
        const err = new Error("createTask: fields must be an object");
        err.errors = [{ path: "task", reason: "fields must be an object" }];
        throw err;
      }
      for (const key of Object.keys(fields)) {
        if (key === "id") {
          const err = new Error("createTask: id is generated and cannot be supplied");
          err.errors = [{ path: "task.id", reason: "id is generated and cannot be supplied" }];
          throw err;
        }
        if (!TASK_FIELDS.includes(key)) {
          const err = new Error(`createTask: unknown task field '${key}'`);
          err.errors = [{ path: `task.${key}`, reason: "unknown task field" }];
          throw err;
        }
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const task = {
        id: generateTaskId(),
        title: fields.title,
        description: fields.description ?? "",
        status: fields.status ?? STATUS.INBOX,
        assignee: fields.assignee ?? null,
        node: fields.node ?? null,
        priority: fields.priority ?? 2,
        due: fields.due ?? null,
        progress: fields.progress ?? 0,
        order: fields.order ?? 0,
        parent_id: fields.parent_id ?? null,
        attempts: fields.attempts ?? [],
        comments: fields.comments ?? [],
        created_at: fields.created_at ?? now,
        updated_at: fields.updated_at ?? now
      };
      const result = validateTask(task);
      if (!result.valid) {
        const summary = result.errors.map((e) => `${e.path}: ${e.reason}`).join("; ");
        const err = new Error(`createTask: invalid task \u2014 ${summary}`);
        err.errors = result.errors;
        throw err;
      }
      return task;
    }
    module2.exports = {
      BOARD_VERSION,
      STATUS,
      COLUMN_ORDER,
      TASK_ID_PATTERN,
      TASK_FIELDS,
      validateBoard,
      validateTask,
      createTask,
      createEmptyBoard,
      generateTaskId
    };
  }
});

// src/state-safety.js
var require_state_safety = __commonJS({
  "src/state-safety.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    function createSafeStore(options = {}) {
      const {
        filePath,
        validate,
        backupDir,
        maxBackups = 10,
        createDefault = () => null,
        debounceMs = 250
      } = options;
      if (!filePath) throw new Error("createSafeStore: filePath is required");
      if (typeof validate !== "function") throw new Error("createSafeStore: validate is required");
      if (!backupDir) throw new Error("createSafeStore: backupDir is required");
      const dir = path2.dirname(filePath);
      const baseName = path2.basename(filePath, path2.extname(filePath));
      let lastWrittenContent = null;
      let backupSeq = 0;
      function fsTimestamp() {
        return (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
      }
      function ensureDirs() {
        fs2.mkdirSync(dir, { recursive: true });
        fs2.mkdirSync(backupDir, { recursive: true });
      }
      function safeValidate(obj) {
        try {
          const result = validate(obj);
          if (result && typeof result.valid === "boolean") return result;
          return { valid: false, errors: [{ path: "", reason: "validator returned no result" }] };
        } catch (e) {
          return { valid: false, errors: [{ path: "", reason: `validator threw: ${e.message}` }] };
        }
      }
      function serialize(obj) {
        return JSON.stringify(obj, null, 2) + "\n";
      }
      function atomicWrite(targetPath, content) {
        const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
        fs2.writeFileSync(tmpPath, content, "utf8");
        fs2.renameSync(tmpPath, targetPath);
        if (targetPath === filePath) lastWrittenContent = content;
      }
      function readRaw() {
        try {
          return fs2.readFileSync(filePath, "utf8");
        } catch (e) {
          return null;
        }
      }
      function readValidFile(p) {
        try {
          const data = JSON.parse(fs2.readFileSync(p, "utf8"));
          return safeValidate(data).valid ? data : null;
        } catch (e) {
          return null;
        }
      }
      function listBackups() {
        let entries = [];
        try {
          entries = fs2.readdirSync(backupDir);
        } catch (e) {
          return [];
        }
        return entries.filter((name) => name.startsWith(`${baseName}.`) && name.endsWith(".json")).sort().reverse().map((name) => ({ name, path: path2.join(backupDir, name) }));
      }
      function pruneBackups() {
        const backups = listBackups();
        for (const backup of backups.slice(maxBackups)) {
          try {
            fs2.unlinkSync(backup.path);
          } catch (e) {
          }
        }
      }
      function backupPrevious(prevContent) {
        let prevData;
        try {
          prevData = JSON.parse(prevContent);
        } catch (e) {
          return;
        }
        if (!safeValidate(prevData).valid) return;
        backupSeq += 1;
        const seq = String(backupSeq).padStart(6, "0");
        const backupPath = path2.join(backupDir, `${baseName}.${fsTimestamp()}-${seq}.json`);
        fs2.writeFileSync(backupPath, prevContent, "utf8");
        pruneBackups();
      }
      function quarantine() {
        const quarantinedPath = path2.join(dir, `${baseName}.quarantine.${fsTimestamp()}.json`);
        try {
          fs2.renameSync(filePath, quarantinedPath);
          return quarantinedPath;
        } catch (e) {
          return null;
        }
      }
      function write(obj) {
        const result = safeValidate(obj);
        if (!result.valid) {
          const summary = result.errors.map((e) => `${e.path}: ${e.reason}`).join("; ");
          const err = new Error(`Refusing to write invalid state to ${filePath} \u2014 ${summary}`);
          err.errors = result.errors;
          throw err;
        }
        ensureDirs();
        const prev = readRaw();
        atomicWrite(filePath, serialize(obj));
        if (prev !== null) backupPrevious(prev);
      }
      function read() {
        if (!fs2.existsSync(filePath)) {
          return {
            data: createDefault(),
            restored: false,
            quarantinedPath: null,
            restoredFrom: null,
            usedDefault: true
          };
        }
        const data = readValidFile(filePath);
        if (data !== null) {
          return {
            data,
            restored: false,
            quarantinedPath: null,
            restoredFrom: null,
            usedDefault: false
          };
        }
        const quarantinedPath = quarantine();
        for (const backup of listBackups()) {
          const candidate = readValidFile(backup.path);
          if (candidate !== null) {
            try {
              ensureDirs();
              atomicWrite(filePath, serialize(candidate));
            } catch (e) {
              console.error(`[StateSafety] Failed to restore ${filePath}:`, e.message);
            }
            return {
              data: candidate,
              restored: true,
              quarantinedPath,
              restoredFrom: backup.path,
              usedDefault: false
            };
          }
        }
        const fallback = createDefault();
        if (fallback !== null) {
          try {
            ensureDirs();
            atomicWrite(filePath, serialize(fallback));
          } catch (e) {
            console.error(`[StateSafety] Failed to write default state to ${filePath}:`, e.message);
          }
        }
        return {
          data: fallback,
          restored: false,
          quarantinedPath,
          restoredFrom: null,
          usedDefault: true
        };
      }
      function restore() {
        for (const backup of listBackups()) {
          const candidate = readValidFile(backup.path);
          if (candidate !== null) {
            ensureDirs();
            atomicWrite(filePath, serialize(candidate));
            return { data: candidate, restoredFrom: backup.path };
          }
        }
        return null;
      }
      function watch(onExternalChange) {
        ensureDirs();
        const fileName = path2.basename(filePath);
        let timer = null;
        const handleEvent = () => {
          const raw = readRaw();
          if (raw !== null && raw === lastWrittenContent) return;
          const result = read();
          try {
            onExternalChange(result);
          } catch (e) {
            console.error(`[StateSafety] watch callback error for ${filePath}:`, e.message);
          }
        };
        const schedule = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(handleEvent, debounceMs);
        };
        let watcher = null;
        let pollTimer = null;
        try {
          watcher = fs2.watch(dir, (eventType, changedName) => {
            if (changedName && changedName !== fileName) return;
            schedule();
          });
        } catch (e) {
          if (e.code !== "EMFILE" && e.code !== "ENOSPC") throw e;
          const statSafe = () => {
            try {
              const s = fs2.statSync(filePath);
              return { mtimeMs: s.mtimeMs, size: s.size };
            } catch (statErr) {
              return null;
            }
          };
          let lastStat = statSafe();
          pollTimer = setInterval(
            () => {
              const current = statSafe();
              const changed = current === null !== (lastStat === null) || current !== null && lastStat !== null && (current.mtimeMs !== lastStat.mtimeMs || current.size !== lastStat.size);
              lastStat = current;
              if (changed) schedule();
            },
            Math.max(debounceMs, 50)
          );
          if (typeof pollTimer.unref === "function") pollTimer.unref();
        }
        return {
          close() {
            if (timer) clearTimeout(timer);
            timer = null;
            if (watcher) watcher.close();
            if (pollTimer) clearInterval(pollTimer);
          }
        };
      }
      return { read, write, restore, listBackups, watch };
    }
    module2.exports = { createSafeStore };
  }
});

// src/kanban.js
var require_kanban = __commonJS({
  "src/kanban.js"(exports2, module2) {
    var path2 = require("path");
    var schema = require_kanban_schema();
    var { createSafeStore } = require_state_safety();
    var DEFAULT_STALE_THRESHOLD_MS = 30 * 60 * 1e3;
    var DEFAULT_CHECK_INTERVAL_MS = 60 * 1e3;
    var WATCHED_STATUSES = Object.freeze([schema.STATUS.ASSIGNED, schema.STATUS.INPROGRESS]);
    function createKanban(options = {}) {
      const { stateDir, onChange, debounceMs } = options;
      if (!stateDir) throw new Error("createKanban: stateDir is required");
      const store = createSafeStore({
        filePath: path2.join(stateDir, "kanban.json"),
        backupDir: path2.join(stateDir, "backups"),
        validate: schema.validateBoard,
        createDefault: () => schema.createEmptyBoard(),
        debounceMs
      });
      const staleTaskIds = /* @__PURE__ */ new Set();
      function nowIso() {
        return (/* @__PURE__ */ new Date()).toISOString();
      }
      function emit(type, detail) {
        if (typeof onChange === "function") {
          onChange({ type, ts: nowIso(), ...detail });
        }
      }
      function readBoard() {
        return store.read().data;
      }
      function requireTask(board, id) {
        const task = board.tasks.find((t) => t.id === id);
        if (!task) throw new Error(`Unknown task: ${id}`);
        return task;
      }
      function withTask(board, updatedTask) {
        return {
          ...board,
          updated_at: nowIso(),
          tasks: board.tasks.map((t) => t.id === updatedTask.id ? updatedTask : t)
        };
      }
      function getBoard() {
        const board = readBoard();
        return {
          ...board,
          tasks: board.tasks.map((t) => ({ ...t, stale: staleTaskIds.has(t.id) }))
        };
      }
      function createTask(fields, actor) {
        const task = schema.createTask(fields);
        const board = readBoard();
        store.write({ ...board, updated_at: nowIso(), tasks: [...board.tasks, task] });
        emit("task.created", { taskId: task.id, actor, task });
        return task;
      }
      function updateTask(id, patch, actor) {
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
          throw new Error("updateTask: patch must be an object");
        }
        for (const key of ["id", "created_at"]) {
          if (key in patch) throw new Error(`updateTask: '${key}' cannot be patched`);
        }
        const board = readBoard();
        const current = requireTask(board, id);
        const clean = {};
        for (const [key, value] of Object.entries(patch)) {
          if (value !== void 0) clean[key] = value;
        }
        const updated = { ...current, ...clean, updated_at: nowIso() };
        store.write(withTask(board, updated));
        emit("task.updated", {
          taskId: id,
          actor,
          task: updated,
          changes: Object.keys(clean),
          previousStatus: current.status
        });
        return updated;
      }
      function moveTask(id, status, order, actor) {
        if (!schema.COLUMN_ORDER.includes(status)) {
          throw new Error(`moveTask: unknown status '${status}'`);
        }
        if (!Number.isInteger(order)) {
          throw new Error("moveTask: order must be an integer");
        }
        const board = readBoard();
        const current = requireTask(board, id);
        const updated = { ...current, status, order, updated_at: nowIso() };
        store.write(withTask(board, updated));
        emit("task.moved", {
          taskId: id,
          actor,
          from: current.status,
          to: status,
          order,
          task: updated
        });
        return updated;
      }
      function addComment(id, { author, text } = {}) {
        const board = readBoard();
        const current = requireTask(board, id);
        const comment = { author, ts: nowIso(), text };
        const updated = {
          ...current,
          comments: [...current.comments, comment],
          updated_at: nowIso()
        };
        store.write(withTask(board, updated));
        emit("comment.added", { taskId: id, actor: author, task: updated, comment });
        return updated;
      }
      function addAttempt(id, attempt = {}) {
        const board = readBoard();
        const current = requireTask(board, id);
        const full = {
          agent: attempt.agent,
          started_at: attempt.started_at ?? nowIso(),
          ended_at: attempt.ended_at ?? null,
          result: attempt.result ?? null,
          branch: attempt.branch ?? null,
          note: attempt.note ?? null
        };
        for (const key of Object.keys(attempt)) {
          if (!(key in full)) throw new Error(`addAttempt: unknown attempt field '${key}'`);
        }
        const updated = {
          ...current,
          attempts: [...current.attempts, full],
          updated_at: nowIso()
        };
        store.write(withTask(board, updated));
        emit("attempt.added", { taskId: id, actor: full.agent, task: updated, attempt: full });
        return updated;
      }
      function deleteTask(id, actor) {
        const board = readBoard();
        const removed = requireTask(board, id);
        store.write({
          ...board,
          updated_at: nowIso(),
          tasks: board.tasks.filter((t) => t.id !== id)
        });
        staleTaskIds.delete(id);
        emit("task.deleted", { taskId: id, actor, task: removed });
        return removed;
      }
      function setStaleTaskIds(ids) {
        staleTaskIds.clear();
        for (const id of ids) staleTaskIds.add(id);
      }
      function watch() {
        return store.watch((result) => {
          emit("board.external_change", {
            restored: result.restored,
            quarantinedPath: result.quarantinedPath,
            usedDefault: result.usedDefault
          });
        });
      }
      return {
        getBoard,
        createTask,
        updateTask,
        moveTask,
        addComment,
        addAttempt,
        deleteTask,
        setStaleTaskIds,
        watch
      };
    }
    function createWatchdog(options = {}) {
      const {
        kanban,
        thresholdMs = DEFAULT_STALE_THRESHOLD_MS,
        checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
        onStale,
        now = () => Date.now()
      } = options;
      if (!kanban) throw new Error("createWatchdog: kanban is required");
      let timer = null;
      const firedIds = /* @__PURE__ */ new Set();
      function lastActivityMs(task) {
        const times = [Date.parse(task.updated_at)];
        for (const comment of task.comments) times.push(Date.parse(comment.ts));
        for (const attempt of task.attempts) times.push(Date.parse(attempt.started_at));
        return Math.max(...times.filter((t) => !Number.isNaN(t)));
      }
      function check() {
        const board = kanban.getBoard();
        const staleIds = [];
        const currentMs = now();
        const liveIds = /* @__PURE__ */ new Set();
        for (const task of board.tasks) {
          liveIds.add(task.id);
          const eligible = WATCHED_STATUSES.includes(task.status);
          const isStale = eligible && currentMs - lastActivityMs(task) > thresholdMs;
          if (isStale) {
            staleIds.push(task.id);
            if (!firedIds.has(task.id)) {
              firedIds.add(task.id);
              if (typeof onStale === "function") onStale(task);
            }
          } else {
            firedIds.delete(task.id);
          }
        }
        for (const id of firedIds) {
          if (!liveIds.has(id)) firedIds.delete(id);
        }
        kanban.setStaleTaskIds(staleIds);
        return staleIds;
      }
      function start() {
        if (timer) return;
        timer = setInterval(check, checkIntervalMs);
        if (typeof timer.unref === "function") timer.unref();
      }
      function stop() {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      }
      return { check, start, stop };
    }
    module2.exports = { createKanban, createWatchdog };
  }
});

// src/briefs.js
var require_briefs = __commonJS({
  "src/briefs.js"(exports2, module2) {
    var crypto = require("crypto");
    var fs2 = require("fs");
    var path2 = require("path");
    var BRIEF_NAME_RE = /^[a-zA-Z0-9._-]+\.md$/;
    var MAX_BRIEF_BYTES = 1024 * 1024;
    function validateBriefName(name) {
      if (typeof name !== "string" || name.length === 0) {
        throw new Error("Brief name must be a non-empty string");
      }
      if (name.startsWith(".")) {
        throw new Error("Invalid brief name: dotfiles and names starting with '.' are not allowed");
      }
      if (!BRIEF_NAME_RE.test(name)) {
        throw new Error(
          "Invalid brief name: only letters, digits, '.', '_', '-' are allowed, and the name must end with '.md'"
        );
      }
      return name;
    }
    function resolveBriefPath(briefsDir, name) {
      const root = path2.resolve(briefsDir);
      const resolved = path2.resolve(root, String(name));
      const relative = path2.relative(root, resolved);
      if (relative === "" || relative === ".." || relative.startsWith(`..${path2.sep}`) || path2.isAbsolute(relative)) {
        throw new Error("Invalid brief name: resolved path escapes the briefs directory");
      }
      if (relative.includes(path2.sep) || relative.includes("/")) {
        throw new Error("Invalid brief name: nested paths are not allowed");
      }
      return resolved;
    }
    function extractFirstHeading(content) {
      const match = content.match(/^#{1,6}[ \t]+(.+)$/m);
      return match ? match[1].trim() : null;
    }
    function createBriefs({ briefsDir } = {}) {
      if (typeof briefsDir !== "string" || briefsDir.length === 0) {
        throw new Error("createBriefs requires a briefsDir option");
      }
      function safePath(name) {
        validateBriefName(name);
        return resolveBriefPath(briefsDir, name);
      }
      function ensureDir() {
        fs2.mkdirSync(briefsDir, { recursive: true });
      }
      function list() {
        let entries;
        try {
          entries = fs2.readdirSync(briefsDir, { withFileTypes: true });
        } catch (e) {
          if (e.code === "ENOENT") return [];
          throw new Error(`Failed to list briefs (${e.code || "unknown error"})`);
        }
        const briefs = [];
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          if (entry.name.startsWith(".")) continue;
          if (!BRIEF_NAME_RE.test(entry.name)) continue;
          try {
            const filePath = path2.join(briefsDir, entry.name);
            const stat = fs2.statSync(filePath);
            const content = fs2.readFileSync(filePath, "utf8");
            briefs.push({
              name: entry.name,
              size: stat.size,
              updatedAt: stat.mtime.toISOString(),
              firstHeading: extractFirstHeading(content)
            });
          } catch (e) {
          }
        }
        return briefs.sort((a, b) => a.name.localeCompare(b.name));
      }
      function read(name) {
        const filePath = safePath(name);
        let content;
        let stat;
        try {
          content = fs2.readFileSync(filePath, "utf8");
          stat = fs2.statSync(filePath);
        } catch (e) {
          if (e.code === "ENOENT") {
            throw new Error(`Brief not found: "${name}"`);
          }
          throw new Error(`Failed to read brief "${name}" (${e.code || "unknown error"})`);
        }
        return {
          name,
          content,
          size: stat.size,
          updatedAt: stat.mtime.toISOString(),
          firstHeading: extractFirstHeading(content)
        };
      }
      function write(name, content) {
        const filePath = safePath(name);
        if (typeof content !== "string") {
          throw new Error("Brief content must be a string");
        }
        const byteLength = Buffer.byteLength(content, "utf8");
        if (byteLength > MAX_BRIEF_BYTES) {
          throw new Error(
            `Brief content too large: ${byteLength} bytes (max ${MAX_BRIEF_BYTES} bytes)`
          );
        }
        ensureDir();
        const tmpPath = path2.join(briefsDir, `.${name}.${crypto.randomBytes(6).toString("hex")}.tmp`);
        try {
          fs2.writeFileSync(tmpPath, content, "utf8");
          fs2.renameSync(tmpPath, filePath);
        } catch (e) {
          try {
            fs2.unlinkSync(tmpPath);
          } catch (cleanupErr) {
          }
          throw new Error(`Failed to write brief "${name}" (${e.code || "unknown error"})`);
        }
        const stat = fs2.statSync(filePath);
        return { name, size: stat.size, updatedAt: stat.mtime.toISOString() };
      }
      function remove(name) {
        const filePath = safePath(name);
        try {
          fs2.unlinkSync(filePath);
        } catch (e) {
          if (e.code === "ENOENT") {
            throw new Error(`Brief not found: "${name}"`);
          }
          throw new Error(`Failed to remove brief "${name}" (${e.code || "unknown error"})`);
        }
        return { name, removed: true };
      }
      return { list, read, write, remove };
    }
    module2.exports = {
      createBriefs,
      validateBriefName,
      resolveBriefPath,
      BRIEF_NAME_RE,
      MAX_BRIEF_BYTES
    };
  }
});

// src/evolution.js
var require_evolution = __commonJS({
  "src/evolution.js"(exports2, module2) {
    var crypto = require("crypto");
    var fs2 = require("fs");
    var path2 = require("path");
    var LEDGER_FILE = "lessons_learned.md";
    var APPROVED_FILE = "lessons_learned.approved.md";
    var STATE_FILE = "evolution.json";
    var LESSON_ID_RE = /^les_[0-9a-f]{6}$/;
    var SECTION_HEADER_RE = /^## \[LESSON\] /gm;
    var SECTION_RE = /^## \[LESSON\] (.+)\n- status: (pending|approved|rejected)[ \t]*\n- id: (les_[0-9a-f]{6})[ \t]*\n- author: ([^\n]*)\n- ts: ([^\n]*)\n\n?([\s\S]*)$/;
    function atomicWriteFileSync(filePath, content) {
      const dir = path2.dirname(filePath);
      fs2.mkdirSync(dir, { recursive: true });
      const tmpPath = path2.join(
        dir,
        `.${path2.basename(filePath)}.${crypto.randomBytes(6).toString("hex")}.tmp`
      );
      try {
        fs2.writeFileSync(tmpPath, content, "utf8");
        fs2.renameSync(tmpPath, filePath);
      } catch (e) {
        try {
          fs2.unlinkSync(tmpPath);
        } catch (cleanupErr) {
        }
        throw e;
      }
    }
    function parseLedger(content) {
      const sections = [];
      if (!content) return sections;
      const starts = [];
      SECTION_HEADER_RE.lastIndex = 0;
      let match;
      while ((match = SECTION_HEADER_RE.exec(content)) !== null) {
        starts.push(match.index);
      }
      for (let i = 0; i < starts.length; i++) {
        const start = starts[i];
        const end = i + 1 < starts.length ? starts[i + 1] : content.length;
        const raw = content.slice(start, end);
        const m = raw.match(SECTION_RE);
        if (!m) {
          sections.push({
            parseError: "Malformed lesson section: expected status/id/author/ts metadata lines",
            raw,
            start,
            end
          });
          continue;
        }
        sections.push({
          title: m[1].trim(),
          status: m[2],
          id: m[3],
          author: m[4].trim(),
          ts: m[5].trim(),
          body: m[6].replace(/\s+$/, ""),
          raw,
          start,
          end
        });
      }
      return sections;
    }
    function formatSection({ title, status, id, author, ts, body }) {
      return `## [LESSON] ${title}
- status: ${status}
- id: ${id}
- author: ${author}
- ts: ${ts}

${body}
`;
    }
    function appendBlock(filePath, block) {
      let existing = "";
      try {
        existing = fs2.readFileSync(filePath, "utf8");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      let prefix = "";
      if (existing.length > 0) {
        prefix = existing.endsWith("\n") ? "\n" : "\n\n";
      }
      atomicWriteFileSync(filePath, existing + prefix + block);
    }
    function createEvolution({ workspaceDir, stateDir, onChange, getGateDefault } = {}) {
      if (typeof workspaceDir !== "string" || workspaceDir.length === 0) {
        throw new Error("createEvolution requires a workspaceDir option");
      }
      if (typeof stateDir !== "string" || stateDir.length === 0) {
        throw new Error("createEvolution requires a stateDir option");
      }
      const ledgerPath = path2.join(workspaceDir, LEDGER_FILE);
      const approvedPath = path2.join(workspaceDir, APPROVED_FILE);
      const statePath = path2.join(stateDir, STATE_FILE);
      function fire(event) {
        if (typeof onChange === "function") {
          try {
            onChange(event);
          } catch (e) {
            console.error("[Evolution] onChange handler failed:", e.message);
          }
        }
      }
      function defaultGate() {
        if (typeof getGateDefault === "function") {
          try {
            return !!getGateDefault();
          } catch (e) {
            console.error("[Evolution] getGateDefault failed:", e.message);
          }
        }
        return true;
      }
      function loadState() {
        try {
          const raw = fs2.readFileSync(statePath, "utf8");
          const parsed = JSON.parse(raw);
          return {
            gate: typeof parsed.gate === "boolean" ? parsed.gate : defaultGate(),
            pending: Array.isArray(parsed.pending) ? parsed.pending : [],
            updatedAt: parsed.updatedAt || null
          };
        } catch (e) {
          return { gate: defaultGate(), pending: [], updatedAt: null };
        }
      }
      function saveState(state2) {
        const next = { ...state2, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
        atomicWriteFileSync(statePath, JSON.stringify(next, null, 2) + "\n");
        return next;
      }
      function readLedger() {
        let content = "";
        try {
          content = fs2.readFileSync(ledgerPath, "utf8");
        } catch (e) {
          if (e.code !== "ENOENT") {
            throw new Error(`Failed to read lessons ledger (${e.code || "unknown error"})`);
          }
        }
        return { content, sections: parseLedger(content) };
      }
      function generateId(existingIds) {
        for (let attempt = 0; attempt < 100; attempt++) {
          const id = `les_${crypto.randomBytes(3).toString("hex")}`;
          if (!existingIds.has(id)) return id;
        }
        throw new Error("Failed to generate a unique lesson id");
      }
      function addLesson({ title, body, author } = {}) {
        if (typeof title !== "string" || title.trim().length === 0) {
          throw new Error("Lesson title must be a non-empty string");
        }
        if (/[\n\r]/.test(title)) {
          throw new Error("Lesson title must not contain newlines");
        }
        if (typeof body !== "string" || body.trim().length === 0) {
          throw new Error("Lesson body must be a non-empty string");
        }
        const safeAuthor = typeof author === "string" && author.trim().length > 0 ? author.trim().replace(/[\n\r]/g, " ") : "unknown";
        const { sections } = readLedger();
        const existingIds = new Set(sections.filter((s) => !s.parseError).map((s) => s.id));
        const state2 = loadState();
        const gate = state2.gate;
        const lesson = {
          id: generateId(existingIds),
          title: title.trim(),
          status: gate ? "pending" : "approved",
          author: safeAuthor,
          ts: (/* @__PURE__ */ new Date()).toISOString(),
          body: body.replace(/\s+$/, "")
        };
        appendBlock(ledgerPath, formatSection(lesson));
        if (lesson.status === "approved") {
          appendBlock(approvedPath, `## [LESSON] ${lesson.title}

${lesson.body}
`);
          saveState(state2);
        } else {
          saveState({
            ...state2,
            pending: [
              ...state2.pending,
              { id: lesson.id, title: lesson.title, author: lesson.author, ts: lesson.ts }
            ]
          });
        }
        fire({ type: "lesson.add", lesson: { ...lesson } });
        return lesson;
      }
      function listLessons(filter) {
        const status = typeof filter === "string" ? filter : filter && filter.status;
        const { sections } = readLedger();
        const mapped = sections.map(
          (s) => s.parseError ? { parseError: s.parseError, raw: s.raw } : {
            id: s.id,
            title: s.title,
            status: s.status,
            author: s.author,
            ts: s.ts,
            body: s.body
          }
        );
        if (!status) return mapped;
        return mapped.filter((s) => !s.parseError && s.status === status);
      }
      function transition(id, actor, fromStatus, toStatus) {
        if (typeof id !== "string" || !LESSON_ID_RE.test(id)) {
          throw new Error("Lesson id must look like les_<6hex>");
        }
        const { content, sections } = readLedger();
        const section = sections.find((s) => !s.parseError && s.id === id);
        if (!section) {
          throw new Error(`Lesson not found: ${id}`);
        }
        if (section.status !== fromStatus) {
          throw new Error(`Lesson ${id} is "${section.status}", expected "${fromStatus}"`);
        }
        const newRaw = section.raw.replace(
          new RegExp(`^- status: ${fromStatus}[ \\t]*$`, "m"),
          `- status: ${toStatus}`
        );
        const newContent = content.slice(0, section.start) + newRaw + content.slice(section.end);
        atomicWriteFileSync(ledgerPath, newContent);
        if (toStatus === "approved") {
          appendBlock(approvedPath, `## [LESSON] ${section.title}

${section.body}
`);
        }
        const state2 = loadState();
        saveState({ ...state2, pending: state2.pending.filter((p) => p.id !== id) });
        fire({
          type: toStatus === "approved" ? "lesson.approve" : "lesson.reject",
          id,
          actor: actor || "unknown",
          lesson: { id, title: section.title, status: toStatus }
        });
        return {
          id,
          title: section.title,
          status: toStatus,
          author: section.author,
          ts: section.ts,
          body: section.body
        };
      }
      function approve(id, actor) {
        return transition(id, actor, "pending", "approved");
      }
      function reject(id, actor) {
        return transition(id, actor, "pending", "rejected");
      }
      function getGate() {
        return loadState().gate;
      }
      function setGate(on, actor) {
        const state2 = loadState();
        const gate = !!on;
        const next = saveState({ ...state2, gate });
        fire({ type: "gate.toggle", gate, actor: actor || "unknown" });
        return { gate: next.gate, updatedAt: next.updatedAt };
      }
      function getState() {
        const state2 = loadState();
        return {
          gate: state2.gate,
          pending: state2.pending.map((p) => ({ ...p })),
          updatedAt: state2.updatedAt
        };
      }
      return { addLesson, listLessons, approve, reject, getGate, setGate, getState };
    }
    module2.exports = { createEvolution, parseLedger };
  }
});

// src/audit.js
var require_audit = __commonJS({
  "src/audit.js"(exports2, module2) {
    var crypto = require("crypto");
    var fs2 = require("fs");
    var path2 = require("path");
    var AUDIT_ACTIONS = [
      "task.create",
      "task.move",
      "task.update",
      "task.delete",
      "task.comment",
      "brief.write",
      "brief.delete",
      "lesson.add",
      "lesson.approve",
      "lesson.reject",
      "gate.toggle",
      "node.register",
      "node.unregister",
      "alerts.config",
      "memory.write"
    ];
    var ACTIVE_LOG = "audit.jsonl";
    var ROTATED_RE = /^audit\..+\.jsonl$/;
    var MAX_LOG_BYTES = 50 * 1024 * 1024;
    var MAX_ROTATED_FILES = 10;
    var DEFAULT_QUERY_LIMIT = 200;
    var MAX_QUERY_LIMIT = 1e3;
    function toEpochMs(value, label) {
      let ms;
      if (value instanceof Date) {
        ms = value.getTime();
      } else if (typeof value === "number") {
        ms = value;
      } else if (typeof value === "string") {
        ms = Date.parse(value);
      } else {
        throw new Error(`Invalid ${label}: expected ISO string, Date, or epoch milliseconds`);
      }
      if (!Number.isFinite(ms)) {
        throw new Error(`Invalid ${label}: could not parse as a timestamp`);
      }
      return ms;
    }
    function createAudit({ logsDir } = {}) {
      if (typeof logsDir !== "string" || logsDir.length === 0) {
        throw new Error("createAudit requires a logsDir option");
      }
      const activePath = path2.join(logsDir, ACTIVE_LOG);
      function listRotatedFiles() {
        let entries = [];
        try {
          entries = fs2.readdirSync(logsDir);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        return entries.filter((name) => name !== ACTIVE_LOG && ROTATED_RE.test(name)).sort();
      }
      function rotateIfNeeded() {
        let size = 0;
        try {
          size = fs2.statSync(activePath).size;
        } catch (e) {
          return;
        }
        if (size < MAX_LOG_BYTES) return;
        const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
        let rotatedPath = path2.join(logsDir, `audit.${stamp}.jsonl`);
        if (fs2.existsSync(rotatedPath)) {
          rotatedPath = path2.join(
            logsDir,
            `audit.${stamp}-${crypto.randomBytes(3).toString("hex")}.jsonl`
          );
        }
        fs2.renameSync(activePath, rotatedPath);
        const rotated = listRotatedFiles();
        const excess = rotated.length - MAX_ROTATED_FILES;
        for (let i = 0; i < excess; i++) {
          try {
            fs2.unlinkSync(path2.join(logsDir, rotated[i]));
          } catch (e) {
            console.error("[Audit] Failed to prune rotated log:", rotated[i], e.message);
          }
        }
      }
      function record(entry) {
        if (!entry || typeof entry !== "object") {
          throw new Error("Audit entry must be an object");
        }
        const { user, action, target, detail } = entry;
        if (typeof action !== "string" || !AUDIT_ACTIONS.includes(action)) {
          throw new Error(
            `Invalid audit action "${String(action)}". Allowed: ${AUDIT_ACTIONS.join(", ")}`
          );
        }
        if (user !== void 0 && user !== null && typeof user !== "string") {
          throw new Error("Audit user must be a string when provided");
        }
        if (target !== void 0 && target !== null && typeof target !== "string") {
          throw new Error("Audit target must be a string when provided");
        }
        const rec = {
          id: `aud_${crypto.randomBytes(8).toString("hex")}`,
          ts: (/* @__PURE__ */ new Date()).toISOString(),
          user: user && user.trim().length > 0 ? user.trim() : "anonymous",
          action,
          target: target || null,
          detail: detail === void 0 ? null : detail
        };
        let line;
        try {
          line = JSON.stringify(rec);
        } catch (e) {
          throw new Error("Audit detail must be JSON-serializable");
        }
        fs2.mkdirSync(logsDir, { recursive: true });
        rotateIfNeeded();
        fs2.appendFileSync(activePath, line + "\n", "utf8");
        return rec;
      }
      function readEntries(filePath) {
        let content;
        try {
          content = fs2.readFileSync(filePath, "utf8");
        } catch (e) {
          return [];
        }
        const entries = [];
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === "object" && parsed.ts && parsed.action) {
              entries.push(parsed);
            }
          } catch (e) {
          }
        }
        return entries;
      }
      function query({ user, action, since, until, limit = DEFAULT_QUERY_LIMIT } = {}) {
        if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) {
          throw new Error("Query limit must be a positive number");
        }
        const cap = Math.min(Math.floor(limit), MAX_QUERY_LIMIT);
        const sinceMs = since === void 0 || since === null ? null : toEpochMs(since, "since");
        const untilMs = until === void 0 || until === null ? null : toEpochMs(until, "until");
        if (action !== void 0 && action !== null && !AUDIT_ACTIONS.includes(action)) {
          throw new Error(`Invalid audit action filter "${String(action)}"`);
        }
        const matches = (rec) => {
          if (user && rec.user !== user) return false;
          if (action && rec.action !== action) return false;
          if (sinceMs !== null || untilMs !== null) {
            const tsMs = Date.parse(rec.ts);
            if (!Number.isFinite(tsMs)) return false;
            if (sinceMs !== null && tsMs < sinceMs) return false;
            if (untilMs !== null && tsMs > untilMs) return false;
          }
          return true;
        };
        const files = [
          activePath,
          ...listRotatedFiles().reverse().map((f) => path2.join(logsDir, f))
        ];
        const results = [];
        for (const filePath of files) {
          if (results.length >= cap) break;
          const entries = readEntries(filePath);
          for (let i = entries.length - 1; i >= 0 && results.length < cap; i--) {
            if (matches(entries[i])) results.push(entries[i]);
          }
        }
        return results.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
      }
      return { record, query };
    }
    module2.exports = { createAudit, AUDIT_ACTIONS };
  }
});

// src/cortex-lancedb.js
var require_cortex_lancedb = __commonJS({
  "src/cortex-lancedb.js"(exports2, module2) {
    var fs2 = require("fs");
    var os = require("os");
    var path2 = require("path");
    var { createRequire } = require("node:module");
    var CLI_TIMEOUT_MS = 15e3;
    var EXPORT_FORMAT_VERSION = "1.0";
    var DEFAULT_SEARCH_LIMIT = 10;
    var DEFAULT_LIST_LIMIT = 20;
    function defaultExecFn(cmd, args2, options = {}) {
      return new Promise((resolve) => {
        let execFile;
        try {
          execFile = require("child_process").execFile;
        } catch (e) {
          resolve({ error: e, stdout: "", stderr: "" });
          return;
        }
        const { getSafeEnv } = require_openclaw();
        execFile(
          cmd,
          args2,
          {
            encoding: "utf8",
            timeout: options.timeoutMs || CLI_TIMEOUT_MS,
            maxBuffer: 32 * 1024 * 1024,
            env: getSafeEnv()
          },
          (error, stdout, stderr) => {
            resolve({ error: error || null, stdout: stdout || "", stderr: stderr || "" });
          }
        );
      });
    }
    function defaultLanceLoader() {
      const requireModule = createRequire(__filename);
      return requireModule("@lancedb/lancedb");
    }
    function extractJsonPayload(text) {
      if (!text || typeof text !== "string") return null;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch !== "{" && ch !== "[") continue;
        const end = findBalancedEnd(text, i);
        if (end === -1) continue;
        try {
          return JSON.parse(text.slice(i, end + 1));
        } catch (e) {
        }
      }
      return null;
    }
    function findBalancedEnd(text, start) {
      const open = text[start];
      const close = open === "{" ? "}" : "]";
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") {
          depth--;
          if (depth === 0) return ch === close ? i : -1;
        }
      }
      return -1;
    }
    function escapeFilterValue(value) {
      return String(value).replace(/'/g, "''");
    }
    function stripAnsi(text) {
      return String(text).replace(/\u001b\[[0-9;]*m/g, "");
    }
    function parseMetadata(metadata) {
      if (metadata && typeof metadata === "string") {
        try {
          return JSON.parse(metadata);
        } catch (e) {
          return metadata;
        }
      }
      return metadata ?? null;
    }
    function normalizeMemoryRow(row) {
      if (!row || typeof row !== "object") return null;
      return {
        id: row.id ?? null,
        text: row.text ?? "",
        category: row.category ?? null,
        scope: row.scope ?? null,
        importance: row.importance ?? null,
        timestamp: row.timestamp ?? null,
        metadata: parseMetadata(row.metadata)
      };
    }
    function parseStatsText(text) {
      const clean = stripAnsi(text);
      const totalMatch = clean.match(/Total memories:\s*(\d+)/i);
      if (!totalMatch) return null;
      const stats = {
        totalMemories: parseInt(totalMatch[1], 10),
        byScope: {},
        byCategory: {},
        source: "cli"
      };
      let section = null;
      for (const line of clean.split("\n")) {
        if (/Memories by scope:/i.test(line)) {
          section = "byScope";
          continue;
        }
        if (/Memories by category:/i.test(line)) {
          section = "byCategory";
          continue;
        }
        const bullet = line.match(/[•*-]\s*(.+):\s*(\d+)\s*$/);
        if (section && bullet) {
          stats[section][bullet[1].trim()] = parseInt(bullet[2], 10);
        }
      }
      return stats;
    }
    function createLanceMemory(options = {}) {
      const dbPath = options.dbPath || path2.join(os.homedir(), ".openclaw", "memory", "lancedb-pro");
      const execFn = options.execFn || defaultExecFn;
      const lanceModuleLoader = options.lanceModuleLoader || defaultLanceLoader;
      const cliCommand = options.cliCommand || "openclaw";
      let cachedAvailability = null;
      function loadLanceModule() {
        try {
          return { module: lanceModuleLoader() };
        } catch (e) {
          return { error: e.message || String(e) };
        }
      }
      async function openMemoriesTable() {
        const loaded = loadLanceModule();
        if (loaded.error) {
          return { error: `@lancedb/lancedb not loadable: ${loaded.error}` };
        }
        if (!fs2.existsSync(dbPath)) {
          return { error: `LanceDB dataset not found at ${dbPath}` };
        }
        try {
          const db = await loaded.module.connect(dbPath);
          const table = await db.openTable("memories");
          return { table };
        } catch (e) {
          return { error: `Failed to open memories table: ${e.message}` };
        }
      }
      async function probeStatsJson() {
        try {
          const res = await execFn(cliCommand, ["memory-pro", "stats", "--json"], {
            timeoutMs: CLI_TIMEOUT_MS
          });
          const payload = extractJsonPayload(res.stdout) ?? extractJsonPayload(res.stderr) ?? extractJsonPayload(res.error?.message);
          return { res, payload };
        } catch (e) {
          return { res: { error: e, stdout: "", stderr: "" }, payload: null };
        }
      }
      async function available() {
        if (cachedAvailability) return cachedAvailability;
        const reasons = [];
        let cliOk = false;
        const probe = await probeStatsJson();
        if (!probe.res.error || probe.payload) {
          cliOk = true;
        } else {
          reasons.push(`openclaw CLI unavailable: ${probe.res.error.message || probe.res.error}`);
        }
        let lanceOk = false;
        const loaded = loadLanceModule();
        if (loaded.error) {
          reasons.push(`@lancedb/lancedb not loadable: ${loaded.error}`);
        } else if (!fs2.existsSync(dbPath)) {
          reasons.push(`LanceDB dataset not found at ${dbPath}`);
        } else {
          lanceOk = true;
        }
        cachedAvailability = {
          available: cliOk || lanceOk,
          cli: cliOk,
          lancedb: lanceOk,
          reason: reasons.length > 0 ? reasons.join("; ") : null
        };
        return cachedAvailability;
      }
      async function search(query, { limit = DEFAULT_SEARCH_LIMIT, scope } = {}) {
        if (typeof query !== "string" || query.trim() === "") {
          return { error: "search query must be a non-empty string" };
        }
        const args2 = ["memory-pro", "search", query, "--json", "--limit", String(limit)];
        if (scope) args2.push("--scope", String(scope));
        const res = await execFn(cliCommand, args2, { timeoutMs: CLI_TIMEOUT_MS });
        if (res.error) {
          return { error: `memory-pro search failed: ${res.error.message || res.error}` };
        }
        const parsed = extractJsonPayload(res.stdout) ?? extractJsonPayload(res.stderr);
        if (!Array.isArray(parsed)) {
          return { error: "could not parse JSON from memory-pro search output" };
        }
        const results = parsed.map((hit) => {
          const entry = hit && typeof hit === "object" && hit.entry ? hit.entry : hit;
          const normalized = normalizeMemoryRow(entry);
          if (!normalized) return null;
          const score = hit?.score ?? hit?.relevance ?? hit?.similarity ?? null;
          return score !== null ? { ...normalized, score } : normalized;
        }).filter(Boolean);
        return { results };
      }
      async function list({ limit = DEFAULT_LIST_LIMIT, scope, category } = {}) {
        const opened = await openMemoriesTable();
        if (opened.error) return { error: opened.error };
        try {
          let queryBuilder = opened.table.query();
          const filters = [];
          if (scope) filters.push(`scope = '${escapeFilterValue(scope)}'`);
          if (category) filters.push(`category = '${escapeFilterValue(category)}'`);
          if (filters.length > 0) queryBuilder = queryBuilder.where(filters.join(" AND "));
          const rows = await queryBuilder.limit(limit).toArray();
          return { items: rows.map(normalizeMemoryRow).filter(Boolean) };
        } catch (e) {
          return { error: `LanceDB list failed: ${e.message}` };
        }
      }
      async function get(id) {
        if (!id || typeof id !== "string") {
          return { error: "memory id must be a non-empty string" };
        }
        const opened = await openMemoriesTable();
        if (opened.error) return { error: opened.error };
        try {
          const rows = await opened.table.query().where(`id = '${escapeFilterValue(id)}'`).limit(1).toArray();
          if (!rows || rows.length === 0) return { error: `memory not found: ${id}` };
          return { item: normalizeMemoryRow(rows[0]) };
        } catch (e) {
          return { error: `LanceDB get failed: ${e.message}` };
        }
      }
      async function store(text, { category = "fact", scope, importance = 0.7 } = {}) {
        if (typeof text !== "string" || text.trim() === "") {
          return { error: "memory text must be a non-empty string" };
        }
        const memory = {
          id: `cortex-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          text,
          category,
          scope: scope || "global",
          importance,
          timestamp: Date.now(),
          metadata: JSON.stringify({ source: "open-fleet-control-cortex" })
        };
        const payload = {
          version: EXPORT_FORMAT_VERSION,
          exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
          count: 1,
          filters: {},
          memories: [memory]
        };
        const tmpFile = path2.join(
          os.tmpdir(),
          `cortex-import-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
        );
        try {
          fs2.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), "utf8");
          const args2 = ["memory-pro", "import", tmpFile];
          if (scope) args2.push("--scope", String(scope));
          const res = await execFn(cliCommand, args2, { timeoutMs: CLI_TIMEOUT_MS });
          if (res.error) {
            return { error: `memory-pro import failed: ${res.error.message || res.error}` };
          }
          return { ok: true, id: memory.id };
        } catch (e) {
          return { error: `store failed: ${e.message}` };
        } finally {
          try {
            fs2.unlinkSync(tmpFile);
          } catch (e) {
          }
        }
      }
      async function stats() {
        const probe = await probeStatsJson();
        const memorySection = probe.payload?.memory;
        if (memorySection && typeof memorySection.totalCount === "number") {
          return {
            totalMemories: memorySection.totalCount,
            byScope: memorySection.scopeCounts || {},
            byCategory: memorySection.categoryCounts || {},
            source: "cli"
          };
        }
        try {
          const res = await execFn(cliCommand, ["memory-pro", "stats"], {
            timeoutMs: CLI_TIMEOUT_MS
          });
          if (!res.error) {
            const parsed = parseStatsText(`${res.stdout}
${res.stderr}`);
            if (parsed) return parsed;
          }
        } catch (e) {
        }
        const opened = await openMemoriesTable();
        if (opened.error) return { error: opened.error };
        try {
          const totalMemories = await opened.table.countRows();
          return { totalMemories, byScope: {}, byCategory: {}, source: "lancedb" };
        } catch (e) {
          return { error: `stats failed: ${e.message}` };
        }
      }
      return { available, search, list, get, store, stats };
    }
    module2.exports = {
      createLanceMemory,
      extractJsonPayload,
      parseStatsText,
      EXPORT_FORMAT_VERSION
    };
  }
});

// src/cortex-gbrain.js
var require_cortex_gbrain = __commonJS({
  "src/cortex-gbrain.js"(exports2, module2) {
    var os = require("os");
    var path2 = require("path");
    var CLI_TIMEOUT_MS = 15e3;
    var DEFAULT_GRAPH_LIMIT = 200;
    function defaultExecFn(cmd, args2, options = {}) {
      return new Promise((resolve) => {
        let execFile;
        try {
          execFile = require("child_process").execFile;
        } catch (e) {
          resolve({ error: e, stdout: "", stderr: "" });
          return;
        }
        const { getSafeEnv } = require_openclaw();
        execFile(
          cmd,
          args2,
          {
            encoding: "utf8",
            timeout: options.timeoutMs || CLI_TIMEOUT_MS,
            maxBuffer: 16 * 1024 * 1024,
            env: getSafeEnv()
          },
          (error, stdout, stderr) => {
            resolve({ error: error || null, stdout: stdout || "", stderr: stderr || "" });
          }
        );
      });
    }
    function parseJsonOutput(text) {
      if (!text || typeof text !== "string") return null;
      const trimmed = text.trim();
      try {
        return JSON.parse(trimmed);
      } catch (e) {
      }
      for (const opener of ["[", "{"]) {
        const start = trimmed.indexOf(opener);
        if (start === -1) continue;
        const closer = opener === "[" ? "]" : "}";
        const end = trimmed.lastIndexOf(closer);
        if (end <= start) continue;
        try {
          return JSON.parse(trimmed.slice(start, end + 1));
        } catch (e2) {
        }
      }
      return null;
    }
    function parseTsvPages(text) {
      if (!text || typeof text !== "string") return null;
      const trimmed = text.trim();
      if (!trimmed) return null;
      if (/^no pages found\.?$/i.test(trimmed)) return [];
      const pages = [];
      for (const line of trimmed.split("\n")) {
        const parts = line.split("	");
        if (parts.length < 2 || !parts[0]) return null;
        pages.push({
          slug: parts[0],
          type: parts[1] || "page",
          updated_at: parts[2] || null,
          title: parts[3] || parts[0]
        });
      }
      return pages;
    }
    function parseExtractLinks(text) {
      if (!text || typeof text !== "string") return null;
      const links = [];
      for (const line of text.split("\n")) {
        const candidate = line.trim();
        if (!candidate.startsWith("{")) continue;
        try {
          const obj = JSON.parse(candidate);
          if (obj && obj.action === "add_link") links.push(obj);
        } catch (e) {
        }
      }
      if (links.length > 0) return links;
      const payload = parseJsonOutput(text);
      if (Array.isArray(payload)) return payload;
      if (payload && Array.isArray(payload.links)) return payload.links;
      if (payload && typeof payload === "object") return [];
      return null;
    }
    function toGraphNode(page) {
      if (!page || typeof page !== "object") return null;
      const id = page.slug ?? page.id ?? null;
      if (!id) return null;
      return {
        id,
        title: page.title ?? page.name ?? id,
        type: page.type ?? page.page_type ?? "page"
      };
    }
    function toGraphEdge(link) {
      if (!link || typeof link !== "object") return null;
      const from = link.from ?? link.source ?? link.from_slug ?? null;
      const to = link.to ?? link.target ?? link.to_slug ?? null;
      if (!from || !to) return null;
      return {
        from,
        to,
        kind: link.kind ?? link.type ?? link.link_type ?? "link"
      };
    }
    function createGbrain(options = {}) {
      const cliPath = options.cliPath || path2.join(os.homedir(), "gbrain", "bin", "gbrain");
      const execFn = options.execFn || defaultExecFn;
      let cachedAvailability = null;
      async function runCli(args2) {
        try {
          return await execFn(cliPath, args2, { timeoutMs: CLI_TIMEOUT_MS });
        } catch (e) {
          return { error: e, stdout: "", stderr: "" };
        }
      }
      async function available() {
        if (cachedAvailability) return cachedAvailability;
        const res = await runCli(["list", "--limit", "1", "--json"]);
        if (res.error) {
          cachedAvailability = {
            available: false,
            reason: `gbrain CLI failed at ${cliPath}: ${res.error.message || res.error}`
          };
          return cachedAvailability;
        }
        const parsed = parseJsonOutput(res.stdout) ?? parseJsonOutput(res.stderr) ?? parseTsvPages(res.stdout);
        if (!Array.isArray(parsed)) {
          const firstLine = `${res.stdout}
${res.stderr}`.trim().split("\n")[0]?.slice(0, 200) || "no output";
          cachedAvailability = {
            available: false,
            reason: `gbrain CLI returned no usable JSON or TSV (likely broken data bundle): ${firstLine}`
          };
          return cachedAvailability;
        }
        cachedAvailability = { available: true, reason: null };
        return cachedAvailability;
      }
      async function getGraph({ limit = DEFAULT_GRAPH_LIMIT } = {}) {
        const listRes = await runCli(["list", "--limit", String(limit), "--json"]);
        if (listRes.error) {
          return { error: `gbrain list failed: ${listRes.error.message || listRes.error}` };
        }
        const pages = parseJsonOutput(listRes.stdout) ?? parseJsonOutput(listRes.stderr) ?? parseTsvPages(listRes.stdout);
        if (!Array.isArray(pages)) {
          return { error: "gbrain list returned no usable JSON or TSV" };
        }
        const nodes = pages.map(toGraphNode).filter(Boolean);
        let edges = [];
        let note = null;
        const linksRes = await runCli(["extract", "links", "--source", "db", "--dry-run", "--json"]);
        if (linksRes.error) {
          note = `link extraction unavailable: ${linksRes.error.message || linksRes.error}`;
        } else {
          const links = parseExtractLinks(linksRes.stdout) ?? parseExtractLinks(linksRes.stderr);
          if (links) {
            edges = links.map(toGraphEdge).filter(Boolean);
          } else {
            note = "link extraction returned no usable JSON";
          }
        }
        const graph = { nodes, edges };
        if (note) graph.note = note;
        return graph;
      }
      async function getPage(id) {
        if (!id || typeof id !== "string") {
          return { error: "page id must be a non-empty string" };
        }
        const res = await runCli(["get", id]);
        if (res.error) {
          return { error: `gbrain get failed: ${res.error.message || res.error}` };
        }
        const content = (res.stdout || "").trim();
        if (!content) {
          return { error: `gbrain returned no content for page: ${id}` };
        }
        return { id, content };
      }
      return { available, getGraph, getPage };
    }
    module2.exports = { createGbrain, parseJsonOutput, parseTsvPages, parseExtractLinks };
  }
});

// src/cortex-gauges.js
var require_cortex_gauges = __commonJS({
  "src/cortex-gauges.js"(exports2, module2) {
    var fs2 = require("fs");
    var os = require("os");
    var path2 = require("path");
    function defaultSqliteLoader() {
      return require("node:sqlite");
    }
    function computeSavingsPct(rawTokens, effectiveTokens) {
      const raw = Number(rawTokens);
      const effective = Number(effectiveTokens);
      if (!Number.isFinite(raw) || raw <= 0 || !Number.isFinite(effective)) return null;
      return Math.round((raw - effective) / raw * 1e3) / 10;
    }
    function unavailableGauge(source, label, reason) {
      return {
        source,
        label,
        rawTokens: 0,
        effectiveTokens: 0,
        savingsPct: null,
        detail: { error: reason },
        available: false
      };
    }
    function readJsonFile(filePath) {
      const content = fs2.readFileSync(filePath, "utf8");
      return JSON.parse(content);
    }
    function createGauges(options = {}) {
      const home = os.homedir();
      const paths = {
        headroom: path2.join(home, ".headroom", "subscription_state.json"),
        leanCtx: path2.join(home, ".lean-ctx", "stats.json"),
        lcmDb: path2.join(home, ".openclaw", "lcm.db"),
        ...options.paths || {}
      };
      const sqliteLoader = options.sqliteLoader || defaultSqliteLoader;
      function headroomGauge() {
        const label = "Headroom (subscription window)";
        try {
          if (!fs2.existsSync(paths.headroom)) {
            return unavailableGauge("headroom", label, `file not found: ${paths.headroom}`);
          }
          const data = readJsonFile(paths.headroom);
          const window = data.window_tokens || {};
          const rawTokens = Number(window.total_raw) || Number(window.input || 0) + Number(window.output || 0) + Number(window.cache_reads || 0) + Number(window.cache_writes_total || 0);
          const effectiveTokens = Number(window.weighted_token_equivalent ?? rawTokens) || 0;
          return {
            source: "headroom",
            label,
            rawTokens,
            effectiveTokens,
            savingsPct: computeSavingsPct(rawTokens, effectiveTokens),
            detail: {
              input: window.input ?? 0,
              output: window.output ?? 0,
              cacheReads: window.cache_reads ?? 0,
              cacheWritesTotal: window.cache_writes_total ?? 0,
              fiveHourUtilizationPct: data.latest?.five_hour?.utilization_pct ?? null,
              sevenDayUtilizationPct: data.latest?.seven_day?.utilization_pct ?? null,
              polledAt: data.latest?.polled_at ?? null
            },
            available: true
          };
        } catch (e) {
          return unavailableGauge("headroom", label, e.message);
        }
      }
      function leanCtxGauge() {
        const label = "lean-ctx (command output compression)";
        try {
          if (!fs2.existsSync(paths.leanCtx)) {
            return unavailableGauge("lean-ctx", label, `file not found: ${paths.leanCtx}`);
          }
          const data = readJsonFile(paths.leanCtx);
          const rawTokens = Number(data.total_input_tokens) || 0;
          const effectiveTokens = Number(data.total_output_tokens) || 0;
          return {
            source: "lean-ctx",
            label,
            rawTokens,
            effectiveTokens,
            savingsPct: computeSavingsPct(rawTokens, effectiveTokens),
            detail: {
              totalCommands: data.total_commands ?? 0,
              firstUse: data.first_use ?? null,
              lastUse: data.last_use ?? null,
              daysTracked: Array.isArray(data.daily) ? data.daily.length : 0
            },
            available: true
          };
        } catch (e) {
          return unavailableGauge("lean-ctx", label, e.message);
        }
      }
      function lcmGauge() {
        const label = "lossless-claw (transcript compaction)";
        let db = null;
        try {
          if (!fs2.existsSync(paths.lcmDb)) {
            return unavailableGauge("lcm", label, `database not found: ${paths.lcmDb}`);
          }
          const sqlite = sqliteLoader();
          db = new sqlite.DatabaseSync(paths.lcmDb, { readOnly: true });
          const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
          if (tables.includes("summaries")) {
            const columns = db.prepare("PRAGMA table_info(summaries)").all().map((col) => col.name);
            if (columns.includes("token_count")) {
              const rawColumn = columns.includes("source_message_token_count") ? "source_message_token_count" : columns.includes("descendant_token_count") ? "descendant_token_count" : null;
              const selectRaw = rawColumn ? `, COALESCE(SUM(${rawColumn}), 0) AS raw` : "";
              const row = db.prepare(
                `SELECT COUNT(*) AS n, COALESCE(SUM(token_count), 0) AS effective${selectRaw} FROM summaries`
              ).get();
              const effectiveTokens = Number(row.effective) || 0;
              const rawTokens = rawColumn ? Number(row.raw) || 0 : effectiveTokens;
              const detail = { summaries: Number(row.n) || 0, rawColumn: rawColumn || "none" };
              if (tables.includes("messages")) {
                try {
                  const messages = db.prepare("SELECT COUNT(*) AS n FROM messages").get();
                  detail.messages = Number(messages.n) || 0;
                } catch (e) {
                }
              }
              return {
                source: "lcm",
                label,
                rawTokens,
                effectiveTokens,
                savingsPct: computeSavingsPct(rawTokens, effectiveTokens),
                detail,
                available: true
              };
            }
          }
          if (tables.includes("messages")) {
            const columns = db.prepare("PRAGMA table_info(messages)").all().map((col) => col.name);
            if (columns.includes("token_count")) {
              const row = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(token_count), 0) AS total FROM messages").get();
              const total = Number(row.total) || 0;
              return {
                source: "lcm",
                label,
                rawTokens: total,
                effectiveTokens: total,
                savingsPct: 0,
                detail: {
                  messages: Number(row.n) || 0,
                  note: "no usable summaries table; reporting message tokens only"
                },
                available: true
              };
            }
          }
          return unavailableGauge("lcm", label, "no summaries/messages tables with token counts");
        } catch (e) {
          return unavailableGauge("lcm", label, e.message);
        } finally {
          if (db) {
            try {
              db.close();
            } catch (e) {
            }
          }
        }
      }
      function getGauges() {
        return [headroomGauge(), leanCtxGauge(), lcmGauge()];
      }
      return { getGauges };
    }
    module2.exports = { createGauges, computeSavingsPct };
  }
});

// src/cortex.js
var require_cortex = __commonJS({
  "src/cortex.js"(exports2, module2) {
    var { createLanceMemory } = require_cortex_lancedb();
    var { createGbrain } = require_cortex_gbrain();
    var { createGauges } = require_cortex_gauges();
    function summarizeGauges(gauges) {
      const list = Array.isArray(gauges) ? gauges : [];
      const availableGauges = list.filter((gauge) => gauge && gauge.available);
      const totalRawTokens = availableGauges.reduce(
        (sum, gauge) => sum + (Number(gauge.rawTokens) || 0),
        0
      );
      const totalEffectiveTokens = availableGauges.reduce(
        (sum, gauge) => sum + (Number(gauge.effectiveTokens) || 0),
        0
      );
      const overallSavingsPct = totalRawTokens > 0 ? Math.round((totalRawTokens - totalEffectiveTokens) / totalRawTokens * 1e3) / 10 : null;
      return {
        sources: list.length,
        available: availableGauges.length,
        totalRawTokens,
        totalEffectiveTokens,
        overallSavingsPct
      };
    }
    function createCortex(options = {}) {
      const memory = createLanceMemory(options.lancedb || {});
      const gbrain = createGbrain(options.gbrain || {});
      const gauges = createGauges(options.gauges || {});
      async function getState() {
        const state2 = {
          timestamp: Date.now(),
          memory: { available: false, cli: false, lancedb: false, reason: null, stats: null },
          gbrain: { available: false, reason: null },
          gauges: [],
          gaugeSummary: summarizeGauges([])
        };
        try {
          const memoryAvailability = await memory.available();
          state2.memory.available = !!memoryAvailability.available;
          state2.memory.cli = !!memoryAvailability.cli;
          state2.memory.lancedb = !!memoryAvailability.lancedb;
          state2.memory.reason = memoryAvailability.reason || null;
          if (memoryAvailability.available) {
            const memoryStats = await memory.stats();
            if (memoryStats && !memoryStats.error) {
              state2.memory.stats = memoryStats;
            } else if (memoryStats?.error) {
              state2.memory.reason = state2.memory.reason ? `${state2.memory.reason}; stats: ${memoryStats.error}` : `stats: ${memoryStats.error}`;
            }
          }
        } catch (e) {
          state2.memory.reason = e.message;
        }
        try {
          const gbrainAvailability = await gbrain.available();
          state2.gbrain.available = !!gbrainAvailability.available;
          state2.gbrain.reason = gbrainAvailability.reason || null;
        } catch (e) {
          state2.gbrain.reason = e.message;
        }
        try {
          state2.gauges = gauges.getGauges();
        } catch (e) {
          state2.gauges = [];
        }
        state2.gaugeSummary = summarizeGauges(state2.gauges);
        return state2;
      }
      return {
        // Sub-adapters (for callers that need full access)
        memory,
        gbrain,
        gauges,
        // Unified state
        getState,
        // Memory passthroughs
        searchMemory: (query, opts) => memory.search(query, opts),
        listMemory: (opts) => memory.list(opts),
        getMemory: (id) => memory.get(id),
        storeMemory: (text, opts) => memory.store(text, opts),
        memoryStats: () => memory.stats(),
        // Graph passthroughs
        getGraph: (opts) => gbrain.getGraph(opts),
        getPage: (id) => gbrain.getPage(id),
        // Gauges passthrough
        getGauges: () => gauges.getGauges()
      };
    }
    module2.exports = { createCortex, summarizeGauges };
  }
});

// src/alerts.js
var require_alerts = __commonJS({
  "src/alerts.js"(exports2, module2) {
    var crypto = require("crypto");
    var SEVERITIES = /* @__PURE__ */ new Set(["info", "warn", "critical"]);
    var NTFY_DEFAULT_SERVER = "https://ntfy.sh";
    var NTFY_PRIORITIES = { critical: "urgent", warn: "high", info: "default" };
    var NTFY_TAGS = { critical: "rotating_light", warn: "warning", info: "information_source" };
    var DEDUPE_WINDOW_MS = 5 * 60 * 1e3;
    var RING_BUFFER_SIZE = 200;
    var DEFAULT_TIMEOUT_MS = 1e4;
    var DEFAULT_RETRY_DELAY_MS = 3e4;
    var DEFAULT_RECENT_LIMIT = 50;
    var DEDUPE_SWEEP_THRESHOLD = 1e3;
    var ALERT_SOURCE = "open-fleet-control";
    function delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }
    function normalizeEvent(event, nowFn) {
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        throw new TypeError("event must be an object");
      }
      if (typeof event.type !== "string" || event.type.length === 0) {
        throw new TypeError("event.type must be a non-empty string");
      }
      const severity = event.severity === void 0 ? "info" : event.severity;
      if (!SEVERITIES.has(severity)) {
        throw new TypeError("event.severity must be one of: info, warn, critical");
      }
      return {
        type: event.type,
        severity,
        node: event.node != null ? String(event.node) : null,
        task: event.task != null ? String(event.task) : null,
        message: event.message != null ? String(event.message) : "",
        ts: Number.isFinite(event.ts) ? event.ts : nowFn()
      };
    }
    function createAlerts({
      config = {},
      fetchFn = globalThis.fetch,
      nowFn = Date.now,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      retryDelayMs = DEFAULT_RETRY_DELAY_MS
    } = {}) {
      if (typeof fetchFn !== "function") {
        throw new TypeError("fetchFn must be a function");
      }
      const dedupeLastFired = /* @__PURE__ */ new Map();
      let recentAlerts = [];
      function sweepDedupe(now) {
        if (dedupeLastFired.size < DEDUPE_SWEEP_THRESHOLD) return;
        for (const [key, ts] of dedupeLastFired) {
          if (now - ts >= DEDUPE_WINDOW_MS) {
            dedupeLastFired.delete(key);
          }
        }
      }
      async function postOnce(url, body, headers) {
        const controller = new globalThis.AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetchFn(url, {
            method: "POST",
            headers,
            body,
            signal: controller.signal
          });
          if (res && typeof res.ok === "boolean" && !res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
        } finally {
          clearTimeout(timer);
        }
      }
      async function postWithRetry(label, url, body, headers) {
        try {
          await postOnce(url, body, headers);
          return true;
        } catch (err) {
          console.error(
            `[Alerts] ${label} delivery to ${url} failed (retrying in ${retryDelayMs}ms):`,
            err.message
          );
        }
        await delay(retryDelayMs);
        try {
          await postOnce(url, body, headers);
          return true;
        } catch (err) {
          console.error(
            `[Alerts] ${label} delivery to ${url} failed after retry, giving up:`,
            err.message
          );
          return false;
        }
      }
      function webhookMatchesEvent(webhook, type) {
        const events = Array.isArray(webhook.events) ? webhook.events : ["*"];
        return events.includes("*") || events.includes(type);
      }
      function dispatchToWebhook(webhook, alert) {
        const body = JSON.stringify({
          event: alert.type,
          severity: alert.severity,
          node: alert.node,
          task: alert.task,
          message: alert.message,
          ts: alert.ts,
          source: ALERT_SOURCE
        });
        const headers = { "Content-Type": "application/json" };
        if (webhook.secret) {
          const hmac = crypto.createHmac("sha256", webhook.secret).update(body).digest("hex");
          headers["X-OFC-Signature"] = `sha256=${hmac}`;
        }
        return postWithRetry("webhook", webhook.url, body, headers);
      }
      function alertContext(alert) {
        return [alert.node ? `node=${alert.node}` : null, alert.task ? `task=${alert.task}` : null].filter(Boolean).join(" ");
      }
      function dispatchToSlack(slack, alert) {
        const context = alertContext(alert);
        const text = `[${alert.severity.toUpperCase()}] ${alert.type}${context ? ` (${context})` : ""}: ${alert.message}`;
        const body = JSON.stringify({ channel: slack.channel, text });
        return postWithRetry("slack", slack.gatewayUrl, body, {
          "Content-Type": "application/json"
        });
      }
      function dispatchToNtfy(ntfy, alert) {
        const server2 = String(ntfy.server || NTFY_DEFAULT_SERVER).replace(/\/+$/, "");
        const url = `${server2}/${encodeURIComponent(String(ntfy.topic))}`;
        const context = alertContext(alert);
        const title = `${alert.type}${context ? ` (${context})` : ""}`;
        const priorityMap = ntfy.priorityMap && typeof ntfy.priorityMap === "object" && !Array.isArray(ntfy.priorityMap) ? ntfy.priorityMap : {};
        const headers = {
          "Content-Type": "text/plain; charset=utf-8",
          Title: title,
          Priority: priorityMap[alert.severity] || NTFY_PRIORITIES[alert.severity] || "default",
          Tags: NTFY_TAGS[alert.severity] || NTFY_TAGS.info
        };
        return postWithRetry("ntfy", url, alert.message || title, headers);
      }
      async function fire(event) {
        const alert = normalizeEvent(event, nowFn);
        if (!config.enabled) {
          return { fired: false, reason: "disabled" };
        }
        const rules = config.rules || {};
        if (Object.prototype.hasOwnProperty.call(rules, alert.type) && !rules[alert.type]) {
          return { fired: false, reason: "rule-disabled" };
        }
        const now = nowFn();
        sweepDedupe(now);
        const dedupeKey = `${alert.type}:${alert.node || ""}:${alert.task || ""}`;
        const lastFired = dedupeLastFired.get(dedupeKey);
        if (lastFired !== void 0 && now - lastFired < DEDUPE_WINDOW_MS) {
          return { fired: false, reason: "deduped" };
        }
        dedupeLastFired.set(dedupeKey, now);
        recentAlerts = [...recentAlerts, alert].slice(-RING_BUFFER_SIZE);
        const sinks = config.sinks || {};
        const dispatches = [];
        for (const webhook of Array.isArray(sinks.webhooks) ? sinks.webhooks : []) {
          if (webhook && webhook.url && webhookMatchesEvent(webhook, alert.type)) {
            dispatches.push(dispatchToWebhook(webhook, alert));
          }
        }
        if (sinks.slack && sinks.slack.enabled && sinks.slack.gatewayUrl) {
          dispatches.push(dispatchToSlack(sinks.slack, alert));
        }
        if (sinks.ntfy && sinks.ntfy.enabled && sinks.ntfy.topic) {
          dispatches.push(dispatchToNtfy(sinks.ntfy, alert));
        }
        const results = await Promise.allSettled(dispatches);
        const delivered = results.filter((r) => r.status === "fulfilled" && r.value === true).length;
        return { fired: true, dispatched: dispatches.length, delivered };
      }
      function getRecent(limit = DEFAULT_RECENT_LIMIT) {
        const parsed = Number(limit);
        const effective = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_RECENT_LIMIT;
        return recentAlerts.slice(-effective).reverse();
      }
      return { fire, getRecent };
    }
    module2.exports = { createAlerts };
  }
});

// src/rate-limit.js
var require_rate_limit = __commonJS({
  "src/rate-limit.js"(exports2, module2) {
    var DEFAULT_WINDOW_MS = 6e4;
    var DEFAULT_MAX = 120;
    var STALE_WINDOW_MULTIPLIER = 2;
    function createRateLimiter({
      windowMs = DEFAULT_WINDOW_MS,
      max = DEFAULT_MAX,
      nowFn = Date.now
    } = {}) {
      if (!Number.isFinite(windowMs) || windowMs <= 0) {
        throw new TypeError("windowMs must be a positive number");
      }
      if (!Number.isFinite(max) || max <= 0) {
        throw new TypeError("max must be a positive number");
      }
      if (typeof nowFn !== "function") {
        throw new TypeError("nowFn must be a function");
      }
      const buckets = /* @__PURE__ */ new Map();
      let lastSweep = nowFn();
      function sweep(now) {
        if (now - lastSweep < windowMs) return;
        lastSweep = now;
        const staleBefore = now - windowMs * STALE_WINDOW_MULTIPLIER;
        for (const [key, bucket] of buckets) {
          if (bucket.lastSeen < staleBefore) {
            buckets.delete(key);
          }
        }
      }
      function check(key) {
        if (typeof key !== "string" || key.length === 0) {
          throw new TypeError("key must be a non-empty string");
        }
        const now = nowFn();
        sweep(now);
        const existing = buckets.get(key);
        const refilled = existing ? Math.min(max, existing.tokens + Math.max(0, now - existing.last) * max / windowMs) : max;
        if (refilled >= 1) {
          const tokens = refilled - 1;
          buckets.set(key, { tokens, last: now, lastSeen: now });
          return { allowed: true, remaining: Math.floor(tokens), retryAfterMs: 0 };
        }
        buckets.set(key, { tokens: refilled, last: now, lastSeen: now });
        return {
          allowed: false,
          remaining: 0,
          retryAfterMs: Math.ceil((1 - refilled) * windowMs / max)
        };
      }
      function size() {
        return buckets.size;
      }
      return { check, size };
    }
    module2.exports = { createRateLimiter };
  }
});

// src/fleet.js
var require_fleet = __commonJS({
  "src/fleet.js"(exports2, module2) {
    var path2 = require("path");
    var { createMesh } = require_mesh();
    var { createFederation } = require_federation();
    var { createTailscaleAdapter } = require_tailscale();
    var { createFleetChat } = require_fleet_chat();
    var { createKanban, createWatchdog } = require_kanban();
    var { createBriefs } = require_briefs();
    var { createEvolution } = require_evolution();
    var { createAudit } = require_audit();
    var { createCortex } = require_cortex();
    var { createAlerts } = require_alerts();
    var { createRateLimiter } = require_rate_limit();
    var CORTEX_SUMMARY_TTL_MS = 6e4;
    var TAILSCALE_PENDING_STATUS = Object.freeze({
      available: false,
      error: "tailscale status refresh pending",
      self: null,
      peers: []
    });
    function cortexPathOrDisabled(configured, stateDir, name) {
      return configured && configured.length > 0 ? configured : path2.join(stateDir, ".cortex-disabled", name);
    }
    function createNonBlockingTailscale(adapter = createTailscaleAdapter()) {
      let lastKnown = null;
      let refreshing = null;
      function refresh() {
        if (refreshing) return refreshing;
        refreshing = adapter.getStatus().then((status) => {
          lastKnown = status;
          return status;
        }).catch((e) => {
          lastKnown = { available: false, error: e.message, self: null, peers: [] };
          return lastKnown;
        }).finally(() => {
          refreshing = null;
        });
        return refreshing;
      }
      async function getStatus() {
        refresh();
        return lastKnown || TAILSCALE_PENDING_STATUS;
      }
      refresh();
      return { getStatus };
    }
    function createFleetRuntime2({ config, broadcast }) {
      if (!config || typeof config !== "object") {
        throw new Error("createFleetRuntime requires a config object");
      }
      const emit = typeof broadcast === "function" ? broadcast : () => {
      };
      const { stateDir, logsDir, briefsDir, workspaceDir } = config;
      const audit = createAudit({ logsDir });
      let alerts = createAlerts({ config: config.alerts });
      function applyAlertsConfig(alertsConfig) {
        alerts = createAlerts({ config: alertsConfig });
        console.log("[Fleet] Alerts engine rebuilt from updated settings");
      }
      async function fireAlert(event) {
        try {
          const result = await alerts.fire(event);
          if (result.fired) {
            emit("fleet.alert", {
              type: event.type,
              severity: event.severity || "info",
              node: event.node || null,
              task: event.task || null,
              message: event.message || "",
              ts: Date.now()
            });
          }
          return result;
        } catch (e) {
          console.error("[Fleet] Alert fire failed:", e.message);
          return { fired: false, reason: e.message };
        }
      }
      const mesh = createMesh({
        stateDir,
        intervalMs: config.mesh.intervalMs,
        // Non-blocking by design: mesh.getState() feeds GET /api/state, which
        // must never wait on the tailscale CLI / LocalAPI at request time.
        tailscale: createNonBlockingTailscale(),
        onChange: ({ node, previousStatus, status }) => {
          emit("fleet.mesh", { id: node.id, hostname: node.hostname, previousStatus, status });
          if (status === "offline") {
            fireAlert({
              type: "nodeOffline",
              severity: "critical",
              node: node.hostname,
              message: `Node ${node.hostname} went offline (was ${previousStatus})`
            });
          } else if (status === "unreachable") {
            fireAlert({
              type: "nodeUnreachable",
              severity: "warn",
              node: node.hostname,
              message: `Node ${node.hostname} is unreachable (was ${previousStatus})`
            });
          }
        }
      });
      const federation = createFederation({
        stateDir,
        intervalMs: config.federation.intervalMs,
        onChange: ({ remote, previousReachable, reachable }) => {
          emit("fleet.federation", {
            id: remote.id,
            label: remote.label,
            previousReachable,
            reachable
          });
        }
      });
      const chat = createFleetChat({ stateDir, logsDir });
      chat.onMessage((message) => {
        emit("fleet.chat", {
          id: message.id,
          sender: message.sender,
          receiver: message.receiver,
          ts: message.ts
        });
      });
      const kanban = createKanban({
        stateDir,
        onChange: (event) => {
          emit("fleet.kanban", { type: event.type, taskId: event.taskId || null });
          const movedToFailed = event.type === "task.moved" && event.to === "failed";
          const updatedToFailed = event.type === "task.updated" && event.task?.status === "failed" && event.previousStatus !== "failed";
          if (movedToFailed || updatedToFailed) {
            fireAlert({
              type: "taskFailed",
              severity: "critical",
              task: event.taskId,
              message: `Task ${event.taskId} marked failed`
            });
          }
        }
      });
      const watchdog = createWatchdog({
        kanban,
        thresholdMs: config.watchdog.thresholdMs,
        onStale: (task) => {
          fireAlert({
            type: "taskStale",
            severity: "warn",
            task: task.id,
            message: `Task "${task.title}" has had no activity past the staleness threshold`
          });
        }
      });
      const briefs = createBriefs({ briefsDir });
      const evolution = createEvolution({
        workspaceDir,
        stateDir,
        getGateDefault: () => config.validationGate.default,
        onChange: (event) => {
          emit("fleet.evolution", { type: event.type, id: event.id || event.lesson?.id || null });
          if (event.type === "lesson.add" && event.lesson?.status === "pending") {
            fireAlert({
              type: "lessonPending",
              severity: "info",
              message: `Lesson pending approval: ${event.lesson.title}`
            });
          }
        }
      });
      const cortex = createCortex({
        lancedb: { dbPath: cortexPathOrDisabled(config.cortex.lancedbPath, stateDir, "lancedb") },
        gbrain: { cliPath: cortexPathOrDisabled(config.cortex.gbrainCli, stateDir, "gbrain") },
        gauges: {
          paths: {
            headroom: config.cortex.headroomStats || "",
            leanCtx: config.cortex.leanCtxStats || "",
            lcmDb: config.cortex.lcmDb || ""
          }
        }
      });
      const rateLimiter = createRateLimiter({
        windowMs: config.rateLimit.windowMs,
        max: config.rateLimit.max
      });
      let boardWatcher = null;
      function start() {
        mesh.start();
        federation.start();
        watchdog.start();
        if (!boardWatcher) boardWatcher = kanban.watch();
      }
      function stop() {
        mesh.stop();
        federation.stop();
        watchdog.stop();
        if (boardWatcher) {
          boardWatcher.close();
          boardWatcher = null;
        }
        chat.close();
      }
      const cortexEnabled = config.cortex.enabled !== false;
      let cortexCache = { value: null, ts: 0 };
      let cortexRefresh = null;
      function refreshCortexAvailability() {
        if (cortexRefresh) return cortexRefresh;
        cortexRefresh = cortex.getState().then((cortexState) => {
          cortexCache = {
            value: {
              memory: cortexState.memory.available,
              gbrain: cortexState.gbrain.available,
              gauges: cortexState.gaugeSummary.available
            },
            ts: Date.now()
          };
          return cortexCache.value;
        }).catch((e) => {
          console.error("[Fleet] Cortex availability refresh failed:", e.message);
          return cortexCache.value;
        }).finally(() => {
          cortexRefresh = null;
        });
        return cortexRefresh;
      }
      function getCortexAvailability() {
        if (!cortexEnabled) {
          return { memory: false, gbrain: false, gauges: 0 };
        }
        if (!cortexCache.value || Date.now() - cortexCache.ts >= CORTEX_SUMMARY_TTL_MS) {
          refreshCortexAvailability();
        }
        return cortexCache.value || { memory: false, gbrain: false, gauges: 0 };
      }
      async function getSummary() {
        const summary = {
          mesh: { nodes: 0, online: 0 },
          chat: { recent: 0, total: 0 },
          kanban: { counts: {}, staleCount: 0 },
          evolution: { gate: null, pendingCount: 0 },
          cortex: { availability: { memory: false, gbrain: false, gauges: 0 } },
          alerts: { recent: 0 },
          federation: { remotes: 0, reachable: 0 }
        };
        try {
          const meshState = await mesh.getState();
          summary.mesh = {
            nodes: meshState.nodes.length,
            online: meshState.nodes.filter((n) => n.health.status === "online").length
          };
        } catch (e) {
          console.error("[Fleet] Summary mesh failed:", e.message);
        }
        try {
          const chatState = chat.getState();
          summary.chat = { recent: chatState.messages.length, total: chatState.counts.total };
        } catch (e) {
          console.error("[Fleet] Summary chat failed:", e.message);
        }
        try {
          const board = kanban.getBoard();
          const counts = {};
          let staleCount = 0;
          for (const task of board.tasks) {
            counts[task.status] = (counts[task.status] || 0) + 1;
            if (task.stale) staleCount++;
          }
          summary.kanban = { counts, staleCount };
        } catch (e) {
          console.error("[Fleet] Summary kanban failed:", e.message);
        }
        try {
          const evolutionState = evolution.getState();
          summary.evolution = {
            gate: evolutionState.gate,
            pendingCount: evolutionState.pending.length
          };
        } catch (e) {
          console.error("[Fleet] Summary evolution failed:", e.message);
        }
        try {
          summary.cortex = { availability: getCortexAvailability() };
        } catch (e) {
          console.error("[Fleet] Summary cortex failed:", e.message);
        }
        try {
          summary.alerts = { recent: alerts.getRecent().length };
        } catch (e) {
          console.error("[Fleet] Summary alerts failed:", e.message);
        }
        try {
          summary.federation = federation.getState().counts;
        } catch (e) {
          console.error("[Fleet] Summary federation failed:", e.message);
        }
        return summary;
      }
      return {
        mesh,
        federation,
        chat,
        kanban,
        watchdog,
        briefs,
        evolution,
        audit,
        cortex,
        // Getter so consumers (fleet-routes) always see the current instance
        // after a settings hot-swap.
        get alerts() {
          return alerts;
        },
        applyAlertsConfig,
        rateLimiter,
        fireAlert,
        start,
        stop,
        getSummary
      };
    }
    module2.exports = { createFleetRuntime: createFleetRuntime2 };
  }
});

// src/fleet-routes.js
var require_fleet_routes = __commonJS({
  "src/fleet-routes.js"(exports2, module2) {
    var DEFAULT_BODY_LIMIT = 64 * 1024;
    var BRIEF_BODY_LIMIT = Math.floor(1.25 * 1024 * 1024);
    var IDENTITY_HEADER = "tailscale-user-login";
    function isFleetRoute2(pathname) {
      return pathname === "/api/fleet" || pathname.startsWith("/api/fleet/");
    }
    function httpError(statusCode, message) {
      const err = new Error(message);
      err.statusCode = statusCode;
      return err;
    }
    function statusForError(err) {
      if (Number.isInteger(err.statusCode)) return err.statusCode;
      const message = err.message || "";
      if (/not found|^Unknown (node|task|remote)/i.test(message)) return 404;
      if (/expected "pending"/.test(message)) return 409;
      if (/too large/i.test(message)) return 413;
      return 400;
    }
    function json(res, statusCode, payload) {
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload, null, 2));
    }
    function getUser(req) {
      const login = req.headers[IDENTITY_HEADER];
      return typeof login === "string" && login.trim().length > 0 ? login.trim().toLowerCase() : "anonymous";
    }
    function readJsonBody(req, maxBytes = DEFAULT_BODY_LIMIT) {
      return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let aborted = false;
        req.on("data", (chunk) => {
          if (aborted) return;
          size += chunk.length;
          if (size > maxBytes) {
            aborted = true;
            reject(httpError(413, `Request body too large (max ${maxBytes} bytes)`));
            return;
          }
          chunks.push(chunk);
        });
        req.on("end", () => {
          if (aborted) return;
          if (chunks.length === 0) {
            resolve({});
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              reject(httpError(400, "Request body must be a JSON object"));
              return;
            }
            resolve(parsed);
          } catch (e) {
            reject(httpError(400, "Invalid JSON body"));
          }
        });
        req.on("error", (e) => {
          if (!aborted) reject(httpError(400, e.message));
        });
      });
    }
    function parseIntParam(query, name, fallback) {
      const raw = query.get(name);
      if (raw === null || raw === "") return fallback;
      const value = parseInt(raw, 10);
      if (!Number.isFinite(value)) throw httpError(400, `Invalid ${name} parameter`);
      return value;
    }
    function createFleetRoutes2({ fleet: fleet2, settings: settings2 = null }) {
      if (!fleet2) throw new Error("createFleetRoutes requires a fleet runtime");
      function guardMutation(req, res) {
        const user = getUser(req);
        const ip = req.socket?.remoteAddress || "unknown";
        const verdict = fleet2.rateLimiter.check(`${user}|${ip}`);
        if (!verdict.allowed) {
          json(res, 429, { error: "Rate limit exceeded", retryAfterMs: verdict.retryAfterMs });
          return null;
        }
        return user;
      }
      function recordAudit(user, action, target, detail) {
        try {
          fleet2.audit.record({ user, action, target, detail });
        } catch (e) {
          console.error("[FleetRoutes] Audit record failed:", e.message);
        }
      }
      async function handleMesh(req, res, method, segments) {
        if (segments.length === 1 && method === "GET") {
          json(res, 200, await fleet2.mesh.getState());
          return true;
        }
        if (segments[1] === "discover" && segments.length === 2 && method === "GET") {
          json(res, 200, await fleet2.mesh.discoverPeers());
          return true;
        }
        if (segments[1] === "nodes" && segments.length === 2 && method === "POST") {
          const user = guardMutation(req, res);
          if (!user) return true;
          const body = await readJsonBody(req);
          const node = fleet2.mesh.registerNode({ ...body, registeredBy: user });
          recordAudit(user, "node.register", node.hostname, { id: node.id });
          json(res, 200, { success: true, node });
          return true;
        }
        if (segments[1] === "nodes" && segments.length === 3 && method === "DELETE") {
          const user = guardMutation(req, res);
          if (!user) return true;
          const removed = fleet2.mesh.unregisterNode(segments[2]);
          recordAudit(user, "node.unregister", removed.hostname, { id: removed.id });
          json(res, 200, { success: true, node: removed });
          return true;
        }
        return false;
      }
      const FEDERATION_PROXY_AUDIT = {
        "lesson.approve": "lesson.approve",
        "lesson.reject": "lesson.reject",
        "gate.set": "gate.toggle",
        "task.move": "task.move"
      };
      async function handleFederation(req, res, method, segments) {
        if (segments.length === 1 && method === "GET") {
          json(res, 200, fleet2.federation.getState());
          return true;
        }
        if (segments[1] === "remotes" && segments.length === 2 && method === "POST") {
          const user = guardMutation(req, res);
          if (!user) return true;
          const body = await readJsonBody(req);
          const remote = fleet2.federation.addRemote({
            label: body.label,
            baseUrl: body.baseUrl,
            token: body.token,
            allowWrites: body.allowWrites,
            addedBy: user
          });
          recordAudit(user, "node.register", remote.baseUrl, { kind: "federation", id: remote.id });
          json(res, 200, { success: true, remote });
          return true;
        }
        if (segments[1] === "remotes" && segments.length === 3 && method === "PATCH") {
          const user = guardMutation(req, res);
          if (!user) return true;
          const body = await readJsonBody(req);
          if (typeof body.allowWrites !== "boolean") {
            throw httpError(400, "Body must include a boolean 'allowWrites' field");
          }
          const remote = fleet2.federation.setRemoteWrites(segments[2], body.allowWrites);
          recordAudit(user, "node.register", remote.baseUrl, {
            kind: "federation",
            change: "allowWrites",
            allowWrites: remote.allowWrites,
            id: remote.id
          });
          json(res, 200, { success: true, remote });
          return true;
        }
        if (segments[1] === "remotes" && segments.length === 4 && segments[3] === "actions" && method === "POST") {
          const user = guardMutation(req, res);
          if (!user) return true;
          const body = await readJsonBody(req);
          const params = body.params && typeof body.params === "object" ? body.params : {};
          const result = await fleet2.federation.performRemoteAction(segments[2], body.action, params, {
            actor: user
          });
          recordAudit(
            user,
            FEDERATION_PROXY_AUDIT[result.action],
            params.lessonId || params.taskId || null,
            {
              kind: "federation-proxy",
              remote: result.remoteId,
              action: result.action,
              remoteStatus: result.remoteStatus,
              ok: result.ok
            }
          );
          json(res, 200, { success: true, result });
          return true;
        }
        if (segments[1] === "remotes" && segments.length === 3 && method === "DELETE") {
          const user = guardMutation(req, res);
          if (!user) return true;
          const removed = fleet2.federation.removeRemote(segments[2]);
          recordAudit(user, "node.unregister", removed.baseUrl, {
            kind: "federation",
            id: removed.id
          });
          json(res, 200, { success: true, remote: removed });
          return true;
        }
        return false;
      }
      async function handleChat(req, res, method, segments, query) {
        if (segments.length === 1 && method === "GET") {
          const filters = {};
          if (query.get("sender")) filters.sender = query.get("sender");
          if (query.get("receiver")) filters.receiver = query.get("receiver");
          if (query.get("text")) filters.text = query.get("text");
          filters.limit = parseIntParam(query, "limit", 100);
          const before = parseIntParam(query, "before", null);
          if (before !== null) filters.before = before;
          json(res, 200, { messages: fleet2.chat.query(filters) });
          return true;
        }
        if (segments[1] === "publish" && segments.length === 2 && method === "POST") {
          const user = guardMutation(req, res);
          if (!user) return true;
          const body = await readJsonBody(req);
          const message = fleet2.chat.publish({
            sender: body.sender || user,
            receiver: body.receiver,
            payload: body.payload,
            toolCalls: body.toolCalls
          });
          json(res, 200, { success: true, message });
          return true;
        }
        return false;
      }
      async function handleKanban(req, res, method, segments) {
        if (segments.length === 1 && method === "GET") {
          json(res, 200, fleet2.kanban.getBoard());
          return true;
        }
        if (segments[1] !== "tasks") return false;
        if (segments.length === 2 && method === "POST") {
          const user = guardMutation(req, res);
          if (!user) return true;
          const body = await readJsonBody(req);
          const task = fleet2.kanban.createTask(body, user);
          recordAudit(user, "task.create", task.id, { title: task.title });
          json(res, 200, { success: true, task });
          return true;
        }
        const taskId = segments[2];
        if (!taskId) return false;
        if (segments.length === 3 && method === "PATCH") {
          const user = guardMutation(req, res);
          if (!user) return true;
          const body = await readJsonBody(req);
          const task = fleet2.kanban.updateTask(taskId, body, user);
          recordAudit(user, "task.update", taskId, { changes: Object.keys(body) });
          json(res, 200, { success: true, task });
          return true;
        }
        if (segments.length === 3 && method === "DELETE") {
          const user = guardMutation(req, res);
          if (!user) return true;
          const task = fleet2.kanban.deleteTask(taskId, user);
          recordAudit(user, "task.delete", taskId, { title: task.title });
          json(res, 200, { success: true, task });
          return true;
        }
        if (segments.length === 4 && method === "POST") {
          const action = segments[3];
          if (action === "move") {
            const user = guardMutation(req, res);
            if (!user) return true;
            const body = await readJsonBody(req);
            const task = fleet2.kanban.moveTask(taskId, body.status, body.order ?? 0, user);
            recordAudit(user, "task.move", taskId, { to: body.status });
            json(res, 200, { success: true, task });
            return true;
          }
          if (action === "comments") {
            const user = guardMutation(req, res);
            if (!user) return true;
            const body = await readJsonBody(req);
            const task = fleet2.kanban.addComment(taskId, {
              author: body.author || user,
              text: body.text
            });
            recordAudit(user, "task.comment", taskId, null);
            json(res, 200, { success: true, task });
            return true;
          }
          if (action === "attempts") {
            const user = guardMutation(req, res);
            if (!user) return true;
            const body = await readJsonBody(req);
            const task = fleet2.kanban.addAttempt(taskId, body);
            recordAudit(user, "task.update", taskId, { attempt: body.agent || null });
            json(res, 200, { success: true, task });
            return true;
          }
        }
        return false;
      }
      async function handleBriefs(req, res, method, segments) {
        if (segments.length === 1 && method === "GET") {
          json(res, 200, { briefs: fleet2.briefs.list() });
          return true;
        }
        if (segments.length !== 2) return false;
        const name = segments[1];
        if (method === "GET") {
          json(res, 200, fleet2.briefs.read(name));
          return true;
        }
        if (method === "PUT") {
          const user = guardMutation(req, res);
          if (!user) return true;
          const body = await readJsonBody(req, BRIEF_BODY_LIMIT);
          const result = fleet2.briefs.write(name, body.content);
          recordAudit(user, "brief.write", name, { size: result.size });
          json(res, 200, { success: true, brief: result });
          return true;
        }
        if (method === "DELETE") {
          const user = guardMutation(req, res);
          if (!user) return true;
          const result = fleet2.briefs.remove(name);
          recordAudit(user, "brief.delete", name, null);
          json(res, 200, { success: true, brief: result });
          return true;
        }
        return false;
      }
      async function handleEvolution(req, res, method, segments) {
        if (segments.length === 1 && method === "GET") {
          const state2 = fleet2.evolution.getState();
          json(res, 200, { ...state2, lessons: fleet2.evolution.listLessons() });
          return true;
        }
        if (segments[1] === "gate" && segments.length === 2) {
          if (method === "GET") {
            json(res, 200, { gate: fleet2.evolution.getGate() });
            return true;
          }
          if (method === "PUT") {
            const user = guardMutation(req, res);
            if (!user) return true;
            const body = await readJsonBody(req);
            if (typeof body.gate !== "boolean") {
              throw httpError(400, "Body must include a boolean 'gate' field");
            }
            const result = fleet2.evolution.setGate(body.gate, user);
            recordAudit(user, "gate.toggle", null, { gate: result.gate });
            json(res, 200, { success: true, ...result });
            return true;
          }
          return false;
        }
        if (segments[1] === "lessons" && segments.length === 2 && method === "POST") {
          const user = guardMutation(req, res);
          if (!user) return true;
          const body = await readJsonBody(req);
          const lesson = fleet2.evolution.addLesson({
            title: body.title,
            body: body.body,
            author: body.author || user
          });
          recordAudit(user, "lesson.add", lesson.id, { title: lesson.title, status: lesson.status });
          json(res, 200, { success: true, lesson });
          return true;
        }
        if (segments[1] === "lessons" && segments.length === 4 && method === "POST") {
          const lessonId = segments[2];
          const action = segments[3];
          if (action !== "approve" && action !== "reject") return false;
          const user = guardMutation(req, res);
          if (!user) return true;
          const lesson = action === "approve" ? fleet2.evolution.approve(lessonId, user) : fleet2.evolution.reject(lessonId, user);
          recordAudit(user, action === "approve" ? "lesson.approve" : "lesson.reject", lessonId, null);
          json(res, 200, { success: true, lesson });
          return true;
        }
        return false;
      }
      async function handleCortex(req, res, method, segments, query) {
        if (segments.length === 1 && method === "GET") {
          json(res, 200, await fleet2.cortex.getState());
          return true;
        }
        if (segments[1] === "memory" && segments.length === 2) {
          if (method === "GET") {
            const searchQuery = query.get("query");
            const limit = parseIntParam(query, "limit", null);
            const opts = limit !== null ? { limit } : {};
            const result = searchQuery ? await fleet2.cortex.searchMemory(searchQuery, opts) : await fleet2.cortex.listMemory(opts);
            if (result && result.error) {
              json(res, 503, { error: result.error });
              return true;
            }
            json(res, 200, result);
            return true;
          }
          if (method === "POST") {
            const user = guardMutation(req, res);
            if (!user) return true;
            const body = await readJsonBody(req);
            if (typeof body.text !== "string" || body.text.trim().length === 0) {
              throw httpError(400, "Body must include a non-empty 'text' field");
            }
            const result = await fleet2.cortex.storeMemory(body.text, body.options || {});
            if (result && result.error) {
              json(res, 503, { error: result.error });
              return true;
            }
            recordAudit(user, "memory.write", null, { bytes: Buffer.byteLength(body.text, "utf8") });
            json(res, 200, { success: true, result });
            return true;
          }
          return false;
        }
        if (segments[1] === "graph" && segments.length === 2 && method === "GET") {
          const result = await fleet2.cortex.getGraph({});
          if (result && result.error) {
            json(res, 503, { error: result.error });
            return true;
          }
          json(res, 200, result);
          return true;
        }
        if (segments[1] === "gauges" && segments.length === 2 && method === "GET") {
          json(res, 200, { gauges: fleet2.cortex.getGauges() });
          return true;
        }
        return false;
      }
      function handleAudit(res, method, segments, query) {
        if (segments.length !== 1 || method !== "GET") return false;
        const filters = { limit: parseIntParam(query, "limit", 200) };
        if (query.get("user")) filters.user = query.get("user");
        if (query.get("action")) filters.action = query.get("action");
        if (query.get("since")) filters.since = query.get("since");
        if (query.get("until")) filters.until = query.get("until");
        json(res, 200, { entries: fleet2.audit.query(filters) });
        return true;
      }
      function handleAlerts(res, method, segments, query) {
        if (segments.length !== 1 || method !== "GET") return false;
        json(res, 200, { alerts: fleet2.alerts.getRecent(parseIntParam(query, "limit", 50)) });
        return true;
      }
      async function handleSettings(req, res, method, segments) {
        if (!settings2) return false;
        if (segments.length === 1 && method === "GET") {
          json(res, 200, settings2.get());
          return true;
        }
        if (segments.length === 1 && method === "PATCH") {
          const user = guardMutation(req, res);
          if (!user) return true;
          const body = await readJsonBody(req);
          const result = settings2.update(body, user);
          recordAudit(user, "alerts.config", null, {
            sections: Object.keys(body),
            restartRequired: result.restartRequired
          });
          json(res, 200, {
            success: true,
            applied: result.applied,
            restartRequired: result.restartRequired
          });
          return true;
        }
        if (segments[1] === "test-alert" && segments.length === 2 && method === "POST") {
          const user = guardMutation(req, res);
          if (!user) return true;
          const body = await readJsonBody(req);
          const result = await fleet2.fireAlert({
            type: "testAlert",
            severity: "info",
            task: String(Date.now()),
            message: typeof body.message === "string" && body.message ? body.message : "Test alert from Settings"
          });
          json(res, 200, { success: true, result });
          return true;
        }
        return false;
      }
      async function dispatch(req, res, pathname, query) {
        const method = req.method || "GET";
        let segments;
        try {
          segments = pathname.slice("/api/fleet".length).split("/").filter(Boolean).map((s) => decodeURIComponent(s));
        } catch (e) {
          throw httpError(400, "Malformed URL encoding");
        }
        if (segments.length === 0) return false;
        switch (segments[0]) {
          case "mesh":
            return handleMesh(req, res, method, segments);
          case "federation":
            return handleFederation(req, res, method, segments);
          case "costs":
            if (segments.length === 1 && method === "GET") {
              json(res, 200, await fleet2.mesh.getFleetCosts());
              return true;
            }
            return false;
          case "chat":
            return handleChat(req, res, method, segments, query);
          case "kanban":
            return handleKanban(req, res, method, segments);
          case "briefs":
            return handleBriefs(req, res, method, segments);
          case "evolution":
            return handleEvolution(req, res, method, segments);
          case "cortex":
            return handleCortex(req, res, method, segments, query);
          case "audit":
            return handleAudit(res, method, segments, query);
          case "alerts":
            return handleAlerts(res, method, segments, query);
          case "settings":
            return handleSettings(req, res, method, segments);
          default:
            return false;
        }
      }
      async function handle(req, res, pathname, query) {
        try {
          const handled = await dispatch(req, res, pathname, query);
          if (!handled) {
            json(res, 404, { error: `Unknown fleet route: ${req.method} ${pathname}` });
          }
        } catch (err) {
          const statusCode = statusForError(err);
          if (statusCode >= 500) {
            console.error("[FleetRoutes] Internal error:", err);
          }
          json(res, statusCode, { error: err.message || "Internal error" });
        }
      }
      return { handle, isFleetRoute: isFleetRoute2 };
    }
    module2.exports = { createFleetRoutes: createFleetRoutes2, isFleetRoute: isFleetRoute2 };
  }
});

// src/settings.js
var require_settings = __commonJS({
  "src/settings.js"(exports2, module2) {
    var fs2 = require("fs");
    var crypto = require("crypto");
    var INTERVAL_MIN_MS = 5e3;
    var INTERVAL_MAX_MS = 36e5;
    var MAX_URL_LENGTH = 2048;
    var MAX_CHANNEL_LENGTH = 120;
    var MAX_TOPIC_LENGTH = 256;
    var MAX_SECRET_LENGTH = 512;
    var MAX_WEBHOOKS = 20;
    var NTFY_TOPIC_RE = /^[A-Za-z0-9_-]+$/;
    var NTFY_DEFAULT_SERVER = "https://ntfy.sh";
    var ALERT_RULES = ["nodeOffline", "nodeUnreachable", "taskFailed", "taskStale", "lessonPending"];
    var EDITABLE_DEFAULTS = Object.freeze({
      alerts: {
        enabled: false,
        rules: {
          nodeOffline: true,
          nodeUnreachable: true,
          taskFailed: true,
          taskStale: true,
          lessonPending: true
        },
        sinks: {
          slack: { enabled: false, gatewayUrl: "", channel: "" },
          ntfy: { enabled: false, server: NTFY_DEFAULT_SERVER, topic: "" },
          webhooks: []
        }
      },
      mesh: { intervalMs: 15e3 },
      watchdog: { thresholdMs: 18e5 },
      validationGate: { default: true },
      federation: { intervalMs: 3e4 }
    });
    var RESTART_PATHS = /* @__PURE__ */ new Set([
      "mesh.intervalMs",
      "federation.intervalMs",
      "watchdog.thresholdMs",
      "validationGate.default"
    ]);
    function badRequest(message) {
      const err = new Error(message);
      err.statusCode = 400;
      return err;
    }
    function isPlainObject(value) {
      return value !== null && typeof value === "object" && !Array.isArray(value);
    }
    function requireBool(value, label) {
      if (typeof value !== "boolean") throw badRequest(`${label} must be a boolean`);
      return value;
    }
    function requireUrl(value, label, { allowEmpty = false } = {}) {
      if (typeof value !== "string") throw badRequest(`${label} must be a string`);
      if (value === "") {
        if (allowEmpty) return value;
        throw badRequest(`${label} must not be empty`);
      }
      if (value.length > MAX_URL_LENGTH) throw badRequest(`${label} is too long`);
      let parsed;
      try {
        parsed = new URL(value);
      } catch (err) {
        throw badRequest(`${label} must be a valid URL`);
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw badRequest(`${label} must use http:// or https://`);
      }
      return value;
    }
    function requireIntervalMs(value, label) {
      if (!Number.isInteger(value) || value < INTERVAL_MIN_MS || value > INTERVAL_MAX_MS) {
        throw badRequest(
          `${label} must be an integer between ${INTERVAL_MIN_MS} and ${INTERVAL_MAX_MS} ms`
        );
      }
      return value;
    }
    function requireKnownKeys(obj, allowed, label) {
      if (!isPlainObject(obj)) throw badRequest(`${label} must be an object`);
      for (const key of Object.keys(obj)) {
        if (!allowed.includes(key)) throw badRequest(`${label}: unknown key "${key}"`);
      }
    }
    function validateEvents(value, label) {
      if (!Array.isArray(value) || value.length === 0) {
        throw badRequest(`${label} must be a non-empty array`);
      }
      for (const event of value) {
        if (event !== "*" && !ALERT_RULES.includes(event)) {
          throw badRequest(`${label}: unknown event "${event}"`);
        }
      }
      return [...value];
    }
    function validateNtfyTopic(value, label) {
      if (typeof value !== "string") throw badRequest(`${label} must be a string`);
      if (value === "") return value;
      if (value.length > MAX_TOPIC_LENGTH || !NTFY_TOPIC_RE.test(value)) {
        throw badRequest(`${label} must match [A-Za-z0-9_-] (max ${MAX_TOPIC_LENGTH} chars)`);
      }
      return value;
    }
    function validateSecret(value, label) {
      if (value === null) return null;
      if (typeof value !== "string" || value.length === 0) {
        throw badRequest(`${label} must be a non-empty string (or null to clear)`);
      }
      if (value.length > MAX_SECRET_LENGTH) throw badRequest(`${label} is too long`);
      return value;
    }
    function validatePatch(patch) {
      if (!isPlainObject(patch) || Object.keys(patch).length === 0) {
        throw badRequest("patch must be a non-empty object");
      }
      requireKnownKeys(patch, ["alerts", "mesh", "federation", "watchdog", "validationGate"], "patch");
      const result = {};
      if (patch.alerts !== void 0) {
        requireKnownKeys(patch.alerts, ["enabled", "rules", "sinks"], "alerts");
        const alerts = {};
        if (patch.alerts.enabled !== void 0) {
          alerts.enabled = requireBool(patch.alerts.enabled, "alerts.enabled");
        }
        if (patch.alerts.rules !== void 0) {
          requireKnownKeys(patch.alerts.rules, ALERT_RULES, "alerts.rules");
          alerts.rules = {};
          for (const [rule, value] of Object.entries(patch.alerts.rules)) {
            alerts.rules[rule] = requireBool(value, `alerts.rules.${rule}`);
          }
        }
        if (patch.alerts.sinks !== void 0) {
          requireKnownKeys(patch.alerts.sinks, ["slack", "ntfy", "webhooks"], "alerts.sinks");
          alerts.sinks = {};
          if (patch.alerts.sinks.slack !== void 0) {
            alerts.sinks.slack = validateSlackPatch(patch.alerts.sinks.slack);
          }
          if (patch.alerts.sinks.ntfy !== void 0) {
            alerts.sinks.ntfy = validateNtfyPatch(patch.alerts.sinks.ntfy);
          }
          if (patch.alerts.sinks.webhooks !== void 0) {
            alerts.sinks.webhooks = validateWebhookOps(patch.alerts.sinks.webhooks);
          }
        }
        result.alerts = alerts;
      }
      for (const [section, field] of [
        ["mesh", "intervalMs"],
        ["federation", "intervalMs"],
        ["watchdog", "thresholdMs"]
      ]) {
        if (patch[section] !== void 0) {
          requireKnownKeys(patch[section], [field], section);
          if (patch[section][field] === void 0) throw badRequest(`${section}.${field} is required`);
          result[section] = {
            [field]: requireIntervalMs(patch[section][field], `${section}.${field}`)
          };
        }
      }
      if (patch.validationGate !== void 0) {
        requireKnownKeys(patch.validationGate, ["default"], "validationGate");
        if (patch.validationGate.default === void 0) {
          throw badRequest("validationGate.default is required");
        }
        result.validationGate = {
          default: requireBool(patch.validationGate.default, "validationGate.default")
        };
      }
      return result;
    }
    function validateSlackPatch(slack) {
      requireKnownKeys(slack, ["enabled", "gatewayUrl", "channel"], "alerts.sinks.slack");
      const out = {};
      if (slack.enabled !== void 0) {
        out.enabled = requireBool(slack.enabled, "alerts.sinks.slack.enabled");
      }
      if (slack.gatewayUrl !== void 0) {
        out.gatewayUrl = requireUrl(slack.gatewayUrl, "alerts.sinks.slack.gatewayUrl", {
          allowEmpty: true
        });
      }
      if (slack.channel !== void 0) {
        if (typeof slack.channel !== "string" || slack.channel.length > MAX_CHANNEL_LENGTH) {
          throw badRequest(`alerts.sinks.slack.channel must be a string (max ${MAX_CHANNEL_LENGTH})`);
        }
        out.channel = slack.channel;
      }
      return out;
    }
    function validateNtfyPatch(ntfy) {
      requireKnownKeys(ntfy, ["enabled", "server", "topic"], "alerts.sinks.ntfy");
      const out = {};
      if (ntfy.enabled !== void 0) {
        out.enabled = requireBool(ntfy.enabled, "alerts.sinks.ntfy.enabled");
      }
      if (ntfy.server !== void 0) {
        out.server = requireUrl(ntfy.server, "alerts.sinks.ntfy.server");
      }
      if (ntfy.topic !== void 0) {
        out.topic = validateNtfyTopic(ntfy.topic, "alerts.sinks.ntfy.topic");
      }
      return out;
    }
    function validateWebhookOps(ops) {
      requireKnownKeys(ops, ["add", "update", "remove"], "alerts.sinks.webhooks");
      const out = {};
      if (ops.add !== void 0) {
        if (!Array.isArray(ops.add)) throw badRequest("alerts.sinks.webhooks.add must be an array");
        out.add = ops.add.map((entry, i) => {
          requireKnownKeys(entry, ["url", "secret", "events"], `webhooks.add[${i}]`);
          const item = { url: requireUrl(entry.url, `webhooks.add[${i}].url`) };
          if (entry.secret !== void 0) {
            const secret = validateSecret(entry.secret, `webhooks.add[${i}].secret`);
            if (secret !== null) item.secret = secret;
          }
          item.events = entry.events !== void 0 ? validateEvents(entry.events, `webhooks.add[${i}].events`) : ["*"];
          return item;
        });
      }
      if (ops.update !== void 0) {
        if (!Array.isArray(ops.update)) {
          throw badRequest("alerts.sinks.webhooks.update must be an array");
        }
        out.update = ops.update.map((entry, i) => {
          requireKnownKeys(entry, ["id", "url", "secret", "events"], `webhooks.update[${i}]`);
          if (typeof entry.id !== "string" || entry.id.length === 0) {
            throw badRequest(`webhooks.update[${i}].id is required`);
          }
          const item = { id: entry.id };
          if (entry.url !== void 0) item.url = requireUrl(entry.url, `webhooks.update[${i}].url`);
          if (entry.secret !== void 0) {
            item.secret = validateSecret(entry.secret, `webhooks.update[${i}].secret`);
          }
          if (entry.events !== void 0) {
            item.events = validateEvents(entry.events, `webhooks.update[${i}].events`);
          }
          return item;
        });
      }
      if (ops.remove !== void 0) {
        if (!Array.isArray(ops.remove)) {
          throw badRequest("alerts.sinks.webhooks.remove must be an array");
        }
        out.remove = ops.remove.map((id, i) => {
          if (typeof id !== "string" || id.length === 0) {
            throw badRequest(`webhooks.remove[${i}] must be a webhook id`);
          }
          return id;
        });
      }
      return out;
    }
    function newWebhookId() {
      return `wh_${crypto.randomBytes(5).toString("hex")}`;
    }
    function derivedWebhookId(webhook, index) {
      const material = `${webhook.url || ""}|${index}`;
      return `wh_${crypto.createHash("sha256").update(material).digest("hex").slice(0, 10)}`;
    }
    function normalizeWebhooks(raw) {
      const list = Array.isArray(raw) ? raw : [];
      return list.filter((wh) => isPlainObject(wh) && typeof wh.url === "string").map((wh, index) => {
        const entry = {
          id: typeof wh.id === "string" && wh.id.length > 0 ? wh.id : derivedWebhookId(wh, index),
          url: wh.url,
          events: Array.isArray(wh.events) && wh.events.length > 0 ? [...wh.events] : ["*"]
        };
        if (typeof wh.secret === "string" && wh.secret.length > 0) entry.secret = wh.secret;
        return entry;
      });
    }
    function buildEffective(fleet2) {
      const src = isPlainObject(fleet2) ? fleet2 : {};
      const alerts = isPlainObject(src.alerts) ? src.alerts : {};
      const rules = isPlainObject(alerts.rules) ? alerts.rules : {};
      const sinks = isPlainObject(alerts.sinks) ? alerts.sinks : {};
      const slack = isPlainObject(sinks.slack) ? sinks.slack : {};
      const ntfy = isPlainObject(sinks.ntfy) ? sinks.ntfy : {};
      const d = EDITABLE_DEFAULTS;
      const pickBool = (value, fallback) => typeof value === "boolean" ? value : fallback;
      const pickStr = (value, fallback) => typeof value === "string" ? value : fallback;
      const pickInt = (value, fallback) => Number.isInteger(value) ? value : fallback;
      return {
        alerts: {
          enabled: pickBool(alerts.enabled, d.alerts.enabled),
          rules: Object.fromEntries(
            ALERT_RULES.map((rule) => [rule, pickBool(rules[rule], d.alerts.rules[rule])])
          ),
          sinks: {
            slack: {
              enabled: pickBool(slack.enabled, d.alerts.sinks.slack.enabled),
              gatewayUrl: pickStr(slack.gatewayUrl, d.alerts.sinks.slack.gatewayUrl),
              channel: pickStr(slack.channel, d.alerts.sinks.slack.channel)
            },
            ntfy: {
              enabled: pickBool(ntfy.enabled, d.alerts.sinks.ntfy.enabled),
              server: pickStr(ntfy.server, d.alerts.sinks.ntfy.server) || NTFY_DEFAULT_SERVER,
              topic: pickStr(ntfy.topic, d.alerts.sinks.ntfy.topic)
            },
            webhooks: normalizeWebhooks(sinks.webhooks)
          }
        },
        mesh: { intervalMs: pickInt(src.mesh && src.mesh.intervalMs, d.mesh.intervalMs) },
        watchdog: {
          thresholdMs: pickInt(src.watchdog && src.watchdog.thresholdMs, d.watchdog.thresholdMs)
        },
        validationGate: {
          default: pickBool(src.validationGate && src.validationGate.default, d.validationGate.default)
        },
        federation: {
          intervalMs: pickInt(src.federation && src.federation.intervalMs, d.federation.intervalMs)
        }
      };
    }
    function redact(effective) {
      return {
        ...effective,
        alerts: {
          ...effective.alerts,
          sinks: {
            ...effective.alerts.sinks,
            webhooks: effective.alerts.sinks.webhooks.map(({ secret, ...rest }) => ({
              ...rest,
              hasSecret: typeof secret === "string" && secret.length > 0
            }))
          }
        }
      };
    }
    function changedPaths(before, after, prefix = "") {
      const paths = [];
      const keys = /* @__PURE__ */ new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
      for (const key of keys) {
        const a = before ? before[key] : void 0;
        const b = after ? after[key] : void 0;
        const path2 = prefix ? `${prefix}.${key}` : key;
        if (isPlainObject(a) && isPlainObject(b)) {
          paths.push(...changedPaths(a, b, path2));
        } else if (JSON.stringify(a) !== JSON.stringify(b)) {
          paths.push(path2);
        }
      }
      return paths;
    }
    function createSettings2({ configPath, onChange } = {}) {
      if (typeof configPath !== "string" || configPath.length === 0) {
        throw new TypeError("configPath is required");
      }
      if (onChange !== void 0 && typeof onChange !== "function") {
        throw new TypeError("onChange must be a function when provided");
      }
      function readConfigFile() {
        let raw = {};
        try {
          if (fs2.existsSync(configPath)) {
            raw = JSON.parse(fs2.readFileSync(configPath, "utf8"));
          }
        } catch (err) {
          throw new Error(`Failed to read settings file ${configPath}: ${err.message}`);
        }
        if (!isPlainObject(raw)) raw = {};
        return raw;
      }
      function writeConfigFile(raw) {
        const tmpFile = `${configPath}.tmp-${process.pid}`;
        fs2.writeFileSync(tmpFile, `${JSON.stringify(raw, null, 2)}
`);
        fs2.renameSync(tmpFile, configPath);
      }
      function get() {
        const raw = readConfigFile();
        return redact(buildEffective(raw.fleet));
      }
      function getAlertsConfig() {
        const raw = readConfigFile();
        return buildEffective(raw.fleet).alerts;
      }
      function applyWebhookOps(webhooks, ops) {
        let next = webhooks.map((wh) => ({ ...wh }));
        for (const id of ops.remove || []) {
          const index = next.findIndex((wh) => wh.id === id);
          if (index === -1) throw badRequest(`Unknown webhook id "${id}"`);
          next = [...next.slice(0, index), ...next.slice(index + 1)];
        }
        for (const patch of ops.update || []) {
          const index = next.findIndex((wh) => wh.id === patch.id);
          if (index === -1) throw badRequest(`Unknown webhook id "${patch.id}"`);
          const current = next[index];
          const updated = { ...current };
          if (patch.url !== void 0) updated.url = patch.url;
          if (patch.events !== void 0) updated.events = patch.events;
          if (patch.secret !== void 0) {
            if (patch.secret === null) delete updated.secret;
            else updated.secret = patch.secret;
          }
          next = [...next.slice(0, index), updated, ...next.slice(index + 1)];
        }
        for (const entry of ops.add || []) {
          next = [...next, { id: newWebhookId(), ...entry }];
        }
        if (next.length > MAX_WEBHOOKS) {
          throw badRequest(`Too many webhooks (max ${MAX_WEBHOOKS})`);
        }
        return next;
      }
      function update(patch, actor = "anonymous") {
        const validated = validatePatch(patch);
        const raw = readConfigFile();
        const fleetBefore = isPlainObject(raw.fleet) ? raw.fleet : {};
        const before = buildEffective(fleetBefore);
        const next = { ...fleetBefore };
        for (const section of ["mesh", "federation", "watchdog", "validationGate"]) {
          if (validated[section]) {
            next[section] = {
              ...isPlainObject(fleetBefore[section]) ? fleetBefore[section] : {},
              ...validated[section]
            };
          }
        }
        if (validated.alerts) {
          const alertsBefore = isPlainObject(fleetBefore.alerts) ? fleetBefore.alerts : {};
          const alertsNext = { ...alertsBefore };
          if (validated.alerts.enabled !== void 0) alertsNext.enabled = validated.alerts.enabled;
          if (validated.alerts.rules) {
            alertsNext.rules = {
              ...before.alerts.rules,
              ...validated.alerts.rules
            };
          }
          if (validated.alerts.sinks) {
            const sinksBefore = isPlainObject(alertsBefore.sinks) ? alertsBefore.sinks : {};
            const sinksNext = { ...sinksBefore };
            if (validated.alerts.sinks.slack) {
              sinksNext.slack = { ...before.alerts.sinks.slack, ...validated.alerts.sinks.slack };
            }
            if (validated.alerts.sinks.ntfy) {
              sinksNext.ntfy = { ...before.alerts.sinks.ntfy, ...validated.alerts.sinks.ntfy };
            }
            if (validated.alerts.sinks.webhooks) {
              sinksNext.webhooks = applyWebhookOps(
                before.alerts.sinks.webhooks,
                validated.alerts.sinks.webhooks
              );
            }
            alertsNext.sinks = sinksNext;
          }
          next.alerts = alertsNext;
        }
        const after = buildEffective(next);
        const changed = changedPaths(before, after);
        if (changed.length > 0) {
          writeConfigFile({ ...raw, fleet: next });
          console.log(`[Settings] ${actor} updated: ${changed.join(", ")}`);
        }
        const alertsChanged = changed.some((p) => p === "alerts" || p.startsWith("alerts."));
        const hotApplyAlerts = typeof onChange === "function";
        const restartRequired = changed.filter((p) => {
          if (RESTART_PATHS.has(p)) return true;
          if (p === "alerts" || p.startsWith("alerts.")) return !hotApplyAlerts;
          return false;
        });
        if (alertsChanged && hotApplyAlerts) {
          try {
            onChange(after.alerts);
          } catch (err) {
            console.error("[Settings] onChange hook failed:", err.message);
          }
        }
        return { applied: redact(after), restartRequired };
      }
      return { get, update, getAlertsConfig };
    }
    module2.exports = { createSettings: createSettings2 };
  }
});

// src/docker.js
var require_docker = __commonJS({
  "src/docker.js"(exports2, module2) {
    var http2 = require("http");
    var DOCKER_API_VERSION = "v1.41";
    var DEFAULT_SOCKET_PATH = "/var/run/docker.sock";
    var DEFAULT_INTERVAL_MS = 15e3;
    var DEFAULT_REQUEST_TIMEOUT_MS = 1e4;
    var STATS_CONCURRENCY = 3;
    function parseHealth(statusText, inspectHealth) {
      if (typeof inspectHealth === "string") {
        const normalized = inspectHealth.toLowerCase();
        if (["healthy", "unhealthy", "starting"].includes(normalized)) return normalized;
        if (normalized === "none") return null;
      }
      if (typeof statusText === "string") {
        const match = statusText.match(/\((healthy|unhealthy|health: starting)\)/i);
        if (match) {
          const token = match[1].toLowerCase();
          return token === "health: starting" ? "starting" : token;
        }
      }
      return null;
    }
    function computeCpuPct(stats) {
      const cpu = stats && stats.cpu_stats;
      const pre = stats && stats.precpu_stats;
      const cpuTotal = cpu && cpu.cpu_usage && cpu.cpu_usage.total_usage;
      const preTotal = pre && pre.cpu_usage && pre.cpu_usage.total_usage;
      const sysNow = cpu && cpu.system_cpu_usage;
      const sysPre = pre && pre.system_cpu_usage;
      if (![cpuTotal, preTotal, sysNow, sysPre].every((v) => Number.isFinite(v))) return null;
      const cpuDelta = cpuTotal - preTotal;
      const systemDelta = sysNow - sysPre;
      if (cpuDelta <= 0 || systemDelta <= 0) return 0;
      const onlineCpus = Number.isFinite(cpu.online_cpus) && cpu.online_cpus > 0 && cpu.online_cpus || Array.isArray(cpu.cpu_usage.percpu_usage) && cpu.cpu_usage.percpu_usage.length || 1;
      return cpuDelta / systemDelta * onlineCpus * 100;
    }
    function computeMemStats(stats) {
      const mem = stats && stats.memory_stats;
      if (!mem || !Number.isFinite(mem.usage)) {
        return { memUsageBytes: null, memLimitBytes: null, memPct: null };
      }
      const detail = mem.stats && typeof mem.stats === "object" ? mem.stats : {};
      const cacheBytes = Number.isFinite(detail.inactive_file) ? detail.inactive_file : Number.isFinite(detail.cache) ? detail.cache : 0;
      const memUsageBytes = Math.max(0, mem.usage - cacheBytes);
      const memLimitBytes = Number.isFinite(mem.limit) && mem.limit > 0 ? mem.limit : null;
      const memPct = memLimitBytes !== null ? memUsageBytes / memLimitBytes * 100 : null;
      return { memUsageBytes, memLimitBytes, memPct };
    }
    function summarizePorts(ports) {
      if (!Array.isArray(ports)) return [];
      const seen = /* @__PURE__ */ new Set();
      const out = [];
      for (const port of ports) {
        if (!port || !Number.isFinite(port.PrivatePort)) continue;
        const type = port.Type || "tcp";
        let summary;
        if (Number.isFinite(port.PublicPort)) {
          const host = port.IP && port.IP !== "0.0.0.0" && port.IP !== "::" ? `${port.IP}:` : "";
          summary = `${host}${port.PublicPort}\u2192${port.PrivatePort}/${type}`;
        } else {
          summary = `${port.PrivatePort}/${type}`;
        }
        if (!seen.has(summary)) {
          seen.add(summary);
          out.push(summary);
        }
      }
      return out;
    }
    function isRunningPortainer(container) {
      if (!container || container.state !== "running") return false;
      const image = String(container.image || "").toLowerCase();
      const name = String(container.name || "").toLowerCase();
      return image.startsWith("portainer/") || image.includes("/portainer") || name === "portainer";
    }
    async function mapWithConcurrency(items, limit, fn) {
      const results = new Array(items.length);
      let nextIndex = 0;
      const workerCount = Math.max(1, Math.min(limit, items.length));
      const workers = Array.from({ length: workerCount }, async () => {
        while (nextIndex < items.length) {
          const i = nextIndex++;
          results[i] = await fn(items[i], i);
        }
      });
      await Promise.all(workers);
      return results;
    }
    function describeSocketError(err, socketPath) {
      const code = err && err.code;
      if (code === "ENOENT") return `Docker socket not found at ${socketPath}`;
      if (code === "EACCES" || code === "EPERM") {
        return `Permission denied on ${socketPath} \u2014 is this user in the docker group?`;
      }
      if (code === "ECONNREFUSED") return `Docker daemon not responding on ${socketPath}`;
      return err && err.message || "Docker API request failed";
    }
    function createSocketFetch(socketPath, timeoutMs) {
      return function socketFetch(apiPath) {
        return new Promise((resolve, reject) => {
          const request = http2.request(
            // Method is a literal — never caller-supplied (read-only guarantee).
            { socketPath, path: apiPath, method: "GET", headers: { Host: "docker" } },
            (response) => {
              const chunks = [];
              response.on("data", (chunk) => chunks.push(chunk));
              response.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                resolve({
                  ok: response.statusCode >= 200 && response.statusCode < 300,
                  status: response.statusCode,
                  json: async () => JSON.parse(body)
                });
              });
              response.on("error", reject);
            }
          );
          request.setTimeout(timeoutMs, () => {
            request.destroy(new Error(`Docker API timeout after ${timeoutMs}ms (${apiPath})`));
          });
          request.on("error", reject);
          request.end();
        });
      };
    }
    function createDocker2(options = {}) {
      const {
        socketPath = DEFAULT_SOCKET_PATH,
        intervalMs = DEFAULT_INTERVAL_MS,
        requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
        onChange = null,
        portainerUrl = null,
        nowFn = Date.now
      } = options;
      const fetchFn = options.fetchFn || createSocketFetch(socketPath, requestTimeoutMs);
      let snapshot = {
        available: false,
        containers: [],
        lastChecked: null,
        error: null
      };
      let previousByid = /* @__PURE__ */ new Map();
      let pollTimer = null;
      async function dockerGet(apiPath) {
        const response = await fetchFn(apiPath, { method: "GET" });
        if (!response || response.ok !== true) {
          const status = response ? response.status : "no response";
          throw new Error(`Docker API ${apiPath} failed (${status})`);
        }
        return response.json();
      }
      function emitChange(container, previousState, previousHealth) {
        if (typeof onChange !== "function") return;
        try {
          onChange({ container, previousState, previousHealth });
        } catch (err) {
          console.error("[Docker] onChange callback failed:", err.message);
        }
      }
      async function fetchInspect(id) {
        try {
          return await dockerGet(`/${DOCKER_API_VERSION}/containers/${id}/json`);
        } catch (err) {
          return null;
        }
      }
      async function fetchStats(id) {
        try {
          return await dockerGet(`/${DOCKER_API_VERSION}/containers/${id}/stats?stream=false`);
        } catch (err) {
          return null;
        }
      }
      function buildContainerRecord(listed, inspect, stats) {
        const id = listed.Id || "";
        const rawName = Array.isArray(listed.Names) && listed.Names[0] ? listed.Names[0] : id;
        const inspectState = inspect && inspect.State && typeof inspect.State === "object";
        const startedAtRaw = inspectState ? inspect.State.StartedAt : null;
        const startedAt = typeof startedAtRaw === "string" && !startedAtRaw.startsWith("0001-") ? startedAtRaw : null;
        const inspectHealth = inspectState && inspect.State.Health && typeof inspect.State.Health === "object" ? inspect.State.Health.Status : null;
        const { memUsageBytes, memLimitBytes, memPct } = computeMemStats(stats);
        return {
          id,
          id12: id.slice(0, 12),
          name: rawName.replace(/^\//, ""),
          image: listed.Image || "",
          state: listed.State || "unknown",
          status: listed.Status || "",
          health: parseHealth(listed.Status, inspectHealth),
          createdAt: Number.isFinite(listed.Created) ? new Date(listed.Created * 1e3).toISOString() : null,
          startedAt,
          restartCount: inspect && Number.isFinite(inspect.RestartCount) ? inspect.RestartCount : null,
          ports: summarizePorts(listed.Ports),
          cpuPct: computeCpuPct(stats),
          memUsageBytes,
          memLimitBytes,
          memPct
        };
      }
      async function _pollOnce() {
        const checkedAt = nowFn();
        let listed;
        try {
          listed = await dockerGet(`/${DOCKER_API_VERSION}/containers/json?all=true`);
        } catch (err) {
          snapshot = {
            available: false,
            containers: [],
            lastChecked: checkedAt,
            error: describeSocketError(err, socketPath)
          };
          return snapshot;
        }
        const list = Array.isArray(listed) ? listed.filter((c) => c && typeof c === "object") : [];
        const containers = await mapWithConcurrency(list, STATS_CONCURRENCY, async (item) => {
          const id = item.Id || "";
          const [inspect, stats] = await Promise.all([
            fetchInspect(id),
            item.State === "running" ? fetchStats(id) : Promise.resolve(null)
          ]);
          return buildContainerRecord(item, inspect, stats);
        });
        const nextById = /* @__PURE__ */ new Map();
        for (const container of containers) {
          nextById.set(container.id12, { state: container.state, health: container.health });
          const prev = previousByid.get(container.id12);
          if (!prev || prev.state !== container.state || prev.health !== container.health) {
            emitChange(container, prev ? prev.state : null, prev ? prev.health : null);
          }
        }
        for (const [id12, prev] of previousByid) {
          if (!nextById.has(id12)) {
            emitChange({ id12, state: "removed", health: null }, prev.state, prev.health);
          }
        }
        previousByid = nextById;
        snapshot = { available: true, containers, lastChecked: checkedAt, error: null };
        return snapshot;
      }
      function getState() {
        const portainerDetected = snapshot.containers.some(isRunningPortainer);
        return {
          ...snapshot,
          containers: [...snapshot.containers],
          portainerUrl: portainerUrl && portainerDetected ? portainerUrl : null,
          intervalMs
        };
      }
      function start() {
        if (pollTimer) return;
        _pollOnce().catch((err) => console.error("[Docker] Poll failed:", err.message));
        pollTimer = setInterval(() => {
          _pollOnce().catch((err) => console.error("[Docker] Poll failed:", err.message));
        }, intervalMs);
        if (typeof pollTimer.unref === "function") pollTimer.unref();
        console.log(`[Docker] Container poller started (${intervalMs}ms interval)`);
      }
      function stop() {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
          console.log("[Docker] Container poller stopped");
        }
      }
      const routes = {
        "GET /api/docker": async (req, res) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(getState(), null, 2));
        }
      };
      return { start, stop, getState, routes, _pollOnce };
    }
    module2.exports = {
      createDocker: createDocker2,
      parseHealth,
      computeCpuPct,
      computeMemStats,
      summarizePorts,
      isRunningPortainer,
      DOCKER_API_VERSION,
      DEFAULT_INTERVAL_MS,
      STATS_CONCURRENCY
    };
  }
});

// src/usage-sources/claude-code.js
var require_claude_code = __commonJS({
  "src/usage-sources/claude-code.js"(exports2, module2) {
    var fs2 = require("fs");
    var os = require("os");
    var path2 = require("path");
    var { TOKEN_RATES, calculateCostForBucket } = require_tokens();
    var DAY_MS = 24 * 60 * 60 * 1e3;
    var MAX_SCAN_DEPTH = 4;
    var PS_TIMEOUT_MS = 5e3;
    function defaultExecFn(cmd, args2, options = {}) {
      return new Promise((resolve) => {
        let execFile;
        try {
          execFile = require("child_process").execFile;
        } catch (e) {
          resolve({ error: e, stdout: "", stderr: "" });
          return;
        }
        execFile(
          cmd,
          args2,
          { encoding: "utf8", timeout: options.timeoutMs || PS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
          (error, stdout, stderr) => {
            resolve({ error: error || null, stdout: stdout || "", stderr: stderr || "" });
          }
        );
      });
    }
    function parsePsOutput(stdout) {
      return String(stdout || "").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
        const match = line.match(/^(\d+)\s+(\S+)\s+(.*)$/);
        if (!match) return null;
        return { pid: Number(match[1]), tty: match[2], command: match[3] };
      }).filter(Boolean);
    }
    function isClaudeProcess(command) {
      const executable = String(command || "").trim().split(/\s+/)[0];
      if (!executable) return false;
      const base = path2.basename(executable);
      return base === "claude" || base === "claude-code";
    }
    function emptyTokens() {
      return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    }
    function addUsage(tokens, usage) {
      tokens.input += Number(usage.input_tokens) || 0;
      tokens.output += Number(usage.output_tokens) || 0;
      tokens.cacheRead += Number(usage.cache_read_input_tokens) || 0;
      tokens.cacheWrite += Number(usage.cache_creation_input_tokens) || 0;
    }
    function collectJsonlFiles(dir, depth, out) {
      if (depth > MAX_SCAN_DEPTH) return;
      let entries;
      try {
        entries = fs2.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        return;
      }
      for (const entry of entries) {
        const full = path2.join(dir, entry.name);
        if (entry.isDirectory()) {
          collectJsonlFiles(full, depth + 1, out);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          out.push(full);
        }
      }
    }
    function parseSessionFile(filePath, mtimeMs) {
      let content;
      try {
        content = fs2.readFileSync(filePath, "utf8");
      } catch (e) {
        return null;
      }
      const tokens = emptyTokens();
      let sessionId = null;
      let cwd = null;
      let model = null;
      let messages = 0;
      let firstTs = null;
      let lastTs = null;
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch (e) {
          continue;
        }
        if (!sessionId && typeof entry.sessionId === "string") sessionId = entry.sessionId;
        if (entry.type !== "user" && entry.type !== "assistant") continue;
        messages++;
        if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;
        const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
        if (Number.isFinite(ts)) {
          if (firstTs === null || ts < firstTs) firstTs = ts;
          if (lastTs === null || ts > lastTs) lastTs = ts;
        }
        const message = entry.message;
        if (entry.type === "assistant" && message) {
          if (typeof message.model === "string" && message.model && message.model !== "<synthetic>") {
            model = message.model;
          }
          if (message.usage && typeof message.usage === "object") addUsage(tokens, message.usage);
        }
      }
      if (messages === 0) return null;
      return {
        sessionId: sessionId || path2.basename(filePath, ".jsonl"),
        file: filePath,
        subagent: filePath.includes(`${path2.sep}subagents${path2.sep}`),
        cwd,
        startedAt: firstTs !== null ? new Date(firstTs).toISOString() : null,
        lastActiveAt: new Date(lastTs !== null ? lastTs : mtimeMs).toISOString(),
        messages,
        tokens,
        model,
        live: false
      };
    }
    function parseUsageEntries(filePath, sinceMs) {
      let content;
      try {
        content = fs2.readFileSync(filePath, "utf8");
      } catch (e) {
        return [];
      }
      const entries = [];
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch (e) {
          continue;
        }
        if (entry.type !== "assistant" || !entry.message?.usage) continue;
        const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
        if (!Number.isFinite(ts) || ts < sinceMs) continue;
        entries.push({ ts, usage: entry.message.usage });
      }
      return entries;
    }
    function createClaudeCodeSource(options = {}) {
      const projectsDir = options.projectsDir || path2.join(os.homedir(), ".claude", "projects");
      const nowFn = options.nowFn || Date.now;
      const execFn = options.execFn || defaultExecFn;
      const psFn = options.psFn || (async () => {
        const res = await execFn("ps", ["-eo", "pid=,tty=,args="], { timeoutMs: PS_TIMEOUT_MS });
        if (res.error) return [];
        return parsePsOutput(res.stdout);
      });
      function describe() {
        if (!fs2.existsSync(projectsDir)) {
          return { available: false, reason: `directory not found: ${projectsDir}` };
        }
        return { available: true };
      }
      function listFiles() {
        const files = [];
        collectJsonlFiles(projectsDir, 0, files);
        return files.map((file) => {
          try {
            return { file, mtimeMs: fs2.statSync(file).mtimeMs };
          } catch (e) {
            return null;
          }
        }).filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs);
      }
      async function getSessions(params = {}) {
        const status2 = describe();
        if (!status2.available) return [];
        const sinceMs = Number.isFinite(params.sinceMs) ? params.sinceMs : null;
        const limit = Number.isFinite(params.limit) ? params.limit : null;
        const sessions2 = [];
        for (const { file, mtimeMs } of listFiles()) {
          if (sinceMs !== null && mtimeMs < sinceMs) continue;
          const session = parseSessionFile(file, mtimeMs);
          if (!session) continue;
          if (sinceMs !== null && Date.parse(session.lastActiveAt) < sinceMs) continue;
          sessions2.push(session);
          if (limit !== null && sessions2.length >= limit) break;
        }
        return sessions2.sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
      }
      async function getUsageWindows() {
        const status2 = describe();
        if (!status2.available) return { available: false, reason: status2.reason };
        const now = nowFn();
        const cutoff7d = now - 7 * DAY_MS;
        const buckets = {
          h24: { ...emptyTokens(), requests: 0 },
          d3: { ...emptyTokens(), requests: 0 },
          d7: { ...emptyTokens(), requests: 0 }
        };
        for (const { file, mtimeMs } of listFiles()) {
          if (mtimeMs < cutoff7d) continue;
          for (const { ts, usage } of parseUsageEntries(file, cutoff7d)) {
            if (ts >= now - DAY_MS) {
              addUsage(buckets.h24, usage);
              buckets.h24.requests++;
            }
            if (ts >= now - 3 * DAY_MS) {
              addUsage(buckets.d3, usage);
              buckets.d3.requests++;
            }
            addUsage(buckets.d7, usage);
            buckets.d7.requests++;
          }
        }
        const finalize = (bucket) => ({
          ...bucket,
          estCost: Math.round(calculateCostForBucket(bucket, TOKEN_RATES).totalCost * 1e4) / 1e4
        });
        return {
          available: true,
          h24: finalize(buckets.h24),
          d3: finalize(buckets.d3),
          d7: finalize(buckets.d7)
        };
      }
      async function getLive() {
        try {
          const processes = await psFn() || [];
          const matches = processes.filter((p) => p && isClaudeProcess(p.command));
          const ttys = [...new Set(matches.map((p) => p.tty).filter((t) => t && t !== "?"))];
          return { count: matches.length, ttys, pids: matches.map((p) => p.pid) };
        } catch (e) {
          return { count: 0, ttys: [], pids: [], error: e.message };
        }
      }
      const status = describe();
      return {
        source: "claude-code",
        available: status.available,
        reason: status.reason,
        describe,
        getSessions,
        getUsageWindows,
        getLive
      };
    }
    module2.exports = { createClaudeCodeSource, parsePsOutput, isClaudeProcess };
  }
});

// src/usage-sources/codex.js
var require_codex = __commonJS({
  "src/usage-sources/codex.js"(exports2, module2) {
    var fs2 = require("fs");
    var os = require("os");
    var path2 = require("path");
    var { parsePsOutput } = require_claude_code();
    var PS_TIMEOUT_MS = 5e3;
    var PREVIEW_LENGTH = 120;
    var MAX_SESSION_SCAN_DEPTH = 5;
    function defaultExecFn(cmd, args2, options = {}) {
      return new Promise((resolve) => {
        let execFile;
        try {
          execFile = require("child_process").execFile;
        } catch (e) {
          resolve({ error: e, stdout: "", stderr: "" });
          return;
        }
        execFile(
          cmd,
          args2,
          { encoding: "utf8", timeout: options.timeoutMs || PS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
          (error, stdout, stderr) => {
            resolve({ error: error || null, stdout: stdout || "", stderr: stderr || "" });
          }
        );
      });
    }
    function isCodexProcess(command) {
      const executable = String(command || "").trim().split(/\s+/)[0];
      if (!executable) return false;
      return path2.basename(executable) === "codex";
    }
    function historyTsToMs(ts) {
      const value = Number(ts);
      if (!Number.isFinite(value) || value <= 0) return null;
      return value < 1e12 ? value * 1e3 : value;
    }
    function collectJsonl(dir, depth, out) {
      if (depth > MAX_SESSION_SCAN_DEPTH) return;
      let entries;
      try {
        entries = fs2.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        return;
      }
      for (const entry of entries) {
        const full = path2.join(dir, entry.name);
        if (entry.isDirectory()) collectJsonl(full, depth + 1, out);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
      }
    }
    function createCodexSource(options = {}) {
      const codexDir = options.codexDir || path2.join(os.homedir(), ".codex");
      const historyPath = options.historyPath || path2.join(codexDir, "history.jsonl");
      const sessionsDir = options.sessionsDir || path2.join(codexDir, "sessions");
      const execFn = options.execFn || defaultExecFn;
      const psFn = options.psFn || (async () => {
        const res = await execFn("ps", ["-eo", "pid=,tty=,args="], { timeoutMs: PS_TIMEOUT_MS });
        if (res.error) return [];
        return parsePsOutput(res.stdout);
      });
      function describe() {
        if (!fs2.existsSync(historyPath) && !fs2.existsSync(sessionsDir)) {
          return { available: false, reason: `no Codex data found under ${codexDir}` };
        }
        return { available: true };
      }
      async function getActivity(params = {}) {
        const status2 = describe();
        if (!status2.available) {
          return { available: false, reason: status2.reason, tokensAvailable: false };
        }
        if (!fs2.existsSync(historyPath)) {
          return {
            available: true,
            tokensAvailable: false,
            entries: 0,
            sessions: 0,
            firstAt: null,
            lastAt: null,
            recent: [],
            note: `history file not found: ${historyPath}`
          };
        }
        const sinceMs = Number.isFinite(params.sinceMs) ? params.sinceMs : null;
        const limit = Number.isFinite(params.limit) ? params.limit : 25;
        let content;
        try {
          content = fs2.readFileSync(historyPath, "utf8");
        } catch (e) {
          return { available: false, reason: e.message, tokensAvailable: false };
        }
        const sessionIds = /* @__PURE__ */ new Set();
        const timeline = [];
        let entries = 0;
        let firstMs = null;
        let lastMs = null;
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          let entry;
          try {
            entry = JSON.parse(line);
          } catch (e) {
            continue;
          }
          const tsMs = historyTsToMs(entry.ts);
          if (sinceMs !== null && (tsMs === null || tsMs < sinceMs)) continue;
          entries++;
          if (entry.session_id) sessionIds.add(entry.session_id);
          if (tsMs !== null) {
            if (firstMs === null || tsMs < firstMs) firstMs = tsMs;
            if (lastMs === null || tsMs > lastMs) lastMs = tsMs;
          }
          timeline.push({
            sessionId: entry.session_id || null,
            tsMs,
            cwd: typeof entry.cwd === "string" ? entry.cwd : null,
            preview: typeof entry.text === "string" ? entry.text.slice(0, PREVIEW_LENGTH) : null
          });
        }
        const recent = timeline.sort((a, b) => (b.tsMs ?? -Infinity) - (a.tsMs ?? -Infinity)).slice(0, limit).map(({ tsMs, ...rest }) => ({
          ...rest,
          ts: tsMs !== null ? new Date(tsMs).toISOString() : null
        }));
        return {
          available: true,
          tokensAvailable: false,
          entries,
          sessions: sessionIds.size,
          firstAt: firstMs !== null ? new Date(firstMs).toISOString() : null,
          lastAt: lastMs !== null ? new Date(lastMs).toISOString() : null,
          recent
        };
      }
      async function getSessionFiles(params = {}) {
        if (!fs2.existsSync(sessionsDir)) {
          return { available: false, reason: `sessions directory not found: ${sessionsDir}`, count: 0 };
        }
        const sinceMs = Number.isFinite(params.sinceMs) ? params.sinceMs : null;
        const files = [];
        collectJsonl(sessionsDir, 0, files);
        let count = 0;
        let newest = null;
        for (const file of files) {
          let mtimeMs;
          try {
            mtimeMs = fs2.statSync(file).mtimeMs;
          } catch (e) {
            continue;
          }
          if (sinceMs !== null && mtimeMs < sinceMs) continue;
          count++;
          if (!newest || mtimeMs > newest.mtimeMs) {
            newest = { file: path2.basename(file), mtimeMs };
          }
        }
        return {
          available: true,
          count,
          newest: newest ? { file: newest.file, modifiedAt: new Date(newest.mtimeMs).toISOString() } : null
        };
      }
      async function getLive() {
        try {
          const processes = await psFn() || [];
          const matches = processes.filter((p) => p && isCodexProcess(p.command));
          const ttys = [...new Set(matches.map((p) => p.tty).filter((t) => t && t !== "?"))];
          return { count: matches.length, ttys, pids: matches.map((p) => p.pid) };
        } catch (e) {
          return { count: 0, ttys: [], pids: [], error: e.message };
        }
      }
      const status = describe();
      return {
        source: "codex",
        available: status.available,
        reason: status.reason,
        describe,
        getActivity,
        getSessionFiles,
        getLive
      };
    }
    module2.exports = { createCodexSource, isCodexProcess, historyTsToMs };
  }
});

// src/usage-sources/nine-router.js
var require_nine_router = __commonJS({
  "src/usage-sources/nine-router.js"(exports2, module2) {
    var fs2 = require("fs");
    var os = require("os");
    var path2 = require("path");
    var DEFAULT_DB_PATH = path2.join(
      os.homedir(),
      ".openclaw",
      "9router",
      "data",
      "db",
      "data.sqlite"
    );
    var MAX_USAGE_ROWS = 5e4;
    var DEFAULT_DAILY_DAYS = 14;
    function defaultSqliteLoader() {
      return require("node:sqlite");
    }
    function parseTimestampMs(value) {
      if (value === null || value === void 0 || value === "") return null;
      const num = Number(value);
      if (Number.isFinite(num) && num > 0) return num < 1e12 ? num * 1e3 : num;
      const parsed = Date.parse(String(value));
      return Number.isFinite(parsed) ? parsed : null;
    }
    function emptyTotals() {
      return { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 };
    }
    function addRowToTotals(totals, row) {
      const prompt = Number(row.promptTokens) || 0;
      const completion = Number(row.completionTokens) || 0;
      totals.requests++;
      totals.promptTokens += prompt;
      totals.completionTokens += completion;
      totals.totalTokens += prompt + completion;
      totals.cost += Number(row.cost) || 0;
    }
    function roundCost(totals) {
      return { ...totals, cost: Math.round(totals.cost * 1e6) / 1e6 };
    }
    function groupToSortedArray(map, keyName) {
      return Object.entries(map).map(([key, totals]) => ({ [keyName]: key, ...roundCost(totals) })).sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests);
    }
    function createNineRouterSource(options = {}) {
      const dbPath = options.dbPath || DEFAULT_DB_PATH;
      const sqliteLoader = options.sqliteLoader || defaultSqliteLoader;
      function describe() {
        if (!fs2.existsSync(dbPath)) {
          return { available: false, reason: `database not found: ${dbPath}` };
        }
        try {
          sqliteLoader();
        } catch (e) {
          return { available: false, reason: `sqlite unavailable: ${e.message}` };
        }
        return { available: true };
      }
      function withDb(fn) {
        const sqlite = sqliteLoader();
        const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
        try {
          const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
          const columnsOf = (table) => db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((col) => col.name);
          return fn(db, tables, columnsOf);
        } finally {
          try {
            db.close();
          } catch (e) {
          }
        }
      }
      async function getUsage(params = {}) {
        const status2 = describe();
        if (!status2.available) return { available: false, reason: status2.reason };
        const sinceMs = Number.isFinite(params.sinceMs) ? params.sinceMs : null;
        try {
          return withDb((db, tables, columnsOf) => {
            const notes = [];
            if (!tables.includes("usageHistory")) {
              return {
                available: true,
                totals: emptyTotals(),
                byProvider: [],
                byModel: [],
                byStatus: {},
                notes: ["usageHistory table missing \u2014 no request-level usage data"]
              };
            }
            const columns = columnsOf("usageHistory");
            const wanted = [
              "timestamp",
              "createdAt",
              "created_at",
              "provider",
              "model",
              "promptTokens",
              "completionTokens",
              "cost",
              "status"
            ];
            const selected = wanted.filter((c) => columns.includes(c));
            if (selected.length === 0) {
              return {
                available: true,
                totals: emptyTotals(),
                byProvider: [],
                byModel: [],
                byStatus: {},
                notes: ["usageHistory has no recognized columns \u2014 schema drift"]
              };
            }
            for (const col of ["promptTokens", "completionTokens", "cost"]) {
              if (!columns.includes(col)) notes.push(`column missing: usageHistory.${col}`);
            }
            const tsColumn = ["timestamp", "createdAt", "created_at"].find((c) => columns.includes(c));
            if (!tsColumn && sinceMs !== null) {
              notes.push("no timestamp column \u2014 sinceMs filter not applied");
            }
            const selectList = selected.map((c) => `"${c}"`).join(", ");
            const rows = db.prepare(
              `SELECT ${selectList} FROM usageHistory ORDER BY rowid DESC LIMIT ${MAX_USAGE_ROWS + 1}`
            ).all();
            if (rows.length > MAX_USAGE_ROWS) {
              rows.length = MAX_USAGE_ROWS;
              notes.push(`row scan capped at ${MAX_USAGE_ROWS} most recent rows`);
            }
            const totals = emptyTotals();
            const byProvider = {};
            const byModel = {};
            const byStatus = {};
            for (const row of rows) {
              if (sinceMs !== null && tsColumn) {
                const tsMs = parseTimestampMs(row[tsColumn]);
                if (tsMs !== null && tsMs < sinceMs) continue;
              }
              addRowToTotals(totals, row);
              const provider = row.provider || "unknown";
              const model = row.model || "unknown";
              if (!byProvider[provider]) byProvider[provider] = emptyTotals();
              if (!byModel[model]) byModel[model] = emptyTotals();
              addRowToTotals(byProvider[provider], row);
              addRowToTotals(byModel[model], row);
              const statusKey = row.status || "unknown";
              byStatus[statusKey] = (byStatus[statusKey] || 0) + 1;
            }
            return {
              available: true,
              totals: roundCost(totals),
              byProvider: groupToSortedArray(byProvider, "provider"),
              byModel: groupToSortedArray(byModel, "model"),
              byStatus,
              notes
            };
          });
        } catch (e) {
          return { available: false, reason: e.message };
        }
      }
      async function getDaily(days = DEFAULT_DAILY_DAYS) {
        const status2 = describe();
        if (!status2.available) return { available: false, reason: status2.reason };
        const limit = Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 366) : DEFAULT_DAILY_DAYS;
        try {
          return withDb((db, tables, columnsOf) => {
            if (!tables.includes("usageDaily")) {
              return { available: true, days: [], notes: ["usageDaily table missing"] };
            }
            const columns = columnsOf("usageDaily");
            if (!columns.includes("dateKey")) {
              return { available: true, days: [], notes: ["usageDaily.dateKey column missing"] };
            }
            const hasData = columns.includes("data");
            const select = hasData ? '"dateKey", "data"' : '"dateKey"';
            const rows = db.prepare(`SELECT ${select} FROM usageDaily ORDER BY "dateKey" DESC LIMIT ${limit}`).all();
            const result = rows.map((row) => {
              const entry = { date: row.dateKey };
              if (!hasData) return { ...entry, note: "no data column" };
              try {
                const parsed = JSON.parse(row.data);
                return { ...entry, summary: parsed };
              } catch (e) {
                return { ...entry, note: "unparseable data blob" };
              }
            });
            return { available: true, days: result, notes: [] };
          });
        } catch (e) {
          return { available: false, reason: e.message };
        }
      }
      async function getConnections() {
        const status2 = describe();
        if (!status2.available) return { available: false, reason: status2.reason };
        try {
          return withDb((db, tables, columnsOf) => {
            if (!tables.includes("providerConnections")) {
              return { available: true, connections: [], notes: ["providerConnections table missing"] };
            }
            const columns = columnsOf("providerConnections");
            const wanted = [
              "id",
              "provider",
              "authType",
              "name",
              "priority",
              "isActive",
              "createdAt",
              "updatedAt"
            ];
            const selected = wanted.filter((c) => columns.includes(c));
            if (selected.length === 0) {
              return { available: true, connections: [], notes: ["no recognized columns"] };
            }
            const selectList = selected.map((c) => `"${c}"`).join(", ");
            const connections = db.prepare(`SELECT ${selectList} FROM providerConnections`).all();
            return { available: true, connections, notes: [] };
          });
        } catch (e) {
          return { available: false, reason: e.message };
        }
      }
      const status = describe();
      return {
        source: "nine-router",
        available: status.available,
        reason: status.reason,
        describe,
        getUsage,
        getDaily,
        getConnections
      };
    }
    module2.exports = { createNineRouterSource, parseTimestampMs };
  }
});

// src/usage-sources/headroom.js
var require_headroom = __commonJS({
  "src/usage-sources/headroom.js"(exports2, module2) {
    var fs2 = require("fs");
    var os = require("os");
    var path2 = require("path");
    var DEFAULT_STATS_PATH = path2.join(os.homedir(), ".headroom", "subscription_state.json");
    var STALE_AFTER_MS = 30 * 60 * 1e3;
    function toFiniteOrNull(value) {
      if (value === null || value === void 0 || value === "") return null;
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    }
    function normalizeWindow(window) {
      if (!window || typeof window !== "object") return null;
      return {
        utilizationPct: toFiniteOrNull(window.utilization_pct),
        resetsAt: window.resets_at ?? null,
        secondsToReset: toFiniteOrNull(window.seconds_to_reset)
      };
    }
    function normalizeExtraUsage(extra) {
      if (!extra || typeof extra !== "object") return null;
      return {
        isEnabled: Boolean(extra.is_enabled),
        monthlyLimitUsd: Number(extra.monthly_limit_usd) || 0,
        usedCreditsUsd: Number(extra.used_credits_usd) || 0,
        utilizationPct: toFiniteOrNull(extra.utilization_pct)
      };
    }
    function normalizeTokenBucket(bucket) {
      if (!bucket || typeof bucket !== "object") return null;
      return {
        input: Number(bucket.input) || 0,
        output: Number(bucket.output) || 0,
        cacheReads: Number(bucket.cache_reads) || 0,
        cacheWritesTotal: Number(bucket.cache_writes_total) || 0
      };
    }
    function createHeadroomSource(options = {}) {
      const statsPath = options.statsPath || DEFAULT_STATS_PATH;
      const nowFn = options.nowFn || Date.now;
      function describe() {
        if (!fs2.existsSync(statsPath)) {
          return { available: false, reason: `file not found: ${statsPath}` };
        }
        return { available: true };
      }
      async function getSubscription() {
        const status2 = describe();
        if (!status2.available) return { available: false, reason: status2.reason };
        let data;
        try {
          data = JSON.parse(fs2.readFileSync(statsPath, "utf8"));
        } catch (e) {
          return { available: false, reason: `unreadable subscription state: ${e.message}` };
        }
        if (!data || typeof data !== "object") {
          return { available: false, reason: "subscription state is not an object" };
        }
        const latest = data.latest && typeof data.latest === "object" ? data.latest : {};
        const windowTokens = data.window_tokens && typeof data.window_tokens === "object" ? data.window_tokens : {};
        const polledAt = latest.polled_at ?? null;
        const polledMs = polledAt ? Date.parse(polledAt) : NaN;
        const stale = !Number.isFinite(polledMs) || nowFn() - polledMs > STALE_AFTER_MS;
        const byModel = {};
        if (windowTokens.by_model && typeof windowTokens.by_model === "object") {
          for (const [model, bucket] of Object.entries(windowTokens.by_model)) {
            const normalized = normalizeTokenBucket(bucket);
            if (normalized) byModel[model] = normalized;
          }
        }
        return {
          available: true,
          fiveHour: normalizeWindow(latest.five_hour),
          sevenDay: normalizeWindow(latest.seven_day),
          sevenDaySonnet: normalizeWindow(latest.seven_day_sonnet),
          extraUsage: normalizeExtraUsage(latest.extra_usage),
          windowTokens: {
            ...normalizeTokenBucket(windowTokens) || {
              input: 0,
              output: 0,
              cacheReads: 0,
              cacheWritesTotal: 0
            },
            totalRaw: Number(windowTokens.total_raw) || 0,
            weightedTokenEquivalent: Number(windowTokens.weighted_token_equivalent) || 0
          },
          byModel,
          polledAt,
          stale
        };
      }
      const status = describe();
      return {
        source: "headroom",
        available: status.available,
        reason: status.reason,
        describe,
        getSubscription
      };
    }
    module2.exports = { createHeadroomSource };
  }
});

// src/usage-sources/openrouter.js
var require_openrouter = __commonJS({
  "src/usage-sources/openrouter.js"(exports2, module2) {
    var DEFAULT_BASE_URL = "https://openrouter.ai";
    var DEFAULT_TIMEOUT_MS = 1e4;
    function defaultFetchFn(...args2) {
      if (typeof globalThis.fetch !== "function") {
        throw new Error("global fetch is not available in this runtime");
      }
      return globalThis.fetch(...args2);
    }
    function toNumber(value) {
      if (value === null || value === void 0 || value === "") return null;
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    }
    function createOpenRouterSource(options = {}) {
      const apiKey = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
      const fetchFn = options.fetchFn || defaultFetchFn;
      const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
      const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
      const available = apiKey.length > 0;
      function scrub(text) {
        const message = String(text || "");
        return available ? message.split(apiKey).join("[redacted]") : message;
      }
      async function request(pathname) {
        if (!available) {
          return { error: "OpenRouter API key not configured" };
        }
        const controller = typeof globalThis.AbortController === "function" ? new globalThis.AbortController() : null;
        const timer = setTimeout(() => {
          if (controller) controller.abort();
        }, timeoutMs);
        try {
          const res = await fetchFn(`${baseUrl}${pathname}`, {
            method: "GET",
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: controller ? controller.signal : void 0
          });
          if (!res.ok) {
            return { error: `OpenRouter API returned HTTP ${res.status}` };
          }
          let body;
          try {
            body = await res.json();
          } catch (e) {
            return { error: "OpenRouter API returned non-JSON body" };
          }
          return { body };
        } catch (e) {
          const reason = e && e.name === "AbortError" ? `request timed out after ${timeoutMs}ms` : scrub(e.message);
          return { error: reason };
        } finally {
          clearTimeout(timer);
        }
      }
      async function getCredits() {
        const res = await request("/api/v1/credits");
        if (res.error) return { available, error: res.error };
        const data = res.body && typeof res.body === "object" && res.body.data && typeof res.body.data === "object" ? res.body.data : res.body || {};
        const totalCredits = toNumber(data.total_credits ?? data.totalCredits);
        const totalUsage = toNumber(data.total_usage ?? data.totalUsage);
        return {
          available,
          totalCredits,
          totalUsage,
          remaining: totalCredits !== null && totalUsage !== null ? Math.round((totalCredits - totalUsage) * 1e6) / 1e6 : null
        };
      }
      async function getKeyInfo() {
        const res = await request("/api/v1/auth/key");
        if (res.error) return { available, error: res.error };
        const data = res.body && typeof res.body === "object" && res.body.data && typeof res.body.data === "object" ? res.body.data : res.body || {};
        return {
          available,
          label: typeof data.label === "string" ? data.label : null,
          usage: toNumber(data.usage),
          limit: toNumber(data.limit),
          limitRemaining: toNumber(data.limit_remaining ?? data.limitRemaining),
          isFreeTier: typeof data.is_free_tier === "boolean" ? data.is_free_tier : null,
          rateLimit: data.rate_limit && typeof data.rate_limit === "object" ? {
            requests: toNumber(data.rate_limit.requests),
            interval: data.rate_limit.interval ?? null
          } : null
        };
      }
      return {
        source: "openrouter",
        available,
        reason: available ? void 0 : "no API key configured",
        getCredits,
        getKeyInfo
      };
    }
    module2.exports = { createOpenRouterSource };
  }
});

// src/usage-sources/index.js
var require_usage_sources = __commonJS({
  "src/usage-sources/index.js"(exports2, module2) {
    var os = require("os");
    var path2 = require("path");
    var { createClaudeCodeSource } = require_claude_code();
    var { createCodexSource } = require_codex();
    var { createNineRouterSource } = require_nine_router();
    var { createHeadroomSource } = require_headroom();
    var { createOpenRouterSource } = require_openrouter();
    var DEFAULT_SESSION_LIMIT = 10;
    function readQueryParam(query, name) {
      if (!query) return null;
      if (typeof query.get === "function") return query.get(name);
      return Object.prototype.hasOwnProperty.call(query, name) ? query[name] : null;
    }
    function queryNumber(query, name, fallback = null) {
      const raw = readQueryParam(query, name);
      if (raw === null || raw === void 0 || raw === "") return fallback;
      const value = Number(raw);
      return Number.isFinite(value) ? value : fallback;
    }
    async function safe(promise) {
      try {
        return await promise;
      } catch (e) {
        return { available: false, error: e.message };
      }
    }
    function createUsageSources2(config = {}) {
      const home = os.homedir();
      const deps = {
        psFn: config.psFn,
        execFn: config.execFn,
        nowFn: config.nowFn
      };
      const claudeCode = createClaudeCodeSource({
        projectsDir: config.claudeProjectsDir || path2.join(home, ".claude", "projects"),
        ...deps
      });
      const codex = createCodexSource({
        codexDir: config.codexDir || path2.join(home, ".codex"),
        ...deps
      });
      const nineRouter = createNineRouterSource({
        dbPath: config.nineRouterDb,
        sqliteLoader: config.sqliteLoader
      });
      const headroom = createHeadroomSource({
        statsPath: config.headroomStats,
        nowFn: config.nowFn
      });
      const openrouter = createOpenRouterSource({
        apiKey: config.openrouterKey,
        fetchFn: config.fetchFn
      });
      const sources = { claudeCode, codex, nineRouter, headroom, openrouter };
      async function claudeCodeSnapshot(params = {}) {
        const status = claudeCode.describe();
        if (!status.available) return { available: false, reason: status.reason };
        const [sessions2, live, windows] = await Promise.all([
          safe(claudeCode.getSessions({ sinceMs: params.sinceMs, limit: params.limit })),
          safe(claudeCode.getLive()),
          safe(claudeCode.getUsageWindows())
        ]);
        return { available: true, live, sessions: sessions2, windows };
      }
      async function codexSnapshot(params = {}) {
        const status = codex.describe();
        if (!status.available) return { available: false, reason: status.reason };
        const [activity, sessionFiles, live] = await Promise.all([
          safe(codex.getActivity({ sinceMs: params.sinceMs, limit: params.limit })),
          safe(codex.getSessionFiles({ sinceMs: params.sinceMs })),
          safe(codex.getLive())
        ]);
        return { available: true, activity, sessionFiles, live };
      }
      async function nineRouterSnapshot(params = {}) {
        const status = nineRouter.describe();
        if (!status.available) return { available: false, reason: status.reason };
        const [usage, daily] = await Promise.all([
          safe(nineRouter.getUsage({ sinceMs: params.sinceMs })),
          safe(nineRouter.getDaily(params.days))
        ]);
        return { available: true, usage, daily };
      }
      async function openrouterSnapshot() {
        if (!openrouter.available) return { available: false, reason: openrouter.reason };
        const [credits, keyInfo] = await Promise.all([
          safe(openrouter.getCredits()),
          safe(openrouter.getKeyInfo())
        ]);
        return { available: true, credits, keyInfo };
      }
      async function getAll(params = {}) {
        const [claudeCodeData, codexData, nineRouterData, headroomData, openrouterData] = await Promise.all([
          safe(claudeCodeSnapshot(params)),
          safe(codexSnapshot(params)),
          safe(nineRouterSnapshot(params)),
          safe(headroom.getSubscription()),
          safe(openrouterSnapshot())
        ]);
        return {
          claudeCode: claudeCodeData,
          codex: codexData,
          nineRouter: nineRouterData,
          headroom: headroomData,
          openrouter: openrouterData
        };
      }
      function paramsFromQuery(query) {
        return {
          sinceMs: queryNumber(query, "sinceMs"),
          limit: queryNumber(query, "limit", DEFAULT_SESSION_LIMIT),
          days: queryNumber(query, "days")
        };
      }
      const routes = {
        "GET /api/usage/sources": async (ctx = {}) => getAll(paramsFromQuery(ctx.query)),
        "GET /api/usage/claude-code": async (ctx = {}) => safe(claudeCodeSnapshot(paramsFromQuery(ctx.query))),
        "GET /api/usage/codex": async (ctx = {}) => safe(codexSnapshot(paramsFromQuery(ctx.query))),
        "GET /api/usage/nine-router": async (ctx = {}) => safe(nineRouterSnapshot(paramsFromQuery(ctx.query))),
        "GET /api/usage/subscription": async () => safe(headroom.getSubscription()),
        "GET /api/usage/openrouter": async () => safe(openrouterSnapshot())
      };
      return { sources, getAll, routes };
    }
    module2.exports = { createUsageSources: createUsageSources2 };
  }
});

// src/index.js
var http = require("http");
var fs = require("fs");
var path = require("path");
var args = process.argv.slice(2);
var cliProfile = null;
var cliPort = null;
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
if (cliProfile) {
  process.env.OPENCLAW_PROFILE = cliProfile;
}
if (cliPort) {
  process.env.PORT = cliPort.toString();
}
var { getVersion } = require_utils();
var { CONFIG, getOpenClawDir } = require_config();
var { handleJobsRequest, isJobsRoute } = require_jobs();
var { runOpenClaw, runOpenClawAsync, extractJSON } = require_openclaw();
var { getSystemVitals, checkOptionalDeps, getOptionalDeps } = require_vitals();
var { checkAuth, getUnauthorizedPage } = require_auth();
var { loadPrivacySettings, savePrivacySettings } = require_privacy();
var {
  loadOperators,
  saveOperators,
  getOperatorBySlackId,
  startOperatorsRefresh,
  calculateOperatorStats
} = require_operators();
var { createSessionsModule } = require_sessions();
var { getCronJobs } = require_cron();
var { getCerebroTopics, updateTopicStatus } = require_cerebro();
var {
  getDailyTokenUsage,
  getTokenStats,
  getCostBreakdown,
  startTokenUsageRefresh,
  refreshTokenUsageAsync
} = require_tokens();
var { getLlmUsage, getRoutingStats, startLlmUsageRefresh } = require_llm_usage();
var { executeAction } = require_actions();
var { migrateDataDir } = require_data();
var { createStateModule } = require_state();
var { createFleetRuntime } = require_fleet();
var { createFleetRoutes, isFleetRoute } = require_fleet_routes();
var { createSettings } = require_settings();
var { createDocker } = require_docker();
var { createUsageSources } = require_usage_sources();
var PORT = CONFIG.server.port;
var DASHBOARD_DIR = path.join(__dirname, "../public");
var PATHS = CONFIG.paths;
var AUTH_CONFIG = {
  mode: CONFIG.auth.mode,
  token: CONFIG.auth.token,
  allowedUsers: CONFIG.auth.allowedUsers,
  allowedIPs: CONFIG.auth.allowedIPs,
  publicPaths: CONFIG.auth.publicPaths
};
var DATA_DIR = path.join(getOpenClawDir(), "command-center", "data");
var LEGACY_DATA_DIR = path.join(DASHBOARD_DIR, "data");
var sseClients = /* @__PURE__ */ new Set();
function sendSSE(res, event, data) {
  try {
    res.write(`event: ${event}
data: ${JSON.stringify(data)}

`);
  } catch (e) {
  }
}
function broadcastSSE(event, data) {
  for (const client of sseClients) {
    sendSSE(client, event, data);
  }
}
var sessions = createSessionsModule({
  getOpenClawDir,
  getOperatorBySlackId: (slackId) => getOperatorBySlackId(DATA_DIR, slackId),
  runOpenClaw,
  runOpenClawAsync,
  extractJSON
});
var state = createStateModule({
  CONFIG,
  getOpenClawDir,
  getSessions: (opts) => sessions.getSessions(opts),
  getSystemVitals,
  getCronJobs: () => getCronJobs(getOpenClawDir),
  loadOperators: () => loadOperators(DATA_DIR),
  calculateOperatorStats,
  getLlmUsage: () => getLlmUsage(PATHS.state),
  getDailyTokenUsage: () => getDailyTokenUsage(getOpenClawDir),
  getTokenStats,
  getCerebroTopics: (opts) => getCerebroTopics(PATHS.cerebro, opts),
  runOpenClaw,
  extractJSON,
  readTranscript: (sessionId) => sessions.readTranscript(sessionId)
});
var fleet = createFleetRuntime({ config: CONFIG.fleet, broadcast: broadcastSSE });
var settings = createSettings({
  configPath: path.join(__dirname, "..", "config", "dashboard.local.json"),
  onChange: (alertsConfig) => fleet.applyAlertsConfig(alertsConfig)
});
var fleetRoutes = createFleetRoutes({ fleet, settings });
var usageSources = createUsageSources({
  claudeProjectsDir: CONFIG.fleet.usage.claudeProjectsDir,
  codexDir: CONFIG.fleet.usage.codexDir,
  nineRouterDb: CONFIG.fleet.usage.nineRouterDb,
  headroomStats: CONFIG.fleet.usage.headroomStats || CONFIG.fleet.cortex.headroomStats,
  openrouterKey: process.env.OPENROUTER_API_KEY || CONFIG.fleet.usage.openrouterKey
});
var docker = createDocker({
  onChange: ({ container, previousState, previousHealth }) => broadcastSSE("fleet.docker", {
    id12: container.id12 || null,
    name: container.name || null,
    state: container.state,
    health: container.health,
    previousState,
    previousHealth,
    ts: Date.now()
  }),
  portainerUrl: CONFIG.fleet.docker?.portainerUrl ?? null
});
process.nextTick(() => migrateDataDir(DATA_DIR, LEGACY_DATA_DIR));
fleet.start();
docker.start();
startOperatorsRefresh(DATA_DIR, getOpenClawDir);
startLlmUsageRefresh();
startTokenUsageRefresh(getOpenClawDir);
function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  if (pathname.includes("..")) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }
  const normalizedPath = path.normalize(pathname).replace(/^[/\\]+/, "");
  const filePath = path.join(DASHBOARD_DIR, normalizedPath);
  const resolvedDashboardDir = path.resolve(DASHBOARD_DIR);
  const resolvedFilePath = path.resolve(filePath);
  if (!resolvedFilePath.startsWith(resolvedDashboardDir + path.sep) && resolvedFilePath !== resolvedDashboardDir) {
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
    ".svg": "image/svg+xml"
  };
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const headers = { "Content-Type": contentTypes[ext] || "text/plain" };
    if ([".html", ".css", ".js", ".json"].includes(ext)) {
      headers["Cache-Control"] = "no-store";
    }
    res.writeHead(200, headers);
    res.end(content);
  });
}
function handleApi(req, res) {
  const sessionsList = sessions.getSessions();
  const capacity = state.getCapacity();
  const tokenStats = getTokenStats(sessionsList, capacity, CONFIG);
  const data = {
    sessions: sessionsList,
    cron: getCronJobs(getOpenClawDir),
    system: state.getSystemStatus(),
    activity: state.getRecentActivity(),
    tokenStats,
    capacity,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}
var server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const urlParts = req.url.split("?");
  const pathname = urlParts[0];
  const query = new URLSearchParams(urlParts[1] || "");
  if (pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", port: PORT, timestamp: (/* @__PURE__ */ new Date()).toISOString() }));
    return;
  }
  const isPublicPath = AUTH_CONFIG.publicPaths.some(
    (p) => pathname === p || pathname.startsWith(p + "/")
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
        `[AUTH] Allowed: ${authResult.user.login || authResult.user.email} (path: ${pathname})`
      );
    } else {
      console.log(`[AUTH] Allowed: ${req.socket?.remoteAddress} (path: ${pathname})`);
    }
  }
  if (pathname === "/api/status") {
    handleApi(req, res);
  } else if (pathname === "/api/session" || pathname === "/api/sessions/detail") {
    const sessionKey = query.get("key");
    if (!sessionKey) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing session key" }));
      return;
    }
    const detail = sessions.getSessionDetail(sessionKey);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(detail, null, 2));
  } else if (pathname === "/api/cerebro") {
    const offset = parseInt(query.get("offset") || "0", 10);
    const limit = parseInt(query.get("limit") || "20", 10);
    const statusFilter = query.get("status") || "all";
    const data = getCerebroTopics(PATHS.cerebro, { offset, limit, status: statusFilter });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data, null, 2));
  } else if (pathname.startsWith("/api/cerebro/topic/") && pathname.endsWith("/status") && req.method === "POST") {
    const topicId = decodeURIComponent(
      pathname.replace("/api/cerebro/topic/", "").replace("/status", "")
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
            JSON.stringify({ error: "Invalid status. Must be: active, resolved, or parked" })
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
    const data = getLlmUsage(PATHS.state);
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
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
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
          user: req.authUser || null
        },
        null,
        2
      )
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
          inspirations: ["Starcraft", "Inside Out", "iStatMenus", "DaisyDisk", "Gmail"]
        },
        null,
        2
      )
    );
  } else if (pathname === "/api/state") {
    const fullState = state.getFullState();
    fleet.getSummary().catch((e) => {
      console.error("[Fleet] Summary failed:", e.message);
      return null;
    }).then((fleetSummary) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...fullState || {}, fleet: fleetSummary }, null, 2));
    });
    return;
  } else if (pathname === "/api/vitals") {
    const vitals = getSystemVitals();
    const optionalDeps = getOptionalDeps();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ vitals, optionalDeps }, null, 2));
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
      idle: allSessions.filter((s) => !s.active && !s.recentlyActive).length
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
    const tokenStats = getTokenStats(allSessions, state.getCapacity(), CONFIG);
    const capacity = state.getCapacity();
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
            hasNext: page < totalPages
          },
          statusCounts,
          tokenStats,
          capacity
        },
        null,
        2
      )
    );
  } else if (pathname === "/api/cron") {
    const cron = getCronJobs(getOpenClawDir);
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
            timestamp: Date.now()
          },
          null,
          2
        )
      );
    } else if (method === "POST") {
      let body = "";
      req.on("data", (chunk) => body += chunk);
      req.on("end", () => {
        try {
          const newOp = JSON.parse(body);
          const existingIdx = data.operators.findIndex((op) => op.id === newOp.id);
          if (existingIdx >= 0) {
            data.operators[existingIdx] = { ...data.operators[existingIdx], ...newOp };
          } else {
            data.operators.push({
              ...newOp,
              createdAt: (/* @__PURE__ */ new Date()).toISOString()
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
    const usage = getLlmUsage(PATHS.state);
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
      const settings2 = loadPrivacySettings(DATA_DIR);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(settings2, null, 2));
    } else if (req.method === "POST" || req.method === "PUT") {
      let body = "";
      req.on("data", (chunk) => body += chunk);
      req.on("end", () => {
        try {
          const updates = JSON.parse(body);
          const current = loadPrivacySettings(DATA_DIR);
          const merged = {
            version: current.version || 1,
            hiddenTopics: updates.hiddenTopics ?? current.hiddenTopics ?? [],
            hiddenSessions: updates.hiddenSessions ?? current.hiddenSessions ?? [],
            hiddenCrons: updates.hiddenCrons ?? current.hiddenCrons ?? [],
            hideHostname: updates.hideHostname ?? current.hideHostname ?? false
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
  } else if (pathname.startsWith("/api/usage/")) {
    const usageHandler = usageSources.routes[`${req.method} ${pathname}`];
    if (!usageHandler) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Unknown usage route: ${req.method} ${pathname}` }));
      return;
    }
    usageHandler({ query }).then((payload) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload, null, 2));
    }).catch((e) => {
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
server.listen(PORT, () => {
  const profile = process.env.OPENCLAW_PROFILE;
  console.log(`\u{1F99E} OpenFleetControl running at http://localhost:${PORT}`);
  if (profile) {
    console.log(`   Profile: ${profile} (~/.openclaw-${profile})`);
  }
  console.log(`   Press Ctrl+C to stop`);
  setTimeout(async () => {
    console.log("[Startup] Pre-warming caches in background...");
    try {
      await Promise.all([sessions.refreshSessionsCache(), refreshTokenUsageAsync(getOpenClawDir)]);
      getSystemVitals();
      console.log("[Startup] Caches warmed.");
    } catch (e) {
      console.log("[Startup] Cache warming error:", e.message);
    }
    checkOptionalDeps();
  }, 100);
  const SESSIONS_CACHE_TTL = 1e4;
  setInterval(() => sessions.refreshSessionsCache(), SESSIONS_CACHE_TTL);
});
var sseRefreshing = false;
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
}, 15e3);
