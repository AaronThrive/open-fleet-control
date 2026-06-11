/**
 * Cron action routes — POST /api/cron/:id/{enable|disable|run}.
 *
 * Same conventions as src/fleet-routes.js:
 *   - success: 200 + { success: true, ... }
 *   - errors:  { error: "<message>" } with a 4xx/5xx status
 *   - rate limiting: every mutation consumes one token from the per-user+ip
 *     bucket; 429 responses include { retryAfterMs }
 *   - identity: Tailscale-User-Login header, falling back to "anonymous"
 *   - audit: cron.update (enable/disable) and cron.run entries; an audit
 *     failure never fails the request
 *
 * GET /api/cron (the read-only list) stays in src/index.js — this module
 * only owns the mutation subpaths.
 */

const IDENTITY_HEADER = "tailscale-user-login";
const CRON_ACTION_RE = /^\/api\/cron\/([^/]+)\/(enable|disable|run)$/;

/** @param {string} pathname @returns {boolean} */
function isCronActionRoute(pathname) {
  return CRON_ACTION_RE.test(pathname);
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload, null, 2));
}

/** Identity from the Tailscale Serve header (fallback "anonymous"). */
function getUser(req) {
  const login = req.headers[IDENTITY_HEADER];
  return typeof login === "string" && login.trim().length > 0
    ? login.trim().toLowerCase()
    : "anonymous";
}

/**
 * Create the cron action route handler.
 *
 * @param {object} options
 * @param {object} options.actions - module from createCronActions()
 * @param {object} options.audit - audit recorder ({ record })
 * @param {object} options.rateLimiter - token bucket ({ check })
 * @param {boolean} [options.enabled=true] - false in economy mode
 *   (fleet.openclawSources=false): mutations respond 503 instead of
 *   spawning the CLI.
 * @returns {{handle: function, isCronActionRoute: function}}
 */
function createCronRoutes({ actions, audit, rateLimiter, enabled = true }) {
  if (!actions || !audit || !rateLimiter) {
    throw new Error("createCronRoutes requires actions, audit and rateLimiter");
  }

  /**
   * Handle a matched cron action request. Always sends a response.
   * @param {object} req
   * @param {object} res
   * @param {string} pathname
   */
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
        recordAudit(user, "cron.run", id, null);
      } else {
        result = await actions.setJobEnabled(id, action === "enable");
        recordAudit(user, "cron.update", id, { enabled: result.enabled });
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

  /** Best-effort audit record — an audit failure never fails the request. */
  function recordAudit(user, action, target, detail) {
    try {
      audit.record({ user, action, target, detail });
    } catch (e) {
      console.error("[CronRoutes] Audit record failed:", e.message);
    }
  }

  return { handle, isCronActionRoute };
}

module.exports = { createCronRoutes, isCronActionRoute };
