/**
 * Tests for the pure (DOM-free) helpers used by the Federation detail-list
 * view. The module is browser ESM, so it is loaded via dynamic import.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert");

let toRemoteRow;
let sumTaskCounts;
let baseUrlHost;

before(async () => {
  const mod = await import("../public/js/views/federation.js");
  toRemoteRow = mod.toRemoteRow;
  sumTaskCounts = mod.sumTaskCounts;
  baseUrlHost = mod.baseUrlHost;
});

const REACHABLE_REMOTE = {
  id: "11111111-2222-3333-4444-555555555555",
  label: "Hermes",
  baseUrl: "https://hermes.tailnet.ts.net",
  allowWrites: true,
  hasToken: true,
  status: {
    reachable: true,
    lastChecked: 1760000000000,
    lastError: null,
    latencyMs: 42.7,
    summary: {
      hostname: "hermes-agent-1",
      mesh: { nodes: 3, online: 2 },
      kanban: { counts: { inbox: 2, inprogress: 1, done: 4 }, staleCount: 0 },
      evolution: { gate: true, pendingCount: 2 },
      alerts: { recent: 1 },
    },
    pendingLessons: [{ id: "les_a1", title: "L", author: "x", ts: "" }],
  },
};

describe("baseUrlHost()", () => {
  it("extracts host (and port) from a base URL", () => {
    assert.strictEqual(baseUrlHost("https://hermes.tailnet.ts.net"), "hermes.tailnet.ts.net");
    assert.strictEqual(baseUrlHost("http://localhost:3334"), "localhost:3334");
  });

  it("falls back to the raw string on unparseable input", () => {
    assert.strictEqual(baseUrlHost("not a url"), "not a url");
    assert.strictEqual(baseUrlHost(null), "");
  });
});

describe("sumTaskCounts()", () => {
  it("sums finite per-status counts", () => {
    assert.strictEqual(sumTaskCounts({ inbox: 2, inprogress: 1, done: 4 }), 7);
  });

  it("ignores non-finite values", () => {
    assert.strictEqual(sumTaskCounts({ inbox: 2, junk: "x", nope: NaN }), 2);
  });

  it("returns null for empty or non-object input", () => {
    assert.strictEqual(sumTaskCounts(null), null);
    assert.strictEqual(sumTaskCounts("nope"), null);
    assert.strictEqual(sumTaskCounts({}), null);
  });
});

describe("toRemoteRow()", () => {
  it("flattens a reachable remote onto sortable/filterable row keys", () => {
    const row = toRemoteRow(REACHABLE_REMOTE);
    assert.strictEqual(row.id, REACHABLE_REMOTE.id);
    assert.strictEqual(row.label, "Hermes");
    assert.strictEqual(row.host, "hermes.tailnet.ts.net");
    assert.strictEqual(row.hostname, "hermes-agent-1");
    assert.strictEqual(row.reachable, "reachable");
    assert.strictEqual(row.writes, true);
    assert.strictEqual(row.latencyMs, 42.7);
    assert.strictEqual(row.lastChecked, 1760000000000);
    assert.strictEqual(row.nodes, "2/3");
    assert.strictEqual(row.tasks, 7);
    assert.strictEqual(row.pending, 2);
    assert.strictEqual(row.remote, REACHABLE_REMOTE);
    assert.strictEqual(row.status, REACHABLE_REMOTE.status);
    assert.strictEqual(row.summary, REACHABLE_REMOTE.status.summary);
  });

  it("marks never-checked remotes as unknown and missing data as null/—", () => {
    const row = toRemoteRow({
      id: "u1",
      label: "Fresh",
      baseUrl: "https://fresh.ts.net",
      allowWrites: false,
    });
    assert.strictEqual(row.reachable, "unknown");
    assert.strictEqual(row.writes, false);
    assert.strictEqual(row.latencyMs, null);
    assert.strictEqual(row.lastChecked, null);
    assert.strictEqual(row.nodes, "—");
    assert.strictEqual(row.tasks, null);
    assert.strictEqual(row.pending, null);
    assert.strictEqual(row.summary, null);
  });

  it("marks failing remotes as unreachable but keeps the last summary", () => {
    const row = toRemoteRow({
      ...REACHABLE_REMOTE,
      allowWrites: false,
      status: { ...REACHABLE_REMOTE.status, reachable: false, lastError: "HTTP 502" },
    });
    assert.strictEqual(row.reachable, "unreachable");
    assert.strictEqual(row.writes, false);
    assert.strictEqual(row.nodes, "2/3");
    assert.strictEqual(row.tasks, 7);
  });

  it("tolerates a summary without mesh/kanban/evolution blocks", () => {
    const row = toRemoteRow({
      id: "p1",
      label: "Partial",
      baseUrl: "https://partial.ts.net",
      status: { reachable: true, summary: { hostname: null } },
    });
    assert.strictEqual(row.nodes, "—");
    assert.strictEqual(row.tasks, null);
    assert.strictEqual(row.pending, null);
    assert.strictEqual(row.hostname, "");
  });
});
