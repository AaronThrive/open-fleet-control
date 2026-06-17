const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  checkAuth,
  AUTH_HEADERS,
  getUnauthorizedPage,
  createTailscaleWhois,
  verifyServeLogin,
} = require("../src/auth");

describe("auth module", () => {
  describe("AUTH_HEADERS", () => {
    it("exports tailscale header names", () => {
      assert.strictEqual(AUTH_HEADERS.tailscale.login, "tailscale-user-login");
      assert.strictEqual(AUTH_HEADERS.tailscale.name, "tailscale-user-name");
      assert.strictEqual(AUTH_HEADERS.tailscale.pic, "tailscale-user-profile-pic");
    });

    it("exports cloudflare header names", () => {
      assert.strictEqual(AUTH_HEADERS.cloudflare.email, "cf-access-authenticated-user-email");
    });
  });

  describe("checkAuth()", () => {
    function mockReq(remoteAddress, headers = {}) {
      return { socket: { remoteAddress }, headers };
    }

    it("allows localhost (127.0.0.1) regardless of auth mode", () => {
      const result = checkAuth(mockReq("127.0.0.1"), { mode: "token", token: "secret" });
      assert.strictEqual(result.authorized, true);
      assert.strictEqual(result.user.type, "localhost");
    });

    it("allows localhost (::1) regardless of auth mode", () => {
      const result = checkAuth(mockReq("::1"), { mode: "tailscale", allowedUsers: [] });
      assert.strictEqual(result.authorized, true);
    });

    it("allows localhost (::ffff:127.0.0.1)", () => {
      const result = checkAuth(mockReq("::ffff:127.0.0.1"), { mode: "token", token: "x" });
      assert.strictEqual(result.authorized, true);
    });

    it("allows all when mode is 'none'", () => {
      const result = checkAuth(mockReq("192.168.1.100"), { mode: "none" });
      assert.strictEqual(result.authorized, true);
      assert.strictEqual(result.user, null);
    });

    describe("token mode", () => {
      const authConfig = { mode: "token", token: "my-secret-token" };

      it("allows valid bearer token", () => {
        const req = mockReq("10.0.0.1", { authorization: "Bearer my-secret-token" });
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, true);
        assert.strictEqual(result.user.type, "token");
      });

      it("rejects invalid token", () => {
        const req = mockReq("10.0.0.1", { authorization: "Bearer wrong-token" });
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, false);
        assert.ok(result.reason.includes("Invalid"));
      });

      it("rejects missing authorization header", () => {
        const req = mockReq("10.0.0.1", {});
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, false);
      });
    });

    describe("tailscale mode", () => {
      const authConfig = { mode: "tailscale", allowedUsers: ["user@example.com", "*@corp.com"] };

      it("allows user in allowlist", () => {
        const req = mockReq("100.64.0.1", { "tailscale-user-login": "user@example.com" });
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, true);
        assert.strictEqual(result.user.type, "tailscale");
        assert.strictEqual(result.user.login, "user@example.com");
      });

      it("allows wildcard domain match", () => {
        const req = mockReq("100.64.0.1", { "tailscale-user-login": "anyone@corp.com" });
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, true);
      });

      it("rejects user not in allowlist", () => {
        const req = mockReq("100.64.0.1", { "tailscale-user-login": "hacker@evil.com" });
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, false);
        assert.ok(result.reason.includes("not in allowlist"));
      });

      it("rejects when no tailscale header present", () => {
        const req = mockReq("10.0.0.1", {});
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, false);
        assert.ok(result.reason.includes("Tailscale"));
      });

      it("allows wildcard (*) user", () => {
        const config = { mode: "tailscale", allowedUsers: ["*"] };
        const req = mockReq("100.64.0.1", { "tailscale-user-login": "anyone@anywhere.com" });
        const result = checkAuth(req, config);
        assert.strictEqual(result.authorized, true);
      });
    });

    describe("cloudflare mode", () => {
      const authConfig = { mode: "cloudflare", allowedUsers: ["user@example.com"] };

      it("allows user in allowlist", () => {
        const req = mockReq("172.16.0.1", {
          "cf-access-authenticated-user-email": "user@example.com",
        });
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, true);
        assert.strictEqual(result.user.type, "cloudflare");
      });

      it("rejects user not in allowlist", () => {
        const req = mockReq("172.16.0.1", {
          "cf-access-authenticated-user-email": "other@example.com",
        });
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, false);
      });

      it("rejects when no cloudflare header present", () => {
        const req = mockReq("172.16.0.1", {});
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, false);
        assert.ok(result.reason.includes("Cloudflare"));
      });
    });

    describe("allowlist mode", () => {
      const authConfig = { mode: "allowlist", allowedIPs: ["10.0.0.5", "192.168.1.0/24"] };

      it("allows exact IP match", () => {
        const req = mockReq("10.0.0.5");
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, true);
        assert.strictEqual(result.user.type, "ip");
      });

      it("allows /24 subnet match", () => {
        const req = mockReq("192.168.1.42");
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, true);
      });

      it("rejects IP not in allowlist", () => {
        const req = mockReq("10.0.0.99");
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, false);
        assert.ok(result.reason.includes("not in allowlist"));
      });

      it("uses x-forwarded-for header when present", () => {
        const req = mockReq("172.16.0.1", { "x-forwarded-for": "10.0.0.5, 172.16.0.1" });
        const result = checkAuth(req, authConfig);
        assert.strictEqual(result.authorized, true);
      });
    });

    it("rejects unknown auth mode", () => {
      const result = checkAuth(mockReq("10.0.0.1"), { mode: "kerberos" });
      assert.strictEqual(result.authorized, false);
      assert.ok(result.reason.includes("Unknown"));
    });

    describe("tailscale Serve-origin verification (config-gated)", () => {
      const allowedUsers = ["user@example.com"];

      function tsReq(remoteAddress, { login, xff } = {}) {
        const headers = {};
        if (login !== undefined) headers["tailscale-user-login"] = login;
        if (xff !== undefined) headers["x-forwarded-for"] = xff;
        return { socket: { remoteAddress }, headers };
      }

      it("verifyServeOrigin:false → trusts the header exactly as before (sync, allowed)", () => {
        const cfg = { mode: "tailscale", allowedUsers, tailscale: { verifyServeOrigin: false } };
        const result = checkAuth(tsReq("100.64.0.1", { login: "user@example.com" }), cfg);
        // Plain object (NOT a promise) — proves the default path stayed synchronous.
        assert.strictEqual(typeof result.then, "undefined");
        assert.strictEqual(result.authorized, true);
        assert.strictEqual(result.user.type, "tailscale");
      });

      it("verifyServeOrigin:true + loopback + matching whois → authorized", async () => {
        const whoisFn = async () => "user@example.com";
        const cfg = {
          mode: "tailscale",
          allowedUsers,
          tailscale: { verifyServeOrigin: true, whoisFn },
        };
        const result = await checkAuth(
          tsReq("127.0.0.1", { login: "user@example.com", xff: "100.64.0.9" }),
          cfg,
        );
        assert.strictEqual(result.authorized, true);
        assert.strictEqual(result.user.login, "user@example.com");
      });

      it("verifyServeOrigin:true + non-loopback peer → denied (forged header)", async () => {
        const whoisFn = async () => "user@example.com";
        const cfg = {
          mode: "tailscale",
          allowedUsers,
          tailscale: { verifyServeOrigin: true, whoisFn },
        };
        const result = await checkAuth(
          tsReq("100.64.0.50", { login: "user@example.com", xff: "100.64.0.9" }),
          cfg,
        );
        assert.strictEqual(result.authorized, false);
        assert.match(result.reason, /verified/i);
      });

      it("verifyServeOrigin:true + whois mismatch → denied", async () => {
        const whoisFn = async () => "someone-else@example.com";
        const cfg = {
          mode: "tailscale",
          allowedUsers,
          tailscale: { verifyServeOrigin: true, whoisFn },
        };
        const result = await checkAuth(
          tsReq("127.0.0.1", { login: "user@example.com", xff: "100.64.0.9" }),
          cfg,
        );
        assert.strictEqual(result.authorized, false);
      });

      it("verifyServeOrigin:true + whois error → denied (fail closed)", async () => {
        const whoisFn = async () => null; // lookup failed / timed out
        const cfg = {
          mode: "tailscale",
          allowedUsers,
          tailscale: { verifyServeOrigin: true, whoisFn },
        };
        const result = await checkAuth(
          tsReq("127.0.0.1", { login: "user@example.com", xff: "100.64.0.9" }),
          cfg,
        );
        assert.strictEqual(result.authorized, false);
      });

      it("verifyServeOrigin:true + missing x-forwarded-for → denied (not via Serve)", async () => {
        const whoisFn = async () => "user@example.com";
        const cfg = {
          mode: "tailscale",
          allowedUsers,
          tailscale: { verifyServeOrigin: true, whoisFn },
        };
        const result = await checkAuth(tsReq("127.0.0.1", { login: "user@example.com" }), cfg);
        assert.strictEqual(result.authorized, false);
      });
    });
  });

  describe("verifyServeLogin()", () => {
    it("returns the verified login on loopback + matching whois", async () => {
      const req = {
        socket: { remoteAddress: "::ffff:127.0.0.1" },
        headers: { "x-forwarded-for": "100.64.0.9, 127.0.0.1" },
      };
      const verified = await verifyServeLogin(req, "user@example.com", async () => "user@example.com");
      assert.strictEqual(verified, "user@example.com");
    });

    it("returns null on a non-loopback peer", async () => {
      const req = { socket: { remoteAddress: "100.64.0.5" }, headers: { "x-forwarded-for": "100.64.0.9" } };
      assert.strictEqual(await verifyServeLogin(req, "x@y.com", async () => "x@y.com"), null);
    });

    it("returns null when no whoisFn is provided", async () => {
      const req = { socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "100.64.0.9" } };
      assert.strictEqual(await verifyServeLogin(req, "x@y.com", undefined), null);
    });
  });

  describe("createTailscaleWhois()", () => {
    it("parses LoginName from `tailscale whois --json` (lowercased) and caches it", async () => {
      let calls = 0;
      const execFileFn = (bin, args, opts, cb) => {
        calls += 1;
        assert.strictEqual(bin, "tailscale");
        assert.deepStrictEqual(args, ["whois", "--json", "100.64.0.9"]);
        cb(null, JSON.stringify({ UserProfile: { LoginName: "User@Example.com" } }), "");
      };
      const whois = createTailscaleWhois({ execFileFn });
      assert.strictEqual(await whois("100.64.0.9"), "user@example.com");
      // Second call within the cache window must not re-exec.
      assert.strictEqual(await whois("100.64.0.9"), "user@example.com");
      assert.strictEqual(calls, 1);
    });

    it("passes --socket when configured", async () => {
      const seen = [];
      const execFileFn = (bin, args, opts, cb) => {
        seen.push(args);
        cb(null, JSON.stringify({ UserProfile: { LoginName: "a@b.com" } }), "");
      };
      const whois = createTailscaleWhois({ socket: "/run/tailscale/tailscaled.sock", execFileFn });
      await whois("1.2.3.4");
      assert.deepStrictEqual(seen[0], ["--socket", "/run/tailscale/tailscaled.sock", "whois", "--json", "1.2.3.4"]);
    });

    it("fails closed (null) on exec error, empty stdout, and bad JSON", async () => {
      const errWhois = createTailscaleWhois({ execFileFn: (b, a, o, cb) => cb(new Error("boom")) });
      assert.strictEqual(await errWhois("1.1.1.1"), null);
      const emptyWhois = createTailscaleWhois({ execFileFn: (b, a, o, cb) => cb(null, "", "") });
      assert.strictEqual(await emptyWhois("2.2.2.2"), null);
      const badWhois = createTailscaleWhois({ execFileFn: (b, a, o, cb) => cb(null, "not json", "") });
      assert.strictEqual(await badWhois("3.3.3.3"), null);
    });

    it("returns null for an empty ip without exec", async () => {
      let called = false;
      const whois = createTailscaleWhois({ execFileFn: () => (called = true) });
      assert.strictEqual(await whois(""), null);
      assert.strictEqual(called, false);
    });
  });

  describe("getUnauthorizedPage()", () => {
    it("returns HTML string", () => {
      const html = getUnauthorizedPage("test reason", null, { mode: "token" });
      assert.ok(html.includes("<!DOCTYPE html>"));
      assert.ok(html.includes("Access Denied"));
      assert.ok(html.includes("test reason"));
    });

    it("includes user info when provided", () => {
      const html = getUnauthorizedPage("denied", { login: "user@test.com" }, { mode: "tailscale" });
      assert.ok(html.includes("user@test.com"));
    });

    it("includes auth mode in output", () => {
      const html = getUnauthorizedPage("denied", null, { mode: "cloudflare" });
      assert.ok(html.includes("cloudflare"));
    });
  });
});
