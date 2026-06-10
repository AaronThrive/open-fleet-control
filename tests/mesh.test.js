const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createMesh,
  composeNodeUrl,
  validateNodeInput,
  extractNodeCosts,
  LATENCY_SAMPLE_LIMIT,
} = require("../src/mesh");

const SUFFIX = "test-tailnet.ts.net";

// Fake tailscale adapter — suffix and peers injected, never hardcoded in src.
function fakeTailscale(overrides = {}) {
  const status = {
    available: true,
    self: {
      hostname: "hermes",
      fqdn: `hermes.${SUFFIX}`,
      tailscaleIPs: ["100.64.0.1"],
      magicDnsSuffix: SUFFIX,
    },
    peers: [
      {
        id: "peer-1",
        hostname: "atlas",
        fqdn: `atlas.${SUFFIX}`,
        ips: ["100.64.0.2"],
        online: true,
        lastSeen: null,
        os: "macos",
      },
      {
        id: "peer-2",
        hostname: "watchtower",
        fqdn: `watchtower.${SUFFIX}`,
        ips: ["100.64.0.3"],
        online: false,
        lastSeen: "2026-06-01T00:00:00Z",
        os: "windows",
      },
    ],
    ...overrides,
  };
  return { getStatus: async () => status };
}

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

describe("mesh module", () => {
  let stateDir;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-test-"));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function makeMesh(overrides = {}) {
    return createMesh({
      stateDir,
      tailscale: fakeTailscale(),
      fetchFn: async () => okResponse({ status: "ok" }),
      ...overrides,
    });
  }

  describe("composeNodeUrl()", () => {
    const node = { hostname: "atlas", port: 443, protocol: "https", healthPath: "/health" };

    it("omits the port for 443", () => {
      assert.strictEqual(composeNodeUrl(node, SUFFIX), `https://atlas.${SUFFIX}/health`);
    });

    it("includes a non-default port", () => {
      const custom = { ...node, port: 8443 };
      assert.strictEqual(composeNodeUrl(custom, SUFFIX), `https://atlas.${SUFFIX}:8443/health`);
    });

    it("supports a path override", () => {
      assert.strictEqual(
        composeNodeUrl(node, SUFFIX, "/api/state"),
        `https://atlas.${SUFFIX}/api/state`,
      );
    });

    it("falls back to the bare hostname when the suffix is empty", () => {
      assert.strictEqual(composeNodeUrl(node, ""), "https://atlas/health");
    });
  });

  describe("validateNodeInput()", () => {
    it("applies defaults for a minimal valid input", () => {
      const result = validateNodeInput({ hostname: "atlas" });
      assert.strictEqual(result.hostname, "atlas");
      assert.strictEqual(result.port, 443);
      assert.strictEqual(result.protocol, "https");
      assert.strictEqual(result.healthPath, "/health");
      assert.strictEqual(result.platform, "unknown");
      assert.strictEqual(result.label, "atlas");
    });

    it("rejects a missing or non-string hostname", () => {
      assert.throws(() => validateNodeInput({}), /Invalid hostname/);
      assert.throws(() => validateNodeInput({ hostname: 42 }), /Invalid hostname/);
    });

    it("rejects hostnames outside [a-z0-9-]", () => {
      assert.throws(() => validateNodeInput({ hostname: "Atlas" }), /Invalid hostname/);
      assert.throws(() => validateNodeInput({ hostname: "bad_host" }), /Invalid hostname/);
      assert.throws(() => validateNodeInput({ hostname: "host.evil.com" }), /Invalid hostname/);
      assert.throws(() => validateNodeInput({ hostname: "host name" }), /Invalid hostname/);
      assert.throws(() => validateNodeInput({ hostname: "" }), /Invalid hostname/);
    });

    it("rejects out-of-range or non-integer ports", () => {
      assert.throws(() => validateNodeInput({ hostname: "atlas", port: 0 }), /Invalid port/);
      assert.throws(() => validateNodeInput({ hostname: "atlas", port: 65536 }), /Invalid port/);
      assert.throws(() => validateNodeInput({ hostname: "atlas", port: 8.5 }), /Invalid port/);
      assert.throws(() => validateNodeInput({ hostname: "atlas", port: "8443" }), /Invalid port/);
    });

    it("rejects a healthPath that does not start with /", () => {
      assert.throws(
        () => validateNodeInput({ hostname: "atlas", healthPath: "health" }),
        /Invalid healthPath/,
      );
    });

    it("rejects an unknown platform", () => {
      assert.throws(
        () => validateNodeInput({ hostname: "atlas", platform: "beos" }),
        /Invalid platform/,
      );
    });

    it("accepts all valid platforms", () => {
      for (const platform of ["linux", "windows-wsl", "macos", "unknown"]) {
        const result = validateNodeInput({ hostname: "atlas", platform });
        assert.strictEqual(result.platform, platform);
      }
    });

    it("rejects a non-string label", () => {
      assert.throws(() => validateNodeInput({ hostname: "atlas", label: 42 }), /Invalid label/);
    });
  });

  describe("registry CRUD + persistence", () => {
    it("registerNode persists an atomic registry file", () => {
      const mesh = makeMesh();
      const record = mesh.registerNode({ hostname: "atlas", platform: "macos", label: "Atlas" });

      assert.ok(record.id, "record should have an id");
      assert.ok(record.registeredAt, "record should have registeredAt");
      assert.strictEqual(record.protocol, "https");

      const registryFile = path.join(stateDir, "mesh-nodes.json");
      assert.ok(fs.existsSync(registryFile), "registry file should exist");

      // No leftover temp files (atomic write: temp + rename)
      const leftovers = fs.readdirSync(stateDir).filter((f) => f.includes(".tmp-"));
      assert.deepStrictEqual(leftovers, []);

      const persisted = JSON.parse(fs.readFileSync(registryFile, "utf8"));
      assert.strictEqual(persisted.nodes.length, 1);
      assert.strictEqual(persisted.nodes[0].hostname, "atlas");
    });

    it("creates the state directory when missing", () => {
      const nested = path.join(stateDir, "deep", "nested");
      const mesh = createMesh({ stateDir: nested, tailscale: fakeTailscale() });
      mesh.registerNode({ hostname: "atlas" });
      assert.ok(fs.existsSync(path.join(nested, "mesh-nodes.json")));
    });

    it("rejects duplicate hostnames", () => {
      const mesh = makeMesh();
      mesh.registerNode({ hostname: "atlas" });
      assert.throws(() => mesh.registerNode({ hostname: "atlas" }), /already registered/);
    });

    it("propagates validation errors from registerNode", () => {
      const mesh = makeMesh();
      assert.throws(() => mesh.registerNode({ hostname: "BAD!" }), /Invalid hostname/);
      assert.throws(() => mesh.registerNode({ hostname: "atlas", port: -1 }), /Invalid port/);
    });

    it("unregisterNode removes by id and persists", () => {
      const mesh = makeMesh();
      const record = mesh.registerNode({ hostname: "atlas" });
      mesh.registerNode({ hostname: "watchtower" });

      const removed = mesh.unregisterNode(record.id);
      assert.strictEqual(removed.hostname, "atlas");

      const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, "mesh-nodes.json"), "utf8"));
      assert.strictEqual(persisted.nodes.length, 1);
      assert.strictEqual(persisted.nodes[0].hostname, "watchtower");
    });

    it("unregisterNode also accepts a hostname", () => {
      const mesh = makeMesh();
      mesh.registerNode({ hostname: "atlas" });
      const removed = mesh.unregisterNode("atlas");
      assert.strictEqual(removed.hostname, "atlas");
    });

    it("unregisterNode throws for an unknown node", () => {
      const mesh = makeMesh();
      assert.throws(() => mesh.unregisterNode("ghost"), /Unknown node/);
    });

    it("reloads persisted nodes in a fresh mesh instance", async () => {
      const mesh = makeMesh();
      mesh.registerNode({ hostname: "atlas", port: 8443 });

      const reloaded = makeMesh();
      const state = await reloaded.getState();
      assert.strictEqual(state.nodes.length, 1);
      assert.strictEqual(state.nodes[0].hostname, "atlas");
      assert.strictEqual(state.nodes[0].url, `https://atlas.${SUFFIX}:8443/health`);
    });
  });

  describe("health polling", () => {
    it("marks a node online on HTTP 200 and records latency + version", async () => {
      const fetchedUrls = [];
      const mesh = makeMesh({
        fetchFn: async (url) => {
          fetchedUrls.push(url);
          return okResponse({ status: "ok", version: "9.9.9" });
        },
      });
      mesh.registerNode({ hostname: "atlas" });

      await mesh._pollOnce();
      const state = await mesh.getState();
      const health = state.nodes[0].health;

      assert.deepStrictEqual(fetchedUrls, [`https://atlas.${SUFFIX}/health`]);
      assert.strictEqual(health.status, "online");
      assert.strictEqual(typeof health.latencyMs, "number");
      assert.strictEqual(health.consecutiveFailures, 0);
      assert.ok(health.lastChecked, "lastChecked should be set");
      assert.ok(health.lastOnline, "lastOnline should be set");
      assert.strictEqual(health.version, "9.9.9");
      assert.strictEqual(health.latencySamples.length, 1);
    });

    it("marks an online tailscale peer with refused connection as unreachable", async () => {
      const mesh = makeMesh({
        fetchFn: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      });
      mesh.registerNode({ hostname: "atlas" }); // peer Online=true in fakeTailscale

      await mesh._pollOnce();
      const state = await mesh.getState();
      assert.strictEqual(state.nodes[0].health.status, "unreachable");
      assert.strictEqual(state.nodes[0].health.consecutiveFailures, 1);
    });

    it("marks a node offline when its tailscale peer reports Online=false", async () => {
      const mesh = makeMesh({
        fetchFn: async () => {
          throw new Error("timeout");
        },
      });
      mesh.registerNode({ hostname: "watchtower" }); // peer Online=false

      await mesh._pollOnce();
      const state = await mesh.getState();
      assert.strictEqual(state.nodes[0].health.status, "offline");
    });

    it("treats a node with no matching peer as unreachable on failure", async () => {
      const mesh = makeMesh({
        fetchFn: async () => {
          throw new Error("timeout");
        },
      });
      mesh.registerNode({ hostname: "ghost" });

      await mesh._pollOnce();
      const state = await mesh.getState();
      assert.strictEqual(state.nodes[0].health.status, "unreachable");
    });

    it("transitions online -> unreachable and preserves lastOnline", async () => {
      let failing = false;
      const mesh = makeMesh({
        fetchFn: async () => {
          if (failing) throw new Error("connect ECONNREFUSED");
          return okResponse({ status: "ok", version: "1.0.0" });
        },
      });
      mesh.registerNode({ hostname: "atlas" });

      await mesh._pollOnce();
      const onlineState = await mesh.getState();
      const lastOnline = onlineState.nodes[0].health.lastOnline;
      assert.strictEqual(onlineState.nodes[0].health.status, "online");

      failing = true;
      await mesh._pollOnce();
      await mesh._pollOnce();
      const failedState = await mesh.getState();
      const health = failedState.nodes[0].health;

      assert.strictEqual(health.status, "unreachable");
      assert.strictEqual(health.consecutiveFailures, 2);
      assert.strictEqual(health.lastOnline, lastOnline, "lastOnline must survive failures");
      assert.strictEqual(health.version, "1.0.0", "version must survive failures");
    });

    it("caps the latency ring buffer at the sample limit", async () => {
      const mesh = makeMesh({
        fetchFn: async () => okResponse({ status: "ok", version: "1.0.0" }),
      });
      mesh.registerNode({ hostname: "atlas" });

      for (let i = 0; i < LATENCY_SAMPLE_LIMIT + 5; i++) {
        await mesh._pollOnce();
      }

      const state = await mesh.getState();
      assert.strictEqual(state.nodes[0].health.latencySamples.length, LATENCY_SAMPLE_LIMIT);
    });

    it("fires onChange only when a node's status changes", async () => {
      const events = [];
      let failing = false;
      const mesh = makeMesh({
        onChange: (event) => events.push(event),
        fetchFn: async () => {
          if (failing) throw new Error("connect ECONNREFUSED");
          return okResponse({ status: "ok", version: "1.0.0" });
        },
      });
      mesh.registerNode({ hostname: "atlas" });

      await mesh._pollOnce(); // unknown -> online
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].previousStatus, "unknown");
      assert.strictEqual(events[0].status, "online");
      assert.strictEqual(events[0].node.hostname, "atlas");

      await mesh._pollOnce(); // online -> online (no event)
      assert.strictEqual(events.length, 1);

      failing = true;
      await mesh._pollOnce(); // online -> unreachable
      assert.strictEqual(events.length, 2);
      assert.strictEqual(events[1].previousStatus, "online");
      assert.strictEqual(events[1].status, "unreachable");

      await mesh._pollOnce(); // unreachable -> unreachable (no event)
      assert.strictEqual(events.length, 2);
    });

    it("survives an onChange callback that throws", async () => {
      const mesh = makeMesh({
        onChange: () => {
          throw new Error("subscriber bug");
        },
      });
      mesh.registerNode({ hostname: "atlas" });
      await mesh._pollOnce(); // must not reject
      const state = await mesh.getState();
      assert.strictEqual(state.nodes[0].health.status, "online");
    });
  });

  describe("discoverPeers()", () => {
    it("merges tailscale peers with the registry", async () => {
      const mesh = makeMesh();
      mesh.registerNode({ hostname: "atlas" });
      mesh.registerNode({ hostname: "ghost" }); // registered but not a peer

      const result = await mesh.discoverPeers();
      assert.strictEqual(result.available, true);

      const atlas = result.candidates.find((c) => c.hostname === "atlas");
      assert.strictEqual(atlas.registered, true);
      assert.strictEqual(atlas.online, true);
      assert.ok(atlas.nodeId);

      const watchtower = result.candidates.find((c) => c.hostname === "watchtower");
      assert.strictEqual(watchtower.registered, false);
      assert.strictEqual(watchtower.nodeId, null);

      const ghost = result.candidates.find((c) => c.hostname === "ghost");
      assert.strictEqual(ghost.registered, true);
      assert.strictEqual(ghost.online, null);
    });

    it("returns registered nodes as candidates when tailscale is unavailable", async () => {
      const mesh = makeMesh({
        tailscale: { getStatus: async () => ({ available: false, error: "down", peers: [] }) },
      });
      mesh.registerNode({ hostname: "atlas" });

      const result = await mesh.discoverPeers();
      assert.strictEqual(result.available, false);
      assert.strictEqual(result.candidates.length, 1);
      assert.strictEqual(result.candidates[0].registered, true);
    });
  });

  describe("cost rollup", () => {
    it("extractNodeCosts tolerates shape mismatches with nulls", () => {
      assert.strictEqual(extractNodeCosts(null), null);
      assert.strictEqual(extractNodeCosts("garbage"), null);
      const empty = extractNodeCosts({ totally: "unrelated" });
      assert.deepStrictEqual(empty, {
        cost24h: null,
        cost7d: null,
        totalTokens: null,
        version: null,
      });
    });

    it("aggregates fleet costs from remote /api/state responses", async () => {
      const mesh = makeMesh({
        fetchFn: async (url) => {
          if (url.endsWith("/api/state")) {
            return okResponse({
              version: "1.5.0",
              llmUsage: { usage24h: { cost: 1.25 }, usage7d: { cost: 7.5 } },
            });
          }
          return okResponse({ status: "ok" });
        },
      });
      const record = mesh.registerNode({ hostname: "atlas" });

      const costs = await mesh.getFleetCosts();
      assert.strictEqual(costs.byNode[record.id].hostname, "atlas");
      assert.strictEqual(costs.byNode[record.id].stats.cost24h, 1.25);
      assert.strictEqual(costs.byNode[record.id].stats.cost7d, 7.5);
      assert.strictEqual(costs.byNode[record.id].stats.version, "1.5.0");
      assert.strictEqual(costs.totals.cost24h, 1.25);
      assert.strictEqual(costs.totals.cost7d, 7.5);
      assert.strictEqual(costs.totals.nodesReporting, 1);
    });

    it("returns null stats for unreachable or malformed nodes", async () => {
      const mesh = makeMesh({
        fetchFn: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      });
      const record = mesh.registerNode({ hostname: "atlas" });

      const costs = await mesh.getFleetCosts();
      assert.strictEqual(costs.byNode[record.id].stats, null);
      assert.strictEqual(costs.totals.cost24h, 0);
      assert.strictEqual(costs.totals.nodesReporting, 0);
    });
  });

  describe("getState()", () => {
    it("returns self identity, nodes with composed URLs, and candidates", async () => {
      const mesh = makeMesh();
      mesh.registerNode({ hostname: "atlas", port: 8443, platform: "macos" });

      const state = await mesh.getState();
      assert.strictEqual(state.self.hostname, "hermes");
      assert.strictEqual(state.self.magicDnsSuffix, SUFFIX);
      assert.strictEqual(state.tailscale.available, true);
      assert.strictEqual(state.nodes[0].url, `https://atlas.${SUFFIX}:8443/health`);
      assert.strictEqual(state.nodes[0].health.status, "unknown");
      assert.ok(Array.isArray(state.candidates));
      assert.ok(state.timestamp > 0);
    });

    it("reports tailscale unavailability without throwing", async () => {
      const mesh = makeMesh({
        tailscale: { getStatus: async () => ({ available: false, error: "down", peers: [] }) },
      });
      mesh.registerNode({ hostname: "atlas" });

      const state = await mesh.getState();
      assert.strictEqual(state.self, null);
      assert.strictEqual(state.tailscale.available, false);
      assert.strictEqual(state.tailscale.error, "down");
      // URL falls back to bare hostname when the suffix is unknown
      assert.strictEqual(state.nodes[0].url, "https://atlas/health");
    });
  });

  describe("createMesh() validation and lifecycle", () => {
    it("requires a stateDir", () => {
      assert.throws(() => createMesh({}), /stateDir/);
    });

    it("start() and stop() are idempotent", () => {
      const mesh = makeMesh({ intervalMs: 60000 });
      mesh.start();
      mesh.start(); // no-op
      mesh.stop();
      mesh.stop(); // no-op
    });
  });
});
