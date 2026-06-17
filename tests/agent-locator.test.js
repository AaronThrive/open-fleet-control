/**
 * Unit tests for src/agent-locator.js — agent → node routing decision.
 *
 * Injects fake rosterFn / meshFn (no network, no CLI). Covers local, remote,
 * the "id@node" pin, unknown agents, unreachable nodes, and the online flag.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { createAgentLocator } = require("../src/agent-locator");

const SELF = "node-a";

function makeLocator({ agents = [], nodes = [] } = {}) {
  return createAgentLocator({
    rosterFn: async () => ({ agents }),
    meshFn: async () => ({ nodes }),
    selfNode: SELF,
  });
}

// A mesh node as composed by mesh.getState(): url ends with the healthPath.
function meshNode(hostname, { status = "online", port = 8443 } = {}) {
  return {
    hostname,
    url: `https://${hostname}.tail1234.ts.net:${port}/health`,
    healthPath: "/health",
    health: { status },
  };
}

describe("agent-locator", () => {
  it("resolves a local agent (node === self) to kind:local", async () => {
    const locator = makeLocator({ agents: [{ id: "dev", node: SELF }] });
    assert.deepStrictEqual(await locator.resolve("dev"), { kind: "local", agentId: "dev" });
  });

  it("resolves a remote-only agent to kind:remote with baseUrl + online", async () => {
    const locator = makeLocator({
      agents: [{ id: "scout", node: "node-b" }],
      nodes: [meshNode("node-b")],
    });
    const route = await locator.resolve("scout");
    assert.strictEqual(route.kind, "remote");
    assert.strictEqual(route.agentId, "scout");
    assert.strictEqual(route.node, "node-b");
    assert.strictEqual(route.baseUrl, "https://node-b.tail1234.ts.net:8443");
    assert.strictEqual(route.online, true);
  });

  it("honours an explicit id@node pin even when the agent also exists locally", async () => {
    const locator = makeLocator({
      agents: [
        { id: "dev", node: SELF },
        { id: "dev", node: "node-b" },
      ],
      nodes: [meshNode("node-b")],
    });
    const route = await locator.resolve("dev@node-b");
    assert.strictEqual(route.kind, "remote");
    assert.strictEqual(route.node, "node-b");
  });

  it("prefers the local match when no pin is given and the agent exists locally", async () => {
    const locator = makeLocator({
      agents: [
        { id: "dev", node: "node-b" },
        { id: "dev", node: SELF },
      ],
      nodes: [meshNode("node-b")],
    });
    assert.strictEqual((await locator.resolve("dev")).kind, "local");
  });

  it("returns kind:unknown for an agent absent from the roster", async () => {
    const locator = makeLocator({ agents: [{ id: "dev", node: SELF }] });
    assert.deepStrictEqual(await locator.resolve("ghost"), { kind: "unknown", agentId: "ghost" });
  });

  it("returns kind:unreachable when the agent's node has no mesh record", async () => {
    const locator = makeLocator({
      agents: [{ id: "scout", node: "node-c" }],
      nodes: [meshNode("node-b")],
    });
    assert.deepStrictEqual(await locator.resolve("scout"), {
      kind: "unreachable",
      agentId: "scout",
      node: "node-c",
    });
  });

  it("marks an offline remote node with online:false", async () => {
    const locator = makeLocator({
      agents: [{ id: "scout", node: "node-b" }],
      nodes: [meshNode("node-b", { status: "offline" })],
    });
    const route = await locator.resolve("scout");
    assert.strictEqual(route.kind, "remote");
    assert.strictEqual(route.online, false);
  });

  it("throws when rosterFn or meshFn is missing", () => {
    assert.throws(() => createAgentLocator({ meshFn: async () => ({}), selfNode: SELF }));
    assert.throws(() => createAgentLocator({ rosterFn: async () => ({}), selfNode: SELF }));
  });

  it("prefers the OFC-dashboard mesh record over a gateway proxy for a duplicate hostname", async () => {
    // node-b registers TWICE: a gateway proxy advertising /health, and the real
    // OFC dashboard advertising /api/health. The resolver must pick the dashboard
    // record so agent-run reaches OFC, not the proxy.
    const gateway = {
      hostname: "node-b",
      url: "https://node-b.tail1234.ts.net:443/health",
      healthPath: "/health",
      health: { status: "online" },
    };
    const dashboard = {
      hostname: "node-b",
      url: "https://node-b.tail1234.ts.net:8443/api/health",
      healthPath: "/api/health",
      health: { status: "online" },
    };
    // Proxy listed FIRST so a naive find() would wrongly pick it.
    const locator = makeLocator({
      agents: [{ id: "scout", node: "node-b" }],
      nodes: [gateway, dashboard],
    });
    const route = await locator.resolve("scout");
    assert.strictEqual(route.kind, "remote");
    assert.strictEqual(route.baseUrl, "https://node-b.tail1234.ts.net:8443");
  });
});
