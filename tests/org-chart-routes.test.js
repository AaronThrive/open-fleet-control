/**
 * Route tests for GET/PUT /api/fleet/org-chart in src/fleet-routes.js.
 *
 * Mirrors the audit-coverage pattern: mocked fleet runtime + a REAL org
 * chart engine over a temp stateDir + fake req/res — no HTTP server. A
 * fixture roster documents the ownership contract: the chart references
 * roster agents by id but the server tolerates ids that disappeared (the
 * UI ghosts them), so PUT is never validated against the roster.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createFleetRoutes } = require("../src/fleet-routes");
const { createOrgChart } = require("../src/org-chart");

const USER = "owner@example.com";

// Fixture roster (what GET /api/agents would serve) — "vanished-agent" is
// deliberately absent to exercise orphan tolerance.
const FIXTURE_ROSTER = {
  hostname: "test-node",
  agents: [
    { id: "ceo-agent", name: "CEO", active: true },
    { id: "lead-marketing", name: "Marketing Lead", active: false },
    { id: "worker-1", name: "Worker One", active: true },
  ],
};

function makeFleet({ auditThrows = false, rateLimited = false } = {}) {
  const auditRecords = [];
  const fleet = {
    rateLimiter: {
      check: () => (rateLimited ? { allowed: false, retryAfterMs: 1234 } : { allowed: true }),
    },
    audit: {
      record: (entry) => {
        if (auditThrows) throw new Error("audit disk full");
        auditRecords.push(entry);
      },
    },
  };
  return { fleet, auditRecords };
}

function makeReq(method, body) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = { "tailscale-user-login": USER };
  req.socket = { remoteAddress: "127.0.0.1" };
  process.nextTick(() => {
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

function makeRes() {
  const res = { statusCode: null, body: null };
  res.writeHead = (code) => {
    res.statusCode = code;
  };
  res.end = (payload) => {
    res.body = payload ? JSON.parse(payload) : null;
  };
  return res;
}

async function call(routes, method, pathname, body) {
  const req = makeReq(method, body);
  const res = makeRes();
  await routes.handle(req, res, pathname, new URLSearchParams(""));
  return res;
}

function rosterTree() {
  const ids = FIXTURE_ROSTER.agents.map((a) => a.id);
  return {
    roots: [
      {
        agentId: ids[0],
        title: "CEO",
        children: [{ agentId: ids[1], title: "Lead — Marketing", children: [] }],
      },
    ],
    unassigned: [ids[2]],
  };
}

describe("org-chart routes", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofc-org-routes-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeRoutes(overrides = {}) {
    const stateDir = fs.mkdtempSync(path.join(tmpDir, "state-"));
    const mocks = makeFleet(overrides);
    const orgChart = createOrgChart({ stateDir });
    const routes = createFleetRoutes({
      fleet: mocks.fleet,
      orgChart,
      rosterFn: () => FIXTURE_ROSTER,
    });
    return { ...mocks, orgChart, routes, stateDir };
  }

  it("GET returns the empty default chart", async () => {
    const { routes } = makeRoutes();
    const res = await call(routes, "GET", "/api/fleet/org-chart");
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.version, 1);
    assert.deepStrictEqual(res.body.roots, []);
    assert.deepStrictEqual(res.body.unassigned, []);
  });

  it("PUT replaces the full tree, persists it, and audits org.update", async () => {
    const { routes, auditRecords, orgChart } = makeRoutes();

    const res = await call(routes, "PUT", "/api/fleet/org-chart", rosterTree());
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.chart.roots[0].agentId, "ceo-agent");
    assert.strictEqual(res.body.chart.roots[0].children[0].title, "Lead — Marketing");

    // Identity-attributed audit entry with counts only (no tree contents).
    assert.strictEqual(auditRecords.length, 1);
    assert.strictEqual(auditRecords[0].action, "org.update");
    assert.strictEqual(auditRecords[0].user, USER);
    assert.deepStrictEqual(auditRecords[0].detail, { roots: 1, unassigned: 1 });

    // Persisted: a fresh GET serves the replaced tree.
    const get = await call(routes, "GET", "/api/fleet/org-chart");
    assert.strictEqual(get.body.roots[0].children[0].agentId, "lead-marketing");
    assert.strictEqual(orgChart.getChart().unassigned[0], "worker-1");
  });

  it("PUT tolerates agentIds missing from the roster (ghost handling is UI-side)", async () => {
    const { routes } = makeRoutes();
    const tree = rosterTree();
    tree.roots[0].children.push({ agentId: "vanished-agent", title: null, children: [] });
    assert.ok(!FIXTURE_ROSTER.agents.some((a) => a.id === "vanished-agent"));

    const res = await call(routes, "PUT", "/api/fleet/org-chart", tree);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.chart.roots[0].children[1].agentId, "vanished-agent");
  });

  it("PUT rejects invalid trees with 400 and keeps the stored chart", async () => {
    const { routes, auditRecords } = makeRoutes();
    await call(routes, "PUT", "/api/fleet/org-chart", rosterTree());

    const dup = {
      roots: [
        { agentId: "ceo-agent", title: null, children: [] },
        { agentId: "ceo-agent", title: null, children: [] },
      ],
      unassigned: [],
    };
    const res = await call(routes, "PUT", "/api/fleet/org-chart", dup);
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /duplicate agentId/);

    const unknownField = {
      roots: [{ agentId: "ceo-agent", title: null, children: [], rank: 1 }],
      unassigned: [],
    };
    const res2 = await call(routes, "PUT", "/api/fleet/org-chart", unknownField);
    assert.strictEqual(res2.statusCode, 400);
    assert.match(res2.body.error, /unknown node field/);

    // Only the first (valid) PUT was audited; the stored chart is untouched.
    assert.strictEqual(auditRecords.filter((e) => e.action === "org.update").length, 1);
    const get = await call(routes, "GET", "/api/fleet/org-chart");
    assert.strictEqual(get.body.roots.length, 1);
  });

  it("PUT is rate-limited (429 with retryAfterMs) before any write", async () => {
    const { routes, auditRecords } = makeRoutes({ rateLimited: true });
    const res = await call(routes, "PUT", "/api/fleet/org-chart", rosterTree());
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(res.body.retryAfterMs, 1234);
    assert.strictEqual(auditRecords.length, 0);

    // GET stays unthrottled (read-only).
    const get = await call(routes, "GET", "/api/fleet/org-chart");
    assert.strictEqual(get.statusCode, 200);
  });

  it("PUT still succeeds when the audit write throws (best-effort contract)", async () => {
    const { routes, orgChart } = makeRoutes({ auditThrows: true });
    const res = await call(routes, "PUT", "/api/fleet/org-chart", rosterTree());
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(orgChart.getChart().roots[0].agentId, "ceo-agent");
  });

  it("responds 404 when the orgChart module is not wired", async () => {
    const { fleet } = makeFleet();
    const routes = createFleetRoutes({ fleet });
    const res = await call(routes, "GET", "/api/fleet/org-chart");
    assert.strictEqual(res.statusCode, 404);
  });

  it("responds 404 for unknown methods/subpaths", async () => {
    const { routes } = makeRoutes();
    assert.strictEqual((await call(routes, "DELETE", "/api/fleet/org-chart")).statusCode, 404);
    assert.strictEqual((await call(routes, "GET", "/api/fleet/org-chart/extra")).statusCode, 404);
  });
});
