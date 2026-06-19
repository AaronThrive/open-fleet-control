/**
 * Flight Recorder routes — HTTP read-layer over the run archive (durable) and
 * the orchestrate run registry (live, in-progress).
 *
 *   GET /api/fleet/flight-recorder/runs?status=&agent=&node=&limit=&before=
 *     → { success, runs: [...], page: {limit, hasMore, nextBefore} }
 *
 *   GET /api/fleet/flight-recorder/runs/:runId
 *     → { success, run: {...}, seats: [...] }  (404 when unknown)
 *     Falls back to the LIVE registry when the run is still in-flight (not yet
 *     archived) so a click-through on a live run still resolves.
 *
 *   GET /api/fleet/flight-recorder/live
 *     → { success, runs: [...] }  (in-progress runs from the registry)
 *
 *   GET /api/fleet/flight-recorder/stats
 *     → { success, total, failed }
 *
 * Read-only (no rate-limit token, no audit entry — same convention as the other
 * fleet read routes and src/timeline-routes.js). index.js dispatches this BEFORE
 * the generic fleet-routes handler (which 404s unknown paths).
 */

const RUNS_LIST_RE = /^\/api\/fleet\/flight-recorder\/runs$/;
const RUN_DETAIL_RE = /^\/api\/fleet\/flight-recorder\/runs\/([^/]+)$/;
const LIVE_RE = /^\/api\/fleet\/flight-recorder\/live$/;
const STATS_RE = /^\/api\/fleet\/flight-recorder\/stats$/;

/** True when pathname is any Flight Recorder route. */
function isFlightRecorderRoute(pathname) {
  return (
    RUNS_LIST_RE.test(pathname) ||
    RUN_DETAIL_RE.test(pathname) ||
    LIVE_RE.test(pathname) ||
    STATS_RE.test(pathname)
  );
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload, null, 2));
}

/**
 * Project a LIVE orchestrate registry snapshot into the same {run, seats} shape
 * the archive returns, so the UI renders an in-flight run with the same code.
 * Reuses the archive's pure mapper when available; otherwise a minimal shape.
 *
 * @param {object} snapshot - orchestrate.getRun() result
 * @param {function} mapFn - runEntryToRecord
 * @param {string} node
 * @returns {{run, seats}|null}
 */
function liveSnapshotToRecord(snapshot, mapFn, node) {
  if (!snapshot) return null;
  const mapped = typeof mapFn === "function" ? mapFn(snapshot, { node }) : null;
  if (mapped) {
    // A still-running board/chain has no results yet; surface its declared
    // agents as pending seats so the live view shows dispatched → answered.
    if ((!mapped.seats || mapped.seats.length === 0) && Array.isArray(snapshot.agents)) {
      mapped.seats = snapshot.agents.map((agent, i) => ({
        seq: i,
        agent: String(agent),
        taskId: null,
        status: "running",
        resultText: null,
        error: null,
        truncated: false,
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
      endedAt: snapshot.endedAt || null,
    },
    seats: (Array.isArray(snapshot.agents) ? snapshot.agents : []).map((agent, i) => ({
      seq: i,
      agent: String(agent),
      taskId: null,
      status: "running",
      resultText: null,
      error: null,
      truncated: false,
    })),
  };
}

/**
 * Create the Flight Recorder route handler.
 *
 * @param {object} options
 * @param {object} options.archive - run archive from createRunArchive()
 * @param {object} [options.orchestrate] - orchestrate module (for live runs);
 *   only getRun + an optional listLive are used. Optional — when absent, the
 *   live endpoint returns [] and detail falls back to the archive only.
 * @param {function} [options.runEntryToRecord] - pure mapper for live snapshots
 * @param {function} [options.listLiveRuns] - () => [registry snapshots] for the
 *   live endpoint (index.js supplies a closure over the live registry).
 * @returns {{handle, isFlightRecorderRoute}}
 */
function createFlightRecorderRoutes({
  archive,
  orchestrate = null,
  runEntryToRecord = null,
  listLiveRuns = null,
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
      // GET /runs/:runId — detail (archive first, then live fallback)
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
        // Not archived yet — maybe still running. Fall back to the registry.
        if (orchestrate && typeof orchestrate.getRun === "function") {
          const snapshot = orchestrate.getRun(runId);
          const record = liveSnapshotToRecord(snapshot, runEntryToRecord, node);
          if (record) {
            json(res, 200, { success: true, ...record });
            return;
          }
        }
        json(res, 404, { error: `Unknown runId: ${runId}` });
        return;
      }

      // GET /live — in-progress runs from the registry
      if (LIVE_RE.test(pathname)) {
        let runs = [];
        if (typeof listLiveRuns === "function") {
          const snapshots = listLiveRuns() || [];
          runs = snapshots
            .filter((s) => s && s.status === "running")
            .map((s) => liveSnapshotToRecord(s, runEntryToRecord, node))
            .filter(Boolean);
        }
        json(res, 200, { success: true, runs });
        return;
      }

      // GET /stats
      if (STATS_RE.test(pathname)) {
        const s = typeof archive.stats === "function" ? archive.stats() : { total: 0, failed: 0 };
        json(res, 200, { success: true, ...s });
        return;
      }

      // GET /runs — paged list with filters
      if (RUNS_LIST_RE.test(pathname)) {
        const opts = {};
        if (query.get("status")) opts.status = query.get("status");
        if (query.get("agent")) opts.agent = query.get("agent");
        if (query.get("node")) opts.node = query.get("node");
        if (query.get("before")) opts.before = query.get("before");
        // Date-range filter: accept epoch ms or any Date-parseable string (e.g.
        // "2026-06-18" or a full ISO timestamp). `until` is exclusive.
        const toMs = (v) => {
          if (v === null || v === "") return null;
          const ms = /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : Date.parse(v);
          if (!Number.isFinite(ms)) {
            const e = new Error(`Invalid date parameter: ${v}`);
            e.statusCode = 400;
            throw e;
          }
          return ms;
        };
        const sinceMs = toMs(query.get("since"));
        if (sinceMs !== null) opts.since = sinceMs;
        const untilMs = toMs(query.get("until"));
        if (untilMs !== null) opts.until = untilMs;
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

  return { handle, isFlightRecorderRoute };
}

module.exports = { createFlightRecorderRoutes, isFlightRecorderRoute, liveSnapshotToRecord };
