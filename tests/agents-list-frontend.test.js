/**
 * Tests for the pure (DOM-free) helpers used by the Agents detail-list view.
 * The module is browser ESM, so it is loaded via dynamic import.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert");

let buildAgentRows;
let relativeSpan;

before(async () => {
  const mod = await import("../public/js/views/agents.js");
  buildAgentRows = mod.buildAgentRows;
  relativeSpan = mod.relativeSpan;
});

const ROSTER = {
  agents: [
    {
      id: "main",
      name: "Main",
      node: "alpha",
      source: "openclaw",
      model: "claude-fable-5",
      active: true,
      lastActiveAt: 1000,
      sessionCount: 4,
      workspace: "/home/a/ws",
      subagentsMax: 8,
    },
    {
      id: "scout",
      name: "Scout",
      node: "beta",
      source: "hermes",
      active: false,
      via: "federation",
    },
    { id: "drone", node: "beta", source: "openclaw", active: true, lastActiveAt: 2000 },
  ],
};

describe("buildAgentRows()", () => {
  it("flattens the roster into rows with stable per-node ids", () => {
    const rows = buildAgentRows(ROSTER, {});
    assert.strictEqual(rows.length, 3);
    assert.deepStrictEqual(
      rows.map((r) => r.id),
      ["alpha/main", "beta/scout", "beta/drone"],
    );
  });

  it("maps display fields with fallbacks", () => {
    const [main, scout, drone] = buildAgentRows(ROSTER, {});
    assert.strictEqual(main.name, "Main");
    assert.strictEqual(main.model, "claude-fable-5");
    assert.strictEqual(main.status, "active");
    assert.strictEqual(main.lastActiveAt, 1000);
    assert.strictEqual(main.via, "");
    assert.strictEqual(scout.source, "hermes");
    assert.strictEqual(scout.via, "federation");
    assert.strictEqual(scout.status, "idle");
    assert.strictEqual(scout.lastActiveAt, null);
    assert.strictEqual(drone.name, "drone"); // falls back to id
    assert.strictEqual(drone.model, "");
    assert.strictEqual(main.agent, ROSTER.agents[0]); // raw agent kept for the detail panel
  });

  it("filters by node", () => {
    const rows = buildAgentRows(ROSTER, { nodeFilter: "beta" });
    assert.deepStrictEqual(
      rows.map((r) => r.agentId),
      ["scout", "drone"],
    );
  });

  it("filters to active-only agents", () => {
    const rows = buildAgentRows(ROSTER, { activeOnly: true });
    assert.deepStrictEqual(
      rows.map((r) => r.agentId),
      ["main", "drone"],
    );
  });

  it("combines node and active filters", () => {
    const rows = buildAgentRows(ROSTER, { nodeFilter: "beta", activeOnly: true });
    assert.deepStrictEqual(
      rows.map((r) => r.agentId),
      ["drone"],
    );
  });

  it("tolerates malformed rosters", () => {
    assert.deepStrictEqual(buildAgentRows(null, {}), []);
    assert.deepStrictEqual(buildAgentRows({}, {}), []);
    assert.deepStrictEqual(buildAgentRows({ agents: "nope" }, {}), []);
  });
});

describe("relativeSpan()", () => {
  const NOW = 1_000_000_000;

  it("formats seconds, minutes, hours, and days", () => {
    assert.strictEqual(relativeSpan(NOW - 30 * 1000, NOW), "30s");
    assert.strictEqual(relativeSpan(NOW - 5 * 60 * 1000, NOW), "5m");
    assert.strictEqual(relativeSpan(NOW - 3 * 3600 * 1000, NOW), "3h");
    assert.strictEqual(relativeSpan(NOW - 2 * 86400 * 1000, NOW), "2d");
  });

  it("clamps future timestamps to zero", () => {
    assert.strictEqual(relativeSpan(NOW + 60 * 1000, NOW), "0s");
  });
});
