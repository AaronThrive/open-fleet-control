/**
 * Unit tests for src/action-guard.js — the fail-closed node→node guard for
 * privileged POST /api/action verbs (agent-run).
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  guardActionPost,
  isLocalhostAddr,
  loginFromReq,
  PRIVILEGED_POST_ACTIONS,
} = require("../src/action-guard");

function req({ remoteAddress = "10.0.0.5", headers = {} } = {}) {
  return { socket: { remoteAddress }, headers };
}

describe("action-guard", () => {
  it("isLocalhostAddr matches IPv4/IPv6 loopback incl. ::ffff: mapping", () => {
    assert.strictEqual(isLocalhostAddr("127.0.0.1"), true);
    assert.strictEqual(isLocalhostAddr("::1"), true);
    assert.strictEqual(isLocalhostAddr("::ffff:127.0.0.1"), true);
    assert.strictEqual(isLocalhostAddr("10.0.0.5"), false);
    assert.strictEqual(isLocalhostAddr(undefined), false);
  });

  it("loginFromReq lowercases the Tailscale header, falls back to anonymous", () => {
    assert.strictEqual(loginFromReq(req({ headers: { "tailscale-user-login": "Node-B" } })), "node-b");
    assert.strictEqual(loginFromReq(req()), "anonymous");
  });

  it("agent-run is the privileged POST action", () => {
    assert.ok(PRIVILEGED_POST_ACTIONS.has("agent-run"));
  });

  it("allows localhost callers unconditionally", () => {
    const v = guardActionPost(req({ remoteAddress: "127.0.0.1" }), {});
    assert.strictEqual(v.allowed, true);
    assert.strictEqual(v.reason, "localhost");
  });

  it("allows a registered mesh peer presenting X-OFC-Dispatch:1", () => {
    const v = guardActionPost(
      req({ headers: { "x-ofc-dispatch": "1", "tailscale-user-login": "node-b" } }),
      { meshLogins: new Set(["node-b"]) },
    );
    assert.strictEqual(v.allowed, true);
    assert.strictEqual(v.reason, "mesh-peer");
  });

  it("allows a valid bearer dispatch token", () => {
    const v = guardActionPost(req({ headers: { authorization: "Bearer s3cret" } }), {
      token: "s3cret",
    });
    assert.strictEqual(v.allowed, true);
    assert.strictEqual(v.reason, "token");
  });

  it("DENIES a non-localhost caller with no identity, peer, or token (403)", () => {
    const v = guardActionPost(req(), {});
    assert.strictEqual(v.allowed, false);
    assert.match(v.reason, /localhost|mesh peer|token/);
  });

  it("DENIES X-OFC-Dispatch from a non-peer login", () => {
    const v = guardActionPost(
      req({ headers: { "x-ofc-dispatch": "1", "tailscale-user-login": "stranger" } }),
      { meshLogins: new Set(["node-b"]) },
    );
    assert.strictEqual(v.allowed, false);
  });

  it("DENIES a wrong bearer token", () => {
    const v = guardActionPost(req({ headers: { authorization: "Bearer wrong" } }), {
      token: "s3cret",
    });
    assert.strictEqual(v.allowed, false);
  });

  it("DENIES X-OFC-Dispatch with no identity even if mesh has peers", () => {
    const v = guardActionPost(req({ headers: { "x-ofc-dispatch": "1" } }), {
      meshLogins: new Set(["node-b"]),
    });
    assert.strictEqual(v.allowed, false);
  });
});
