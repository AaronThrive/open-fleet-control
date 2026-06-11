/**
 * Federation drill-down detail tests.
 *
 * The poller enriches each REACHABLE remote with a cached, trimmed detail
 * snapshot (mesh nodes + kanban board + recent alerts) via three additional
 * READ-ONLY GETs. Every sub-fetch is independently failure-tolerant: a dead
 * endpoint keeps that section's last-known value, a fully dead remote keeps
 * the whole cached detail, and nothing in the enrichment path can ever fail
 * the health poll. Remote HTTP is always faked via the injected fetchFn.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createFederation,
  extractRemoteMeshDetail,
  extractRemoteBoardDetail,
  extractRemoteAlertsDetail,
  MAX_DETAIL_NODES,
  MAX_DETAIL_TASKS,
  MAX_DETAIL_ALERTS,
} = require("../src/federation");

const REMOTE_URL = "https://atlas.test-tailnet.ts.net";

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

function remoteStateBody() {
  return {
    vitals: { hostname: "atlas" },
    fleet: {
      mesh: { nodes: 2, online: 1 },
      kanban: { counts: { inbox: 1 }, staleCount: 0 },
      evolution: { gate: true, pendingCount: 0 },
      alerts: { recent: 1 },
    },
  };
}

function remoteMeshBody() {
  return {
    nodes: [
      {
        id: "node-1",
        hostname: "hermes",
        label: "Hermes",
        port: 3334,
        health: { status: "online", latencyMs: 12, version: "1.8.0" },
        vitals: {
          uptime: "4 days",
          cpu: { percent: 21, load: 0.4, cores: 8 },
          memory: { pct: 55, used: 4, total: 8 },
          disk: { pct: 70, used: 70, free: 30, total: 100 },
        },
      },
      { id: "node-2", hostname: "watchtower", health: { status: "offline" }, vitals: null },
    ],
  };
}

function remoteKanbanBody() {
  return {
    version: 1,
    tasks: [
      {
        id: "tsk_b2",
        title: "Second",
        status: "inbox",
        assignee: null,
        priority: 2,
        order: 1,
        updated_at: "2026-06-10T00:00:00Z",
        stale: false,
      },
      {
        id: "tsk_a1",
        title: "First",
        status: "inbox",
        assignee: "smith",
        priority: 1,
        order: 0,
        updated_at: "2026-06-09T00:00:00Z",
        stale: true,
      },
      { id: "tsk_c3", title: "Doing", status: "inprogress", order: 0 },
      { id: "bad", title: "Unknown column", status: "limbo" },
      { title: "No id", status: "inbox" },
    ],
  };
}

function remoteAlertsBody() {
  return {
    alerts: [
      {
        ts: 1760000000000,
        type: "nodeOffline",
        severity: "warning",
        node: "watchtower",
        message: "watchtower went offline",
      },
    ],
    source: "memory",
  };
}

/** fetchFn that routes by URL path, with per-path overrides. */
function routedFetch(overrides = {}) {
  const log = [];
  const fetchFn = async (url, init) => {
    log.push({ url, init: init || {} });
    const urlPath = url.slice(REMOTE_URL.length);
    if (Object.prototype.hasOwnProperty.call(overrides, urlPath)) {
      const handler = overrides[urlPath];
      return typeof handler === "function" ? handler() : handler;
    }
    if (urlPath === "/api/state") return okResponse(remoteStateBody());
    if (urlPath === "/api/fleet/evolution") return okResponse({ lessons: [] });
    if (urlPath === "/api/fleet/mesh") return okResponse(remoteMeshBody());
    if (urlPath === "/api/fleet/kanban") return okResponse(remoteKanbanBody());
    if (urlPath.startsWith("/api/fleet/alerts")) return okResponse(remoteAlertsBody());
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchFn, log };
}

describe("federation drill-down detail", () => {
  let stateDir;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "federation-detail-test-"));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function makeFederation(overrides = {}, options = {}) {
    const { fetchFn, log } = routedFetch(overrides);
    const federation = createFederation({ stateDir, fetchFn, ...options });
    return { federation, log };
  }

  describe("polling + cache", () => {
    it("caches trimmed mesh/kanban/alerts detail for a reachable remote", async () => {
      const { federation } = makeFederation();
      const remote = federation.addRemote({ label: "Atlas", baseUrl: REMOTE_URL });
      await federation._pollOnce();

      const { detail, status } = federation.getRemoteDetail(remote.id);
      assert.strictEqual(status.reachable, true);
      assert.ok(detail);
      assert.ok(Number.isFinite(detail.fetchedAt));

      // Mesh nodes with vitals
      assert.strictEqual(detail.mesh.nodes.length, 2);
      const hermes = detail.mesh.nodes[0];
      assert.deepStrictEqual(hermes, {
        id: "node-1",
        hostname: "hermes",
        label: "Hermes",
        port: 3334,
        status: "online",
        latencyMs: 12,
        version: "1.8.0",
        vitals: { cpuPct: 21, memPct: 55, diskPct: 70, uptime: "4 days" },
      });
      assert.strictEqual(detail.mesh.nodes[1].status, "offline");
      assert.strictEqual(detail.mesh.nodes[1].vitals, null);

      // Kanban: per-column counts + cards sorted by column then order;
      // malformed tasks dropped (unknown status, missing id).
      assert.strictEqual(detail.kanban.counts.inbox, 2);
      assert.strictEqual(detail.kanban.counts.inprogress, 1);
      assert.strictEqual(detail.kanban.counts.done, 0);
      assert.deepStrictEqual(
        detail.kanban.tasks.map((t) => t.id),
        ["tsk_a1", "tsk_b2", "tsk_c3"],
      );
      assert.strictEqual(detail.kanban.tasks[0].assignee, "smith");
      assert.strictEqual(detail.kanban.tasks[0].stale, true);

      // Alerts trimmed
      assert.deepStrictEqual(detail.alerts.alerts, [
        {
          ts: 1760000000000,
          type: "nodeOffline",
          severity: "warning",
          node: "watchtower",
          message: "watchtower went offline",
        },
      ]);
    });

    it("forwards the bearer token on every detail GET and stays read-only", async () => {
      const { federation, log } = makeFederation();
      federation.addRemote({ label: "Atlas", baseUrl: REMOTE_URL, token: "tok-detail" });
      await new Promise((resolve) => setImmediate(resolve)); // initial probe
      await federation._pollOnce();

      // Initial probe + one poll cycle: 3 detail GETs each.
      const detailCalls = log.filter(({ url }) => /\/api\/fleet\/(mesh|kanban|alerts)/.test(url));
      assert.strictEqual(detailCalls.length, 6);
      for (const { init } of detailCalls) {
        assert.strictEqual(init.headers.Authorization, "Bearer tok-detail");
        assert.strictEqual((init.method || "GET").toUpperCase(), "GET");
      }
    });

    it("tolerates a single dead detail endpoint without losing the others", async () => {
      const { federation } = makeFederation({
        "/api/fleet/mesh": () => {
          throw new Error("connection refused");
        },
      });
      const remote = federation.addRemote({ label: "Atlas", baseUrl: REMOTE_URL });
      await federation._pollOnce();

      const { detail, status } = federation.getRemoteDetail(remote.id);
      assert.strictEqual(status.reachable, true); // health poll unaffected
      assert.strictEqual(detail.mesh, null);
      assert.ok(detail.kanban);
      assert.ok(detail.alerts);
    });

    it("keeps the last-known section when a detail endpoint starts failing", async () => {
      let meshDead = false;
      const { federation } = makeFederation({
        "/api/fleet/mesh": () =>
          meshDead
            ? { ok: false, status: 503, json: async () => ({}) }
            : okResponse(remoteMeshBody()),
      });
      const remote = federation.addRemote({ label: "Atlas", baseUrl: REMOTE_URL });
      await federation._pollOnce();

      meshDead = true;
      await federation._pollOnce();

      const { detail } = federation.getRemoteDetail(remote.id);
      assert.strictEqual(detail.mesh.nodes.length, 2); // last-known survives
    });

    it("degrades to the existing summary when the whole remote dies — never throws", async () => {
      let dead = false;
      const { fetchFn } = routedFetch();
      const federation = createFederation({
        stateDir,
        fetchFn: async (url, init) => {
          if (dead) throw new Error("ECONNREFUSED");
          return fetchFn(url, init);
        },
      });
      const remote = federation.addRemote({ label: "Atlas", baseUrl: REMOTE_URL });
      await federation._pollOnce();

      dead = true;
      await federation._pollOnce(); // must not throw

      const entry = federation.getState().remotes.find((r) => r.id === remote.id);
      assert.strictEqual(entry.status.reachable, false);
      assert.deepStrictEqual(entry.status.summary.mesh, { nodes: 2, online: 1 }); // summary tile intact
      // Cached detail survives the outage for the drill-down.
      const { detail } = federation.getRemoteDetail(remote.id);
      assert.ok(detail);
      assert.strictEqual(detail.kanban.tasks.length, 3);
    });

    it("never caches detail for a remote that has never responded", async () => {
      const { federation } = makeFederation(
        {},
        {
          fetchFn: async () => {
            throw new Error("ECONNREFUSED");
          },
        },
      );
      const remote = federation.addRemote({ label: "Dead", baseUrl: REMOTE_URL });
      await federation._pollOnce();
      assert.strictEqual(federation.getRemoteDetail(remote.id).detail, null);
    });

    it("getState() stays a compact summary — no detail blocks", async () => {
      const { federation } = makeFederation();
      const remote = federation.addRemote({ label: "Atlas", baseUrl: REMOTE_URL });
      await federation._pollOnce();
      const entry = federation.getState().remotes.find((r) => r.id === remote.id);
      assert.strictEqual(entry.detail, undefined);
      assert.strictEqual(entry.status.detail, undefined);
    });
  });

  describe("getRemoteDetail() / getBoardSources()", () => {
    it("throws Unknown remote on a bad id (maps to 404)", () => {
      const { federation } = makeFederation();
      assert.throws(() => federation.getRemoteDetail("nope"), /Unknown remote/);
    });

    it("redacts the token everywhere", async () => {
      const { federation } = makeFederation();
      const remote = federation.addRemote({
        label: "Atlas",
        baseUrl: REMOTE_URL,
        token: "secret",
      });
      await federation._pollOnce();

      const detail = federation.getRemoteDetail(remote.id);
      assert.strictEqual(detail.remote.token, undefined);
      assert.strictEqual(detail.remote.hasToken, true);
      for (const source of federation.getBoardSources()) {
        assert.strictEqual(source.remote.token, undefined);
      }
    });

    it("getBoardSources lists every remote, including dead ones without data", async () => {
      const { fetchFn } = routedFetch();
      const federation = createFederation({
        stateDir,
        fetchFn: async (url, init) => {
          if (url.startsWith("https://dead.")) throw new Error("ECONNREFUSED");
          return fetchFn(url, init);
        },
      });
      const up = federation.addRemote({ label: "Atlas", baseUrl: REMOTE_URL, allowWrites: true });
      const down = federation.addRemote({ label: "Ghost", baseUrl: "https://dead.ts.net" });
      await federation._pollOnce();

      const sources = federation.getBoardSources();
      assert.strictEqual(sources.length, 2);
      const upSource = sources.find((s) => s.remote.id === up.id);
      const downSource = sources.find((s) => s.remote.id === down.id);
      assert.strictEqual(upSource.reachable, true);
      assert.strictEqual(upSource.remote.allowWrites, true);
      assert.strictEqual(upSource.detail.kanban.tasks.length, 3);
      assert.strictEqual(downSource.reachable, false);
      assert.strictEqual(downSource.detail, null);
    });

    it("removeRemote drops the cached detail", async () => {
      const { federation } = makeFederation();
      const remote = federation.addRemote({ label: "Atlas", baseUrl: REMOTE_URL });
      await federation._pollOnce();
      federation.removeRemote(remote.id);
      assert.strictEqual(federation.getBoardSources().length, 0);
      assert.throws(() => federation.getRemoteDetail(remote.id), /Unknown remote/);
    });
  });

  describe("extraction tolerance + caps", () => {
    it("extractRemoteMeshDetail returns null on junk and caps the node list", () => {
      assert.strictEqual(extractRemoteMeshDetail(null), null);
      assert.strictEqual(extractRemoteMeshDetail({}), null);
      assert.strictEqual(extractRemoteMeshDetail({ nodes: "nope" }), null);

      const many = { nodes: Array.from({ length: 100 }, (_, i) => ({ id: `n${i}` })) };
      assert.strictEqual(extractRemoteMeshDetail(many).nodes.length, MAX_DETAIL_NODES);

      const [node] = extractRemoteMeshDetail({ nodes: [{ hostname: "x" }] }).nodes;
      assert.strictEqual(node.status, "unknown");
      assert.strictEqual(node.vitals, null);
      assert.strictEqual(node.latencyMs, null);
    });

    it("extractRemoteBoardDetail returns null on junk and caps the task list", () => {
      assert.strictEqual(extractRemoteBoardDetail(null), null);
      assert.strictEqual(extractRemoteBoardDetail({ tasks: {} }), null);

      const many = {
        tasks: Array.from({ length: 300 }, (_, i) => ({
          id: `tsk_${i}`,
          title: `T${i}`,
          status: "inbox",
          order: i,
        })),
      };
      const board = extractRemoteBoardDetail(many);
      assert.strictEqual(board.tasks.length, MAX_DETAIL_TASKS);
      assert.strictEqual(board.counts.inbox, 300); // counts reflect the full board
    });

    it("extractRemoteAlertsDetail returns null on junk and caps the list", () => {
      assert.strictEqual(extractRemoteAlertsDetail(null), null);
      assert.strictEqual(extractRemoteAlertsDetail({ alerts: 7 }), null);

      const many = { alerts: Array.from({ length: 50 }, () => ({ type: "x" })) };
      assert.strictEqual(extractRemoteAlertsDetail(many).alerts.length, MAX_DETAIL_ALERTS);
    });
  });
});
