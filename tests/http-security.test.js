/**
 * Unit tests for src/http-security.js — the CSRF / cross-origin guard and the
 * security response headers (security hardening Phase 2, fixes 2 + 7).
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { securityHeaders, checkCrossOrigin } = require("../src/http-security");

describe("securityHeaders", () => {
  it("emits nosniff, frame-deny, no-referrer, and a CSP", () => {
    const h = securityHeaders();
    assert.strictEqual(h["X-Content-Type-Options"], "nosniff");
    assert.strictEqual(h["X-Frame-Options"], "DENY");
    assert.strictEqual(h["Referrer-Policy"], "no-referrer");
    assert.match(h["Content-Security-Policy"], /default-src 'self'/);
    assert.match(h["Content-Security-Policy"], /frame-ancestors 'none'/);
    assert.match(h["Content-Security-Policy"], /object-src 'none'/);
  });

  it("does NOT include any Access-Control-Allow-Origin header", () => {
    const h = securityHeaders();
    assert.strictEqual(h["Access-Control-Allow-Origin"], undefined);
  });
});

describe("checkCrossOrigin (CSRF guard)", () => {
  const req = (method, headers = {}) => ({ method, headers });

  it("always allows safe methods (GET/HEAD/OPTIONS-ish) regardless of origin", () => {
    assert.strictEqual(checkCrossOrigin(req("GET", { "sec-fetch-site": "cross-site" })).allowed, true);
    assert.strictEqual(checkCrossOrigin(req("HEAD", {})).allowed, true);
  });

  it("allows a same-origin POST via Sec-Fetch-Site", () => {
    const v = checkCrossOrigin(req("POST", { "sec-fetch-site": "same-origin" }));
    assert.strictEqual(v.allowed, true);
  });

  it("allows a browser-initiated navigation (Sec-Fetch-Site: none)", () => {
    assert.strictEqual(checkCrossOrigin(req("POST", { "sec-fetch-site": "none" })).allowed, true);
  });

  it("BLOCKS a cross-site POST (the CSRF attack)", () => {
    const v = checkCrossOrigin(req("POST", { "sec-fetch-site": "cross-site" }));
    assert.strictEqual(v.allowed, false);
    assert.match(v.reason, /cross-origin/);
  });

  it("BLOCKS a same-site-but-cross-origin POST", () => {
    assert.strictEqual(checkCrossOrigin(req("POST", { "sec-fetch-site": "same-site" })).allowed, false);
  });

  it("allows when Origin host matches the request Host", () => {
    const v = checkCrossOrigin(
      req("PATCH", { origin: "http://fleet.example:3333", host: "fleet.example:3333" }),
    );
    assert.strictEqual(v.allowed, true);
  });

  it("BLOCKS when Origin host differs from the request Host", () => {
    const v = checkCrossOrigin(
      req("DELETE", { origin: "http://evil.example", host: "fleet.example:3333" }),
    );
    assert.strictEqual(v.allowed, false);
  });

  it("allows a non-browser client (no Sec-Fetch-Site / Origin) — node→node dispatch", () => {
    // The remote-dispatch POST carries X-OFC-Dispatch + Bearer, but NO Origin
    // or Sec-Fetch-Site, so it is treated as a programmatic (non-CSRF) caller.
    const v = checkCrossOrigin(
      req("POST", { "x-ofc-dispatch": "1", authorization: "Bearer abc" }),
    );
    assert.strictEqual(v.allowed, true);
    assert.strictEqual(v.reason, "non-browser");
  });

  it("allows when the explicit X-OFC-CSRF custom header is present", () => {
    const v = checkCrossOrigin(req("POST", { "x-ofc-csrf": "1", "sec-fetch-site": "cross-site" }));
    assert.strictEqual(v.allowed, true);
    assert.strictEqual(v.reason, "csrf-header");
  });
});
