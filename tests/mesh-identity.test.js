/**
 * Mesh instance-identity tests.
 *
 * The mesh registry used to dedupe nodes by hostname alone, which made a
 * second dashboard instance on the same host (e.g. oc-bot-1:3333 +
 * hermes:3334) impossible to register. Identity is now hostname + port,
 * with a migration-safe comparison: legacy records persisted without a
 * port field (or with a malformed one) behave exactly like the https
 * default (443) they were registered under.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMesh, nodeInstanceKey, isSameInstance } = require("../src/mesh");

const SUFFIX = "test-tailnet.ts.net";

function fakeTailscale() {
  return {
    getStatus: async () => ({
      available: true,
      self: { hostname: "hermes", fqdn: `hermes.${SUFFIX}`, magicDnsSuffix: SUFFIX },
      peers: [
        {
          id: "peer-1",
          hostname: "hermes",
          fqdn: `hermes.${SUFFIX}`,
          ips: ["100.64.0.1"],
          online: true,
          lastSeen: null,
          os: "linux",
        },
      ],
    }),
  };
}

describe("mesh instance identity", () => {
  let stateDir;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-identity-test-"));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function makeMesh() {
    return createMesh({
      stateDir,
      tailscale: fakeTailscale(),
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ status: "ok" }) }),
    });
  }

  /** Write a registry file directly (simulates a pre-fix install). */
  function writeRegistry(nodes) {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "mesh-nodes.json"), JSON.stringify({ nodes }, null, 2));
  }

  describe("nodeInstanceKey()", () => {
    it("composes hostname:port", () => {
      assert.strictEqual(nodeInstanceKey({ hostname: "hermes", port: 3334 }), "hermes:3334");
    });

    it("defaults a missing port to 443 (legacy records)", () => {
      assert.strictEqual(nodeInstanceKey({ hostname: "atlas" }), "atlas:443");
    });

    it("defaults malformed ports to 443", () => {
      assert.strictEqual(nodeInstanceKey({ hostname: "atlas", port: "8443" }), "atlas:443");
      assert.strictEqual(nodeInstanceKey({ hostname: "atlas", port: 0 }), "atlas:443");
      assert.strictEqual(nodeInstanceKey({ hostname: "atlas", port: 8.5 }), "atlas:443");
      assert.strictEqual(nodeInstanceKey({ hostname: "atlas", port: null }), "atlas:443");
    });
  });

  describe("isSameInstance()", () => {
    it("matches identical hostname + port", () => {
      assert.strictEqual(
        isSameInstance({ hostname: "hermes", port: 3334 }, { hostname: "hermes", port: 3334 }),
        true,
      );
    });

    it("distinguishes two instances on one host by port", () => {
      assert.strictEqual(
        isSameInstance({ hostname: "hermes", port: 3333 }, { hostname: "hermes", port: 3334 }),
        false,
      );
    });

    it("treats a legacy record without port as the 443 default", () => {
      assert.strictEqual(
        isSameInstance({ hostname: "atlas" }, { hostname: "atlas", port: 443 }),
        true,
      );
      assert.strictEqual(
        isSameInstance({ hostname: "atlas" }, { hostname: "atlas", port: 3334 }),
        false,
      );
      // Two legacy records on the same host are still the same instance.
      assert.strictEqual(isSameInstance({ hostname: "atlas" }, { hostname: "atlas" }), true);
    });

    it("never matches across hostnames and tolerates junk input", () => {
      assert.strictEqual(
        isSameInstance({ hostname: "atlas", port: 443 }, { hostname: "hermes", port: 443 }),
        false,
      );
      assert.strictEqual(isSameInstance(null, { hostname: "atlas" }), false);
      assert.strictEqual(isSameInstance({ hostname: "atlas" }, undefined), false);
      assert.strictEqual(isSameInstance("atlas", "atlas"), false);
    });
  });

  describe("registerNode() with instance identity", () => {
    it("registers two instances on the same host with different ports", () => {
      const mesh = makeMesh();
      const main = mesh.registerNode({ hostname: "hermes", port: 3333, label: "Main" });
      const economy = mesh.registerNode({ hostname: "hermes", port: 3334, label: "Economy" });

      assert.notStrictEqual(main.id, economy.id);
      const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, "mesh-nodes.json"), "utf8"));
      assert.strictEqual(persisted.nodes.length, 2);
    });

    it("still rejects the exact same hostname + port", () => {
      const mesh = makeMesh();
      mesh.registerNode({ hostname: "hermes", port: 3334 });
      assert.throws(
        () => mesh.registerNode({ hostname: "hermes", port: 3334 }),
        /already registered: hermes:3334/,
      );
    });

    it("rejects a default-port re-registration against a legacy record without port", () => {
      writeRegistry([{ id: "legacy-1", hostname: "atlas", protocol: "https" }]); // no port field
      const mesh = makeMesh();
      // validateNodeInput defaults port to 443, which the legacy record implies.
      assert.throws(() => mesh.registerNode({ hostname: "atlas" }), /already registered/);
      assert.throws(
        () => mesh.registerNode({ hostname: "atlas", port: 443 }),
        /already registered/,
      );
    });

    it("allows a non-default-port instance alongside a legacy record without port", () => {
      writeRegistry([{ id: "legacy-1", hostname: "atlas", protocol: "https" }]); // no port field
      const mesh = makeMesh();
      const record = mesh.registerNode({ hostname: "atlas", port: 3334 });
      assert.strictEqual(record.port, 3334);

      const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, "mesh-nodes.json"), "utf8"));
      assert.strictEqual(persisted.nodes.length, 2);
    });
  });

  describe("multi-instance hosts in state + lifecycle", () => {
    it("getState lists both instances on one host with distinct URLs", async () => {
      const mesh = makeMesh();
      mesh.registerNode({ hostname: "hermes", port: 3333, healthPath: "/health" });
      mesh.registerNode({ hostname: "hermes", port: 3334, healthPath: "/health" });

      const state = await mesh.getState();
      const urls = state.nodes.map((n) => n.url).sort();
      assert.deepStrictEqual(urls, [
        `https://hermes.${SUFFIX}:3333/health`,
        `https://hermes.${SUFFIX}:3334/health`,
      ]);
    });

    it("unregisterNode supports the instance key and removes only that instance", () => {
      const mesh = makeMesh();
      mesh.registerNode({ hostname: "hermes", port: 3333 });
      mesh.registerNode({ hostname: "hermes", port: 3334 });

      const removed = mesh.unregisterNode("hermes:3334");
      assert.strictEqual(removed.port, 3334);

      const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, "mesh-nodes.json"), "utf8"));
      assert.strictEqual(persisted.nodes.length, 1);
      assert.strictEqual(persisted.nodes[0].port, 3333);
    });

    it("unregisterNode still accepts id and bare hostname (backward compatible)", () => {
      const mesh = makeMesh();
      const record = mesh.registerNode({ hostname: "hermes", port: 3333 });
      mesh.registerNode({ hostname: "hermes", port: 3334 });

      assert.strictEqual(mesh.unregisterNode(record.id).id, record.id);
      // Bare hostname removes the first remaining match.
      assert.strictEqual(mesh.unregisterNode("hermes").port, 3334);
      assert.throws(() => mesh.unregisterNode("hermes"), /Unknown node/);
    });
  });
});
