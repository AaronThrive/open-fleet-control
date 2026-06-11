/**
 * Agent Flight Recorder — read-model aggregation of one agent's activity.
 *
 * Answers "what did this agent actually do?" by merging data the dashboard
 * ALREADY collects into a single chronological timeline. No new collection,
 * no persistence — every call re-reads the injected sources:
 *
 *   - sessions   — per-agent OpenClaw session store
 *                  (<agentsDir>/<id>/sessions/sessions.json). Entries carry
 *                  sessionStartedAt + updatedAt (last activity) + token
 *                  totals, so session.start / session.end events are exact.
 *   - kanban     — board tasks: attempts[] where attempt.agent matches give
 *                  dispatch / dispatch.result events; comments authored by
 *                  the agent become note events.
 *   - audit      — logs/audit.jsonl via the audit module's query() (already
 *                  bounded + rotation-aware); entries where the agent is the
 *                  actor (user), the target, or detail.agent.
 *   - cron       — the cron adapter's job list; jobs whose `agent` matches
 *                  and that expose lastRunAtMs become cron.run events.
 *
 * Normalized event shape:
 *   { ts, type, title, detail, refs: { taskId?, sessionKey? } }
 * with type one of EVENT_TYPES.
 *
 * Known attribution gaps (surfaced in summary.gaps so the UI can say so):
 *   - cost is NOT attributable per agent (cost breakdowns are global); the
 *     summary carries session token totals instead and cost stays null.
 *   - cron state only keeps the LAST run per job, not a run history.
 *
 * Windowing/pagination: getTimeline() never loads unbounded data — the audit
 * source is queried with the window + a hard cap, the session store is one
 * bounded JSON file per agent, and the response is capped at `limit` events
 * (newest first) with a nextUntil cursor for "load more".
 */

const fs = require("fs");
const path = require("path");

const EVENT_TYPES = Object.freeze([
  "session.start",
  "session.end",
  "dispatch",
  "dispatch.result",
  "cron.run",
  "audit",
  "note",
]);

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const AUDIT_SCAN_LIMIT = 1000; // hard cap honoured by src/audit.js query()
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
// A session whose last activity is older than this is considered ended
// (mirrors the sessions view's "active" threshold).
const SESSION_ENDED_AFTER_MS = 15 * 60 * 1000;
const DETAIL_TEXT_MAX = 300;

// Agent ids are config tokens (e.g. "main", "ghl_leadattractor") — never
// paths. First char alphanumeric so "." / ".." can never match.
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/** Parse a since/until query value (ISO string or epoch ms) to epoch ms. */
function parseTimeParam(value, label) {
  if (value === undefined || value === null || value === "") return null;
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

/** Normalize the types filter (array or comma string) to a validated Set. */
function parseTypesParam(types) {
  if (types === undefined || types === null || types === "") return null;
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
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * Default sessions source: reads the per-agent OpenClaw session store
 * (<agentsDir>/<agentId>/sessions/sessions.json — the same file family the
 * sessions module and agents roster already read). Missing/corrupt stores
 * degrade to [] — never a throw.
 *
 * @param {object} options
 * @param {string} options.agentsDir - the OpenClaw agents directory
 * @returns {function(string): Array<object>} readAgentSessions(agentId)
 */
function createStoreSessionsSource({ agentsDir } = {}) {
  if (typeof agentsDir !== "string" || agentsDir.length === 0) {
    throw new Error("createStoreSessionsSource requires an agentsDir option");
  }
  return function readAgentSessions(agentId) {
    if (!AGENT_ID_RE.test(agentId)) return [];
    const storePath = path.join(agentsDir, agentId, "sessions", "sessions.json");
    let store;
    try {
      store = JSON.parse(fs.readFileSync(storePath, "utf8"));
    } catch (e) {
      return []; // no store / unreadable / malformed — an empty timeline source
    }
    if (!store || typeof store !== "object" || Array.isArray(store)) return [];
    return Object.entries(store)
      .filter(([, v]) => v && typeof v === "object")
      .map(([key, v]) => ({
        key,
        sessionId: typeof v.sessionId === "string" ? v.sessionId : null,
        sessionStartedAt: Number.isFinite(v.sessionStartedAt) ? v.sessionStartedAt : null,
        updatedAt: Number.isFinite(v.updatedAt) ? v.updatedAt : null,
        totalTokens: Number.isFinite(v.totalTokens)
          ? v.totalTokens
          : (v.inputTokens || 0) + (v.outputTokens || 0),
        model: typeof v.model === "string" ? v.model : null,
        label:
          (typeof v.displayName === "string" && v.displayName) ||
          (typeof v.groupChannel === "string" && v.groupChannel) ||
          (typeof v.label === "string" && v.label) ||
          null,
      }));
  };
}

/**
 * Create the flight recorder. All sources are injected; each one is optional
 * (an absent source simply contributes no events) and each is fault-isolated
 * (a throwing source degrades to a summary.gaps note, never a failed call).
 *
 * @param {object} options
 * @param {function} [options.readAgentSessions] - (agentId) => session entries
 *        ({key, sessionId, sessionStartedAt, updatedAt, totalTokens, model, label})
 * @param {function} [options.getBoard] - () => kanban board ({tasks: [...]})
 * @param {function} [options.queryAudit] - ({since, until, limit}) => audit entries
 * @param {function} [options.getCronJobs] - () => cron jobs (incl. lastRunAtMs)
 * @param {function} [options.nowFn] - clock (epoch ms), injectable for tests
 * @returns {{getTimeline: function}}
 */
function createFlightRecorder(options = {}) {
  const {
    readAgentSessions = null,
    getBoard = null,
    queryAudit = null,
    getCronJobs = null,
    nowFn = Date.now,
  } = options;

  // ---- per-source collectors (raw events carry tsMs; ts is added late) ----

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
          title: `Session started — ${label}`,
          detail: { sessionId: s.sessionId, model: s.model },
          refs,
        });
      }
      // Last activity counts as the session END once the session has gone
      // quiet; a still-active session has not ended yet, so no event.
      const lastMs = s.updatedAt;
      if (Number.isFinite(lastMs) && nowMs - lastMs > SESSION_ENDED_AFTER_MS) {
        events.push({
          tsMs: lastMs,
          type: "session.end",
          title: `Session ended — ${label}`,
          detail: { sessionId: s.sessionId, model: s.model, tokens: s.totalTokens ?? null },
          refs,
        });
      }
    }
    return events;
  }

  /** Sum of token totals for sessions whose lifetime overlaps the window. */
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
            refs,
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
              branch: attempt.branch ?? null,
            },
            refs,
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
          refs,
        });
      }
    }
    return events;
  }

  function collectCronEvents(agentId) {
    if (typeof getCronJobs !== "function") return [];
    const jobs = getCronJobs();
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
          source: job.source ?? null,
        },
        refs: {},
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
        title: rec.target ? `${rec.action} → ${rec.target}` : String(rec.action),
        detail: {
          user: rec.user ?? null,
          action: rec.action ?? null,
          target: rec.target ?? null,
          context: rec.detail ?? null,
          role: rec.user === agentId ? "actor" : rec.target === agentId ? "target" : "mentioned",
        },
        refs,
      });
    }
    return events;
  }

  // ---- public API ----------------------------------------------------------

  /**
   * Build the timeline for one agent.
   *
   * @param {string} agentId
   * @param {object} [opts]
   * @param {string|number} [opts.since] - window start (default until - 24h)
   * @param {string|number} [opts.until] - window end (default now)
   * @param {string|string[]} [opts.types] - event-type filter (comma list)
   * @param {number} [opts.limit] - max events returned (default 200, cap 1000)
   * @returns {{agent, range, events, summary, page}}
   */
  function getTimeline(agentId, opts = {}) {
    if (typeof agentId !== "string" || !AGENT_ID_RE.test(agentId)) {
      throw httpError(400, "Invalid agent id");
    }
    const limitRaw = opts.limit === undefined || opts.limit === null ? DEFAULT_LIMIT : opts.limit;
    if (!Number.isInteger(limitRaw) || limitRaw < 1) {
      throw httpError(400, "limit must be a positive integer");
    }
    const limit = Math.min(limitRaw, MAX_LIMIT);

    const nowMs = nowFn();
    const untilMs = parseTimeParam(opts.until, "until") ?? nowMs;
    const sinceMs = parseTimeParam(opts.since, "since") ?? untilMs - DEFAULT_WINDOW_MS;
    if (sinceMs > untilMs) throw httpError(400, "since must not be later than until");
    const typeFilter = parseTypesParam(opts.types);

    // Standing attribution gaps + any source failures from this call.
    const gaps = [
      "cost is not attributable per agent — summary.tokens carries the session token totals instead",
      "cron state only records the most recent run per job (no run history)",
    ];

    const collected = [];
    const collectors = [
      ["sessions", () => collectSessionEvents(agentId, nowMs)],
      ["kanban", () => collectKanbanEvents(agentId)],
      ["cron", () => collectCronEvents(agentId)],
      ["audit", () => collectAuditEvents(agentId, sinceMs, untilMs)],
    ];
    for (const [name, collect] of collectors) {
      try {
        collected.push(...collect());
      } catch (e) {
        console.error(`[FlightRecorder] ${name} source failed:`, e.message);
        gaps.push(`${name} source unavailable: ${e.message}`);
      }
    }

    const windowed = collected
      .filter((ev) => ev.tsMs >= sinceMs && ev.tsMs <= untilMs)
      .filter((ev) => !typeFilter || typeFilter.has(ev.type))
      .sort((a, b) => b.tsMs - a.tsMs || a.type.localeCompare(b.type));

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
        refs,
      })),
      summary: { total: windowed.length, counts, tokens, cost: null, gaps },
      page: {
        limit,
        hasMore,
        nextUntil: hasMore ? pageEvents[pageEvents.length - 1].tsMs - 1 : null,
      },
    };
  }

  return { getTimeline };
}

module.exports = { createFlightRecorder, createStoreSessionsSource, EVENT_TYPES };
