/**
 * Scheduled fleet digest — composes a compact markdown summary of the fleet
 * (spend vs budgets, kanban throughput, failing cron jobs, mesh node events,
 * pending evolution lessons, top token consumers) and delivers it through
 * the EXISTING alert sink infrastructure (createSinkDispatcher in
 * src/alerts.js — there is exactly one webhook/Slack/ntfy implementation).
 *
 * Config (fleet.digest):
 *   { enabled: false,                  // default OFF
 *     schedule: "daily" | "weekly",    // weekly = Mondays (UTC)
 *     hourUtc: 8,                      // 0..23
 *     sinks: ["*"] }                   // ["*"] | subset of slack/ntfy/webhooks
 *
 * Scheduling: a 60s setInterval tick checks whether the most recent
 * scheduled occurrence is newer than the persisted lastSentAt
 * (state/digest.json) — restarts therefore never double-send, and a missed
 * window (server down at send time) is caught up on the next tick. The
 * first enable initializes lastSentAt to "now" so the first digest goes out
 * at the NEXT scheduled time instead of immediately.
 *
 * Sources (all injected, all individually guarded — a broken source
 * degrades to an "unavailable" line, never an error):
 *   getBudgetStatus()    → budgets.getStatus() shape (src/budgets.js)
 *   getBoard()           → kanban board {tasks: [{status, updated_at, stale}]}
 *   getCronJobs()        → [{name, lastStatus, source}] or null
 *   getMeshState()       → {nodes: [{hostname, health: {status}}]}
 *   getAlertHistory(f)   → persistent alert history rows (alerts.query)
 *   getEvolutionState()  → {gate, pending: [...]}
 *   getTopConsumers()    → [{label, costUSD?, tokens?, requests?}] or null
 *
 * Delivery contract: deliver(alertLike, sinkNames) where alertLike is
 * {type: "fleetDigest", severity: "info", message: <markdown>, ts} and
 * sinkNames is the normalized fleet.digest.sinks list (["*"] = all sinks).
 * The orchestrator (src/fleet.js) maps this onto the shared sink dispatcher
 * over the CURRENT fleet.alerts.sinks endpoints.
 *
 * POST /api/fleet/digest/test (src/fleet-routes.js) calls sendNow() — a
 * test send composes + delivers immediately but never advances lastSentAt,
 * so the scheduled send still fires on time.
 */

const fs = require("fs");
const path = require("path");

const TICK_MS = 60000;
const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;
const DEFAULT_HOUR_UTC = 8;
const SINK_NAMES = ["slack", "ntfy", "webhooks"];
const FAILED_STATUS_RE = /error|fail/i;
const MAX_TOP_CONSUMERS = 5;
const MAX_LIST_NAMES = 6;
const ALERT_HISTORY_SCAN = 500;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Normalize a fleet.digest config section to safe values. */
function normalizeDigestConfig(raw) {
  const src = isPlainObject(raw) ? raw : {};
  let sinks = Array.isArray(src.sinks)
    ? src.sinks.filter((sink) => sink === "*" || SINK_NAMES.includes(sink))
    : ["*"];
  if (sinks.length === 0 || sinks.includes("*")) sinks = ["*"];
  return {
    enabled: src.enabled === true,
    schedule: src.schedule === "weekly" ? "weekly" : "daily",
    hourUtc:
      Number.isInteger(src.hourUtc) && src.hourUtc >= 0 && src.hourUtc <= 23
        ? src.hourUtc
        : DEFAULT_HOUR_UTC,
    sinks,
  };
}

/**
 * Epoch ms of the most recent scheduled occurrence at or before nowMs.
 * Daily: today at hourUtc (or yesterday when not reached yet).
 * Weekly: the most recent Monday (UTC) at hourUtc.
 */
function lastScheduledOccurrence(cfg, nowMs) {
  const date = new Date(nowMs);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (cfg.schedule === "weekly") {
    const dayOfWeek = new Date(dayStart).getUTCDay() || 7; // ISO: Monday = 1
    let occurrence = dayStart - (dayOfWeek - 1) * DAY_MS + cfg.hourUtc * HOUR_MS;
    if (occurrence > nowMs) occurrence -= WEEK_MS;
    return occurrence;
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

/** "a, b, c" capped at MAX_LIST_NAMES with a "+N more" tail. */
function nameList(names) {
  if (names.length <= MAX_LIST_NAMES) return names.join(", ");
  return `${names.slice(0, MAX_LIST_NAMES).join(", ")} +${names.length - MAX_LIST_NAMES} more`;
}

// ---------------------------------------------------------------------------
// Section composers (pure over their source payload — unit-testable)
// ---------------------------------------------------------------------------

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
      const marker = scope.state === "critical" ? " ⛔" : scope.state === "warn" ? " ⚠" : "";
      lines.push(
        `- ${period} ${scope.scope}: ${fmtUsd(scope.spentUSD)} / ${fmtUsd(scope.limitUSD)} (${scope.percent}%)${marker}`,
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
  return [`- done: ${done} · failed: ${failed} · stuck: ${stuck} (of ${tasks.length} cards)`];
}

function composeCronLines(jobs) {
  if (!Array.isArray(jobs)) return ["- cron data unavailable"];
  if (jobs.length === 0) return ["- no cron jobs registered"];
  const failing = jobs.filter(
    (job) => job && typeof job.lastStatus === "string" && FAILED_STATUS_RE.test(job.lastStatus),
  );
  if (failing.length === 0) return [`- all green (${jobs.length} jobs)`];
  return failing.map(
    (job) => `- FAILING: ${job.name || job.id || "unnamed"} (last status: ${job.lastStatus})`,
  );
}

function composeMeshLines(meshState, alertRows) {
  const lines = [];
  const nodes = Array.isArray(meshState && meshState.nodes) ? meshState.nodes : [];
  const downNow = nodes.filter(
    (n) => n.health && (n.health.status === "offline" || n.health.status === "unreachable"),
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
    if (row && counts[row.type] !== undefined) counts[row.type]++;
  }
  const total = counts.nodeOffline + counts.nodeUnreachable + counts.nodeRecovered;
  if (total > 0) {
    const flapped = counts.nodeRecovered > 0 && counts.nodeOffline + counts.nodeUnreachable > 0;
    lines.push(
      `- events since last digest: ${counts.nodeOffline} offline, ` +
        `${counts.nodeUnreachable} unreachable, ${counts.nodeRecovered} recovered` +
        (flapped ? " (flapping)" : ""),
    );
  }
  return lines;
}

function composeLessonLines(evolutionState) {
  const pending = Array.isArray(evolutionState && evolutionState.pending)
    ? evolutionState.pending
    : [];
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
    return `- ${c.label}: ${parts.join(" · ") || "n/a"}`;
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the fleet digest module.
 *
 * @param {object} options
 * @param {object} [options.config] - fleet.digest section (see header)
 * @param {string} [options.stateFile] - persisted {lastSentAt} path
 * @param {object} [options.sources] - injected data sources (see header)
 * @param {function} options.deliver - (alertLike, sinkNames) => Promise<{dispatched, delivered, suppressed?}>
 * @param {function} [options.nowFn=Date.now]
 * @param {object} [options.log=console]
 * @returns {{start, stop, tick, composeDigest, sendNow, applyConfig, getState}}
 */
function createDigest({
  config,
  stateFile = null,
  sources = {},
  deliver,
  nowFn = Date.now,
  log = console,
} = {}) {
  if (typeof deliver !== "function") throw new TypeError("createDigest requires deliver");

  let cfg = normalizeDigestConfig(config);
  let timer = null;
  let sending = null;
  let state = loadState(); // { lastSentAt: number|null }

  function loadState() {
    const empty = { lastSentAt: null };
    if (!stateFile) return empty;
    try {
      if (!fs.existsSync(stateFile)) return empty;
      const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      return {
        lastSentAt: Number.isFinite(raw && raw.lastSentAt) ? raw.lastSentAt : null,
      };
    } catch (e) {
      log.warn(`[Digest] Failed to read state file ${stateFile}: ${e.message}`);
      return empty;
    }
  }

  function saveState() {
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmpFile = `${stateFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmpFile, `${JSON.stringify(state, null, 2)}\n`);
      fs.renameSync(tmpFile, stateFile);
    } catch (e) {
      log.warn(`[Digest] Failed to persist state to ${stateFile}: ${e.message}`);
    }
  }

  /** Await one source; a missing or broken source resolves to null. */
  async function readSource(name, ...args) {
    const fn = sources[name];
    if (typeof fn !== "function") return null;
    try {
      const value = await fn(...args);
      return value === undefined ? null : value;
    } catch (e) {
      log.error(`[Digest] Source ${name} failed: ${e.message}`);
      return null;
    }
  }

  /**
   * Compose the digest markdown. `sinceMs` defaults to the persisted
   * lastSentAt, falling back to one schedule period before now.
   *
   * @param {object} [options] - {now?, sinceMs?}
   * @returns {Promise<{title: string, markdown: string, sinceMs: number, generatedAt: number}>}
   */
  async function composeDigest({ now = nowFn(), sinceMs = null } = {}) {
    const fallbackWindow = cfg.schedule === "weekly" ? WEEK_MS : DAY_MS;
    const since = Number.isFinite(sinceMs)
      ? sinceMs
      : Number.isFinite(state.lastSentAt)
        ? state.lastSentAt
        : now - fallbackWindow;

    const [budgetStatus, board, cronJobs, meshState, alertRows, evolutionState, consumers] =
      await Promise.all([
        readSource("getBudgetStatus"),
        readSource("getBoard"),
        readSource("getCronJobs"),
        readSource("getMeshState"),
        readSource("getAlertHistory", { since, limit: ALERT_HISTORY_SCAN }),
        readSource("getEvolutionState"),
        readSource("getTopConsumers"),
      ]);

    const title = `Fleet digest (${cfg.schedule}) — ${fmtUtc(now)}`;
    const lines = [
      `**${title}**`,
      `_since ${fmtUtc(since)}_`,
      "",
      "**Spend vs budgets**",
      ...composeBudgetLines(budgetStatus),
      "",
      "**Kanban throughput**",
      ...(board ? composeKanbanLines(board, since) : ["- kanban unavailable"]),
      "",
      "**Cron**",
      ...composeCronLines(cronJobs),
      "",
      "**Mesh**",
      ...(meshState ? composeMeshLines(meshState, alertRows) : ["- mesh unavailable"]),
      "",
      "**Evolution**",
      ...composeLessonLines(evolutionState),
      "",
      "**Top token consumers**",
      ...composeConsumerLines(consumers),
    ];

    return { title, markdown: lines.join("\n"), sinceMs: since, generatedAt: now };
  }

  /**
   * Compose and deliver a digest now. Scheduled sends advance lastSentAt
   * (persisted); test sends (the default) never do.
   *
   * @param {object} [options] - {scheduled?: boolean}
   * @returns {Promise<object>} {sent, scheduled, title, markdown, dispatched, delivered, suppressed?}
   */
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
          ts: now,
        },
        [...cfg.sinks],
      );
    } catch (e) {
      log.error(`[Digest] Delivery failed: ${e.message}`);
      return { sent: false, scheduled, error: e.message, title: digest.title };
    }
    if (scheduled) {
      state = { ...state, lastSentAt: now };
      saveState();
    }
    return {
      sent: true,
      scheduled,
      title: digest.title,
      markdown: digest.markdown,
      dispatched: result && Number.isFinite(result.dispatched) ? result.dispatched : 0,
      delivered: result && Number.isFinite(result.delivered) ? result.delivered : 0,
      ...(result && result.suppressed ? { suppressed: true } : {}),
    };
  }

  /**
   * One scheduler tick: send when the most recent scheduled occurrence is
   * newer than lastSentAt. Single-flight; never throws.
   */
  function tick() {
    if (!cfg.enabled || sending) return sending;
    const now = nowFn();
    const occurrence = lastScheduledOccurrence(cfg, now);
    if (Number.isFinite(state.lastSentAt) && state.lastSentAt >= occurrence) return null;
    sending = sendNow({ scheduled: true })
      .then((result) => {
        if (result.sent) {
          log.log(`[Digest] Scheduled ${cfg.schedule} digest sent (${result.delivered} delivered)`);
        }
        return result;
      })
      .catch((e) => {
        log.error(`[Digest] Scheduled send failed: ${e.message}`);
        return { sent: false, error: e.message };
      })
      .finally(() => {
        sending = null;
      });
    return sending;
  }

  function start() {
    if (timer || !cfg.enabled) return;
    // First-ever enable: anchor lastSentAt to "now" so the first digest goes
    // out at the NEXT scheduled time instead of immediately on boot.
    if (!Number.isFinite(state.lastSentAt)) {
      state = { ...state, lastSentAt: nowFn() };
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

  /** Hot-apply a new fleet.digest config (settings PATCH path). */
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
      lastSentAt: state.lastSentAt,
      nextDueAt: cfg.enabled
        ? lastScheduledOccurrence(cfg, nowFn()) + (cfg.schedule === "weekly" ? WEEK_MS : DAY_MS)
        : null,
    };
  }

  return { start, stop, tick, composeDigest, sendNow, applyConfig, getState };
}

/**
 * Standard getTopConsumers source over the usage-sources module: claude-code
 * 24h estimate plus the top 9Router models by 24h cost. Every sub-source is
 * individually guarded.
 *
 * @param {object} options - { usageSources, nowFn? }
 * @returns {function(): Promise<Array<{label, costUSD?, tokens?, requests?}>>}
 */
function createTopConsumersSource({ usageSources, nowFn = Date.now }) {
  if (!usageSources || !usageSources.sources) {
    throw new TypeError("createTopConsumersSource requires a usageSources instance");
  }
  const { claudeCode, nineRouter } = usageSources.sources;

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
            tokens:
              (Number(bucket.input) || 0) +
              (Number(bucket.output) || 0) +
              (Number(bucket.cacheRead) || 0) +
              (Number(bucket.cacheWrite) || 0),
            requests: Number(bucket.requests) || 0,
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
              requests: Number(row.requests) || 0,
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

module.exports = {
  createDigest,
  createTopConsumersSource,
  normalizeDigestConfig,
  lastScheduledOccurrence,
};
