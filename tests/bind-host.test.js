/**
 * Unit tests for src/bind-host.js — the HTTP server bind-interface resolver.
 *
 * CRITICAL invariant: the DEFAULT must remain all-interfaces (null), preserving
 * the dashboard's historical live behavior. Loopback binding is opt-in only.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { resolveBindHost } = require("../src/bind-host");

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
