const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

describe("server", () => {
  // Use a random high port to avoid conflicts
  const TEST_PORT = 10000 + Math.floor(Math.random() * 50000);
  let serverProcess;

  before(async () => {
    // Start the server as a child process with a custom PORT.
    // Test isolation: without FLEET_CONFIG_JSON this boot inherits config/
    // dashboard.local.json (which may have alerts + a real ntfy topic
    // enabled). Force the alert engine OFF and disable every sink so a test
    // run can never deliver real notifications; OFC_DISABLE_ALERT_DELIVERY
    // is the engine-level belt-and-braces guard for anything that slips by.
    serverProcess = spawn(process.execPath, [path.join(__dirname, "..", "lib", "server.js")], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        FLEET_CONFIG_JSON: JSON.stringify({
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

    // Wait for server to be ready by polling the health endpoint
    const maxWait = 10000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      try {
        await httpGet(`http://localhost:${TEST_PORT}/api/health`);
        return; // Server is ready
      } catch (_e) {
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
  });

  it("responds to /api/health with status ok", async () => {
    const { statusCode, body } = await httpGet(`http://localhost:${TEST_PORT}/api/health`);
    assert.strictEqual(statusCode, 200);
    const data = JSON.parse(body);
    assert.strictEqual(data.status, "ok");
    assert.strictEqual(data.port, TEST_PORT);
    assert.ok(data.timestamp, "should have timestamp");
  });

  it("responds to /api/about with project info", async () => {
    const { statusCode, body } = await httpGet(`http://localhost:${TEST_PORT}/api/about`);
    assert.strictEqual(statusCode, 200);
    const data = JSON.parse(body);
    assert.ok(data.name || data.version, "should have project info");
  });

  it("returns JSON content type for API endpoints", async () => {
    const { headers } = await httpGet(`http://localhost:${TEST_PORT}/api/health`);
    assert.ok(
      headers["content-type"].includes("application/json"),
      `Expected JSON content type, got: ${headers["content-type"]}`,
    );
  });

  it("responds to /api/cost-breakdown with the expected shape", async () => {
    const { statusCode, body } = await httpGet(`http://localhost:${TEST_PORT}/api/cost-breakdown`);
    assert.strictEqual(statusCode, 200);
    const data = JSON.parse(body);
    assert.ok(data.rates, "should include pricing rates");
    assert.ok(data.windows, "should include 24h/3d/7d windows");
    for (const key of ["24h", "3d", "7d"]) {
      assert.ok(data.windows[key], `should include the ${key} window`);
      assert.ok(data.windows[key].tokens, `${key} window should include token counts`);
      assert.ok(
        Array.isArray(data.windows[key].byModel),
        `${key} window should include a per-model breakdown array`,
      );
    }
    assert.ok("cacheRead" in data && "cacheWrite" in data, "cache tokens reported distinctly");
  });

  it("responds 400 to /api/sessions/detail without a key", async () => {
    const { statusCode, body } = await httpGet(`http://localhost:${TEST_PORT}/api/sessions/detail`);
    assert.strictEqual(statusCode, 400);
    const data = JSON.parse(body);
    assert.ok(data.error, "should include an error message");
  });

  it("responds to /api/sessions/detail with JSON for an unknown key", async () => {
    const { statusCode, body } = await httpGet(
      `http://localhost:${TEST_PORT}/api/sessions/detail?key=${encodeURIComponent("agent:nope:nope")}`,
    );
    assert.strictEqual(statusCode, 200);
    const data = JSON.parse(body);
    // Unknown keys resolve to a structured error payload, never a crash
    assert.ok(data.error || data.key, "should return a structured payload");
  });

  it("serves static files for root path", async () => {
    const { statusCode } = await httpGet(`http://localhost:${TEST_PORT}/`);
    // Should return 200 (index.html) or similar
    assert.ok(
      statusCode >= 200 && statusCode < 500,
      `Expected 2xx/3xx/4xx status for root, got: ${statusCode}`,
    );
  });
});

/**
 * Simple HTTP GET helper that returns a promise
 */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body,
          }),
        );
      })
      .on("error", reject);
  });
}
