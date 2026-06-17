// ============================================================================
// Authentication Module
// ============================================================================

// Auth header names
const AUTH_HEADERS = {
  tailscale: {
    login: "tailscale-user-login",
    name: "tailscale-user-name",
    pic: "tailscale-user-profile-pic",
  },
  cloudflare: {
    email: "cf-access-authenticated-user-email",
  },
};

// Short positive/negative cache TTL for whois lookups so a burst of requests
// from the same Serve front-end does not spawn one CLI per request.
const WHOIS_CACHE_MS = 5000;
const WHOIS_TIMEOUT_MS = 2000;

/** True for loopback remote addresses (IPv4/IPv6, incl. ::ffff: mapping). */
function isLoopbackAddr(addr) {
  if (typeof addr !== "string" || !addr) return false;
  const normalized = addr.replace(/^::ffff:/i, "");
  return normalized === "127.0.0.1" || normalized === "::1" || addr === "::1";
}

/**
 * Default Tailscale whois resolver: `tailscale whois --json <ip>` via execFile
 * (never a shell), against an optional tailscaled socket. Resolves to the
 * lowercased LoginName, or null on ANY error/timeout/parse failure (fail
 * CLOSED). Results (incl. nulls) are cached briefly. Injectable for tests.
 *
 * @param {object} [opts]
 * @param {string} [opts.socket] - tailscaled socket path (CONFIG.auth.tailscale.tailscaledSocket)
 * @param {string} [opts.bin] - tailscale binary (default "tailscale")
 * @param {function} [opts.execFileFn] - injected execFile (testing)
 * @param {function} [opts.nowFn] - injected clock (testing)
 * @returns {function(string): Promise<string|null>}
 */
function createTailscaleWhois({ socket = "", bin = "tailscale", execFileFn, nowFn = Date.now } = {}) {
  const cache = new Map(); // ip -> { at, login }
  const exec =
    typeof execFileFn === "function" ? execFileFn : require("child_process").execFile;
  return function whois(ip) {
    return new Promise((resolve) => {
      if (typeof ip !== "string" || ip.trim().length === 0) {
        resolve(null);
        return;
      }
      const now = nowFn();
      const hit = cache.get(ip);
      if (hit && now - hit.at < WHOIS_CACHE_MS) {
        resolve(hit.login);
        return;
      }
      const args = socket ? ["--socket", socket, "whois", "--json", ip] : ["whois", "--json", ip];
      let settled = false;
      const done = (login) => {
        if (settled) return;
        settled = true;
        cache.set(ip, { at: nowFn(), login });
        resolve(login);
      };
      try {
        exec(bin, args, { encoding: "utf8", timeout: WHOIS_TIMEOUT_MS }, (err, stdout) => {
          if (err || !stdout) {
            done(null);
            return;
          }
          try {
            const parsed = JSON.parse(stdout);
            const login = parsed && parsed.UserProfile && parsed.UserProfile.LoginName;
            done(typeof login === "string" && login ? login.toLowerCase() : null);
          } catch (e) {
            done(null);
          }
        });
      } catch (e) {
        done(null); // fail closed if the binary is missing
      }
    });
  };
}

/**
 * Verify a Tailscale Serve origin. Serve terminates locally and proxies to the
 * dashboard over loopback, injecting x-forwarded-for/-proto/-host plus the
 * tailscale-user-* identity headers. A direct tailnet connection to the bound
 * port can forge those identity headers — so when enabled we require BOTH:
 *   1. the TCP peer is loopback (the Serve front-end), carrying x-forwarded-for, and
 *   2. whois(x-forwarded-for IP) resolves to a login matching the claimed header.
 * Returns the verified lowercased login on success, or null (fail closed).
 *
 * @returns {Promise<string|null>}
 */
async function verifyServeLogin(req, claimedLogin, whoisFn) {
  if (typeof whoisFn !== "function") return null;
  const remoteAddr = req.socket?.remoteAddress || "";
  if (!isLoopbackAddr(remoteAddr)) return null; // not behind a loopback Serve proxy
  const xff = req.headers["x-forwarded-for"];
  const forwardedIp = typeof xff === "string" ? xff.split(",")[0]?.trim() : "";
  if (!forwardedIp) return null; // Serve always injects this; absence = not via Serve
  const resolved = await whoisFn(forwardedIp);
  if (!resolved || resolved !== claimedLogin) return null; // mismatch / lookup failure
  return resolved;
}

function checkAuth(req, authConfig) {
  const mode = authConfig.mode;
  const remoteAddr = req.socket?.remoteAddress || "";
  const isLocalhost =
    remoteAddr === "127.0.0.1" || remoteAddr === "::1" || remoteAddr === "::ffff:127.0.0.1";
  // Serve-origin verification (when enabled) fronts OFC over loopback, so a
  // Serve-proxied request appears local. Blanket-allowing loopback would bypass
  // the per-user allowlist for those proxied requests. The reliable signal that a
  // loopback request actually arrived via Serve is Serve's injected
  // x-forwarded-for header — NOT the identity header, which a genuine local agent
  // legitimately sets (the dispatch kickoff instructs local agents to send
  // tailscale-user-login when calling 127.0.0.1). So when verifyServeOrigin is on
  // AND this loopback request carries x-forwarded-for, fall through to the
  // tailscale verification path instead of the localhost short-circuit. A genuine
  // local call (no x-forwarded-for) still short-circuits as localhost, regardless
  // of any identity header it carries.
  const tsCfg = authConfig.tailscale || {};
  const looksLikeServeProxy =
    mode === "tailscale" &&
    tsCfg.verifyServeOrigin === true &&
    typeof req.headers["x-forwarded-for"] === "string" &&
    req.headers["x-forwarded-for"].length > 0;
  if (isLocalhost && !looksLikeServeProxy) {
    return { authorized: true, user: { type: "localhost", login: "localhost" } };
  }
  if (mode === "none") {
    return { authorized: true, user: null };
  }
  if (mode === "token") {
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (token && token === authConfig.token) {
      return { authorized: true, user: { type: "token" } };
    }
    return { authorized: false, reason: "Invalid or missing token" };
  }
  if (mode === "tailscale") {
    const login = (req.headers[AUTH_HEADERS.tailscale.login] || "").toLowerCase();
    const name = req.headers[AUTH_HEADERS.tailscale.name] || "";
    const pic = req.headers[AUTH_HEADERS.tailscale.pic] || "";
    if (!login) {
      return { authorized: false, reason: "Not accessed via Tailscale Serve" };
    }
    const decide = () => {
      const isAllowed = authConfig.allowedUsers.some((allowed) => {
        if (allowed === "*") return true;
        if (allowed === login) return true;
        if (allowed.startsWith("*@")) {
          const domain = allowed.slice(2);
          return login.endsWith("@" + domain);
        }
        return false;
      });
      if (isAllowed) {
        return { authorized: true, user: { type: "tailscale", login, name, pic } };
      }
      return { authorized: false, reason: `User ${login} not in allowlist`, user: { login } };
    };
    // Default OFF: trust the header exactly as before (pre-cutover behavior).
    // When verifyServeOrigin is on, the header is only honored if the request
    // arrived via a loopback Tailscale Serve proxy AND whois confirms it — this
    // returns a Promise; the call site awaits it (see src/index.js auth block).
    const ts = authConfig.tailscale || {};
    if (!ts.verifyServeOrigin) {
      return decide();
    }
    return verifyServeLogin(req, login, ts.whoisFn).then((verified) => {
      if (!verified) {
        return {
          authorized: false,
          reason: "Tailscale identity could not be verified via Serve origin",
          user: { login },
        };
      }
      return decide();
    });
  }
  if (mode === "cloudflare") {
    const email = (req.headers[AUTH_HEADERS.cloudflare.email] || "").toLowerCase();
    if (!email) {
      return { authorized: false, reason: "Not accessed via Cloudflare Access" };
    }
    const isAllowed = authConfig.allowedUsers.some((allowed) => {
      if (allowed === "*") return true;
      if (allowed === email) return true;
      if (allowed.startsWith("*@")) {
        const domain = allowed.slice(2);
        return email.endsWith("@" + domain);
      }
      return false;
    });
    if (isAllowed) {
      return { authorized: true, user: { type: "cloudflare", email } };
    }
    return { authorized: false, reason: `User ${email} not in allowlist`, user: { email } };
  }
  if (mode === "allowlist") {
    const clientIP =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "";
    const isAllowed = authConfig.allowedIPs.some((allowed) => {
      if (allowed === clientIP) return true;
      if (allowed.endsWith("/24")) {
        const prefix = allowed.slice(0, -3).split(".").slice(0, 3).join(".");
        return clientIP.startsWith(prefix + ".");
      }
      return false;
    });
    if (isAllowed) {
      return { authorized: true, user: { type: "ip", ip: clientIP } };
    }
    return { authorized: false, reason: `IP ${clientIP} not in allowlist` };
  }
  return { authorized: false, reason: "Unknown auth mode" };
}

function getUnauthorizedPage(reason, user, authConfig) {
  const userInfo = user
    ? `<p class="user-info">Detected: ${user.login || user.email || user.ip || "unknown"}</p>`
    : "";

  return `<!DOCTYPE html>
<html>
<head>
    <title>Access Denied - OpenFleetControl</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #e8e8e8;
        }
        .container {
            text-align: center;
            padding: 3rem;
            background: rgba(255,255,255,0.05);
            border-radius: 16px;
            border: 1px solid rgba(255,255,255,0.1);
            max-width: 500px;
        }
        .icon { font-size: 4rem; margin-bottom: 1rem; }
        h1 { font-size: 1.8rem; margin-bottom: 1rem; color: #ff6b6b; }
        .reason { color: #aaa; margin-bottom: 1.5rem; font-size: 0.95rem; }
        .user-info { color: #ffeb3b; margin: 1rem 0; font-size: 0.9rem; }
        .instructions { color: #ccc; font-size: 0.85rem; line-height: 1.5; }
        .auth-mode { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid rgba(255,255,255,0.1); color: #888; font-size: 0.75rem; }
        code { background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">🔐</div>
        <h1>Access Denied</h1>
        <div class="reason">${reason}</div>
        ${userInfo}
        <div class="instructions">
            <p>This dashboard requires authentication via <strong>${authConfig.mode}</strong>.</p>
            ${authConfig.mode === "tailscale" ? '<p style="margin-top:1rem">Make sure you\'re accessing via your Tailscale URL and your account is in the allowlist.</p>' : ""}
            ${authConfig.mode === "cloudflare" ? '<p style="margin-top:1rem">Make sure you\'re accessing via Cloudflare Access and your email is in the allowlist.</p>' : ""}
        </div>
        <div class="auth-mode">Auth mode: <code>${authConfig.mode}</code></div>
    </div>
</body>
</html>`;
}

module.exports = {
  AUTH_HEADERS,
  checkAuth,
  getUnauthorizedPage,
  createTailscaleWhois,
  verifyServeLogin,
  isLoopbackAddr,
};
