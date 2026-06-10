/**
 * Tests for the performance-related config flags and the vitals
 * refresh worker (coalescing + collectedAt + force refresh).
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");

const { loadConfig } = require("../src/config");

describe("fleet perf config flags", () => {
  afterEach(() => {
    delete process.env.FLEET_CONFIG_JSON;
  });

  it("defaults: sessionsSource=files, sessionsRefreshMs=30000, openclawSources=true", () => {
    const config = loadConfig();
    assert.strictEqual(config.fleet.sessionsSource, "files");
    assert.strictEqual(config.fleet.sessionsRefreshMs, 30000);
    assert.strictEqual(config.fleet.openclawSources, true);
  });

  it("FLEET_CONFIG_JSON can flip openclawSources and sessionsSource", () => {
    process.env.FLEET_CONFIG_JSON = JSON.stringify({
      openclawSources: false,
      sessionsSource: "cli",
      sessionsRefreshMs: 5000,
    });
    const config = loadConfig();
    assert.strictEqual(config.fleet.openclawSources, false);
    assert.strictEqual(config.fleet.sessionsSource, "cli");
    assert.strictEqual(config.fleet.sessionsRefreshMs, 5000);
  });
});

describe("vitals refresh worker", () => {
  it("coalesces concurrent refreshes and stamps collectedAt", async () => {
    const vitals = require("../src/vitals");

    const p1 = vitals.refreshVitalsAsync();
    const p2 = vitals.refreshVitalsAsync();
    assert.strictEqual(p1, p2, "concurrent refreshes must share one in-flight collection");

    const collected = await vitals.forceRefreshVitals();
    assert.ok(collected && typeof collected === "object");
    assert.ok(Number.isFinite(collected.collectedAt), "vitals must carry collectedAt");
    assert.ok(Number.isFinite(vitals.getVitalsCacheAgeMs()));
    assert.ok(vitals.getVitalsCacheAgeMs() < 60000);
  });
});
