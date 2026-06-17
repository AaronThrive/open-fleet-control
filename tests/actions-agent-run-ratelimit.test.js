/**
 * Unit test for the agent-run rate-limit added to POST /api/action (§5 of OFC
 * v2.4.0). The production route (src/index.js) routes a non-localhost,
 * authorised agent-run through fleet.rateLimiter keyed by caller login and 429s
 * when the bucket is exhausted; localhost dispatch is exempt. Rather than boot
 * the server, this mirrors the exact guard+limit sequence from index.js against
 * the REAL action-guard + rate-limit modules (no network, no CLI).
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { guardActionPost } = require("../src/action-guard");
const { createRateLimiter } = require("../src/rate-limit");

function req({ remoteAddress = "10.0.0.5", headers = {} } = {}) {
  return { socket: { remoteAddress }, headers };
}

function login(r) {
  const v = r.headers["tailscale-user-login"];
  return typeof v === "string" && v.trim() ? v.trim().toLowerCase() : "anonymous";
}

/**
 * The exact post-guard sequence index.js runs for agent-run: authorise, then
 * (non-localhost only) consume a rate-limit token keyed by caller login.
 * Returns the HTTP status the route would emit.
 */
function runGuardAndLimit(r, { limiter, token = null, meshLogins = new Set() }) {
  const verdict = guardActionPost(r, { token, meshLogins });
  if (!verdict.allowed) return 403;
  if (verdict.reason !== "localhost" && limiter) {
    const rl = limiter.check(`agent-run|${login(r)}`);
    if (!rl.allowed) return 429;
  }
  return 200;
}

describe("agent-run rate-limit (POST /api/action §5)", () => {
  const meshLogins = new Set(["node-b"]);

  it("limits a mesh peer to `max` agent-runs per window, then 429s", () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 60000 });
    const peer = req({
      headers: { "x-ofc-dispatch": "1", "tailscale-user-login": "node-b" },
    });
    assert.strictEqual(runGuardAndLimit(peer, { limiter, meshLogins }), 200);
    assert.strictEqual(runGuardAndLimit(peer, { limiter, meshLogins }), 200);
    // Third call within the window is rate-limited.
    assert.strictEqual(runGuardAndLimit(peer, { limiter, meshLogins }), 429);
  });

  it("keys the limit per caller login (one peer's exhaustion does not block another)", () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60000 });
    const peers = new Set(["node-b", "node-c"]);
    const b = req({ headers: { "x-ofc-dispatch": "1", "tailscale-user-login": "node-b" } });
    const c = req({ headers: { "x-ofc-dispatch": "1", "tailscale-user-login": "node-c" } });
    assert.strictEqual(runGuardAndLimit(b, { limiter, meshLogins: peers }), 200);
    assert.strictEqual(runGuardAndLimit(b, { limiter, meshLogins: peers }), 429);
    // node-c has its own bucket.
    assert.strictEqual(runGuardAndLimit(c, { limiter, meshLogins: peers }), 200);
  });

  it("exempts localhost dispatch from the rate limit", () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60000 });
    const local = req({ remoteAddress: "127.0.0.1" });
    // Many localhost calls, never throttled.
    for (let i = 0; i < 5; i += 1) {
      assert.strictEqual(runGuardAndLimit(local, { limiter, meshLogins }), 200);
    }
  });
});
