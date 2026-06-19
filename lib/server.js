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

// src/secrets.js
var require_secrets = __commonJS({
  "src/secrets.js"(exports2, module2) {
    var { execFile: execFile2, execFileSync } = require("child_process");
    var OP_REF_RE = /^op:\/\/[^/\n]+\/[^/\n]+\/[^\n]+$/;
    var DEFAULT_OP_PATH = "op";
    var DEFAULT_CACHE_TTL_MS = 3e5;
    var DEFAULT_TIMEOUT_MS = 1e4;
    var MAX_OUTPUT_BYTES = 64 * 1024;
    var MAX_ERROR_LENGTH = 300;
    var DEFAULT_SECRET_KEYS = Object.freeze([
      "secret",
      "gatewayUrl",
      "topic",
      "openrouterKey",
      "token"
    ]);
    function isSecretRef(value) {
      return typeof value === "string" && OP_REF_RE.test(value.trim());
    }
    function scrubExecError(err) {
      if (!err) return "unknown error";
      const parts = [];
      if (err.code === "ENOENT") return "op CLI not found";
      if (err.killed || err.signal === "SIGTERM") parts.push("timed out");
      if (typeof err.status === "number") parts.push(`exit ${err.status}`);
      else if (typeof err.code === "number") parts.push(`exit ${err.code}`);
      const stderr = err.stderr != null ? String(err.stderr) : "";
      const firstLine = stderr.split("\n").find((line) => line.trim().length > 0);
      if (firstLine) parts.push(firstLine.trim().slice(0, MAX_ERROR_LENGTH));
      return parts.length > 0 ? parts.join(": ") : "op read failed";
    }
    function keyAllowed(key, allowKeys) {
      return allowKeys === null || allowKeys.includes(key);
    }
    function containsSecretRef(node, allowKeys) {
      if (typeof node === "string") {
        return allowKeys === null && isSecretRef(node);
      }
      if (Array.isArray(node)) {
        return node.some((item) => containsSecretRef(item, allowKeys));
      }
      if (node !== null && typeof node === "object") {
        return Object.entries(node).some(([key, value]) => {
          if (typeof value === "string") return keyAllowed(key, allowKeys) && isSecretRef(value);
          return containsSecretRef(value, allowKeys);
        });
      }
      return false;
    }
    function createSecrets({
      execFn = execFile2,
      execSyncFn = execFileSync,
      opPath = process.env.OP_CLI_PATH || DEFAULT_OP_PATH,
      cacheTtlMs = DEFAULT_CACHE_TTL_MS,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      nowFn = Date.now
    } = {}) {
      const cache = /* @__PURE__ */ new Map();
      const status = /* @__PURE__ */ new Map();
      const pending = /* @__PURE__ */ new Map();
      const execOptions = () => ({
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf8",
        windowsHide: true
      });
      function cached(ref) {
        const entry = cache.get(ref);
        if (entry && entry.expiresAt > nowFn()) return entry;
        return null;
      }
      function recordSuccess(ref, value) {
        cache.set(ref, { value, expiresAt: nowFn() + cacheTtlMs });
        status.set(ref, { ref, ok: true, error: null, ts: nowFn() });
        return { ok: true, ref, value };
      }
      function recordFailure(ref, err) {
        const error = scrubExecError(err);
        status.set(ref, { ref, ok: false, error, ts: nowFn() });
        return { ok: false, ref, error };
      }
      function resolveSync(value) {
        if (!isSecretRef(value)) return { ok: true, ref: null, value };
        const ref = value.trim();
        const hit = cached(ref);
        if (hit) return { ok: true, ref, value: hit.value };
        try {
          const out = execSyncFn(opPath, ["read", "--no-newline", ref], execOptions());
          return recordSuccess(ref, String(out).replace(/\n+$/, ""));
        } catch (err) {
          return recordFailure(ref, err);
        }
      }
      function resolve(value) {
        if (!isSecretRef(value)) return Promise.resolve({ ok: true, ref: null, value });
        const ref = value.trim();
        const hit = cached(ref);
        if (hit) return Promise.resolve({ ok: true, ref, value: hit.value });
        if (pending.has(ref)) return pending.get(ref);
        const promise = new Promise((resolveP) => {
          execFn(opPath, ["read", "--no-newline", ref], execOptions(), (err, stdout) => {
            if (err) resolveP(recordFailure(ref, err));
            else resolveP(recordSuccess(ref, String(stdout).replace(/\n+$/, "")));
          });
        }).finally(() => pending.delete(ref));
        pending.set(ref, promise);
        return promise;
      }
      function deepWalk(node, allowKeys, path2, failures, resolveValue) {
        const resolveLeaf = (value, leafPath) => {
          const result = resolveValue(value);
          if (result.ok) return result.value;
          failures.push({ path: leafPath, ref: result.ref, error: result.error });
          return value;
        };
        if (Array.isArray(node)) {
          return node.map((item, i) => {
            const childPath = `${path2}[${i}]`;
            if (typeof item === "string" && allowKeys === null && isSecretRef(item)) {
              return resolveLeaf(item, childPath);
            }
            return deepWalk(item, allowKeys, childPath, failures, resolveValue);
          });
        }
        if (node !== null && typeof node === "object") {
          const out = {};
          for (const [key, value] of Object.entries(node)) {
            const childPath = path2 ? `${path2}.${key}` : key;
            if (typeof value === "string" && keyAllowed(key, allowKeys) && isSecretRef(value)) {
              out[key] = resolveLeaf(value, childPath);
            } else if (value !== null && typeof value === "object") {
              out[key] = deepWalk(value, allowKeys, childPath, failures, resolveValue);
            } else {
              out[key] = value;
            }
          }
          return out;
        }
        return node;
      }
      function resolveDeepSync(obj, keyAllowlist = null) {
        if (!containsSecretRef(obj, keyAllowlist)) return { value: obj, failures: [] };
        const failures = [];
        const value = deepWalk(obj, keyAllowlist, "", failures, resolveSync);
        return { value, failures };
      }
      async function resolveDeep(obj, keyAllowlist = null) {
        if (!containsSecretRef(obj, keyAllowlist)) return { value: obj, failures: [] };
        const refs = /* @__PURE__ */ new Set();
        (function collect(node) {
          if (typeof node === "string") {
            if (keyAllowlist === null && isSecretRef(node)) refs.add(node.trim());
            return;
          }
          if (Array.isArray(node)) return node.forEach(collect);
          if (node !== null && typeof node === "object") {
            for (const [key, value2] of Object.entries(node)) {
              if (typeof value2 === "string" && keyAllowed(key, keyAllowlist) && isSecretRef(value2)) {
                refs.add(value2.trim());
              } else {
                collect(value2);
              }
            }
          }
        })(obj);
        const resolved = /* @__PURE__ */ new Map();
        await Promise.all(
          [...refs].map(async (ref) => {
            resolved.set(ref, await resolve(ref));
          })
        );
        const failures = [];
        const value = deepWalk(obj, keyAllowlist, "", failures, (v) => resolved.get(v.trim()));
        return { value, failures };
      }
      function getStatus() {
        const refs = [...status.values()].map((entry) => ({ ...entry }));
        const ok = refs.filter((entry) => entry.ok).length;
        return { configured: refs.length, ok, failed: refs.length - ok, refs };
      }
      function clearCache() {
        cache.clear();
        pending.clear();
      }
      return { isSecretRef, resolve, resolveSync, resolveDeep, resolveDeepSync, getStatus, clearCache };
    }
    var defaultSecrets = createSecrets();
    module2.exports = { createSecrets, isSecretRef, DEFAULT_SECRET_KEYS, defaultSecrets };
  }
});

// src/config.js
var require_config = __commonJS({
  "src/config.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var os2 = require("os");
    var { defaultSecrets } = require_secrets();
    var HOME = os2.homedir();
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
    function loadConfigFile({ localPath: localPathOverride } = {}) {
      const basePath = path2.join(__dirname, "..", "config", "dashboard.json");
      const localPath = localPathOverride || path2.join(__dirname, "..", "config", "dashboard.local.json");
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
      // Session list source: "files" reads the OpenClaw session store JSON
      // directly (fast, no CLI spawn); "cli" shells out to `openclaw sessions
      // --json` via the async background worker.
      sessionsSource: "files",
      // Background sessions-cache refresh interval (ms).
      sessionsRefreshMs: 3e4,
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
      mesh: { intervalMs: 15e3, seed: [] },
      federation: { intervalMs: 3e4 },
      watchdog: { thresholdMs: 18e5 },
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
          // Flight Recorder: a board/chain run failed or a seat timed out
          // (src/run-archive.js → fleet.fireAlert). ON by default so a failed
          // orchestration surfaces; routed to whichever sinks are configured (ntfy).
          orchestrationFailed: true
        },
        sinks: {
          slack: { enabled: false, gatewayUrl: "", channel: "" },
          // ntfy push sink (src/alerts.js dispatchToNtfy). Disabled by default; set
          // {enabled:true, topic:"<secret-topic>"} (optional server, default
          // https://ntfy.sh) to receive Flight Recorder failure alerts on a phone.
          ntfy: { enabled: false, server: "", topic: "" },
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
        identity: ""
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
        perSeatCostUSD: 0
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
        maxRows: 5e3
      },
      rateLimit: { windowMs: 6e4, max: 120 },
      // Cost budgets (USD) over LLM API spend — see src/budgets.js. 0 = no limit.
      // enforce.enabled gates dispatch blocking when a budget crosses 100%.
      budgets: {
        enabled: false,
        daily: { totalUSD: 0, perProvider: {} },
        weekly: { totalUSD: 0, perProvider: {} },
        checkIntervalMs: 9e5,
        enforce: { enabled: false }
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
        hermesDir: "~/.hermes"
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
        readinessTimeoutMs: 1e4,
        // Time (ms) a worker may be idle before the reaper stops it (AC-4).
        idleReapMs: 6e4,
        // Reconcile-loop interval (ms): rebuilds pool from docker ps (AC-8).
        reconcileMs: 5e3,
        // Max worker lifetime before a drain-and-recycle is triggered (AC-9).
        maxLifetimeMs: 36e5,
        // Per-worker recycle jitter window (ms) to spread pool recycling (AC-9).
        recycleJitterMs: 5e3,
        // Maximum in-flight requests per advisor that can wait in the queue (AC-10).
        queueMax: 100,
        // Maximum time (ms) a queued request may wait before timing out (AC-10).
        queueDeadlineMs: 3e4,
        // Maximum time (ms) to wait for a Slack result before the fallback
        // "couldn't complete" message is posted (AC-16, must be >= dispatch.timeoutSec).
        slackDeadlineMs: 3e3,
        // RAM budget (bytes): 80% of 32 GiB; admission refuses spawns that
        // would exceed this (AC-15).
        ramBudgetBytes: Math.floor(0.8 * 32 * 1024 * 1024 * 1024),
        // TTL (ms) for a worker's mesh registration; the controller refreshes
        // it while the worker is alive; a lapsed TTL triggers unregistration (AC-7).
        registrationTtlMs: 3e5
      }
    };
    function resolveDispatchConcurrency(fleet2) {
      const dispatch2 = fleet2 && fleet2.dispatch || {};
      const spawn = fleet2 && fleet2.spawn || {};
      const configured = Number.isInteger(dispatch2.maxConcurrent) ? dispatch2.maxConcurrent : Number(dispatch2.maxConcurrent) || 3;
      if (spawn.enabled !== true) return configured;
      const poolCeiling = Number.isInteger(spawn.poolCeiling) ? spawn.poolCeiling : Number(spawn.poolCeiling) || 8;
      return Math.max(configured, poolCeiling);
    }
    function resolveSequentialBoard(fleet2, rawFleet) {
      const explicit = rawFleet && rawFleet.orchestrate && Object.prototype.hasOwnProperty.call(rawFleet.orchestrate, "sequentialBoard") ? rawFleet.orchestrate.sequentialBoard : void 0;
      if (explicit !== void 0) return explicit === true;
      const spawnEnabled2 = !!(fleet2 && fleet2.spawn && fleet2.spawn.enabled === true);
      return spawnEnabled2 ? false : true;
    }
    function buildFleetConfig(fileFleet) {
      let rawFleet = fileFleet ? deepMerge({}, fileFleet) : {};
      if (process.env.FLEET_CONFIG_JSON) {
        try {
          rawFleet = deepMerge(rawFleet, JSON.parse(process.env.FLEET_CONFIG_JSON));
        } catch (e) {
        }
      }
      let fleet2 = deepMerge(FLEET_DEFAULTS, fileFleet || {});
      if (process.env.FLEET_CONFIG_JSON) {
        try {
          fleet2 = deepMerge(fleet2, JSON.parse(process.env.FLEET_CONFIG_JSON));
        } catch (e) {
          console.warn("[Config] Invalid FLEET_CONFIG_JSON, ignoring:", e.message);
        }
      }
      fleet2 = {
        ...fleet2,
        orchestrate: {
          ...fleet2.orchestrate,
          sequentialBoard: resolveSequentialBoard(fleet2, rawFleet)
        }
      };
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
      const resolvedAgents = { ...fleet2.agents };
      for (const key of ["openclawConfigPath", "agentsDir", "hermesDir"]) {
        if (typeof resolvedAgents[key] === "string" && resolvedAgents[key].length > 0) {
          resolvedAgents[key] = expandPath(resolvedAgents[key]);
        }
      }
      const resolvedDispatch = {
        ...fleet2.dispatch,
        token: process.env.FLEET_DISPATCH_TOKEN || fleet2.dispatch?.token || "",
        identity: process.env.FLEET_DISPATCH_IDENTITY || fleet2.dispatch?.identity || "",
        // AC-18 — raise maxConcurrent in lockstep with the spawn pool ceiling when
        // the worker pool is enabled, so a parallel board at peak never trips the
        // dispatch 429 open-attempt cap. No-op (preserves the configured value)
        // when spawn is disabled — byte-identical to today.
        maxConcurrent: resolveDispatchConcurrency(fleet2)
      };
      return {
        ...fleet2,
        ...resolvedDirs,
        cortex: resolvedCortex,
        usage: resolvedUsage,
        agents: resolvedAgents,
        dispatch: resolvedDispatch
      };
    }
    function loadConfig({ secrets = defaultSecrets, localPath } = {}) {
      const fileConfig = loadConfigFile({ localPath });
      const workspace = process.env.OPENCLAW_WORKSPACE || expandPath(fileConfig.paths?.workspace) || detectWorkspace();
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
          bindHost: process.env.BIND_HOST || fileConfig.server?.bindHost || ""
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
          publicPaths: fileConfig.auth?.publicPaths || ["/api/health", "/api/whoami", "/favicon.ico"],
          // Tailscale Serve-origin verification (security hardening). DEFAULT OFF =
          // exactly the prior behavior: the tailscale-user-login header is trusted
          // from any allowlisted caller. When verifyServeOrigin is true, that header
          // is only honored if the request arrived via a loopback Serve proxy AND a
          // `tailscale whois` lookup of the x-forwarded-for IP confirms the login
          // (fail closed). Flip this ON together with server.bindHost=127.0.0.1 at
          // the Serve cutover. tailscaledSocket overrides the default socket path.
          tailscale: {
            verifyServeOrigin: process.env.AUTH_TAILSCALE_VERIFY_SERVE_ORIGIN === "true" || fileConfig.auth?.tailscale?.verifyServeOrigin === true,
            tailscaledSocket: process.env.AUTH_TAILSCALED_SOCKET || fileConfig.auth?.tailscale?.tailscaledSocket || ""
          }
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
      const { value: resolved, failures } = secrets.resolveDeepSync(config);
      for (const failure of failures) {
        console.warn(
          `[Config] 1Password ref ${failure.ref} (${failure.path}) failed: ${failure.error} \u2014 keeping the reference in place`
        );
      }
      return resolved;
    }
    var CONFIG2 = loadConfig();
    console.log("[Config] Workspace:", CONFIG2.paths.workspace);
    console.log("[Config] Auth mode:", CONFIG2.auth.mode);
    module2.exports = {
      CONFIG: CONFIG2,
      loadConfig,
      detectWorkspace,
      expandPath,
      getOpenClawDir: getOpenClawDir2,
      resolveDispatchConcurrency,
      resolveSequentialBoard
    };
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
    var cronFallbackFn = null;
    var auditRecordFn = null;
    var IDENTITY_HEADER = "tailscale-user-login";
    function getUser(req) {
      const login = req && req.headers ? req.headers[IDENTITY_HEADER] : void 0;
      return typeof login === "string" && login.trim().length > 0 ? login.trim().toLowerCase() : "anonymous";
    }
    function recordAudit2(req, action, target, detail) {
      if (typeof auditRecordFn !== "function") return;
      try {
        auditRecordFn({ user: getUser(req), action, target, detail });
      } catch (e) {
        console.error("[Jobs] Audit record failed:", e.message);
      }
    }
    function setAuditRecorder2(fn) {
      auditRecordFn = fn;
    }
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
      apiInstance = options.api || null;
      forceApiUnavailable = options.forceUnavailable || false;
      cronFallbackFn = null;
      auditRecordFn = null;
    }
    function setCronFallback2(fn) {
      cronFallbackFn = fn;
    }
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
        ...failing ? { stats: { streak: { type: "failed", count: 2 } } } : {}
      };
    }
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
    function handleCronBackedRequest(res, pathname, method, jobs) {
      const json = (code, payload) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload, null, 2));
      };
      if (method !== "GET") {
        json(405, { error: "Jobs are backed by the read-only cron source \u2014 manage them in Cron." });
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
            pausedJobs: jobs.filter((j) => j.paused).length
          },
          timestamp: Date.now()
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
        const cronJobs = getCronBackedJobs();
        if (cronJobs) {
          handleCronBackedRequest(res, pathname, method, cronJobs);
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            available: false,
            reason: "Jobs library not installed",
            jobs: [],
            timestamp: Date.now()
          })
        );
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
          recordAudit2(req, "cache.clear", "jobs", null);
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
          res.end(JSON.stringify({ available: true, jobs: enhanced, timestamp: Date.now() }, null, 2));
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
          recordAudit2(req, "job.run", jobId, { success: !!result.success });
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
          recordAudit2(req, "job.update", jobId, { op: "pause" });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result, null, 2));
          return;
        }
        const resumeMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/resume$/);
        if (resumeMatch && method === "POST") {
          const jobId = decodeURIComponent(resumeMatch[1]);
          const result = await api.resumeJob(jobId);
          recordAudit2(req, "job.update", jobId, { op: "resume" });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result, null, 2));
          return;
        }
        const skipMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/skip$/);
        if (skipMatch && method === "POST") {
          const jobId = decodeURIComponent(skipMatch[1]);
          const result = await api.skipJob(jobId);
          recordAudit2(req, "job.update", jobId, { op: "skip" });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result, null, 2));
          return;
        }
        const killMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/kill$/);
        if (killMatch && method === "POST") {
          const jobId = decodeURIComponent(killMatch[1]);
          const result = await api.killJob(jobId);
          recordAudit2(req, "job.update", jobId, { op: "kill" });
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
    module2.exports = {
      handleJobsRequest: handleJobsRequest2,
      isJobsRoute: isJobsRoute2,
      setCronFallback: setCronFallback2,
      setAuditRecorder: setAuditRecorder2,
      _resetForTesting
    };
  }
});

// src/openclaw.js
var require_openclaw = __commonJS({
  "src/openclaw.js"(exports2, module2) {
    var { execFileSync, execFile: execFile2 } = require("child_process");
    var { promisify } = require("util");
    var execFileAsync = promisify(execFile2);
    function getSafeEnv2() {
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
          env: getSafeEnv2(),
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
          env: getSafeEnv2()
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
      getSafeEnv: getSafeEnv2
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
    var vitalsInFlight = null;
    function refreshVitalsAsync() {
      if (vitalsInFlight) return vitalsInFlight;
      vitalsInFlight = collectVitals().finally(() => {
        vitalsInFlight = null;
      });
      return vitalsInFlight;
    }
    async function collectVitals() {
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
      vitals.collectedAt = Date.now();
      cachedVitals = vitals;
      lastVitalsUpdate = vitals.collectedAt;
      console.log("[Vitals] Cache refreshed async");
    }
    setTimeout(() => refreshVitalsAsync(), 500).unref();
    setInterval(() => refreshVitalsAsync(), VITALS_CACHE_TTL).unref();
    async function forceRefreshVitals2() {
      await refreshVitalsAsync();
      return getSystemVitals2();
    }
    function getVitalsCacheAgeMs2() {
      return lastVitalsUpdate ? Date.now() - lastVitalsUpdate : Infinity;
    }
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
      forceRefreshVitals: forceRefreshVitals2,
      getVitalsCacheAgeMs: getVitalsCacheAgeMs2,
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
    var WHOIS_CACHE_MS = 5e3;
    var WHOIS_TIMEOUT_MS = 2e3;
    function isLoopbackAddr(addr) {
      if (typeof addr !== "string" || !addr) return false;
      const normalized = addr.replace(/^::ffff:/i, "");
      return normalized === "127.0.0.1" || normalized === "::1" || addr === "::1";
    }
    function createTailscaleWhois2({ socket = "", bin = "tailscale", execFileFn, nowFn = Date.now } = {}) {
      const cache = /* @__PURE__ */ new Map();
      const exec = typeof execFileFn === "function" ? execFileFn : require("child_process").execFile;
      return function whois(ip) {
        return new Promise((resolve) => {
          if (typeof ip !== "string" || ip.trim().length === 0) {
            resolve(null);
            return;
          }
          const now = nowFn();
          const hit = cache.get(ip);
          if (hit && now - hit.at < WHOIS_CACHE_MS) {
            resolve(hit.login);
            return;
          }
          const args2 = socket ? ["--socket", socket, "whois", "--json", ip] : ["whois", "--json", ip];
          let settled = false;
          const done = (login) => {
            if (settled) return;
            settled = true;
            cache.set(ip, { at: nowFn(), login });
            resolve(login);
          };
          try {
            exec(bin, args2, { encoding: "utf8", timeout: WHOIS_TIMEOUT_MS }, (err, stdout) => {
              if (err || !stdout) {
                done(null);
                return;
              }
              try {
                const parsed = JSON.parse(stdout);
                const login = parsed && parsed.UserProfile && parsed.UserProfile.LoginName;
                done(typeof login === "string" && login ? login.toLowerCase() : null);
              } catch (e) {
                done(null);
              }
            });
          } catch (e) {
            done(null);
          }
        });
      };
    }
    async function verifyServeLogin2(req, claimedLogin, whoisFn) {
      if (typeof whoisFn !== "function") return null;
      const remoteAddr = req.socket?.remoteAddress || "";
      if (!isLoopbackAddr(remoteAddr)) return null;
      const xff = req.headers["x-forwarded-for"];
      const forwardedIp = typeof xff === "string" ? xff.split(",")[0]?.trim() : "";
      if (!forwardedIp) return null;
      const resolved = await whoisFn(forwardedIp);
      if (!resolved || resolved !== claimedLogin) return null;
      return resolved;
    }
    function checkAuth2(req, authConfig) {
      const mode = authConfig.mode;
      const remoteAddr = req.socket?.remoteAddress || "";
      const isLocalhost = remoteAddr === "127.0.0.1" || remoteAddr === "::1" || remoteAddr === "::ffff:127.0.0.1";
      const tsCfg = authConfig.tailscale || {};
      const looksLikeServeProxy = mode === "tailscale" && tsCfg.verifyServeOrigin === true && typeof req.headers["x-forwarded-for"] === "string" && req.headers["x-forwarded-for"].length > 0;
      if (isLocalhost && !looksLikeServeProxy) {
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
        const decide = () => {
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
        };
        const ts = authConfig.tailscale || {};
        if (!ts.verifyServeOrigin) {
          return decide();
        }
        return verifyServeLogin2(req, login, ts.whoisFn).then((verified) => {
          if (!verified) {
            return {
              authorized: false,
              reason: "Tailscale identity could not be verified via Serve origin",
              user: { login }
            };
          }
          return decide();
        });
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
    module2.exports = {
      AUTH_HEADERS,
      checkAuth: checkAuth2,
      getUnauthorizedPage: getUnauthorizedPage2,
      createTailscaleWhois: createTailscaleWhois2,
      verifyServeLogin: verifyServeLogin2,
      isLoopbackAddr
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
    function deriveKind(key, entry = {}) {
      if (entry.spawnedBy || entry.subagentRole || key.includes(":subagent:")) return "spawn-child";
      if (key.includes(":cron:")) return "cron";
      if (entry.chatType === "group" || entry.groupId) return "group";
      return "direct";
    }
    function createSessionsModule2(deps) {
      const { getOpenClawDir: getOpenClawDir2, getOperatorBySlackId: getOperatorBySlackId2, runOpenClawAsync: runOpenClawAsync2, extractJSON: extractJSON2 } = deps;
      const sessionsSource = deps.sessionsSource === "cli" ? "cli" : "files";
      const refreshMs = Number.isFinite(deps.refreshMs) && deps.refreshMs > 0 ? deps.refreshMs : 3e4;
      const enabled = deps.enabled !== false;
      let sessionsCache = { sessions: [], raw: [], timestamp: 0 };
      let refreshInFlight = null;
      let refreshTimer = null;
      let storeFileCache = { mtimeMs: 0, size: -1, entries: null };
      const originatorMemo = /* @__PURE__ */ new Map();
      const topicMemo = /* @__PURE__ */ new Map();
      const MEMO_MAX = 2e3;
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
      function memoized(memo, sessionId, transcriptPath, compute) {
        let mtimeMs = 0;
        try {
          mtimeMs = fs2.statSync(transcriptPath).mtimeMs;
        } catch (e) {
          return compute();
        }
        const hit = memo.get(sessionId);
        if (hit && hit.mtimeMs === mtimeMs) return hit.value;
        const value = compute();
        if (memo.size >= MEMO_MAX) memo.clear();
        memo.set(sessionId, { mtimeMs, value });
        return value;
      }
      function getSessionOriginator(sessionId) {
        try {
          if (!sessionId) return null;
          const transcriptPath = findTranscriptPath(sessionId);
          if (!transcriptPath) return null;
          return memoized(
            originatorMemo,
            sessionId,
            transcriptPath,
            () => computeSessionOriginator(transcriptPath)
          );
        } catch (e) {
          return null;
        }
      }
      function computeSessionOriginator(transcriptPath) {
        try {
          const fd = fs2.openSync(transcriptPath, "r");
          const buffer = Buffer.alloc(131072);
          const bytesRead = fs2.readSync(fd, buffer, 0, buffer.length, 0);
          fs2.closeSync(fd);
          if (bytesRead === 0) return null;
          const content = buffer.toString("utf8", 0, bytesRead);
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
          return memoized(
            topicMemo,
            sessionId,
            transcriptPath,
            () => computeSessionTopic(transcriptPath)
          );
        } catch (e) {
          return null;
        }
      }
      function computeSessionTopic(transcriptPath) {
        try {
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
        if (s.kind === "spawn-child" || s.key.includes(":subagent:")) sessionType = "subagent";
        else if (s.kind === "cron" || s.key.includes(":cron:")) sessionType = "cron";
        else if (s.key === "agent:main:main" || s.key.startsWith("agent:main:main:"))
          sessionType = "main";
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
      function getStorePath() {
        return path2.join(getOpenClawDir2(), "agents", "main", "sessions", "sessions.json");
      }
      function getDefaultModel() {
        try {
          const configPath = path2.join(getOpenClawDir2(), "openclaw.json");
          const config = JSON.parse(fs2.readFileSync(configPath, "utf8"));
          const primary = config?.agents?.defaults?.model?.primary;
          if (typeof primary === "string" && primary.length > 0) {
            const slash = primary.indexOf("/");
            return slash > 0 ? { model: primary.slice(slash + 1), modelProvider: primary.slice(0, slash) } : { model: primary, modelProvider: void 0 };
          }
        } catch (e) {
        }
        return { model: void 0, modelProvider: void 0 };
      }
      function listSessionsFromStore() {
        const storePath = getStorePath();
        let stat;
        try {
          stat = fs2.statSync(storePath);
        } catch (e) {
          return [];
        }
        const now = Date.now();
        if (storeFileCache.entries && storeFileCache.mtimeMs === stat.mtimeMs && storeFileCache.size === stat.size) {
          return storeFileCache.entries.map((s) => ({ ...s, ageMs: now - (s.updatedAt || 0) }));
        }
        let store;
        try {
          store = JSON.parse(fs2.readFileSync(storePath, "utf8"));
        } catch (e) {
          console.error("[Sessions Files] Store parse error:", e.message);
          return storeFileCache.entries ? storeFileCache.entries.map((s) => ({ ...s, ageMs: now - (s.updatedAt || 0) })) : [];
        }
        const defaults = getDefaultModel();
        const entries = Object.entries(store).filter(([, v]) => v && typeof v === "object").map(([key, v]) => ({
          key,
          sessionId: v.sessionId,
          updatedAt: v.updatedAt || 0,
          ageMs: now - (v.updatedAt || 0),
          totalTokens: v.totalTokens ?? (v.inputTokens || 0) + (v.outputTokens || 0),
          inputTokens: v.inputTokens,
          outputTokens: v.outputTokens,
          model: v.model || defaults.model,
          modelProvider: v.modelProvider || defaults.modelProvider,
          contextTokens: v.contextTokens,
          kind: deriveKind(key, v),
          displayName: v.displayName,
          groupChannel: v.groupChannel,
          label: v.label,
          agentId: "main"
        })).sort((a, b) => b.updatedAt - a.updatedAt);
        storeFileCache = { mtimeMs: stat.mtimeMs, size: stat.size, entries };
        return entries;
      }
      async function fetchRawSessions() {
        if (sessionsSource === "files") {
          return listSessionsFromStore();
        }
        const output = await runOpenClawAsync2("sessions --json 2>/dev/null");
        const jsonStr = extractJSON2(output);
        if (!jsonStr) return null;
        return JSON.parse(jsonStr).sessions || [];
      }
      function refreshSessionsCache() {
        if (!enabled) return Promise.resolve();
        if (refreshInFlight) return refreshInFlight;
        refreshInFlight = (async () => {
          try {
            const raw = await fetchRawSessions();
            if (raw) {
              const mapped = raw.map((s) => mapSession(s));
              sessionsCache = { sessions: mapped, raw, timestamp: Date.now() };
            }
          } catch (e) {
            console.error("[Sessions Cache] Refresh error:", e.message);
          } finally {
            refreshInFlight = null;
          }
        })();
        return refreshInFlight;
      }
      function getCacheAgeMs() {
        return sessionsCache.timestamp ? Date.now() - sessionsCache.timestamp : Infinity;
      }
      function getSessionsCached() {
        if (enabled && getCacheAgeMs() > refreshMs) {
          refreshSessionsCache();
        }
        return sessionsCache.sessions;
      }
      function getRawSessionsCached() {
        getSessionsCached();
        return sessionsCache.raw;
      }
      function getSessions(options = {}) {
        const limit = Object.prototype.hasOwnProperty.call(options, "limit") ? options.limit : 20;
        const returnCount = options.returnCount || false;
        const cached = getSessionsCached();
        const totalCount = cached.length;
        const sessions2 = limit == null ? cached : cached.slice(0, limit);
        return returnCount ? { sessions: sessions2, totalCount } : sessions2;
      }
      function startSessionsRefresh() {
        if (!enabled || refreshTimer) return;
        refreshSessionsCache();
        refreshTimer = setInterval(() => refreshSessionsCache(), refreshMs);
        if (refreshTimer.unref) refreshTimer.unref();
        console.log(
          `[Sessions Cache] Background refresh started (source=${sessionsSource}, ${refreshMs}ms)`
        );
      }
      function stopSessionsRefresh() {
        if (refreshTimer) {
          clearInterval(refreshTimer);
          refreshTimer = null;
        }
      }
      async function resolveTranscriptForId(sessionId) {
        if (typeof sessionId !== "string" || sessionId.length === 0) return null;
        if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
        if (sessionsCache.timestamp === 0) await refreshSessionsCache();
        const known = sessionsCache.raw.some((s) => s && s.sessionId === sessionId);
        if (!known) return null;
        return findTranscriptPath(sessionId);
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
      async function getSessionDetail(sessionKey) {
        try {
          if (sessionsCache.timestamp === 0) {
            await refreshSessionsCache();
          }
          const sessionInfo = sessionsCache.raw.find((s) => s.key === sessionKey);
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
        getRawSessionsCached,
        getSessions,
        getCacheAgeMs,
        listSessionsFromStore,
        startSessionsRefresh,
        stopSessionsRefresh,
        readTranscript,
        resolveTranscriptForId,
        getSessionDetail,
        parseSessionLabel
      };
    }
    module2.exports = { createSessionsModule: createSessionsModule2, CHANNEL_MAP, deriveKind };
  }
});

// src/cron.js
var require_cron = __commonJS({
  "src/cron.js"(exports2, module2) {
    var fs2 = require("fs");
    var os2 = require("os");
    var path2 = require("path");
    var { execFile: execFile2 } = require("child_process");
    var CLI_CACHE_TTL_MS = 6e4;
    var CLI_TIMEOUT_MS = 3e4;
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
    function formatNextRun(nextRunAtMs) {
      if (!nextRunAtMs || !Number.isFinite(nextRunAtMs)) return "\u2014";
      const diffMins = Math.round((nextRunAtMs - Date.now()) / 6e4);
      if (diffMins < 0) return "overdue";
      if (diffMins < 60) return `${diffMins}m`;
      if (diffMins < 1440) return `${Math.round(diffMins / 60)}h`;
      return `${Math.round(diffMins / 1440)}d`;
    }
    function parseOpenClawSchedule(schedule) {
      if (!schedule) return { schedule: "\u2014", scheduleHuman: null };
      if (schedule.kind === "cron" && schedule.expr) {
        return { schedule: schedule.expr, scheduleHuman: cronToHuman(schedule.expr) };
      }
      if (schedule.kind === "once" || schedule.kind === "at") {
        return { schedule: "once", scheduleHuman: "One-time" };
      }
      if (schedule.kind === "every" && Number.isFinite(schedule.everyMs)) {
        const mins = Math.round(schedule.everyMs / 6e4);
        return {
          schedule: `every ${mins}m`,
          scheduleHuman: mins >= 60 ? `Every ${Math.round(mins / 60)} hours` : `Every ${mins} minutes`
        };
      }
      return { schedule: schedule.kind || "\u2014", scheduleHuman: null };
    }
    function mapOpenClawJob(job, node) {
      const { schedule, scheduleHuman } = parseOpenClawSchedule(job.schedule);
      const state2 = job.state || {};
      return {
        id: job.id,
        name: job.name || String(job.id || "").slice(0, 8),
        schedule,
        scheduleHuman,
        enabled: job.enabled !== false,
        nextRun: formatNextRun(state2.nextRunAtMs),
        lastStatus: state2.lastStatus ?? state2.lastRunStatus ?? null,
        // Epoch ms of the most recent run (null when the job never ran) — feeds
        // the per-agent flight-recorder timeline (cron.run events).
        lastRunAtMs: Number.isFinite(state2.lastRunAtMs) ? state2.lastRunAtMs : null,
        agent: job.agentId || null,
        node,
        source: "openclaw"
      };
    }
    function mapHermesJob(job, node) {
      let schedule = "\u2014";
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
        lastStatus: job.last_status ?? null,
        lastRunAtMs,
        agent: job.profile || null,
        node,
        source: "hermes"
      };
    }
    function defaultCliRunner() {
      return new Promise((resolve, reject) => {
        const profile = process.env.OPENCLAW_PROFILE || "";
        const args2 = [...profile ? ["--profile", profile] : [], "cron", "list", "--json"];
        execFile2(
          "openclaw",
          args2,
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
              OPENCLAW_HOME: process.env.OPENCLAW_HOME || ""
            }
          },
          (error, stdout) => error ? reject(error) : resolve(stdout)
        );
      });
    }
    var cliRunner = defaultCliRunner;
    var cliCache = { rawJobs: null, fetchedAt: 0, refreshing: false, promise: null };
    function refreshCliCache() {
      if (cliCache.refreshing) return cliCache.promise;
      const promise = Promise.resolve().then(() => cliRunner()).then((stdout) => {
        const parsed = JSON.parse(String(stdout));
        cliCache = {
          rawJobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
          fetchedAt: Date.now(),
          refreshing: false,
          promise: null
        };
      }).catch((e) => {
        console.error("[Cron] CLI refresh failed:", e.message);
        cliCache = { ...cliCache, fetchedAt: Date.now(), refreshing: false, promise: null };
      });
      cliCache = { ...cliCache, refreshing: true, promise };
      return promise;
    }
    function getOpenClawRawJobs(getOpenClawDir2) {
      const cronPath = path2.join(getOpenClawDir2(), "cron", "jobs.json");
      if (fs2.existsSync(cronPath)) {
        const data = JSON.parse(fs2.readFileSync(cronPath, "utf8"));
        return Array.isArray(data.jobs) ? data.jobs : [];
      }
      if (Date.now() - cliCache.fetchedAt > CLI_CACHE_TTL_MS) {
        refreshCliCache();
      }
      return cliCache.rawJobs || [];
    }
    function getHermesRawJobs(hermesCronPath) {
      const target = hermesCronPath || path2.join(os2.homedir(), ".hermes", "cron", "jobs.json");
      if (!fs2.existsSync(target)) return [];
      const data = JSON.parse(fs2.readFileSync(target, "utf8"));
      return Array.isArray(data.jobs) ? data.jobs : [];
    }
    function getCronJobs2(getOpenClawDir2, opts = {}) {
      const node = os2.hostname();
      let openclawJobs = [];
      try {
        openclawJobs = getOpenClawRawJobs(getOpenClawDir2).map((j) => mapOpenClawJob(j, node));
      } catch (e) {
        console.error("Failed to get cron:", e.message);
      }
      let hermesJobs = [];
      try {
        hermesJobs = getHermesRawJobs(opts.hermesCronPath).map((j) => mapHermesJob(j, node));
      } catch (e) {
        console.error("Failed to get Hermes cron:", e.message);
      }
      return [...openclawJobs, ...hermesJobs];
    }
    function forceCliRefresh2() {
      const inflight = cliCache.promise || Promise.resolve();
      return inflight.then(() => {
        cliCache = { ...cliCache, fetchedAt: 0 };
        return refreshCliCache();
      });
    }
    function _resetForTesting(options = {}) {
      cliCache = { rawJobs: null, fetchedAt: 0, refreshing: false, promise: null };
      cliRunner = options.cliRunner || defaultCliRunner;
    }
    function _waitForCliRefreshForTesting() {
      return cliCache.promise || Promise.resolve();
    }
    module2.exports = {
      cronToHuman,
      getCronJobs: getCronJobs2,
      forceCliRefresh: forceCliRefresh2,
      _resetForTesting,
      _waitForCliRefreshForTesting
    };
  }
});

// src/cron-actions.js
var require_cron_actions = __commonJS({
  "src/cron-actions.js"(exports2, module2) {
    var { execFile: execFile2 } = require("child_process");
    var CLI_TIMEOUT_MS = 3e4;
    function httpError(statusCode, message) {
      const err = new Error(message);
      err.statusCode = statusCode;
      return err;
    }
    function defaultExecFn(args2) {
      return new Promise((resolve, reject) => {
        execFile2(
          "openclaw",
          args2,
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
              OPENCLAW_HOME: process.env.OPENCLAW_HOME || ""
            }
          },
          (error, stdout, stderr) => {
            if (error) {
              const detail = String(stderr || "").trim();
              reject(new Error(detail ? `${error.message}: ${detail}` : error.message));
              return;
            }
            resolve(stdout);
          }
        );
      });
    }
    function createCronActions2({ execFn = defaultExecFn, getJobs, refreshJobs = async () => {
    } }) {
      if (typeof getJobs !== "function") {
        throw new Error("createCronActions requires a getJobs function");
      }
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
            `Cron job '${id}' comes from a read-only source ('${job.source}') \u2014 only OpenClaw jobs can be modified from the dashboard`
          );
        }
        return job;
      }
      function profileArgs() {
        const profile = process.env.OPENCLAW_PROFILE || "";
        return profile ? ["--profile", profile] : [];
      }
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
      async function setJobEnabled(id, enabled) {
        requireWritableJob(id);
        await mutate(enabled ? "enable" : "disable", id);
        return { id, enabled: Boolean(enabled) };
      }
      async function runJobNow(id) {
        requireWritableJob(id);
        await mutate("run", id);
        return { id, triggered: true };
      }
      return { setJobEnabled, runJobNow };
    }
    module2.exports = { createCronActions: createCronActions2 };
  }
});

// src/cron-routes.js
var require_cron_routes = __commonJS({
  "src/cron-routes.js"(exports2, module2) {
    var IDENTITY_HEADER = "tailscale-user-login";
    var CRON_ACTION_RE = /^\/api\/cron\/([^/]+)\/(enable|disable|run)$/;
    function isCronActionRoute(pathname) {
      return CRON_ACTION_RE.test(pathname);
    }
    function json(res, statusCode, payload) {
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload, null, 2));
    }
    function getUser(req) {
      const login = req.headers[IDENTITY_HEADER];
      return typeof login === "string" && login.trim().length > 0 ? login.trim().toLowerCase() : "anonymous";
    }
    function createCronRoutes2({ actions, audit, rateLimiter, enabled = true }) {
      if (!actions || !audit || !rateLimiter) {
        throw new Error("createCronRoutes requires actions, audit and rateLimiter");
      }
      async function handle(req, res, pathname) {
        const match = pathname.match(CRON_ACTION_RE);
        if (!match) {
          json(res, 404, { error: `Unknown cron route: ${req.method} ${pathname}` });
          return;
        }
        if (req.method !== "POST") {
          json(res, 405, { error: "Method not allowed" });
          return;
        }
        if (!enabled) {
          json(res, 503, { error: "OpenClaw sources are disabled on this instance" });
          return;
        }
        let id;
        try {
          id = decodeURIComponent(match[1]);
        } catch (e) {
          json(res, 400, { error: "Malformed URL encoding" });
          return;
        }
        const action = match[2];
        const user = getUser(req);
        const ip = req.socket?.remoteAddress || "unknown";
        const verdict = rateLimiter.check(`${user}|${ip}`);
        if (!verdict.allowed) {
          json(res, 429, { error: "Rate limit exceeded", retryAfterMs: verdict.retryAfterMs });
          return;
        }
        try {
          let result;
          if (action === "run") {
            result = await actions.runJobNow(id);
            recordAudit2(user, "cron.run", id, null);
          } else {
            result = await actions.setJobEnabled(id, action === "enable");
            recordAudit2(user, "cron.update", id, { enabled: result.enabled });
          }
          json(res, 200, { success: true, ...result });
        } catch (err) {
          const statusCode = Number.isInteger(err.statusCode) ? err.statusCode : 500;
          if (statusCode >= 500) {
            console.error("[CronRoutes] Action failed:", err);
          }
          json(res, statusCode, { error: err.message || "Internal error" });
        }
      }
      function recordAudit2(user, action, target, detail) {
        try {
          audit.record({ user, action, target, detail });
        } catch (e) {
          console.error("[CronRoutes] Audit record failed:", e.message);
        }
      }
      return { handle, isCronActionRoute };
    }
    module2.exports = { createCronRoutes: createCronRoutes2, isCronActionRoute };
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
    var { execFile: execFile2 } = require("child_process");
    var { getSafeEnv: getSafeEnv2 } = require_openclaw();
    var llmUsageCache = { data: null, timestamp: 0, refreshing: false };
    var LLM_CACHE_TTL_MS = 6e4;
    function refreshLlmUsageAsync() {
      if (llmUsageCache.refreshing) return;
      llmUsageCache.refreshing = true;
      const profile = process.env.OPENCLAW_PROFILE || "";
      const args2 = profile ? ["--profile", profile, "status", "--usage", "--json"] : ["status", "--usage", "--json"];
      execFile2(
        "openclaw",
        args2,
        { encoding: "utf8", timeout: 2e4, env: getSafeEnv2() },
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
    function getLlmUsage2(statePath, options = {}) {
      const now = Date.now();
      if (options.allowSpawn !== false && (!llmUsageCache.data || now - llmUsageCache.timestamp > LLM_CACHE_TTL_MS)) {
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
    var routingStatsCache = /* @__PURE__ */ new Map();
    var ROUTING_STATS_TTL_MS = 6e4;
    function refreshRoutingStatsAsync(skillsPath, hours) {
      const skillDir = path2.join(skillsPath, "llm_routing");
      if (!fs2.existsSync(skillDir)) return;
      const entry = routingStatsCache.get(hours) || { data: null, timestamp: 0, refreshing: false };
      if (entry.refreshing) return;
      entry.refreshing = true;
      routingStatsCache.set(hours, entry);
      execFile2(
        "python",
        ["-m", "llm_routing", "stats", "--hours", String(hours), "--json"],
        { encoding: "utf8", timeout: 1e4, cwd: skillDir, env: getSafeEnv2() },
        (err, stdout) => {
          entry.refreshing = false;
          if (err) return;
          try {
            entry.data = JSON.parse(stdout);
            entry.timestamp = Date.now();
          } catch (e) {
          }
        }
      );
    }
    function getRoutingStats2(skillsPath, statePath, hours = 24) {
      const safeHours = parseInt(hours, 10) || 24;
      const cached = routingStatsCache.get(safeHours);
      if (cached?.data && Date.now() - cached.timestamp < ROUTING_STATS_TTL_MS) {
        return cached.data;
      }
      refreshRoutingStatsAsync(skillsPath, safeHours);
      if (cached?.data) return cached.data;
      {
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
      setTimeout(() => refreshLlmUsageAsync(), 1e3).unref();
      setInterval(() => refreshLlmUsageAsync(), LLM_CACHE_TTL_MS).unref();
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

// src/dispatch.js
var require_dispatch = __commonJS({
  "src/dispatch.js"(exports2, module2) {
    var fs2 = require("fs");
    var os2 = require("os");
    var path2 = require("path");
    var { execFile: execFile2 } = require("child_process");
    var { getSafeEnv: getSafeEnv2 } = require_openclaw();
    var DEFAULT_MAX_CONCURRENT = 3;
    var DEFAULT_TIMEOUT_SEC = 600;
    var DEFAULT_BASE_URL = "http://127.0.0.1:3333";
    var OPEN_ATTEMPT_GRACE_MS = 15 * 60 * 1e3;
    var DISPATCH_NOTE = "dispatched";
    var PROTOCOL_BRIEF = "agent-task-protocol";
    var EXEC_MAX_BUFFER = 16 * 1024 * 1024;
    var RESULT_SNIPPET_MAX = 300;
    var RESULT_TEXT_MAX = 12 * 1024;
    var AUTO_MOVE_SOURCES = Object.freeze(["assigned", "inprogress"]);
    var WATCHER_ACTOR = "dispatch";
    function httpError(statusCode, message) {
      const err = new Error(message);
      err.statusCode = statusCode;
      return err;
    }
    function timeoutSignal(ms) {
      if (globalThis.AbortSignal && typeof globalThis.AbortSignal.timeout === "function") {
        return globalThis.AbortSignal.timeout(ms);
      }
      return void 0;
    }
    function synthStdout(body) {
      const detail = body && typeof body.detail === "object" && body.detail ? body.detail : {};
      return JSON.stringify({
        result: {
          meta: { agentMeta: { sessionId: detail.sessionId || null } },
          text: detail.outputText || null
        },
        error: detail.cliError || (body && body.success === false ? body.error || "agent run reported failure" : void 0)
      });
    }
    function resolveBinary(name, pathEnv = process.env.PATH || "") {
      for (const dir of pathEnv.split(path2.delimiter)) {
        if (!dir) continue;
        const candidate = path2.join(dir, name);
        try {
          fs2.accessSync(candidate, fs2.constants.X_OK);
          if (fs2.statSync(candidate).isFile()) return candidate;
        } catch (e) {
        }
      }
      return null;
    }
    function isOpenDispatchAttempt(attempt, nowMs, openTtlMs) {
      if (!attempt || attempt.ended_at !== null) return false;
      if (typeof attempt.note !== "string" || !attempt.note.startsWith(DISPATCH_NOTE)) return false;
      const startedMs = Date.parse(attempt.started_at);
      if (Number.isNaN(startedMs)) return false;
      return nowMs - startedMs <= openTtlMs;
    }
    function composeKickoffMessage(task, { agent, baseUrl, briefsDir, slackChannel, isBoard }) {
      const protocolPath = briefsDir ? path2.join(briefsDir, `${PROTOCOL_BRIEF}.md`) : null;
      const channelHint = slackChannel || (isBoard ? "#ceo-boardroom" : `#${agent}-command`);
      const lines = [
        `You have been dispatched a task from the Open Fleet Control kanban board.`,
        ``,
        `Task ${task.id}: ${task.title}`,
        `Priority: P${task.priority}`,
        `Due: ${task.due ? task.due : "none"}`,
        `Description:`,
        task.description && task.description.trim().length > 0 ? task.description : "(none)",
        ``,
        `Dashboard base URL for all API calls: ${baseUrl}`,
        `Identify yourself with the header "Tailscale-User-Login: ${agent}" on every request.`,
        ``,
        `Standing instructions \u2014 follow the fleet-control bindings:`,
        `1. FIRST read the agent task protocol brief and follow it exactly:`,
        `   GET ${baseUrl}/api/fleet/briefs/${PROTOCOL_BRIEF}` + (protocolPath ? ` (local file: ${protocolPath})` : ""),
        `2. Comment on the task when you START, the moment you hit a BLOCKER, and on HANDOFF:`,
        `   POST ${baseUrl}/api/fleet/kanban/tasks/${task.id}/comments {"author":"${agent}","text":"[${agent}] ..."}`,
        `3. Move the card through the lifecycle as you work (inprogress when you begin, review when done):`,
        `   POST ${baseUrl}/api/fleet/kanban/tasks/${task.id}/move {"status":"inprogress"}`,
        `4. Publish your handoff summary to fleet chat:`,
        `   POST ${baseUrl}/api/fleet/chat/publish {"sender":"${agent}","payload":{"text":"..."}}`,
        `5. Submit a lesson learned:`,
        `   POST ${baseUrl}/api/fleet/evolution/lessons {"title":"...","body":"...","author":"${agent}"}`,
        `6. WHEN FINISHED, post your FINAL human-readable answer to Slack ${channelHint} from your own`,
        `   OpenClaw bot account. This Slack post IS the canonical answer \u2014 post the SAME complete text`,
        `   you want recorded as the result (do not summarize it down; the dashboard stores exactly what`,
        `   you post). Run:`,
        `   openclaw message send --channel slack --account ${agent} --target ${channelHint} --message "<your full answer>" --json`,
        ...isBoard ? [`   Because this is a BOARD task, lead the post with "@Chief" and light emojis are welcome.`] : [`   Keep it factual and self-contained \u2014 a teammate reading only the Slack post should understand the outcome.`]
      ];
      return lines.join("\n");
    }
    function shortReason(message, fallback = "failed") {
      return String(message || fallback).split("\n")[0].slice(0, 300);
    }
    function snippet(text) {
      const collapsed = String(text).replace(/\s+/g, " ").trim();
      if (collapsed.length <= RESULT_SNIPPET_MAX) return collapsed;
      return `${collapsed.slice(0, RESULT_SNIPPET_MAX)}\u2026`;
    }
    function canonicalResultText(text) {
      const trimmed = String(text).trim();
      if (trimmed.length <= RESULT_TEXT_MAX) return trimmed;
      return `${trimmed.slice(0, RESULT_TEXT_MAX)}\u2026`;
    }
    function extractOutputText(parsed) {
      const result = parsed.result && typeof parsed.result === "object" ? parsed.result : {};
      if (Array.isArray(result.payloads)) {
        const joined = result.payloads.map((p) => p && typeof p.text === "string" ? p.text : "").filter((text) => text.length > 0).join("\n");
        if (joined.length > 0) return joined;
      }
      for (const candidate of [result.text, result.output, parsed.output, parsed.text]) {
        if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
      }
      return null;
    }
    function extractCliError(parsed) {
      if (typeof parsed.error === "string" && parsed.error.length > 0) return parsed.error;
      if (parsed.error && typeof parsed.error === "object" && parsed.error.message) {
        return String(parsed.error.message);
      }
      if (parsed.success === false || parsed.ok === false) return "agent run reported failure";
      return null;
    }
    function parseRunResult(stdout) {
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (e) {
        return { sessionId: null, outputText: null, error: null };
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { sessionId: null, outputText: null, error: null };
      }
      return {
        sessionId: parsed?.result?.meta?.agentMeta?.sessionId || parsed?.result?.meta?.systemPromptReport?.sessionId || null,
        outputText: extractOutputText(parsed),
        error: extractCliError(parsed)
      };
    }
    function createDispatch2(options = {}) {
      const {
        kanban,
        briefsDir = null,
        onEvent,
        execFn = null,
        config = {},
        nowFn = Date.now,
        fireAlert = null,
        resolveAgentNode = null,
        fetchFn = (...a) => globalThis.fetch(...a),
        meshIdentity = null,
        dispatchToken = null,
        remoteTimeoutMs = null
      } = options;
      if (!kanban) throw new Error("createDispatch: kanban is required");
      const enabled = config.enabled !== false;
      const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
      const maxConcurrent = Number.isInteger(config.maxConcurrent) ? config.maxConcurrent : DEFAULT_MAX_CONCURRENT;
      const timeoutSec = Number.isInteger(config.timeoutSec) ? config.timeoutSec : DEFAULT_TIMEOUT_SEC;
      const selfNode = config.node || os2.hostname();
      const openTtlMs = timeoutSec * 1e3 + OPEN_ATTEMPT_GRACE_MS;
      let binaryProbe = null;
      function mechanismAvailable() {
        if (typeof execFn === "function") return true;
        if (binaryProbe === null) binaryProbe = resolveBinary("openclaw") || false;
        return binaryProbe !== false;
      }
      function defaultExecFn(args2, { timeoutMs }) {
        return new Promise((resolve, reject) => {
          execFile2(
            "openclaw",
            args2,
            { encoding: "utf8", timeout: timeoutMs, env: getSafeEnv2(), maxBuffer: EXEC_MAX_BUFFER },
            (err, stdout) => {
              if (err) reject(err);
              else resolve({ stdout });
            }
          );
        });
      }
      function runLocal(args2) {
        const run = typeof execFn === "function" ? execFn : defaultExecFn;
        return Promise.resolve(run(args2, { timeoutMs: timeoutSec * 1e3 + 5e3 })).then(
          ({ stdout }) => ({ ok: true, stdout }),
          (error) => ({ ok: false, error })
        );
      }
      async function runRemote(route, { agent, message, sessionKey }) {
        const url = `${route.baseUrl}/api/action`;
        const ms = remoteTimeoutMs || timeoutSec * 1e3 + 5e3;
        let res;
        try {
          res = await fetchFn(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              // Tailnet identity so the remote node can authorise the node→node call.
              ...meshIdentity ? { "Tailscale-User-Login": meshIdentity } : {},
              "X-OFC-Dispatch": "1",
              // Shared dispatch token (guardActionPost token branch) — the only
              // branch that authorises when the remote has verifyServeOrigin ON.
              // Omitted when unset → byte-identical to the prior behavior.
              ...dispatchToken ? { Authorization: `Bearer ${dispatchToken}` } : {}
            },
            body: JSON.stringify({ action: "agent-run", agent, message, sessionKey, timeoutSec }),
            signal: timeoutSignal(ms)
          });
        } catch (e) {
          return { ok: false, error: e };
        }
        if (!res || res.ok !== true) {
          return {
            ok: false,
            error: new Error(`HTTP ${res && res.status ? res.status : "error"} from ${url}`)
          };
        }
        let body;
        try {
          body = await res.json();
        } catch (e) {
          return { ok: false, error: new Error("Malformed agent-run response") };
        }
        if (body && body.success === false && (body.error || body.detail && body.detail.cliError)) {
          return { ok: true, stdout: synthStdout(body) };
        }
        if (!body || body.success !== true) {
          return {
            ok: false,
            error: new Error(body && body.error ? body.error : "Remote agent-run failed")
          };
        }
        return { ok: true, stdout: synthStdout(body) };
      }
      function startRun(node, { args: args2, agent, agentRef, message, sessionKey }) {
        if (typeof resolveAgentNode !== "function") {
          ensureLocalNode(node);
          return runLocal(args2);
        }
        const ref = agentRef || (node && !agent.includes("@") ? `${agent}@${node}` : agent);
        return Promise.resolve(resolveAgentNode(ref)).then((route) => {
          if (!route || route.kind === "local") return runLocal(args2);
          if (route.kind === "unknown") {
            return { ok: false, error: new Error(`Unknown agent '${agent}' in fleet roster`) };
          }
          if (route.kind === "unreachable") {
            return {
              ok: false,
              error: new Error(`No mesh node hosts agent '${agent}' (node ${route.node})`)
            };
          }
          if (route.online === false) {
            return {
              ok: false,
              error: new Error(`Target node ${route.node} is offline (mesh precheck)`)
            };
          }
          return runRemote(route, { agent, message, sessionKey });
        }).catch((error) => ({ ok: false, error }));
      }
      function emit(event) {
        if (typeof onEvent === "function") {
          try {
            onEvent(event);
          } catch (e) {
            console.error("[Dispatch] onEvent handler failed:", e.message);
          }
        }
      }
      function requireTask(id) {
        const board = kanban.getBoard();
        const task = board.tasks.find((t) => t.id === id);
        if (!task) throw httpError(404, `Unknown task: ${id}`);
        return { board, task };
      }
      function requireAgent(agent) {
        if (typeof agent !== "string" || agent.trim().length === 0) {
          throw httpError(400, "Body must include a non-empty 'agent' field");
        }
        return agent.trim();
      }
      function ensureAvailable() {
        if (!enabled) throw httpError(503, "Dispatch is disabled (fleet.dispatch.enabled=false)");
        if (!mechanismAvailable()) {
          throw httpError(503, "Dispatch mechanism unavailable: openclaw CLI not found on PATH");
        }
      }
      function ensureLocalNode(node) {
        if (node && node !== selfNode) {
          throw httpError(400, `remote dispatch not yet supported (this node is '${selfNode}')`);
        }
      }
      function resolveSlack(agent, opts = {}) {
        const isBoard = opts.isBoard === true;
        const slackChannel = typeof opts.slackChannel === "string" && opts.slackChannel.trim() ? opts.slackChannel.trim() : isBoard ? "#ceo-boardroom" : `#${agent}-command`;
        return { isBoard, slackChannel };
      }
      function countOpenDispatches(board) {
        const nowMs = nowFn();
        return board.tasks.filter(
          (t) => t.attempts.some((a) => isOpenDispatchAttempt(a, nowMs, openTtlMs))
        ).length;
      }
      function hasOpenDispatch(task) {
        const nowMs = nowFn();
        return task.attempts.some((a) => isOpenDispatchAttempt(a, nowMs, openTtlMs));
      }
      function closeAttempt(taskId, attemptIndex, { result, note, result_text }) {
        try {
          kanban.updateAttempt(taskId, attemptIndex, {
            ended_at: new Date(nowFn()).toISOString(),
            result,
            note,
            ...result_text !== void 0 ? { result_text } : {}
          });
        } catch (e) {
          console.error(`[Dispatch] Could not close attempt on ${taskId}:`, e.message);
        }
      }
      function autoMoveOnSettle(taskId, toStatus) {
        try {
          const task = kanban.getBoard().tasks.find((t) => t.id === taskId);
          if (!task || !AUTO_MOVE_SOURCES.includes(task.status)) return;
          kanban.moveTask(taskId, toStatus, task.order, WATCHER_ACTOR);
        } catch (e) {
          console.error(`[Dispatch] Could not auto-move ${taskId} to ${toStatus}:`, e.message);
        }
      }
      function notifyCompletion({ taskId, agent, ok, detail }) {
        if (typeof fireAlert !== "function") return;
        const message = `Dispatch ${ok ? "completed" : "failed"} for task ${taskId} (agent ${agent})` + (detail ? `: ${detail}` : "");
        try {
          Promise.resolve(
            fireAlert({
              type: "dispatchComplete",
              severity: ok ? "info" : "warn",
              task: taskId,
              message
            })
          ).catch((e) => {
            console.error("[Dispatch] dispatchComplete alert failed:", e.message);
          });
        } catch (e) {
          console.error("[Dispatch] dispatchComplete alert failed:", e.message);
        }
      }
      function settleFailure(taskId, attemptIndex, agent, { reason, timedOut }) {
        const label = timedOut ? "timeout" : "failed";
        closeAttempt(taskId, attemptIndex, {
          result: "failure",
          note: `${DISPATCH_NOTE} \xB7 ${label}: ${reason}`
        });
        try {
          kanban.addComment(taskId, {
            author: WATCHER_ACTOR,
            text: `[Dispatch] Agent run for ${agent} ${timedOut ? "timed out" : "failed"}: ${reason}`
          });
        } catch (e) {
          console.error(`[Dispatch] Could not record failure comment on ${taskId}:`, e.message);
        }
        autoMoveOnSettle(taskId, "failed");
        emit({ type: "task.dispatch_failed", taskId, agent, error: reason, timedOut });
        notifyCompletion({ taskId, agent, ok: false, detail: reason });
      }
      function handleRunSettled(taskId, attemptIndex, agent, settled, startedMs) {
        if (settled.ok) {
          const run = parseRunResult(settled.stdout);
          if (run.error) {
            settleFailure(taskId, attemptIndex, agent, {
              reason: shortReason(run.error),
              timedOut: false
            });
            return;
          }
          const noteParts = [
            DISPATCH_NOTE,
            run.sessionId ? `session ${run.sessionId}` : "completed",
            ...run.outputText ? [`result: ${snippet(run.outputText)}`] : []
          ];
          const fullText = run.outputText ? canonicalResultText(run.outputText) : null;
          closeAttempt(taskId, attemptIndex, {
            result: "success",
            note: noteParts.join(" \xB7 "),
            result_text: fullText
          });
          autoMoveOnSettle(taskId, "review");
          emit({ type: "task.dispatch_completed", taskId, agent, sessionId: run.sessionId });
          notifyCompletion({ taskId, agent, ok: true, detail: null });
          return;
        }
        const err = settled.error || {};
        const timedOut = err.killed === true || Boolean(err.signal) || nowFn() - startedMs >= timeoutSec * 1e3;
        settleFailure(taskId, attemptIndex, agent, {
          reason: shortReason(err.message, timedOut ? `no exit within ${timeoutSec}s` : "failed"),
          timedOut
        });
      }
      function getStatus() {
        let openCount = 0;
        try {
          openCount = countOpenDispatches(kanban.getBoard());
        } catch (e) {
          console.error("[Dispatch] Status board read failed:", e.message);
        }
        return {
          available: enabled && mechanismAvailable(),
          enabled,
          node: selfNode,
          maxConcurrent,
          openCount
        };
      }
      function previewDispatch(taskId, opts = {}) {
        ensureAvailable();
        const agent = requireAgent(opts.agent);
        ensureLocalNode(opts.node);
        const { task } = requireTask(taskId);
        const { isBoard, slackChannel } = resolveSlack(agent, opts);
        return {
          taskId: task.id,
          agent,
          node: selfNode,
          slackChannel,
          message: composeKickoffMessage(task, { agent, baseUrl, briefsDir, slackChannel, isBoard })
        };
      }
      function dispatchTask(taskId, opts = {}) {
        ensureAvailable();
        const agentRef = requireAgent(opts.agent);
        const agent = agentRef.includes("@") ? agentRef.slice(0, agentRef.indexOf("@")) : agentRef;
        if (typeof resolveAgentNode !== "function") ensureLocalNode(opts.node);
        const actor = typeof opts.actor === "string" && opts.actor ? opts.actor : "operator";
        const { board, task } = requireTask(taskId);
        if (hasOpenDispatch(task)) {
          throw httpError(409, `Task ${taskId} already has an open dispatched attempt`);
        }
        if (countOpenDispatches(board) >= maxConcurrent) {
          throw httpError(
            429,
            `Max concurrent dispatches (${maxConcurrent}) reached \u2014 wait for a running dispatch to finish`
          );
        }
        const startedMs = nowFn();
        const sessionKey = `agent:${agent}:kanban-${taskId}-${startedMs}`;
        const { isBoard, slackChannel } = resolveSlack(agent, opts);
        const message = composeKickoffMessage(task, { agent, baseUrl, briefsDir, slackChannel, isBoard });
        const args2 = [
          "agent",
          "--agent",
          agent,
          "--session-key",
          sessionKey,
          "--message",
          message,
          "--json",
          "--timeout",
          String(timeoutSec)
        ];
        let settledPromise;
        try {
          settledPromise = startRun(opts.node, { args: args2, agent, agentRef, message, sessionKey });
        } catch (e) {
          throw httpError(503, `Dispatch invocation failed: ${e.message}`);
        }
        const afterAttempt = kanban.addAttempt(taskId, { agent, note: DISPATCH_NOTE });
        const attemptIndex = afterAttempt.attempts.length - 1;
        if (task.status === "inbox") {
          kanban.moveTask(taskId, "assigned", task.order, actor);
        }
        kanban.addComment(taskId, {
          author: actor,
          text: `[Dispatch] Dispatched to ${agent} by ${actor} (session key: ${sessionKey})`
        });
        emit({ type: "task.dispatched", taskId, agent, actor, sessionKey });
        const completion = settledPromise.then(
          (settled) => handleRunSettled(taskId, attemptIndex, agent, settled, startedMs)
        );
        const { task: latest } = requireTask(taskId);
        return { task: latest, sessionKey, agent, attemptIndex, completion };
      }
      return { dispatchTask, previewDispatch, getStatus, composeKickoffMessage };
    }
    module2.exports = {
      createDispatch: createDispatch2,
      composeKickoffMessage,
      resolveBinary,
      isOpenDispatchAttempt,
      parseRunResult,
      synthStdout,
      DISPATCH_NOTE
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
      "clear-stale-sessions",
      "agent-run"
      // node→node remote dispatch: run a local agent turn, return the parsed result
    ]);
    var ACTION_ALIASES = {
      "prune-stale": "clear-stale-sessions",
      "clean-stale-sessions": "clear-stale-sessions"
    };
    var DEFAULT_STALE_MINUTES = 24 * 60;
    var MIN_STALE_MINUTES = 5;
    var MAX_STALE_MINUTES = 30 * 24 * 60;
    var AGENT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
    var SESSION_KEY_PATTERN = /^[a-zA-Z0-9:_.-]{1,200}$/;
    var AGENT_RUN_MAX_TIMEOUT_SEC = 1800;
    var AGENT_RUN_DEFAULT_TIMEOUT_SEC = 600;
    var AGENT_RUN_MESSAGE_MAX = 64 * 1024;
    var AGENT_RUN_SNIPPET_MAX = 300;
    function clampAgentTimeout(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return AGENT_RUN_DEFAULT_TIMEOUT_SEC;
      return Math.min(AGENT_RUN_MAX_TIMEOUT_SEC, Math.max(30, Math.round(n)));
    }
    function snippetOneLine(text) {
      const collapsed = String(text).replace(/\s+/g, " ").trim();
      if (collapsed.length <= AGENT_RUN_SNIPPET_MAX) return collapsed;
      return `${collapsed.slice(0, AGENT_RUN_SNIPPET_MAX)}\u2026`;
    }
    function normalizeAction(action) {
      const name = typeof action === "string" ? action.trim() : "";
      return ACTION_ALIASES[name] || name;
    }
    function clampStaleMinutes(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return DEFAULT_STALE_MINUTES;
      return Math.min(MAX_STALE_MINUTES, Math.max(MIN_STALE_MINUTES, Math.round(n)));
    }
    function parseGatewayStatus(raw) {
      const text = String(raw || "");
      const probeOk = /Connectivity probe:\s*ok/i.test(text);
      const listening = /Listening:\s*\S/i.test(text);
      const runtimeMatch = text.match(/Runtime:\s*([^\n(]+)/i);
      const portMatch = text.match(/port=(\d+)/i);
      const versionMatch = text.match(/Gateway version:\s*([^\s\n]+)/i);
      return {
        reachable: probeOk || listening,
        probeOk,
        runtime: runtimeMatch ? runtimeMatch[1].trim() : null,
        port: portMatch ? parseInt(portMatch[1], 10) : null,
        version: versionMatch ? versionMatch[1] : null
      };
    }
    function summarizeGateway(gw) {
      const bits = [gw.reachable ? "reachable" : "NOT reachable"];
      if (gw.port) bits.push(`port ${gw.port}`);
      if (gw.version) bits.push(`v${gw.version}`);
      if (gw.runtime && !gw.reachable) bits.push(`runtime ${gw.runtime}`);
      return `Gateway ${bits.join(", ")}`;
    }
    function parseCleanupResult(raw, extractJSON2) {
      const jsonStr = extractJSON2 ? extractJSON2(raw) : raw;
      if (!jsonStr) return null;
      try {
        const data = JSON.parse(jsonStr);
        if (!data || typeof data !== "object") return null;
        return data;
      } catch (e) {
        return null;
      }
    }
    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
      const MB = 1024 * 1024;
      if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
      if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
      return `${bytes} B`;
    }
    function countStaleSessions(getRawSessions, staleMinutes) {
      if (typeof getRawSessions !== "function") return null;
      try {
        const raw = getRawSessions();
        if (!Array.isArray(raw)) return null;
        const cutoffMs = staleMinutes * 60 * 1e3;
        return raw.filter((s) => s && Number.isFinite(s.ageMs) && s.ageMs > cutoffMs).length;
      } catch (e) {
        return null;
      }
    }
    function countSessions(getRawSessions) {
      if (typeof getRawSessions !== "function") return null;
      try {
        const raw = getRawSessions();
        return Array.isArray(raw) ? raw.length : null;
      } catch (e) {
        return null;
      }
    }
    async function executeAction2(action, deps, opts = {}) {
      const { runOpenClawAsync: runOpenClawAsync2, extractJSON: extractJSON2, PORT: PORT2, getRawSessions } = deps;
      const canonical = normalizeAction(action);
      const results = { success: false, action: canonical, output: "", error: null };
      if (!ALLOWED_ACTIONS.has(canonical)) {
        results.action = typeof action === "string" ? action : String(action);
        results.error = `Unknown action: ${results.action}`;
        return results;
      }
      if (canonical !== "agent-run" && typeof runOpenClawAsync2 !== "function") {
        results.error = "OpenClaw runner unavailable";
        return results;
      }
      try {
        switch (canonical) {
          case "gateway-status": {
            const raw = await runOpenClawAsync2("gateway status");
            if (raw === null || raw === void 0) {
              results.error = "openclaw gateway status failed or timed out";
              break;
            }
            const gw = parseGatewayStatus(raw);
            results.output = summarizeGateway(gw);
            results.detail = { ...gw, raw: String(raw).trim() };
            results.success = true;
            break;
          }
          case "gateway-restart":
            results.output = "To restart gateway, run: openclaw gateway restart";
            results.note = "Dashboard cannot restart gateway for safety";
            results.success = true;
            break;
          case "sessions-list": {
            const raw = await runOpenClawAsync2("sessions");
            results.output = raw || "No sessions";
            results.success = raw !== null && raw !== void 0;
            if (!results.success) results.error = "openclaw sessions failed or timed out";
            break;
          }
          case "cron-list": {
            const raw = await runOpenClawAsync2("cron list");
            results.output = raw || "No cron jobs";
            results.success = raw !== null && raw !== void 0;
            if (!results.success) results.error = "openclaw cron list failed or timed out";
            break;
          }
          case "health-check": {
            const raw = await runOpenClawAsync2("gateway status");
            const gw = parseGatewayStatus(raw || "");
            const sessionCount = countSessions(getRawSessions);
            results.output = [
              gw.reachable ? "Gateway: OK reachable" : "Gateway: NOT reachable",
              `Sessions: ${sessionCount !== null ? sessionCount : "unknown"}`,
              `Dashboard: OK running on port ${PORT2}`
            ].join("\n");
            results.detail = { gateway: gw, sessionCount };
            results.success = gw.reachable;
            if (!gw.reachable) {
              results.error = raw ? "Gateway connectivity probe failed" : "openclaw gateway status failed or timed out";
            }
            break;
          }
          case "clear-stale-sessions": {
            const staleMinutes = clampStaleMinutes(opts.staleMinutes);
            const staleCount = countStaleSessions(getRawSessions, staleMinutes);
            const raw = await runOpenClawAsync2("sessions cleanup --enforce --json");
            const data = parseCleanupResult(raw, extractJSON2);
            if (!data) {
              results.error = "openclaw sessions cleanup failed or timed out";
              break;
            }
            const pruned = Number.isFinite(data.pruned) ? data.pruned : 0;
            const capped = Number.isFinite(data.capped) ? data.capped : 0;
            const missing = Number.isFinite(data.missing) ? data.missing : 0;
            const artifacts = data.unreferencedArtifacts && typeof data.unreferencedArtifacts === "object" ? data.unreferencedArtifacts : {};
            const removedFiles = Number.isFinite(artifacts.removedFiles) ? artifacts.removedFiles : 0;
            const freedBytes = Number.isFinite(artifacts.freedBytes) ? artifacts.freedBytes : 0;
            const parts = [`Cleanup done: ${pruned + capped + missing} session entries removed`];
            if (Number.isFinite(data.beforeCount) && Number.isFinite(data.afterCount)) {
              parts.push(`store ${data.beforeCount} \u2192 ${data.afterCount}`);
            }
            if (removedFiles > 0) {
              parts.push(`${removedFiles} unreferenced files removed (${formatBytes(freedBytes)})`);
            }
            if (staleCount !== null) {
              parts.push(`${staleCount} sessions idle >${Math.round(staleMinutes / 60)}h`);
            }
            results.output = parts.join(" \xB7 ");
            results.detail = {
              staleMinutes,
              staleCount,
              pruned,
              capped,
              missing,
              removedFiles,
              freedBytes,
              beforeCount: Number.isFinite(data.beforeCount) ? data.beforeCount : null,
              afterCount: Number.isFinite(data.afterCount) ? data.afterCount : null
            };
            results.success = true;
            break;
          }
          case "agent-run": {
            const agent = typeof opts.agent === "string" ? opts.agent.trim() : "";
            const message = typeof opts.message === "string" ? opts.message : "";
            const sessionKey = typeof opts.sessionKey === "string" ? opts.sessionKey.trim() : "";
            const timeoutSec = clampAgentTimeout(opts.timeoutSec);
            if (!AGENT_ID_PATTERN.test(agent)) {
              results.error = "Invalid agent id";
              break;
            }
            if (sessionKey && !SESSION_KEY_PATTERN.test(sessionKey)) {
              results.error = "Invalid sessionKey";
              break;
            }
            if (message.length === 0 || message.length > AGENT_RUN_MESSAGE_MAX) {
              results.error = "message must be 1..64KB";
              break;
            }
            if (typeof deps.runAgent !== "function") {
              results.error = "Agent runner unavailable on this node";
              break;
            }
            const args2 = [
              "agent",
              "--agent",
              agent,
              ...sessionKey ? ["--session-key", sessionKey] : [],
              "--message",
              message,
              "--json",
              "--timeout",
              String(timeoutSec)
            ];
            const stdout = await deps.runAgent(args2, { timeoutMs: timeoutSec * 1e3 + 5e3 });
            if (stdout === null || stdout === void 0) {
              results.error = "openclaw agent failed or timed out";
              break;
            }
            const parsed = require_dispatch().parseRunResult(stdout);
            results.output = parsed.outputText ? snippetOneLine(parsed.outputText) : "agent run complete";
            results.detail = {
              sessionId: parsed.sessionId,
              outputText: parsed.outputText,
              // FULL text — the caller stores result_text
              cliError: parsed.error
              // CLI-reported error inside a clean exit
            };
            results.success = parsed.error ? false : true;
            if (parsed.error) results.error = parsed.error;
            break;
          }
        }
      } catch (e) {
        results.error = e.message;
        results.success = false;
      }
      return results;
    }
    module2.exports = {
      executeAction: executeAction2,
      normalizeAction,
      parseGatewayStatus,
      clampAgentTimeout,
      snippetOneLine,
      ALLOWED_ACTIONS,
      ACTION_ALIASES,
      DEFAULT_STALE_MINUTES,
      AGENT_ID_PATTERN,
      SESSION_KEY_PATTERN,
      AGENT_RUN_MAX_TIMEOUT_SEC,
      AGENT_RUN_DEFAULT_TIMEOUT_SEC
    };
  }
});

// src/action-guard.js
var require_action_guard = __commonJS({
  "src/action-guard.js"(exports2, module2) {
    var PRIVILEGED_POST_ACTIONS2 = /* @__PURE__ */ new Set(["agent-run"]);
    function loginFromReq(req) {
      const login = req && req.headers && req.headers["tailscale-user-login"];
      return typeof login === "string" && login.trim().length > 0 ? login.trim().toLowerCase() : "anonymous";
    }
    function isLocalhostAddr(addr) {
      if (typeof addr !== "string" || !addr) return false;
      const normalized = addr.replace(/^::ffff:/i, "");
      return normalized === "127.0.0.1" || normalized === "::1" || addr === "::1";
    }
    function guardActionPost2(req, { token = null, meshLogins = /* @__PURE__ */ new Set(), verifyServeOrigin = false, verifiedLogin = null } = {}) {
      const hasForwardedFor = typeof (req && req.headers && req.headers["x-forwarded-for"]) === "string" && req.headers["x-forwarded-for"].length > 0;
      const proxiedViaServe = verifyServeOrigin && hasForwardedFor;
      if (!proxiedViaServe && isLocalhostAddr(req && req.socket && req.socket.remoteAddress)) {
        return { allowed: true, reason: "localhost" };
      }
      if (token) {
        const auth = req && req.headers && req.headers["authorization"];
        if (typeof auth === "string" && auth === `Bearer ${token}`) {
          return { allowed: true, reason: "token" };
        }
      }
      const dispatchFlag = req && req.headers && req.headers["x-ofc-dispatch"];
      if (dispatchFlag === "1") {
        const login = verifyServeOrigin ? typeof verifiedLogin === "string" && verifiedLogin ? verifiedLogin.toLowerCase() : "anonymous" : loginFromReq(req);
        if (login !== "anonymous" && meshLogins.has(login)) {
          return { allowed: true, reason: "mesh-peer" };
        }
      }
      return {
        allowed: false,
        reason: "node\u2192node action requires localhost, a mesh peer identity, or a dispatch token"
      };
    }
    module2.exports = {
      guardActionPost: guardActionPost2,
      isLocalhostAddr,
      loginFromReq,
      PRIVILEGED_POST_ACTIONS: PRIVILEGED_POST_ACTIONS2
    };
  }
});

// src/bulk.js
var require_bulk = __commonJS({
  "src/bulk.js"(exports2, module2) {
    var BULK_ACTIONS = Object.freeze([
      "kill-stale-sessions",
      "health-check",
      "gateway-status",
      "dispatch-task",
      "chat-broadcast"
    ]);
    var REMOTE_QUICK_ACTION = {
      "kill-stale-sessions": "clear-stale-sessions",
      "gateway-status": "gateway-status"
    };
    var MAX_TARGETS = 50;
    var REMOTE_TIMEOUT_MS = 1e4;
    var LOCAL_TARGETS = /* @__PURE__ */ new Set(["local", "self"]);
    function httpError(statusCode, message) {
      const err = new Error(message);
      err.statusCode = statusCode;
      return err;
    }
    function shortMessage(message) {
      return String(message || "failed").split("\n")[0].slice(0, 300);
    }
    function timeoutSignal(ms) {
      if (globalThis.AbortSignal && typeof globalThis.AbortSignal.timeout === "function") {
        return globalThis.AbortSignal.timeout(ms);
      }
      return void 0;
    }
    function nodeBaseUrl(node) {
      const url = String(node.url || "");
      const healthPath = typeof node.healthPath === "string" ? node.healthPath : "/health";
      return url.endsWith(healthPath) ? url.slice(0, -healthPath.length) : url;
    }
    function createBulk2(deps = {}) {
      const {
        mesh,
        chat,
        dispatch: dispatch2 = null,
        rosterFn = null,
        runAction,
        fetchFn = (...args2) => globalThis.fetch(...args2)
      } = deps;
      if (!mesh || typeof mesh.getState !== "function") {
        throw new Error("createBulk requires a mesh module");
      }
      if (!chat || typeof chat.publish !== "function") {
        throw new Error("createBulk requires a chat module");
      }
      if (typeof runAction !== "function") {
        throw new Error("createBulk requires a runAction function");
      }
      function findNode(nodes, target) {
        return nodes.find(
          (n) => n.id === target || n.hostname === target || `${n.hostname}:${n.port || 443}` === target
        ) || null;
      }
      async function fetchRemoteJson(url) {
        const res = await fetchFn(url, { signal: timeoutSignal(REMOTE_TIMEOUT_MS) });
        if (!res || res.ok !== true) {
          throw new Error(`HTTP ${res && res.status ? res.status : "error"} from ${url}`);
        }
        return res.json();
      }
      async function runNodeTarget(action, target, params, meshNodes) {
        if (LOCAL_TARGETS.has(target)) {
          if (action === "health-check") {
            const result2 = await runAction("health-check", {});
            return { ok: result2.success, detail: result2.output || result2.error || "" };
          }
          const result = await runAction(REMOTE_QUICK_ACTION[action], {
            staleMinutes: params.staleMinutes
          });
          return { ok: result.success, detail: result.output || result.error || "" };
        }
        const node = findNode(meshNodes, target);
        if (!node) throw new Error(`Unknown node: ${target}`);
        if (action === "health-check") {
          const startedAt = Date.now();
          const body2 = await fetchRemoteJson(node.url);
          const latencyMs = Date.now() - startedAt;
          const version = body2 && typeof body2.version === "string" ? ` v${body2.version}` : "";
          return { ok: true, detail: `healthy (${latencyMs} ms)${version}` };
        }
        const quickAction = REMOTE_QUICK_ACTION[action];
        const url = `${nodeBaseUrl(node)}/api/action?action=${encodeURIComponent(quickAction)}`;
        const body = await fetchRemoteJson(url);
        const ok = !!(body && body.success === true);
        const detail = body ? body.output || body.error || "" : "";
        return { ok, detail: String(detail).slice(0, 500) };
      }
      async function requireRosterAgent(agent) {
        if (typeof rosterFn !== "function") return;
        const [id, node] = String(agent).split("@");
        let roster;
        try {
          roster = await rosterFn();
        } catch (e) {
          throw new Error(`Agent roster unavailable: ${e.message}`);
        }
        const agents = Array.isArray(roster && roster.agents) ? roster.agents : [];
        if (!agents.some((a) => a && a.id === id && (!node || a.node === node))) {
          throw new Error(`Unknown agent '${agent}' \u2014 not in the local roster`);
        }
      }
      async function runDispatchTarget(agent, params, actor) {
        if (!dispatch2 || typeof dispatch2.dispatchTask !== "function") {
          throw new Error("Dispatch is not configured on this node");
        }
        await requireRosterAgent(agent);
        const result = dispatch2.dispatchTask(params.taskId, {
          agent,
          node: params.node,
          actor
        });
        return { ok: true, detail: `dispatched (session key: ${result.sessionKey})` };
      }
      function runChatTarget(receiver, params, actor) {
        const message = chat.publish({
          sender: typeof params.sender === "string" && params.sender ? params.sender : actor,
          receiver,
          payload: params.text
        });
        return { ok: true, detail: `published (${message.id})` };
      }
      function validateRequest({ action, targets, params }) {
        if (typeof action !== "string" || !BULK_ACTIONS.includes(action)) {
          throw httpError(
            400,
            `Unknown bulk action: ${String(action)}. Allowed: ${BULK_ACTIONS.join(", ")}`
          );
        }
        const list = targets === void 0 || targets === null ? [] : targets;
        if (!Array.isArray(list) || list.some((t) => typeof t !== "string" || t.trim().length === 0)) {
          throw httpError(400, "targets must be an array of non-empty strings");
        }
        if (list.length > MAX_TARGETS) {
          throw httpError(400, `Too many targets (max ${MAX_TARGETS})`);
        }
        const normalizedParams = params && typeof params === "object" ? params : {};
        let normalizedTargets = list.map((t) => t.trim());
        if (normalizedTargets.length === 0) {
          if (action === "dispatch-task") {
            throw httpError(400, "dispatch-task requires at least one agent target");
          }
          normalizedTargets = action === "chat-broadcast" ? ["all"] : ["local"];
        }
        if (action === "dispatch-task") {
          if (typeof normalizedParams.taskId !== "string" || !normalizedParams.taskId.trim()) {
            throw httpError(400, "dispatch-task requires params.taskId");
          }
        }
        if (action === "chat-broadcast") {
          if (typeof normalizedParams.text !== "string" || normalizedParams.text.trim().length === 0) {
            throw httpError(400, "chat-broadcast requires a non-empty params.text");
          }
        }
        return { action, targets: normalizedTargets, params: normalizedParams };
      }
      async function execute(request = {}) {
        const { action, targets, params } = validateRequest(request);
        const actor = typeof request.actor === "string" && request.actor ? request.actor : "anonymous";
        let meshNodes = [];
        if (action === "kill-stale-sessions" || action === "health-check" || action === "gateway-status") {
          const needsMesh = targets.some((t) => !LOCAL_TARGETS.has(t));
          if (needsMesh) {
            const state2 = await mesh.getState();
            meshNodes = Array.isArray(state2 && state2.nodes) ? state2.nodes : [];
          }
        }
        const results = await Promise.all(
          targets.map(async (target) => {
            try {
              let outcome;
              switch (action) {
                case "dispatch-task":
                  outcome = await runDispatchTarget(target, params, actor);
                  break;
                case "chat-broadcast":
                  outcome = runChatTarget(target, params, actor);
                  break;
                default:
                  outcome = await runNodeTarget(action, target, params, meshNodes);
              }
              return { target, ok: outcome.ok, detail: outcome.detail };
            } catch (e) {
              return { target, ok: false, detail: shortMessage(e.message) };
            }
          })
        );
        const okCount = results.filter((r) => r.ok).length;
        return { action, targets, results, okCount, failCount: results.length - okCount };
      }
      return { execute, BULK_ACTIONS };
    }
    module2.exports = { createBulk: createBulk2, BULK_ACTIONS, MAX_TARGETS };
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
    var os2 = require("os");
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
        runOpenClawAsync: runOpenClawAsync2,
        readTranscript
      } = deps;
      const openclawEnabled = deps.openclawEnabled !== false;
      const PATHS2 = CONFIG2.paths;
      let cachedState = null;
      let lastStateUpdate = 0;
      const STATE_CACHE_TTL = 3e4;
      let stateRefreshInterval = null;
      let gatewayStatusCache = { value: "Unknown", timestamp: 0, refreshing: false };
      const GATEWAY_STATUS_TTL = 6e4;
      function refreshGatewayStatus() {
        if (!openclawEnabled || !runOpenClawAsync2) return Promise.resolve();
        if (gatewayStatusCache.refreshing) return Promise.resolve();
        gatewayStatusCache.refreshing = true;
        return runOpenClawAsync2("gateway status 2>/dev/null").then((status) => {
          let value = "Unknown";
          if (status && status.includes("running")) value = "Running";
          else if (status && status.includes("stopped")) value = "Stopped";
          gatewayStatusCache = { value, timestamp: Date.now(), refreshing: false };
        }).catch(() => {
          gatewayStatusCache.refreshing = false;
        });
      }
      function getSystemStatus() {
        const hostname = os2.hostname();
        let uptime = "\u2014";
        try {
          const uptimeRaw = execFileSync("uptime", [], { encoding: "utf8", timeout: 1e3 });
          const match = uptimeRaw.match(/up\s+([^,]+)/);
          if (match) uptime = match[1].trim();
        } catch (e) {
        }
        if (Date.now() - gatewayStatusCache.timestamp > GATEWAY_STATUS_TTL) {
          refreshGatewayStatus();
        }
        return {
          hostname,
          gateway: gatewayStatusCache.value,
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
          const cached = getSessions({ limit: null }) || [];
          if (cached.length > 0) {
            for (const s of cached) {
              if ((s.minutesAgo ?? Infinity) >= 5) continue;
              if (s.sessionType === "subagent" || s.sessionType === "cron") {
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
        if (!openclawEnabled) return result;
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
          subagents = allSessions.filter((s) => s.sessionType === "subagent").filter((s) => (s.minutesAgo || 0) * 6e4 < retentionMs).map((s) => {
            const match = (s.sessionKey || "").match(/:subagent:([a-f0-9-]+)$/);
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
          const cached = getSessions({ limit: null }) || [];
          const subagentSessions = cached.filter((s) => s.sessionType === "subagent").map((s) => ({
            key: s.sessionKey,
            sessionId: s.sessionId,
            ageMs: (s.minutesAgo ?? Infinity) * 6e4,
            totalTokens: s.tokens || 0,
            model: s.model
          }));
          {
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

// src/mesh.js
var require_mesh = __commonJS({
  "src/mesh.js"(exports2, module2) {
    var path2 = require("path");
    var crypto = require("crypto");
    var { createTailscaleAdapter } = require_tailscale();
    var { createSafeStore } = require_state_safety();
    var REGISTRY_FILENAME = "mesh-nodes.json";
    var REGISTRY_BACKUP_DIRNAME = "mesh-nodes-backups";
    var DEFAULT_INTERVAL_MS = 15e3;
    var DEFAULT_HEALTH_TIMEOUT_MS = 5e3;
    var LATENCY_SAMPLE_LIMIT = 60;
    var STATE_REFRESH_EVERY_N_POLLS = 4;
    var VALID_PLATFORMS = ["linux", "windows-wsl", "macos", "unknown"];
    var HOSTNAME_PATTERN = /^[a-z0-9-]+$/;
    var MAX_LABEL_LENGTH = 120;
    var DEFAULT_NODE_PORT = 443;
    function instancePort(record) {
      const port = record ? record.port : void 0;
      return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_NODE_PORT;
    }
    function nodeInstanceKey(record) {
      return `${record.hostname}:${instancePort(record)}`;
    }
    function isSameInstance(a, b) {
      if (!a || typeof a !== "object" || !b || typeof b !== "object") return false;
      return a.hostname === b.hostname && instancePort(a) === instancePort(b);
    }
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
    function validateRegistry(obj) {
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        return {
          valid: false,
          errors: [{ path: "", reason: "registry must be a non-array object" }]
        };
      }
      if (!Array.isArray(obj.nodes)) {
        return {
          valid: false,
          errors: [{ path: "nodes", reason: "nodes must be an array" }]
        };
      }
      const errors = [];
      for (let i = 0; i < obj.nodes.length; i++) {
        const n = obj.nodes[i];
        if (!n || typeof n !== "object") {
          errors.push({ path: `nodes[${i}]`, reason: "must be an object" });
          continue;
        }
        if (typeof n.id !== "string" || n.id.length === 0) {
          errors.push({ path: `nodes[${i}].id`, reason: "id must be a non-empty string" });
        }
        if (typeof n.hostname !== "string" || n.hostname.length === 0) {
          errors.push({ path: `nodes[${i}].hostname`, reason: "hostname must be a non-empty string" });
        }
      }
      return errors.length > 0 ? { valid: false, errors } : { valid: true, errors: [] };
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
        onHealth = null,
        nowFn = Date.now,
        seed = [],
        selfHostname = ""
      } = options;
      if (!stateDir || typeof stateDir !== "string") {
        throw new Error("createMesh requires a stateDir string");
      }
      const registryFile = path2.join(stateDir, REGISTRY_FILENAME);
      const registryBackupDir = path2.join(stateDir, REGISTRY_BACKUP_DIRNAME);
      const registryStore = createSafeStore({
        filePath: registryFile,
        validate: validateRegistry,
        backupDir: registryBackupDir,
        createDefault: () => ({ nodes: [] })
      });
      function loadRegistry() {
        const { data, restored, quarantinedPath } = registryStore.read();
        if (restored) {
          console.warn(`[Mesh] Registry was corrupt; auto-restored. Quarantined: ${quarantinedPath}`);
        }
        if (!data || !Array.isArray(data.nodes)) return [];
        return data.nodes.filter((n) => n && typeof n === "object" && typeof n.hostname === "string");
      }
      function saveRegistry() {
        registryStore.write({ nodes });
      }
      let nodes = loadRegistry();
      const health = {};
      const nodeStats = {};
      let pollTimer = null;
      let pollCycle = 0;
      function seedRegistry(seedList, self) {
        if (!Array.isArray(seedList) || seedList.length === 0) return;
        let changed = false;
        for (const raw of seedList) {
          let validated;
          try {
            validated = validateNodeInput({ ...raw, registeredBy: "seed" });
          } catch (e) {
            console.warn(`[Mesh] Skipping invalid seed entry: ${e.message}`);
            continue;
          }
          if (self && validated.hostname === self) continue;
          const existing = nodes.find((n) => isSameInstance(n, validated));
          if (existing) {
            if (existing.healthPath !== validated.healthPath || existing.label !== validated.label || existing.platform !== validated.platform) {
              const updated = {
                ...existing,
                healthPath: validated.healthPath,
                label: validated.label,
                platform: validated.platform
              };
              nodes = nodes.map((n) => n.id === existing.id ? updated : n);
              changed = true;
            }
            continue;
          }
          nodes = [
            ...nodes,
            {
              id: crypto.randomUUID(),
              ...validated,
              registeredAt: new Date(nowFn()).toISOString()
            }
          ];
          changed = true;
        }
        if (changed) saveRegistry();
      }
      seedRegistry(seed, selfHostname);
      function registerNode(input) {
        const validated = validateNodeInput(input);
        if (nodes.some((n) => isSameInstance(n, validated))) {
          throw new Error(`Node already registered: ${nodeInstanceKey(validated)}`);
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
        const target = nodes.find(
          (n) => n.id === idOrHostname || nodeInstanceKey(n) === idOrHostname || n.hostname === idOrHostname
        );
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
        if (typeof onHealth === "function") {
          try {
            onHealth({ node, previousStatus: prev.status, status: next.status, health: next });
          } catch (e) {
            console.error("[Mesh] onHealth callback failed:", e.message);
          }
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
      validateRegistry,
      nodeInstanceKey,
      isSameInstance,
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
    var MAX_DETAIL_NODES = 24;
    var MAX_DETAIL_TASKS = 120;
    var MAX_DETAIL_ALERTS = 10;
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
    function pickString(value) {
      return typeof value === "string" && value.length > 0 ? value : null;
    }
    function extractRemoteMeshDetail(body) {
      if (!body || typeof body !== "object" || !Array.isArray(body.nodes)) return null;
      const nodes = body.nodes.filter((n) => n && typeof n === "object").slice(0, MAX_DETAIL_NODES).map((n) => {
        const health = n.health && typeof n.health === "object" ? n.health : {};
        const vitals = n.vitals && typeof n.vitals === "object" ? n.vitals : null;
        return {
          id: pickString(n.id),
          hostname: pickString(n.hostname),
          label: pickString(n.label),
          port: pickNumber(n.port),
          status: pickString(health.status) || "unknown",
          latencyMs: pickNumber(health.latencyMs),
          version: pickString(health.version),
          vitals: vitals ? {
            cpuPct: pickNumber(vitals.cpu?.percent),
            memPct: pickNumber(vitals.memory?.pct),
            diskPct: pickNumber(vitals.disk?.pct),
            uptime: typeof vitals.uptime === "string" || typeof vitals.uptime === "number" ? vitals.uptime : null
          } : null
        };
      });
      return { nodes };
    }
    function extractRemoteBoardDetail(body) {
      if (!body || typeof body !== "object" || !Array.isArray(body.tasks)) return null;
      const counts = {};
      for (const status of KANBAN_STATUSES) counts[status] = 0;
      const tasks = [];
      for (const task of body.tasks) {
        if (!task || typeof task !== "object") continue;
        if (typeof task.id !== "string" || typeof task.title !== "string") continue;
        if (!KANBAN_STATUSES.includes(task.status)) continue;
        counts[task.status] += 1;
        tasks.push({
          id: task.id,
          title: task.title,
          status: task.status,
          assignee: pickString(task.assignee),
          priority: pickNumber(task.priority),
          order: pickNumber(task.order) ?? 0,
          updated_at: pickString(task.updated_at),
          stale: task.stale === true
        });
      }
      tasks.sort(
        (a, b) => KANBAN_STATUSES.indexOf(a.status) - KANBAN_STATUSES.indexOf(b.status) || a.order - b.order
      );
      return { counts, tasks: tasks.slice(0, MAX_DETAIL_TASKS) };
    }
    function extractRemoteAlertsDetail(body) {
      if (!body || typeof body !== "object" || !Array.isArray(body.alerts)) return null;
      const alerts = body.alerts.filter((a) => a && typeof a === "object").slice(0, MAX_DETAIL_ALERTS).map((a) => ({
        ts: pickNumber(a.ts) ?? pickString(a.ts),
        type: pickString(a.type),
        severity: pickString(a.severity),
        node: pickString(a.node),
        message: pickString(a.message)
      }));
      return { alerts };
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
      const details = {};
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
        delete details[target.id];
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
      async function fetchRemoteJson(remote, urlPath, headers) {
        try {
          const res = await fetchFn(`${remote.baseUrl}${urlPath}`, {
            headers,
            signal: timeoutSignal(timeoutMs)
          });
          if (!res || res.ok !== true) return null;
          return await res.json();
        } catch (e) {
          return null;
        }
      }
      async function refreshRemoteDetail(remote, headers) {
        const [meshBody, kanbanBody, alertsBody] = await Promise.all([
          fetchRemoteJson(remote, "/api/fleet/mesh", headers),
          fetchRemoteJson(remote, "/api/fleet/kanban", headers),
          fetchRemoteJson(remote, `/api/fleet/alerts?limit=${MAX_DETAIL_ALERTS}`, headers)
        ]);
        const prev = details[remote.id] || null;
        const mesh = extractRemoteMeshDetail(meshBody) ?? (prev ? prev.mesh : null);
        const kanban = extractRemoteBoardDetail(kanbanBody) ?? (prev ? prev.kanban : null);
        const alerts = extractRemoteAlertsDetail(alertsBody) ?? (prev ? prev.alerts : null);
        if (!mesh && !kanban && !alerts) return;
        if (!remotes.some((r) => r.id === remote.id)) return;
        details[remote.id] = { mesh, kanban, alerts, fetchedAt: nowFn() };
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
            const [pendingLessons] = await Promise.all([
              fetchPendingLessons(remote, headers),
              refreshRemoteDetail(remote, headers)
            ]);
            next = {
              reachable: true,
              lastChecked: startedAt,
              lastError: null,
              latencyMs,
              summary,
              pendingLessons
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
      function getRemoteDetail(remoteId) {
        const remote = remotes.find((r) => r.id === remoteId);
        if (!remote) {
          throw new Error(`Unknown remote: ${remoteId}`);
        }
        return {
          remote: redactRemote(remote),
          status: statuses[remote.id] || createInitialStatus(),
          detail: details[remote.id] || null
        };
      }
      function getBoardSources() {
        return remotes.map((remote) => {
          const status = statuses[remote.id];
          return {
            remote: redactRemote(remote),
            reachable: status ? status.reachable : null,
            detail: details[remote.id] || null
          };
        });
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
        getRemoteDetail,
        getBoardSources,
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
      extractRemoteMeshDetail,
      extractRemoteBoardDetail,
      extractRemoteAlertsDetail,
      KANBAN_STATUSES,
      MAX_DETAIL_NODES,
      MAX_DETAIL_TASKS,
      MAX_DETAIL_ALERTS,
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
    var RESULT_TEXT_MAX_BYTES = 16 * 1024;
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
      "note",
      "result_text"
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
      if (attempt.result_text !== void 0 && attempt.result_text !== null && (typeof attempt.result_text !== "string" || byteLength(attempt.result_text) > RESULT_TEXT_MAX_BYTES)) {
        errors.push({
          path: `${basePath}.result_text`,
          reason: `result_text must be null or a string of at most ${RESULT_TEXT_MAX_BYTES} bytes`
        });
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
          note: attempt.note ?? null,
          result_text: attempt.result_text ?? null
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
      function updateAttempt(id, index, patch = {}) {
        const board = readBoard();
        const current = requireTask(board, id);
        if (!Number.isInteger(index) || index < 0 || index >= current.attempts.length) {
          throw new Error(`updateAttempt: no attempt at index ${index}`);
        }
        const allowed = ["ended_at", "result", "branch", "note", "result_text"];
        const clean = {};
        for (const [key, value] of Object.entries(patch)) {
          if (!allowed.includes(key)) throw new Error(`updateAttempt: '${key}' cannot be patched`);
          if (value !== void 0) clean[key] = value;
        }
        const attempt = { ...current.attempts[index], ...clean };
        const updated = {
          ...current,
          attempts: current.attempts.map((a, i) => i === index ? attempt : a),
          updated_at: nowIso()
        };
        store.write(withTask(board, updated));
        emit("attempt.updated", { taskId: id, actor: attempt.agent, task: updated, attempt, index });
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
        updateAttempt,
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
      "memory.write",
      "session.kill",
      "cron.update",
      "cron.run",
      "org.update",
      "settings.update",
      "chat.publish",
      "topic.status",
      "operator.save",
      "action.execute",
      "alert.test",
      "cache.clear",
      "job.run",
      "job.update",
      "service.restart",
      "digest.test",
      "budgets.ack"
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
    var os2 = require("os");
    var path2 = require("path");
    var { createRequire } = require("node:module");
    var CLI_TIMEOUT_MS = 6e4;
    var CLI_WRITE_TIMEOUT_MS = 12e4;
    var EXPORT_FORMAT_VERSION = "1.0";
    var DEFAULT_SEARCH_LIMIT = 10;
    var DEFAULT_LIST_LIMIT = 20;
    var METADATA_SOURCE = "open-fleet-control-cortex";
    var EDITABLE_FIELDS = ["text", "category", "scope", "importance"];
    function defaultExecFn(cmd, args2, options = {}) {
      return new Promise((resolve) => {
        let execFile2;
        try {
          execFile2 = require("child_process").execFile;
        } catch (e) {
          resolve({ error: e, stdout: "", stderr: "" });
          return;
        }
        const { getSafeEnv: getSafeEnv2 } = require_openclaw();
        execFile2(
          cmd,
          args2,
          {
            encoding: "utf8",
            timeout: options.timeoutMs || CLI_TIMEOUT_MS,
            maxBuffer: 32 * 1024 * 1024,
            env: getSafeEnv2()
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
    function validateUpdateChanges(changes) {
      if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
        return { error: "update changes must be an object" };
      }
      const fields = {};
      for (const key of EDITABLE_FIELDS) {
        if (changes[key] !== void 0) fields[key] = changes[key];
      }
      if (Object.keys(fields).length === 0) {
        return { error: `update requires at least one editable field (${EDITABLE_FIELDS.join(", ")})` };
      }
      if (fields.text !== void 0 && (typeof fields.text !== "string" || fields.text.trim() === "")) {
        return { error: "memory text must be a non-empty string" };
      }
      for (const key of ["category", "scope"]) {
        if (fields[key] !== void 0 && (typeof fields[key] !== "string" || fields[key].trim() === "")) {
          return { error: `memory ${key} must be a non-empty string` };
        }
      }
      if (fields.importance !== void 0) {
        const value = Number(fields.importance);
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          return { error: "memory importance must be a number between 0 and 1" };
        }
        fields.importance = value;
      }
      return { fields };
    }
    function buildUpdatedMetadata(currentMetadata) {
      const base = currentMetadata && typeof currentMetadata === "object" && !Array.isArray(currentMetadata) ? { ...currentMetadata } : currentMetadata !== null && currentMetadata !== void 0 ? { legacyMetadata: currentMetadata } : {};
      return JSON.stringify({
        ...base,
        updatedBy: METADATA_SOURCE,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
    function toExportRecord(item) {
      return {
        id: item.id,
        text: item.text,
        category: item.category || "fact",
        scope: item.scope || "global",
        importance: item.importance ?? 0.7,
        timestamp: item.timestamp ?? Date.now(),
        metadata: typeof item.metadata === "string" ? item.metadata : JSON.stringify(item.metadata ?? {})
      };
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
      const dbPath = options.dbPath || path2.join(os2.homedir(), ".openclaw", "memory", "lancedb-pro");
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
      async function importViaCli(memories, scope) {
        const payload = {
          version: EXPORT_FORMAT_VERSION,
          exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
          count: memories.length,
          filters: {},
          memories
        };
        const tmpFile = path2.join(
          os2.tmpdir(),
          `cortex-import-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
        );
        try {
          fs2.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), "utf8");
          const args2 = ["memory-pro", "import", tmpFile];
          if (scope) args2.push("--scope", String(scope));
          const res = await execFn(cliCommand, args2, { timeoutMs: CLI_WRITE_TIMEOUT_MS });
          if (res.error) {
            return { error: `memory-pro import failed: ${res.error.message || res.error}` };
          }
          return { ok: true };
        } catch (e) {
          return { error: `import failed: ${e.message}` };
        } finally {
          try {
            fs2.unlinkSync(tmpFile);
          } catch (e) {
          }
        }
      }
      async function deleteViaCli(id, scope) {
        const args2 = ["memory-pro", "delete", id];
        if (scope) args2.push("--scope", String(scope));
        const res = await execFn(cliCommand, args2, { timeoutMs: CLI_WRITE_TIMEOUT_MS });
        if (res.error) {
          return { error: `memory-pro delete failed: ${res.error.message || res.error}` };
        }
        return { ok: true };
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
          metadata: JSON.stringify({ source: METADATA_SOURCE })
        };
        const imported = await importViaCli([memory], scope);
        if (imported.error) return { error: imported.error };
        return { ok: true, id: memory.id };
      }
      async function update(id, changes = {}) {
        if (!id || typeof id !== "string") {
          return { error: "memory id must be a non-empty string" };
        }
        const validated = validateUpdateChanges(changes);
        if (validated.error) return { error: validated.error };
        const { fields } = validated;
        const existing = await get(id);
        if (existing.error) return { error: existing.error };
        const current = existing.item;
        const updated = {
          ...toExportRecord(current),
          ...fields.text !== void 0 ? { text: fields.text } : {},
          ...fields.category !== void 0 ? { category: fields.category } : {},
          ...fields.scope !== void 0 ? { scope: fields.scope } : {},
          ...fields.importance !== void 0 ? { importance: fields.importance } : {},
          metadata: buildUpdatedMetadata(current.metadata)
        };
        const deleted = await deleteViaCli(id, current.scope || null);
        if (deleted.error) return { error: `update failed (delete step): ${deleted.error}` };
        const imported = await importViaCli([updated], updated.scope);
        if (imported.error) {
          const restored = await importViaCli([toExportRecord(current)], current.scope || null);
          if (restored.error) {
            return {
              error: `update failed (import step): ${imported.error}; ROLLBACK FAILED \u2014 original memory may be lost: ${restored.error}`
            };
          }
          return { error: `update failed (import step): ${imported.error}; original memory restored` };
        }
        return { ok: true, id, item: { ...updated, metadata: parseMetadata(updated.metadata) } };
      }
      async function remove(id) {
        if (!id || typeof id !== "string") {
          return { error: "memory id must be a non-empty string" };
        }
        let scope = null;
        let confirmedExists = false;
        const existing = await get(id);
        if (existing.item) {
          scope = existing.item.scope || null;
          confirmedExists = true;
        } else if (existing.error && existing.error.startsWith("memory not found")) {
          return { error: existing.error };
        }
        const deleted = await deleteViaCli(id, scope);
        if (deleted.error) return { error: deleted.error };
        if (confirmedExists) {
          const check = await get(id);
          if (check.item) {
            return { error: `delete did not take effect: memory ${id} is still present` };
          }
        }
        return { ok: true, id };
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
      return { available, search, list, get, store, update, remove, stats };
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
    var os2 = require("os");
    var path2 = require("path");
    var CLI_TIMEOUT_MS = 15e3;
    var DEFAULT_GRAPH_LIMIT = 200;
    function defaultExecFn(cmd, args2, options = {}) {
      return new Promise((resolve) => {
        let execFile2;
        try {
          execFile2 = require("child_process").execFile;
        } catch (e) {
          resolve({ error: e, stdout: "", stderr: "" });
          return;
        }
        const { getSafeEnv: getSafeEnv2 } = require_openclaw();
        execFile2(
          cmd,
          args2,
          {
            encoding: "utf8",
            timeout: options.timeoutMs || CLI_TIMEOUT_MS,
            maxBuffer: 16 * 1024 * 1024,
            env: getSafeEnv2()
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
    function parseStatsText(text) {
      if (!text || typeof text !== "string") return null;
      const grab = (label) => {
        const match = text.match(new RegExp(`^${label}:\\s*(\\d+)\\s*$`, "mi"));
        return match ? Number(match[1]) : null;
      };
      const pages = grab("Pages");
      if (pages === null) return null;
      return {
        pages,
        chunks: grab("Chunks"),
        embedded: grab("Embedded"),
        links: grab("Links"),
        tags: grab("Tags")
      };
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
      const cliPath = options.cliPath || path2.join(os2.homedir(), "gbrain", "bin", "gbrain");
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
        const provenance = {
          totalPages: nodes.length,
          dbLinks: null,
          lastUpdated: pages.find((p) => p && p.updated_at)?.updated_at ?? null
        };
        const statsRes = await runCli(["stats"]);
        if (!statsRes.error) {
          const stats = parseStatsText(statsRes.stdout) ?? parseStatsText(statsRes.stderr);
          if (stats) {
            if (Number.isFinite(stats.pages)) provenance.totalPages = stats.pages;
            if (Number.isFinite(stats.links)) provenance.dbLinks = stats.links;
          }
        }
        const graph = { nodes, edges, provenance };
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
    module2.exports = {
      createGbrain,
      parseJsonOutput,
      parseTsvPages,
      parseExtractLinks,
      parseStatsText
    };
  }
});

// src/cortex-gauges.js
var require_cortex_gauges = __commonJS({
  "src/cortex-gauges.js"(exports2, module2) {
    var fs2 = require("fs");
    var os2 = require("os");
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
    var LCM_STALE_DAYS = 7;
    function parseSqliteUtc(value) {
      if (typeof value !== "string" || !value.trim()) return null;
      const normalized = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value) ? `${value.replace(" ", "T")}Z` : value;
      const ms = Date.parse(normalized);
      return Number.isFinite(ms) ? ms : null;
    }
    function createGauges(options = {}) {
      const home = options.home || os2.homedir();
      const defaults = {
        headroom: path2.join(home, ".headroom", "subscription_state.json"),
        leanCtx: path2.join(home, ".lean-ctx", "stats.json"),
        lcmDb: path2.join(home, ".openclaw", "lcm.db"),
        openclawConfig: path2.join(home, ".openclaw", "openclaw.json")
      };
      const overrides = {};
      for (const [key, value] of Object.entries(options.paths || {})) {
        if (typeof value === "string" && value.trim() !== "") overrides[key] = value;
      }
      const paths = { ...defaults, ...overrides };
      const sqliteLoader = options.sqliteLoader || defaultSqliteLoader;
      const now = options.now || Date.now;
      function headroomGauge() {
        const label = "Headroom (subscription window)";
        try {
          if (!fs2.existsSync(paths.headroom)) {
            return unavailableGauge("headroom", label, `file not found: ${paths.headroom}`);
          }
          const data = readJsonFile(paths.headroom);
          const window = data.window_tokens || null;
          const latest = data.latest || null;
          if (!window && !latest) {
            const gauge = unavailableGauge(
              "headroom",
              label,
              `headroom state has no poll data yet (latest/window_tokens are null in ${paths.headroom})`
            );
            gauge.detail.stale = true;
            gauge.detail.lastError = data.last_error ?? null;
            try {
              gauge.detail.fileModifiedAt = fs2.statSync(paths.headroom).mtime.toISOString();
            } catch (e) {
              gauge.detail.fileModifiedAt = null;
            }
            return gauge;
          }
          const w = window || {};
          const rawTokens = Number(w.total_raw) || Number(w.input || 0) + Number(w.output || 0) + Number(w.cache_reads || 0) + Number(w.cache_writes_total || 0);
          const effectiveTokens = Number(w.weighted_token_equivalent ?? rawTokens) || 0;
          const extra = latest?.extra_usage;
          const extraEnabled = !!(extra && extra.is_enabled);
          return {
            source: "headroom",
            label,
            rawTokens,
            effectiveTokens,
            savingsPct: computeSavingsPct(rawTokens, effectiveTokens),
            detail: {
              input: w.input ?? 0,
              output: w.output ?? 0,
              cacheReads: w.cache_reads ?? 0,
              cacheWritesTotal: w.cache_writes_total ?? 0,
              fiveHourUtilizationPct: latest?.five_hour?.utilization_pct ?? null,
              fiveHourResetsAt: latest?.five_hour?.resets_at ?? null,
              sevenDayUtilizationPct: latest?.seven_day?.utilization_pct ?? null,
              sevenDayResetsAt: latest?.seven_day?.resets_at ?? null,
              extraUsageUsd: extraEnabled ? extra.used_credits_usd ?? null : null,
              extraUsageLimitUsd: extraEnabled ? extra.monthly_limit_usd ?? null : null,
              polledAt: latest?.polled_at ?? null
            },
            available: true
          };
        } catch (e) {
          return unavailableGauge("headroom", label, e.message);
        }
      }
      function topLeanCtxCommands(commands) {
        if (!commands || typeof commands !== "object") return [];
        return Object.entries(commands).map(([command, stats]) => ({
          command,
          count: Number(stats?.count) || 0,
          tokens: Number(stats?.output_tokens) || 0
        })).sort((a, b) => b.tokens - a.tokens).slice(0, 5);
      }
      function leanCtxGauge() {
        const label = "lean-ctx (command output compression)";
        try {
          if (!fs2.existsSync(paths.leanCtx)) {
            return unavailableGauge("lean-ctx", label, `file not found: ${paths.leanCtx}`);
          }
          const data = readJsonFile(paths.leanCtx);
          const tokensProcessed = Number(data.total_output_tokens) || 0;
          const baseDetail = {
            totalCommands: data.total_commands ?? 0,
            tokensProcessed,
            topCommands: topLeanCtxCommands(data.commands),
            firstUse: data.first_use ?? null,
            lastUse: data.last_use ?? null,
            daysTracked: Array.isArray(data.daily) ? data.daily.length : 0
          };
          const cep = data.cep && typeof data.cep === "object" ? data.cep : {};
          const cepOriginal = Number(cep.total_tokens_original) || 0;
          if (cepOriginal > 0) {
            const cepCompressed = Number(cep.total_tokens_compressed) || 0;
            return {
              source: "lean-ctx",
              label,
              rawTokens: cepOriginal,
              effectiveTokens: cepCompressed,
              savingsPct: computeSavingsPct(cepOriginal, cepCompressed),
              detail: { ...baseDetail, savingsSource: "cep" },
              available: true
            };
          }
          return {
            source: "lean-ctx",
            label,
            rawTokens: tokensProcessed,
            effectiveTokens: tokensProcessed,
            savingsPct: null,
            detail: {
              ...baseDetail,
              note: "savings not derivable: stats.json does not record pre-compression sizes"
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
              detail.lastActivity = null;
              detail.stale = null;
              detail.staleDays = null;
              if (columns.includes("created_at")) {
                const activity = db.prepare("SELECT MAX(created_at) AS last FROM summaries").get();
                detail.lastActivity = activity?.last ?? null;
                const lastMs = parseSqliteUtc(detail.lastActivity);
                if (lastMs !== null) {
                  const days = Math.floor((now() - lastMs) / 864e5);
                  detail.staleDays = days;
                  detail.stale = days >= LCM_STALE_DAYS;
                }
              }
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
      function getContextEngine() {
        try {
          if (!fs2.existsSync(paths.openclawConfig)) {
            return {
              engine: null,
              source: null,
              reason: `openclaw config not found: ${paths.openclawConfig}`
            };
          }
          const data = readJsonFile(paths.openclawConfig);
          const engine = data?.plugins?.slots?.contextEngine;
          if (typeof engine !== "string" || !engine.trim()) {
            return {
              engine: null,
              source: null,
              reason: `no contextEngine slot configured in ${paths.openclawConfig}`
            };
          }
          return { engine, source: "plugins.slots.contextEngine", reason: null };
        } catch (e) {
          return { engine: null, source: null, reason: e.message };
        }
      }
      return { getGauges, getContextEngine };
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
      let stateCache = { value: null, timestamp: 0 };
      let stateInFlight = null;
      const STATE_TTL_MS = 12e4;
      function collect() {
        if (!stateInFlight) {
          stateInFlight = collectState().then((value) => {
            stateCache = { value, timestamp: Date.now() };
            return value;
          }).finally(() => {
            stateInFlight = null;
          });
        }
        return stateInFlight;
      }
      function warmingState() {
        return {
          warming: true,
          timestamp: Date.now(),
          memory: { available: false, cli: false, lancedb: false, reason: null, stats: null },
          gbrain: { available: false, reason: null },
          gauges: [],
          gaugeSummary: summarizeGauges([]),
          contextEngine: { engine: null, source: null, reason: "warming" }
        };
      }
      async function getState() {
        const age = Date.now() - stateCache.timestamp;
        if (stateCache.value && age < STATE_TTL_MS) return stateCache.value;
        collect().catch(() => {
        });
        if (stateCache.value) return stateCache.value;
        return warmingState();
      }
      function warmup() {
        return collect();
      }
      async function collectState() {
        const state2 = {
          timestamp: Date.now(),
          memory: { available: false, cli: false, lancedb: false, reason: null, stats: null },
          gbrain: { available: false, reason: null },
          gauges: [],
          gaugeSummary: summarizeGauges([]),
          contextEngine: { engine: null, source: null, reason: null }
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
        try {
          state2.contextEngine = gauges.getContextEngine();
        } catch (e) {
          state2.contextEngine = { engine: null, source: null, reason: e.message };
        }
        return state2;
      }
      return {
        // Sub-adapters (for callers that need full access)
        memory,
        gbrain,
        gauges,
        // Unified state
        getState,
        warmup,
        // Memory passthroughs
        searchMemory: (query, opts) => memory.search(query, opts),
        listMemory: (opts) => memory.list(opts),
        getMemory: (id) => memory.get(id),
        storeMemory: (text, opts) => memory.store(text, opts),
        updateMemory: (id, changes) => memory.update(id, changes),
        deleteMemory: (id) => memory.remove(id),
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

// src/alerts-history.js
var require_alerts_history = __commonJS({
  "src/alerts-history.js"(exports2, module2) {
    var crypto = require("crypto");
    var fs2 = require("fs");
    var path2 = require("path");
    var ACTIVE_LOG = "alerts.jsonl";
    var ROTATED_RE = /^alerts\..+\.jsonl$/;
    var DEFAULT_MAX_LOG_BYTES = 20 * 1024 * 1024;
    var DEFAULT_MAX_ROTATED_FILES = 5;
    var DEFAULT_QUERY_LIMIT = 200;
    var MAX_QUERY_LIMIT = 500;
    var SEVERITIES = /* @__PURE__ */ new Set(["info", "warn", "critical"]);
    var DAY_MS = 24 * 60 * 60 * 1e3;
    var ANALYTICS_DEFAULT_DAYS = 14;
    var ANALYTICS_MAX_DAYS = 90;
    var ANALYTICS_TOP_LIMIT = 10;
    var ANALYTICS_FLAP_LIMIT = 20;
    var NODE_DOWN_RULES = /* @__PURE__ */ new Set(["nodeOffline", "nodeUnreachable"]);
    function toEpochMs(value) {
      let ms;
      if (value instanceof Date) {
        ms = value.getTime();
      } else if (typeof value === "number") {
        ms = value;
      } else if (typeof value === "string") {
        ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
      } else {
        throw new Error("Invalid since: expected ISO string, Date, or epoch milliseconds");
      }
      if (!Number.isFinite(ms)) {
        throw new Error("Invalid since: could not parse as a timestamp");
      }
      return ms;
    }
    function clampAnalyticsDays(days) {
      return Number.isInteger(days) && days >= 1 && days <= ANALYTICS_MAX_DAYS ? days : ANALYTICS_DEFAULT_DAYS;
    }
    function utcDayKey(ts) {
      return new Date(ts).toISOString().slice(0, 10);
    }
    function topCounts(counts, keyName, limit) {
      return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, limit).map(([key, count]) => ({ [keyName]: key, count }));
    }
    function countFlapCycles(entries) {
      const ordered = [...entries].sort((a, b) => a.ts - b.ts);
      const pendingRuleByNode = /* @__PURE__ */ new Map();
      const cycles = /* @__PURE__ */ new Map();
      for (const rec of ordered) {
        if (typeof rec.node !== "string" || rec.node.length === 0) continue;
        if (NODE_DOWN_RULES.has(rec.type)) {
          pendingRuleByNode.set(rec.node, rec.type);
        } else if (rec.type === "nodeRecovered" && pendingRuleByNode.has(rec.node)) {
          const key = `${pendingRuleByNode.get(rec.node)}|${rec.node}`;
          cycles.set(key, (cycles.get(key) || 0) + 1);
          pendingRuleByNode.delete(rec.node);
        }
      }
      return [...cycles.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, ANALYTICS_FLAP_LIMIT).map(([key, count]) => {
        const [rule, ...nodeParts] = key.split("|");
        return { rule, node: nodeParts.join("|"), cycles: count };
      });
    }
    function computeAlertAnalytics(entries, { now = Date.now(), days = ANALYTICS_DEFAULT_DAYS } = {}) {
      const windowDays = clampAnalyticsDays(days);
      const reference = Number.isFinite(now) ? now : Date.now();
      const todayStart = Math.floor(reference / DAY_MS) * DAY_MS;
      const since = todayStart - (windowDays - 1) * DAY_MS;
      const perDayByKey = /* @__PURE__ */ new Map();
      for (let i = 0; i < windowDays; i++) {
        const dayStart = since + i * DAY_MS;
        perDayByKey.set(utcDayKey(dayStart), {
          date: utcDayKey(dayStart),
          total: 0,
          critical: 0,
          warn: 0,
          info: 0
        });
      }
      const inWindow = [];
      const nodeCounts = /* @__PURE__ */ new Map();
      const ruleCounts = /* @__PURE__ */ new Map();
      for (const rec of Array.isArray(entries) ? entries : []) {
        if (!rec || typeof rec !== "object") continue;
        if (!Number.isFinite(rec.ts) || rec.ts < since || rec.ts > reference) continue;
        inWindow.push(rec);
        const bucket = perDayByKey.get(utcDayKey(rec.ts));
        if (bucket) {
          bucket.total += 1;
          const severity = SEVERITIES.has(rec.severity) ? rec.severity : "info";
          bucket[severity] += 1;
        }
        if (typeof rec.node === "string" && rec.node.length > 0) {
          nodeCounts.set(rec.node, (nodeCounts.get(rec.node) || 0) + 1);
        }
        if (typeof rec.type === "string" && rec.type.length > 0) {
          ruleCounts.set(rec.type, (ruleCounts.get(rec.type) || 0) + 1);
        }
      }
      return {
        days: windowDays,
        since,
        total: inWindow.length,
        perDay: [...perDayByKey.values()],
        flaps: countFlapCycles(inWindow),
        topNodes: topCounts(nodeCounts, "node", ANALYTICS_TOP_LIMIT),
        topRules: topCounts(ruleCounts, "type", ANALYTICS_TOP_LIMIT)
      };
    }
    function createAlertHistory({
      logsDir,
      maxBytes = DEFAULT_MAX_LOG_BYTES,
      keepFiles = DEFAULT_MAX_ROTATED_FILES
    } = {}) {
      if (typeof logsDir !== "string" || logsDir.length === 0) {
        throw new Error("createAlertHistory requires a logsDir option");
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
        if (size < maxBytes) return;
        const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
        let rotatedPath = path2.join(logsDir, `alerts.${stamp}.jsonl`);
        if (fs2.existsSync(rotatedPath)) {
          rotatedPath = path2.join(
            logsDir,
            `alerts.${stamp}-${crypto.randomBytes(3).toString("hex")}.jsonl`
          );
        }
        fs2.renameSync(activePath, rotatedPath);
        const rotated = listRotatedFiles();
        const excess = rotated.length - keepFiles;
        for (let i = 0; i < excess; i++) {
          try {
            fs2.unlinkSync(path2.join(logsDir, rotated[i]));
          } catch (e) {
            console.error("[AlertHistory] Failed to prune rotated log:", rotated[i], e.message);
          }
        }
      }
      function append(alert) {
        try {
          fs2.mkdirSync(logsDir, { recursive: true });
          rotateIfNeeded();
          fs2.appendFileSync(activePath, JSON.stringify(alert) + "\n", "utf8");
        } catch (e) {
          console.error("[AlertHistory] Append failed:", e.message);
        }
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
            if (parsed && typeof parsed === "object" && parsed.type && Number.isFinite(parsed.ts)) {
              entries.push(parsed);
            }
          } catch (e) {
          }
        }
        return entries;
      }
      function query({ type, node, severity, since, limit = DEFAULT_QUERY_LIMIT } = {}) {
        const parsedLimit = Number(limit);
        if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
          throw new Error("Query limit must be a positive number");
        }
        const cap = Math.min(Math.floor(parsedLimit), MAX_QUERY_LIMIT);
        const sinceMs = since === void 0 || since === null || since === "" ? null : toEpochMs(since);
        if (severity !== void 0 && severity !== null && !SEVERITIES.has(severity)) {
          throw new Error(`Invalid severity filter "${String(severity)}"`);
        }
        const matches = (rec) => {
          if (type && rec.type !== type) return false;
          if (node && rec.node !== node) return false;
          if (severity && rec.severity !== severity) return false;
          if (sinceMs !== null && rec.ts < sinceMs) return false;
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
        return results.sort((a, b) => b.ts - a.ts);
      }
      function analytics(options = {}) {
        const entries = [];
        for (const filePath of [activePath, ...listRotatedFiles().map((f) => path2.join(logsDir, f))]) {
          entries.push(...readEntries(filePath));
        }
        return computeAlertAnalytics(entries, options);
      }
      return { append, query, analytics };
    }
    module2.exports = { createAlertHistory, computeAlertAnalytics, MAX_QUERY_LIMIT };
  }
});

// src/alerts.js
var require_alerts = __commonJS({
  "src/alerts.js"(exports2, module2) {
    var crypto = require("crypto");
    var { createAlertHistory, computeAlertAnalytics } = require_alerts_history();
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
    function isTestDeliveryContext() {
      return Boolean(process.env.NODE_TEST_CONTEXT) || process.env.OFC_DISABLE_ALERT_DELIVERY === "1";
    }
    function muteUntilMs(until) {
      if (until === void 0 || until === null || until === "") return null;
      const ms = typeof until === "number" ? until : Date.parse(until);
      return Number.isFinite(ms) ? ms : null;
    }
    function parseSinceMs(since) {
      if (since === void 0 || since === null || since === "") return null;
      if (typeof since === "number") return Number.isFinite(since) ? since : null;
      const text = String(since);
      const ms = /^\d+$/.test(text) ? Number(text) : Date.parse(text);
      return Number.isFinite(ms) ? ms : null;
    }
    function matchesMute(mutes, alert, now) {
      if (!Array.isArray(mutes)) return false;
      for (const mute of mutes) {
        if (!mute || typeof mute !== "object") continue;
        const hasRule = typeof mute.rule === "string" && mute.rule.length > 0;
        const hasNode = typeof mute.node === "string" && mute.node.length > 0;
        if (!hasRule && !hasNode) continue;
        const untilMs = muteUntilMs(mute.until);
        if (untilMs !== null && now >= untilMs) continue;
        if (hasRule && mute.rule !== alert.type) continue;
        if (hasNode && mute.node !== alert.node) continue;
        return true;
      }
      return false;
    }
    function sinkRoutesForType(routing, type) {
      if (!routing || typeof routing !== "object" || Array.isArray(routing)) return null;
      const entry = routing[type];
      if (!Array.isArray(entry) || entry.includes("*")) return null;
      return new Set(entry.filter((sink) => typeof sink === "string"));
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
        id: `alr_${crypto.randomBytes(6).toString("hex")}`,
        type: event.type,
        severity,
        node: event.node != null ? String(event.node) : null,
        task: event.task != null ? String(event.task) : null,
        message: event.message != null ? String(event.message) : "",
        ts: Number.isFinite(event.ts) ? event.ts : nowFn()
      };
    }
    function createSinkDispatcher({
      fetchFn = globalThis.fetch,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      retryDelayMs = DEFAULT_RETRY_DELAY_MS
    } = {}) {
      if (typeof fetchFn !== "function") {
        throw new TypeError("fetchFn must be a function");
      }
      const suppressed = isTestDeliveryContext() && fetchFn === globalThis.fetch;
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
      async function dispatch2(sinks, alert, routedTo = () => true) {
        if (suppressed) {
          return { dispatched: 0, delivered: 0, suppressed: true };
        }
        const effective = sinks && typeof sinks === "object" ? sinks : {};
        const dispatches = [];
        if (routedTo("webhooks")) {
          for (const webhook of Array.isArray(effective.webhooks) ? effective.webhooks : []) {
            if (webhook && webhook.url && webhookMatchesEvent(webhook, alert.type)) {
              dispatches.push(dispatchToWebhook(webhook, alert));
            }
          }
        }
        if (routedTo("slack") && effective.slack && effective.slack.enabled && effective.slack.gatewayUrl) {
          dispatches.push(dispatchToSlack(effective.slack, alert));
        }
        if (routedTo("ntfy") && effective.ntfy && effective.ntfy.enabled && effective.ntfy.topic) {
          dispatches.push(dispatchToNtfy(effective.ntfy, alert));
        }
        const results = await Promise.allSettled(dispatches);
        const delivered = results.filter((r) => r.status === "fulfilled" && r.value === true).length;
        return { dispatched: dispatches.length, delivered, suppressed: false };
      }
      return { dispatch: dispatch2, suppressed };
    }
    function createAlerts({
      config = {},
      logsDir = null,
      fetchFn = globalThis.fetch,
      nowFn = Date.now,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      retryDelayMs = DEFAULT_RETRY_DELAY_MS,
      historyMaxBytes = void 0,
      historyKeepFiles = void 0
    } = {}) {
      const dispatcher = createSinkDispatcher({ fetchFn, timeoutMs, retryDelayMs });
      const history = typeof logsDir === "string" && logsDir.length > 0 ? createAlertHistory({
        logsDir,
        ...historyMaxBytes !== void 0 ? { maxBytes: historyMaxBytes } : {},
        ...historyKeepFiles !== void 0 ? { keepFiles: historyKeepFiles } : {}
      }) : null;
      const dedupeLastFired = /* @__PURE__ */ new Map();
      let recentAlerts = [];
      let mutedCount = 0;
      function sweepDedupe(now) {
        if (dedupeLastFired.size < DEDUPE_SWEEP_THRESHOLD) return;
        for (const [key, ts] of dedupeLastFired) {
          if (now - ts >= DEDUPE_WINDOW_MS) {
            dedupeLastFired.delete(key);
          }
        }
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
        if (matchesMute(config.mutes, alert, now)) {
          mutedCount++;
          return { fired: false, reason: "muted" };
        }
        sweepDedupe(now);
        const dedupeKey = `${alert.type}:${alert.node || ""}:${alert.task || ""}`;
        const lastFired = dedupeLastFired.get(dedupeKey);
        if (lastFired !== void 0 && now - lastFired < DEDUPE_WINDOW_MS) {
          return { fired: false, reason: "deduped" };
        }
        dedupeLastFired.set(dedupeKey, now);
        recentAlerts = [...recentAlerts, alert].slice(-RING_BUFFER_SIZE);
        if (history) history.append(alert);
        if (dispatcher.suppressed) {
          console.log(`[Alerts] ${alert.type} delivery suppressed (test mode)`);
          return { fired: true, dispatched: 0, delivered: 0, suppressed: true };
        }
        const routes = sinkRoutesForType(config.routing, alert.type);
        const routedTo = (sinkName) => routes === null || routes.has(sinkName);
        const result = await dispatcher.dispatch(config.sinks || {}, alert, routedTo);
        return { fired: true, dispatched: result.dispatched, delivered: result.delivered };
      }
      function getRecent(limit = DEFAULT_RECENT_LIMIT, filters = {}) {
        const parsed = Number(limit);
        const effective = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_RECENT_LIMIT;
        const { type, node, severity, since } = filters || {};
        const sinceMs = parseSinceMs(since);
        const matched = recentAlerts.filter((alert) => {
          if (type && alert.type !== type) return false;
          if (node && alert.node !== node) return false;
          if (severity && alert.severity !== severity) return false;
          if (sinceMs !== null && alert.ts < sinceMs) return false;
          return true;
        });
        return matched.slice(-effective).reverse();
      }
      function query(filters = {}) {
        if (!history) return [];
        return history.query(filters);
      }
      function getMutedCount() {
        return mutedCount;
      }
      function analytics(options = {}) {
        if (!history) return computeAlertAnalytics([], options);
        return history.analytics(options);
      }
      return { fire, getRecent, query, getMutedCount, analytics };
    }
    var FLAP_DEFAULT_CONSECUTIVE = 3;
    var FLAP_DEFAULT_MIN_DURATION_MS = 6e4;
    function normalizeFlapConfig(flap) {
      const src = flap && typeof flap === "object" && !Array.isArray(flap) ? flap : {};
      return {
        consecutive: Number.isInteger(src.consecutive) && src.consecutive >= 1 ? src.consecutive : FLAP_DEFAULT_CONSECUTIVE,
        minDurationMs: Number.isFinite(src.minDurationMs) && src.minDurationMs >= 0 ? src.minDurationMs : FLAP_DEFAULT_MIN_DURATION_MS
      };
    }
    function createNodeAlertTracker({ flap, fire, nowFn = Date.now } = {}) {
      if (typeof fire !== "function") {
        throw new TypeError("createNodeAlertTracker requires a fire function");
      }
      let cfg = normalizeFlapConfig(flap);
      const states = /* @__PURE__ */ new Map();
      function setFlapConfig(flapConfig) {
        cfg = normalizeFlapConfig(flapConfig);
      }
      function observe(node, status, health = {}) {
        const key = node && (node.id || node.hostname);
        if (!key) return null;
        const now = nowFn();
        const prev = states.get(key) || { failingSince: null, alerted: false };
        if (status === "online") {
          let event2 = null;
          if (prev.alerted) {
            event2 = {
              type: "nodeRecovered",
              severity: "info",
              node: node.hostname,
              message: `Node ${node.hostname} recovered (back online)`
            };
            fire(event2);
          }
          states.set(key, { failingSince: null, alerted: false });
          return event2;
        }
        if (status !== "offline" && status !== "unreachable") return null;
        const failingSince = prev.failingSince === null ? now : prev.failingSince;
        const streak = Number.isInteger(health.consecutiveFailures) ? health.consecutiveFailures : 1;
        let event = null;
        let alerted = prev.alerted;
        if (!alerted && streak >= cfg.consecutive && now - failingSince >= cfg.minDurationMs) {
          alerted = true;
          event = status === "offline" ? {
            type: "nodeOffline",
            severity: "critical",
            node: node.hostname,
            message: `Node ${node.hostname} is offline (${streak} consecutive failed checks)`
          } : {
            type: "nodeUnreachable",
            severity: "warn",
            node: node.hostname,
            message: `Node ${node.hostname} is unreachable (${streak} consecutive failed checks)`
          };
          fire(event);
        }
        states.set(key, { failingSince, alerted });
        return event;
      }
      return { observe, setFlapConfig };
    }
    module2.exports = {
      createAlerts,
      createNodeAlertTracker,
      createSinkDispatcher,
      normalizeFlapConfig
    };
  }
});

// src/rate-limit.js
var require_rate_limit = __commonJS({
  "src/rate-limit.js"(exports2, module2) {
    var DEFAULT_WINDOW_MS = 6e4;
    var DEFAULT_MAX = 120;
    var STALE_WINDOW_MULTIPLIER = 2;
    function createRateLimiter2({
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
    module2.exports = { createRateLimiter: createRateLimiter2 };
  }
});

// src/budgets.js
var require_budgets = __commonJS({
  "src/budgets.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var DEFAULT_CHECK_INTERVAL_MS = 9e5;
    var WARN_RATIO = 0.8;
    var CRITICAL_RATIO = 1;
    var DAY_MS = 864e5;
    function normalizePeriod(raw) {
      const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      const perProvider = {};
      if (src.perProvider && typeof src.perProvider === "object" && !Array.isArray(src.perProvider)) {
        for (const [provider, value] of Object.entries(src.perProvider)) {
          const usd = Number(value);
          if (provider.length > 0 && Number.isFinite(usd) && usd > 0) perProvider[provider] = usd;
        }
      }
      const totalUSD = Number(src.totalUSD);
      return {
        totalUSD: Number.isFinite(totalUSD) && totalUSD > 0 ? totalUSD : 0,
        perProvider
      };
    }
    function normalizeBudgetsConfig(raw) {
      const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      const closedCeilingUSD = Number(src.closedCeilingUSD);
      return {
        enabled: src.enabled === true,
        daily: normalizePeriod(src.daily),
        weekly: normalizePeriod(src.weekly),
        checkIntervalMs: Number.isInteger(src.checkIntervalMs) && src.checkIntervalMs >= 6e4 ? src.checkIntervalMs : DEFAULT_CHECK_INTERVAL_MS,
        enforce: {
          enabled: Boolean(
            src.enforce && typeof src.enforce === "object" && src.enforce.enabled === true
          )
        },
        // Orchestration mode gate (src/orchestrate.js + the orchestrate route).
        // OPEN mode is OFF unless explicitly opted in — burns unbounded tokens.
        allowOpen: src.allowOpen === true,
        // Default per-orchestration CLOSED ceiling (USD). 0 / absent = no
        // per-orchestration ceiling (the fleet daily/weekly ceilings still apply).
        closedCeilingUSD: Number.isFinite(closedCeilingUSD) && closedCeilingUSD > 0 ? closedCeilingUSD : 0
      };
    }
    function dailyKey(ms) {
      return new Date(ms).toISOString().slice(0, 10);
    }
    function weeklyKey(ms) {
      const date = new Date(ms);
      const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
      const dayOfWeek = target.getUTCDay() || 7;
      target.setUTCDate(target.getUTCDate() + 4 - dayOfWeek);
      const isoYear = target.getUTCFullYear();
      const yearStart = new Date(Date.UTC(isoYear, 0, 1));
      const week = Math.ceil(((target - yearStart) / DAY_MS + 1) / 7);
      return `${isoYear}-W${String(week).padStart(2, "0")}`;
    }
    function periodStartMs(period, ms) {
      const date = new Date(ms);
      const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
      if (period === "daily") return dayStart;
      const dayOfWeek = new Date(dayStart).getUTCDay() || 7;
      return dayStart - (dayOfWeek - 1) * DAY_MS;
    }
    function periodKey(period, ms) {
      return period === "daily" ? dailyKey(ms) : weeklyKey(ms);
    }
    function round2(value) {
      return Math.round(value * 100) / 100;
    }
    function round1(value) {
      return Math.round(value * 10) / 10;
    }
    function scopeStatus(scope, limitUSD, spentUSD) {
      const ratio = limitUSD > 0 ? spentUSD / limitUSD : 0;
      return {
        scope,
        limitUSD,
        spentUSD: round2(spentUSD),
        percent: round1(ratio * 100),
        state: ratio >= CRITICAL_RATIO ? "critical" : ratio >= WARN_RATIO ? "warn" : "ok"
      };
    }
    function createBudgets({
      getUsage,
      onBreach,
      config,
      stateFile = null,
      nowFn = Date.now,
      log = console
    } = {}) {
      if (typeof getUsage !== "function") throw new TypeError("createBudgets requires getUsage");
      if (typeof onBreach !== "function") throw new TypeError("createBudgets requires onBreach");
      let cfg = normalizeBudgetsConfig(config);
      let timer = null;
      let evaluating = null;
      let warnedNoProvider = false;
      let lastCheck = null;
      let lastSpend = null;
      let blocked = {};
      let state2 = loadState();
      function loadState() {
        const empty = { fired: {}, openrouterBaseline: {}, acks: {} };
        if (!stateFile) return empty;
        try {
          if (!fs2.existsSync(stateFile)) return empty;
          const raw = JSON.parse(fs2.readFileSync(stateFile, "utf8"));
          return {
            fired: raw && typeof raw.fired === "object" && raw.fired !== null ? raw.fired : {},
            openrouterBaseline: raw && typeof raw.openrouterBaseline === "object" && raw.openrouterBaseline !== null ? raw.openrouterBaseline : {},
            acks: raw && typeof raw.acks === "object" && raw.acks !== null ? raw.acks : {}
          };
        } catch (e) {
          log.warn(`[Budgets] Failed to read state file ${stateFile}: ${e.message}`);
          return empty;
        }
      }
      function saveState() {
        if (!stateFile) return;
        try {
          fs2.mkdirSync(path2.dirname(stateFile), { recursive: true });
          const tmpFile = `${stateFile}.tmp-${process.pid}`;
          fs2.writeFileSync(tmpFile, `${JSON.stringify(state2, null, 2)}
`);
          fs2.renameSync(tmpFile, stateFile);
        } catch (e) {
          log.warn(`[Budgets] Failed to persist state to ${stateFile}: ${e.message}`);
        }
      }
      function pruneState(currentKeys) {
        let changed = false;
        const next = {};
        for (const [key, value] of Object.entries(state2.fired)) {
          const [period, pKey] = key.split(":");
          if (currentKeys[period] === pKey) next[key] = value;
          else changed = true;
        }
        const nextAcks = {};
        for (const [key, value] of Object.entries(state2.acks)) {
          const [period, pKey] = key.split(":");
          if (currentKeys[period] === pKey) nextAcks[key] = value;
          else changed = true;
        }
        for (const period of Object.keys(state2.openrouterBaseline)) {
          const baseline = state2.openrouterBaseline[period];
          if (!baseline || baseline.periodKey !== currentKeys[period]) {
            delete state2.openrouterBaseline[period];
            changed = true;
          }
        }
        if (changed) state2 = { ...state2, fired: next, acks: nextAcks };
        return changed;
      }
      function computeSpend(usage, period, key) {
        const byProvider = {};
        let hasApiSignal = false;
        if (usage.nineRouterByProvider && typeof usage.nineRouterByProvider === "object") {
          hasApiSignal = true;
          for (const [provider, value] of Object.entries(usage.nineRouterByProvider)) {
            const usd = Number(value);
            if (Number.isFinite(usd)) byProvider[provider] = (byProvider[provider] || 0) + usd;
          }
        }
        if (Number.isFinite(usage.openrouterCumulativeUSD)) {
          hasApiSignal = true;
          const cumulative = usage.openrouterCumulativeUSD;
          const baseline = state2.openrouterBaseline[period];
          if (!baseline || baseline.periodKey !== key || baseline.value > cumulative) {
            state2.openrouterBaseline = {
              ...state2.openrouterBaseline,
              [period]: { periodKey: key, value: cumulative }
            };
            byProvider.openrouter = 0;
          } else {
            byProvider.openrouter = round2(cumulative - baseline.value);
          }
        }
        if (Number.isFinite(usage.claudeCodeUSD)) {
          byProvider["claude-code"] = usage.claudeCodeUSD;
        }
        let totalUSD = 0;
        for (const [provider, usd] of Object.entries(byProvider)) {
          if (provider !== "claude-code") totalUSD += usd;
        }
        if (!hasApiSignal && Number.isFinite(usage.tokensEstUSD)) {
          totalUSD = usage.tokensEstUSD;
        }
        return { byProvider, totalUSD: round2(totalUSD) };
      }
      function recordBlockState(period, key, scope, limitUSD, spentUSD) {
        const blockKey = `${period}:${key}:${scope}`;
        if (limitUSD > 0 && spentUSD / limitUSD >= CRITICAL_RATIO) {
          blocked = {
            ...blocked,
            [blockKey]: { period, periodKey: key, scope, limitUSD, spentUSD: round2(spentUSD) }
          };
        } else if (blocked[blockKey]) {
          const rest = { ...blocked };
          delete rest[blockKey];
          blocked = rest;
        }
      }
      function currentBlocks(now) {
        const currentKeys = { daily: dailyKey(now), weekly: weeklyKey(now) };
        return Object.values(blocked).filter((entry) => currentKeys[entry.period] === entry.periodKey);
      }
      function checkDispatchBlock() {
        if (!cfg.enabled || !cfg.enforce.enabled) return null;
        const now = nowFn();
        for (const entry of currentBlocks(now)) {
          if (state2.acks[`${entry.period}:${entry.periodKey}`]) continue;
          return {
            scope: entry.scope,
            spent: entry.spentUSD,
            limit: entry.limitUSD,
            period: entry.period,
            periodKey: entry.periodKey
          };
        }
        return null;
      }
      function ack(user = "anonymous") {
        const now = nowFn();
        const acked = [];
        for (const entry of currentBlocks(now)) {
          const ackKey = `${entry.period}:${entry.periodKey}`;
          if (acked.includes(ackKey)) continue;
          acked.push(ackKey);
          if (!state2.acks[ackKey]) {
            state2 = { ...state2, acks: { ...state2.acks, [ackKey]: { by: user, ts: now } } };
          }
        }
        if (acked.length > 0) saveState();
        return { acked };
      }
      function checkOrchestrationBlock({
        mode = "closed",
        ceiling,
        spentUSD = 0,
        projectedUSD = 0
      } = {}) {
        const m = mode === "open" ? "open" : "closed";
        if (m === "open") {
          if (!cfg.allowOpen) {
            return {
              reason: "open-mode-disabled",
              mode: "open",
              message: "OPEN mode requires unlimited-budget opt-in (fleet.budgets.allowOpen=true)."
            };
          }
          return null;
        }
        const cap = Number.isFinite(ceiling) && ceiling > 0 ? ceiling : cfg.closedCeilingUSD;
        if (cap > 0) {
          const spent = Number(spentUSD) || 0;
          const projected = Number(projectedUSD) || 0;
          const worst = Math.max(spent, spent + projected);
          if (worst >= cap) {
            return {
              reason: "closed-ceiling-exceeded",
              mode: "closed",
              ceiling: round2(cap),
              spent: round2(spent),
              projected: round2(projected),
              message: `CLOSED orchestration halted: projected spend $${round2(worst)} reaches the $${round2(cap)} per-task ceiling.`
            };
          }
        }
        return null;
      }
      function firedKey(period, key, scope, severity) {
        return `${period}:${key}:${scope}:${severity}`;
      }
      function checkScope(period, key, scope, budgetUSD, actualUSD, now) {
        const ratio = budgetUSD > 0 ? actualUSD / budgetUSD : 0;
        const severity = ratio >= CRITICAL_RATIO ? "critical" : ratio >= WARN_RATIO ? "warn" : null;
        if (!severity) return false;
        const sevKey = firedKey(period, key, scope, severity);
        if (state2.fired[sevKey]) return false;
        const record = { ts: now, budgetUSD, actualUSD: round2(actualUSD) };
        const fired = { ...state2.fired, [sevKey]: record };
        const warnKey = firedKey(period, key, scope, "warn");
        if (severity === "critical" && !fired[warnKey]) fired[warnKey] = record;
        state2 = { ...state2, fired };
        try {
          onBreach({
            period,
            periodKey: key,
            scope,
            severity,
            budgetUSD,
            actualUSD: round2(actualUSD),
            ratio: Math.round(ratio * 1e3) / 1e3
          });
        } catch (e) {
          log.error(`[Budgets] onBreach callback failed: ${e.message}`);
        }
        return true;
      }
      async function evaluateOnce() {
        if (!cfg.enabled) return { checked: false, reason: "disabled" };
        const now = nowFn();
        const currentKeys = { daily: dailyKey(now), weekly: weeklyKey(now) };
        let dirty = pruneState(currentKeys);
        const spendByPeriod = {};
        for (const period of ["daily", "weekly"]) {
          const periodCfg = cfg[period];
          const providerScopes = Object.entries(periodCfg.perProvider);
          if (periodCfg.totalUSD <= 0 && providerScopes.length === 0) continue;
          let usage;
          try {
            usage = await getUsage({ sinceMs: periodStartMs(period, now), period });
          } catch (e) {
            log.error(`[Budgets] getUsage failed (${period}): ${e.message}`);
            continue;
          }
          if (!usage || typeof usage !== "object") {
            if (!warnedNoProvider) {
              warnedNoProvider = true;
              log.warn("[Budgets] No usage provider wired yet \u2014 budget checks are skipped");
            }
            continue;
          }
          const key = periodKey(period, now);
          const spend = computeSpend(usage, period, key);
          spendByPeriod[period] = spend;
          dirty = true;
          if (periodCfg.totalUSD > 0) {
            checkScope(period, key, "total", periodCfg.totalUSD, spend.totalUSD, now);
            recordBlockState(period, key, "total", periodCfg.totalUSD, spend.totalUSD);
          }
          for (const [provider, budgetUSD] of providerScopes) {
            const actual = Number(spend.byProvider[provider]) || 0;
            checkScope(period, key, `provider:${provider}`, budgetUSD, actual, now);
            recordBlockState(period, key, `provider:${provider}`, budgetUSD, actual);
          }
        }
        if (dirty) saveState();
        lastCheck = now;
        lastSpend = spendByPeriod;
        return { checked: true, spend: spendByPeriod };
      }
      function evaluate() {
        if (evaluating) return evaluating;
        evaluating = evaluateOnce().catch((e) => {
          log.error(`[Budgets] Evaluation failed: ${e.message}`);
          return { checked: false, reason: e.message };
        }).finally(() => {
          evaluating = null;
        });
        return evaluating;
      }
      function start() {
        if (timer || !cfg.enabled) return;
        evaluate();
        timer = setInterval(evaluate, cfg.checkIntervalMs);
        if (typeof timer.unref === "function") timer.unref();
      }
      function stop() {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      }
      function applyConfig(newConfig) {
        stop();
        cfg = normalizeBudgetsConfig(newConfig);
        if (cfg.enabled) start();
      }
      async function getStatus() {
        if (!cfg.enabled) return { enabled: false };
        const now = nowFn();
        const periods = {};
        for (const period of ["daily", "weekly"]) {
          const periodCfg = cfg[period];
          const providerScopes = Object.entries(periodCfg.perProvider);
          if (periodCfg.totalUSD <= 0 && providerScopes.length === 0) continue;
          const startMs = periodStartMs(period, now);
          const lengthMs = period === "daily" ? DAY_MS : 7 * DAY_MS;
          const elapsedPct = round1(Math.min(100, Math.max(0, (now - startMs) / lengthMs * 100)));
          let usage = null;
          try {
            usage = await getUsage({ sinceMs: startMs, period });
          } catch (e) {
            log.error(`[Budgets] getUsage failed for status (${period}): ${e.message}`);
          }
          const usageAvailable = Boolean(usage && typeof usage === "object");
          const key = periodKey(period, now);
          const spend = usageAvailable ? computeSpend(usage, period, key) : { byProvider: {}, totalUSD: 0 };
          const scopes = [];
          if (periodCfg.totalUSD > 0) {
            scopes.push(scopeStatus("total", periodCfg.totalUSD, spend.totalUSD));
            if (usageAvailable)
              recordBlockState(period, key, "total", periodCfg.totalUSD, spend.totalUSD);
          }
          for (const [provider, limitUSD] of providerScopes) {
            const actual = Number(spend.byProvider[provider]) || 0;
            scopes.push(scopeStatus(`provider:${provider}`, limitUSD, actual));
            if (usageAvailable) recordBlockState(period, key, `provider:${provider}`, limitUSD, actual);
          }
          periods[period] = { periodKey: key, elapsedPct, usageAvailable, scopes };
        }
        if (Object.keys(periods).length === 0) return { enabled: false };
        return {
          enabled: true,
          generatedAt: now,
          periods,
          enforcement: {
            enabled: cfg.enforce.enabled,
            blocked: currentBlocks(now).map((entry) => ({
              period: entry.period,
              periodKey: entry.periodKey,
              scope: entry.scope,
              limitUSD: entry.limitUSD,
              spentUSD: entry.spentUSD,
              acked: Boolean(state2.acks[`${entry.period}:${entry.periodKey}`])
            })),
            acks: Object.entries(state2.acks).map(([window, value]) => ({
              window,
              by: value.by || "anonymous",
              ts: value.ts || null
            }))
          }
        };
      }
      function getState() {
        return {
          enabled: cfg.enabled,
          checkIntervalMs: cfg.checkIntervalMs,
          enforceEnabled: cfg.enforce.enabled,
          lastCheck,
          lastSpend,
          firedCount: Object.keys(state2.fired).length,
          blockedCount: Object.keys(blocked).length,
          ackCount: Object.keys(state2.acks).length
        };
      }
      return {
        start,
        stop,
        evaluate,
        applyConfig,
        getState,
        getStatus,
        checkDispatchBlock,
        checkOrchestrationBlock,
        ack
      };
    }
    function createUsageProvider2({ usageSources: usageSources2 }) {
      if (!usageSources2 || !usageSources2.sources) {
        throw new TypeError("createUsageProvider requires a usageSources instance");
      }
      const { nineRouter, openrouter, claudeCode } = usageSources2.sources;
      return async function getUsage({ sinceMs, period }) {
        const out = {};
        try {
          if (nineRouter && nineRouter.describe().available) {
            const usage = await nineRouter.getUsage({ sinceMs });
            if (usage && Array.isArray(usage.byProvider)) {
              out.nineRouterByProvider = {};
              for (const row of usage.byProvider) {
                if (row && typeof row.provider === "string") {
                  out.nineRouterByProvider[row.provider] = Number(row.cost) || 0;
                }
              }
            }
          }
        } catch (e) {
          console.error("[Budgets] nine-router usage read failed:", e.message);
        }
        try {
          if (openrouter && openrouter.available) {
            const credits = await openrouter.getCredits();
            if (credits && Number.isFinite(credits.totalUsage)) {
              out.openrouterCumulativeUSD = credits.totalUsage;
            }
          }
        } catch (e) {
          console.error("[Budgets] openrouter usage read failed:", e.message);
        }
        try {
          if (claudeCode && claudeCode.describe().available) {
            const windows = await claudeCode.getUsageWindows();
            if (windows && windows.available) {
              const bucket = period === "weekly" ? windows.d7 : windows.h24;
              if (bucket && Number.isFinite(bucket.estCost)) {
                out.claudeCodeUSD = bucket.estCost;
                out.tokensEstUSD = bucket.estCost;
              }
            }
          }
        } catch (e) {
          console.error("[Budgets] claude-code usage read failed:", e.message);
        }
        return out;
      };
    }
    module2.exports = {
      createBudgets,
      createUsageProvider: createUsageProvider2,
      normalizeBudgetsConfig,
      // exported for tests
      dailyKey,
      weeklyKey,
      periodStartMs
    };
  }
});

// src/digest.js
var require_digest = __commonJS({
  "src/digest.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var TICK_MS = 6e4;
    var HOUR_MS = 36e5;
    var DAY_MS = 864e5;
    var WEEK_MS = 7 * DAY_MS;
    var DEFAULT_HOUR_UTC = 8;
    var SINK_NAMES = ["slack", "ntfy", "webhooks"];
    var FAILED_STATUS_RE = /error|fail/i;
    var MAX_TOP_CONSUMERS = 5;
    var MAX_LIST_NAMES = 6;
    var ALERT_HISTORY_SCAN = 500;
    function isPlainObject(value) {
      return value !== null && typeof value === "object" && !Array.isArray(value);
    }
    function normalizeDigestConfig(raw) {
      const src = isPlainObject(raw) ? raw : {};
      let sinks = Array.isArray(src.sinks) ? src.sinks.filter((sink) => sink === "*" || SINK_NAMES.includes(sink)) : ["*"];
      if (sinks.length === 0 || sinks.includes("*")) sinks = ["*"];
      return {
        enabled: src.enabled === true,
        schedule: src.schedule === "weekly" ? "weekly" : "daily",
        hourUtc: Number.isInteger(src.hourUtc) && src.hourUtc >= 0 && src.hourUtc <= 23 ? src.hourUtc : DEFAULT_HOUR_UTC,
        sinks
      };
    }
    function lastScheduledOccurrence(cfg, nowMs) {
      const date = new Date(nowMs);
      const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
      if (cfg.schedule === "weekly") {
        const dayOfWeek = new Date(dayStart).getUTCDay() || 7;
        let occurrence2 = dayStart - (dayOfWeek - 1) * DAY_MS + cfg.hourUtc * HOUR_MS;
        if (occurrence2 > nowMs) occurrence2 -= WEEK_MS;
        return occurrence2;
      }
      let occurrence = dayStart + cfg.hourUtc * HOUR_MS;
      if (occurrence > nowMs) occurrence -= DAY_MS;
      return occurrence;
    }
    function fmtUsd(value) {
      return `$${(Number(value) || 0).toFixed(2)}`;
    }
    function fmtUtc(ms) {
      return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    }
    function fmtTokens(value) {
      const n = Number(value) || 0;
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
      if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
      return String(n);
    }
    function nameList(names) {
      if (names.length <= MAX_LIST_NAMES) return names.join(", ");
      return `${names.slice(0, MAX_LIST_NAMES).join(", ")} +${names.length - MAX_LIST_NAMES} more`;
    }
    function composeBudgetLines(status) {
      if (!status || status.enabled !== true) return ["- budgets disabled"];
      const lines = [];
      for (const [period, data] of Object.entries(status.periods || {})) {
        if (!data) continue;
        if (data.usageAvailable === false) {
          lines.push(`- ${period}: usage data unavailable (spend source not wired)`);
          continue;
        }
        for (const scope of Array.isArray(data.scopes) ? data.scopes : []) {
          const marker = scope.state === "critical" ? " \u26D4" : scope.state === "warn" ? " \u26A0" : "";
          lines.push(
            `- ${period} ${scope.scope}: ${fmtUsd(scope.spentUSD)} / ${fmtUsd(scope.limitUSD)} (${scope.percent}%)${marker}`
          );
        }
      }
      if (status.enforcement && status.enforcement.enabled && status.enforcement.blocked.length > 0) {
        const scopes = status.enforcement.blocked.map((b) => `${b.period} ${b.scope}`);
        lines.push(`- dispatch blocking ACTIVE: ${nameList(scopes)}`);
      }
      return lines.length > 0 ? lines : ["- no budget scopes configured"];
    }
    function composeKanbanLines(board, sinceMs) {
      const tasks = Array.isArray(board && board.tasks) ? board.tasks : [];
      let done = 0;
      let failed = 0;
      let stuck = 0;
      for (const task of tasks) {
        if (task.stale === true) stuck++;
        const updatedMs = Date.parse(task.updated_at);
        if (!Number.isFinite(updatedMs) || updatedMs < sinceMs) continue;
        if (task.status === "done") done++;
        else if (task.status === "failed") failed++;
      }
      return [`- done: ${done} \xB7 failed: ${failed} \xB7 stuck: ${stuck} (of ${tasks.length} cards)`];
    }
    function composeCronLines(jobs) {
      if (!Array.isArray(jobs)) return ["- cron data unavailable"];
      if (jobs.length === 0) return ["- no cron jobs registered"];
      const failing = jobs.filter(
        (job) => job && typeof job.lastStatus === "string" && FAILED_STATUS_RE.test(job.lastStatus)
      );
      if (failing.length === 0) return [`- all green (${jobs.length} jobs)`];
      return failing.map(
        (job) => `- FAILING: ${job.name || job.id || "unnamed"} (last status: ${job.lastStatus})`
      );
    }
    function composeMeshLines(meshState, alertRows) {
      const lines = [];
      const nodes = Array.isArray(meshState && meshState.nodes) ? meshState.nodes : [];
      const downNow = nodes.filter(
        (n) => n.health && (n.health.status === "offline" || n.health.status === "unreachable")
      );
      if (nodes.length === 0) {
        lines.push("- no nodes registered");
      } else if (downNow.length === 0) {
        lines.push(`- all ${nodes.length} nodes online`);
      } else {
        lines.push(`- down now: ${nameList(downNow.map((n) => `${n.hostname} (${n.health.status})`))}`);
      }
      const rows = Array.isArray(alertRows) ? alertRows : [];
      const counts = { nodeOffline: 0, nodeUnreachable: 0, nodeRecovered: 0 };
      for (const row of rows) {
        if (row && counts[row.type] !== void 0) counts[row.type]++;
      }
      const total = counts.nodeOffline + counts.nodeUnreachable + counts.nodeRecovered;
      if (total > 0) {
        const flapped = counts.nodeRecovered > 0 && counts.nodeOffline + counts.nodeUnreachable > 0;
        lines.push(
          `- events since last digest: ${counts.nodeOffline} offline, ${counts.nodeUnreachable} unreachable, ${counts.nodeRecovered} recovered` + (flapped ? " (flapping)" : "")
        );
      }
      return lines;
    }
    function composeLessonLines(evolutionState) {
      const pending = Array.isArray(evolutionState && evolutionState.pending) ? evolutionState.pending : [];
      if (pending.length === 0) return ["- no lessons pending"];
      return [`- ${pending.length} pending approval: ${nameList(pending.map((p) => p.title || p.id))}`];
    }
    function composeConsumerLines(consumers) {
      if (!Array.isArray(consumers)) return ["- usage sources unavailable"];
      if (consumers.length === 0) return ["- no token usage recorded"];
      return consumers.slice(0, MAX_TOP_CONSUMERS).map((c) => {
        const parts = [];
        if (Number.isFinite(c.costUSD)) parts.push(fmtUsd(c.costUSD));
        if (Number.isFinite(c.tokens)) parts.push(`${fmtTokens(c.tokens)} tok`);
        if (Number.isFinite(c.requests)) parts.push(`${c.requests} req`);
        return `- ${c.label}: ${parts.join(" \xB7 ") || "n/a"}`;
      });
    }
    function createDigest({
      config,
      stateFile = null,
      sources = {},
      deliver,
      nowFn = Date.now,
      log = console
    } = {}) {
      if (typeof deliver !== "function") throw new TypeError("createDigest requires deliver");
      let cfg = normalizeDigestConfig(config);
      let timer = null;
      let sending = null;
      let state2 = loadState();
      function loadState() {
        const empty = { lastSentAt: null };
        if (!stateFile) return empty;
        try {
          if (!fs2.existsSync(stateFile)) return empty;
          const raw = JSON.parse(fs2.readFileSync(stateFile, "utf8"));
          return {
            lastSentAt: Number.isFinite(raw && raw.lastSentAt) ? raw.lastSentAt : null
          };
        } catch (e) {
          log.warn(`[Digest] Failed to read state file ${stateFile}: ${e.message}`);
          return empty;
        }
      }
      function saveState() {
        if (!stateFile) return;
        try {
          fs2.mkdirSync(path2.dirname(stateFile), { recursive: true });
          const tmpFile = `${stateFile}.tmp-${process.pid}`;
          fs2.writeFileSync(tmpFile, `${JSON.stringify(state2, null, 2)}
`);
          fs2.renameSync(tmpFile, stateFile);
        } catch (e) {
          log.warn(`[Digest] Failed to persist state to ${stateFile}: ${e.message}`);
        }
      }
      async function readSource(name, ...args2) {
        const fn = sources[name];
        if (typeof fn !== "function") return null;
        try {
          const value = await fn(...args2);
          return value === void 0 ? null : value;
        } catch (e) {
          log.error(`[Digest] Source ${name} failed: ${e.message}`);
          return null;
        }
      }
      async function composeDigest({ now = nowFn(), sinceMs = null } = {}) {
        const fallbackWindow = cfg.schedule === "weekly" ? WEEK_MS : DAY_MS;
        const since = Number.isFinite(sinceMs) ? sinceMs : Number.isFinite(state2.lastSentAt) ? state2.lastSentAt : now - fallbackWindow;
        const [budgetStatus, board, cronJobs, meshState, alertRows, evolutionState, consumers] = await Promise.all([
          readSource("getBudgetStatus"),
          readSource("getBoard"),
          readSource("getCronJobs"),
          readSource("getMeshState"),
          readSource("getAlertHistory", { since, limit: ALERT_HISTORY_SCAN }),
          readSource("getEvolutionState"),
          readSource("getTopConsumers")
        ]);
        const title = `Fleet digest (${cfg.schedule}) \u2014 ${fmtUtc(now)}`;
        const lines = [
          `**${title}**`,
          `_since ${fmtUtc(since)}_`,
          "",
          "**Spend vs budgets**",
          ...composeBudgetLines(budgetStatus),
          "",
          "**Kanban throughput**",
          ...board ? composeKanbanLines(board, since) : ["- kanban unavailable"],
          "",
          "**Cron**",
          ...composeCronLines(cronJobs),
          "",
          "**Mesh**",
          ...meshState ? composeMeshLines(meshState, alertRows) : ["- mesh unavailable"],
          "",
          "**Evolution**",
          ...composeLessonLines(evolutionState),
          "",
          "**Top token consumers**",
          ...composeConsumerLines(consumers)
        ];
        return { title, markdown: lines.join("\n"), sinceMs: since, generatedAt: now };
      }
      async function sendNow({ scheduled = false } = {}) {
        const now = nowFn();
        const digest = await composeDigest({ now });
        let result;
        try {
          result = await deliver(
            {
              type: "fleetDigest",
              severity: "info",
              node: null,
              task: null,
              message: digest.markdown,
              ts: now
            },
            [...cfg.sinks]
          );
        } catch (e) {
          log.error(`[Digest] Delivery failed: ${e.message}`);
          return { sent: false, scheduled, error: e.message, title: digest.title };
        }
        if (scheduled) {
          state2 = { ...state2, lastSentAt: now };
          saveState();
        }
        return {
          sent: true,
          scheduled,
          title: digest.title,
          markdown: digest.markdown,
          dispatched: result && Number.isFinite(result.dispatched) ? result.dispatched : 0,
          delivered: result && Number.isFinite(result.delivered) ? result.delivered : 0,
          ...result && result.suppressed ? { suppressed: true } : {}
        };
      }
      function tick() {
        if (!cfg.enabled || sending) return sending;
        const now = nowFn();
        const occurrence = lastScheduledOccurrence(cfg, now);
        if (Number.isFinite(state2.lastSentAt) && state2.lastSentAt >= occurrence) return null;
        sending = sendNow({ scheduled: true }).then((result) => {
          if (result.sent) {
            log.log(`[Digest] Scheduled ${cfg.schedule} digest sent (${result.delivered} delivered)`);
          }
          return result;
        }).catch((e) => {
          log.error(`[Digest] Scheduled send failed: ${e.message}`);
          return { sent: false, error: e.message };
        }).finally(() => {
          sending = null;
        });
        return sending;
      }
      function start() {
        if (timer || !cfg.enabled) return;
        if (!Number.isFinite(state2.lastSentAt)) {
          state2 = { ...state2, lastSentAt: nowFn() };
          saveState();
        }
        tick();
        timer = setInterval(tick, TICK_MS);
        if (typeof timer.unref === "function") timer.unref();
      }
      function stop() {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      }
      function applyConfig(newConfig) {
        stop();
        cfg = normalizeDigestConfig(newConfig);
        if (cfg.enabled) start();
      }
      function getState() {
        return {
          enabled: cfg.enabled,
          schedule: cfg.schedule,
          hourUtc: cfg.hourUtc,
          sinks: [...cfg.sinks],
          lastSentAt: state2.lastSentAt,
          nextDueAt: cfg.enabled ? lastScheduledOccurrence(cfg, nowFn()) + (cfg.schedule === "weekly" ? WEEK_MS : DAY_MS) : null
        };
      }
      return { start, stop, tick, composeDigest, sendNow, applyConfig, getState };
    }
    function createTopConsumersSource2({ usageSources: usageSources2, nowFn = Date.now }) {
      if (!usageSources2 || !usageSources2.sources) {
        throw new TypeError("createTopConsumersSource requires a usageSources instance");
      }
      const { claudeCode, nineRouter } = usageSources2.sources;
      return async function getTopConsumers() {
        const out = [];
        try {
          if (claudeCode && claudeCode.describe().available) {
            const windows = await claudeCode.getUsageWindows();
            if (windows && windows.available && windows.h24) {
              const bucket = windows.h24;
              out.push({
                label: "claude-code (24h est)",
                costUSD: Number(bucket.estCost) || 0,
                tokens: (Number(bucket.input) || 0) + (Number(bucket.output) || 0) + (Number(bucket.cacheRead) || 0) + (Number(bucket.cacheWrite) || 0),
                requests: Number(bucket.requests) || 0
              });
            }
          }
        } catch (e) {
          console.error("[Digest] claude-code consumer read failed:", e.message);
        }
        try {
          if (nineRouter && nineRouter.describe().available) {
            const usage = await nineRouter.getUsage({ sinceMs: nowFn() - DAY_MS });
            if (usage && Array.isArray(usage.byModel)) {
              for (const row of usage.byModel.slice(0, MAX_TOP_CONSUMERS)) {
                if (!row || typeof row.model !== "string") continue;
                out.push({
                  label: `9router ${row.model} (24h)`,
                  costUSD: Number(row.cost) || 0,
                  tokens: Number(row.totalTokens) || 0,
                  requests: Number(row.requests) || 0
                });
              }
            }
          }
        } catch (e) {
          console.error("[Digest] nine-router consumer read failed:", e.message);
        }
        return out.sort((a, b) => (b.costUSD || 0) - (a.costUSD || 0)).slice(0, MAX_TOP_CONSUMERS);
      };
    }
    module2.exports = {
      createDigest,
      createTopConsumersSource: createTopConsumersSource2,
      normalizeDigestConfig,
      lastScheduledOccurrence
    };
  }
});

// src/fleet.js
var require_fleet = __commonJS({
  "src/fleet.js"(exports2, module2) {
    var path2 = require("path");
    var os2 = require("os");
    var { createMesh } = require_mesh();
    var { createFederation } = require_federation();
    var { createTailscaleAdapter } = require_tailscale();
    var { createFleetChat } = require_fleet_chat();
    var { createKanban, createWatchdog } = require_kanban();
    var { createBriefs } = require_briefs();
    var { createEvolution } = require_evolution();
    var { createAudit } = require_audit();
    var { createCortex } = require_cortex();
    var { createAlerts, createNodeAlertTracker, createSinkDispatcher } = require_alerts();
    var { createRateLimiter: createRateLimiter2 } = require_rate_limit();
    var { createBudgets } = require_budgets();
    var { createDigest } = require_digest();
    var { defaultSecrets } = require_secrets();
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
      let alerts = createAlerts({ config: config.alerts, logsDir });
      let currentAlertsConfig = config.alerts || {};
      function applyAlertsConfig(alertsConfig) {
        const { value: resolvedAlerts, failures } = defaultSecrets.resolveDeepSync(alertsConfig || {});
        for (const failure of failures) {
          console.warn(
            `[Fleet] 1Password ref ${failure.ref} (alerts.${failure.path}) failed: ${failure.error} \u2014 keeping the reference in place`
          );
        }
        alerts = createAlerts({ config: resolvedAlerts, logsDir });
        currentAlertsConfig = resolvedAlerts || {};
        nodeAlertTracker.setFlapConfig(resolvedAlerts && resolvedAlerts.flap);
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
      const nodeAlertTracker = createNodeAlertTracker({
        flap: config.alerts && config.alerts.flap,
        fire: fireAlert
      });
      const mesh = createMesh({
        stateDir,
        intervalMs: config.mesh.intervalMs,
        // Zero-touch mesh join: the fleet-wide seed list is auto-registered on
        // boot, skipping this node's own entry. selfHostname prefers the
        // installer-set Tailscale identity (config.dispatch.identity) over the
        // container hostname — the former is the stable tailnet name seed entries
        // are keyed on. Empty seed = no-op (byte-identical to pre-seed boots).
        seed: config.mesh.seed,
        selfHostname: config.dispatch && config.dispatch.identity || os2.hostname(),
        // Non-blocking by design: mesh.getState() feeds GET /api/state, which
        // must never wait on the tailscale CLI / LocalAPI at request time.
        tailscale: createNonBlockingTailscale(),
        onChange: ({ node, previousStatus, status }) => {
          emit("fleet.mesh", { id: node.id, hostname: node.hostname, previousStatus, status });
        },
        onHealth: ({ node, status, health }) => {
          nodeAlertTracker.observe(node, status, health);
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
      const rateLimiter = createRateLimiter2({
        windowMs: config.rateLimit.windowMs,
        max: config.rateLimit.max
      });
      let usageProvider = null;
      const budgets = createBudgets({
        config: config.budgets,
        stateFile: path2.join(stateDir, "budgets.json"),
        getUsage: (params) => usageProvider ? usageProvider(params) : null,
        onBreach: (breach) => {
          fireAlert({
            type: "budgetBreach",
            severity: breach.severity === "critical" ? "critical" : "warn",
            task: `${breach.period}:${breach.scope}`,
            message: `Budget breach (${breach.severity}): ${breach.scope} spent $${breach.actualUSD.toFixed(2)} of $${breach.budgetUSD.toFixed(2)} (${Math.round(breach.ratio * 100)}%) for ${breach.period} period ${breach.periodKey}`
          });
        }
      });
      function setUsageProvider(fn) {
        usageProvider = typeof fn === "function" ? fn : null;
      }
      function applyBudgetsConfig(budgetsConfig) {
        budgets.applyConfig(budgetsConfig);
        console.log("[Fleet] Budget evaluator reconfigured from updated settings");
      }
      const digestDispatcher = createSinkDispatcher();
      let digestExtras = {};
      const digest = createDigest({
        config: config.digest,
        stateFile: path2.join(stateDir, "digest.json"),
        sources: {
          getBudgetStatus: () => budgets.getStatus(),
          getBoard: () => kanban.getBoard(),
          getMeshState: () => mesh.getState(),
          getEvolutionState: () => evolution.getState(),
          getAlertHistory: (filters) => alerts.query(filters),
          getCronJobs: () => digestExtras.getCronJobs ? digestExtras.getCronJobs() : null,
          getTopConsumers: () => digestExtras.getTopConsumers ? digestExtras.getTopConsumers() : null
        },
        deliver: (alert, sinkNames) => {
          const allowAll = !Array.isArray(sinkNames) || sinkNames.includes("*");
          const allowed = allowAll ? null : new Set(sinkNames);
          return digestDispatcher.dispatch(
            currentAlertsConfig.sinks || {},
            alert,
            (sinkName) => allowed === null || allowed.has(sinkName)
          );
        }
      });
      function setDigestSources(extras) {
        digestExtras = extras && typeof extras === "object" ? extras : {};
      }
      function applyDigestConfig(digestConfig) {
        digest.applyConfig(digestConfig);
        console.log("[Fleet] Digest scheduler reconfigured from updated settings");
      }
      let boardWatcher = null;
      function start() {
        mesh.start();
        federation.start();
        watchdog.start();
        budgets.start();
        digest.start();
        if (!boardWatcher) boardWatcher = kanban.watch();
      }
      function stop() {
        mesh.stop();
        federation.stop();
        watchdog.stop();
        budgets.stop();
        digest.stop();
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
        budgets,
        applyBudgetsConfig,
        setUsageProvider,
        digest,
        applyDigestConfig,
        setDigestSources,
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
    var { defaultSecrets } = require_secrets();
    var { isLoopbackAddr } = require_auth();
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
    function createFleetRoutes2({
      fleet: fleet2,
      settings: settings2 = null,
      dispatch: dispatch2 = null,
      orchestrate: orchestrate2 = null,
      bulk: bulk2 = null,
      rosterFn = null,
      secretsStatusFn = () => defaultSecrets.getStatus(),
      exitFn = (code) => process.exit(code),
      restartDelayMs = 300,
      // AC-11 / AC-22: optional spawn-store accessor for dedup at the orchestrate
      // entry. Accepts either a spawnStore object directly OR a spawnStoreFn getter
      // (lazy, for wiring after construction). When absent or unavailable, dedup
      // degrades to no-op — never crashes the route.
      spawnStore = null,
      spawnStoreFn = null
    }) {
      function resolveSpawnStore() {
        if (typeof spawnStoreFn === "function") {
          try {
            return spawnStoreFn();
          } catch (e) {
            return null;
          }
        }
        return spawnStore || null;
      }
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
      function recordAudit2(user, action, target, detail) {
        try {
          fleet2.audit.record({ user, action, target, detail });
        } catch (e) {
          console.error("[FleetRoutes] Audit record failed:", e.message);
        }
      }
      function isInternalCall(req) {
        const remoteAddr = req.socket?.remoteAddress || "";
        if (!isLoopbackAddr(remoteAddr)) return false;
        if (req.headers["x-forwarded-for"]) return false;
        return true;
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
          if (typeof body.registeredBy === "string" && body.registeredBy.trim() === "spawn") {
            json(res, 403, { error: 'registeredBy "spawn" is reserved for the internal controller' });
            return true;
          }
          if (user === "anonymous" && !isInternalCall(req)) {
            json(res, 403, { error: "Mesh registration requires an authenticated identity" });
            return true;
          }
          const node = fleet2.mesh.registerNode({ ...body, registeredBy: user });
          recordAudit2(user, "node.register", node.hostname, { id: node.id });
          json(res, 200, { success: true, node });
          return true;
        }
        if (segments[1] === "nodes" && segments.length === 3 && method === "DELETE") {
          const user = guardMutation(req, res);
          if (!user) return true;
          if (user === "anonymous" && !isInternalCall(req)) {
            json(res, 403, { error: "Mesh unregistration requires an authenticated identity" });
            return true;
          }
          const removed = fleet2.mesh.unregisterNode(segments[2]);
          recordAudit2(user, "node.unregister", removed.hostname, { id: removed.id });
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
      const FLEET_BOARD_COLUMNS = ["inbox", "assigned", "inprogress", "review", "done", "failed"];
      function trimBoardTask(task) {
        return {
          id: task.id,
          title: task.title,
          status: task.status,
          assignee: typeof task.assignee === "string" && task.assignee ? task.assignee : null,
          priority: Number.isFinite(task.priority) ? task.priority : null,
          order: Number.isFinite(task.order) ? task.order : 0,
          updated_at: typeof task.updated_at === "string" ? task.updated_at : null,
          stale: task.stale === true
        };
      }
      function buildFleetBoard() {
        const board = fleet2.kanban.getBoard();
        const origins = [{ key: "local", label: "This dashboard", kind: "local", writable: true }];
        const tasks = (Array.isArray(board.tasks) ? board.tasks : []).map((task) => ({
          ...trimBoardTask(task),
          origin: "local"
        }));
        for (const source of fleet2.federation.getBoardSources()) {
          origins.push({
            key: source.remote.id,
            label: source.remote.label,
            kind: "remote",
            writable: source.remote.allowWrites === true,
            reachable: source.reachable,
            baseUrl: source.remote.baseUrl,
            hasData: !!(source.detail && source.detail.kanban)
          });
          const remoteTasks = source.detail && source.detail.kanban && Array.isArray(source.detail.kanban.tasks) ? source.detail.kanban.tasks : [];
          for (const task of remoteTasks) {
            tasks.push({ ...task, origin: source.remote.id });
          }
        }
        return { columns: FLEET_BOARD_COLUMNS, origins, tasks };
      }
      async function handleFederation(req, res, method, segments) {
        if (segments.length === 1 && method === "GET") {
          json(res, 200, fleet2.federation.getState());
          return true;
        }
        if (segments[1] === "board" && segments.length === 2 && method === "GET") {
          json(res, 200, buildFleetBoard());
          return true;
        }
        if (segments[1] === "remotes" && segments.length === 4 && segments[3] === "detail" && method === "GET") {
          json(res, 200, fleet2.federation.getRemoteDetail(segments[2]));
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
          recordAudit2(user, "node.register", remote.baseUrl, { kind: "federation", id: remote.id });
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
          recordAudit2(user, "node.register", remote.baseUrl, {
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
          recordAudit2(
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
          recordAudit2(user, "node.unregister", removed.baseUrl, {
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
          recordAudit2(user, "chat.publish", message.id || null, {
            sender: message.sender,
            receiver: message.receiver
          });
          json(res, 200, { success: true, message });
          return true;
        }
        return false;
      }
      async function requireRosterAgent(agent) {
        if (typeof rosterFn !== "function") return;
        if (typeof agent !== "string" || agent.trim().length === 0) {
          throw httpError(400, "Body must include a non-empty 'agent' field");
        }
        const [id, node] = String(agent).trim().split("@");
        let roster;
        try {
          roster = await rosterFn();
        } catch (e) {
          throw httpError(503, `Agent roster unavailable: ${e.message}`);
        }
        const agents = Array.isArray(roster && roster.agents) ? roster.agents : [];
        if (!agents.some((a) => a && a.id === id && (!node || a.node === node))) {
          throw httpError(400, `Unknown agent '${agent.trim()}' \u2014 not in the fleet roster`);
        }
      }
      function refuseWhenOverBudget(res, taskId) {
        const block = fleet2.budgets && typeof fleet2.budgets.checkDispatchBlock === "function" ? fleet2.budgets.checkDispatchBlock() : null;
        if (!block) return false;
        fleet2.fireAlert({
          type: "budgetBreach",
          severity: "warn",
          task: taskId,
          message: `Dispatch blocked: ${block.scope} ${block.period} budget exceeded ($${block.spent.toFixed(2)} of $${block.limit.toFixed(2)}, window ${block.periodKey}). Acknowledge via POST /api/fleet/budgets/ack to resume dispatching.`
        });
        json(res, 429, {
          error: "budget exceeded",
          scope: block.scope,
          spent: block.spent,
          limit: block.limit,
          period: block.period,
          periodKey: block.periodKey
        });
        return true;
      }
      async function handleKanbanDispatch(req, res, method, taskId, query) {
        if (method !== "POST") return false;
        if (!dispatch2) {
          json(res, 503, { error: "Dispatch is not configured on this node" });
          return true;
        }
        const preview = query.get("preview") === "1";
        if (preview) {
          const body2 = await readJsonBody(req);
          await requireRosterAgent(body2.agent);
          json(res, 200, { preview: true, ...dispatch2.previewDispatch(taskId, body2) });
          return true;
        }
        const user = guardMutation(req, res);
        if (!user) return true;
        if (refuseWhenOverBudget(res, taskId)) return true;
        const body = await readJsonBody(req);
        await requireRosterAgent(body.agent);
        const result = dispatch2.dispatchTask(taskId, {
          agent: body.agent,
          node: body.node,
          actor: user
        });
        recordAudit2(user, "task.update", taskId, { op: "dispatch", agent: result.agent });
        json(res, 200, {
          success: true,
          task: result.task,
          agent: result.agent,
          sessionKey: result.sessionKey
        });
        return true;
      }
      function refuseOrchestration(res, taskId, { mode, ceiling, spentUSD, projectedUSD }) {
        if (refuseWhenOverBudget(res, taskId)) return true;
        const block = fleet2.budgets && typeof fleet2.budgets.checkOrchestrationBlock === "function" ? fleet2.budgets.checkOrchestrationBlock({ mode, ceiling, spentUSD, projectedUSD }) : null;
        if (!block) return false;
        const status = block.reason === "open-mode-disabled" ? 403 : 429;
        fleet2.fireAlert({
          type: "budgetBreach",
          severity: "warn",
          task: taskId,
          message: `Orchestration refused (${block.reason}): ${block.message}`
        });
        json(res, status, { error: block.message, ...block });
        return true;
      }
      async function handleOrchestrate(req, res, method, segments = [], query = null) {
        if (!orchestrate2) {
          json(res, 503, { error: "Orchestration is not configured on this node" });
          return true;
        }
        if (method === "GET" && segments.length === 2) {
          const runId = segments[1];
          const snapshot = orchestrate2.getRun(runId);
          if (!snapshot) {
            json(res, 404, { error: `Unknown runId: ${runId}` });
            return true;
          }
          json(res, 200, { success: true, ...snapshot });
          return true;
        }
        if (method !== "POST") return false;
        const user = guardMutation(req, res);
        if (!user) return true;
        const body = await readJsonBody(req);
        const mode = typeof body.mode === "string" ? body.mode.trim() : "";
        const wantWait = body.wait === true || query && typeof query.get === "function" && query.get("wait") === "true";
        const budgetMode = body.budgetMode === "open" ? "open" : "closed";
        const ceiling = body.ceilingUSD;
        const eventId = typeof body.event_id === "string" && body.event_id.trim() || typeof body.dedup_key === "string" && body.dedup_key.trim() || null;
        if (eventId !== null && eventId.length > 256) {
          throw httpError(400, "event_id/dedup_key must be at most 256 characters");
        }
        const activeStore = resolveSpawnStore();
        if (eventId && activeStore && typeof activeStore.insertDedup === "function") {
          let dedupResult;
          try {
            dedupResult = activeStore.insertDedup(eventId);
          } catch (e) {
            console.warn("[Orchestrate] insertDedup failed:", e.message);
            dedupResult = null;
          }
          if (dedupResult && dedupResult.isDuplicate) {
            json(res, 200, {
              success: true,
              deduped: true,
              event_id: eventId,
              status: "deduped",
              reason: "duplicate_event_id"
            });
            return true;
          }
        }
        const anchorTask = mode === "single" && typeof body.taskId === "string" ? body.taskId : null;
        if (refuseOrchestration(res, anchorTask, { mode: budgetMode, ceiling })) return true;
        const budgetCheck = fleet2.budgets && typeof fleet2.budgets.checkOrchestrationBlock === "function" ? ({ spentUSD }) => fleet2.budgets.checkOrchestrationBlock({ mode: budgetMode, ceiling, spentUSD }) : null;
        if (mode === "single") {
          await requireRosterAgent(body.agent);
          const result = orchestrate2.runSingle(body.taskId, { agent: body.agent, actor: user });
          recordAudit2(user, "task.update", body.taskId, {
            op: "orchestrate:single",
            agent: result.agent
          });
          json(res, 200, {
            success: true,
            mode,
            task: result.task,
            agent: result.agent,
            sessionKey: result.sessionKey
          });
          return true;
        }
        if (mode === "board") {
          if (!Array.isArray(body.agents) || body.agents.length === 0) {
            throw httpError(400, "board mode requires a non-empty 'agents' array");
          }
          for (const agent of body.agents) await requireRosterAgent(agent);
          const ostatus = orchestrate2 && typeof orchestrate2.getStatus === "function" ? orchestrate2.getStatus() : null;
          const wantsParallel = typeof body.sequential === "boolean" ? body.sequential === false : true;
          if (ostatus && ostatus.routeToPool === true && wantsParallel && Number(ostatus.perSeatCostUSD) > 0) {
            const projectedUSD = Number(ostatus.perSeatCostUSD) * body.agents.length;
            if (refuseOrchestration(res, anchorTask, {
              mode: budgetMode,
              ceiling,
              projectedUSD
            })) {
              return true;
            }
          }
          const run = orchestrate2.runBoard({
            title: body.title,
            question: body.question,
            agents: body.agents,
            actor: user,
            timeoutSec: body.timeoutSec,
            // Sequential council: advisors run one-at-a-time (single-box reliability)
            // instead of fanning out in parallel. Pass the boolean through verbatim;
            // OMITTED (undefined) lets the server default (fleet.orchestrate
            // .sequentialBoard) decide. Do NOT coerce absent->false, or the default
            // never fires for the normal case where the caller omits the field.
            sequential: typeof body.sequential === "boolean" ? body.sequential : void 0,
            budgetCheck
          });
          recordAudit2(user, "task.create", run.runId, {
            op: "orchestrate:board",
            agents: body.agents.length,
            async: !wantWait
          });
          if (!wantWait) {
            json(res, 202, {
              success: true,
              mode,
              runId: run.runId,
              agents: run.agents,
              status: "running",
              startedAt: run.startedAt
            });
            return true;
          }
          const snapshot = await orchestrate2.waitForRun(run.runId);
          json(res, 200, { success: true, mode, ...snapshot });
          return true;
        }
        if (mode === "chain") {
          if (!Array.isArray(body.steps) || body.steps.length === 0) {
            throw httpError(400, "chain mode requires a non-empty 'steps' array");
          }
          for (const step of body.steps) await requireRosterAgent(step && step.agent);
          const run = orchestrate2.runChain({
            title: body.title,
            steps: body.steps,
            actor: user,
            timeoutSec: body.timeoutSec,
            budgetCheck
          });
          recordAudit2(user, "task.create", run.runId, {
            op: "orchestrate:chain",
            steps: body.steps.length,
            async: !wantWait
          });
          if (!wantWait) {
            json(res, 202, {
              success: true,
              mode,
              runId: run.runId,
              agents: run.agents,
              status: "running",
              startedAt: run.startedAt
            });
            return true;
          }
          const snapshot = await orchestrate2.waitForRun(run.runId);
          json(res, 200, { success: true, mode, ...snapshot });
          return true;
        }
        throw httpError(400, "Body 'mode' must be one of: single, board, chain");
      }
      async function handleKanban(req, res, method, segments, query) {
        if (segments.length === 1 && method === "GET") {
          json(res, 200, fleet2.kanban.getBoard());
          return true;
        }
        if (segments[1] === "dispatch" && segments.length === 2 && method === "GET") {
          json(
            res,
            200,
            dispatch2 ? dispatch2.getStatus() : { available: false, enabled: false, openCount: 0 }
          );
          return true;
        }
        if (segments[1] !== "tasks") return false;
        if (segments.length === 2 && method === "POST") {
          const user = guardMutation(req, res);
          if (!user) return true;
          const body = await readJsonBody(req);
          const task = fleet2.kanban.createTask(body, user);
          recordAudit2(user, "task.create", task.id, { title: task.title });
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
          recordAudit2(user, "task.update", taskId, { changes: Object.keys(body) });
          json(res, 200, { success: true, task });
          return true;
        }
        if (segments.length === 3 && method === "DELETE") {
          const user = guardMutation(req, res);
          if (!user) return true;
          const task = fleet2.kanban.deleteTask(taskId, user);
          recordAudit2(user, "task.delete", taskId, { title: task.title });
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
            recordAudit2(user, "task.move", taskId, { to: body.status });
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
            recordAudit2(user, "task.comment", taskId, null);
            json(res, 200, { success: true, task });
            return true;
          }
          if (action === "attempts") {
            const user = guardMutation(req, res);
            if (!user) return true;
            const body = await readJsonBody(req);
            const task = fleet2.kanban.addAttempt(taskId, body);
            recordAudit2(user, "task.update", taskId, { attempt: body.agent || null });
            json(res, 200, { success: true, task });
            return true;
          }
          if (action === "dispatch") {
            return handleKanbanDispatch(req, res, method, taskId, query);
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
          recordAudit2(user, "brief.write", name, { size: result.size });
          json(res, 200, { success: true, brief: result });
          return true;
        }
        if (method === "DELETE") {
          const user = guardMutation(req, res);
          if (!user) return true;
          const result = fleet2.briefs.remove(name);
          recordAudit2(user, "brief.delete", name, null);
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
            recordAudit2(user, "gate.toggle", null, { gate: result.gate });
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
          recordAudit2(user, "lesson.add", lesson.id, { title: lesson.title, status: lesson.status });
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
          recordAudit2(user, action === "approve" ? "lesson.approve" : "lesson.reject", lessonId, null);
          json(res, 200, { success: true, lesson });
          return true;
        }
        return false;
      }
      function memoryErrorStatus(message) {
        if (/not found/i.test(message)) return 404;
        if (/must be|must include|requires at least one/i.test(message)) return 400;
        return 503;
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
            recordAudit2(user, "memory.write", result.id || null, {
              op: "store",
              bytes: Buffer.byteLength(body.text, "utf8")
            });
            json(res, 200, { success: true, result });
            return true;
          }
          return false;
        }
        if (segments[1] === "memory" && segments.length === 3) {
          const memoryId = segments[2];
          if (method === "GET") {
            const result = await fleet2.cortex.getMemory(memoryId);
            if (result && result.error) {
              json(res, memoryErrorStatus(result.error), { error: result.error });
              return true;
            }
            json(res, 200, result);
            return true;
          }
          if (method === "PATCH") {
            const user = guardMutation(req, res);
            if (!user) return true;
            const body = await readJsonBody(req);
            const changes = {};
            for (const field of ["text", "category", "scope", "importance"]) {
              if (body[field] !== void 0) changes[field] = body[field];
            }
            if (Object.keys(changes).length === 0) {
              throw httpError(
                400,
                "Body must include at least one of: text, category, scope, importance"
              );
            }
            const result = await fleet2.cortex.updateMemory(memoryId, changes);
            if (result && result.error) {
              json(res, memoryErrorStatus(result.error), { error: result.error });
              return true;
            }
            recordAudit2(user, "memory.write", memoryId, {
              op: "update",
              fields: Object.keys(changes)
            });
            json(res, 200, { success: true, result });
            return true;
          }
          if (method === "DELETE") {
            const user = guardMutation(req, res);
            if (!user) return true;
            const result = await fleet2.cortex.deleteMemory(memoryId);
            if (result && result.error) {
              json(res, memoryErrorStatus(result.error), { error: result.error });
              return true;
            }
            recordAudit2(user, "memory.write", memoryId, { op: "delete" });
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
        if (segments.length === 2 && segments[1] === "analytics" && method === "GET") {
          const days = parseIntParam(query, "days", 14);
          if (days < 1 || days > 90) throw httpError(400, "days must be between 1 and 90");
          json(res, 200, fleet2.alerts.analytics({ days }));
          return true;
        }
        if (segments.length !== 1 || method !== "GET") return false;
        const limit = parseIntParam(query, "limit", 50);
        const filters = {};
        if (query.get("type")) filters.type = query.get("type");
        if (query.get("node")) filters.node = query.get("node");
        if (query.get("severity")) filters.severity = query.get("severity");
        if (query.get("since")) filters.since = query.get("since");
        if (query.get("history") === "1") {
          json(res, 200, { alerts: fleet2.alerts.query({ ...filters, limit }), source: "history" });
        } else {
          json(res, 200, { alerts: fleet2.alerts.getRecent(limit, filters), source: "memory" });
        }
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
          recordAudit2(user, "settings.update", null, {
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
          recordAudit2(user, "alert.test", null, { fired: result ? !!result.fired : null });
          json(res, 200, { success: true, result });
          return true;
        }
        return false;
      }
      async function handleBulk(req, res, method, segments) {
        if (segments.length !== 1 || method !== "POST") return false;
        if (!bulk2) {
          json(res, 503, { error: "Bulk operations are not configured on this node" });
          return true;
        }
        const user = guardMutation(req, res);
        if (!user) return true;
        const body = await readJsonBody(req);
        const report = await bulk2.execute({
          action: body.action,
          targets: body.targets,
          params: body.params,
          actor: user
        });
        recordAudit2(user, "action.execute", report.action, {
          kind: "bulk",
          targets: report.targets,
          okCount: report.okCount,
          failCount: report.failCount
        });
        json(res, 200, {
          success: true,
          action: report.action,
          targets: report.targets,
          okCount: report.okCount,
          failCount: report.failCount,
          results: report.results
        });
        return true;
      }
      async function handleAdmin(req, res, method, segments) {
        if (segments[1] === "restart" && segments.length === 2 && method === "POST") {
          const user = guardMutation(req, res);
          if (!user) return true;
          recordAudit2(user, "service.restart", null, { restartingInMs: restartDelayMs });
          json(res, 200, { success: true, restartingInMs: restartDelayMs });
          const timer = setTimeout(() => exitFn(1), restartDelayMs);
          if (typeof timer.unref === "function") timer.unref();
          return true;
        }
        return false;
      }
      async function routeRequest2(req, res, pathname, query) {
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
          case "budgets":
            if (segments[1] === "status" && segments.length === 2 && method === "GET") {
              json(res, 200, await fleet2.budgets.getStatus());
              return true;
            }
            if (segments[1] === "ack" && segments.length === 2 && method === "POST") {
              const user = guardMutation(req, res);
              if (!user) return true;
              const result = fleet2.budgets.ack(user);
              recordAudit2(user, "budgets.ack", null, { acked: result.acked });
              json(res, 200, { success: true, ...result });
              return true;
            }
            return false;
          case "digest":
            if (segments[1] === "test" && segments.length === 2 && method === "POST") {
              const user = guardMutation(req, res);
              if (!user) return true;
              const result = await fleet2.digest.sendNow();
              recordAudit2(user, "digest.test", null, {
                sent: result.sent,
                dispatched: result.dispatched ?? 0,
                delivered: result.delivered ?? 0
              });
              json(res, 200, { success: true, result });
              return true;
            }
            return false;
          case "chat":
            return handleChat(req, res, method, segments, query);
          case "kanban":
            return handleKanban(req, res, method, segments, query);
          case "orchestrate":
            return handleOrchestrate(req, res, method, segments, query);
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
          case "bulk":
            return handleBulk(req, res, method, segments);
          case "admin":
            return handleAdmin(req, res, method, segments);
          case "secrets":
            if (segments.length === 1 && method === "GET") {
              json(res, 200, secretsStatusFn());
              return true;
            }
            return false;
          default:
            return false;
        }
      }
      async function handle(req, res, pathname, query) {
        try {
          const handled = await routeRequest2(req, res, pathname, query);
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

// src/orchestrate.js
var require_orchestrate = __commonJS({
  "src/orchestrate.js"(exports2, module2) {
    var crypto = require("crypto");
    var DEFAULT_TIMEOUT_SEC = 1200;
    var COMPLETION_GRACE_MS = 30 * 1e3;
    var MAX_TIMEOUT_SEC = 3600;
    var RUN_ID_PREFIX = "orx_";
    var SYNC_WAIT_CAP_MS = 90 * 1e3;
    var RUN_TTL_MS = 30 * 60 * 1e3;
    function newRunId() {
      return RUN_ID_PREFIX + crypto.randomBytes(8).toString("hex");
    }
    function createRunRegistry({ nowFn, emit, setTimerFn = setTimeout }) {
      const runs = /* @__PURE__ */ new Map();
      function open({ runId, mode, agents }) {
        const entry = {
          runId,
          mode,
          // "board" | "chain"
          status: "running",
          // running | done | failed
          agents: agents.slice(),
          results: [],
          // filled when the background run settles
          missing: [],
          // board: timed-out / refused / budget seats
          final: null,
          // chain: last successful step text
          stoppedAt: null,
          // chain: index it halted at, else null
          budgetHalt: null,
          // block descriptor if cut by CLOSED ceiling
          truncatedAny: false,
          error: null,
          // set on an UNEXPECTED background throw (status:"failed")
          startedAt: new Date(nowFn()).toISOString(),
          endedAt: null
        };
        runs.set(runId, entry);
        return entry;
      }
      function patch(runId, fields) {
        const prev = runs.get(runId);
        if (!prev) return null;
        const next = { ...prev, ...fields };
        if (Object.prototype.hasOwnProperty.call(prev, "_completion")) {
          Object.defineProperty(next, "_completion", {
            value: prev._completion,
            enumerable: false,
            configurable: true
          });
        }
        runs.set(runId, next);
        return next;
      }
      function settle(runId, { status, result }) {
        const next = patch(runId, {
          ...result,
          status,
          // "done" | "failed"
          endedAt: new Date(nowFn()).toISOString()
        });
        if (next) {
          emit({
            type: "orchestration.completed",
            runId,
            mode: next.mode,
            status: next.status,
            // counts only — keep the SSE payload light, like dispatch's events
            collected: Array.isArray(next.results) ? next.results.filter((r) => r && r.ok).length : 0,
            missing: Array.isArray(next.missing) ? next.missing.length : 0
          });
          scheduleReap(runId);
        }
        return next;
      }
      function fail(runId, err) {
        return settle(runId, {
          status: "failed",
          result: { error: String(err && err.message || err) }
        });
      }
      function get(runId) {
        return runs.get(runId) || null;
      }
      function list() {
        return Array.from(runs.values()).sort(
          (a, b) => String(b.startedAt).localeCompare(String(a.startedAt))
        );
      }
      function scheduleReap(runId) {
        const t = setTimerFn(() => runs.delete(runId), RUN_TTL_MS);
        if (t && typeof t.unref === "function") t.unref();
      }
      return { open, patch, settle, fail, get, list, _size: () => runs.size };
    }
    function httpError(statusCode, message) {
      const err = new Error(message);
      err.statusCode = statusCode;
      return err;
    }
    function normalizeTimeoutSec(value, fallback) {
      const n = Number.isFinite(value) ? Math.floor(value) : fallback;
      if (n <= 0) return fallback;
      return Math.min(n, MAX_TIMEOUT_SEC);
    }
    function withTimeout(promise, ms, setTimer = setTimeout) {
      return new Promise((resolve) => {
        let done = false;
        const timer = setTimer(() => {
          if (done) return;
          done = true;
          resolve({ settled: false });
        }, ms);
        if (timer && typeof timer.unref === "function") timer.unref();
        Promise.resolve(promise).then(
          (value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ settled: true, value });
          },
          // dispatch.completion never rejects, but be defensive: a thrown
          // composition still counts as "settled with no usable value".
          () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ settled: true, value: void 0 });
          }
        );
      });
    }
    var FAILURE_RESULT_COPY = "The agent could not complete this request \u2014 please try again.";
    function readAttemptResultText(attempt) {
      if (!attempt || typeof attempt !== "object") {
        return { text: null, truncated: false, failureCopy: FAILURE_RESULT_COPY };
      }
      if (typeof attempt.result_text === "string" && attempt.result_text.length > 0) {
        return { text: attempt.result_text, truncated: false, failureCopy: null };
      }
      return { text: null, truncated: false, failureCopy: FAILURE_RESULT_COPY };
    }
    function attemptSucceeded(attempt) {
      return !!attempt && attempt.result === "success";
    }
    function buildCardDescription({ question, instruction, context }) {
      const lines = [];
      if (question) {
        lines.push(question);
      }
      if (instruction) {
        lines.push(instruction);
      }
      if (context && context.trim().length > 0) {
        lines.push("");
        lines.push("--- Context from the previous step ---");
        lines.push(context);
      }
      return lines.join("\n");
    }
    function createOrchestrate2(options = {}) {
      const {
        kanban,
        dispatch: dispatch2,
        onEvent,
        config = {},
        spawn = null,
        spawnEnabled: spawnEnabled2 = false,
        nowFn = Date.now,
        setTimerFn = setTimeout
      } = options;
      if (!kanban) throw new Error("createOrchestrate: kanban is required");
      if (!dispatch2) throw new Error("createOrchestrate: dispatch is required");
      const enabled = config.enabled !== false;
      const defaultTimeoutSec = normalizeTimeoutSec(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
      const routeToPool = spawnEnabled2 === true && !!spawn && typeof spawn.lease === "function";
      const defaultSequentialBoard = config.sequentialBoard === true;
      const registry = createRunRegistry({ nowFn, emit, setTimerFn });
      function emit(event) {
        if (typeof onEvent === "function") {
          try {
            onEvent(event);
          } catch (e) {
            console.error("[Orchestrate] onEvent handler failed:", e.message);
          }
        }
      }
      function ensureEnabled() {
        if (!enabled) {
          throw httpError(503, "Orchestration is disabled (fleet.orchestrate.enabled=false)");
        }
      }
      function requireString(value, field) {
        if (typeof value !== "string" || value.trim().length === 0) {
          throw httpError(400, `Body must include a non-empty '${field}' field`);
        }
        return value.trim();
      }
      function normalizeBudgetCheck(budgetCheck) {
        if (typeof budgetCheck !== "function") return () => null;
        return ({ spentUSD }) => {
          try {
            return budgetCheck({ spentUSD }) || null;
          } catch (e) {
            console.error("[Orchestrate] budgetCheck guard failed:", e.message);
            return null;
          }
        };
      }
      function readSettledAttempt(taskId, attemptIndex) {
        try {
          const task = kanban.getBoard().tasks.find((t) => t.id === taskId);
          if (!task || !Array.isArray(task.attempts)) return null;
          return task.attempts[attemptIndex] || null;
        } catch (e) {
          console.error(`[Orchestrate] Could not read attempt on ${taskId}:`, e.message);
          return null;
        }
      }
      function collectOutcome(taskId, dispatched, settled) {
        if (!settled) {
          return {
            agent: dispatched.agent,
            text: null,
            ok: false,
            truncated: false,
            timedOut: true
          };
        }
        const attempt = readSettledAttempt(taskId, dispatched.attemptIndex);
        const ok = attemptSucceeded(attempt);
        const { text, truncated, failureCopy } = readAttemptResultText(attempt);
        return { agent: dispatched.agent, text, ok, truncated, timedOut: false, failureCopy };
      }
      function startRun({ mode, agents, runner }) {
        const runId = newRunId();
        const entry = registry.open({ runId, mode, agents });
        const completion = Promise.resolve().then(runner).then((result) => registry.settle(runId, { status: "done", result })).catch((err) => registry.fail(runId, err));
        Object.defineProperty(entry, "_completion", {
          value: completion,
          enumerable: false,
          configurable: true
        });
        return { runId, entry, completion };
      }
      function getRun(runId) {
        return registry.get(runId);
      }
      function listRuns() {
        return registry.list();
      }
      async function waitForRun(runId, capMs = SYNC_WAIT_CAP_MS) {
        const entry = registry.get(runId);
        if (!entry) return null;
        if (entry.status !== "running") return entry;
        const ms = Math.min(capMs, SYNC_WAIT_CAP_MS);
        await withTimeout(entry._completion, ms, setTimerFn);
        return registry.get(runId);
      }
      function leaseSeat(advisorId) {
        if (!routeToPool) return null;
        let leaseHandle = null;
        try {
          leaseHandle = spawn.lease(advisorId);
        } catch (e) {
          leaseHandle = null;
        }
        if (!leaseHandle || !leaseHandle.workerId) return null;
        const workerNode = leaseHandle.workerId;
        const ref = `${advisorId}@${workerNode}`;
        let settled = false;
        async function settle(ok) {
          if (settled) return;
          settled = true;
          try {
            if (ok && typeof spawn.release === "function") {
              spawn.release(leaseHandle.workerId, leaseHandle.generation);
            } else if (typeof spawn.beginDrain === "function") {
              if (spawn.beginDrain(leaseHandle.workerId) && typeof spawn.settleAndRemove === "function") {
                await spawn.settleAndRemove(leaseHandle.workerId);
              }
            }
          } catch (e) {
            console.error(`[Orchestrate] lease settle failed for ${leaseHandle.workerId}:`, e.message);
          }
        }
        return { ref, settle };
      }
      function runSingle(taskId, opts = {}) {
        ensureEnabled();
        return dispatch2.dispatchTask(taskId, opts);
      }
      function runBoard(params = {}) {
        ensureEnabled();
        const title = requireString(params.title, "title");
        const question = requireString(params.question, "question");
        if (!Array.isArray(params.agents) || params.agents.length === 0) {
          throw httpError(400, "Body must include a non-empty 'agents' array");
        }
        const agents = params.agents.map((a) => requireString(a, "agents[]"));
        const actor = typeof params.actor === "string" && params.actor ? params.actor : "operator";
        const timeoutSec = normalizeTimeoutSec(params.timeoutSec, defaultTimeoutSec);
        const sequential = params.sequential === void 0 ? defaultSequentialBoard : params.sequential === true;
        const description = buildCardDescription({ question });
        const checkBudget = normalizeBudgetCheck(params.budgetCheck);
        emit({ type: "orchestrate.board_started", title, agents, actor });
        const runner = async () => {
          let budgetHalt = null;
          const budgetMs = timeoutSec * 1e3;
          const notDispatchedOutcome = (agent, taskId, budgetBlocked, dispatchError) => ({
            agent,
            taskId,
            text: null,
            ok: false,
            truncated: false,
            timedOut: false,
            budgetBlocked,
            dispatchError
          });
          let outcomes;
          if (sequential) {
            outcomes = [];
            for (let i = 0; i < agents.length; i += 1) {
              const agent = agents[i];
              if (budgetHalt) {
                outcomes.push(notDispatchedOutcome(agent, null, true, null));
                continue;
              }
              const block = checkBudget({ spentUSD: i });
              if (block) {
                budgetHalt = block;
                outcomes.push(notDispatchedOutcome(agent, null, true, null));
                continue;
              }
              const card = kanban.createTask({ title: `${title} \xB7 ${agent}`, description }, actor);
              const seatLease = leaseSeat(agent);
              const dispatchRef = seatLease ? seatLease.ref : agent;
              let dispatched;
              try {
                dispatched = dispatch2.dispatchTask(card.id, {
                  agent: dispatchRef,
                  actor,
                  isBoard: true
                });
              } catch (e) {
                if (seatLease) void seatLease.settle(false);
                outcomes.push(notDispatchedOutcome(agent, card.id, false, e.message));
                continue;
              }
              const raced = await withTimeout(
                dispatched.completion,
                budgetMs + COMPLETION_GRACE_MS,
                setTimerFn
              );
              const outcome = collectOutcome(card.id, dispatched, raced.settled);
              if (seatLease) await seatLease.settle(raced.settled && outcome.ok);
              outcomes.push({ ...outcome, taskId: card.id, budgetBlocked: false, dispatchError: null });
            }
          } else {
            const seats = agents.map((agent, i) => {
              if (budgetHalt) {
                return { agent, taskId: null, dispatched: null, error: null, budgetBlocked: true };
              }
              const block = checkBudget({ spentUSD: i });
              if (block) {
                budgetHalt = block;
                return { agent, taskId: null, dispatched: null, error: null, budgetBlocked: true };
              }
              const card = kanban.createTask({ title: `${title} \xB7 ${agent}`, description }, actor);
              const seatLease = leaseSeat(agent);
              const dispatchRef = seatLease ? seatLease.ref : agent;
              try {
                const dispatched = dispatch2.dispatchTask(card.id, {
                  agent: dispatchRef,
                  actor,
                  isBoard: true
                });
                return {
                  agent,
                  taskId: card.id,
                  dispatched,
                  error: null,
                  budgetBlocked: false,
                  seatLease
                };
              } catch (e) {
                if (seatLease) void seatLease.settle(false);
                return { agent, taskId: card.id, dispatched: null, error: e, budgetBlocked: false };
              }
            });
            outcomes = await Promise.all(
              seats.map(async (seat) => {
                if (!seat.dispatched) {
                  return notDispatchedOutcome(
                    seat.agent,
                    seat.taskId,
                    !!seat.budgetBlocked,
                    seat.error ? seat.error.message : null
                  );
                }
                const raced = await withTimeout(
                  seat.dispatched.completion,
                  budgetMs + COMPLETION_GRACE_MS,
                  setTimerFn
                );
                const outcome = collectOutcome(seat.taskId, seat.dispatched, raced.settled);
                if (seat.seatLease) await seat.seatLease.settle(raced.settled && outcome.ok);
                return { ...outcome, taskId: seat.taskId, budgetBlocked: false, dispatchError: null };
              })
            );
          }
          const results = outcomes.map(({ agent, text, ok, truncated, taskId }) => ({
            agent,
            taskId,
            text,
            ok,
            truncated
          }));
          const missing = outcomes.filter((o) => o.timedOut || o.dispatchError || o.budgetBlocked).map((o) => ({
            agent: o.agent,
            taskId: o.taskId,
            reason: o.budgetBlocked ? "budget" : o.timedOut ? "timeout" : `dispatch refused: ${o.dispatchError}`
          }));
          const truncatedAny = results.some((r) => r.truncated);
          emit({
            type: "orchestrate.board_completed",
            title,
            collected: results.filter((r) => r.ok).length,
            missing: missing.length
          });
          const anchor = outcomes.find((o) => o.taskId);
          return {
            taskId: anchor ? anchor.taskId : null,
            question,
            results,
            missing,
            truncatedAny,
            budgetHalt
          };
        };
        const { runId, entry, completion } = startRun({ mode: "board", agents, runner });
        return {
          runId,
          mode: "board",
          agents,
          status: "running",
          startedAt: entry.startedAt,
          completion
        };
      }
      function runChain(params = {}) {
        ensureEnabled();
        const title = requireString(params.title, "title");
        if (!Array.isArray(params.steps) || params.steps.length === 0) {
          throw httpError(400, "Body must include a non-empty 'steps' array");
        }
        const steps = params.steps.map((step, i) => {
          if (!step || typeof step !== "object") {
            throw httpError(400, `steps[${i}] must be an object`);
          }
          return {
            agent: requireString(step.agent, `steps[${i}].agent`),
            instruction: requireString(step.instruction, `steps[${i}].instruction`)
          };
        });
        const actor = typeof params.actor === "string" && params.actor ? params.actor : "operator";
        const timeoutSec = normalizeTimeoutSec(params.timeoutSec, defaultTimeoutSec);
        const budgetMs = timeoutSec * 1e3;
        const checkBudget = normalizeBudgetCheck(params.budgetCheck);
        emit({ type: "orchestrate.chain_started", title, steps: steps.length, actor });
        const runner = async () => {
          const results = [];
          let context = null;
          let final = null;
          let stoppedAt = null;
          let budgetHalt = null;
          for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            if (stoppedAt !== null) {
              results.push({
                agent: step.agent,
                taskId: null,
                text: null,
                ok: false,
                truncated: false,
                skipped: true
              });
              continue;
            }
            const block = checkBudget({ spentUSD: i });
            if (block) {
              budgetHalt = block;
              stoppedAt = i;
              results.push({
                agent: step.agent,
                taskId: null,
                text: null,
                ok: false,
                truncated: false,
                skipped: true,
                budgetBlocked: true
              });
              continue;
            }
            const description = buildCardDescription({ instruction: step.instruction, context });
            const card = kanban.createTask(
              { title: `${title} \xB7 step ${i + 1}/${steps.length} \xB7 ${step.agent}`, description },
              actor
            );
            const seatLease = leaseSeat(step.agent);
            const dispatchRef = seatLease ? seatLease.ref : step.agent;
            let dispatched;
            try {
              dispatched = dispatch2.dispatchTask(card.id, { agent: dispatchRef, actor });
            } catch (e) {
              if (seatLease) void seatLease.settle(false);
              results.push({
                agent: step.agent,
                taskId: card.id,
                text: null,
                ok: false,
                truncated: false,
                skipped: false,
                error: e.message
              });
              stoppedAt = i;
              continue;
            }
            const raced = await withTimeout(
              dispatched.completion,
              budgetMs + COMPLETION_GRACE_MS,
              setTimerFn
            );
            const outcome = collectOutcome(card.id, dispatched, raced.settled);
            if (seatLease) await seatLease.settle(raced.settled && outcome.ok);
            results.push({
              agent: step.agent,
              taskId: card.id,
              text: outcome.text,
              ok: outcome.ok,
              truncated: outcome.truncated,
              skipped: false,
              timedOut: outcome.timedOut
            });
            if (!outcome.ok || !outcome.text) {
              stoppedAt = i;
              continue;
            }
            context = outcome.text;
            final = outcome.text;
          }
          const ok = stoppedAt === null;
          emit({ type: "orchestrate.chain_completed", title, ok, stoppedAt });
          return { title, steps: results, final, ok, stoppedAt, budgetHalt };
        };
        const { runId, entry, completion } = startRun({
          mode: "chain",
          agents: steps.map((s) => s.agent),
          runner
        });
        return {
          runId,
          mode: "chain",
          agents: steps.map((s) => s.agent),
          status: "running",
          startedAt: entry.startedAt,
          completion
        };
      }
      function getStatus() {
        return {
          available: enabled,
          enabled,
          timeoutSec: defaultTimeoutSec,
          // M-2 — expose whether parallel pool routing is active and the projected
          // per-seat cost, so the route's PRE-DISPATCH budget gate can refuse a
          // wide parallel board BEFORE it fans K seats (the mid-run CLOSED re-check
          // can only halt later seats once they have already been dispatched).
          routeToPool,
          perSeatCostUSD: projectedSeatCostUSD()
        };
      }
      function projectedSeatCostUSD() {
        const v = Number(config && config.perSeatCostUSD);
        return Number.isFinite(v) && v > 0 ? v : 0;
      }
      return {
        runSingle,
        runBoard,
        runChain,
        getStatus,
        getRun,
        listRuns,
        waitForRun,
        projectedSeatCostUSD
      };
    }
    module2.exports = {
      createOrchestrate: createOrchestrate2,
      createRunRegistry,
      newRunId,
      withTimeout,
      readAttemptResultText,
      normalizeTimeoutSec,
      buildCardDescription,
      SYNC_WAIT_CAP_MS,
      RUN_TTL_MS,
      FAILURE_RESULT_COPY
    };
  }
});

// src/settings.js
var require_settings = __commonJS({
  "src/settings.js"(exports2, module2) {
    var fs2 = require("fs");
    var crypto = require("crypto");
    var { isSecretRef } = require_secrets();
    var INTERVAL_MIN_MS = 5e3;
    var INTERVAL_MAX_MS = 36e5;
    var MAX_URL_LENGTH = 2048;
    var MAX_CHANNEL_LENGTH = 120;
    var MAX_TOPIC_LENGTH = 256;
    var MAX_SECRET_LENGTH = 512;
    var MAX_WEBHOOKS = 20;
    var NTFY_TOPIC_RE = /^[A-Za-z0-9_-]+$/;
    var NTFY_DEFAULT_SERVER = "https://ntfy.sh";
    var ALERT_RULES = [
      "nodeOffline",
      "nodeUnreachable",
      "nodeRecovered",
      "taskFailed",
      "taskStale",
      "lessonPending",
      "budgetBreach",
      "dispatchComplete"
    ];
    var ALERT_SINK_NAMES = ["slack", "ntfy", "webhooks"];
    var BUDGET_USD_MAX = 1e6;
    var BUDGET_CHECK_MIN_MS = 6e4;
    var BUDGET_CHECK_MAX_MS = 864e5;
    var MAX_BUDGET_PROVIDERS = 50;
    var BUDGET_PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,63}$/;
    var FLAP_CONSECUTIVE_MIN = 1;
    var FLAP_CONSECUTIVE_MAX = 20;
    var FLAP_DURATION_MIN_MS = 0;
    var FLAP_DURATION_MAX_MS = 36e5;
    var MAX_MUTES = 50;
    var MAX_MUTE_NODE_LENGTH = 120;
    var EDITABLE_DEFAULTS = Object.freeze({
      alerts: {
        enabled: false,
        rules: {
          nodeOffline: true,
          nodeUnreachable: true,
          nodeRecovered: true,
          taskFailed: true,
          taskStale: true,
          lessonPending: true,
          budgetBreach: true,
          // Dispatch follow-through ping — opt-in, OFF by default.
          dispatchComplete: false
        },
        flap: { consecutive: 3, minDurationMs: 6e4 },
        mutes: [],
        sinks: {
          slack: { enabled: false, gatewayUrl: "", channel: "" },
          ntfy: { enabled: false, server: NTFY_DEFAULT_SERVER, topic: "" },
          webhooks: []
        }
      },
      mesh: { intervalMs: 15e3 },
      watchdog: { thresholdMs: 18e5 },
      validationGate: { default: true },
      federation: { intervalMs: 3e4 },
      budgets: {
        enabled: false,
        daily: { totalUSD: 0, perProvider: {} },
        weekly: { totalUSD: 0, perProvider: {} },
        checkIntervalMs: 9e5,
        enforce: { enabled: false },
        // Orchestration mode gate (src/orchestrate.js). OPEN is OFF by default;
        // closedCeilingUSD 0 = no per-orchestration ceiling.
        allowOpen: false,
        closedCeilingUSD: 0
      },
      digest: { enabled: false, schedule: "daily", hourUtc: 8, sinks: ["*"] }
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
    function requireUrl(value, label, { allowEmpty = false, allowSecretRef = false } = {}) {
      if (typeof value !== "string") throw badRequest(`${label} must be a string`);
      if (value === "") {
        if (allowEmpty) return value;
        throw badRequest(`${label} must not be empty`);
      }
      if (allowSecretRef && isSecretRef(value)) return value;
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
      if (isSecretRef(value)) return value;
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
      requireKnownKeys(
        patch,
        ["alerts", "mesh", "federation", "watchdog", "validationGate", "budgets", "digest"],
        "patch"
      );
      const result = {};
      if (patch.alerts !== void 0) {
        requireKnownKeys(
          patch.alerts,
          ["enabled", "rules", "flap", "mutes", "routing", "sinks"],
          "alerts"
        );
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
        if (patch.alerts.flap !== void 0) {
          alerts.flap = validateFlapPatch(patch.alerts.flap);
        }
        if (patch.alerts.mutes !== void 0) {
          alerts.mutes = validateMutes(patch.alerts.mutes);
        }
        if (patch.alerts.routing !== void 0) {
          alerts.routing = validateAlertRouting(patch.alerts.routing);
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
      if (patch.budgets !== void 0) {
        result.budgets = validateBudgetsPatch(patch.budgets);
      }
      if (patch.digest !== void 0) {
        result.digest = validateDigestPatch(patch.digest);
      }
      return result;
    }
    function validateBudgetUSD(value, label) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > BUDGET_USD_MAX) {
        throw badRequest(`${label} must be a number between 0 and ${BUDGET_USD_MAX} USD`);
      }
      return value;
    }
    function validateBudgetProviders(value, label) {
      if (!isPlainObject(value)) throw badRequest(`${label} must be an object`);
      const entries = Object.entries(value);
      if (entries.length > MAX_BUDGET_PROVIDERS) {
        throw badRequest(`${label}: too many providers (max ${MAX_BUDGET_PROVIDERS})`);
      }
      const out = {};
      for (const [provider, usd] of entries) {
        if (!BUDGET_PROVIDER_RE.test(provider)) {
          throw badRequest(`${label}: invalid provider name "${provider}"`);
        }
        const amount = validateBudgetUSD(usd, `${label}.${provider}`);
        if (amount <= 0) {
          throw badRequest(`${label}.${provider} must be greater than 0 (omit the entry to remove it)`);
        }
        out[provider] = amount;
      }
      return out;
    }
    function validateBudgetPeriodPatch(period, label) {
      requireKnownKeys(period, ["totalUSD", "perProvider"], label);
      const out = {};
      if (period.totalUSD !== void 0) {
        out.totalUSD = validateBudgetUSD(period.totalUSD, `${label}.totalUSD`);
      }
      if (period.perProvider !== void 0) {
        out.perProvider = validateBudgetProviders(period.perProvider, `${label}.perProvider`);
      }
      if (Object.keys(out).length === 0) {
        throw badRequest(`${label} must set totalUSD and/or perProvider`);
      }
      return out;
    }
    function validateBudgetsPatch(budgets) {
      requireKnownKeys(
        budgets,
        ["enabled", "daily", "weekly", "checkIntervalMs", "enforce", "allowOpen", "closedCeilingUSD"],
        "budgets"
      );
      const out = {};
      if (budgets.enabled !== void 0) {
        out.enabled = requireBool(budgets.enabled, "budgets.enabled");
      }
      if (budgets.allowOpen !== void 0) {
        out.allowOpen = requireBool(budgets.allowOpen, "budgets.allowOpen");
      }
      if (budgets.closedCeilingUSD !== void 0) {
        out.closedCeilingUSD = validateBudgetUSD(budgets.closedCeilingUSD, "budgets.closedCeilingUSD");
      }
      if (budgets.enforce !== void 0) {
        requireKnownKeys(budgets.enforce, ["enabled"], "budgets.enforce");
        if (budgets.enforce.enabled === void 0) {
          throw badRequest("budgets.enforce.enabled is required");
        }
        out.enforce = { enabled: requireBool(budgets.enforce.enabled, "budgets.enforce.enabled") };
      }
      if (budgets.daily !== void 0) {
        out.daily = validateBudgetPeriodPatch(budgets.daily, "budgets.daily");
      }
      if (budgets.weekly !== void 0) {
        out.weekly = validateBudgetPeriodPatch(budgets.weekly, "budgets.weekly");
      }
      if (budgets.checkIntervalMs !== void 0) {
        if (!Number.isInteger(budgets.checkIntervalMs) || budgets.checkIntervalMs < BUDGET_CHECK_MIN_MS || budgets.checkIntervalMs > BUDGET_CHECK_MAX_MS) {
          throw badRequest(
            `budgets.checkIntervalMs must be an integer between ${BUDGET_CHECK_MIN_MS} and ${BUDGET_CHECK_MAX_MS} ms`
          );
        }
        out.checkIntervalMs = budgets.checkIntervalMs;
      }
      if (Object.keys(out).length === 0) {
        throw badRequest(
          "budgets must set at least one of enabled/daily/weekly/checkIntervalMs/enforce/allowOpen/closedCeilingUSD"
        );
      }
      return out;
    }
    var DIGEST_SCHEDULES = ["daily", "weekly"];
    function validateDigestPatch(digest) {
      requireKnownKeys(digest, ["enabled", "schedule", "hourUtc", "sinks"], "digest");
      const out = {};
      if (digest.enabled !== void 0) {
        out.enabled = requireBool(digest.enabled, "digest.enabled");
      }
      if (digest.schedule !== void 0) {
        if (!DIGEST_SCHEDULES.includes(digest.schedule)) {
          throw badRequest('digest.schedule must be "daily" or "weekly"');
        }
        out.schedule = digest.schedule;
      }
      if (digest.hourUtc !== void 0) {
        if (!Number.isInteger(digest.hourUtc) || digest.hourUtc < 0 || digest.hourUtc > 23) {
          throw badRequest("digest.hourUtc must be an integer between 0 and 23");
        }
        out.hourUtc = digest.hourUtc;
      }
      if (digest.sinks !== void 0) {
        if (!Array.isArray(digest.sinks) || digest.sinks.length === 0) {
          throw badRequest("digest.sinks must be a non-empty array of sink names");
        }
        const seen = /* @__PURE__ */ new Set();
        for (const sink of digest.sinks) {
          if (sink !== "*" && !ALERT_SINK_NAMES.includes(sink)) {
            throw badRequest(`digest.sinks: unknown sink "${String(sink)}"`);
          }
          seen.add(sink);
        }
        out.sinks = seen.has("*") ? ["*"] : ALERT_SINK_NAMES.filter((sink) => seen.has(sink));
      }
      if (Object.keys(out).length === 0) {
        throw badRequest("digest must set at least one of enabled/schedule/hourUtc/sinks");
      }
      return out;
    }
    function buildEffectiveDigest(raw, defaults) {
      const src = isPlainObject(raw) ? raw : {};
      let sinks = Array.isArray(src.sinks) ? src.sinks.filter((sink) => sink === "*" || ALERT_SINK_NAMES.includes(sink)) : [...defaults.sinks];
      if (sinks.length === 0 || sinks.includes("*")) sinks = ["*"];
      return {
        enabled: typeof src.enabled === "boolean" ? src.enabled : defaults.enabled,
        schedule: DIGEST_SCHEDULES.includes(src.schedule) ? src.schedule : defaults.schedule,
        hourUtc: Number.isInteger(src.hourUtc) && src.hourUtc >= 0 && src.hourUtc <= 23 ? src.hourUtc : defaults.hourUtc,
        sinks
      };
    }
    function validateFlapPatch(flap) {
      requireKnownKeys(flap, ["consecutive", "minDurationMs"], "alerts.flap");
      const out = {};
      if (flap.consecutive !== void 0) {
        if (!Number.isInteger(flap.consecutive) || flap.consecutive < FLAP_CONSECUTIVE_MIN || flap.consecutive > FLAP_CONSECUTIVE_MAX) {
          throw badRequest(
            `alerts.flap.consecutive must be an integer between ${FLAP_CONSECUTIVE_MIN} and ${FLAP_CONSECUTIVE_MAX}`
          );
        }
        out.consecutive = flap.consecutive;
      }
      if (flap.minDurationMs !== void 0) {
        if (!Number.isInteger(flap.minDurationMs) || flap.minDurationMs < FLAP_DURATION_MIN_MS || flap.minDurationMs > FLAP_DURATION_MAX_MS) {
          throw badRequest(
            `alerts.flap.minDurationMs must be an integer between ${FLAP_DURATION_MIN_MS} and ${FLAP_DURATION_MAX_MS} ms`
          );
        }
        out.minDurationMs = flap.minDurationMs;
      }
      if (Object.keys(out).length === 0) {
        throw badRequest("alerts.flap must set consecutive and/or minDurationMs");
      }
      return out;
    }
    function validateMutes(mutes) {
      if (!Array.isArray(mutes)) throw badRequest("alerts.mutes must be an array");
      if (mutes.length > MAX_MUTES) throw badRequest(`Too many mutes (max ${MAX_MUTES})`);
      return mutes.map((entry, i) => {
        requireKnownKeys(entry, ["rule", "node", "until"], `alerts.mutes[${i}]`);
        const out = {};
        if (entry.rule !== void 0) {
          if (!ALERT_RULES.includes(entry.rule)) {
            throw badRequest(`alerts.mutes[${i}].rule: unknown rule "${String(entry.rule)}"`);
          }
          out.rule = entry.rule;
        }
        if (entry.node !== void 0) {
          if (typeof entry.node !== "string" || entry.node.length === 0 || entry.node.length > MAX_MUTE_NODE_LENGTH) {
            throw badRequest(
              `alerts.mutes[${i}].node must be a non-empty string (max ${MAX_MUTE_NODE_LENGTH} chars)`
            );
          }
          out.node = entry.node;
        }
        if (out.rule === void 0 && out.node === void 0) {
          throw badRequest(`alerts.mutes[${i}] must set rule and/or node`);
        }
        if (entry.until !== void 0 && entry.until !== null) {
          const ms = typeof entry.until === "number" ? entry.until : Date.parse(entry.until);
          if (!Number.isFinite(ms)) {
            throw badRequest(`alerts.mutes[${i}].until must be an ISO timestamp or epoch ms`);
          }
          out.until = new Date(ms).toISOString();
        }
        return out;
      });
    }
    function validateAlertRouting(routing) {
      requireKnownKeys(routing, ALERT_RULES, "alerts.routing");
      const out = {};
      for (const [rule, sinks] of Object.entries(routing)) {
        if (!Array.isArray(sinks) || sinks.length === 0) {
          throw badRequest(`alerts.routing.${rule} must be a non-empty array of sink names`);
        }
        const seen = /* @__PURE__ */ new Set();
        for (const sink of sinks) {
          if (sink !== "*" && !ALERT_SINK_NAMES.includes(sink)) {
            throw badRequest(`alerts.routing.${rule}: unknown sink "${String(sink)}"`);
          }
          seen.add(sink);
        }
        out[rule] = seen.has("*") ? ["*"] : ALERT_SINK_NAMES.filter((sink) => seen.has(sink));
      }
      if (Object.keys(out).length === 0) {
        throw badRequest("alerts.routing must set at least one rule");
      }
      return out;
    }
    function normalizeAlertRouting(raw) {
      const src = isPlainObject(raw) ? raw : {};
      return Object.fromEntries(
        ALERT_RULES.map((rule) => {
          const entry = src[rule];
          if (!Array.isArray(entry) || entry.includes("*")) return [rule, ["*"]];
          const known = ALERT_SINK_NAMES.filter((sink) => entry.includes(sink));
          return [rule, known.length > 0 ? known : ["*"]];
        })
      );
    }
    function validateSlackPatch(slack) {
      requireKnownKeys(slack, ["enabled", "gatewayUrl", "channel"], "alerts.sinks.slack");
      const out = {};
      if (slack.enabled !== void 0) {
        out.enabled = requireBool(slack.enabled, "alerts.sinks.slack.enabled");
      }
      if (slack.gatewayUrl !== void 0) {
        out.gatewayUrl = requireUrl(slack.gatewayUrl, "alerts.sinks.slack.gatewayUrl", {
          allowEmpty: true,
          allowSecretRef: true
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
    function normalizeMutes(raw) {
      const list = Array.isArray(raw) ? raw : [];
      return list.filter((m) => isPlainObject(m)).map((m) => {
        const entry = {};
        if (typeof m.rule === "string" && m.rule.length > 0) entry.rule = m.rule;
        if (typeof m.node === "string" && m.node.length > 0) entry.node = m.node;
        if (typeof m.until === "string" || typeof m.until === "number") entry.until = m.until;
        return entry;
      }).filter((m) => m.rule !== void 0 || m.node !== void 0);
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
      const flap = isPlainObject(alerts.flap) ? alerts.flap : {};
      return {
        alerts: {
          enabled: pickBool(alerts.enabled, d.alerts.enabled),
          rules: Object.fromEntries(
            ALERT_RULES.map((rule) => [rule, pickBool(rules[rule], d.alerts.rules[rule])])
          ),
          flap: {
            consecutive: pickInt(flap.consecutive, d.alerts.flap.consecutive),
            minDurationMs: pickInt(flap.minDurationMs, d.alerts.flap.minDurationMs)
          },
          mutes: normalizeMutes(alerts.mutes),
          routing: normalizeAlertRouting(alerts.routing),
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
        },
        budgets: buildEffectiveBudgets(src.budgets, d.budgets),
        digest: buildEffectiveDigest(src.digest, d.digest)
      };
    }
    function buildEffectiveBudgets(raw, defaults) {
      const src = isPlainObject(raw) ? raw : {};
      const period = (rawPeriod, dPeriod) => {
        const p = isPlainObject(rawPeriod) ? rawPeriod : {};
        const perProvider = {};
        if (isPlainObject(p.perProvider)) {
          for (const [provider, usd] of Object.entries(p.perProvider)) {
            if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) {
              perProvider[provider] = usd;
            }
          }
        }
        return {
          totalUSD: typeof p.totalUSD === "number" && Number.isFinite(p.totalUSD) && p.totalUSD >= 0 ? p.totalUSD : dPeriod.totalUSD,
          perProvider
        };
      };
      return {
        enabled: typeof src.enabled === "boolean" ? src.enabled : defaults.enabled,
        daily: period(src.daily, defaults.daily),
        weekly: period(src.weekly, defaults.weekly),
        checkIntervalMs: Number.isInteger(src.checkIntervalMs) ? src.checkIntervalMs : defaults.checkIntervalMs,
        enforce: {
          enabled: isPlainObject(src.enforce) && typeof src.enforce.enabled === "boolean" ? src.enforce.enabled : defaults.enforce.enabled
        },
        allowOpen: typeof src.allowOpen === "boolean" ? src.allowOpen : defaults.allowOpen,
        closedCeilingUSD: typeof src.closedCeilingUSD === "number" && Number.isFinite(src.closedCeilingUSD) && src.closedCeilingUSD >= 0 ? src.closedCeilingUSD : defaults.closedCeilingUSD
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
              hasSecret: typeof secret === "string" && secret.length > 0,
              ...isSecretRef(secret) ? { secretRef: secret } : {}
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
    function createSettings2({ configPath, onChange, onBudgetsChange, onDigestChange } = {}) {
      if (typeof configPath !== "string" || configPath.length === 0) {
        throw new TypeError("configPath is required");
      }
      if (onChange !== void 0 && typeof onChange !== "function") {
        throw new TypeError("onChange must be a function when provided");
      }
      if (onBudgetsChange !== void 0 && typeof onBudgetsChange !== "function") {
        throw new TypeError("onBudgetsChange must be a function when provided");
      }
      if (onDigestChange !== void 0 && typeof onDigestChange !== "function") {
        throw new TypeError("onDigestChange must be a function when provided");
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
      function getBudgetsConfig() {
        const raw = readConfigFile();
        return buildEffective(raw.fleet).budgets;
      }
      function getDigestConfig() {
        const raw = readConfigFile();
        return buildEffective(raw.fleet).digest;
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
          if (validated.alerts.flap) {
            alertsNext.flap = { ...before.alerts.flap, ...validated.alerts.flap };
          }
          if (validated.alerts.mutes) {
            alertsNext.mutes = validated.alerts.mutes;
          }
          if (validated.alerts.routing) {
            alertsNext.routing = { ...before.alerts.routing, ...validated.alerts.routing };
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
        if (validated.budgets) {
          const budgetsBefore = isPlainObject(fleetBefore.budgets) ? fleetBefore.budgets : {};
          const budgetsNext = { ...budgetsBefore };
          if (validated.budgets.enabled !== void 0) budgetsNext.enabled = validated.budgets.enabled;
          if (validated.budgets.checkIntervalMs !== void 0) {
            budgetsNext.checkIntervalMs = validated.budgets.checkIntervalMs;
          }
          if (validated.budgets.enforce !== void 0) {
            budgetsNext.enforce = { ...validated.budgets.enforce };
          }
          for (const period of ["daily", "weekly"]) {
            if (validated.budgets[period]) {
              budgetsNext[period] = {
                ...before.budgets[period],
                ...validated.budgets[period]
              };
            }
          }
          next.budgets = budgetsNext;
        }
        if (validated.digest) {
          const digestBefore = isPlainObject(fleetBefore.digest) ? fleetBefore.digest : {};
          next.digest = { ...digestBefore, ...validated.digest };
        }
        const after = buildEffective(next);
        const changed = changedPaths(before, after);
        if (changed.length > 0) {
          writeConfigFile({ ...raw, fleet: next });
          console.log(`[Settings] ${actor} updated: ${changed.join(", ")}`);
        }
        const alertsChanged = changed.some((p) => p === "alerts" || p.startsWith("alerts."));
        const budgetsChanged = changed.some((p) => p === "budgets" || p.startsWith("budgets."));
        const digestChanged = changed.some((p) => p === "digest" || p.startsWith("digest."));
        const hotApplyAlerts = typeof onChange === "function";
        const hotApplyBudgets = typeof onBudgetsChange === "function";
        const hotApplyDigest = typeof onDigestChange === "function";
        const restartRequired = changed.filter((p) => {
          if (RESTART_PATHS.has(p)) return true;
          if (p === "alerts" || p.startsWith("alerts.")) return !hotApplyAlerts;
          if (p === "budgets" || p.startsWith("budgets.")) return !hotApplyBudgets;
          if (p === "digest" || p.startsWith("digest.")) return !hotApplyDigest;
          return false;
        });
        if (alertsChanged && hotApplyAlerts) {
          try {
            onChange(after.alerts);
          } catch (err) {
            console.error("[Settings] onChange hook failed:", err.message);
          }
        }
        if (budgetsChanged && hotApplyBudgets) {
          try {
            onBudgetsChange(after.budgets);
          } catch (err) {
            console.error("[Settings] onBudgetsChange hook failed:", err.message);
          }
        }
        if (digestChanged && hotApplyDigest) {
          try {
            onDigestChange(after.digest);
          } catch (err) {
            console.error("[Settings] onDigestChange hook failed:", err.message);
          }
        }
        return { applied: redact(after), restartRequired };
      }
      return { get, update, getAlertsConfig, getBudgetsConfig, getDigestConfig };
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

// src/docker-pool.js
var require_docker_pool = __commonJS({
  "src/docker-pool.js"(exports2, module2) {
    var http2 = require("http");
    var DOCKER_API_VERSION = "v1.41";
    var DEFAULT_SOCKET_PATH = "/var/run/docker.sock";
    var DEFAULT_REQUEST_TIMEOUT_MS = 1e4;
    var DEFAULT_STOP_GRACE_SECONDS = 10;
    var EVENTS_RECONNECT_DELAY_MS = 2e3;
    function encodeFilters(filters) {
      return encodeURIComponent(JSON.stringify(filters));
    }
    function parseNdjsonChunk(chunk, remainder) {
      const combined = remainder + chunk;
      const lines = combined.split("\n");
      const remainder2 = lines.pop();
      const events = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          events.push(JSON.parse(trimmed));
        } catch (_) {
        }
      }
      return { events, remainder: remainder2 };
    }
    function createDockerPool2(options = {}) {
      const {
        socketPath = DEFAULT_SOCKET_PATH,
        requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
        stopGraceSeconds = DEFAULT_STOP_GRACE_SECONDS,
        requestFn = http2.request
      } = options;
      function socketRequest(method, apiPath, timeoutMs = requestTimeoutMs) {
        return new Promise((resolve, reject) => {
          const req = requestFn(
            {
              socketPath,
              path: apiPath,
              method,
              headers: { Host: "docker", "Content-Length": 0 }
            },
            (res) => {
              const chunks = [];
              res.on("data", (chunk) => chunks.push(chunk));
              res.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                resolve({
                  ok: res.statusCode >= 200 && res.statusCode < 300,
                  status: res.statusCode,
                  body,
                  json: () => JSON.parse(body)
                });
              });
              res.on("error", reject);
            }
          );
          req.setTimeout(timeoutMs, () => {
            req.destroy(
              new Error(`[DockerPool] Request timeout after ${timeoutMs}ms: ${method} ${apiPath}`)
            );
          });
          req.on("error", reject);
          req.end();
        });
      }
      async function ps(opts = {}) {
        const all = opts.all !== false;
        const filters = opts.filters || {};
        const params = new URLSearchParams();
        if (all) params.set("all", "true");
        if (Object.keys(filters).length > 0) {
          params.set("filters", encodeFilters(filters));
        }
        const qs = params.toString() ? `?${params.toString()}` : "";
        const apiPath = `/${DOCKER_API_VERSION}/containers/json${all ? "?all=true" : ""}${Object.keys(filters).length > 0 ? (all ? "&" : "?") + "filters=" + encodeFilters(filters) : ""}`;
        const res = await socketRequest("GET", apiPath);
        if (!res.ok) {
          throw new Error(`[DockerPool] ps failed (${res.status}): ${res.body}`);
        }
        const list = res.json();
        return Array.isArray(list) ? list : [];
      }
      async function start(name) {
        if (!name || typeof name !== "string") throw new Error("[DockerPool] start: name is required");
        const apiPath = `/${DOCKER_API_VERSION}/containers/${encodeURIComponent(name)}/start`;
        const res = await socketRequest("POST", apiPath);
        if (!res.ok && res.status !== 304) {
          throw new Error(`[DockerPool] start(${name}) failed (${res.status}): ${res.body}`);
        }
      }
      async function stop(name, opts = {}) {
        if (!name || typeof name !== "string") throw new Error("[DockerPool] stop: name is required");
        const grace = opts.graceful === false ? 0 : stopGraceSeconds;
        const apiPath = `/${DOCKER_API_VERSION}/containers/${encodeURIComponent(name)}/stop?t=${grace}`;
        const timeoutMs = Math.max(requestTimeoutMs, (grace + 5) * 1e3);
        const res = await socketRequest("POST", apiPath, timeoutMs);
        if (!res.ok && res.status !== 304) {
          throw new Error(`[DockerPool] stop(${name}) failed (${res.status}): ${res.body}`);
        }
      }
      async function inspect(name) {
        if (!name || typeof name !== "string")
          throw new Error("[DockerPool] inspect: name is required");
        const apiPath = `/${DOCKER_API_VERSION}/containers/${encodeURIComponent(name)}/json`;
        const res = await socketRequest("GET", apiPath);
        if (!res.ok) {
          throw new Error(`[DockerPool] inspect(${name}) failed (${res.status}): ${res.body}`);
        }
        return res.json();
      }
      function subscribeEvents(handler) {
        if (typeof handler !== "function")
          throw new Error("[DockerPool] subscribeEvents: handler must be a function");
        const filters = {
          type: ["container"],
          label: ["com.ofc.pool=worker"]
        };
        const apiPath = `/${DOCKER_API_VERSION}/events?filters=` + encodeFilters(filters);
        let active = true;
        let currentReq = null;
        let reconnectTimer = null;
        function connect() {
          if (!active) return;
          let remainder = "";
          const req = requestFn(
            {
              socketPath,
              path: apiPath,
              method: "GET",
              headers: { Host: "docker" }
            },
            (res) => {
              if (res.statusCode !== 200) {
                res.resume();
                scheduleReconnect();
                return;
              }
              res.on("data", (chunk) => {
                if (!active) return;
                const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
                const { events, remainder: rem } = parseNdjsonChunk(text, remainder);
                remainder = rem;
                for (const evt of events) {
                  try {
                    handler(evt);
                  } catch (_) {
                  }
                }
              });
              res.on("end", () => {
                scheduleReconnect();
              });
              res.on("error", () => {
                scheduleReconnect();
              });
            }
          );
          req.on("error", () => {
            scheduleReconnect();
          });
          req.end();
          currentReq = req;
        }
        function scheduleReconnect() {
          if (!active) return;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, EVENTS_RECONNECT_DELAY_MS);
        }
        connect();
        return function unsubscribe() {
          active = false;
          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }
          if (currentReq) {
            try {
              currentReq.destroy();
            } catch (_) {
            }
            currentReq = null;
          }
        };
      }
      return { ps, start, stop, inspect, subscribeEvents };
    }
    module2.exports = {
      createDockerPool: createDockerPool2,
      encodeFilters,
      parseNdjsonChunk,
      DEFAULT_STOP_GRACE_SECONDS,
      EVENTS_RECONNECT_DELAY_MS
    };
  }
});

// src/usage-sources/claude-code.js
var require_claude_code = __commonJS({
  "src/usage-sources/claude-code.js"(exports2, module2) {
    var fs2 = require("fs");
    var os2 = require("os");
    var path2 = require("path");
    var { TOKEN_RATES, calculateCostForBucket } = require_tokens();
    var DAY_MS = 24 * 60 * 60 * 1e3;
    var MAX_SCAN_DEPTH = 4;
    var PS_TIMEOUT_MS = 5e3;
    function defaultExecFn(cmd, args2, options = {}) {
      return new Promise((resolve) => {
        let execFile2;
        try {
          execFile2 = require("child_process").execFile;
        } catch (e) {
          resolve({ error: e, stdout: "", stderr: "" });
          return;
        }
        execFile2(
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
      const projectsDir = options.projectsDir || path2.join(os2.homedir(), ".claude", "projects");
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
    var os2 = require("os");
    var path2 = require("path");
    var { parsePsOutput } = require_claude_code();
    var PS_TIMEOUT_MS = 5e3;
    var PREVIEW_LENGTH = 120;
    var MAX_SESSION_SCAN_DEPTH = 5;
    function defaultExecFn(cmd, args2, options = {}) {
      return new Promise((resolve) => {
        let execFile2;
        try {
          execFile2 = require("child_process").execFile;
        } catch (e) {
          resolve({ error: e, stdout: "", stderr: "" });
          return;
        }
        execFile2(
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
      const codexDir = options.codexDir || path2.join(os2.homedir(), ".codex");
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
    var os2 = require("os");
    var path2 = require("path");
    var DEFAULT_DB_PATH = path2.join(
      os2.homedir(),
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
    var os2 = require("os");
    var path2 = require("path");
    var DEFAULT_STATS_PATH = path2.join(os2.homedir(), ".headroom", "subscription_state.json");
    var STALE_AFTER_MS = 30 * 60 * 1e3;
    function toFiniteOrNull2(value) {
      if (value === null || value === void 0 || value === "") return null;
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    }
    function normalizeWindow(window) {
      if (!window || typeof window !== "object") return null;
      return {
        utilizationPct: toFiniteOrNull2(window.utilization_pct),
        resetsAt: window.resets_at ?? null,
        secondsToReset: toFiniteOrNull2(window.seconds_to_reset)
      };
    }
    function normalizeExtraUsage(extra) {
      if (!extra || typeof extra !== "object") return null;
      return {
        isEnabled: Boolean(extra.is_enabled),
        monthlyLimitUsd: Number(extra.monthly_limit_usd) || 0,
        usedCreditsUsd: Number(extra.used_credits_usd) || 0,
        utilizationPct: toFiniteOrNull2(extra.utilization_pct)
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
    var { defaultSecrets } = require_secrets();
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
      const secrets = options.secrets || defaultSecrets;
      const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
      const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
      const available = apiKey.length > 0;
      const isRef = secrets.isSecretRef(apiKey);
      function effectiveKey() {
        if (!isRef) return apiKey;
        const result = secrets.resolveSync(apiKey);
        return result.ok ? result.value : null;
      }
      function scrub(text, key) {
        const message = String(text || "");
        return key ? message.split(key).join("[redacted]") : message;
      }
      async function request(pathname) {
        if (!available) {
          return { error: "OpenRouter API key not configured" };
        }
        const key = effectiveKey();
        if (key === null) {
          return { error: "OpenRouter API key (1Password ref) could not be resolved" };
        }
        const controller = typeof globalThis.AbortController === "function" ? new globalThis.AbortController() : null;
        const timer = setTimeout(() => {
          if (controller) controller.abort();
        }, timeoutMs);
        try {
          const res = await fetchFn(`${baseUrl}${pathname}`, {
            method: "GET",
            headers: { Authorization: `Bearer ${key}` },
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
          const reason = e && e.name === "AbortError" ? `request timed out after ${timeoutMs}ms` : scrub(e.message, key);
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
    var os2 = require("os");
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
      const home = os2.homedir();
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
        fetchFn: config.fetchFn,
        secrets: config.secrets
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

// src/hermes-agents.js
var require_hermes_agents = __commonJS({
  "src/hermes-agents.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var ACTIVE_THRESHOLD_MS = 10 * 60 * 1e3;
    function agentIdFromSessionKey(sessionKey) {
      if (typeof sessionKey !== "string") return "hermes";
      const parts = sessionKey.split(":");
      if (parts[0] === "agent" && typeof parts[1] === "string" && parts[1].length > 0) {
        return parts[1];
      }
      return "hermes";
    }
    function parseTimestamp(value) {
      if (typeof value !== "string" || value.length === 0) return null;
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? ms : null;
    }
    function summarizeHermesSessions(sessionsBody) {
      const summaries = {};
      if (!sessionsBody || typeof sessionsBody !== "object" || Array.isArray(sessionsBody)) {
        return summaries;
      }
      for (const [key, session] of Object.entries(sessionsBody)) {
        const agentId = agentIdFromSessionKey(
          session && typeof session.session_key === "string" ? session.session_key : key
        );
        const prev = summaries[agentId] || { sessionCount: 0, lastActiveAt: null };
        const updatedAt = parseTimestamp(session && session.updated_at) ?? parseTimestamp(session && session.created_at);
        summaries[agentId] = {
          sessionCount: prev.sessionCount + 1,
          lastActiveAt: updatedAt !== null && (prev.lastActiveAt === null || updatedAt > prev.lastActiveAt) ? updatedAt : prev.lastActiveAt
        };
      }
      return summaries;
    }
    function parseHermesModel(yamlText) {
      if (typeof yamlText !== "string") return null;
      const lines = yamlText.split("\n");
      const start = lines.findIndex((line) => /^model:\s*$/.test(line));
      if (start === -1) return null;
      let model = null;
      let provider = null;
      for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        if (!/^\s/.test(line)) break;
        const match = line.match(/^\s+(default|provider):\s*(.+?)\s*$/);
        if (!match) continue;
        const value = match[2].replace(/^['"]|['"]$/g, "");
        if (match[1] === "default") model = value || null;
        else provider = value || null;
      }
      if (!model) return null;
      return provider ? `${provider}/${model}` : model;
    }
    function createHermesAgents(options = {}) {
      const { hermesDir, nowFn = Date.now } = options;
      if (!hermesDir || typeof hermesDir !== "string") {
        throw new Error("createHermesAgents requires a hermesDir string");
      }
      function readSessions() {
        const sessionsPath = path2.join(hermesDir, "sessions", "sessions.json");
        let raw;
        try {
          raw = fs2.readFileSync(sessionsPath, "utf8");
        } catch (err) {
          return {};
        }
        try {
          const parsed = JSON.parse(raw);
          return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        } catch (err) {
          console.error(`[HermesAgents] Malformed sessions.json at ${sessionsPath}:`, err.message);
          return {};
        }
      }
      function readModel() {
        try {
          return parseHermesModel(fs2.readFileSync(path2.join(hermesDir, "config.yaml"), "utf8"));
        } catch (err) {
          return null;
        }
      }
      function readWorkspace() {
        const workspace = path2.join(hermesDir, "workspace");
        try {
          return fs2.statSync(workspace).isDirectory() ? workspace : null;
        } catch (err) {
          return null;
        }
      }
      function listAgents() {
        const now = nowFn();
        const model = readModel();
        const workspace = readWorkspace();
        const summaries = summarizeHermesSessions(readSessions());
        const ids = Object.keys(summaries);
        if (ids.length === 0) {
          return [
            {
              id: "hermes",
              name: "Hermes",
              model,
              workspace,
              subagentsMax: null,
              sessionCount: 0,
              lastActiveAt: null,
              active: false,
              source: "hermes"
            }
          ];
        }
        return ids.sort().map((id) => {
          const { sessionCount, lastActiveAt } = summaries[id];
          return {
            id,
            name: id === "main" || id === "hermes" ? "Hermes" : `Hermes ${id}`,
            model,
            workspace,
            subagentsMax: null,
            sessionCount,
            lastActiveAt,
            active: lastActiveAt !== null && now - lastActiveAt < ACTIVE_THRESHOLD_MS,
            source: "hermes"
          };
        });
      }
      return { listAgents };
    }
    module2.exports = {
      createHermesAgents,
      summarizeHermesSessions,
      agentIdFromSessionKey,
      parseHermesModel,
      ACTIVE_THRESHOLD_MS
    };
  }
});

// src/agents-roster.js
var require_agents_roster = __commonJS({
  "src/agents-roster.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var os2 = require("os");
    var { createHermesAgents } = require_hermes_agents();
    var AGENT_SOURCES = ["openclaw", "hermes", "none"];
    var ACTIVE_THRESHOLD_MS = 10 * 60 * 1e3;
    var FLEET_CACHE_MS = 60 * 1e3;
    var REMOTE_TIMEOUT_MS = 5e3;
    function parseAgentsConfig(config) {
      const agents = config && typeof config === "object" ? config.agents : null;
      if (!agents || typeof agents !== "object" || !Array.isArray(agents.list)) return [];
      const defaults = agents.defaults && typeof agents.defaults === "object" ? agents.defaults : {};
      const defaultModel = typeof defaults.model === "string" ? defaults.model : defaults.model && typeof defaults.model.primary === "string" ? defaults.model.primary : null;
      const defaultWorkspace = typeof defaults.workspace === "string" ? defaults.workspace : null;
      const defaultSubagentsMax = Number.isFinite(defaults.subagents?.maxConcurrent) ? defaults.subagents.maxConcurrent : null;
      const records = [];
      for (const entry of agents.list) {
        if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id) continue;
        const subagentsMax = Number.isFinite(entry.subagents?.maxConcurrent) ? entry.subagents.maxConcurrent : defaultSubagentsMax;
        records.push({
          id: entry.id,
          name: typeof entry.name === "string" && entry.name ? entry.name : entry.id,
          model: typeof entry.model === "string" && entry.model ? entry.model : defaultModel,
          workspace: typeof entry.workspace === "string" && entry.workspace ? entry.workspace : defaultWorkspace,
          subagentsMax
        });
      }
      return records;
    }
    function isSessionFile(filename) {
      return filename.endsWith(".jsonl") && !filename.endsWith(".trajectory.jsonl") && !filename.includes(".deleted.");
    }
    function scanSessionsDir(sessionsDir) {
      let files;
      try {
        files = fs2.readdirSync(sessionsDir);
      } catch (err) {
        return { sessionCount: 0, lastActiveAt: null };
      }
      let sessionCount = 0;
      let lastActiveAt = null;
      for (const file of files) {
        if (!isSessionFile(file)) continue;
        sessionCount++;
        try {
          const mtimeMs = fs2.statSync(path2.join(sessionsDir, file)).mtimeMs;
          if (lastActiveAt === null || mtimeMs > lastActiveAt) lastActiveAt = mtimeMs;
        } catch (err) {
        }
      }
      return { sessionCount, lastActiveAt };
    }
    function nodeBaseUrl(nodeUrl) {
      try {
        return new URL(nodeUrl).origin;
      } catch (err) {
        return null;
      }
    }
    function defaultAgentsConfig() {
      try {
        const { CONFIG: CONFIG2 } = require_config();
        return CONFIG2 && CONFIG2.fleet && CONFIG2.fleet.agents || {};
      } catch (err) {
        return {};
      }
    }
    function createAgentsRoster2(options = {}) {
      const {
        mesh = null,
        federationStateFn = null,
        fetchFn = (...args2) => globalThis.fetch(...args2),
        nowFn = Date.now,
        hostname = os2.hostname(),
        fleetCacheMs = FLEET_CACHE_MS,
        remoteTimeoutMs = REMOTE_TIMEOUT_MS
      } = options;
      const agentsConfig = options.agentsConfig && typeof options.agentsConfig === "object" ? options.agentsConfig : defaultAgentsConfig();
      const source = AGENT_SOURCES.includes(agentsConfig.source) ? agentsConfig.source : "openclaw";
      const openclawConfigPath = typeof agentsConfig.openclawConfigPath === "string" && agentsConfig.openclawConfigPath || options.openclawConfigPath;
      const agentsDir = typeof agentsConfig.agentsDir === "string" && agentsConfig.agentsDir || options.agentsDir;
      if (source === "openclaw") {
        if (!openclawConfigPath || typeof openclawConfigPath !== "string") {
          throw new Error("createAgentsRoster requires an openclawConfigPath string");
        }
        if (!agentsDir || typeof agentsDir !== "string") {
          throw new Error("createAgentsRoster requires an agentsDir string");
        }
      }
      const hermesAgents = options.hermesAgents && typeof options.hermesAgents.listAgents === "function" ? options.hermesAgents : source === "hermes" ? createHermesAgents({
        hermesDir: typeof agentsConfig.hermesDir === "string" && agentsConfig.hermesDir || path2.join(os2.homedir(), ".hermes"),
        nowFn
      }) : null;
      let fleetCache = null;
      function timeoutSignal(ms) {
        if (globalThis.AbortSignal && typeof globalThis.AbortSignal.timeout === "function") {
          return globalThis.AbortSignal.timeout(ms);
        }
        return void 0;
      }
      function readConfigAgents() {
        let raw;
        try {
          raw = fs2.readFileSync(openclawConfigPath, "utf8");
        } catch (err) {
          return [];
        }
        try {
          return parseAgentsConfig(JSON.parse(raw));
        } catch (err) {
          console.error(`[Agents] Malformed config at ${openclawConfigPath}:`, err.message);
          return [];
        }
      }
      function readLocalAgents(now) {
        if (source === "none") return [];
        if (source === "hermes") {
          try {
            const agents = hermesAgents.listAgents();
            return Array.isArray(agents) ? agents : [];
          } catch (err) {
            console.error("[Agents] Hermes adapter failed:", err.message);
            return [];
          }
        }
        return readConfigAgents().map((agent) => {
          const { sessionCount, lastActiveAt } = scanSessionsDir(
            path2.join(agentsDir, agent.id, "sessions")
          );
          return {
            ...agent,
            sessionCount,
            lastActiveAt,
            active: lastActiveAt !== null && now - lastActiveAt < ACTIVE_THRESHOLD_MS,
            source: "openclaw"
          };
        });
      }
      function getLocalRoster() {
        const now = nowFn();
        const agents = readLocalAgents(now);
        return {
          hostname,
          agents,
          counts: { total: agents.length, active: agents.filter((a) => a.active).length },
          timestamp: now
        };
      }
      async function fetchAgentsEndpoint(base) {
        try {
          const res = await fetchFn(`${base}/api/agents`, { signal: timeoutSignal(remoteTimeoutMs) });
          if (!res || res.ok !== true) return null;
          const body = await res.json();
          if (!body || !Array.isArray(body.agents)) return null;
          return {
            hostname: typeof body.hostname === "string" && body.hostname ? body.hostname : null,
            agents: body.agents
          };
        } catch (err) {
          return null;
        }
      }
      function attributeRemoteAgent(agent, nodeName, via) {
        if (!agent || typeof agent !== "object" || typeof agent.id !== "string" || !agent.id) {
          return null;
        }
        return {
          id: agent.id,
          name: typeof agent.name === "string" && agent.name ? agent.name : agent.id,
          model: typeof agent.model === "string" ? agent.model : null,
          workspace: typeof agent.workspace === "string" ? agent.workspace : null,
          subagentsMax: Number.isFinite(agent.subagentsMax) ? agent.subagentsMax : null,
          sessionCount: Number.isFinite(agent.sessionCount) ? agent.sessionCount : 0,
          lastActiveAt: Number.isFinite(agent.lastActiveAt) ? agent.lastActiveAt : null,
          active: agent.active === true,
          source: AGENT_SOURCES.includes(agent.source) ? agent.source : "openclaw",
          node: nodeName,
          via
        };
      }
      async function collectRemoteAgents() {
        if (!mesh || typeof mesh.getState !== "function") return [];
        let meshState;
        try {
          meshState = await mesh.getState();
        } catch (err) {
          console.error("[Agents] Mesh state unavailable:", err.message);
          return [];
        }
        const nodes = Array.isArray(meshState && meshState.nodes) ? meshState.nodes : [];
        const online = nodes.filter(
          (n) => n && n.health && n.health.status === "online" && typeof n.url === "string" && n.hostname !== hostname
          // never double-count this host
        );
        const results = await Promise.all(
          online.map(async (node) => {
            const base = nodeBaseUrl(node.url);
            return { node, fetched: base ? await fetchAgentsEndpoint(base) : null };
          })
        );
        const remote = [];
        for (const { node, fetched } of results) {
          if (!fetched) continue;
          for (const agent of fetched.agents) {
            const attributed = attributeRemoteAgent(agent, node.hostname, "mesh");
            if (attributed) remote.push(attributed);
          }
        }
        return remote;
      }
      async function collectFederationAgents(meshHostnames) {
        if (typeof federationStateFn !== "function") return [];
        let state2;
        try {
          state2 = await federationStateFn();
        } catch (err) {
          console.error("[Agents] Federation state unavailable:", err.message);
          return [];
        }
        const remotes = Array.isArray(state2 && state2.remotes) ? state2.remotes : [];
        const reachable = remotes.filter(
          (r) => r && typeof r.baseUrl === "string" && nodeBaseUrl(r.baseUrl) !== null && (r.reachable === true || r.status && r.status.reachable === true)
        );
        const results = await Promise.all(
          reachable.map(async (remote) => ({
            remote,
            fetched: await fetchAgentsEndpoint(nodeBaseUrl(remote.baseUrl))
          }))
        );
        const collected = [];
        for (const { remote, fetched } of results) {
          if (!fetched) continue;
          if (fetched.hostname && meshHostnames.has(fetched.hostname)) continue;
          const nodeName = fetched.hostname && fetched.hostname !== hostname ? fetched.hostname : typeof remote.label === "string" && remote.label || new URL(remote.baseUrl).hostname;
          for (const agent of fetched.agents) {
            const attributed = attributeRemoteAgent(agent, nodeName, "federation");
            if (attributed) collected.push(attributed);
          }
        }
        return collected;
      }
      function buildRoster(localAgents, remoteAgents) {
        const agents = [...localAgents.map((agent) => ({ ...agent, node: hostname })), ...remoteAgents];
        const byNode = {};
        for (const agent of agents) {
          byNode[agent.node] = [...byNode[agent.node] || [], agent];
        }
        return {
          agents,
          byNode,
          counts: {
            total: agents.length,
            active: agents.filter((a) => a.active).length,
            nodes: Object.keys(byNode).length
          },
          timestamp: nowFn()
        };
      }
      async function getRoster() {
        const now = nowFn();
        if (fleetCache && now - fleetCache.at < fleetCacheMs) return fleetCache.roster;
        const meshAgents = await collectRemoteAgents();
        const meshHostnames = new Set(meshAgents.map((a) => a.node));
        const federationAgents = await collectFederationAgents(meshHostnames);
        const roster = buildRoster(getLocalRoster().agents, [...meshAgents, ...federationAgents]);
        fleetCache = { at: now, roster };
        return roster;
      }
      async function getAssignees() {
        const roster = await getRoster();
        const values = /* @__PURE__ */ new Set();
        for (const agent of roster.agents) {
          values.add(agent.id);
          values.add(`${agent.id}@${agent.node}`);
        }
        return [...values].sort((a, b) => a.localeCompare(b));
      }
      const routes = {
        "GET /api/agents": async (req, res) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(getLocalRoster(), null, 2));
        },
        "GET /api/agents/fleet": async (req, res) => {
          const roster = await getRoster();
          const assignees = await getAssignees();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ...roster, assignees }, null, 2));
        }
      };
      return { getLocalRoster, getRoster, getAssignees, routes };
    }
    module2.exports = {
      createAgentsRoster: createAgentsRoster2,
      parseAgentsConfig,
      scanSessionsDir,
      isSessionFile,
      nodeBaseUrl,
      ACTIVE_THRESHOLD_MS,
      FLEET_CACHE_MS,
      REMOTE_TIMEOUT_MS
    };
  }
});

// src/agent-locator.js
var require_agent_locator = __commonJS({
  "src/agent-locator.js"(exports2, module2) {
    function nodeBaseUrl(node) {
      const url = String(node.url || "");
      const healthPath = typeof node.healthPath === "string" ? node.healthPath : "/health";
      return url.endsWith(healthPath) ? url.slice(0, -healthPath.length) : url;
    }
    var OFC_DASHBOARD_HEALTH_PATH = "/api/health";
    function pickDashboardNode(meshNodes, hostname) {
      const matches = meshNodes.filter((n) => n && n.hostname === hostname);
      if (matches.length === 0) return null;
      if (matches.length === 1) return matches[0];
      return matches.find((n) => n.healthPath === OFC_DASHBOARD_HEALTH_PATH) || matches.find((n) => nodeBaseUrl(n).endsWith("/api")) || matches[0];
    }
    function createAgentLocator2({ rosterFn, meshFn, selfNode }) {
      if (typeof rosterFn !== "function") {
        throw new Error("createAgentLocator requires a rosterFn function");
      }
      if (typeof meshFn !== "function") {
        throw new Error("createAgentLocator requires a meshFn function");
      }
      async function resolve(agentRef) {
        const [agentId, pinnedNode] = String(agentRef).split("@");
        const roster = await rosterFn();
        const agents = Array.isArray(roster && roster.agents) ? roster.agents : [];
        const matches = agents.filter((a) => a && a.id === agentId);
        if (matches.length === 0) {
          return { kind: "unknown", agentId };
        }
        const chosen = pinnedNode && matches.find((a) => a.node === pinnedNode) || matches.find((a) => a.node === selfNode) || matches[0];
        if (chosen.node === selfNode) return { kind: "local", agentId };
        const mesh = await meshFn();
        const meshNodes = Array.isArray(mesh && mesh.nodes) ? mesh.nodes : [];
        const node = pickDashboardNode(meshNodes, chosen.node);
        if (!node) return { kind: "unreachable", agentId, node: chosen.node };
        return {
          kind: "remote",
          agentId,
          node: chosen.node,
          baseUrl: nodeBaseUrl(node),
          online: !!(node.health && node.health.status === "online")
        };
      }
      return { resolve };
    }
    module2.exports = { createAgentLocator: createAgentLocator2 };
  }
});

// src/spawn-store.js
var require_spawn_store = __commonJS({
  "src/spawn-store.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var { DatabaseSync } = require("node:sqlite");
    var DB_FILE_NAME = "spawn-store.db";
    var DEDUP_TTL_MS = 10 * 60 * 1e3;
    function createSpawnStore2({ stateDir, nowFn = Date.now } = {}) {
      if (typeof stateDir !== "string" || stateDir.length === 0) {
        throw new TypeError("stateDir must be a non-empty string");
      }
      fs2.mkdirSync(stateDir, { recursive: true });
      const db = new DatabaseSync(path2.join(stateDir, DB_FILE_NAME));
      db.exec("PRAGMA journal_mode=WAL");
      db.exec("PRAGMA synchronous=NORMAL");
      db.exec("PRAGMA busy_timeout=5000");
      db.exec(`
    CREATE TABLE IF NOT EXISTS slack_event_dedup (
      event_id  TEXT    PRIMARY KEY,
      seen_at   INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
      const insertDedupStmt = db.prepare(`
    INSERT INTO slack_event_dedup (event_id, seen_at, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT (event_id) DO NOTHING
  `);
      const pruneExpiredStmt = db.prepare("DELETE FROM slack_event_dedup WHERE expires_at < ?");
      function insertDedup(eventId) {
        if (typeof eventId !== "string" || eventId.length === 0) {
          throw new TypeError("eventId must be a non-empty string");
        }
        const now = nowFn();
        const result = insertDedupStmt.run(eventId, now, now + DEDUP_TTL_MS);
        pruneExpiredStmt.run(now);
        return { isDuplicate: Number(result.changes) === 0 };
      }
      function pruneDedup() {
        const result = pruneExpiredStmt.run(nowFn());
        return Number(result.changes);
      }
      db.exec(`
    CREATE TABLE IF NOT EXISTS fencing_counter (
      id    INTEGER PRIMARY KEY CHECK(id = 1),
      value INTEGER NOT NULL
    )
  `);
      db.exec("INSERT OR IGNORE INTO fencing_counter (id, value) VALUES (1, 0)");
      const nextTokenStmt = db.prepare(
        "UPDATE fencing_counter SET value = value + 1 WHERE id = 1 RETURNING value"
      );
      function nextToken() {
        const row = nextTokenStmt.get();
        return Number(row.value);
      }
      db.exec(`
    CREATE TABLE IF NOT EXISTS result_high_water (
      node_id    TEXT    NOT NULL,
      generation INTEGER NOT NULL,
      token      INTEGER NOT NULL,
      PRIMARY KEY (node_id, generation)
    )
  `);
      const getHighWaterStmt = db.prepare(
        "SELECT token FROM result_high_water WHERE node_id = ? AND generation = ?"
      );
      const upsertHighWaterStmt = db.prepare(`
    INSERT INTO result_high_water (node_id, generation, token)
    VALUES (?, ?, ?)
    ON CONFLICT (node_id, generation) DO UPDATE SET token = excluded.token
      WHERE excluded.token > result_high_water.token
  `);
      const clearHighWaterStmt = db.prepare("DELETE FROM result_high_water");
      function createResultSink() {
        const highWater = /* @__PURE__ */ new Map();
        function durableHighWater(nodeId, generation) {
          const row = getHighWaterStmt.get(nodeId, generation);
          return row && row.token != null ? Number(row.token) : void 0;
        }
        function accept(nodeId, generation, token, result) {
          if (typeof nodeId !== "string" || nodeId.length === 0) {
            throw new TypeError("nodeId must be a non-empty string");
          }
          if (!Number.isFinite(generation)) {
            throw new TypeError("generation must be a finite number");
          }
          if (!Number.isFinite(token)) {
            throw new TypeError("token must be a finite number");
          }
          const key = `${nodeId}:${generation}`;
          let current = durableHighWater(nodeId, generation);
          if (current === void 0) current = highWater.get(key);
          if (current !== void 0 && token < current) {
            return { accepted: false, reason: "stale_token" };
          }
          upsertHighWaterStmt.run(nodeId, generation, token);
          highWater.set(key, Math.max(current === void 0 ? token : current, token));
          return { accepted: true, reason: null, result };
        }
        function reset() {
          highWater.clear();
          clearHighWaterStmt.run();
        }
        return { accept, reset };
      }
      function close() {
        try {
          db.close();
        } catch (e) {
          console.error("[SpawnStore] Failed to close database:", e.message);
        }
      }
      return { insertDedup, pruneDedup, nextToken, createResultSink, close };
    }
    module2.exports = { createSpawnStore: createSpawnStore2 };
  }
});

// src/agent-spawn.js
var require_agent_spawn = __commonJS({
  "src/agent-spawn.js"(exports2, module2) {
    var POOL_LABEL = "com.ofc.pool";
    var POOL_LABEL_VALUE = "worker";
    var STATE = Object.freeze({
      IDLE: "idle",
      LEASED: "leased",
      DRAINING: "draining",
      REMOVED: "removed"
    });
    var REASON = Object.freeze({
      DISABLED: "disabled",
      QUEUED: "queued",
      QUEUE_FULL: "queue_full",
      QUEUE_TIMEOUT: "queue_timeout",
      CAPACITY: "capacity",
      READINESS: "readiness",
      MISCAP: "miscap",
      NO_WORKER: "no_worker"
    });
    var BYTES_PER_GIB = 1024 * 1024 * 1024;
    function escapeRegExp(s) {
      return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    function createAgentSpawn2({
      config,
      mesh,
      roster,
      store,
      docker: docker2,
      logger = console,
      nowFn = Date.now,
      jitterFn = Math.random,
      probeHealthFn = null,
      readMemAvailableFn = null
    } = {}) {
      const spawnCfg = config && config.fleet && config.fleet.spawn || {};
      const enabled = spawnCfg.enabled === true;
      const workerNamePrefix = spawnCfg.workerNamePrefix && String(spawnCfg.workerNamePrefix).trim() || config && config.fleet && config.fleet.dispatch && typeof config.fleet.dispatch.node === "string" && config.fleet.dispatch.node.trim() || "";
      const workerNamePattern = workerNamePrefix ? new RegExp(`^${escapeRegExp(workerNamePrefix)}-worker-[a-z0-9-]+$`) : null;
      function isInstanceWorkerName(name) {
        if (typeof name !== "string" || name.length === 0) return false;
        if (!workerNamePattern) return false;
        return workerNamePattern.test(name);
      }
      const pool = /* @__PURE__ */ new Map();
      const queues = /* @__PURE__ */ new Map();
      let eventsUnsub = null;
      let reaperTimer = null;
      let reconcileTimer = null;
      let registrationTimer = null;
      const VALID_TRANSITIONS = /* @__PURE__ */ new Map([
        [`${STATE.IDLE}->${STATE.LEASED}`, true],
        [`${STATE.IDLE}->${STATE.DRAINING}`, true],
        [`${STATE.LEASED}->${STATE.IDLE}`, true],
        [`${STATE.LEASED}->${STATE.DRAINING}`, true],
        [`${STATE.DRAINING}->${STATE.REMOVED}`, true]
      ]);
      function cas(workerId, expectedState, nextState, expectedGeneration, patch = {}) {
        const w = pool.get(workerId);
        if (!w) return false;
        if (w.state !== expectedState) return false;
        if (w.generation !== expectedGeneration) return false;
        if (!VALID_TRANSITIONS.get(`${expectedState}->${nextState}`)) return false;
        w.state = nextState;
        if (nextState === STATE.IDLE) w.idleSince = nowFn();
        Object.assign(w, patch);
        return true;
      }
      function activeWorkerCount() {
        let n = 0;
        for (const w of pool.values()) {
          if (w.state === STATE.LEASED || w.state === STATE.IDLE || w.state === STATE.DRAINING) n++;
        }
        return n;
      }
      function admitCapacity(readMemAvailableFn2) {
        const workerMem = Number(spawnCfg.workerMemBytes) || Math.round(2.5 * BYTES_PER_GIB);
        const poolCeiling = Number(spawnCfg.poolCeiling) || 8;
        const ramBudget = Number(spawnCfg.ramBudgetBytes) || Math.floor(0.8 * 32 * BYTES_PER_GIB);
        const baseBytes = 5 * BYTES_PER_GIB;
        const margin = Math.round(0.5 * BYTES_PER_GIB);
        const active = activeWorkerCount();
        if (active >= poolCeiling) return { ok: false, reason: REASON.CAPACITY };
        const projected = (active + 1) * workerMem + baseBytes;
        if (projected > ramBudget) return { ok: false, reason: REASON.CAPACITY };
        if (typeof readMemAvailableFn2 === "function") {
          let memAvailable;
          try {
            memAvailable = Number(readMemAvailableFn2());
          } catch (e) {
            memAvailable = NaN;
          }
          if (Number.isFinite(memAvailable) && memAvailable < workerMem + margin) {
            return { ok: false, reason: REASON.CAPACITY };
          }
        }
        return { ok: true, reason: null };
      }
      async function listPoolContainers() {
        return docker2.ps({
          all: true,
          filters: { label: [`${POOL_LABEL}=${POOL_LABEL_VALUE}`] }
        });
      }
      function findStoppedWorker(containers) {
        if (!Array.isArray(containers)) return null;
        for (const c of containers) {
          const name = containerName(c);
          const state2 = String(c.State || c.state || "").toLowerCase();
          const tracked = pool.get(name);
          const isStopped = state2 !== "running" || c.running === false;
          if (isStopped && (!tracked || tracked.state === STATE.REMOVED)) {
            return c;
          }
        }
        return null;
      }
      function containerName(c) {
        if (!c) return "";
        if (Array.isArray(c.Names) && c.Names.length) return c.Names[0].replace(/^\//, "");
        if (typeof c.Name === "string") return c.Name.replace(/^\//, "");
        if (typeof c.name === "string") return c.name.replace(/^\//, "");
        if (typeof c.Id === "string") return c.Id;
        if (typeof c.id === "string") return c.id;
        return "";
      }
      function verifyCap(inspect) {
        const hostConfig = inspect && (inspect.HostConfig || inspect.hostConfig) || {};
        const mem = Number(hostConfig.Memory);
        const memSwap = Number(hostConfig.MemorySwap);
        const expected = Number(spawnCfg.workerMemBytes) || 2684354560;
        if (mem !== expected) return false;
        if (memSwap !== mem) return false;
        return true;
      }
      async function awaitReadiness(worker, probeFn) {
        const needed = Number(spawnCfg.readinessOks) || 3;
        const timeoutMs = Number(spawnCfg.readinessTimeoutMs) || 1e4;
        const deadline = nowFn() + timeoutMs;
        let consecutive = 0;
        while (nowFn() < deadline) {
          let ok = false;
          try {
            ok = await probeFn(worker) === true;
          } catch (e) {
            ok = false;
          }
          consecutive = ok ? consecutive + 1 : 0;
          if (consecutive >= needed) return true;
        }
        return false;
      }
      function beginDrain(workerId) {
        const w = pool.get(workerId);
        if (!w) return false;
        if (w.state === STATE.IDLE) return cas(workerId, STATE.IDLE, STATE.DRAINING, w.generation);
        if (w.state === STATE.LEASED) return cas(workerId, STATE.LEASED, STATE.DRAINING, w.generation);
        return false;
      }
      async function settleAndRemove(workerId) {
        const w = pool.get(workerId);
        if (!w || w.state !== STATE.DRAINING) return false;
        const gen = w.generation;
        try {
          await docker2.stop(w.containerName, { graceful: true });
        } catch (e) {
          logger.warn(`[AgentSpawn] docker stop failed for ${w.containerName}: ${e.message}`);
        }
        await unregisterWorker(w);
        cas(workerId, STATE.DRAINING, STATE.REMOVED, gen, { registered: false, nodeId: null });
        pool.delete(workerId);
        return true;
      }
      async function unregisterWorker(w) {
        if (!w || !w.nodeId) return;
        try {
          await mesh.unregisterNode(w.nodeId);
        } catch (e) {
          logger.warn(`[AgentSpawn] unregister tolerated for ${w.nodeId}: ${e.message}`);
        }
      }
      function refreshRegistrations() {
        const ttl = Number(spawnCfg.registrationTtlMs) || 3e5;
        const now = nowFn();
        for (const w of [...pool.values()]) {
          if (!w.registered) continue;
          if (w.registeredAt != null && now - w.registeredAt > ttl) {
            logger.warn(`[AgentSpawn] registration TTL lapsed for ${w.nodeId}; evicting`);
            void evictDead(w.workerId);
          } else {
            w.registeredAt = now;
          }
        }
      }
      async function evictDead(workerId) {
        const w = pool.get(workerId);
        if (!w) return;
        await unregisterWorker(w);
        w.state = STATE.DRAINING;
        cas(workerId, STATE.DRAINING, STATE.REMOVED, w.generation, {
          registered: false,
          nodeId: null
        });
        pool.delete(workerId);
      }
      function onDockerEvent(evt) {
        if (!evt || typeof evt !== "object") return;
        const action = String(evt.Action || evt.action || "").toLowerCase();
        const isDeath = action === "die" || action === "oom" || action === "stop" || action === "kill";
        if (!isDeath) return;
        if (!eventCarriesPoolLabel(evt)) return;
        const name = eventContainerName(evt);
        if (!name) return;
        const tracked = pool.get(name);
        if (!tracked) return;
        const evtId = eventContainerId(evt);
        if (tracked.containerId && evtId && evtId !== tracked.containerId) {
          logger.warn(
            `[AgentSpawn] ignoring die event for ${name}: container id ${evtId} does not match tracked id ${tracked.containerId} (name collision)`
          );
          return;
        }
        void evictDead(name);
      }
      function eventCarriesPoolLabel(evt) {
        const actor = evt.Actor || evt.actor;
        const attrs = actor && (actor.Attributes || actor.attributes) || null;
        if (!attrs || typeof attrs !== "object") return false;
        return attrs[POOL_LABEL] === POOL_LABEL_VALUE;
      }
      function eventContainerName(evt) {
        const actor = evt.Actor || evt.actor;
        const attrs = actor && (actor.Attributes || actor.attributes) || null;
        if (attrs && typeof attrs.name === "string") {
          return attrs.name.replace(/^\//, "");
        }
        if (typeof evt.name === "string") return evt.name.replace(/^\//, "");
        return "";
      }
      function eventContainerId(evt) {
        const actor = evt.Actor || evt.actor;
        if (actor && typeof actor.ID === "string" && actor.ID) return actor.ID;
        if (actor && typeof actor.id === "string" && actor.id) return actor.id;
        if (typeof evt.id === "string" && evt.id) return evt.id;
        if (typeof evt.Id === "string" && evt.Id) return evt.Id;
        return null;
      }
      async function reconcile(opts = {}) {
        if (!enabled) return { registered: 0, unregistered: 0, stopped: 0 };
        const probeFn = opts.probeFn || probeHealthFn || (async () => true);
        const [containers, meshState] = await Promise.all([
          listPoolContainers().catch(() => []),
          Promise.resolve(mesh.getState ? mesh.getState() : { nodes: [] }).catch(() => ({ nodes: [] }))
        ]);
        const meshNodes = Array.isArray(meshState && meshState.nodes) ? meshState.nodes : [];
        const meshByName = /* @__PURE__ */ new Map();
        for (const n of meshNodes) {
          if (n && typeof n.hostname === "string") meshByName.set(n.hostname, n);
        }
        const liveNames = /* @__PURE__ */ new Set();
        let registered = 0;
        let unregistered = 0;
        let stopped = 0;
        for (const c of Array.isArray(containers) ? containers : []) {
          const name = containerName(c);
          if (!name) continue;
          const state2 = String(c.State || c.state || "").toLowerCase();
          const isRunning = state2 === "running" || c.running === true;
          if (!isRunning) continue;
          if (!isInstanceWorkerName(name)) {
            logger.warn(
              `[AgentSpawn] reconcile: container ${name} carries the pool label but does not match this instance's worker pattern; refusing to register/adopt`
            );
            continue;
          }
          liveNames.add(name);
          const inMesh = meshByName.has(name);
          const tracked = pool.get(name);
          if (inMesh && tracked) continue;
          if (!inMesh) {
            const cap = admitCapacity(opts.readMemAvailableFn || readMemAvailableFn);
            if (!cap.ok) {
              try {
                await docker2.stop(name, { graceful: true });
                stopped++;
              } catch (e) {
                logger.warn(`[AgentSpawn] reconcile stop failed for ${name}: ${e.message}`);
              }
              continue;
            }
            const worker = trackWorker(name, { running: true, containerId: containerIdOf(c) });
            const ready = await awaitReadiness(worker, probeFn);
            if (!ready) {
              beginDrain(worker.workerId);
              await settleAndRemove(worker.workerId);
              stopped++;
              continue;
            }
            const ok = await registerWorker(worker, c);
            if (ok) registered++;
          } else if (inMesh && !tracked) {
            const node = meshByName.get(name);
            const worker = trackWorker(name, { running: true, containerId: containerIdOf(c) });
            worker.registered = true;
            worker.nodeId = node && node.id ? node.id : null;
            worker.registeredAt = nowFn();
            cas(worker.workerId, STATE.IDLE, STATE.IDLE, worker.generation);
          }
        }
        for (const n of meshNodes) {
          if (!n || typeof n.hostname !== "string") continue;
          if (!isPoolNode(n)) continue;
          if (liveNames.has(n.hostname)) continue;
          try {
            await mesh.unregisterNode(n.id || n.hostname);
            unregistered++;
          } catch (e) {
            logger.warn(`[AgentSpawn] reconcile unregister tolerated: ${e.message}`);
          }
          const tracked = pool.get(n.hostname);
          if (tracked) {
            tracked.state = STATE.DRAINING;
            cas(n.hostname, STATE.DRAINING, STATE.REMOVED, tracked.generation);
            pool.delete(n.hostname);
          }
        }
        return { registered, unregistered, stopped };
      }
      function isPoolNode(node) {
        return node && (node.registeredBy === "spawn" || node.label === POOL_LABEL_VALUE);
      }
      function trackWorker(containerName2, { running, containerId } = {}) {
        const existing = pool.get(containerName2);
        const generation = existing ? existing.generation + 1 : 0;
        const worker = {
          workerId: containerName2,
          containerName: containerName2,
          // H-1 — record the docker container ID so eviction can bind to the exact
          // tracked container, not just the name (a recycled-name collision across
          // generations must never evict a different container).
          containerId: containerId || null,
          nodeId: null,
          generation,
          state: STATE.IDLE,
          idleSince: nowFn(),
          startedAt: nowFn(),
          recycleAt: computeRecycleAt(),
          token: null,
          registered: false,
          registeredAt: null
        };
        pool.set(containerName2, worker);
        return worker;
      }
      function containerIdOf(c) {
        if (!c) return null;
        if (typeof c.Id === "string" && c.Id) return c.Id;
        if (typeof c.id === "string" && c.id) return c.id;
        return null;
      }
      function computeRecycleAt() {
        const base = Number(spawnCfg.maxLifetimeMs) || 36e5;
        const jitterWindow = Number(spawnCfg.recycleJitterMs) || 5e3;
        const jitter = Math.floor(jitterFn() * jitterWindow);
        return nowFn() + base + jitter;
      }
      async function registerWorker(worker, container) {
        if (!isInstanceWorkerName(worker.containerName)) {
          logger.warn(
            `[AgentSpawn] refusing to register ${worker.containerName}: not an instance worker name`
          );
          return false;
        }
        try {
          const port = workerPort(container);
          const record = await mesh.registerNode({
            hostname: worker.containerName,
            port,
            healthPath: workerHealthPath(container),
            platform: "linux",
            label: POOL_LABEL_VALUE,
            registeredBy: "spawn"
          });
          worker.nodeId = record && record.id ? record.id : null;
          worker.registered = true;
          worker.registeredAt = nowFn();
          return true;
        } catch (e) {
          logger.warn(`[AgentSpawn] register failed for ${worker.containerName}: ${e.message}`);
          return false;
        }
      }
      function pinnedWorkerPort() {
        const p = Number(spawnCfg.workerPort);
        return Number.isInteger(p) && p > 0 && p <= 65535 ? p : null;
      }
      function workerPort(container) {
        const pinned = pinnedWorkerPort();
        if (pinned !== null) return pinned;
        const labels = container && (container.Labels || container.labels) || {};
        const p = Number(labels[`${POOL_LABEL}.port`]);
        return Number.isInteger(p) && p > 0 && p <= 65535 ? p : 443;
      }
      function workerHealthPath(container) {
        const labels = container && (container.Labels || container.labels) || {};
        const hp = labels[`${POOL_LABEL}.healthPath`];
        return typeof hp === "string" && hp.startsWith("/") ? hp : "/api/health";
      }
      async function acquireWorker(advisorId, opts = {}) {
        if (!enabled) return { ok: false, reason: REASON.DISABLED };
        const cap = admitCapacity(opts.readMemAvailableFn || readMemAvailableFn);
        if (!cap.ok) return { ok: false, reason: cap.reason };
        const containers = await listPoolContainers();
        const target = findStoppedWorker(containers);
        if (!target) return { ok: false, reason: REASON.NO_WORKER };
        const name = containerName(target);
        await docker2.start(name);
        const worker = trackWorker(name, { running: true, containerId: containerIdOf(target) });
        const inspect = await docker2.inspect(name);
        if (!verifyCap(inspect)) {
          logger.warn(`[AgentSpawn] worker ${name} mis-capped; draining`);
          beginDrain(worker.workerId);
          await settleAndRemove(worker.workerId);
          return { ok: false, reason: REASON.MISCAP };
        }
        const probeFn = opts.probeFn || probeHealthFn || (async () => true);
        const ready = await awaitReadiness(worker, probeFn);
        if (!ready) {
          logger.warn(`[AgentSpawn] worker ${name} never reached readiness; draining`);
          beginDrain(worker.workerId);
          await settleAndRemove(worker.workerId);
          return { ok: false, reason: REASON.READINESS };
        }
        const registered = await registerWorker(worker, inspect.Config ? inspect : target);
        if (!registered) {
          beginDrain(worker.workerId);
          await settleAndRemove(worker.workerId);
          return { ok: false, reason: REASON.READINESS };
        }
        return { ok: true, worker };
      }
      function lease(workerId) {
        if (!enabled) return null;
        const w = pool.get(workerId);
        if (!w || w.state !== STATE.IDLE) return null;
        const token = store && typeof store.nextToken === "function" ? store.nextToken() : null;
        const ok = cas(workerId, STATE.IDLE, STATE.LEASED, w.generation, { token });
        if (!ok) return null;
        return { workerId, nodeId: w.nodeId, generation: w.generation, token };
      }
      function release(workerId, generation) {
        const w = pool.get(workerId);
        if (!w) return false;
        return cas(workerId, STATE.LEASED, STATE.IDLE, generation);
      }
      async function reapIdle() {
        if (!enabled) return 0;
        const idleReapMs = Number(spawnCfg.idleReapMs) || 6e4;
        const now = nowFn();
        let reaped = 0;
        for (const w of [...pool.values()]) {
          if (w.state !== STATE.IDLE) continue;
          if (now - w.idleSince < idleReapMs) continue;
          if (beginDrain(w.workerId)) {
            await settleAndRemove(w.workerId);
            reaped++;
          }
        }
        return reaped;
      }
      async function recycleAged() {
        if (!enabled) return 0;
        const now = nowFn();
        let recycled = 0;
        for (const w of [...pool.values()]) {
          if (w.state === STATE.DRAINING || w.state === STATE.REMOVED) continue;
          if (now < w.recycleAt) continue;
          if (w.state === STATE.LEASED) {
            cas(w.workerId, STATE.LEASED, STATE.DRAINING, w.generation);
            recycled++;
          } else if (w.state === STATE.IDLE) {
            if (beginDrain(w.workerId)) {
              await settleAndRemove(w.workerId);
              recycled++;
            }
          }
        }
        return recycled;
      }
      function admit(advisorId, opts = {}) {
        if (!enabled) return { admitted: false, reason: REASON.DISABLED };
        if (hasIdleWorker()) return { admitted: true, reason: REASON.QUEUED };
        const cap = admitCapacity(opts.readMemAvailableFn);
        if (cap.ok) return { admitted: true, reason: REASON.QUEUED };
        const queueMax = Number(spawnCfg.queueMax) || 100;
        const q = queues.get(advisorId) || [];
        if (q.length >= queueMax) return { admitted: false, reason: REASON.QUEUE_FULL };
        const entry = { advisorId, enqueuedAt: nowFn() };
        q.push(entry);
        queues.set(advisorId, q);
        return { admitted: false, reason: REASON.QUEUED };
      }
      function hasIdleWorker() {
        for (const w of pool.values()) {
          if (w.state === STATE.IDLE) return true;
        }
        return false;
      }
      function sweepQueueDeadlines() {
        const deadlineMs = Number(spawnCfg.queueDeadlineMs) || 3e4;
        const now = nowFn();
        const timedOut = [];
        for (const [advisorId, q] of queues) {
          const kept = [];
          for (const entry of q) {
            if (now - entry.enqueuedAt >= deadlineMs) {
              timedOut.push({ advisorId, reason: REASON.QUEUE_TIMEOUT });
            } else {
              kept.push(entry);
            }
          }
          if (kept.length) queues.set(advisorId, kept);
          else queues.delete(advisorId);
        }
        return timedOut;
      }
      function queueDepth(advisorId) {
        const q = queues.get(advisorId);
        return q ? q.length : 0;
      }
      function start() {
        if (!enabled) return;
        if (typeof docker2.subscribeEvents === "function" && !eventsUnsub) {
          eventsUnsub = docker2.subscribeEvents(onDockerEvent);
        }
        void reconcile().catch((e) => logger.error(`[AgentSpawn] reconcile failed: ${e.message}`));
        const reconcileMs = Number(spawnCfg.reconcileMs) || 5e3;
        reconcileTimer = setInterval(() => {
          void reconcile().catch((e) => logger.error(`[AgentSpawn] reconcile failed: ${e.message}`));
        }, reconcileMs);
        if (reconcileTimer.unref) reconcileTimer.unref();
        const idleReapMs = Number(spawnCfg.idleReapMs) || 6e4;
        reaperTimer = setInterval(() => {
          void reapIdle().catch((e) => logger.error(`[AgentSpawn] reaper failed: ${e.message}`));
          void recycleAged().catch((e) => logger.error(`[AgentSpawn] recycle failed: ${e.message}`));
        }, idleReapMs);
        if (reaperTimer.unref) reaperTimer.unref();
        const ttlMs = Math.max(1e3, Math.floor((Number(spawnCfg.registrationTtlMs) || 3e5) / 4));
        registrationTimer = setInterval(() => refreshRegistrations(), ttlMs);
        if (registrationTimer.unref) registrationTimer.unref();
        logger.info("[AgentSpawn] controller started (pool enabled)");
      }
      function stop() {
        if (eventsUnsub) {
          try {
            eventsUnsub();
          } catch (e) {
          }
          eventsUnsub = null;
        }
        for (const t of [reconcileTimer, reaperTimer, registrationTimer]) {
          if (t) clearInterval(t);
        }
        reconcileTimer = reaperTimer = registrationTimer = null;
      }
      function getPoolState() {
        return {
          enabled,
          workers: [...pool.values()].map((w) => ({
            workerId: w.workerId,
            nodeId: w.nodeId,
            generation: w.generation,
            state: w.state,
            registered: w.registered,
            token: w.token
          })),
          counts: {
            total: pool.size,
            idle: [...pool.values()].filter((w) => w.state === STATE.IDLE).length,
            leased: [...pool.values()].filter((w) => w.state === STATE.LEASED).length,
            draining: [...pool.values()].filter((w) => w.state === STATE.DRAINING).length
          }
        };
      }
      return {
        enabled,
        start,
        stop,
        // Core engine
        acquireWorker,
        lease,
        release,
        beginDrain,
        settleAndRemove,
        cas,
        // Loops (also exposed for deterministic test driving)
        reapIdle,
        recycleAged,
        reconcile,
        refreshRegistrations,
        admit,
        sweepQueueDeadlines,
        // Helpers
        admitCapacity,
        awaitReadiness,
        verifyCap,
        trackWorker,
        getPoolState,
        queueDepth,
        onDockerEvent,
        // Constants for tests / wiring
        STATE,
        REASON,
        POOL_LABEL,
        POOL_LABEL_VALUE
      };
    }
    module2.exports = {
      createAgentSpawn: createAgentSpawn2,
      STATE,
      REASON,
      POOL_LABEL,
      POOL_LABEL_VALUE
    };
  }
});

// src/flight-recorder.js
var require_flight_recorder = __commonJS({
  "src/flight-recorder.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var EVENT_TYPES = Object.freeze([
      "session.start",
      "session.end",
      "dispatch",
      "dispatch.result",
      "cron.run",
      "audit",
      "note"
    ]);
    var DEFAULT_LIMIT = 200;
    var MAX_LIMIT = 1e3;
    var AUDIT_SCAN_LIMIT = 1e3;
    var DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1e3;
    var SESSION_ENDED_AFTER_MS = 15 * 60 * 1e3;
    var DETAIL_TEXT_MAX = 300;
    var AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
    function httpError(statusCode, message) {
      const err = new Error(message);
      err.statusCode = statusCode;
      return err;
    }
    function parseTimeParam(value, label) {
      if (value === void 0 || value === null || value === "") return null;
      let ms;
      if (typeof value === "number") {
        ms = value;
      } else if (typeof value === "string") {
        ms = /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : Date.parse(value);
      } else {
        throw httpError(400, `Invalid ${label}: expected ISO string or epoch milliseconds`);
      }
      if (!Number.isFinite(ms)) {
        throw httpError(400, `Invalid ${label}: could not parse as a timestamp`);
      }
      return ms;
    }
    function parseTypesParam(types) {
      if (types === void 0 || types === null || types === "") return null;
      const list = Array.isArray(types) ? types : String(types).split(",");
      const cleaned = list.map((t) => String(t).trim()).filter((t) => t.length > 0);
      if (cleaned.length === 0) return null;
      for (const type of cleaned) {
        if (!EVENT_TYPES.includes(type)) {
          throw httpError(400, `Unknown event type '${type}'. Allowed: ${EVENT_TYPES.join(", ")}`);
        }
      }
      return new Set(cleaned);
    }
    function truncate(text, max = DETAIL_TEXT_MAX) {
      const value = String(text);
      return value.length <= max ? value : `${value.slice(0, max)}\u2026`;
    }
    function createStoreSessionsSource2({ agentsDir } = {}) {
      if (typeof agentsDir !== "string" || agentsDir.length === 0) {
        throw new Error("createStoreSessionsSource requires an agentsDir option");
      }
      return function readAgentSessions(agentId) {
        if (!AGENT_ID_RE.test(agentId)) return [];
        const storePath = path2.join(agentsDir, agentId, "sessions", "sessions.json");
        let store;
        try {
          store = JSON.parse(fs2.readFileSync(storePath, "utf8"));
        } catch (e) {
          return [];
        }
        if (!store || typeof store !== "object" || Array.isArray(store)) return [];
        return Object.entries(store).filter(([, v]) => v && typeof v === "object").map(([key, v]) => ({
          key,
          sessionId: typeof v.sessionId === "string" ? v.sessionId : null,
          sessionStartedAt: Number.isFinite(v.sessionStartedAt) ? v.sessionStartedAt : null,
          updatedAt: Number.isFinite(v.updatedAt) ? v.updatedAt : null,
          totalTokens: Number.isFinite(v.totalTokens) ? v.totalTokens : (v.inputTokens || 0) + (v.outputTokens || 0),
          model: typeof v.model === "string" ? v.model : null,
          label: typeof v.displayName === "string" && v.displayName || typeof v.groupChannel === "string" && v.groupChannel || typeof v.label === "string" && v.label || null
        }));
      };
    }
    function createFlightRecorder2(options = {}) {
      const {
        readAgentSessions = null,
        getBoard = null,
        queryAudit = null,
        getCronJobs: getCronJobs2 = null,
        nowFn = Date.now
      } = options;
      function collectSessionEvents(agentId, nowMs) {
        if (typeof readAgentSessions !== "function") return [];
        const events = [];
        for (const s of readAgentSessions(agentId) || []) {
          if (!s || typeof s !== "object") continue;
          const label = s.label || s.key || s.sessionId || "session";
          const refs = s.key ? { sessionKey: s.key } : {};
          if (Number.isFinite(s.sessionStartedAt)) {
            events.push({
              tsMs: s.sessionStartedAt,
              type: "session.start",
              title: `Session started \u2014 ${label}`,
              detail: { sessionId: s.sessionId, model: s.model },
              refs
            });
          }
          const lastMs = s.updatedAt;
          if (Number.isFinite(lastMs) && nowMs - lastMs > SESSION_ENDED_AFTER_MS) {
            events.push({
              tsMs: lastMs,
              type: "session.end",
              title: `Session ended \u2014 ${label}`,
              detail: { sessionId: s.sessionId, model: s.model, tokens: s.totalTokens ?? null },
              refs
            });
          }
        }
        return events;
      }
      function sumSessionTokens(agentId, sinceMs, untilMs) {
        if (typeof readAgentSessions !== "function") return 0;
        let tokens = 0;
        for (const s of readAgentSessions(agentId) || []) {
          if (!s || typeof s !== "object" || !Number.isFinite(s.totalTokens)) continue;
          const startMs = Number.isFinite(s.sessionStartedAt) ? s.sessionStartedAt : s.updatedAt;
          const endMs = Number.isFinite(s.updatedAt) ? s.updatedAt : startMs;
          if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
          if (startMs <= untilMs && endMs >= sinceMs) tokens += s.totalTokens;
        }
        return tokens;
      }
      function collectKanbanEvents(agentId) {
        if (typeof getBoard !== "function") return [];
        const board = getBoard();
        const tasks = Array.isArray(board && board.tasks) ? board.tasks : [];
        const events = [];
        for (const task of tasks) {
          if (!task || typeof task !== "object") continue;
          const refs = { taskId: task.id };
          for (const attempt of Array.isArray(task.attempts) ? task.attempts : []) {
            if (!attempt || attempt.agent !== agentId) continue;
            const startedMs = Date.parse(attempt.started_at);
            if (Number.isFinite(startedMs)) {
              events.push({
                tsMs: startedMs,
                type: "dispatch",
                title: `Dispatched: ${task.title}`,
                detail: { branch: attempt.branch ?? null, note: attempt.note ?? null },
                refs
              });
            }
            const endedMs = attempt.ended_at === null ? NaN : Date.parse(attempt.ended_at);
            if (Number.isFinite(endedMs)) {
              events.push({
                tsMs: endedMs,
                type: "dispatch.result",
                title: `Dispatch ${attempt.result || "settled"}: ${task.title}`,
                detail: {
                  result: attempt.result ?? null,
                  note: attempt.note ? truncate(attempt.note) : null,
                  branch: attempt.branch ?? null
                },
                refs
              });
            }
          }
          for (const comment of Array.isArray(task.comments) ? task.comments : []) {
            if (!comment || comment.author !== agentId) continue;
            const tsMs = Date.parse(comment.ts);
            if (!Number.isFinite(tsMs)) continue;
            events.push({
              tsMs,
              type: "note",
              title: `Comment on: ${task.title}`,
              detail: { text: truncate(comment.text ?? "") },
              refs
            });
          }
        }
        return events;
      }
      function collectCronEvents(agentId) {
        if (typeof getCronJobs2 !== "function") return [];
        const jobs = getCronJobs2();
        const events = [];
        for (const job of Array.isArray(jobs) ? jobs : []) {
          if (!job || job.agent !== agentId || !Number.isFinite(job.lastRunAtMs)) continue;
          events.push({
            tsMs: job.lastRunAtMs,
            type: "cron.run",
            title: `Cron run: ${job.name || job.id}`,
            detail: {
              jobId: job.id ?? null,
              status: job.lastStatus ?? null,
              schedule: job.schedule ?? null,
              source: job.source ?? null
            },
            refs: {}
          });
        }
        return events;
      }
      function collectAuditEvents(agentId, sinceMs, untilMs) {
        if (typeof queryAudit !== "function") return [];
        const entries = queryAudit({ since: sinceMs, until: untilMs, limit: AUDIT_SCAN_LIMIT });
        const events = [];
        for (const rec of Array.isArray(entries) ? entries : []) {
          if (!rec || typeof rec !== "object") continue;
          const detailAgent = rec.detail && typeof rec.detail === "object" ? rec.detail.agent : null;
          const involved = rec.user === agentId || rec.target === agentId || detailAgent === agentId;
          if (!involved) continue;
          const tsMs = Date.parse(rec.ts);
          if (!Number.isFinite(tsMs)) continue;
          const refs = {};
          if (typeof rec.action === "string" && rec.action.startsWith("task.") && rec.target) {
            refs.taskId = rec.target;
          }
          events.push({
            tsMs,
            type: "audit",
            title: rec.target ? `${rec.action} \u2192 ${rec.target}` : String(rec.action),
            detail: {
              user: rec.user ?? null,
              action: rec.action ?? null,
              target: rec.target ?? null,
              context: rec.detail ?? null,
              role: rec.user === agentId ? "actor" : rec.target === agentId ? "target" : "mentioned"
            },
            refs
          });
        }
        return events;
      }
      function getTimeline(agentId, opts = {}) {
        if (typeof agentId !== "string" || !AGENT_ID_RE.test(agentId)) {
          throw httpError(400, "Invalid agent id");
        }
        const limitRaw = opts.limit === void 0 || opts.limit === null ? DEFAULT_LIMIT : opts.limit;
        if (!Number.isInteger(limitRaw) || limitRaw < 1) {
          throw httpError(400, "limit must be a positive integer");
        }
        const limit = Math.min(limitRaw, MAX_LIMIT);
        const nowMs = nowFn();
        const untilMs = parseTimeParam(opts.until, "until") ?? nowMs;
        const sinceMs = parseTimeParam(opts.since, "since") ?? untilMs - DEFAULT_WINDOW_MS;
        if (sinceMs > untilMs) throw httpError(400, "since must not be later than until");
        const typeFilter = parseTypesParam(opts.types);
        const gaps = [
          "cost is not attributable per agent \u2014 summary.tokens carries the session token totals instead",
          "cron state only records the most recent run per job (no run history)"
        ];
        const collected = [];
        const collectors = [
          ["sessions", () => collectSessionEvents(agentId, nowMs)],
          ["kanban", () => collectKanbanEvents(agentId)],
          ["cron", () => collectCronEvents(agentId)],
          ["audit", () => collectAuditEvents(agentId, sinceMs, untilMs)]
        ];
        for (const [name, collect] of collectors) {
          try {
            collected.push(...collect());
          } catch (e) {
            console.error(`[FlightRecorder] ${name} source failed:`, e.message);
            gaps.push(`${name} source unavailable: ${e.message}`);
          }
        }
        const windowed = collected.filter((ev) => ev.tsMs >= sinceMs && ev.tsMs <= untilMs).filter((ev) => !typeFilter || typeFilter.has(ev.type)).sort((a, b) => b.tsMs - a.tsMs || a.type.localeCompare(b.type));
        const pageEvents = windowed.slice(0, limit);
        const hasMore = windowed.length > limit;
        const counts = {};
        for (const type of EVENT_TYPES) counts[type] = 0;
        for (const ev of windowed) counts[ev.type] += 1;
        let tokens = 0;
        try {
          tokens = sumSessionTokens(agentId, sinceMs, untilMs);
        } catch (e) {
          console.error("[FlightRecorder] token summary failed:", e.message);
          gaps.push(`token summary unavailable: ${e.message}`);
        }
        return {
          agent: { id: agentId },
          range: { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() },
          events: pageEvents.map(({ tsMs, type, title, detail, refs }) => ({
            ts: new Date(tsMs).toISOString(),
            type,
            title,
            detail,
            refs
          })),
          summary: { total: windowed.length, counts, tokens, cost: null, gaps },
          page: {
            limit,
            hasMore,
            nextUntil: hasMore ? pageEvents[pageEvents.length - 1].tsMs - 1 : null
          }
        };
      }
      return { getTimeline };
    }
    module2.exports = { createFlightRecorder: createFlightRecorder2, createStoreSessionsSource: createStoreSessionsSource2, EVENT_TYPES };
  }
});

// src/timeline-routes.js
var require_timeline_routes = __commonJS({
  "src/timeline-routes.js"(exports2, module2) {
    var TIMELINE_RE = /^\/api\/fleet\/agents\/([^/]+)\/timeline$/;
    function isTimelineRoute2(pathname) {
      return TIMELINE_RE.test(pathname);
    }
    function json(res, statusCode, payload) {
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload, null, 2));
    }
    function createTimelineRoutes2({ recorder } = {}) {
      if (!recorder || typeof recorder.getTimeline !== "function") {
        throw new Error("createTimelineRoutes requires a recorder with getTimeline()");
      }
      async function handle(req, res, pathname, query) {
        if ((req.method || "GET") !== "GET") {
          json(res, 405, { error: "Method not allowed" });
          return;
        }
        let agentId;
        try {
          agentId = decodeURIComponent(TIMELINE_RE.exec(pathname)[1]);
        } catch (e) {
          json(res, 400, { error: "Malformed URL encoding" });
          return;
        }
        try {
          const opts = {};
          if (query.get("since")) opts.since = query.get("since");
          if (query.get("until")) opts.until = query.get("until");
          if (query.get("types")) opts.types = query.get("types");
          const limitRaw = query.get("limit");
          if (limitRaw !== null && limitRaw !== "") {
            const limit = Number(limitRaw);
            if (!Number.isInteger(limit)) {
              json(res, 400, { error: "Invalid limit parameter" });
              return;
            }
            opts.limit = limit;
          }
          json(res, 200, recorder.getTimeline(agentId, opts));
        } catch (err) {
          const statusCode = Number.isInteger(err.statusCode) ? err.statusCode : 500;
          if (statusCode >= 500) {
            console.error("[TimelineRoutes] Internal error:", err);
          }
          json(res, statusCode, { error: err.message || "Internal error" });
        }
      }
      return { handle, isTimelineRoute: isTimelineRoute2 };
    }
    module2.exports = { createTimelineRoutes: createTimelineRoutes2, isTimelineRoute: isTimelineRoute2 };
  }
});

// src/run-archive.js
var require_run_archive = __commonJS({
  "src/run-archive.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var { DatabaseSync } = require("node:sqlite");
    var DB_FILE_NAME = "flight-recorder.db";
    var DEFAULT_RETENTION_DAYS = 30;
    var DEFAULT_MAX_ROWS = 5e3;
    var DAY_MS = 24 * 60 * 60 * 1e3;
    var DEFAULT_LIST_LIMIT = 50;
    var MAX_LIST_LIMIT = 200;
    var SEAT_TEXT_MAX = 2e4;
    var VALID_STATUSES = /* @__PURE__ */ new Set(["running", "done", "failed"]);
    var VALID_SEAT_STATUSES = /* @__PURE__ */ new Set(["ok", "failed", "timeout", "skipped", "budget", "refused"]);
    function httpError(statusCode, message) {
      const err = new Error(message);
      err.statusCode = statusCode;
      return err;
    }
    function truncate(text, max) {
      if (typeof text !== "string") return text;
      return text.length <= max ? text : text.slice(0, max);
    }
    function toMs(value) {
      if (value == null) return null;
      if (typeof value === "number") return Number.isFinite(value) ? value : null;
      const ms = Date.parse(String(value));
      return Number.isFinite(ms) ? ms : null;
    }
    function deriveSeats(entry) {
      const seats = [];
      if (!entry || typeof entry !== "object") return seats;
      if (entry.mode === "chain") {
        const steps = Array.isArray(entry.steps) ? entry.steps : [];
        steps.forEach((step, i) => {
          if (!step || typeof step !== "object") return;
          let status;
          if (step.skipped) status = "skipped";
          else if (step.timedOut) status = "timeout";
          else if (step.error) status = "refused";
          else if (step.ok) status = "ok";
          else status = "failed";
          seats.push({
            seq: i,
            agent: String(step.agent || "unknown"),
            taskId: step.taskId || null,
            status,
            resultText: typeof step.text === "string" ? step.text : null,
            error: typeof step.error === "string" ? step.error : null,
            truncated: !!step.truncated
          });
        });
        return seats;
      }
      const results = Array.isArray(entry.results) ? entry.results : [];
      const missing = Array.isArray(entry.missing) ? entry.missing : [];
      const reasonFor = (agent, taskId) => {
        const m = missing.find(
          (x) => x && x.agent === agent && (x.taskId === taskId || x.taskId == null)
        );
        return m ? String(m.reason || "missing") : null;
      };
      results.forEach((r, i) => {
        if (!r || typeof r !== "object") return;
        let status;
        if (r.ok) {
          status = "ok";
        } else {
          const reason = reasonFor(r.agent, r.taskId) || "";
          if (reason.startsWith("timeout")) status = "timeout";
          else if (reason.startsWith("budget")) status = "budget";
          else if (reason.startsWith("dispatch")) status = "refused";
          else status = "failed";
        }
        seats.push({
          seq: i,
          agent: String(r.agent || "unknown"),
          taskId: r.taskId || null,
          status,
          resultText: typeof r.text === "string" ? r.text : null,
          error: status === "refused" ? reasonFor(r.agent, r.taskId) : null,
          truncated: !!r.truncated
        });
      });
      return seats;
    }
    function runEntryToRecord2(entry, opts = {}) {
      if (!entry || typeof entry !== "object" || !entry.runId) return null;
      const seats = deriveSeats(entry);
      const startedMs = toMs(entry.startedAt);
      const endedMs = toMs(entry.endedAt);
      const question = typeof entry.question === "string" ? entry.question : entry.mode === "chain" && typeof entry.title === "string" ? entry.title : null;
      const title = typeof opts.title === "string" && opts.title || typeof entry.title === "string" && entry.title || (entry.mode === "chain" ? "Chain run" : "Board run");
      const seatCount = seats.length;
      const okCount = seats.filter((s) => s.status === "ok").length;
      return {
        run: {
          runId: String(entry.runId),
          node: typeof opts.node === "string" && opts.node ? opts.node : "local",
          mode: entry.mode === "chain" ? "chain" : "board",
          title,
          question,
          status: VALID_STATUSES.has(entry.status) ? entry.status : "done",
          agents: Array.isArray(entry.agents) ? entry.agents.map(String) : [],
          seatCount,
          okCount,
          error: typeof entry.error === "string" ? entry.error : null,
          budgetHalt: entry.budgetHalt ? JSON.stringify(entry.budgetHalt) : null,
          startedAtMs: startedMs,
          endedAtMs: endedMs,
          durationMs: startedMs != null && endedMs != null ? Math.max(0, endedMs - startedMs) : null
        },
        seats
      };
    }
    function recordIsFailure2(record) {
      if (!record || !record.run) return false;
      if (record.run.status === "failed") return true;
      return (record.seats || []).some(
        (s) => s.status === "timeout" || s.status === "failed" || s.status === "refused"
      );
    }
    function createRunArchive2({
      stateDir,
      node = "local",
      retentionDays = DEFAULT_RETENTION_DAYS,
      maxRows = DEFAULT_MAX_ROWS,
      nowFn = Date.now
    } = {}) {
      if (typeof stateDir !== "string" || stateDir.length === 0) {
        throw new TypeError("stateDir must be a non-empty string");
      }
      const instanceNode = typeof node === "string" && node.length > 0 ? node : "local";
      const retentionMs = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays * DAY_MS : null;
      const rowCap = Number.isFinite(maxRows) && maxRows > 0 ? Math.floor(maxRows) : null;
      fs2.mkdirSync(stateDir, { recursive: true });
      const db = new DatabaseSync(path2.join(stateDir, DB_FILE_NAME));
      db.exec("PRAGMA journal_mode=WAL");
      db.exec("PRAGMA synchronous=NORMAL");
      db.exec("PRAGMA busy_timeout=5000");
      db.exec("PRAGMA foreign_keys=ON");
      db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id       TEXT PRIMARY KEY,
      node         TEXT NOT NULL,
      mode         TEXT NOT NULL,
      title        TEXT NOT NULL,
      question     TEXT,
      status       TEXT NOT NULL,
      agents       TEXT NOT NULL,
      seat_count   INTEGER NOT NULL,
      ok_count     INTEGER NOT NULL,
      error        TEXT,
      budget_halt  TEXT,
      started_at   INTEGER,
      ended_at     INTEGER,
      duration_ms  INTEGER,
      archived_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_archived ON runs(archived_at);
    CREATE INDEX IF NOT EXISTS idx_runs_status   ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_runs_node     ON runs(node);

    CREATE TABLE IF NOT EXISTS run_seats (
      run_id       TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      agent        TEXT NOT NULL,
      task_id      TEXT,
      status       TEXT NOT NULL,
      result_text  TEXT,
      error        TEXT,
      truncated    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, seq),
      FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_seats_agent ON run_seats(agent);
  `);
      const insertRunStmt = db.prepare(`
    INSERT OR IGNORE INTO runs
      (run_id, node, mode, title, question, status, agents, seat_count, ok_count,
       error, budget_halt, started_at, ended_at, duration_ms, archived_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
      const insertSeatStmt = db.prepare(`
    INSERT OR IGNORE INTO run_seats
      (run_id, seq, agent, task_id, status, result_text, error, truncated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
      const pruneByAgeStmt = db.prepare("DELETE FROM runs WHERE archived_at < ?");
      const pruneByCountStmt = db.prepare(
        "DELETE FROM runs WHERE run_id NOT IN (SELECT run_id FROM runs ORDER BY archived_at DESC, run_id DESC LIMIT ?)"
      );
      const getRunStmt = db.prepare("SELECT * FROM runs WHERE run_id = ?");
      const getSeatsStmt = db.prepare("SELECT * FROM run_seats WHERE run_id = ? ORDER BY seq ASC");
      function runRowToJson(row) {
        if (!row) return null;
        let agents = [];
        try {
          agents = JSON.parse(row.agents);
        } catch (e) {
          agents = [];
        }
        let budgetHalt = null;
        if (row.budget_halt) {
          try {
            budgetHalt = JSON.parse(row.budget_halt);
          } catch (e) {
            budgetHalt = null;
          }
        }
        return {
          runId: row.run_id,
          node: row.node,
          mode: row.mode,
          title: row.title,
          question: row.question,
          status: row.status,
          agents: Array.isArray(agents) ? agents : [],
          seatCount: Number(row.seat_count),
          okCount: Number(row.ok_count),
          error: row.error,
          budgetHalt,
          startedAt: row.started_at != null ? new Date(Number(row.started_at)).toISOString() : null,
          endedAt: row.ended_at != null ? new Date(Number(row.ended_at)).toISOString() : null,
          startedAtMs: row.started_at != null ? Number(row.started_at) : null,
          endedAtMs: row.ended_at != null ? Number(row.ended_at) : null,
          durationMs: row.duration_ms != null ? Number(row.duration_ms) : null,
          archivedAt: new Date(Number(row.archived_at)).toISOString()
        };
      }
      function seatRowToJson(row) {
        return {
          seq: Number(row.seq),
          agent: row.agent,
          taskId: row.task_id,
          status: row.status,
          resultText: row.result_text,
          error: row.error,
          truncated: Number(row.truncated) === 1
        };
      }
      function pruneOldRuns() {
        let removed = 0;
        const now = nowFn();
        if (retentionMs != null) {
          removed += Number(pruneByAgeStmt.run(now - retentionMs).changes);
        }
        if (rowCap != null) {
          removed += Number(pruneByCountStmt.run(rowCap).changes);
        }
        return removed;
      }
      function archiveRun(entryOrRecord, opts = {}) {
        if (!entryOrRecord || typeof entryOrRecord !== "object") return null;
        const record = entryOrRecord.run && entryOrRecord.seats ? entryOrRecord : runEntryToRecord2(entryOrRecord, { node: instanceNode, ...opts });
        if (!record || !record.run || !record.run.runId) return null;
        const r = record.run;
        const archivedAt = nowFn();
        try {
          const res = insertRunStmt.run(
            r.runId,
            typeof r.node === "string" && r.node ? r.node : instanceNode,
            r.mode,
            truncate(r.title, 500),
            r.question != null ? truncate(String(r.question), 4e3) : null,
            VALID_STATUSES.has(r.status) ? r.status : "done",
            JSON.stringify(Array.isArray(r.agents) ? r.agents : []),
            Number.isFinite(r.seatCount) ? r.seatCount : (record.seats || []).length,
            Number.isFinite(r.okCount) ? r.okCount : 0,
            r.error != null ? truncate(String(r.error), 2e3) : null,
            r.budgetHalt != null ? String(r.budgetHalt) : null,
            r.startedAtMs != null ? r.startedAtMs : null,
            r.endedAtMs != null ? r.endedAtMs : null,
            r.durationMs != null ? r.durationMs : null,
            archivedAt
          );
          if (Number(res.changes) === 0) return record;
          for (const seat of record.seats || []) {
            const seatStatus = VALID_SEAT_STATUSES.has(seat.status) ? seat.status : "failed";
            insertSeatStmt.run(
              r.runId,
              Number.isFinite(seat.seq) ? seat.seq : 0,
              String(seat.agent || "unknown"),
              seat.taskId != null ? String(seat.taskId) : null,
              seatStatus,
              seat.resultText != null ? truncate(String(seat.resultText), SEAT_TEXT_MAX) : null,
              seat.error != null ? truncate(String(seat.error), 2e3) : null,
              seat.truncated ? 1 : 0
            );
          }
        } catch (e) {
          console.error("[RunArchive] archiveRun failed:", e.message);
          return record;
        }
        pruneOldRuns();
        return record;
      }
      function listRuns({ status, agent, node: nodeFilter, limit, before } = {}) {
        const conditions = [];
        const params = [];
        if (status !== void 0 && status !== null && status !== "") {
          if (!VALID_STATUSES.has(status)) {
            throw httpError(400, `Unknown status filter '${status}'`);
          }
          conditions.push("status = ?");
          params.push(status);
        }
        if (nodeFilter !== void 0 && nodeFilter !== null && nodeFilter !== "") {
          conditions.push("node = ?");
          params.push(String(nodeFilter));
        }
        if (agent !== void 0 && agent !== null && agent !== "") {
          conditions.push(
            "run_id IN (SELECT run_id FROM run_seats WHERE agent = ?)"
          );
          params.push(String(agent));
        }
        if (before !== void 0 && before !== null && before !== "") {
          const beforeMs = Number(before);
          if (!Number.isFinite(beforeMs)) throw httpError(400, "before must be a number (epoch ms)");
          conditions.push("archived_at < ?");
          params.push(beforeMs);
        }
        let effectiveLimit = Number(limit);
        if (!Number.isFinite(effectiveLimit) || effectiveLimit < 1) effectiveLimit = DEFAULT_LIST_LIMIT;
        effectiveLimit = Math.min(Math.floor(effectiveLimit), MAX_LIST_LIMIT);
        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const sql = `SELECT * FROM runs ${where} ORDER BY archived_at DESC, run_id DESC LIMIT ?`;
        const rows = db.prepare(sql).all(...params, effectiveLimit + 1);
        const hasMore = rows.length > effectiveLimit;
        const page = rows.slice(0, effectiveLimit).map(runRowToJson);
        return {
          runs: page,
          page: {
            limit: effectiveLimit,
            hasMore,
            nextBefore: hasMore && page.length > 0 ? page[page.length - 1].archivedAt : null
          }
        };
      }
      function getRun(runId) {
        if (typeof runId !== "string" || runId.length === 0) return null;
        const row = getRunStmt.get(runId);
        if (!row) return null;
        const seats = getSeatsStmt.all(runId).map(seatRowToJson);
        return { run: runRowToJson(row), seats };
      }
      function stats() {
        const totals = db.prepare(
          "SELECT COUNT(*) AS total, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM runs"
        ).get();
        return { total: Number(totals.total || 0), failed: Number(totals.failed || 0) };
      }
      function close() {
        try {
          db.close();
        } catch (e) {
          console.error("[RunArchive] Failed to close database:", e.message);
        }
      }
      return {
        archiveRun,
        listRuns,
        getRun,
        pruneOldRuns,
        stats,
        close,
        node: instanceNode
      };
    }
    module2.exports = {
      createRunArchive: createRunArchive2,
      runEntryToRecord: runEntryToRecord2,
      deriveSeats,
      recordIsFailure: recordIsFailure2
    };
  }
});

// src/run-archive-routes.js
var require_run_archive_routes = __commonJS({
  "src/run-archive-routes.js"(exports2, module2) {
    var RUNS_LIST_RE = /^\/api\/fleet\/flight-recorder\/runs$/;
    var RUN_DETAIL_RE = /^\/api\/fleet\/flight-recorder\/runs\/([^/]+)$/;
    var LIVE_RE = /^\/api\/fleet\/flight-recorder\/live$/;
    var STATS_RE = /^\/api\/fleet\/flight-recorder\/stats$/;
    function isFlightRecorderRoute2(pathname) {
      return RUNS_LIST_RE.test(pathname) || RUN_DETAIL_RE.test(pathname) || LIVE_RE.test(pathname) || STATS_RE.test(pathname);
    }
    function json(res, statusCode, payload) {
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload, null, 2));
    }
    function liveSnapshotToRecord(snapshot, mapFn, node) {
      if (!snapshot) return null;
      const mapped = typeof mapFn === "function" ? mapFn(snapshot, { node }) : null;
      if (mapped) {
        if ((!mapped.seats || mapped.seats.length === 0) && Array.isArray(snapshot.agents)) {
          mapped.seats = snapshot.agents.map((agent, i) => ({
            seq: i,
            agent: String(agent),
            taskId: null,
            status: "running",
            resultText: null,
            error: null,
            truncated: false
          }));
        }
        mapped.live = true;
        return mapped;
      }
      return {
        live: true,
        run: {
          runId: snapshot.runId,
          node,
          mode: snapshot.mode || "board",
          title: snapshot.title || "Run",
          question: snapshot.question || null,
          status: snapshot.status || "running",
          agents: Array.isArray(snapshot.agents) ? snapshot.agents : [],
          seatCount: Array.isArray(snapshot.agents) ? snapshot.agents.length : 0,
          okCount: 0,
          startedAt: snapshot.startedAt || null,
          endedAt: snapshot.endedAt || null
        },
        seats: (Array.isArray(snapshot.agents) ? snapshot.agents : []).map((agent, i) => ({
          seq: i,
          agent: String(agent),
          taskId: null,
          status: "running",
          resultText: null,
          error: null,
          truncated: false
        }))
      };
    }
    function createFlightRecorderRoutes2({
      archive,
      orchestrate: orchestrate2 = null,
      runEntryToRecord: runEntryToRecord2 = null,
      listLiveRuns = null
    } = {}) {
      if (!archive || typeof archive.listRuns !== "function") {
        throw new Error("createFlightRecorderRoutes requires an archive with listRuns()");
      }
      const node = archive.node || "local";
      async function handle(req, res, pathname, query) {
        if ((req.method || "GET") !== "GET") {
          json(res, 405, { error: "Method not allowed" });
          return;
        }
        try {
          const detailMatch = RUN_DETAIL_RE.exec(pathname);
          if (detailMatch) {
            let runId;
            try {
              runId = decodeURIComponent(detailMatch[1]);
            } catch (e) {
              json(res, 400, { error: "Malformed URL encoding" });
              return;
            }
            const archived = archive.getRun(runId);
            if (archived) {
              json(res, 200, { success: true, ...archived });
              return;
            }
            if (orchestrate2 && typeof orchestrate2.getRun === "function") {
              const snapshot = orchestrate2.getRun(runId);
              const record = liveSnapshotToRecord(snapshot, runEntryToRecord2, node);
              if (record) {
                json(res, 200, { success: true, ...record });
                return;
              }
            }
            json(res, 404, { error: `Unknown runId: ${runId}` });
            return;
          }
          if (LIVE_RE.test(pathname)) {
            let runs = [];
            if (typeof listLiveRuns === "function") {
              const snapshots = listLiveRuns() || [];
              runs = snapshots.filter((s) => s && s.status === "running").map((s) => liveSnapshotToRecord(s, runEntryToRecord2, node)).filter(Boolean);
            }
            json(res, 200, { success: true, runs });
            return;
          }
          if (STATS_RE.test(pathname)) {
            const s = typeof archive.stats === "function" ? archive.stats() : { total: 0, failed: 0 };
            json(res, 200, { success: true, ...s });
            return;
          }
          if (RUNS_LIST_RE.test(pathname)) {
            const opts = {};
            if (query.get("status")) opts.status = query.get("status");
            if (query.get("agent")) opts.agent = query.get("agent");
            if (query.get("node")) opts.node = query.get("node");
            if (query.get("before")) opts.before = query.get("before");
            const limitRaw = query.get("limit");
            if (limitRaw !== null && limitRaw !== "") {
              const limit = Number(limitRaw);
              if (!Number.isFinite(limit)) {
                json(res, 400, { error: "Invalid limit parameter" });
                return;
              }
              opts.limit = limit;
            }
            json(res, 200, { success: true, ...archive.listRuns(opts) });
            return;
          }
          json(res, 404, { error: "Unknown Flight Recorder route" });
        } catch (err) {
          const statusCode = Number.isInteger(err.statusCode) ? err.statusCode : 500;
          if (statusCode >= 500) {
            console.error("[FlightRecorderRoutes] Internal error:", err);
          }
          json(res, statusCode, { error: err.message || "Internal error" });
        }
      }
      return { handle, isFlightRecorderRoute: isFlightRecorderRoute2 };
    }
    module2.exports = { createFlightRecorderRoutes: createFlightRecorderRoutes2, isFlightRecorderRoute: isFlightRecorderRoute2, liveSnapshotToRecord };
  }
});

// src/session-control.js
var require_session_control = __commonJS({
  "src/session-control.js"(exports2, module2) {
    var fs2 = require("fs");
    var KILL_ESCALATION_MS = 1e4;
    var TAIL_BYTES = 64 * 1024;
    var MAX_CHUNK_BYTES = 256 * 1024;
    var MAX_TEXT_EXCERPT = 600;
    var SEARCH_DEFAULT_RESULTS = 50;
    var SEARCH_MAX_RESULTS = 200;
    var SEARCH_MAX_QUERY_LEN = 256;
    var SEARCH_MAX_SCAN_BYTES = 32 * 1024 * 1024;
    var TRANSCRIPT_SOURCES = ["terminal", "openclaw"];
    var SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;
    function parseTranscriptLine(line) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (e) {
        return null;
      }
      if (!entry || typeof entry !== "object") return null;
      if (entry.type !== "user" && entry.type !== "assistant" && entry.type !== "message") return null;
      const msg = entry.message;
      if (!msg || typeof msg !== "object" || typeof msg.role !== "string") return null;
      if (msg.role !== "user" && msg.role !== "assistant") return null;
      let text = "";
      const tools = [];
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (!part || typeof part !== "object") continue;
          if (part.type === "text" && !text && typeof part.text === "string") text = part.text;
          if (part.type === "tool_use" || part.type === "toolCall") {
            const name = part.name || part.tool;
            if (typeof name === "string" && name) tools.push(name);
          }
        }
      }
      if (!text && tools.length === 0) return null;
      return {
        role: msg.role,
        text: String(text).slice(0, MAX_TEXT_EXCERPT),
        ts: typeof entry.timestamp === "string" || typeof entry.timestamp === "number" ? entry.timestamp : null,
        tools
      };
    }
    function defaultReadCwd(pid) {
      try {
        return fs2.readlinkSync(`/proc/${pid}/cwd`);
      } catch (e) {
        return null;
      }
    }
    function createSessionControl2(deps = {}) {
      const { claudeCode, codex = null, resolveOpenClawTranscript } = deps;
      if (!claudeCode) throw new Error("createSessionControl requires a claudeCode adapter");
      if (typeof resolveOpenClawTranscript !== "function") {
        throw new Error("createSessionControl requires a resolveOpenClawTranscript function");
      }
      const killFn = deps.killFn || ((pid, signal) => process.kill(pid, signal));
      const readCwdFn = deps.readCwdFn || defaultReadCwd;
      const scheduleFn = deps.scheduleFn || setTimeout;
      const fsImpl = deps.fsImpl || fs2;
      function isPidAlive(pid) {
        try {
          killFn(pid, 0);
          return true;
        } catch (e) {
          return e && e.code === "EPERM";
        }
      }
      async function listKillablePids() {
        const lists = await Promise.all([
          claudeCode.getLive(),
          codex && typeof codex.getLive === "function" ? codex.getLive() : Promise.resolve({ pids: [] })
        ]);
        const pids = /* @__PURE__ */ new Set();
        for (const live of lists) {
          for (const pid of live && live.pids || []) {
            if (Number.isInteger(pid) && pid > 1) pids.add(pid);
          }
        }
        return pids;
      }
      async function killTerminalSession(pid) {
        if (!Number.isInteger(pid) || pid <= 1) {
          return { error: "Invalid pid", code: 400 };
        }
        const killable = await listKillablePids();
        if (!killable.has(pid)) {
          return { error: `No live claude/codex process with pid ${pid}`, code: 404 };
        }
        try {
          killFn(pid, "SIGTERM");
        } catch (e) {
          if (e && e.code === "ESRCH") {
            return { error: `Process ${pid} exited before it could be signalled`, code: 404 };
          }
          return { error: `Failed to signal pid ${pid}: ${e.message}`, code: 500 };
        }
        const timer = scheduleFn(() => {
          if (!isPidAlive(pid)) return;
          try {
            killFn(pid, "SIGKILL");
          } catch (e) {
          }
        }, KILL_ESCALATION_MS);
        if (timer && typeof timer.unref === "function") timer.unref();
        return { success: true, pid, signal: "SIGTERM", escalatesToSigkillAfterMs: KILL_ESCALATION_MS };
      }
      async function getTerminalLive() {
        const live = await claudeCode.getLive();
        const pids = live && live.pids || [];
        return {
          count: live && Number.isFinite(live.count) ? live.count : pids.length,
          ttys: live && live.ttys || [],
          processes: pids.filter((pid) => Number.isInteger(pid) && pid > 1).map((pid) => ({ pid, cwd: readCwdFn(pid) }))
        };
      }
      async function resolveTranscript(source, id) {
        if (typeof id !== "string" || !SAFE_ID_RE.test(id)) return null;
        if (source === "openclaw") {
          return resolveOpenClawTranscript(id);
        }
        const sessions2 = await claudeCode.getSessions({});
        const match = (sessions2 || []).find((s) => s && s.sessionId === id);
        return match ? match.file : null;
      }
      async function readTranscriptChunk({ source, id, offset = null } = {}) {
        if (!TRANSCRIPT_SOURCES.includes(source)) {
          return { error: `Invalid source (expected ${TRANSCRIPT_SOURCES.join("|")})`, code: 400 };
        }
        if (typeof id !== "string" || id.length === 0) {
          return { error: "Missing id", code: 400 };
        }
        if (offset !== null && (!Number.isFinite(offset) || offset < 0)) {
          return { error: "Invalid offset", code: 400 };
        }
        const filePath = await resolveTranscript(source, id);
        if (!filePath) {
          return { error: `Unknown ${source} session: ${id}`, code: 404 };
        }
        let size;
        try {
          size = fsImpl.statSync(filePath).size;
        } catch (e) {
          return { error: `Transcript unreadable: ${e.message}`, code: 404 };
        }
        let start = offset;
        let aligning = false;
        if (start === null || start > size) {
          start = Math.max(0, size - TAIL_BYTES);
          aligning = start > 0;
        }
        const end = Math.min(size, start + MAX_CHUNK_BYTES);
        if (end <= start) {
          return { source, id, messages: [], nextOffset: start, size, eof: start >= size };
        }
        let content;
        try {
          const fd = fsImpl.openSync(filePath, "r");
          const buffer = Buffer.alloc(end - start);
          const bytesRead = fsImpl.readSync(fd, buffer, 0, buffer.length, start);
          fsImpl.closeSync(fd);
          content = buffer.toString("utf8", 0, bytesRead);
        } catch (e) {
          return { error: `Transcript read failed: ${e.message}`, code: 500 };
        }
        let consumed = 0;
        if (aligning) {
          const firstNewline = content.indexOf("\n");
          if (firstNewline === -1) {
            return { source, id, messages: [], nextOffset: size, size, eof: true };
          }
          consumed = firstNewline + 1;
        }
        const messages = [];
        while (consumed < content.length) {
          const newline = content.indexOf("\n", consumed);
          if (newline === -1) {
            if (start + content.length >= size) {
              const message2 = parseTranscriptLine(content.slice(consumed));
              if (message2) {
                messages.push(message2);
                consumed = content.length;
              }
            }
            break;
          }
          const message = parseTranscriptLine(content.slice(consumed, newline));
          if (message) messages.push(message);
          consumed = newline + 1;
        }
        const nextOffset = start + consumed;
        return { source, id, messages, nextOffset, size, eof: nextOffset >= size };
      }
      async function searchTranscript({ source, id, query, maxResults = SEARCH_DEFAULT_RESULTS } = {}) {
        if (!TRANSCRIPT_SOURCES.includes(source)) {
          return { error: `Invalid source (expected ${TRANSCRIPT_SOURCES.join("|")})`, code: 400 };
        }
        if (typeof id !== "string" || id.length === 0) {
          return { error: "Missing id", code: 400 };
        }
        if (typeof query !== "string" || query.trim().length === 0) {
          return { error: "Missing query", code: 400 };
        }
        if (query.length > SEARCH_MAX_QUERY_LEN) {
          return { error: `Query too long (max ${SEARCH_MAX_QUERY_LEN} chars)`, code: 400 };
        }
        if (!Number.isInteger(maxResults) || maxResults < 1) {
          return { error: "Invalid maxResults", code: 400 };
        }
        const limit = Math.min(maxResults, SEARCH_MAX_RESULTS);
        const filePath = await resolveTranscript(source, id);
        if (!filePath) {
          return { error: `Unknown ${source} session: ${id}`, code: 404 };
        }
        let size;
        try {
          size = fsImpl.statSync(filePath).size;
        } catch (e) {
          return { error: `Transcript unreadable: ${e.message}`, code: 404 };
        }
        const needle = query.toLowerCase();
        const matches = [];
        let hitLimit = false;
        let previous = null;
        let awaitingAfter = [];
        const considerLine = (line) => {
          const message = parseTranscriptLine(line);
          if (!message) return;
          for (const entry of awaitingAfter) entry.after = message;
          awaitingAfter = [];
          const haystack = message.text.toLowerCase() + "\n" + message.tools.join("\n").toLowerCase();
          if (haystack.includes(needle)) {
            if (matches.length >= limit) {
              hitLimit = true;
            } else {
              const entry = { before: previous, message, after: null };
              matches.push(entry);
              awaitingAfter.push(entry);
            }
          }
          previous = message;
        };
        const scanEnd = Math.min(size, SEARCH_MAX_SCAN_BYTES);
        try {
          const fd = fsImpl.openSync(filePath, "r");
          try {
            let position = 0;
            let leftover = Buffer.alloc(0);
            while (position < scanEnd && !hitLimit) {
              const wanted = Math.min(MAX_CHUNK_BYTES, scanEnd - position);
              const buffer = Buffer.alloc(wanted);
              const bytesRead = fsImpl.readSync(fd, buffer, 0, wanted, position);
              if (bytesRead <= 0) break;
              position += bytesRead;
              let buf = leftover.length ? Buffer.concat([leftover, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
              let lineStart = 0;
              while (!hitLimit) {
                const newline = buf.indexOf(10, lineStart);
                if (newline === -1) break;
                considerLine(buf.toString("utf8", lineStart, newline));
                lineStart = newline + 1;
              }
              leftover = buf.subarray(lineStart);
            }
            if (!hitLimit && leftover.length > 0 && position >= size) {
              considerLine(leftover.toString("utf8"));
            }
          } finally {
            fsImpl.closeSync(fd);
          }
        } catch (e) {
          return { error: `Transcript read failed: ${e.message}`, code: 500 };
        }
        return {
          source,
          id,
          query,
          matches,
          matchCount: matches.length,
          truncated: hitLimit || scanEnd < size,
          size
        };
      }
      return {
        killTerminalSession,
        getTerminalLive,
        readTranscriptChunk,
        searchTranscript,
        isPidAlive,
        KILL_ESCALATION_MS
      };
    }
    module2.exports = { createSessionControl: createSessionControl2, parseTranscriptLine };
  }
});

// src/bind-host.js
var require_bind_host = __commonJS({
  "src/bind-host.js"(exports2, module2) {
    function resolveBindHost2(bindHost) {
      const value = typeof bindHost === "string" ? bindHost.trim().toLowerCase() : "";
      if (value === "" || value === "0.0.0.0" || value === "all" || value === "*") {
        return null;
      }
      if (value === "localhost" || value === "127.0.0.1") return "127.0.0.1";
      if (value === "::1") return "::1";
      return bindHost.trim();
    }
    module2.exports = { resolveBindHost: resolveBindHost2 };
  }
});

// src/index.js
var http = require("http");
var fs = require("fs");
var path = require("path");
var os = require("os");
var { execFile } = require("child_process");
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
var { handleJobsRequest, isJobsRoute, setCronFallback, setAuditRecorder } = require_jobs();
var { runOpenClaw, runOpenClawAsync, extractJSON, getSafeEnv } = require_openclaw();
var {
  getSystemVitals,
  forceRefreshVitals,
  getVitalsCacheAgeMs,
  checkOptionalDeps,
  getOptionalDeps
} = require_vitals();
var { checkAuth, getUnauthorizedPage } = require_auth();
var {
  loadOperators,
  saveOperators,
  getOperatorBySlackId,
  startOperatorsRefresh,
  calculateOperatorStats
} = require_operators();
var { createSessionsModule } = require_sessions();
var { getCronJobs, forceCliRefresh } = require_cron();
var { createCronActions } = require_cron_actions();
var { createCronRoutes } = require_cron_routes();
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
var { guardActionPost, PRIVILEGED_POST_ACTIONS } = require_action_guard();
var { createBulk } = require_bulk();
var { migrateDataDir } = require_data();
var { createStateModule } = require_state();
var { createFleetRuntime } = require_fleet();
var { createFleetRoutes, isFleetRoute } = require_fleet_routes();
var { createDispatch } = require_dispatch();
var { createOrchestrate } = require_orchestrate();
var { createSettings } = require_settings();
var { createDocker } = require_docker();
var { createDockerPool } = require_docker_pool();
var { createUsageSources } = require_usage_sources();
var { createUsageProvider } = require_budgets();
var { createTopConsumersSource } = require_digest();
var { createAgentsRoster } = require_agents_roster();
var { createAgentLocator } = require_agent_locator();
var { createSpawnStore } = require_spawn_store();
var { createAgentSpawn } = require_agent_spawn();
var { createFlightRecorder, createStoreSessionsSource } = require_flight_recorder();
var { createTimelineRoutes, isTimelineRoute } = require_timeline_routes();
var { createRunArchive, runEntryToRecord, recordIsFailure } = require_run_archive();
var {
  createFlightRecorderRoutes,
  isFlightRecorderRoute
} = require_run_archive_routes();
var { createSessionControl } = require_session_control();
var { createRateLimiter } = require_rate_limit();
var { resolveBindHost } = require_bind_host();
var { createTailscaleWhois, verifyServeLogin } = require_auth();
var PORT = CONFIG.server.port;
var DASHBOARD_DIR = path.join(__dirname, "../public");
var PATHS = CONFIG.paths;
var AUTH_CONFIG = {
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
    whoisFn: createTailscaleWhois({ socket: CONFIG.auth.tailscale.tailscaledSocket })
  }
};
var DATA_DIR = path.join(getOpenClawDir(), "command-center", "data");
var LEGACY_DATA_DIR = path.join(DASHBOARD_DIR, "data");
function toFiniteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}
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
var OPENCLAW_SOURCES = CONFIG.fleet.openclawSources !== false;
var getCronJobsSafe = () => OPENCLAW_SOURCES ? getCronJobs(getOpenClawDir) : [];
var getLlmUsageSafe = (statePath) => getLlmUsage(statePath, { allowSpawn: OPENCLAW_SOURCES });
setCronFallback(getCronJobsSafe);
var sessions = createSessionsModule({
  getOpenClawDir,
  getOperatorBySlackId: (slackId) => getOperatorBySlackId(DATA_DIR, slackId),
  runOpenClaw,
  runOpenClawAsync,
  extractJSON,
  sessionsSource: CONFIG.fleet.sessionsSource,
  refreshMs: CONFIG.fleet.sessionsRefreshMs,
  enabled: OPENCLAW_SOURCES
});
var state = createStateModule({
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
  readTranscript: (sessionId) => sessions.readTranscript(sessionId)
});
var fleet = createFleetRuntime({ config: CONFIG.fleet, broadcast: broadcastSSE });
function getRequestUser(req) {
  const login = req.headers["tailscale-user-login"];
  return typeof login === "string" && login.trim().length > 0 ? login.trim().toLowerCase() : "anonymous";
}
function recordAudit(user, action, target, detail) {
  try {
    fleet.audit.record({ user, action, target, detail });
  } catch (e) {
    console.error("[Audit] Record failed:", e.message);
  }
}
setAuditRecorder((entry) => fleet.audit.record(entry));
var settings = createSettings({
  configPath: path.join(__dirname, "..", "config", "dashboard.local.json"),
  onChange: (alertsConfig) => fleet.applyAlertsConfig(alertsConfig),
  onBudgetsChange: (budgetsConfig) => fleet.applyBudgetsConfig(budgetsConfig),
  onDigestChange: (digestConfig) => fleet.applyDigestConfig(digestConfig)
});
var agentLocator = null;
var dispatch = createDispatch({
  kanban: fleet.kanban,
  briefsDir: CONFIG.fleet.briefsDir,
  config: {
    ...CONFIG.fleet.dispatch,
    baseUrl: CONFIG.fleet.dispatch.baseUrl || `http://127.0.0.1:${PORT}`
  },
  onEvent: (event) => broadcastSSE("fleet.kanban", { type: event.type, taskId: event.taskId || null }),
  fireAlert: (event) => fleet.fireAlert(event),
  // Remote dispatch (Phase 2): route an agent to the node that hosts it.
  resolveAgentNode: (agentRef) => agentLocator.resolve(agentRef),
  fetchFn: (...a) => globalThis.fetch(...a),
  meshIdentity: CONFIG.fleet.dispatch.identity || os.hostname(),
  // Shared Bearer token for node→node agent-run auth (guardActionPost token
  // branch). null = header omitted (today's behavior).
  dispatchToken: CONFIG.fleet.dispatch.token || null
});
var spawnControllerRef = { controller: null };
var spawnEnabled = !!(CONFIG.fleet.spawn && CONFIG.fleet.spawn.enabled === true);
var orchestrateSpawnProxy = spawnEnabled ? {
  lease: (advisorId) => spawnControllerRef.controller?.lease(advisorId) ?? null,
  release: (workerId, generation) => spawnControllerRef.controller?.release(workerId, generation),
  beginDrain: (workerId) => spawnControllerRef.controller?.beginDrain(workerId) ?? false,
  settleAndRemove: (workerId) => spawnControllerRef.controller?.settleAndRemove(workerId)
} : null;
var flightRecorderCfg = CONFIG.fleet.flightRecorder || {};
var flightRecorderEnabled = flightRecorderCfg.enabled !== false;
var flightRecorderNodeId = typeof flightRecorderCfg.nodeId === "string" && flightRecorderCfg.nodeId || CONFIG.fleet.dispatch?.identity || CONFIG.fleet.dispatch?.node || os.hostname();
var orchestrateRef = { mod: null };
var runArchive = null;
if (flightRecorderEnabled) {
  try {
    runArchive = createRunArchive({
      stateDir: CONFIG.fleet.stateDir,
      node: flightRecorderNodeId,
      retentionDays: flightRecorderCfg.retentionDays,
      maxRows: flightRecorderCfg.maxRows
    });
  } catch (e) {
    console.error("[FlightRecorder] archive init failed (continuing without it):", e.message);
    runArchive = null;
  }
}
var FLIGHT_REC_ALERT_COOLDOWN_MS = 60 * 1e3;
var flightRecAlertedRuns = /* @__PURE__ */ new Set();
var flightRecLastAlertMs = 0;
function recordOrchestrationRun(runId) {
  if (!runArchive || !runId) return;
  const entry = orchestrateRef.mod && typeof orchestrateRef.mod.getRun === "function" ? orchestrateRef.mod.getRun(runId) : null;
  if (!entry || entry.status === "running") return;
  let record;
  try {
    record = runArchive.archiveRun(entry, { node: flightRecorderNodeId });
  } catch (e) {
    console.error("[FlightRecorder] archiveRun threw:", e.message);
    return;
  }
  if (!record) return;
  if (flightRecorderCfg.alertOnFailure !== false && recordIsFailure(record)) {
    if (flightRecAlertedRuns.has(runId)) return;
    const now = Date.now();
    if (now - flightRecLastAlertMs < FLIGHT_REC_ALERT_COOLDOWN_MS) {
      flightRecAlertedRuns.add(runId);
      return;
    }
    flightRecLastAlertMs = now;
    flightRecAlertedRuns.add(runId);
    if (flightRecAlertedRuns.size > 500) {
      const keep = Array.from(flightRecAlertedRuns).slice(-250);
      flightRecAlertedRuns.clear();
      for (const k of keep) flightRecAlertedRuns.add(k);
    }
    const r = record.run;
    const failedSeats = (record.seats || []).filter((s) => s.status === "timeout" || s.status === "failed" || s.status === "refused").map((s) => `${s.agent}:${s.status}`);
    try {
      fleet.fireAlert({
        type: "orchestrationFailed",
        severity: "warn",
        node: r.node,
        task: r.runId,
        message: `Flight Recorder: ${r.mode} run "${r.title}" ${r.status} (${r.okCount}/${r.seatCount} ok` + (failedSeats.length ? `; failed: ${failedSeats.join(", ")}` : "") + ")"
      });
    } catch (e) {
      console.error("[FlightRecorder] failure alert failed:", e.message);
    }
  }
}
var orchestrate = createOrchestrate({
  kanban: fleet.kanban,
  dispatch,
  config: CONFIG.fleet.orchestrate || {},
  // AC-17: pool routing + parallel flip engage ONLY when spawn is enabled.
  spawn: orchestrateSpawnProxy,
  spawnEnabled,
  onEvent: (event) => {
    broadcastSSE("fleet.kanban", { type: event.type, taskId: event.taskId || null });
    if (event.type === "orchestration.completed") {
      broadcastSSE("fleet.orchestration", {
        type: event.type,
        runId: event.runId,
        mode: event.mode,
        status: event.status,
        collected: event.collected,
        missing: event.missing
      });
      recordOrchestrationRun(event.runId);
    }
  }
});
orchestrateRef.mod = orchestrate;
var actionDeps = {
  runOpenClawAsync,
  extractJSON,
  PORT,
  getRawSessions: () => sessions.getRawSessionsCached(),
  // Long-timeout agent runner for the agent-run verb (an agent turn needs
  // minutes, not the 20s runOpenClawAsync budget). Mirrors dispatch's
  // defaultExecFn: openclaw via execFile (no shell — injection-safe), returns
  // stdout or null on failure/timeout so the verb maps cleanly to an error.
  runAgent: (args2, { timeoutMs }) => new Promise(
    (resolve) => execFile(
      "openclaw",
      args2,
      { encoding: "utf8", timeout: timeoutMs, env: getSafeEnv(), maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve(err && !stdout ? null : stdout)
    )
  )
};
var bulk = createBulk({
  mesh: fleet.mesh,
  chat: fleet.chat,
  dispatch,
  // Validate dispatch targets against the FLEET roster (local + mesh + federation)
  // so remote-only and "id@node"-qualified agents pass validation and reach the
  // node-aware resolver. Lazy closure: agentsRoster is constructed further down.
  rosterFn: () => agentsRoster.getRoster(),
  runAction: (name, opts) => executeAction(name, actionDeps, opts)
});
var spawnStoreRef = { store: null };
var fleetRoutes = createFleetRoutes({
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
  spawnStoreFn: () => spawnStoreRef.store
});
var cronActions = createCronActions({
  getJobs: getCronJobsSafe,
  refreshJobs: forceCliRefresh
});
var cronRoutes = createCronRoutes({
  actions: cronActions,
  audit: fleet.audit,
  rateLimiter: fleet.rateLimiter,
  enabled: OPENCLAW_SOURCES
});
var usageSources = createUsageSources({
  claudeProjectsDir: CONFIG.fleet.usage.claudeProjectsDir,
  codexDir: CONFIG.fleet.usage.codexDir,
  nineRouterDb: CONFIG.fleet.usage.nineRouterDb,
  headroomStats: CONFIG.fleet.usage.headroomStats || CONFIG.fleet.cortex.headroomStats,
  openrouterKey: process.env.OPENROUTER_API_KEY || CONFIG.fleet.usage.openrouterKey
});
fleet.setUsageProvider(createUsageProvider({ usageSources }));
fleet.setDigestSources({
  getCronJobs: () => getCronJobsSafe(),
  getTopConsumers: createTopConsumersSource({ usageSources })
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
var sessionControl = createSessionControl({
  claudeCode: usageSources.sources.claudeCode,
  codex: usageSources.sources.codex,
  resolveOpenClawTranscript: (sessionId) => sessions.resolveTranscriptForId(sessionId)
});
var killRateLimiter = createRateLimiter({ windowMs: 6e4, max: 6 });
var TERMINAL_KILL_RE = /^\/api\/sessions\/terminal\/(\d+)\/kill$/;
var agentsRoster = createAgentsRoster({
  openclawConfigPath: path.join(getOpenClawDir(), "openclaw.json"),
  agentsDir: path.join(getOpenClawDir(), "agents"),
  mesh: fleet.mesh
});
agentLocator = createAgentLocator({
  rosterFn: () => agentsRoster.getRoster(),
  meshFn: () => fleet.mesh.getState(),
  selfNode: CONFIG.fleet.dispatch.node || os.hostname()
});
var agentSpawn = null;
if (CONFIG.fleet.spawn && CONFIG.fleet.spawn.enabled === true) {
  const spawnStore = createSpawnStore({ stateDir: CONFIG.fleet.stateDir });
  spawnStoreRef.store = spawnStore;
  const dockerIface = createDockerPool({
    socketPath: CONFIG.fleet.docker?.socketPath
  });
  const spawnCfgLive = CONFIG.fleet.spawn;
  const probePort = Number(spawnCfgLive.workerPort) || 443;
  const probeHealthPath = "/api/health";
  const probeTimeoutMs = 3e3;
  const probeHealthFn = (worker) => new Promise((resolve) => {
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
        method: "GET"
      },
      (res) => {
        res.resume();
        settle(res.statusCode === 200);
      }
    );
    req.setTimeout(probeTimeoutMs, () => {
      req.destroy();
      settle(false);
    });
    req.on("error", () => settle(false));
    req.end();
  });
  const readMemAvailableFn = () => {
    const raw = fs.readFileSync("/proc/meminfo", "utf8");
    const m = raw.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (!m) throw new Error("[AgentSpawn] MemAvailable not found in /proc/meminfo");
    return Number(m[1]) * 1024;
  };
  agentSpawn = createAgentSpawn({
    config: CONFIG,
    mesh: fleet.mesh,
    roster: agentsRoster,
    store: spawnStore,
    docker: dockerIface,
    logger: console,
    probeHealthFn,
    readMemAvailableFn
  });
  spawnControllerRef.controller = agentSpawn;
  agentSpawn.start();
}
var flightRecorder = createFlightRecorder({
  readAgentSessions: createStoreSessionsSource({
    agentsDir: path.join(getOpenClawDir(), "agents")
  }),
  getBoard: () => fleet.kanban.getBoard(),
  queryAudit: (filters) => fleet.audit.query(filters),
  getCronJobs: getCronJobsSafe
});
var timelineRoutes = createTimelineRoutes({ recorder: flightRecorder });
var flightRecorderRoutes = runArchive ? createFlightRecorderRoutes({
  archive: runArchive,
  orchestrate,
  runEntryToRecord,
  listLiveRuns: () => orchestrate.listRuns()
}) : null;
process.nextTick(() => migrateDataDir(DATA_DIR, LEGACY_DATA_DIR));
fleet.start();
docker.start();
if (OPENCLAW_SOURCES) {
  startOperatorsRefresh(DATA_DIR, getOpenClawDir);
  startLlmUsageRefresh();
  startTokenUsageRefresh(getOpenClawDir);
}
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
    cron: getCronJobsSafe(),
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
        `[AUTH] Allowed: ${authResult.user.login || authResult.user.email} (path: ${pathname})`
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
function routeRequest(req, res, pathname, query) {
  if (pathname === "/api/status") {
    handleApi(req, res);
  } else if (pathname === "/api/session" || pathname === "/api/sessions/detail") {
    const sessionKey = query.get("key");
    if (!sessionKey) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing session key" }));
      return;
    }
    Promise.resolve(sessions.getSessionDetail(sessionKey)).then((detail) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(detail, null, 2));
    }).catch((e) => {
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
      if (!PRIVILEGED_POST_ACTIONS.has(action)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ success: false, action, error: `Unknown POST action: ${action}` })
        );
        return;
      }
      const token = CONFIG.fleet.dispatch.token || null;
      const verifyServeOrigin = AUTH_CONFIG.tailscale.verifyServeOrigin === true;
      Promise.resolve(fleet.mesh.getState()).then((state2) => {
        const nodes = Array.isArray(state2 && state2.nodes) ? state2.nodes : [];
        return new Set(
          nodes.filter((n) => n && typeof n.hostname === "string").map((n) => n.hostname.trim().toLowerCase())
        );
      }).catch(() => /* @__PURE__ */ new Set()).then(async (meshLogins) => {
        let verifiedLogin = null;
        if (verifyServeOrigin) {
          const claimed = getRequestUser(req);
          verifiedLogin = claimed !== "anonymous" ? await verifyServeLogin(req, claimed, AUTH_CONFIG.tailscale.whoisFn) : null;
        }
        const verdict = guardActionPost(req, {
          token,
          meshLogins,
          verifyServeOrigin,
          verifiedLogin
        });
        if (!verdict.allowed) {
          recordAudit(getRequestUser(req), "action.execute", action, {
            success: false,
            kind: "remote-dispatch",
            denied: verdict.reason
          });
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, action, error: "Forbidden" }));
          return;
        }
        if (verdict.reason !== "localhost" && fleet.rateLimiter) {
          const rlKey = `agent-run|${getRequestUser(req)}`;
          const rl = fleet.rateLimiter.check(rlKey);
          if (!rl.allowed) {
            recordAudit(getRequestUser(req), "action.execute", action, {
              success: false,
              kind: "remote-dispatch",
              denied: "rate-limited"
            });
            res.writeHead(429, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                success: false,
                action,
                error: "Rate limit exceeded",
                retryAfterMs: rl.retryAfterMs
              })
            );
            return;
          }
        }
        const opts = {
          agent: body.agent,
          message: body.message,
          sessionKey: body.sessionKey,
          timeoutSec: body.timeoutSec,
          staleMinutes: body.staleMinutes
        };
        executeAction(action, actionDeps, opts).then((result) => {
          recordAudit(getRequestUser(req), "action.execute", action, {
            success: result.success,
            kind: "remote-dispatch",
            agent: typeof body.agent === "string" ? body.agent : null
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result, null, 2));
        }).catch((e) => {
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
    executeAction(action, actionDeps).then((result) => {
      recordAudit(getRequestUser(req), "action.execute", action, { success: result.success });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result, null, 2));
    }).catch((e) => {
      console.error("[Action] Execute failed:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, action, error: "Internal error" }));
    });
    return;
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
      res.end(
        JSON.stringify(
          {
            ...fullState || {},
            fleet: fleetSummary,
            cacheAgeMs: fullState?.timestamp ? Date.now() - fullState.timestamp : null,
            sessionsCacheAgeMs: toFiniteOrNull(sessions.getCacheAgeMs())
          },
          null,
          2
        )
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
          2
        )
      );
    };
    if (wantsRefresh) {
      forceRefreshVitals().then(respond).catch((e) => {
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
            hasNext: page < totalPages
          },
          statusCounts,
          tokenStats,
          capacity,
          cacheAgeMs: toFiniteOrNull(sessions.getCacheAgeMs())
        },
        null,
        2
      )
    );
  } else if (pathname === "/api/sessions/transcript") {
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    const offsetRaw = query.get("offset");
    sessionControl.readTranscriptChunk({
      source: query.get("source"),
      id: query.get("id"),
      offset: offsetRaw === null || offsetRaw === "" ? null : Number(offsetRaw)
    }).then((result) => {
      res.writeHead(result.error ? result.code || 500 : 200, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify(result, null, 2));
    }).catch((e) => {
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
    sessionControl.searchTranscript({
      source: query.get("source"),
      id: query.get("id"),
      query: query.get("q"),
      ...maxRaw !== null && maxRaw !== "" ? { maxResults: Number(maxRaw) } : {}
    }).then((result) => {
      res.writeHead(result.error ? result.code || 500 : 200, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify(result, null, 2));
    }).catch((e) => {
      console.error("[SessionControl] Transcript search failed:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error" }));
    });
    return;
  } else if (pathname === "/api/sessions/terminal/live") {
    sessionControl.getTerminalLive().then((live) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(live, null, 2));
    }).catch((e) => {
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
    sessionControl.killTerminalSession(pid).then((result) => {
      if (result.success) {
        recordAudit(user, "session.kill", String(pid), {
          source: "terminal",
          signal: result.signal
        });
      }
      res.writeHead(result.error ? result.code || 500 : 200, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify(result, null, 2));
    }).catch((e) => {
      console.error("[SessionControl] Kill failed:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error" }));
    });
    return;
  } else if (cronRoutes.isCronActionRoute(pathname)) {
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
            recordAudit(
              getRequestUser(req),
              "operator.save",
              newOp.id != null ? String(newOp.id) : null,
              { op: existingIdx >= 0 ? "update" : "create", fields: Object.keys(newOp) }
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
  } else if (isTimelineRoute(pathname)) {
    timelineRoutes.handle(req, res, pathname, query).catch((e) => {
      console.error("[Timeline] Route failed:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error" }));
    });
    return;
  } else if (flightRecorderRoutes && isFlightRecorderRoute(pathname)) {
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
var BIND_HOST = resolveBindHost(CONFIG.server.bindHost);
var listenArgs = BIND_HOST ? [PORT, BIND_HOST] : [PORT];
server.listen(...listenArgs, () => {
  const profile = process.env.OPENCLAW_PROFILE;
  const boundTo = BIND_HOST ? `${BIND_HOST}:${PORT}` : `:${PORT} (all interfaces)`;
  console.log(`\u{1F99E} OpenFleetControl running at http://localhost:${PORT} (bound ${boundTo})`);
  if (profile) {
    console.log(`   Profile: ${profile} (~/.openclaw-${profile})`);
  }
  console.log(`   Press Ctrl+C to stop`);
  setTimeout(async () => {
    console.log("[Startup] Pre-warming caches in background...");
    try {
      if (OPENCLAW_SOURCES) {
        sessions.startSessionsRefresh();
        await refreshTokenUsageAsync(getOpenClawDir);
      }
      getSystemVitals();
      console.log("[Startup] Caches warmed.");
    } catch (e) {
      console.log("[Startup] Cache warming error:", e.message);
    }
    if (CONFIG.fleet.cortex?.enabled && fleet.cortex?.warmup) {
      fleet.cortex.warmup().then(() => console.log("[Startup] Cortex state cache warmed.")).catch((e) => console.log("[Startup] Cortex warming error:", e.message));
    }
    checkOptionalDeps();
  }, 100);
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
