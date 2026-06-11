/**
 * End-to-end verification of the two-way federation write-enable path that
 * the kanban relies on, using the REAL federation module behind the REAL
 * fleet routes (only the remote dashboard + fleet runtime shell are faked):
 *
 *   1. POST   /api/fleet/federation/remotes          → registers read-only
 *   2. POST   .../actions task.move                  → 403 (writes off)
 *   3. PATCH  /api/fleet/federation/remotes/:id      → allowWrites: true
 *   4. GET    /api/fleet/federation/board            → origin writable: true
 *   5. POST   .../actions task.move                  → proxied to the remote
 *      /api/fleet/kanban/tasks/:id/move with the forwarded operator identity
 *
 * Every mutating hop must consume a rate-limit token and write an audit
 * entry — the same guarantees the rest of the mutating surface has.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createFleetRoutes } = require("../src/fleet-routes");
const { createFederation } = require("../src/federation");

const REMOTE_BASE = "http://localhost:3334";
const REMOTE_TASK_ID = "tsk_abc123";
const OPERATOR = "aaron@example.com";

// ---------------------------------------------------------------------------
// Fake remote dashboard (hermes) — answers the federation module's GETs and
// records every request so the proxy path can be asserted end-to-end.
// ---------------------------------------------------------------------------

const remoteRequests = [];

function jsonResponse(body, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

async function fakeRemoteFetch(url, options = {}) {
  remoteRequests.push({ url, method: options.method || "GET", headers: options.headers || {} });
  const pathname = new URL(url).pathname;
  if (pathname === "/api/state") {
    return jsonResponse({
      vitals: { hostname: "hermes-agent-1" },
      fleet: {
        mesh: { nodes: 1, online: 1 },
        kanban: { counts: { inbox: 1 }, staleCount: 0 },
        evolution: { gate: true, pendingCount: 0 },
        alerts: { recent: 0 },
      },
    });
  }
  if (pathname === "/api/fleet/evolution") return jsonResponse({ lessons: [] });
  if (pathname === "/api/fleet/mesh") return jsonResponse({ nodes: [] });
  if (pathname === "/api/fleet/kanban") {
    return jsonResponse({
      tasks: [{ id: REMOTE_TASK_ID, title: "Remote work", status: "inbox", order: 0 }],
    });
  }
  if (pathname === "/api/fleet/alerts") return jsonResponse({ alerts: [] });
  if (pathname === `/api/fleet/kanban/tasks/${REMOTE_TASK_ID}/move`) {
    return jsonResponse({ success: true });
  }
  return jsonResponse({ error: "not found" }, 404);
}

// ---------------------------------------------------------------------------
// Fake req/res (mirrors the dispatch-routes harness, plus JSON bodies)
// ---------------------------------------------------------------------------

function makeReq(method, body) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = { "tailscale-user-login": OPERATOR };
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

describe("federation two-way write-enable flow (routes + real federation)", () => {
  let tmpDir;
  let federation;
  let routes;
  let auditRecords;
  let rateChecks;
  let remoteId;

  async function call(method, pathname, body) {
    const req = makeReq(method, body);
    const res = makeRes();
    await routes.handle(req, res, pathname, new URLSearchParams(""));
    return res;
  }

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofc-fed-write-flow-"));
    auditRecords = [];
    rateChecks = [];
    federation = createFederation({ stateDir: tmpDir, fetchFn: fakeRemoteFetch });
    const fleet = {
      rateLimiter: {
        check: (key) => {
          rateChecks.push(key);
          return { allowed: true };
        },
      },
      audit: { record: (entry) => auditRecords.push(entry) },
      kanban: { getBoard: () => ({ version: 1, tasks: [] }) },
      federation,
    };
    routes = createFleetRoutes({ fleet });
  });

  after(() => {
    federation.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers the remote read-only by default", async () => {
    const res = await call("POST", "/api/fleet/federation/remotes", {
      label: "Hermes",
      baseUrl: REMOTE_BASE,
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.remote.allowWrites, false);
    remoteId = res.body.remote.id;

    // Deterministic poll so the board has cached remote detail.
    await federation._pollOnce();
    const board = await call("GET", "/api/fleet/federation/board");
    const origin = board.body.origins.find((o) => o.key === remoteId);
    assert.strictEqual(origin.writable, false);
    assert.strictEqual(origin.reachable, true);
    assert.ok(board.body.tasks.some((t) => t.id === REMOTE_TASK_ID && t.origin === remoteId));
  });

  it("rejects task.move with 403 while writes are off — remote never contacted", async () => {
    const writesBefore = remoteRequests.filter((r) => r.method !== "GET").length;
    const res = await call("POST", `/api/fleet/federation/remotes/${remoteId}/actions`, {
      action: "task.move",
      params: { taskId: REMOTE_TASK_ID, status: "inprogress" },
    });
    assert.strictEqual(res.statusCode, 403);
    assert.match(res.body.error, /Write actions are disabled/);
    assert.strictEqual(
      remoteRequests.filter((r) => r.method !== "GET").length,
      writesBefore,
      "no non-GET request may reach the remote while allowWrites is off",
    );
  });

  it("PATCH allowWrites:true flips the remote writable (rate-limited + audited)", async () => {
    const checksBefore = rateChecks.length;
    const res = await call("PATCH", `/api/fleet/federation/remotes/${remoteId}`, {
      allowWrites: true,
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.remote.allowWrites, true);
    assert.strictEqual(res.body.remote.token, undefined, "token must stay redacted");
    assert.ok(rateChecks.length > checksBefore, "PATCH must consume a rate-limit token");

    const audit = auditRecords.find(
      (e) => e.detail && e.detail.kind === "federation" && e.detail.change === "allowWrites",
    );
    assert.ok(audit, "PATCH must write an audit entry");
    assert.strictEqual(audit.user, OPERATOR);
    assert.strictEqual(audit.detail.allowWrites, true);

    const board = await call("GET", "/api/fleet/federation/board");
    const origin = board.body.origins.find((o) => o.key === remoteId);
    assert.strictEqual(origin.writable, true, "board origin must turn writable after the PATCH");
  });

  it("rejects non-boolean allowWrites with 400", async () => {
    const res = await call("PATCH", `/api/fleet/federation/remotes/${remoteId}`, {
      allowWrites: "yes",
    });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /boolean 'allowWrites'/);
  });

  it("proxies task.move to the remote kanban with the forwarded identity", async () => {
    const res = await call("POST", `/api/fleet/federation/remotes/${remoteId}/actions`, {
      action: "task.move",
      params: { taskId: REMOTE_TASK_ID, status: "inprogress" },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.result.ok, true);
    assert.strictEqual(res.body.result.remoteStatus, 200);

    const proxied = remoteRequests.find((r) => r.method === "POST");
    assert.ok(proxied, "the move must reach the remote as a POST");
    assert.strictEqual(
      new URL(proxied.url).pathname,
      `/api/fleet/kanban/tasks/${REMOTE_TASK_ID}/move`,
    );
    assert.strictEqual(
      proxied.headers["Tailscale-User-Login"],
      OPERATOR,
      "the LOCAL operator identity must be forwarded for the remote audit trail",
    );

    const audit = auditRecords.find(
      (e) => e.action === "task.move" && e.detail && e.detail.kind === "federation-proxy",
    );
    assert.ok(audit, "the proxied move must be audited locally");
    assert.strictEqual(audit.target, REMOTE_TASK_ID);
    assert.strictEqual(audit.detail.remote, remoteId);
  });

  it("persists allowWrites across a module reload (config survives restart)", async () => {
    const reloaded = createFederation({ stateDir: tmpDir, fetchFn: fakeRemoteFetch });
    const state = reloaded.getState();
    const remote = state.remotes.find((r) => r.id === remoteId);
    assert.strictEqual(remote.allowWrites, true);
    reloaded.stop();
  });
});
