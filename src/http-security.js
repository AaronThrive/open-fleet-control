/**
 * HTTP response hardening + CSRF / cross-origin defense for the dashboard.
 *
 * The dashboard is SAME-ORIGIN: the vanilla-JS frontend fetches only relative
 * /api/* paths and opens a same-origin EventSource at /api/events. Nothing in
 * the UI relies on a cross-origin response, so the legacy `Access-Control-Allow-
 * Origin: *` header (which invited any website to read authenticated responses)
 * is removed entirely — see src/index.js.
 *
 * CSRF model — applyCsrfGuard():
 *   State-changing requests (POST/PUT/PATCH/DELETE) are the only CSRF targets.
 *   A forged cross-site browser request rides the victim's ambient credentials
 *   (loopback short-circuit, Tailscale Serve identity headers injected by the
 *   proxy). We reject those using signals the browser sets automatically and a
 *   page CANNOT forge:
 *     - Sec-Fetch-Site: a cross-site/ same-site-but-cross-origin fetch is denied.
 *     - Origin: when present, its scheme://host[:port] must match the request's
 *       own Host (same-origin).
 *   Requests with NEITHER header are non-browser clients (node→node dispatch,
 *   curl, the openclaw CLI). Those carry their own auth (dispatch token / mesh
 *   identity) and are NOT subject to CSRF, so they are allowed through. An
 *   optional X-OFC-CSRF custom header is also honored as an explicit
 *   same-origin assertion (custom headers force a CORS preflight cross-origin,
 *   so their mere presence proves a same-origin or trusted programmatic caller).
 *
 * Pure + injectable so it is unit-testable without booting the server.
 */

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const CSRF_HEADER = "x-ofc-csrf";

/** Security response headers applied to every response. */
function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    // The dashboard is self-hosted vanilla JS. Inline <script>/<style> blocks in
    // public/index.html (and the 403 page) require 'unsafe-inline'; no remote
    // origins are loaded. connect-src 'self' covers same-origin fetch + the
    // /api/events EventSource. frame-ancestors 'none' mirrors X-Frame-Options.
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join("; "),
  };
}

/** Normalize an Origin header to scheme://host[:port], or null if unparseable. */
function originKey(origin) {
  if (typeof origin !== "string" || !origin || origin === "null") return null;
  try {
    const u = new URL(origin);
    return `${u.protocol}//${u.host}`;
  } catch (err) {
    return null;
  }
}

/**
 * Decide whether a request passes the cross-origin / CSRF guard.
 *
 * @param {object} req - { method, headers }
 * @returns {{allowed: boolean, reason: string}}
 */
function checkCrossOrigin(req) {
  const method = (req && req.method ? String(req.method) : "GET").toUpperCase();
  if (!UNSAFE_METHODS.has(method)) return { allowed: true, reason: "safe-method" };

  const headers = (req && req.headers) || {};

  // Explicit same-origin assertion via a custom header (forces a preflight
  // cross-origin, so a simple cross-site form/fetch cannot set it).
  if (typeof headers[CSRF_HEADER] === "string" && headers[CSRF_HEADER].length > 0) {
    return { allowed: true, reason: "csrf-header" };
  }

  const secFetchSite = headers["sec-fetch-site"];
  if (typeof secFetchSite === "string" && secFetchSite) {
    // Modern browsers: only genuine same-origin (or browser-initiated "none",
    // e.g. typed URL) requests are trusted. cross-site / same-site are denied.
    if (secFetchSite === "same-origin" || secFetchSite === "none") {
      return { allowed: true, reason: "sec-fetch-same-origin" };
    }
    return { allowed: false, reason: `cross-origin request blocked (Sec-Fetch-Site: ${secFetchSite})` };
  }

  const origin = headers["origin"];
  if (typeof origin === "string" && origin) {
    const reqOrigin = originKey(origin);
    const host = headers["host"];
    if (reqOrigin && typeof host === "string" && host) {
      // Compare host portion only — scheme behind a loopback proxy is http.
      const originHost = reqOrigin.replace(/^https?:\/\//, "");
      if (originHost === host) return { allowed: true, reason: "origin-same-host" };
    }
    return { allowed: false, reason: "cross-origin request blocked (Origin mismatch)" };
  }

  // No Sec-Fetch-Site AND no Origin → not a browser-driven request. These are
  // programmatic clients (node→node dispatch, CLI, curl) that authenticate with
  // their own credentials and are not CSRF-exposed.
  return { allowed: true, reason: "non-browser" };
}

module.exports = {
  securityHeaders,
  checkCrossOrigin,
  originKey,
  UNSAFE_METHODS,
  CSRF_HEADER,
};
