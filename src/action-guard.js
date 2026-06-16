/**
 * Fail-closed authorisation for the privileged POST /api/action verbs.
 *
 * agent-run lets a caller run an arbitrary LOCAL agent (the server side of
 * remote dispatch — see §5 of the remote-dispatch design), so node→node POSTs
 * must be locked down. Pure + synchronous so it is unit-testable without
 * booting the server; the caller resolves the async inputs (mesh peer logins,
 * dispatch token) and passes them in.
 */

const PRIVILEGED_POST_ACTIONS = new Set(["agent-run"]);

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
 * @param {object} req - incoming request (req.headers, req.socket.remoteAddress)
 * @param {object} ctx
 * @param {string|null} [ctx.token] - shared dispatch token (null → disabled)
 * @param {Set<string>} [ctx.meshLogins] - lowercased mesh peer hostnames/logins
 * @returns {{allowed: boolean, reason: string}}
 */
function guardActionPost(req, { token = null, meshLogins = new Set() } = {}) {
  if (isLocalhostAddr(req && req.socket && req.socket.remoteAddress)) {
    return { allowed: true, reason: "localhost" };
  }

  if (token) {
    const auth = req && req.headers && req.headers["authorization"];
    if (typeof auth === "string" && auth === `Bearer ${token}`) {
      return { allowed: true, reason: "token" };
    }
  }

  const dispatchFlag = req && req.headers && req.headers["x-ofc-dispatch"];
  if (dispatchFlag === "1") {
    const login = loginFromReq(req);
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
  PRIVILEGED_POST_ACTIONS,
};
