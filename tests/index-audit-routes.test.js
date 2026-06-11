/**
 * Integration tests for the audit coverage of the legacy (non-fleet) routes
 * in src/index.js:
 *   POST /api/cerebro/topic/:id/status → topic.status
 *   GET  /api/action?action=...        → action.execute
 *   POST /api/operators                → operator.save
 *
 * Boots the real bundled server (lib/server.js) with HOME + cerebro dir
 * pointed at a temp tree so no real OpenClaw data is touched, then asserts
 * the entries in logs/audit.jsonl (actor passthrough via the
 * Tailscale-User-Login header).
 *
 * A second server boots with logs/audit.jsonl pre-created as a DIRECTORY so
 * every audit append throws (EISDIR) — proving the best-effort contract:
 * mutations still succeed when the audit write fails.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const USER = "auditor@example.com";

function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      `http://localhost:${port}${urlPath}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          "Tailscale-User-Login": USER,
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
            // Non-JSON body — leave parsed null
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

/** Spawn lib/server.js with an isolated HOME + temp fleet dirs. */
function makeServer({ auditBroken = false } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofc-index-audit-"));
  const home = path.join(tmpDir, "home");
  const cerebroDir = path.join(tmpDir, "cerebro");
  const logsDir = path.join(tmpDir, "logs");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(cerebroDir, "topics", "test-topic"), { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  if (auditBroken) {
    // audit.jsonl as a DIRECTORY: appendFileSync throws EISDIR on every
    // record() while the rest of the logs dir keeps working.
    fs.mkdirSync(path.join(logsDir, "audit.jsonl"), { recursive: true });
  }

  const port = 10000 + Math.floor(Math.random() * 50000);
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "lib", "server.js")], {
    env: {
      ...process.env,
      HOME: home,
      PORT: String(port),
      OPENCLAW_WORKSPACE: path.join(tmpDir, "workspace"),
      OPENCLAW_CEREBRO_DIR: cerebroDir,
      FLEET_CONFIG_JSON: JSON.stringify({
        stateDir: path.join(tmpDir, "state"),
        logsDir,
        briefsDir: path.join(tmpDir, "briefs"),
        workspaceDir: path.join(tmpDir, "workspace"),
        openclawSources: false, // hermetic: never spawn the openclaw CLI
        cortex: { enabled: false },
        alerts: {
          enabled: false,
          sinks: {
            ntfy: { enabled: false, topic: "" },
            slack: { enabled: false, gatewayUrl: "" },
            webhooks: [],
          },
        },
      }),
      OFC_DISABLE_ALERT_DELIVERY: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  return { proc, port, tmpDir, logsDir };
}

async function waitForServer(port, maxWait = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      await request(port, "GET", "/api/health");
      return;
    } catch (e) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`Server did not start within ${maxWait}ms`);
}

function readAuditEntries(logsDir) {
  const file = path.join(logsDir, "audit.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("index.js route audit coverage", () => {
  let server;

  before(async () => {
    server = makeServer();
    await waitForServer(server.port);
  });

  after(() => {
    if (server) {
      server.proc.kill("SIGTERM");
      fs.rmSync(server.tmpDir, { recursive: true, force: true });
    }
  });

  it("audits cerebro topic status updates as topic.status", async () => {
    const res = await request(server.port, "POST", "/api/cerebro/topic/test-topic/status", {
      status: "resolved",
    });
    assert.strictEqual(res.status, 200, res.raw);

    const entry = readAuditEntries(server.logsDir).find((e) => e.action === "topic.status");
    assert.ok(entry, "audit.jsonl should contain a topic.status entry");
    assert.strictEqual(entry.user, USER);
    assert.strictEqual(entry.target, "test-topic");
    assert.deepStrictEqual(entry.detail, { status: "resolved" });
  });

  it("audits /api/action executions as action.execute", async () => {
    // gateway-restart is allowed and never spawns the CLI (static response).
    const res = await request(server.port, "GET", "/api/action?action=gateway-restart");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);

    const entry = readAuditEntries(server.logsDir).find((e) => e.action === "action.execute");
    assert.ok(entry, "audit.jsonl should contain an action.execute entry");
    assert.strictEqual(entry.user, USER);
    assert.strictEqual(entry.target, "gateway-restart");
    assert.deepStrictEqual(entry.detail, { success: true });
  });

  it("audits operator saves as operator.save (field names only)", async () => {
    const res = await request(server.port, "POST", "/api/operators", {
      id: "op-1",
      name: "Alice",
      slackId: "U123",
    });
    assert.strictEqual(res.status, 200, res.raw);
    assert.strictEqual(res.body.success, true);

    const entry = readAuditEntries(server.logsDir).find((e) => e.action === "operator.save");
    assert.ok(entry, "audit.jsonl should contain an operator.save entry");
    assert.strictEqual(entry.user, USER);
    assert.strictEqual(entry.target, "op-1");
    assert.strictEqual(entry.detail.op, "create");
    assert.deepStrictEqual(entry.detail.fields, ["id", "name", "slackId"]);
    // Values never land in the trail — only the field names.
    assert.ok(!JSON.stringify(entry.detail).includes("Alice"));
  });

});

describe("index.js route audit best-effort (audit write fails)", () => {
  let server;

  before(async () => {
    server = makeServer({ auditBroken: true });
    await waitForServer(server.port);
  });

  after(() => {
    if (server) {
      server.proc.kill("SIGTERM");
      fs.rmSync(server.tmpDir, { recursive: true, force: true });
    }
  });

  it("mutations still succeed when the audit append throws", async () => {
    const operators = await request(server.port, "POST", "/api/operators", {
      id: "op-2",
      name: "Bob",
    });
    assert.strictEqual(operators.status, 200, operators.raw);
    assert.strictEqual(operators.body.success, true);

    const topic = await request(server.port, "POST", "/api/cerebro/topic/test-topic/status", {
      status: "parked",
    });
    assert.strictEqual(topic.status, 200, topic.raw);

    const action = await request(server.port, "GET", "/api/action?action=gateway-restart");
    assert.strictEqual(action.status, 200);
    assert.strictEqual(action.body.success, true);
  });
});
