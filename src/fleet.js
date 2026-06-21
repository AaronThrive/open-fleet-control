/**
 * Fleet runtime — instantiates and cross-wires the fleet module family
 * (mesh, chat, kanban + watchdog, briefs, evolution, audit, cortex, alerts,
 * rate limiter) from the `fleet` config section, and exposes:
 *
 *   - start()/stop() lifecycle (mesh poller, stale-task watchdog, board watch)
 *   - fireAlert(event): alerts.fire + SSE broadcast when actually fired
 *   - getSummary(): compact fleet summary for GET /api/state
 *
 * SSE event types broadcast via the injected `broadcast(event, data)`:
 *   fleet.mesh, fleet.chat, fleet.kanban, fleet.evolution, fleet.alert,
 *   fleet.federation
 * Payloads are minimal — clients refetch detail from the REST routes.
 */

const path = require("path");
const os = require("os");
const { createMesh } = require("./mesh");
const { createFederation } = require("./federation");
const { createTailscaleAdapter } = require("./tailscale");
const { createFleetChat } = require("./fleet-chat");
const { createKanban, createWatchdog } = require("./kanban");
const { createBriefs } = require("./briefs");
const { createEvolution } = require("./evolution");
const { createAudit } = require("./audit");
const { createCortex } = require("./cortex");
const { createAlerts, createNodeAlertTracker, createSinkDispatcher } = require("./alerts");
const { createRateLimiter } = require("./rate-limit");
const { createBudgets } = require("./budgets");
const { createDigest } = require("./digest");
const { createDigestsStore } = require("./digests-store");
const { createNtfyIngest } = require("./ntfy-ingest");
const { createCronLog } = require("./cron-log");
const { defaultSecrets } = require("./secrets");

const CORTEX_SUMMARY_TTL_MS = 60000;

const TAILSCALE_PENDING_STATUS = Object.freeze({
  available: false,
  error: "tailscale status refresh pending",
  self: null,
  peers: [],
});

/**
 * Map an empty configured cortex path to a sentinel that never exists, so
 * the adapter reports "unavailable" instead of probing built-in defaults.
 */
function cortexPathOrDisabled(configured, stateDir, name) {
  return configured && configured.length > 0
    ? configured
    : path.join(stateDir, ".cortex-disabled", name);
}

/**
 * Wrap a tailscale adapter so getStatus() never blocks callers on external
 * CLI / LocalAPI latency: it resolves immediately with the last-known status
 * (or a "refresh pending" placeholder before the first refresh lands) and
 * refreshes in the background with single-flight dedupe. The underlying
 * adapter keeps its own TTL cache, so refreshes stay cheap.
 *
 * @param {object} [adapter] - tailscale adapter ({getStatus})
 * @returns {{getStatus: function(): Promise<object>}}
 */
function createNonBlockingTailscale(adapter = createTailscaleAdapter()) {
  let lastKnown = null;
  let refreshing = null;

  function refresh() {
    if (refreshing) return refreshing;
    refreshing = adapter
      .getStatus()
      .then((status) => {
        lastKnown = status;
        return status;
      })
      .catch((e) => {
        // adapter.getStatus never throws by contract — belt and braces
        lastKnown = { available: false, error: e.message, self: null, peers: [] };
        return lastKnown;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  async function getStatus() {
    refresh(); // fire-and-forget background refresh
    return lastKnown || TAILSCALE_PENDING_STATUS;
  }

  // Warm the cache immediately so the first real consumer usually
  // sees actual data instead of the pending placeholder.
  refresh();

  return { getStatus };
}

/**
 * Create the fleet runtime.
 *
 * @param {object} options
 * @param {object} options.config - resolved CONFIG.fleet section
 * @param {function} options.broadcast - (event, data) => void SSE fan-out
 * @returns {object} fleet runtime API
 */
function createFleetRuntime({ config, broadcast }) {
  if (!config || typeof config !== "object") {
    throw new Error("createFleetRuntime requires a config object");
  }
  const emit = typeof broadcast === "function" ? broadcast : () => {};
  const { stateDir, logsDir, briefsDir, workspaceDir } = config;

  const audit = createAudit({ logsDir });

  // Mutable reference: the settings service hot-swaps the alert engine on
  // alerts.* config changes (see applyAlertsConfig). Every consumer below
  // (fireAlert, getSummary) reads the closed-over variable at call time, and
  // the runtime exposes it through a getter, so mesh / watchdog / kanban /
  // evolution hooks and the REST routes always use the current instance.
  let alerts = createAlerts({ config: config.alerts, logsDir });

  // Effective alerts config tracker — the digest reads the CURRENT sink
  // endpoints (fleet.alerts.sinks) at delivery time, surviving settings
  // hot-swaps of the alert engine.
  let currentAlertsConfig = config.alerts || {};

  /**
   * Rebuild the alert engine from a new effective alerts config (hot-apply
   * path for PATCH /api/fleet/settings). The ring buffer of the previous
   * instance is dropped by design — recent alerts are transient UI state;
   * the persistent history (logs/alerts.jsonl) survives rebuilds. The flap
   * tracker keeps its per-node streak state and only swaps thresholds.
   *
   * Values may be 1Password refs (op://...) when the operator stores refs in
   * the settings file — they are resolved here (boot-time configs arrive
   * already resolved by src/config.js; the shared resolver caches refs).
   *
   * @param {object} alertsConfig - effective fleet.alerts config (with secrets)
   */
  function applyAlertsConfig(alertsConfig) {
    const { value: resolvedAlerts, failures } = defaultSecrets.resolveDeepSync(alertsConfig || {});
    for (const failure of failures) {
      console.warn(
        `[Fleet] 1Password ref ${failure.ref} (alerts.${failure.path}) failed: ${failure.error} — keeping the reference in place`,
      );
    }
    alerts = createAlerts({ config: resolvedAlerts, logsDir });
    currentAlertsConfig = resolvedAlerts || {};
    nodeAlertTracker.setFlapConfig(resolvedAlerts && resolvedAlerts.flap);
    console.log("[Fleet] Alerts engine rebuilt from updated settings");
  }

  /**
   * Fire an alert and broadcast fleet.alert when it actually fired
   * (i.e. not disabled / rule-disabled / deduped). Never throws.
   */
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
          ts: Date.now(),
          source: event.source || "ofc",
        });
      }
      return result;
    } catch (e) {
      console.error("[Fleet] Alert fire failed:", e.message);
      return { fired: false, reason: e.message };
    }
  }

  /**
   * Record an already-fired EXTERNAL event (ntfy ingest, cron run log) straight
   * into the alert ring + history (no rule-gating / dedupe / sink re-dispatch),
   * then broadcast fleet.alert so the UI updates live. See alerts.record().
   */
  function recordAlert(event) {
    try {
      const alert = alerts.record(event);
      emit("fleet.alert", {
        type: alert.type,
        severity: alert.severity,
        node: alert.node,
        task: alert.task,
        message: alert.message,
        ts: alert.ts,
        source: alert.source,
      });
      return alert;
    } catch (e) {
      console.error("[Fleet] Alert record failed:", e.message);
      return null;
    }
  }

  // Flap suppression + recovery for node health alerts: nodeOffline /
  // nodeUnreachable fire only after `flap.consecutive` failed polls (default
  // 3) sustained for >= `flap.minDurationMs` (default 60s); a nodeRecovered
  // (info) alert fires once when a previously-alerted node comes back online.
  // Fed from mesh's per-poll onHealth hook (transitions alone cannot see the
  // streak grow). Policy lives in createNodeAlertTracker (src/alerts.js).
  const nodeAlertTracker = createNodeAlertTracker({
    flap: config.alerts && config.alerts.flap,
    fire: fireAlert,
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
    selfHostname: (config.dispatch && config.dispatch.identity) || os.hostname(),
    // Non-blocking by design: mesh.getState() feeds GET /api/state, which
    // must never wait on the tailscale CLI / LocalAPI at request time.
    tailscale: createNonBlockingTailscale(),
    onChange: ({ node, previousStatus, status }) => {
      emit("fleet.mesh", { id: node.id, hostname: node.hostname, previousStatus, status });
    },
    onHealth: ({ node, status, health }) => {
      nodeAlertTracker.observe(node, status, health);
    },
  });

  // Read-only fleet-of-fleets: polls OTHER dashboards' /api/state.
  const federation = createFederation({
    stateDir,
    intervalMs: config.federation.intervalMs,
    onChange: ({ remote, previousReachable, reachable }) => {
      emit("fleet.federation", {
        id: remote.id,
        label: remote.label,
        previousReachable,
        reachable,
      });
    },
  });

  const chat = createFleetChat({ stateDir, logsDir });
  chat.onMessage((message) => {
    emit("fleet.chat", {
      id: message.id,
      sender: message.sender,
      receiver: message.receiver,
      ts: message.ts,
    });
  });

  const kanban = createKanban({
    stateDir,
    onChange: (event) => {
      emit("fleet.kanban", { type: event.type, taskId: event.taskId || null });
      const movedToFailed = event.type === "task.moved" && event.to === "failed";
      const updatedToFailed =
        event.type === "task.updated" &&
        event.task?.status === "failed" &&
        event.previousStatus !== "failed";
      if (movedToFailed || updatedToFailed) {
        fireAlert({
          type: "taskFailed",
          severity: "critical",
          task: event.taskId,
          message: `Task ${event.taskId} marked failed`,
        });
      }
    },
  });

  const watchdog = createWatchdog({
    kanban,
    thresholdMs: config.watchdog.thresholdMs,
    onStale: (task) => {
      fireAlert({
        type: "taskStale",
        severity: "warn",
        task: task.id,
        message: `Task "${task.title}" has had no activity past the staleness threshold`,
      });
    },
  });

  const briefs = createBriefs({ briefsDir });

  const evolution = createEvolution({
    workspaceDir,
    stateDir,
    getGateDefault: () => config.validationGate.default,
    lessonsVaultDir: config.evolution?.lessonsVaultDir || "",
    onChange: (event) => {
      emit("fleet.evolution", { type: event.type, id: event.id || event.lesson?.id || null });
      if (event.type === "lesson.add" && event.lesson?.status === "pending") {
        fireAlert({
          type: "lessonPending",
          severity: "info",
          message: `Lesson pending approval: ${event.lesson.title}`,
        });
      }
    },
  });

  const cortex = createCortex({
    gbrain: { cliPath: cortexPathOrDisabled(config.cortex.gbrainCli, stateDir, "gbrain") },
    gauges: {
      paths: {
        leanCtx: config.cortex.leanCtxStats || "",
        lcmDb: config.cortex.lcmDb || "",
      },
    },
  });

  const rateLimiter = createRateLimiter({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
  });

  // Cost budgets (src/budgets.js): periodic spend-vs-budget evaluation that
  // fires budgetBreach alerts through the normal alert engine. The usage
  // aggregate is INJECTED by the orchestrator via setUsageProvider() because
  // the usage-sources module is instantiated in src/index.js — until wired,
  // getUsage returns null and the evaluator skips with a one-time log.
  let usageProvider = null;

  const budgets = createBudgets({
    config: config.budgets,
    stateFile: path.join(stateDir, "budgets.json"),
    getUsage: (params) => (usageProvider ? usageProvider(params) : null),
    onBreach: (breach) => {
      fireAlert({
        type: "budgetBreach",
        severity: breach.severity === "critical" ? "critical" : "warn",
        task: `${breach.period}:${breach.scope}`,
        message:
          `Budget breach (${breach.severity}): ${breach.scope} spent ` +
          `$${breach.actualUSD.toFixed(2)} of $${breach.budgetUSD.toFixed(2)} ` +
          `(${Math.round(breach.ratio * 100)}%) for ${breach.period} period ${breach.periodKey}`,
      });
    },
  });

  /**
   * Inject the usage aggregate used by the budget evaluator
   * (see createUsageProvider in src/budgets.js). Pass null to unwire.
   */
  function setUsageProvider(fn) {
    usageProvider = typeof fn === "function" ? fn : null;
  }

  /** Hot-apply a new fleet.budgets config (settings PATCH path). */
  function applyBudgetsConfig(budgetsConfig) {
    budgets.applyConfig(budgetsConfig);
    console.log("[Fleet] Budget evaluator reconfigured from updated settings");
  }

  // Scheduled fleet digest (src/digest.js): a 60s tick sends the compact
  // markdown summary through the SHARED sink dispatcher over the current
  // alerts sink endpoints, restricted to fleet.digest.sinks. Sources that
  // live outside this runtime (cron jobs, top token consumers) are injected
  // by the orchestrator via setDigestSources().
  const digestDispatcher = createSinkDispatcher();
  let digestExtras = {};

  // Read-only store over the SAME directory the digest writer persists to
  // (path.join(stateDir, "digests")) — backs the "Digests" tab's list/read.
  const digests = createDigestsStore({ digestsDir: path.join(stateDir, "digests") });

  const digest = createDigest({
    config: config.digest,
    stateFile: path.join(stateDir, "digest.json"),
    digestsDir: path.join(stateDir, "digests"),
    sources: {
      getBudgetStatus: () => budgets.getStatus(),
      getBoard: () => kanban.getBoard(),
      getMeshState: () => mesh.getState(),
      getEvolutionState: () => evolution.getState(),
      getAlertHistory: (filters) => alerts.query(filters),
      getCronJobs: () => (digestExtras.getCronJobs ? digestExtras.getCronJobs() : null),
      getTopConsumers: () => (digestExtras.getTopConsumers ? digestExtras.getTopConsumers() : null),
    },
    deliver: (alert, sinkNames) => {
      const allowAll = !Array.isArray(sinkNames) || sinkNames.includes("*");
      const allowed = allowAll ? null : new Set(sinkNames);
      return digestDispatcher.dispatch(
        currentAlertsConfig.sinks || {},
        alert,
        (sinkName) => allowed === null || allowed.has(sinkName),
      );
    },
  });

  /**
   * Inject digest sources that live outside the fleet runtime
   * ({getCronJobs, getTopConsumers} — wired by src/index.js).
   */
  function setDigestSources(extras) {
    digestExtras = extras && typeof extras === "object" ? extras : {};
  }

  /** Hot-apply a new fleet.digest config (settings PATCH path). */
  function applyDigestConfig(digestConfig) {
    digest.applyConfig(digestConfig);
    console.log("[Fleet] Digest scheduler reconfigured from updated settings");
  }

  // --- Alert ingestion pollers → unified hub (ntfy topic + OpenClaw cron runs) ---
  // Both feed recordAlert() (non-gated log path) so every external alert + cron
  // run shows in the Alerts view tagged source:"ntfy"/"cron". Disabled by default.
  const ingestCfg = (config.alerts && config.alerts.ingest) || {};
  const ntfySink = (config.alerts && config.alerts.sinks && config.alerts.sinks.ntfy) || {};
  const ntfyIngestEnabled = !!(ingestCfg.ntfy && ingestCfg.ntfy.enabled && ntfySink.topic);
  const cronIngestEnabled = !!(ingestCfg.cron && ingestCfg.cron.enabled);
  // No-op stand-in when a poller is disabled. IMPORTANT: createNtfyIngest throws
  // on an empty topic by design, so we must NOT construct it unless it's actually
  // enabled with a real topic — otherwise the server crashes on boot under the
  // default (disabled / empty-topic) config.
  const NOOP_POLLER = { start() {}, stop() {}, getState: () => ({ running: false }) };
  const ntfyIngest = ntfyIngestEnabled
    ? createNtfyIngest({
        server: ntfySink.server || "https://ntfy.sh",
        topic: ntfySink.topic,
        intervalMs: (ingestCfg.ntfy && ingestCfg.ntfy.intervalMs) || 30000,
        stateFile: path.join(stateDir, "ntfy-ingest.json"),
        onAlert: (rec) => recordAlert(rec),
      })
    : NOOP_POLLER;
  const cronLog = cronIngestEnabled
    ? createCronLog({
        intervalMs: (ingestCfg.cron && ingestCfg.cron.intervalMs) || 120000,
        stateFile: path.join(stateDir, "cron-runs-seen.json"),
        onRun: (e) =>
          recordAlert({
            source: "cron",
            type: "cron",
            severity: e.status === "error" ? "warn" : "info",
            node: null,
            task: e.job || null,
            message: `${e.job || "cron"} ${e.status}${e.error ? ": " + e.error : ""}`,
            ts: e.ts,
          }),
      })
    : NOOP_POLLER;

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  let boardWatcher = null;

  function start() {
    mesh.start();
    federation.start();
    watchdog.start();
    budgets.start();
    digest.start();
    if (ntfyIngestEnabled) ntfyIngest.start();
    if (cronIngestEnabled) cronLog.start();
    if (!boardWatcher) boardWatcher = kanban.watch();
  }

  function stop() {
    mesh.stop();
    federation.stop();
    watchdog.stop();
    budgets.stop();
    digest.stop();
    ntfyIngest.stop();
    cronLog.stop();
    if (boardWatcher) {
      boardWatcher.close();
      boardWatcher = null;
    }
    chat.close();
  }

  // ---------------------------------------------------------------------
  // Summary for GET /api/state. Probing cortex availability shells out to
  // external CLIs (openclaw memory-pro, gbrain), so the summary NEVER awaits
  // it: values are served from the last-known cache and refreshed in the
  // background (single-flight). The first call returns the default
  // (all-unavailable) snapshot immediately while the probe warms up.
  // fleet.cortex.enabled=false disables probing entirely.
  // ---------------------------------------------------------------------

  const cortexEnabled = config.cortex.enabled !== false;
  let cortexCache = { value: null, ts: 0 };
  let cortexRefresh = null;

  function refreshCortexAvailability() {
    if (cortexRefresh) return cortexRefresh;
    cortexRefresh = cortex
      .getState()
      .then((cortexState) => {
        cortexCache = {
          value: {
            memory: cortexState.memory.available,
            gbrain: cortexState.gbrain.available,
            gauges: cortexState.gaugeSummary.available,
          },
          ts: Date.now(),
        };
        return cortexCache.value;
      })
      .catch((e) => {
        console.error("[Fleet] Cortex availability refresh failed:", e.message);
        return cortexCache.value;
      })
      .finally(() => {
        cortexRefresh = null;
      });
    return cortexRefresh;
  }

  /**
   * Last-known cortex availability — synchronous, never probes inline.
   * Kicks a background refresh when the cache is missing or stale.
   */
  function getCortexAvailability() {
    if (!cortexEnabled) {
      return { memory: false, gbrain: false, gauges: 0 };
    }
    if (!cortexCache.value || Date.now() - cortexCache.ts >= CORTEX_SUMMARY_TTL_MS) {
      refreshCortexAvailability();
    }
    return cortexCache.value || { memory: false, gbrain: false, gauges: 0 };
  }

  /**
   * Compact fleet summary attached to GET /api/state. Each section is
   * independently guarded so one failing module never hides the rest.
   */
  async function getSummary() {
    const summary = {
      mesh: { nodes: 0, online: 0 },
      chat: { recent: 0, total: 0 },
      kanban: { counts: {}, staleCount: 0 },
      evolution: { gate: null, pendingCount: 0 },
      cortex: { availability: { memory: false, gbrain: false, gauges: 0 } },
      alerts: { recent: 0 },
      federation: { remotes: 0, reachable: 0 },
    };

    try {
      const meshState = await mesh.getState();
      summary.mesh = {
        nodes: meshState.nodes.length,
        online: meshState.nodes.filter((n) => n.health.status === "online").length,
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
        pendingCount: evolutionState.pending.length,
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
    digests,
    applyDigestConfig,
    setDigestSources,
    rateLimiter,
    fireAlert,
    start,
    stop,
    getSummary,
  };
}

module.exports = { createFleetRuntime };
