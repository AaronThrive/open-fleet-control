const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const {
  createTailscaleAdapter,
  normalizeStatus,
  stripTrailingDot,
  deriveMagicDnsSuffix,
  DEFAULT_LOCAL_API_ENDPOINT,
  STATUS_CACHE_TTL,
  NEGATIVE_STATUS_CACHE_TTL,
  EXEC_TIMEOUT_MS,
  LOCALAPI_MAX_CONSECUTIVE_FAILURES,
  LOCALAPI_REPROBE_INTERVAL_MS,
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

  describe("constants", () => {
    it("uses a 10s exec timeout", () => {
      assert.strictEqual(EXEC_TIMEOUT_MS, 10000);
    });

    it("caches negatives for a shorter TTL than positives", () => {
      assert.strictEqual(STATUS_CACHE_TTL, 10000);
      assert.strictEqual(NEGATIVE_STATUS_CACHE_TTL, 3000);
      assert.ok(NEGATIVE_STATUS_CACHE_TTL < STATUS_CACHE_TTL);
    });
  });

  describe("getStatus() — unavailability logging", () => {
    it("warns once on the transition to unavailable, not on every poll", async () => {
      const warnings = [];
      let fakeNow = 1000000;
      const adapter = createTailscaleAdapter({
        execFn: async () => {
          throw new Error("no cli");
        },
        fetchFn: async () => {
          throw new Error("refused");
        },
        nowFn: () => fakeNow,
        warnFn: (msg) => warnings.push(msg),
      });

      await adapter.getStatus();
      fakeNow += NEGATIVE_STATUS_CACHE_TTL + 1;
      await adapter.getStatus();
      fakeNow += NEGATIVE_STATUS_CACHE_TTL + 1;
      await adapter.getStatus();

      const transitionWarnings = warnings.filter((w) => w.includes("mesh status unavailable"));
      assert.strictEqual(transitionWarnings.length, 1, "exactly one transition warning expected");
      assert.ok(transitionWarnings[0].includes("no cli"), "warning carries the underlying error");
    });

    it("warns again after a recovery followed by a new failure", async () => {
      const warnings = [];
      let fakeNow = 1000000;
      let cliWorks = false;
      const adapter = createTailscaleAdapter({
        execFn: async () => {
          if (cliWorks) return JSON.stringify(rawStatus());
          throw new Error("no cli");
        },
        fetchFn: async () => {
          throw new Error("refused");
        },
        nowFn: () => fakeNow,
        warnFn: (msg) => warnings.push(msg),
      });

      await adapter.getStatus(); // unavailable -> warn #1
      cliWorks = true;
      fakeNow += NEGATIVE_STATUS_CACHE_TTL + 1;
      await adapter.getStatus(); // recovered
      cliWorks = false;
      fakeNow += STATUS_CACHE_TTL + 1;
      await adapter.getStatus(); // unavailable again -> warn #2

      const transitionWarnings = warnings.filter((w) => w.includes("mesh status unavailable"));
      assert.strictEqual(transitionWarnings.length, 2);
    });
  });

  describe("getStatus() — negative caching", () => {
    it("caches a failure for the shorter negative TTL", async () => {
      let execCalls = 0;
      let fakeNow = 1000000;
      const adapter = createTailscaleAdapter({
        execFn: async () => {
          execCalls++;
          throw new Error("no cli");
        },
        fetchFn: async () => {
          throw new Error("refused");
        },
        nowFn: () => fakeNow,
        warnFn: () => {},
      });

      await adapter.getStatus();
      assert.strictEqual(execCalls, 1);

      // Within the negative TTL: served from cache.
      fakeNow += NEGATIVE_STATUS_CACHE_TTL - 1;
      await adapter.getStatus();
      assert.strictEqual(execCalls, 1, "negative result must be cached within 3s");

      // Past the negative TTL (but well within the positive TTL): refreshed.
      fakeNow += 2;
      await adapter.getStatus();
      assert.strictEqual(execCalls, 2, "negative result must be retried after 3s");
    });
  });

  describe("getStatus() — preferred path memory", () => {
    it("tries the LocalAPI first after it was the last path to succeed", async () => {
      let execCalls = 0;
      let fetchCalls = 0;
      let fakeNow = 1000000;
      const adapter = createTailscaleAdapter({
        execFn: async () => {
          execCalls++;
          throw new Error("no cli");
        },
        fetchFn: async () => {
          fetchCalls++;
          return okResponse(rawStatus());
        },
        nowFn: () => fakeNow,
        warnFn: () => {},
      });

      // First refresh: CLI fails, LocalAPI succeeds.
      const first = await adapter.getStatus();
      assert.strictEqual(first.available, true);
      assert.strictEqual(execCalls, 1);
      assert.strictEqual(fetchCalls, 1);

      // Second refresh: LocalAPI is preferred — the CLI is not retried.
      fakeNow += STATUS_CACHE_TTL + 1;
      const second = await adapter.getStatus();
      assert.strictEqual(second.available, true);
      assert.strictEqual(fetchCalls, 2);
      assert.strictEqual(execCalls, 1, "CLI must not be retried while LocalAPI is preferred");
    });

    it("returns to preferring the CLI after the CLI succeeds again", async () => {
      let cliWorks = false;
      let fetchWorks = true;
      let fetchCalls = 0;
      let fakeNow = 1000000;
      const adapter = createTailscaleAdapter({
        execFn: async () => {
          if (cliWorks) return JSON.stringify(rawStatus());
          throw new Error("no cli");
        },
        fetchFn: async () => {
          fetchCalls++;
          if (fetchWorks) return okResponse(rawStatus());
          throw new Error("refused");
        },
        nowFn: () => fakeNow,
        warnFn: () => {},
      });

      await adapter.getStatus(); // CLI fails, LocalAPI succeeds -> preferred
      assert.strictEqual(fetchCalls, 1);

      // LocalAPI dies, CLI recovers: LocalAPI tried first (preferred), CLI rescues.
      cliWorks = true;
      fetchWorks = false;
      fakeNow += STATUS_CACHE_TTL + 1;
      const rescued = await adapter.getStatus();
      assert.strictEqual(rescued.available, true);
      assert.strictEqual(fetchCalls, 2);

      // CLI is now preferred: the LocalAPI is not touched while CLI works.
      fakeNow += STATUS_CACHE_TTL + 1;
      const next = await adapter.getStatus();
      assert.strictEqual(next.available, true);
      assert.strictEqual(fetchCalls, 2, "LocalAPI must not be hit once CLI is preferred again");
    });
  });

  describe("getStatus() — LocalAPI circuit breaker", () => {
    it("skips the LocalAPI fallback after 3 consecutive failures", async () => {
      let fetchCalls = 0;
      let fakeNow = 1000000;
      const warnings = [];
      const adapter = createTailscaleAdapter({
        execFn: async () => {
          throw new Error("no cli");
        },
        fetchFn: async () => {
          fetchCalls++;
          throw new Error("connection refused");
        },
        nowFn: () => fakeNow,
        warnFn: (msg) => warnings.push(msg),
      });

      for (let i = 0; i < LOCALAPI_MAX_CONSECUTIVE_FAILURES; i++) {
        await adapter.getStatus();
        fakeNow += NEGATIVE_STATUS_CACHE_TTL + 1;
      }
      assert.strictEqual(fetchCalls, LOCALAPI_MAX_CONSECUTIVE_FAILURES);

      // Subsequent refreshes must not touch the LocalAPI.
      const status = await adapter.getStatus();
      assert.strictEqual(fetchCalls, LOCALAPI_MAX_CONSECUTIVE_FAILURES, "fallback must be skipped");
      assert.strictEqual(status.available, false);
      assert.ok(status.error.includes("circuit open"), "error explains the skipped fallback");
      assert.ok(
        warnings.some((w) => w.includes("LocalAPI fallback disabled")),
        "circuit-open event is logged",
      );
    });

    it("re-probes the LocalAPI after the hourly re-probe interval", async () => {
      let fetchCalls = 0;
      let fakeNow = 1000000;
      const adapter = createTailscaleAdapter({
        execFn: async () => {
          throw new Error("no cli");
        },
        fetchFn: async () => {
          fetchCalls++;
          throw new Error("connection refused");
        },
        nowFn: () => fakeNow,
        warnFn: () => {},
      });

      for (let i = 0; i < LOCALAPI_MAX_CONSECUTIVE_FAILURES; i++) {
        await adapter.getStatus();
        fakeNow += NEGATIVE_STATUS_CACHE_TTL + 1;
      }
      await adapter.getStatus(); // circuit open: skipped
      assert.strictEqual(fetchCalls, LOCALAPI_MAX_CONSECUTIVE_FAILURES);

      // After the re-probe interval the LocalAPI is attempted again.
      fakeNow += LOCALAPI_REPROBE_INTERVAL_MS + 1;
      await adapter.getStatus();
      assert.strictEqual(fetchCalls, LOCALAPI_MAX_CONSECUTIVE_FAILURES + 1, "hourly re-probe");
    });

    it("closes the circuit once the LocalAPI succeeds on a re-probe", async () => {
      let fetchFails = true;
      let fetchCalls = 0;
      let fakeNow = 1000000;
      const adapter = createTailscaleAdapter({
        execFn: async () => {
          throw new Error("no cli");
        },
        fetchFn: async () => {
          fetchCalls++;
          if (fetchFails) throw new Error("connection refused");
          return okResponse(rawStatus());
        },
        nowFn: () => fakeNow,
        warnFn: () => {},
      });

      for (let i = 0; i < LOCALAPI_MAX_CONSECUTIVE_FAILURES; i++) {
        await adapter.getStatus();
        fakeNow += NEGATIVE_STATUS_CACHE_TTL + 1;
      }

      fetchFails = false;
      fakeNow += LOCALAPI_REPROBE_INTERVAL_MS + 1;
      const recovered = await adapter.getStatus();
      assert.strictEqual(recovered.available, true);

      // Circuit is closed and LocalAPI is now the preferred path.
      fakeNow += STATUS_CACHE_TTL + 1;
      const next = await adapter.getStatus();
      assert.strictEqual(next.available, true);
      assert.strictEqual(fetchCalls, LOCALAPI_MAX_CONSECUTIVE_FAILURES + 2);
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
