/**
 * Unit tests for the federation drill-down + fleet board routes in
 * src/fleet-routes.js:
 *   GET /api/fleet/federation/remotes/:id/detail   (cached drill-down)
 *   GET /api/fleet/federation/board                (unified fleet board)
 *
 * Mirrors the dispatch-routes pattern: mocked fleet runtime + fake req/res —
 * no HTTP server, no real federation polling. Both routes are READ-ONLY:
 * they must consume no rate-limit token and write no audit entry.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { createFleetRoutes } = require("../src/fleet-routes");

const REMOTE_ID = "11111111-2222-3333-4444-555555555555";

function localTask(overrides = {}) {
  return {
    id: "tsk_local1",
    title: "Local work",
    status: "inprogress",
    assignee: "aaron",
    priority: 1,
    order: 0,
    description: "should be trimmed away",
    comments: [{ author: "x", text: "trimmed" }],
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-10T00:00:00Z",
    stale: false,
    ...overrides,
  };
}

function remoteSource(overrides = {}) {
  return {
    remote: {
      id: REMOTE_ID,
      label: "Hermes",
      baseUrl: "http://localhost:3334",
      allowWrites: false,
      hasToken: false,
      ...(overrides.remote || {}),
    },
    reachable: overrides.reachable !== undefined ? overrides.reachable : true,
    detail:
      overrides.detail !== undefined
        ? overrides.detail
        : {
            mesh: { nodes: [] },
            kanban: {
              counts: { inbox: 1, assigned: 0, inprogress: 0, review: 0, done: 0, failed: 0 },
              tasks: [
                {
                  id: "tsk_rem1",
                  title: "Remote work",
                  status: "inbox",
                  assignee: null,
                  priority: 2,
                  order: 0,
                  updated_at: "2026-06-09T00:00:00Z",
                  stale: false,
                },
              ],
            },
            alerts: { alerts: [] },
            fetchedAt: 1760000000000,
          },
  };
}

function makeFleet({ sources = [remoteSource()], tasks = [localTask()] } = {}) {
  const auditRecords = [];
  const rateChecks = [];
  const fleet = {
    rateLimiter: {
      check: (key) => {
        rateChecks.push(key);
        return { allowed: true };
      },
    },
    audit: { record: (entry) => auditRecords.push(entry) },
    kanban: { getBoard: () => ({ version: 1, tasks }) },
    federation: {
      getBoardSources: () => sources,
      getRemoteDetail: (id) => {
        const source = sources.find((s) => s.remote.id === id);
        if (!source) throw new Error(`Unknown remote: ${id}`);
        return {
          remote: source.remote,
          status: { reachable: source.reachable },
          detail: source.detail,
        };
      },
    },
  };
  return { fleet, auditRecords, rateChecks };
}

function makeReq(method) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = { "tailscale-user-login": "tester@example.com" };
  req.socket = { remoteAddress: "127.0.0.1" };
  process.nextTick(() => req.emit("end"));
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

async function call(routes, method, pathname) {
  const req = makeReq(method);
  const res = makeRes();
  await routes.handle(req, res, pathname, new URLSearchParams(""));
  return res;
}

describe("federation board + detail routes", () => {
  describe("GET /api/fleet/federation/board", () => {
    it("merges local + remote cards, each labeled with its origin", async () => {
      const { fleet } = makeFleet();
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "GET", "/api/fleet/federation/board");

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.body.columns, [
        "inbox",
        "assigned",
        "inprogress",
        "review",
        "done",
        "failed",
      ]);

      const local = res.body.tasks.find((t) => t.id === "tsk_local1");
      const remote = res.body.tasks.find((t) => t.id === "tsk_rem1");
      assert.strictEqual(local.origin, "local");
      assert.strictEqual(remote.origin, REMOTE_ID);
      // Local tasks are trimmed to the shared card shape.
      assert.strictEqual(local.description, undefined);
      assert.strictEqual(local.comments, undefined);
      assert.strictEqual(local.title, "Local work");
      assert.strictEqual(local.assignee, "aaron");
    });

    it("flags origin writability from the remote's allowWrites opt-in", async () => {
      const writable = remoteSource({ remote: { allowWrites: true } });
      const { fleet } = makeFleet({ sources: [writable] });
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "GET", "/api/fleet/federation/board");

      const localOrigin = res.body.origins.find((o) => o.key === "local");
      const remoteOrigin = res.body.origins.find((o) => o.key === REMOTE_ID);
      assert.strictEqual(localOrigin.writable, true);
      assert.strictEqual(localOrigin.kind, "local");
      assert.strictEqual(remoteOrigin.writable, true);
      assert.strictEqual(remoteOrigin.kind, "remote");
    });

    it("includes dead remotes as origins with no tasks (degrades, never throws)", async () => {
      const dead = remoteSource({ reachable: false, detail: null });
      const { fleet } = makeFleet({ sources: [dead] });
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "GET", "/api/fleet/federation/board");

      assert.strictEqual(res.statusCode, 200);
      const origin = res.body.origins.find((o) => o.key === REMOTE_ID);
      assert.strictEqual(origin.reachable, false);
      assert.strictEqual(origin.hasData, false);
      assert.strictEqual(origin.writable, false);
      assert.deepStrictEqual(
        res.body.tasks.map((t) => t.origin),
        ["local"],
      );
    });

    it("is read-only: no rate-limit token, no audit entry", async () => {
      const { fleet, auditRecords, rateChecks } = makeFleet();
      const routes = createFleetRoutes({ fleet });
      await call(routes, "GET", "/api/fleet/federation/board");
      assert.strictEqual(rateChecks.length, 0);
      assert.strictEqual(auditRecords.length, 0);
    });
  });

  describe("GET /api/fleet/federation/remotes/:id/detail", () => {
    it("returns the cached drill-down snapshot", async () => {
      const { fleet } = makeFleet();
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "GET", `/api/fleet/federation/remotes/${REMOTE_ID}/detail`);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.remote.id, REMOTE_ID);
      assert.strictEqual(res.body.detail.kanban.tasks.length, 1);
    });

    it("404s on an unknown remote id", async () => {
      const { fleet } = makeFleet();
      const routes = createFleetRoutes({ fleet });
      const res = await call(routes, "GET", "/api/fleet/federation/remotes/nope/detail");
      assert.strictEqual(res.statusCode, 404);
      assert.match(res.body.error, /Unknown remote/);
    });

    it("is read-only: no rate-limit token, no audit entry", async () => {
      const { fleet, auditRecords, rateChecks } = makeFleet();
      const routes = createFleetRoutes({ fleet });
      await call(routes, "GET", `/api/fleet/federation/remotes/${REMOTE_ID}/detail`);
      assert.strictEqual(rateChecks.length, 0);
      assert.strictEqual(auditRecords.length, 0);
    });
  });
});
