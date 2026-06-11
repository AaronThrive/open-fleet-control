const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  executeAction,
  normalizeAction,
  parseGatewayStatus,
  ALLOWED_ACTIONS,
  DEFAULT_STALE_MINUTES,
} = require("../src/actions");

// Real-shaped CLI fixtures (captured from openclaw 2026.6.5 on this host).
const GATEWAY_STATUS_UP = [
  "Service: systemd user (disabled)",
  "Gateway: bind=loopback (127.0.0.1), port=18789 (env/config)",
  "Gateway version: 2026.6.5",
  "Runtime: stopped (state inactive, sub dead, last exit 0, reason 0)",
  "Connectivity probe: ok",
  "Listening: 127.0.0.1:18789, [::1]:18789",
].join("\n");

const GATEWAY_STATUS_DOWN = [
  "Service: systemd user (disabled)",
  "Gateway: bind=loopback (127.0.0.1), port=18789 (env/config)",
  "Runtime: stopped (state inactive, sub dead, last exit 1, reason 1)",
  "Connectivity probe: failed (connection refused)",
].join("\n");

const CLEANUP_JSON = JSON.stringify({
  agentId: "main",
  mode: "enforce",
  dryRun: false,
  beforeCount: 47,
  afterCount: 44,
  missing: 1,
  pruned: 2,
  capped: 0,
  unreferencedArtifacts: { scannedFiles: 655, removedFiles: 46, freedBytes: 40041737 },
});

/** Fake async CLI runner: records calls, returns canned output per command. */
function makeExec(responses = {}) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    for (const [prefix, output] of Object.entries(responses)) {
      if (args.startsWith(prefix)) return output;
    }
    return null;
  };
  return { fn, calls };
}

function makeDeps(execResponses, extras = {}) {
  const exec = makeExec(execResponses);
  return {
    deps: {
      runOpenClawAsync: exec.fn,
      extractJSON: (output) => {
        if (!output) return null;
        const start = String(output).search(/[[{]/);
        return start === -1 ? null : String(output).slice(start);
      },
      PORT: 3333,
      ...extras,
    },
    calls: exec.calls,
  };
}

describe("actions module", () => {
  describe("normalizeAction()", () => {
    it("maps the front-end prune-stale alias to clear-stale-sessions", () => {
      assert.strictEqual(normalizeAction("prune-stale"), "clear-stale-sessions");
      assert.strictEqual(normalizeAction("clean-stale-sessions"), "clear-stale-sessions");
    });

    it("passes canonical names through", () => {
      for (const name of ALLOWED_ACTIONS) {
        assert.strictEqual(normalizeAction(name), name);
      }
    });
  });

  describe("parseGatewayStatus()", () => {
    it("reports reachable from the connectivity probe even when runtime says stopped", () => {
      const gw = parseGatewayStatus(GATEWAY_STATUS_UP);
      assert.strictEqual(gw.reachable, true);
      assert.strictEqual(gw.probeOk, true);
      assert.strictEqual(gw.port, 18789);
      assert.strictEqual(gw.version, "2026.6.5");
    });

    it("reports unreachable when the probe fails and nothing is listening", () => {
      const gw = parseGatewayStatus(GATEWAY_STATUS_DOWN);
      assert.strictEqual(gw.reachable, false);
      assert.strictEqual(gw.runtime, "stopped");
    });
  });

  describe("executeAction()", () => {
    it("clear-stale-sessions actually runs `sessions cleanup --enforce --json`", async () => {
      const { deps, calls } = makeDeps({ "sessions cleanup": CLEANUP_JSON });
      const result = await executeAction("clear-stale-sessions", deps);
      assert.strictEqual(result.success, true);
      assert.ok(calls.some((args) => args.includes("sessions cleanup --enforce --json")));
      assert.ok(result.output.includes("3 session entries removed"));
      assert.ok(result.output.includes("47 → 44"));
      assert.ok(result.output.includes("46 unreferenced files"));
      assert.strictEqual(result.detail.pruned, 2);
      assert.strictEqual(result.detail.freedBytes, 40041737);
    });

    it("accepts the front-end's prune-stale action name", async () => {
      const { deps } = makeDeps({ "sessions cleanup": CLEANUP_JSON });
      const result = await executeAction("prune-stale", deps);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.action, "clear-stale-sessions");
    });

    it("clear-stale-sessions includes the stale count from the sessions backend", async () => {
      const hourMs = 60 * 60 * 1000;
      const { deps } = makeDeps(
        { "sessions cleanup": CLEANUP_JSON },
        {
          getRawSessions: () => [
            { key: "a", ageMs: 25 * hourMs },
            { key: "b", ageMs: 30 * hourMs },
            { key: "c", ageMs: 1 * hourMs },
          ],
        },
      );
      const result = await executeAction("clear-stale-sessions", deps);
      assert.strictEqual(result.detail.staleCount, 2);
      assert.strictEqual(result.detail.staleMinutes, DEFAULT_STALE_MINUTES);
      assert.ok(result.output.includes("2 sessions idle"));
    });

    it("clear-stale-sessions honors a custom staleMinutes window", async () => {
      const { deps } = makeDeps(
        { "sessions cleanup": CLEANUP_JSON },
        { getRawSessions: () => [{ key: "a", ageMs: 90 * 60 * 1000 }] },
      );
      const result = await executeAction("clear-stale-sessions", deps, { staleMinutes: 60 });
      assert.strictEqual(result.detail.staleMinutes, 60);
      assert.strictEqual(result.detail.staleCount, 1);
    });

    it("clear-stale-sessions fails cleanly when the CLI times out", async () => {
      const { deps } = makeDeps({}); // every command returns null
      const result = await executeAction("clear-stale-sessions", deps);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes("cleanup failed or timed out"));
    });

    it("gateway-status returns a one-line summary (toast-friendly)", async () => {
      const { deps } = makeDeps({ "gateway status": GATEWAY_STATUS_UP });
      const result = await executeAction("gateway-status", deps);
      assert.strictEqual(result.success, true);
      assert.ok(!result.output.includes("\n"));
      assert.ok(result.output.includes("reachable"));
      assert.ok(result.output.includes("18789"));
      assert.ok(result.detail.raw.includes("Connectivity probe"));
    });

    it("gateway-status fails cleanly when the CLI is unavailable", async () => {
      const { deps } = makeDeps({});
      const result = await executeAction("gateway-status", deps);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes("failed or timed out"));
    });

    it("health-check succeeds when the gateway probe is ok", async () => {
      const { deps } = makeDeps(
        { "gateway status": GATEWAY_STATUS_UP },
        { getRawSessions: () => [{ key: "a", ageMs: 1000 }] },
      );
      const result = await executeAction("health-check", deps);
      assert.strictEqual(result.success, true);
      assert.ok(result.output.includes("Gateway: OK reachable"));
      assert.ok(result.output.includes("Sessions: 1"));
      assert.ok(result.output.includes("3333"));
    });

    it("health-check fails (success:false) when the gateway is unreachable", async () => {
      const { deps } = makeDeps({ "gateway status": GATEWAY_STATUS_DOWN });
      const result = await executeAction("health-check", deps);
      assert.strictEqual(result.success, false);
      assert.ok(result.output.includes("Gateway: NOT reachable"));
      assert.ok(result.error.includes("probe failed"));
    });

    it("handles sessions-list and cron-list", async () => {
      const { deps } = makeDeps({ sessions: "session table", "cron list": "cron table" });
      const sessions = await executeAction("sessions-list", deps);
      assert.strictEqual(sessions.success, true);
      assert.strictEqual(sessions.output, "session table");
      const cron = await executeAction("cron-list", deps);
      assert.strictEqual(cron.success, true);
      assert.strictEqual(cron.output, "cron table");
    });

    it("handles gateway-restart with safety message", async () => {
      const { deps } = makeDeps({});
      const result = await executeAction("gateway-restart", deps);
      assert.strictEqual(result.success, true);
      assert.ok(result.note.includes("safety"));
    });

    it("returns error for unknown action", async () => {
      const { deps } = makeDeps({});
      const result = await executeAction("nonexistent-action", deps);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes("Unknown action"));
    });

    it("catches exec exceptions and returns error", async () => {
      const deps = {
        runOpenClawAsync: async () => {
          throw new Error("command failed");
        },
        extractJSON: (o) => o,
        PORT: 3333,
      };
      const result = await executeAction("gateway-status", deps);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes("command failed"));
    });

    it("tolerates a broken getRawSessions provider", async () => {
      const { deps } = makeDeps(
        { "sessions cleanup": CLEANUP_JSON },
        {
          getRawSessions: () => {
            throw new Error("cache exploded");
          },
        },
      );
      const result = await executeAction("clear-stale-sessions", deps);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.detail.staleCount, null);
    });
  });
});
