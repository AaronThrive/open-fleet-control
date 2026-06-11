/**
 * Timeline routes — HTTP layer over the agent flight recorder.
 *
 *   GET /api/fleet/agents/:id/timeline?since=&until=&types=&limit=
 *     → { agent, range, events, summary, page }
 *
 * Read-only (no rate-limit token, no audit entry — same convention as the
 * other fleet read routes). Kept in its own module so the shared
 * src/fleet-routes.js and src/index.js footprints stay tight: index.js wires
 * this handler BEFORE the generic fleet-routes dispatch.
 *
 * Errors follow the fleet-routes convention: { error } with a 4xx/5xx status
 * (the recorder throws err.statusCode = 400 for validation failures).
 */

const TIMELINE_RE = /^\/api\/fleet\/agents\/([^/]+)\/timeline$/;

/** @param {string} pathname @returns {boolean} */
function isTimelineRoute(pathname) {
  return TIMELINE_RE.test(pathname);
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload, null, 2));
}

/**
 * Create the timeline route handler.
 *
 * @param {object} options
 * @param {object} options.recorder - flight recorder from createFlightRecorder()
 * @returns {{handle: function, isTimelineRoute: function}}
 */
function createTimelineRoutes({ recorder } = {}) {
  if (!recorder || typeof recorder.getTimeline !== "function") {
    throw new Error("createTimelineRoutes requires a recorder with getTimeline()");
  }

  /**
   * Handle a timeline request. Always sends a response.
   * @param {object} req
   * @param {object} res
   * @param {string} pathname
   * @param {URLSearchParams} query
   */
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

  return { handle, isTimelineRoute };
}

module.exports = { createTimelineRoutes, isTimelineRoute };
