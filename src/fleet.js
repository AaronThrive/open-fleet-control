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
 *   fleet.mesh, fleet.chat, fleet.kanban, fleet.evolution, fleet.alert
 * Payloads are minimal — clients refetch detail from the REST routes.
 */

const path = require("path");
const { createMesh } = require("./mesh");
const { createFleetChat } = require("./fleet-chat");
const { createKanban, createWatchdog } = require("./kanban");
const { createBriefs } = require("./briefs");
const { createEvolution } = require("./evolution");
const { createAudit } = require("./audit");
const { createCortex } = require("./cortex");
const { createAlerts } = require("./alerts");
const { createRateLimiter } = require("./rate-limit");

const CORTEX_SUMMARY_TTL_MS = 60000;

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
  const alerts = createAlerts({ config: config.alerts });

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
    onChange: ({ node, previousStatus, status }) => {
      emit("fleet.mesh", { id: node.id, hostname: node.hostname, previousStatus, status });
      if (status === "offline") {
        fireAlert({
          type: "nodeOffline",
          severity: "critical",
          node: node.hostname,
          message: `Node ${node.hostname} went offline (was ${previousStatus})`,
        });
      } else if (status === "unreachable") {
        fireAlert({
          type: "nodeUnreachable",
          severity: "warn",
          node: node.hostname,
          message: `Node ${node.hostname} is unreachable (was ${previousStatus})`,
        });
      }
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
    lancedb: { dbPath: cortexPathOrDisabled(config.cortex.lancedbPath, stateDir, "lancedb") },
    gbrain: { cliPath: cortexPathOrDisabled(config.cortex.gbrainCli, stateDir, "gbrain") },
    gauges: {
      paths: {
        headroom: config.cortex.headroomStats || "",
        leanCtx: config.cortex.leanCtxStats || "",
        lcmDb: config.cortex.lcmDb || "",
      },
    },
  });

  const rateLimiter = createRateLimiter({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
  });

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  let boardWatcher = null;

  function start() {
    mesh.start();
    watchdog.start();
    if (!boardWatcher) boardWatcher = kanban.watch();
  }

  function stop() {
    mesh.stop();
    watchdog.stop();
    if (boardWatcher) {
      boardWatcher.close();
      boardWatcher = null;
    }
    chat.close();
  }

  // ---------------------------------------------------------------------
  // Summary for GET /api/state (cortex availability is TTL-cached because
  // probing it may shell out to CLIs)
  // ---------------------------------------------------------------------

  let cortexCache = { value: null, ts: 0 };

  async function getCortexAvailability() {
    if (cortexCache.value && Date.now() - cortexCache.ts < CORTEX_SUMMARY_TTL_MS) {
      return cortexCache.value;
    }
    const cortexState = await cortex.getState();
    const value = {
      memory: cortexState.memory.available,
      gbrain: cortexState.gbrain.available,
      gauges: cortexState.gaugeSummary.available,
    };
    cortexCache = { value, ts: Date.now() };
    return value;
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
      summary.cortex = { availability: await getCortexAvailability() };
    } catch (e) {
      console.error("[Fleet] Summary cortex failed:", e.message);
    }

    try {
      summary.alerts = { recent: alerts.getRecent().length };
    } catch (e) {
      console.error("[Fleet] Summary alerts failed:", e.message);
    }

    return summary;
  }

  return {
    mesh,
    chat,
    kanban,
    watchdog,
    briefs,
    evolution,
    audit,
    cortex,
    alerts,
    rateLimiter,
    fireAlert,
    start,
    stop,
    getSummary,
  };
}

module.exports = { createFleetRuntime };
