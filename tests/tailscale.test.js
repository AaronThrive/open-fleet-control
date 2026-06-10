const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const {
  createTailscaleAdapter,
  normalizeStatus,
  stripTrailingDot,
  deriveMagicDnsSuffix,
  DEFAULT_LOCAL_API_ENDPOINT,
} = require("../src/tailscale");

// Representative tailscale status JSON (same shape from CLI and LocalAPI).
// Tailnet name is a fixture value — the module must derive it at runtime.
function rawStatus() {
  return {
    Self: {
      ID: "self-1",
      HostName: "hermes",
      DNSName: "hermes.example-tailnet.ts.net.",
      TailscaleIPs: ["100.64.0.1"],
      Online: true,
      OS: "linux",
    },
    MagicDNSSuffix: "example-tailnet.ts.net",
    Peer: {
      "key-1": {
        ID: "peer-1",
        HostName: "atlas",
        DNSName: "atlas.example-tailnet.ts.net.",
        TailscaleIPs: ["100.64.0.2"],
        Online: true,
        LastSeen: "2026-06-09T00:00:00Z",
        OS: "macOS",
      },
      "key-2": {
        ID: "peer-2",
        HostName: "watchtower",
        DNSName: "watchtower.example-tailnet.ts.net.",
        TailscaleIPs: ["100.64.0.3"],
        Online: false,
        LastSeen: "2026-06-01T00:00:00Z",
        OS: "windows",
      },
    },
  };
}

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

describe("tailscale module", () => {
  const originalEndpoint = process.env.TAILSCALE_LOCAL_API_ENDPOINT;

  afterEach(() => {
    if (originalEndpoint === undefined) {
      delete process.env.TAILSCALE_LOCAL_API_ENDPOINT;
    } else {
      process.env.TAILSCALE_LOCAL_API_ENDPOINT = originalEndpoint;
    }
  });

  describe("stripTrailingDot()", () => {
    it("strips a trailing dot", () => {
      assert.strictEqual(stripTrailingDot("host.tailnet.ts.net."), "host.tailnet.ts.net");
    });

    it("leaves names without a trailing dot unchanged", () => {
      assert.strictEqual(stripTrailingDot("host.tailnet.ts.net"), "host.tailnet.ts.net");
    });

    it("returns empty string for non-string input", () => {
      assert.strictEqual(stripTrailingDot(null), "");
      assert.strictEqual(stripTrailingDot(undefined), "");
      assert.strictEqual(stripTrailingDot(42), "");
    });
  });

  describe("deriveMagicDnsSuffix()", () => {
    it("derives the suffix from a full DNSName", () => {
      assert.strictEqual(
        deriveMagicDnsSuffix("hermes.example-tailnet.ts.net."),
        "example-tailnet.ts.net",
      );
    });

    it("returns empty string when there is no dot", () => {
      assert.strictEqual(deriveMagicDnsSuffix("hermes"), "");
    });

    it("returns empty string for empty input", () => {
      assert.strictEqual(deriveMagicDnsSuffix(""), "");
      assert.strictEqual(deriveMagicDnsSuffix(undefined), "");
    });
  });

  describe("normalizeStatus()", () => {
    it("throws on an unrecognized payload", () => {
      assert.throws(() => normalizeStatus(null), /Unrecognized/);
      assert.throws(() => normalizeStatus({}), /Unrecognized/);
      assert.throws(() => normalizeStatus({ Peer: {} }), /Unrecognized/);
    });

    it("handles a status with no peers", () => {
      const raw = rawStatus();
      delete raw.Peer;
      const result = normalizeStatus(raw);
      assert.strictEqual(result.available, true);
      assert.deepStrictEqual(result.peers, []);
    });
  });

  describe("getStatus() — CLI mode", () => {
    it("normalizes CLI output into the fleet status shape", async () => {
      let fetchCalls = 0;
      const adapter = createTailscaleAdapter({
        execFn: async () => JSON.stringify(rawStatus()),
        fetchFn: async () => {
          fetchCalls++;
          throw new Error("should not be called");
        },
      });

      const status = await adapter.getStatus();
      assert.strictEqual(status.available, true);
      assert.strictEqual(fetchCalls, 0, "LocalAPI should not be hit when CLI succeeds");

      // Self normalization with trailing dots stripped
      assert.strictEqual(status.self.hostname, "hermes");
      assert.strictEqual(status.self.fqdn, "hermes.example-tailnet.ts.net");
      assert.strictEqual(status.self.magicDnsSuffix, "example-tailnet.ts.net");
      assert.deepStrictEqual(status.self.tailscaleIPs, ["100.64.0.1"]);

      // Peer normalization
      assert.strictEqual(status.peers.length, 2);
      const atlas = status.peers.find((p) => p.hostname === "atlas");
      assert.strictEqual(atlas.id, "peer-1");
      assert.strictEqual(atlas.fqdn, "atlas.example-tailnet.ts.net");
      assert.deepStrictEqual(atlas.ips, ["100.64.0.2"]);
      assert.strictEqual(atlas.online, true);
      assert.strictEqual(atlas.lastSeen, "2026-06-09T00:00:00Z");
      assert.strictEqual(atlas.os, "macOS");

      const watchtower = status.peers.find((p) => p.hostname === "watchtower");
      assert.strictEqual(watchtower.online, false);
    });
  });

  describe("getStatus() — LocalAPI sidecar mode", () => {
    it("falls back to the LocalAPI endpoint when the CLI fails", async () => {
      const fetchedUrls = [];
      const adapter = createTailscaleAdapter({
        execFn: async () => {
          throw new Error("tailscale: command not found");
        },
        fetchFn: async (url) => {
          fetchedUrls.push(url);
          return okResponse(rawStatus());
        },
      });

      const status = await adapter.getStatus();
      assert.strictEqual(status.available, true);
      assert.deepStrictEqual(fetchedUrls, [DEFAULT_LOCAL_API_ENDPOINT]);
      assert.strictEqual(status.self.magicDnsSuffix, "example-tailnet.ts.net");
      assert.strictEqual(status.peers.length, 2);
    });

    it("respects the TAILSCALE_LOCAL_API_ENDPOINT env override", async () => {
      process.env.TAILSCALE_LOCAL_API_ENDPOINT = "http://127.0.0.1:9999/custom/status";
      const fetchedUrls = [];
      const adapter = createTailscaleAdapter({
        execFn: async () => {
          throw new Error("no cli");
        },
        fetchFn: async (url) => {
          fetchedUrls.push(url);
          return okResponse(rawStatus());
        },
      });

      const status = await adapter.getStatus();
      assert.strictEqual(status.available, true);
      assert.deepStrictEqual(fetchedUrls, ["http://127.0.0.1:9999/custom/status"]);
    });
  });

  describe("getStatus() — unavailable", () => {
    it("returns available:false (never throws) when both modes fail", async () => {
      const adapter = createTailscaleAdapter({
        execFn: async () => {
          throw new Error("no cli");
        },
        fetchFn: async () => {
          throw new Error("connection refused");
        },
      });

      const status = await adapter.getStatus();
      assert.strictEqual(status.available, false);
      assert.ok(status.error.includes("no cli"));
      assert.ok(status.error.includes("connection refused"));
      assert.strictEqual(status.self, null);
      assert.deepStrictEqual(status.peers, []);
    });

    it("returns available:false when the LocalAPI responds non-200", async () => {
      const adapter = createTailscaleAdapter({
        execFn: async () => {
          throw new Error("no cli");
        },
        fetchFn: async () => ({ ok: false, status: 502, json: async () => ({}) }),
      });

      const status = await adapter.getStatus();
      assert.strictEqual(status.available, false);
      assert.ok(status.error.includes("502"));
    });

    it("returns available:false when the CLI emits garbage and LocalAPI fails", async () => {
      const adapter = createTailscaleAdapter({
        execFn: async () => "this is not json",
        fetchFn: async () => {
          throw new Error("refused");
        },
      });

      const status = await adapter.getStatus();
      assert.strictEqual(status.available, false);
    });
  });

  describe("getStatus() — caching", () => {
    it("serves a cached status within the TTL", async () => {
      let execCalls = 0;
      const adapter = createTailscaleAdapter({
        execFn: async () => {
          execCalls++;
          return JSON.stringify(rawStatus());
        },
        cacheTtlMs: 10000,
      });

      const first = await adapter.getStatus();
      const second = await adapter.getStatus();
      assert.strictEqual(execCalls, 1, "second call within TTL must hit the cache");
      assert.strictEqual(first, second);
    });

    it("refreshes once the TTL has elapsed", async () => {
      let execCalls = 0;
      let fakeNow = 1000000;
      const adapter = createTailscaleAdapter({
        execFn: async () => {
          execCalls++;
          return JSON.stringify(rawStatus());
        },
        cacheTtlMs: 10000,
        nowFn: () => fakeNow,
      });

      await adapter.getStatus();
      fakeNow += 10001; // advance past the TTL
      await adapter.getStatus();
      assert.strictEqual(execCalls, 2);
    });
  });
});
