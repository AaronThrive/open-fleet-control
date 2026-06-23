/**
 * Unit tests for src/bind-host.js — the HTTP server bind-interface resolver.
 *
 * CRITICAL invariant: the DEFAULT must remain all-interfaces (null), preserving
 * the dashboard's historical live behavior. Loopback binding is opt-in only.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { resolveBindHost, assertSecureBindPosture } = require("../src/bind-host");

describe("resolveBindHost", () => {
  it("defaults to all-interfaces (null) when bindHost is unset/empty", () => {
    assert.strictEqual(resolveBindHost(undefined), null);
    assert.strictEqual(resolveBindHost(""), null);
    assert.strictEqual(resolveBindHost("   "), null);
  });

  it("treats 0.0.0.0 / all / * as bind-all (null)", () => {
    assert.strictEqual(resolveBindHost("0.0.0.0"), null);
    assert.strictEqual(resolveBindHost("all"), null);
    assert.strictEqual(resolveBindHost("ALL"), null);
    assert.strictEqual(resolveBindHost("*"), null);
  });

  it("honors an explicit loopback override (127.0.0.1 / localhost)", () => {
    assert.strictEqual(resolveBindHost("127.0.0.1"), "127.0.0.1");
    assert.strictEqual(resolveBindHost("localhost"), "127.0.0.1");
    assert.strictEqual(resolveBindHost("LOCALHOST"), "127.0.0.1");
  });

  it("honors IPv6 loopback", () => {
    assert.strictEqual(resolveBindHost("::1"), "::1");
  });

  it("passes any other explicit address through verbatim (trimmed)", () => {
    assert.strictEqual(resolveBindHost("10.0.0.5"), "10.0.0.5");
    assert.strictEqual(resolveBindHost(" 192.168.1.10 "), "192.168.1.10");
  });
});

describe("assertSecureBindPosture (startup guard)", () => {
  const silent = { warn: () => {} };

  it("REFUSES (fatal) when auth.mode=none AND bind is all-interfaces", () => {
    const v = assertSecureBindPosture({ mode: "none" }, undefined, silent);
    assert.strictEqual(v.fatal, true);
    assert.strictEqual(v.errors.length, 1);
    assert.match(v.errors[0], /REFUSING TO START/);
  });

  it("REFUSES for explicit 0.0.0.0 with auth.mode=none", () => {
    const v = assertSecureBindPosture({ mode: "none" }, "0.0.0.0", silent);
    assert.strictEqual(v.fatal, true);
  });

  it("ALLOWS auth.mode=none when bound to loopback only", () => {
    const v = assertSecureBindPosture({ mode: "none" }, "127.0.0.1", silent);
    assert.strictEqual(v.fatal, false);
    assert.deepStrictEqual(v.errors, []);
  });

  it("ALLOWS an authenticated mode bound to all interfaces (not fatal)", () => {
    const v = assertSecureBindPosture(
      { mode: "tailscale", tailscale: { verifyServeOrigin: true } },
      undefined,
      silent,
    );
    assert.strictEqual(v.fatal, false);
  });

  it("WARNS (not fatal) for tailscale mode without verifyServeOrigin", () => {
    const warnings = [];
    const v = assertSecureBindPosture(
      { mode: "tailscale", tailscale: { verifyServeOrigin: false } },
      "127.0.0.1",
      { warn: (m) => warnings.push(m) },
    );
    assert.strictEqual(v.fatal, false);
    assert.strictEqual(v.warnings.length, 1);
    assert.match(v.warnings[0], /verifyServeOrigin/);
    assert.strictEqual(warnings.length, 1); // emitted via the warn sink
  });

  it("the LIVE secure posture (tailscale + verify + loopback) passes cleanly", () => {
    const v = assertSecureBindPosture(
      { mode: "tailscale", tailscale: { verifyServeOrigin: true } },
      "127.0.0.1",
      silent,
    );
    assert.strictEqual(v.fatal, false);
    assert.deepStrictEqual(v.errors, []);
    assert.deepStrictEqual(v.warnings, []);
  });
});
