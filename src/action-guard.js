/**
 * Fail-closed authorisation for the privileged POST /api/action verbs.
 *
 * agent-run lets a caller run an arbitrary LOCAL agent (the server side of
 * remote dispatch — see §5 of the remote-dispatch design), so node→node POSTs
 * must be locked down. Pure + synchronous so it is unit-testable without
 * booting the server; the caller resolves the async inputs (mesh peer logins,
 * dispatch token) and passes them in.
 */

const crypto = require("crypto");

const PRIVILEGED_POST_ACTIONS = new Set(["agent-run"]);

/**
 * Constant-time equality for the dispatch Bearer token (avoids leaking how many
 * leading bytes matched via response-time differences). Length-checked; returns
 * false on any non-string/empty/length-mismatch input (fail closed).
 */
function timingSafeStrEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || b.length === 0) {
    return false;
  }
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Identity from the Tailscale Serve header (fallback "anonymous"). */
function loginFromReq(req) {
  const login = req && req.headers && req.headers["tailscale-user-login"];
  return typeof login === "string" && login.trim().length > 0
    ? login.trim().toLowerCase()
    : "anonymous";
}

/** True for loopback remote addresses (IPv4/IPv6, incl. ::ffff: mapping). */
function isLocalhostAddr(addr) {
  if (typeof addr !== "string" || !addr) return false;
  const normalized = addr.replace(/^::ffff:/i, "");
  return normalized === "127.0.0.1" || normalized === "::1" || addr === "::1";
}

/**
 * Decide whether a POST /api/action request may run the given action. Allow
 * ONLY when at least one holds:
 *   1. the caller is localhost, OR
 *   2. X-OFC-Dispatch:1 AND the caller identity is a registered mesh peer, OR
 *   3. a shared dispatch token is presented as Authorization: Bearer <token>.
 * Everything else is denied (403).
 *
 * Serve-origin verification (default OFF): when ctx.verifyServeOrigin is true,
 * the mesh-peer branch (2) trusts the WHOIS-verified identity (ctx.verifiedLogin)
 * instead of the raw, spoofable tailscale-user-login header — the verified login
 * must itself be a registered mesh peer. The token branch (3) is unaffected
 * (defense-in-depth). Default OFF preserves exact pre-cutover behavior.
 *
 * PRIMARY node→node path = the TOKEN (3). As of v2.4.3 runRemote sends
 * `Authorization: Bearer <fleet.dispatch.token>`, so cross-node agent-run is
 * authed by the shared token. Branch (2) CANNOT authorise a Serve-proxied
 * node→node call: Tailscale Serve identifies the caller by tailnet USER (via
 * whois), but meshLogins holds node HOSTNAMES — user ≠ hostname → it would 403.
 * That is by design; node→node uses the token, humans use verifyServeOrigin +
 * the allowlist (two orthogonal axes — see docs/security-hardening.md).
 *
 * @param {object} req - incoming request (req.headers, req.socket.remoteAddress)
 * @param {object} ctx
 * @param {string|null} [ctx.token] - shared dispatch token (null → disabled)
 * @param {Set<string>} [ctx.meshLogins] - lowercased mesh peer hostnames/logins
 * @param {boolean} [ctx.verifyServeOrigin=false] - require a verified identity
 * @param {string|null} [ctx.verifiedLogin=null] - whois-verified login (or null)
 * @returns {{allowed: boolean, reason: string}}
 */
function guardActionPost(
  req,
  { token = null, meshLogins = new Set(), verifyServeOrigin = false, verifiedLogin = null } = {},
) {
  // Behind Serve→loopback EVERY request's remoteAddress is loopback, so the
  // localhost short-circuit cannot distinguish a real Serve peer from a genuine
  // local caller. The reliable Serve signal is the injected x-forwarded-for
  // header. When verifyServeOrigin is on AND x-forwarded-for is present, do NOT
  // auto-allow as localhost — fall through to require a verified mesh-peer
  // identity. A genuine local call (no x-forwarded-for) still allows as localhost.
  const hasForwardedFor =
    typeof (req && req.headers && req.headers["x-forwarded-for"]) === "string" &&
    req.headers["x-forwarded-for"].length > 0;
  const proxiedViaServe = verifyServeOrigin && hasForwardedFor;
  if (!proxiedViaServe && isLocalhostAddr(req && req.socket && req.socket.remoteAddress)) {
    return { allowed: true, reason: "localhost" };
  }

  if (token) {
    const auth = req && req.headers && req.headers["authorization"];
    const presented = typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "") : "";
    if (timingSafeStrEqual(presented, token)) {
      return { allowed: true, reason: "token" };
    }
  }

  const dispatchFlag = req && req.headers && req.headers["x-ofc-dispatch"];
  if (dispatchFlag === "1") {
    // When verifying, the peer login MUST be the whois-verified one; the raw
    // header is never trusted. Otherwise fall back to the header identity.
    const login = verifyServeOrigin
      ? typeof verifiedLogin === "string" && verifiedLogin
        ? verifiedLogin.toLowerCase()
        : "anonymous"
      : loginFromReq(req);
    if (login !== "anonymous" && meshLogins.has(login)) {
      return { allowed: true, reason: "mesh-peer" };
    }
  }

  return {
    allowed: false,
    reason: "node→node action requires localhost, a mesh peer identity, or a dispatch token",
  };
}

module.exports = {
  guardActionPost,
  isLocalhostAddr,
  loginFromReq,
  timingSafeStrEqual,
  PRIVILEGED_POST_ACTIONS,
};
