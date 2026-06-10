/**
 * Integration tests for the /api/fleet/* routes.
 *
 * Boots the real bundled server (lib/server.js) on an ephemeral port with
 * FLEET_CONFIG_JSON pointing all fleet directories at a temp dir, then
 * exercises the REST surface end-to-end: mesh registry + audit trail, chat
 * publish/query, kanban lifecycle + /api/state fleet summary, briefs CRUD +
 * traversal rejection, evolution gate/approve flow, audit queries, and the
 * per-user rate limit (429 envelope). The rate-limit test runs LAST because
 * it drains the shared token bucket.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const TEST_PORT = 10000 + Math.floor(Math.random() * 50000);
const BASE = `http://localhost:${TEST_PORT}`;
const RATE_LIMIT_MAX = 20;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofc-fleet-routes-"));
const fleetConfig = {
  stateDir: path.join(tmpDir, "state"),
  logsDir: path.join(tmpDir, "logs"),
  briefsDir: path.join(tmpDir, "briefs"),
  workspaceDir: path.join(tmpDir, "workspace"),
  mesh: { intervalMs: 60000 },
  // Never shell out to external CLIs (openclaw memory-pro / gbrain) in tests
  cortex: { enabled: false },
  rateLimit: { windowMs: 60000, max: RATE_LIMIT_MAX },
};

function request(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      `${BASE}${urlPath}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch (e) {
            // Non-JSON body — leave parsed null, expose raw
          }
          resolve({ status: res.statusCode, body: parsed, raw: data });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("fleet routes", () => {
  let serverProcess;

  before(async () => {
    serverProcess = spawn(process.execPath, [path.join(__dirname, "..", "lib", "server.js")], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        FLEET_CONFIG_JSON: JSON.stringify(fleetConfig),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const maxWait = 15000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      try {
        await request("GET", "/api/health");
        return;
      } catch (e) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw new Error(`Server did not start within ${maxWait}ms`);
  });

  after(() => {
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
      serverProcess = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------
  // Mesh + audit trail
  // -------------------------------------------------------------------

  it("rejects an invalid node registration with 400", async () => {
    const res = await request("POST", "/api/fleet/mesh/nodes", { hostname: "Bad Host!" });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /hostname/i);
  });

  it("registers a node and writes an audit line", async () => {
    const res = await request(
      "POST",
      "/api/fleet/mesh/nodes",
      { hostname: "drone-1", platform: "linux" },
      { "Tailscale-User-Login": "tester@example.com" },
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.node.id, "node should get an id");
    assert.strictEqual(res.body.node.registeredBy, "tester@example.com");

    const auditFile = path.join(fleetConfig.logsDir, "audit.jsonl");
    const lines = fs
      .readFileSync(auditFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const entry = lines.find((l) => l.action === "node.register");
    assert.ok(entry, "audit.jsonl should contain a node.register entry");
    assert.strictEqual(entry.user, "tester@example.com");
    assert.strictEqual(entry.target, "drone-1");
  });

  it("rejects a duplicate node registration", async () => {
    const res = await request("POST", "/api/fleet/mesh/nodes", { hostname: "drone-1" });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /already registered/i);
  });

  it("returns mesh state including the registered node", async () => {
    const res = await request("GET", "/api/fleet/mesh");
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.nodes));
    assert.ok(res.body.nodes.some((n) => n.hostname === "drone-1"));
  });

  // -------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------

  it("publishes a chat message and queries it back", async () => {
    const publish = await request("POST", "/api/fleet/chat/publish", {
      sender: "scout-1",
      receiver: "overlord",
      payload: "zerg rush detected",
    });
    assert.strictEqual(publish.status, 200);
    assert.ok(publish.body.message.id.startsWith("msg_"));

    const query = await request("GET", "/api/fleet/chat?sender=scout-1&text=rush");
    assert.strictEqual(query.status, 200);
    assert.strictEqual(query.body.messages.length, 1);
    assert.strictEqual(query.body.messages[0].payload, "zerg rush detected");
  });

  it("rejects a chat message without a receiver", async () => {
    const res = await request("POST", "/api/fleet/chat/publish", {
      sender: "scout-1",
      payload: "lost",
    });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /receiver/i);
  });

  // -------------------------------------------------------------------
  // Kanban + /api/state fleet summary
  // -------------------------------------------------------------------

  it("creates and moves a kanban task over HTTP", async () => {
    const created = await request("POST", "/api/fleet/kanban/tasks", {
      title: "Integrate fleet routes",
    });
    assert.strictEqual(created.status, 200);
    const taskId = created.body.task.id;
    assert.match(taskId, /^tsk_/);
    assert.strictEqual(created.body.task.status, "inbox");

    const moved = await request("POST", `/api/fleet/kanban/tasks/${taskId}/move`, {
      status: "inprogress",
      order: 0,
    });
    assert.strictEqual(moved.status, 200);
    assert.strictEqual(moved.body.task.status, "inprogress");

    const board = await request("GET", "/api/fleet/kanban");
    assert.strictEqual(board.status, 200);
    const task = board.body.tasks.find((t) => t.id === taskId);
    assert.strictEqual(task.status, "inprogress");
  });

  it("reflects fleet counts in the /api/state summary", async () => {
    const res = await request("GET", "/api/state");
    assert.strictEqual(res.status, 200);
    const fleet = res.body.fleet;
    assert.ok(fleet, "/api/state should include a fleet summary");
    assert.strictEqual(fleet.mesh.nodes, 1);
    assert.strictEqual(fleet.kanban.counts.inprogress, 1);
    assert.strictEqual(typeof fleet.kanban.staleCount, "number");
    assert.ok(fleet.chat.total >= 1);
    assert.strictEqual(typeof fleet.evolution.gate, "boolean");
    assert.ok(fleet.cortex.availability, "summary should include cortex availability");
    assert.strictEqual(fleet.cortex.availability.memory, false);
    assert.strictEqual(typeof fleet.alerts.recent, "number");
  });

  // -------------------------------------------------------------------
  // Briefs
  // -------------------------------------------------------------------

  it("writes, reads, and deletes a brief", async () => {
    const put = await request("PUT", "/api/fleet/briefs/sop-deploy.md", {
      content: "# Deploy SOP\n\nStep one.",
    });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(put.body.brief.name, "sop-deploy.md");

    const list = await request("GET", "/api/fleet/briefs");
    assert.ok(list.body.briefs.some((b) => b.name === "sop-deploy.md"));

    const get = await request("GET", "/api/fleet/briefs/sop-deploy.md");
    assert.strictEqual(get.status, 200);
    assert.match(get.body.content, /Deploy SOP/);

    const del = await request("DELETE", "/api/fleet/briefs/sop-deploy.md");
    assert.strictEqual(del.status, 200);

    const gone = await request("GET", "/api/fleet/briefs/sop-deploy.md");
    assert.strictEqual(gone.status, 404);
  });

  it("rejects a path-traversal brief name with 4xx", async () => {
    const res = await request("PUT", "/api/fleet/briefs/..%2Fpwned.md", { content: "evil" });
    assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
    assert.ok(!fs.existsSync(path.join(tmpDir, "pwned.md")), "traversal must not write a file");
  });

  // -------------------------------------------------------------------
  // Evolution gate + approve flow
  // -------------------------------------------------------------------

  it("sets the gate, adds a pending lesson, and approves it", async () => {
    const gate = await request("PUT", "/api/fleet/evolution/gate", { gate: true });
    assert.strictEqual(gate.status, 200);
    assert.strictEqual(gate.body.gate, true);

    const added = await request("POST", "/api/fleet/evolution/lessons", {
      title: "Always run the watchdog",
      body: "Stale tasks hide failures.",
    });
    assert.strictEqual(added.status, 200);
    assert.strictEqual(added.body.lesson.status, "pending");
    const lessonId = added.body.lesson.id;

    const state = await request("GET", "/api/fleet/evolution");
    assert.strictEqual(state.status, 200);
    assert.ok(state.body.pending.some((p) => p.id === lessonId));
    assert.ok(state.body.lessons.some((l) => l.id === lessonId));

    const approved = await request("POST", `/api/fleet/evolution/lessons/${lessonId}/approve`);
    assert.strictEqual(approved.status, 200);
    assert.strictEqual(approved.body.lesson.status, "approved");

    // Approving twice conflicts (no longer pending)
    const again = await request("POST", `/api/fleet/evolution/lessons/${lessonId}/approve`);
    assert.strictEqual(again.status, 409);
  });

  // -------------------------------------------------------------------
  // Audit + alerts endpoints
  // -------------------------------------------------------------------

  it("queries the audit trail over HTTP", async () => {
    const res = await request("GET", "/api/fleet/audit?action=node.register");
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.entries.length >= 1);
    assert.strictEqual(res.body.entries[0].action, "node.register");

    const bad = await request("GET", "/api/fleet/audit?action=not.an.action");
    assert.strictEqual(bad.status, 400);
  });

  it("serves recent alerts (empty by default)", async () => {
    const res = await request("GET", "/api/fleet/alerts");
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.alerts));
  });

  it("returns a 404 envelope for unknown fleet routes", async () => {
    const res = await request("GET", "/api/fleet/nope");
    assert.strictEqual(res.status, 404);
    assert.match(res.body.error, /Unknown fleet route/);
  });

  // -------------------------------------------------------------------
  // Rate limiting — LAST: drains the shared per-user token bucket
  // -------------------------------------------------------------------

  it("rate limits mutating routes with a 429 + retryAfterMs envelope", async () => {
    let limited = null;
    for (let i = 0; i < RATE_LIMIT_MAX * 3 && !limited; i++) {
      const res = await request("POST", "/api/fleet/chat/publish", {
        sender: "spammer",
        receiver: "overlord",
        payload: `spam ${i}`,
      });
      if (res.status === 429) limited = res;
    }
    assert.ok(limited, "expected a 429 after exceeding the rate limit");
    assert.match(limited.body.error, /rate limit/i);
    assert.strictEqual(typeof limited.body.retryAfterMs, "number");
    assert.ok(limited.body.retryAfterMs > 0);
  });
});
