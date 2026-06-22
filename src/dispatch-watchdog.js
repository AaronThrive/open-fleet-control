/**
 * Dispatch liveness watchdog + stale-lock sweeper (Phase E).
 *
 * Ported CONCEPT from paperclip's recovery service, adapted to OFC's kanban
 * store: a periodic sweep that finds in-flight dispatches whose lock has gone
 * SILENT past a threshold, reclaims the lock so the work can be retried instead
 * of being wedged forever, with bounded retries and a snooze/re-arm so the same
 * card isn't reclaimed every tick.
 *
 * What a "stuck dispatch" looks like here: a kanban card carrying an OPEN
 * dispatched attempt (ended_at===null, note starts with "dispatched") whose
 * started_at is older than `staleAfterMs`. In normal operation the dispatch
 * watcher (src/dispatch.js handleRunSettled) closes the attempt when the agent
 * run settles. If the SERVER crashed mid-run, or the agent process vanished
 * without the CLI returning, that close never happens and the card is stuck in
 * assigned/inprogress with a perpetually-open lock — counting against the
 * concurrency cap and blocking re-dispatch (409). This sweeper is the recovery
 * path for exactly that failure.
 *
 * SAFETY (this runs on a LIVE fleet and reclaims real locks):
 *   - Conservative defaults: 60s interval, 25min stale threshold (well beyond a
 *     normal Codex turn), 2 retries. A legitimately long-running dispatch is
 *     protected as long as staleAfterMs > its real runtime; tune via config.
 *   - Gated behind fleet.dispatchWatchdog.enabled. When disabled, the caller
 *     constructs the NOOP stand-in (mirrors the budgets/ntfy poller pattern) so
 *     boot never depends on the feature being configured.
 *   - Snooze/re-arm: a reclaimed lock is fingerprinted by its started_at; that
 *     exact lock is never reclaimed twice. A NEW dispatch (different started_at)
 *     becomes eligible only once IT goes stale. Bookkeeping for cards that
 *     recover (lock closed) or are deleted is dropped.
 *   - Bounded retries: after `maxRetries` reclaims, the card is moved to
 *     `failed` (needs-attention) instead of being re-dispatched forever.
 *   - Every reclaim fires a `dispatchReclaimed` alert through the injected
 *     fireAlert hook so the action is observable.
 *
 * The sweeper itself NEVER throws out of a tick — a single bad card can't wedge
 * the loop or crash the server.
 */

const dispatchMod = require("./dispatch");

const DEFAULT_CHECK_INTERVAL_MS = 60 * 1000; // 60s
const DEFAULT_STALE_AFTER_MS = 25 * 60 * 1000; // 25 min (safely past the 20-min dispatch timeout)
const MIN_STALE_GRACE_MS = 60 * 1000; // floor margin past timeoutSec
const DEFAULT_MAX_RETRIES = 2;
const WATCHDOG_ACTOR = "dispatch-watchdog";

/** Reclaim threshold the same way dispatch.js measures an open lock. */
function openTtlMsFrom(config) {
  // Mirror dispatch's lock TTL math so "open" means the same thing in both
  // places. timeoutSec drives the agent CLI timeout; 15min grace matches
  // OPEN_ATTEMPT_GRACE_MS in dispatch.js. We re-derive it locally rather than
  // importing a private constant.
  const timeoutSec = Number.isInteger(config.timeoutSec) ? config.timeoutSec : 1200;
  return timeoutSec * 1000 + 15 * 60 * 1000;
}

/**
 * Create the dispatch watchdog.
 *
 * @param {object} options
 * @param {object} options.kanban - kanban engine from createKanban()
 * @param {object} [options.config] - fleet.dispatchWatchdog config:
 *   {enabled, checkIntervalMs=60000, staleAfterMs=900000, maxRetries=2}
 * @param {object} [options.dispatchConfig] - fleet.dispatch config (read for
 *   timeoutSec to size the open-lock TTL; never mutated)
 * @param {function} [options.redispatch] - (taskId, {agent}) => void; called to
 *   re-run a reclaimed card that is still under the retry cap. Injected by the
 *   orchestrator as a thin wrapper over dispatch.dispatchTask. When absent, a
 *   reclaimed card is freed (lock closed) but NOT auto-re-dispatched.
 * @param {function} [options.fireAlert] - (event) => void|Promise; fired with a
 *   `dispatchReclaimed` alert per reclaim. Gating + sink delivery live in the
 *   alerts engine.
 * @param {function} [options.now] - injectable clock (epoch ms)
 * @returns {{check: function, start: function, stop: function, getState: function}}
 */
function createDispatchWatchdog(options = {}) {
  const {
    kanban,
    config = {},
    dispatchConfig = {},
    redispatch = null,
    fireAlert = null,
    now = () => Date.now(),
  } = options;
  if (!kanban) throw new Error("createDispatchWatchdog: kanban is required");

  const checkIntervalMs = Number.isInteger(config.checkIntervalMs)
    ? config.checkIntervalMs
    : DEFAULT_CHECK_INTERVAL_MS;
  const configuredStaleAfterMs = Number.isInteger(config.staleAfterMs)
    ? config.staleAfterMs
    : DEFAULT_STALE_AFTER_MS;
  // SAFETY FLOOR: the reclaim threshold can NEVER drop into the window where a
  // dispatch could still be legitimately running. A live dispatch closes its own
  // attempt at timeoutSec (+5s); any attempt still open past timeoutSec + grace is
  // genuinely wedged (e.g. server crashed mid-run), not slow. Flooring here means a
  // misconfigured small staleAfterMs can never cause the watchdog to re-dispatch
  // live work in parallel.
  const timeoutSec = Number.isInteger(dispatchConfig.timeoutSec) ? dispatchConfig.timeoutSec : 1200;
  const minStaleAfterMs = timeoutSec * 1000 + MIN_STALE_GRACE_MS;
  const staleAfterMs = Math.max(configuredStaleAfterMs, minStaleAfterMs);
  const maxRetries = Number.isInteger(config.maxRetries) ? config.maxRetries : DEFAULT_MAX_RETRIES;
  const openTtlMs = openTtlMsFrom(dispatchConfig);

  let timer = null;
  // Per-card reclaim bookkeeping: taskId -> {retries, lastReclaimedStartedAt}.
  // The snooze key is the started_at of the lock we last reclaimed; we never
  // reclaim that exact lock twice, only a new one once it goes stale.
  const state = new Map();

  /** Find the latest open dispatched attempt + its index, or null. */
  function findOpenDispatch(task, nowMs) {
    for (let i = task.attempts.length - 1; i >= 0; i--) {
      if (dispatchMod.isOpenDispatchAttempt(task.attempts[i], nowMs, openTtlMs)) {
        return { attempt: task.attempts[i], index: i };
      }
    }
    return null;
  }

  function emitReclaimAlert({ taskId, agent, retries, willRetry }) {
    if (typeof fireAlert !== "function") return;
    const message =
      `Dispatch lock reclaimed for task ${taskId} (agent ${agent}) — ` +
      (willRetry
        ? `silent past threshold, re-dispatching (retry ${retries}/${maxRetries})`
        : `silent past threshold, retry cap (${maxRetries}) reached → marked failed`);
    try {
      Promise.resolve(
        fireAlert({
          type: "dispatchReclaimed",
          severity: willRetry ? "warn" : "critical",
          task: taskId,
          message,
        }),
      ).catch((e) =>
        console.error("[DispatchWatchdog] dispatchReclaimed alert failed:", e.message),
      );
    } catch (e) {
      console.error("[DispatchWatchdog] dispatchReclaimed alert failed:", e.message);
    }
  }

  /**
   * Reclaim one stuck card: close its open lock as a timeout, then either
   * re-dispatch (under cap) or mark failed (cap reached). Never throws.
   * @returns {boolean} true if a reclaim happened
   */
  function reclaim(task, open, nowMs) {
    const taskId = task.id;
    const agent = open.attempt.agent;
    const prior = state.get(taskId) || { retries: 0 };
    const retries = prior.retries + 1;
    const willRetry = retries <= maxRetries && typeof redispatch === "function";

    // Close the stuck attempt as a timeout so it stops counting as an open
    // lock (frees the concurrency slot) and the card stops being wedged.
    try {
      kanban.updateAttempt(taskId, open.index, {
        ended_at: new Date(nowMs).toISOString(),
        result: "failure",
        note: `${dispatchMod.DISPATCH_NOTE} · reclaimed: no activity past ${Math.round(
          staleAfterMs / 1000,
        )}s (watchdog)`,
      });
    } catch (e) {
      console.error(`[DispatchWatchdog] could not close stuck attempt on ${taskId}:`, e.message);
      return false;
    }

    try {
      kanban.addComment(taskId, {
        author: WATCHDOG_ACTOR,
        text: willRetry
          ? `[Watchdog] Reclaimed stuck dispatch (agent ${agent}); re-dispatching (retry ${retries}/${maxRetries}).`
          : `[Watchdog] Reclaimed stuck dispatch (agent ${agent}); retry cap (${maxRetries}) reached — needs attention.`,
      });
    } catch (e) {
      console.error(`[DispatchWatchdog] could not comment on ${taskId}:`, e.message);
    }

    if (willRetry) {
      // Snooze: remember the new attempt count AFTER re-dispatch fires so the
      // fresh open attempt doesn't get re-swept until IT goes stale.
      try {
        redispatch(taskId, { agent });
      } catch (e) {
        console.error(`[DispatchWatchdog] re-dispatch of ${taskId} failed:`, e.message);
      }
    } else {
      // Cap reached (or no redispatch wired): move to failed if still in a
      // non-final column. Best-effort.
      try {
        const fresh = kanban.getBoard().tasks.find((t) => t.id === taskId);
        if (fresh && (fresh.status === "assigned" || fresh.status === "inprogress")) {
          kanban.moveTask(taskId, "failed", fresh.order, WATCHDOG_ACTOR);
        }
      } catch (e) {
        console.error(`[DispatchWatchdog] could not move ${taskId} to failed:`, e.message);
      }
    }

    // Snooze keyed on the SPECIFIC lock we just reclaimed (its started_at is a
    // stable fingerprint of that attempt). We never reclaim the same lock
    // twice; a re-dispatch opens a NEW lock with a fresh started_at, which only
    // becomes eligible once IT goes stale — giving bounded retries without
    // thrashing the same attempt every tick.
    state.set(taskId, { retries, lastReclaimedStartedAt: open.attempt.started_at });

    emitReclaimAlert({ taskId, agent, retries, willRetry });
    return true;
  }

  /**
   * One sweep. Returns the ids reclaimed this tick. Never throws.
   * @returns {string[]}
   */
  function check() {
    let board;
    try {
      board = kanban.getBoard();
    } catch (e) {
      console.error("[DispatchWatchdog] board read failed:", e.message);
      return [];
    }
    const nowMs = now();
    const reclaimed = [];
    const liveIds = new Set();

    for (const task of board.tasks) {
      liveIds.add(task.id);
      const open = findOpenDispatch(task, nowMs);
      if (!open) {
        // No open lock — re-arm (drop snooze) so a future dispatch is eligible.
        state.delete(task.id);
        continue;
      }
      const startedMs = Date.parse(open.attempt.started_at);
      const silentMs = Number.isNaN(startedMs) ? Infinity : nowMs - startedMs;
      if (silentMs <= staleAfterMs) continue; // still fresh — leave it alone

      // Snooze guard: don't reclaim the SAME open lock twice. The started_at of
      // the open attempt fingerprints it; once we've reclaimed that lock we
      // skip it until a NEW lock (different started_at) appears.
      const prior = state.get(task.id);
      if (prior && prior.lastReclaimedStartedAt === open.attempt.started_at) continue;

      if (reclaim(task, open, nowMs)) reclaimed.push(task.id);
    }

    // Drop bookkeeping for deleted cards.
    for (const id of state.keys()) {
      if (!liveIds.has(id)) state.delete(id);
    }
    return reclaimed;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      try {
        check();
      } catch (e) {
        console.error("[DispatchWatchdog] sweep threw:", e.message);
      }
    }, checkIntervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function getState() {
    return {
      running: timer !== null,
      checkIntervalMs,
      staleAfterMs,
      maxRetries,
      tracked: state.size,
    };
  }

  return { check, start, stop, getState };
}

module.exports = { createDispatchWatchdog };
