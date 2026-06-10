const { describe, it } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createAlerts, createNodeAlertTracker } = require("../src/alerts");

// Recording fetch stub: captures calls, succeeds (or fails) per options
function makeFetch({ failUrls = [] } = {}) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    if (failUrls.includes(url)) {
      throw new Error("connection refused");
    }
    return { ok: true, status: 200 };
  };
  return { calls, fetchFn };
}

function makeClock(start = 1000000) {
  let now = start;
  return {
    nowFn: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

function baseConfig(overrides = {}) {
  return {
    enabled: true,
    rules: {
      nodeOffline: true,
      nodeUnreachable: true,
      taskFailed: true,
      taskStale: true,
      lessonPending: true,
    },
    sinks: { webhooks: [] },
    ...overrides,
  };
}

const baseEvent = {
  type: "nodeOffline",
  severity: "critical",
  node: "hermes-1",
  message: "Node went offline",
};

describe("alerts module", () => {
  describe("fire() validation", () => {
    it("rejects invalid events", async () => {
      const alerts = createAlerts({ config: baseConfig(), fetchFn: makeFetch().fetchFn });
      await assert.rejects(() => alerts.fire(null), /event must be an object/);
      await assert.rejects(() => alerts.fire({}), /type/);
      await assert.rejects(() => alerts.fire({ type: "" }), /type/);
      await assert.rejects(
        () => alerts.fire({ type: "nodeOffline", severity: "panic" }),
        /severity/,
      );
    });

    it("defaults severity to info", async () => {
      const alerts = createAlerts({ config: baseConfig(), fetchFn: makeFetch().fetchFn });
      await alerts.fire({ type: "taskStale", node: "n1", message: "stale" });
      assert.strictEqual(alerts.getRecent(1)[0].severity, "info");
    });
  });

  describe("enable/rules gating", () => {
    it("does not fire when disabled", async () => {
      const { calls, fetchFn } = makeFetch();
      const alerts = createAlerts({
        config: baseConfig({
          enabled: false,
          sinks: { webhooks: [{ url: "https://hook.example/1", events: ["*"] }] },
        }),
        fetchFn,
      });

      const result = await alerts.fire(baseEvent);
      assert.strictEqual(result.fired, false);
      assert.strictEqual(result.reason, "disabled");
      assert.strictEqual(calls.length, 0);
      assert.strictEqual(alerts.getRecent().length, 0);
    });

    it("respects per-rule toggles", async () => {
      const { calls, fetchFn } = makeFetch();
      const config = baseConfig({
        sinks: { webhooks: [{ url: "https://hook.example/1", events: ["*"] }] },
      });
      config.rules.taskFailed = false;
      const alerts = createAlerts({ config, fetchFn });

      const blocked = await alerts.fire({ type: "taskFailed", task: "t1", message: "failed" });
      assert.strictEqual(blocked.fired, false);
      assert.strictEqual(blocked.reason, "rule-disabled");

      const allowed = await alerts.fire(baseEvent);
      assert.strictEqual(allowed.fired, true);
      assert.strictEqual(calls.length, 1);
    });
  });

  describe("dedupe", () => {
    it("fires same type+node only once within 5 minutes", async () => {
      const clock = makeClock();
      const alerts = createAlerts({
        config: baseConfig(),
        fetchFn: makeFetch().fetchFn,
        nowFn: clock.nowFn,
      });

      assert.strictEqual((await alerts.fire(baseEvent)).fired, true);
      clock.advance(4 * 60 * 1000);
      const dup = await alerts.fire(baseEvent);
      assert.strictEqual(dup.fired, false);
      assert.strictEqual(dup.reason, "deduped");
      assert.strictEqual(alerts.getRecent().length, 1);
    });

    it("fires again after the 5 minute window", async () => {
      const clock = makeClock();
      const alerts = createAlerts({
        config: baseConfig(),
        fetchFn: makeFetch().fetchFn,
        nowFn: clock.nowFn,
      });

      await alerts.fire(baseEvent);
      clock.advance(5 * 60 * 1000 + 1);
      assert.strictEqual((await alerts.fire(baseEvent)).fired, true);
      assert.strictEqual(alerts.getRecent().length, 2);
    });

    it("does not dedupe across different nodes or tasks", async () => {
      const alerts = createAlerts({ config: baseConfig(), fetchFn: makeFetch().fetchFn });

      assert.strictEqual((await alerts.fire(baseEvent)).fired, true);
      assert.strictEqual((await alerts.fire({ ...baseEvent, node: "hermes-2" })).fired, true);
      assert.strictEqual(
        (await alerts.fire({ type: "taskFailed", task: "t1", message: "x" })).fired,
        true,
      );
      assert.strictEqual(
        (await alerts.fire({ type: "taskFailed", task: "t2", message: "x" })).fired,
        true,
      );
    });
  });

  describe("webhook sink", () => {
    it("POSTs the documented JSON body", async () => {
      const { calls, fetchFn } = makeFetch();
      const clock = makeClock(777000);
      const alerts = createAlerts({
        config: baseConfig({
          sinks: { webhooks: [{ url: "https://hook.example/1", events: ["*"] }] },
        }),
        fetchFn,
        nowFn: clock.nowFn,
      });

      await alerts.fire(baseEvent);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].url, "https://hook.example/1");
      assert.strictEqual(calls[0].options.method, "POST");
      assert.deepStrictEqual(JSON.parse(calls[0].options.body), {
        event: "nodeOffline",
        severity: "critical",
        node: "hermes-1",
        task: null,
        message: "Node went offline",
        ts: 777000,
        source: "open-fleet-control",
      });
    });

    it("signs the body with HMAC-SHA256 when a secret is set", async () => {
      const { calls, fetchFn } = makeFetch();
      const secret = "shhh-very-secret";
      const alerts = createAlerts({
        config: baseConfig({
          sinks: { webhooks: [{ url: "https://hook.example/1", secret, events: ["*"] }] },
        }),
        fetchFn,
      });

      await alerts.fire(baseEvent);
      const { body, headers } = calls[0].options;
      const expected = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
      assert.strictEqual(headers["X-OFC-Signature"], expected);
    });

    it("omits the signature header when there is no secret", async () => {
      const { calls, fetchFn } = makeFetch();
      const alerts = createAlerts({
        config: baseConfig({
          sinks: { webhooks: [{ url: "https://hook.example/1", events: ["*"] }] },
        }),
        fetchFn,
      });

      await alerts.fire(baseEvent);
      assert.strictEqual(calls[0].options.headers["X-OFC-Signature"], undefined);
    });

    it("filters webhooks by event list", async () => {
      const { calls, fetchFn } = makeFetch();
      const alerts = createAlerts({
        config: baseConfig({
          sinks: {
            webhooks: [
              { url: "https://hook.example/task-only", events: ["taskFailed"] },
              { url: "https://hook.example/everything", events: ["*"] },
            ],
          },
        }),
        fetchFn,
      });

      await alerts.fire(baseEvent); // nodeOffline
      assert.deepStrictEqual(
        calls.map((c) => c.url),
        ["https://hook.example/everything"],
      );

      await alerts.fire({ type: "taskFailed", task: "t1", message: "failed" });
      assert.deepStrictEqual(
        calls
          .slice(1)
          .map((c) => c.url)
          .sort(),
        ["https://hook.example/everything", "https://hook.example/task-only"],
      );
    });

    it("retries once after failure without throwing", async () => {
      const { calls, fetchFn } = makeFetch({ failUrls: ["https://hook.example/down"] });
      const alerts = createAlerts({
        config: baseConfig({
          sinks: { webhooks: [{ url: "https://hook.example/down", events: ["*"] }] },
        }),
        fetchFn,
        retryDelayMs: 5,
      });

      const result = await alerts.fire(baseEvent);
      assert.strictEqual(result.fired, true);
      assert.strictEqual(result.delivered, 0);
      assert.strictEqual(calls.length, 2); // Initial attempt + one retry
    });

    it("treats non-2xx responses as failures", async () => {
      const calls = [];
      const fetchFn = async (url, options) => {
        calls.push({ url, options });
        return { ok: false, status: 500 };
      };
      const alerts = createAlerts({
        config: baseConfig({
          sinks: { webhooks: [{ url: "https://hook.example/500", events: ["*"] }] },
        }),
        fetchFn,
        retryDelayMs: 5,
      });

      const result = await alerts.fire(baseEvent);
      assert.strictEqual(result.delivered, 0);
      assert.strictEqual(calls.length, 2);
    });

    it("isolates sink failures: one failing sink does not block others", async () => {
      const { calls, fetchFn } = makeFetch({ failUrls: ["https://hook.example/down"] });
      const alerts = createAlerts({
        config: baseConfig({
          sinks: {
            webhooks: [
              { url: "https://hook.example/down", events: ["*"] },
              { url: "https://hook.example/up", events: ["*"] },
            ],
            slack: { enabled: true, gatewayUrl: "https://gateway.example/slack", channel: "#ops" },
          },
        }),
        fetchFn,
        retryDelayMs: 5,
      });

      const result = await alerts.fire(baseEvent);
      assert.strictEqual(result.fired, true);
      assert.strictEqual(result.dispatched, 3);
      assert.strictEqual(result.delivered, 2);
      const succeeded = calls.filter((c) => !c.url.includes("down")).map((c) => c.url);
      assert.ok(succeeded.includes("https://hook.example/up"));
      assert.ok(succeeded.includes("https://gateway.example/slack"));
    });
  });

  describe("slack sink", () => {
    it("POSTs {channel, text} to the gateway URL", async () => {
      const { calls, fetchFn } = makeFetch();
      const alerts = createAlerts({
        config: baseConfig({
          sinks: {
            slack: { enabled: true, gatewayUrl: "https://gateway.example/slack", channel: "#ops" },
          },
        }),
        fetchFn,
      });

      await alerts.fire(baseEvent);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].url, "https://gateway.example/slack");
      const body = JSON.parse(calls[0].options.body);
      assert.strictEqual(body.channel, "#ops");
      assert.match(body.text, /\[CRITICAL\]/);
      assert.match(body.text, /nodeOffline/);
      assert.match(body.text, /hermes-1/);
      assert.match(body.text, /Node went offline/);
      // Gateway relays to Slack — no token fields ever sent from here
      assert.deepStrictEqual(Object.keys(body).sort(), ["channel", "text"]);
    });

    it("skips slack when disabled or missing gatewayUrl", async () => {
      const { calls, fetchFn } = makeFetch();
      const alerts = createAlerts({
        config: baseConfig({
          sinks: {
            slack: { enabled: false, gatewayUrl: "https://gateway.example/slack", channel: "#ops" },
          },
        }),
        fetchFn,
      });

      await alerts.fire(baseEvent);
      assert.strictEqual(calls.length, 0);
    });
  });

  describe("ntfy sink", () => {
    const ntfyConfig = (overrides = {}) =>
      baseConfig({
        sinks: {
          ntfy: {
            enabled: true,
            server: "https://ntfy.example",
            topic: "fleet-alerts",
            ...overrides,
          },
        },
      });

    it("POSTs the message as plain text to <server>/<topic> with publish headers", async () => {
      const { calls, fetchFn } = makeFetch();
      const alerts = createAlerts({ config: ntfyConfig(), fetchFn });

      await alerts.fire(baseEvent);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].url, "https://ntfy.example/fleet-alerts");
      assert.strictEqual(calls[0].options.method, "POST");
      assert.strictEqual(calls[0].options.body, "Node went offline");

      const headers = calls[0].options.headers;
      assert.strictEqual(headers["Content-Type"], "text/plain; charset=utf-8");
      assert.strictEqual(headers.Title, "nodeOffline (node=hermes-1)");
      assert.strictEqual(headers.Priority, "urgent"); // critical → urgent
      assert.strictEqual(headers.Tags, "rotating_light");
    });

    it("defaults the server to https://ntfy.sh and strips trailing slashes", async () => {
      const { calls, fetchFn } = makeFetch();
      const alerts = createAlerts({
        config: baseConfig({ sinks: { ntfy: { enabled: true, topic: "t1" } } }),
        fetchFn,
      });
      await alerts.fire(baseEvent);
      assert.strictEqual(calls[0].url, "https://ntfy.sh/t1");

      const second = makeFetch();
      const alerts2 = createAlerts({
        config: baseConfig({
          sinks: { ntfy: { enabled: true, server: "https://ntfy.example/", topic: "t1" } },
        }),
        fetchFn: second.fetchFn,
      });
      await alerts2.fire(baseEvent);
      assert.strictEqual(second.calls[0].url, "https://ntfy.example/t1");
    });

    it("maps severities to priorities: critical→urgent, warn→high, info→default", async () => {
      const { calls, fetchFn } = makeFetch();
      const alerts = createAlerts({ config: ntfyConfig(), fetchFn });

      await alerts.fire({ type: "nodeOffline", severity: "critical", node: "n1", message: "x" });
      await alerts.fire({ type: "taskStale", severity: "warn", task: "t1", message: "x" });
      await alerts.fire({ type: "lessonPending", severity: "info", message: "x" });

      assert.deepStrictEqual(
        calls.map((c) => c.options.headers.Priority),
        ["urgent", "high", "default"],
      );
      assert.deepStrictEqual(
        calls.map((c) => c.options.headers.Tags),
        ["rotating_light", "warning", "information_source"],
      );
    });

    it("honors a custom priorityMap, falling back per-severity", async () => {
      const { calls, fetchFn } = makeFetch();
      const alerts = createAlerts({
        config: ntfyConfig({ priorityMap: { critical: "max" } }),
        fetchFn,
      });

      await alerts.fire({ type: "nodeOffline", severity: "critical", node: "n1", message: "x" });
      await alerts.fire({ type: "taskStale", severity: "warn", task: "t1", message: "x" });

      assert.strictEqual(calls[0].options.headers.Priority, "max");
      assert.strictEqual(calls[1].options.headers.Priority, "high"); // default fallback
    });

    it("uses the title as body when the message is empty and includes task context", async () => {
      const { calls, fetchFn } = makeFetch();
      const alerts = createAlerts({ config: ntfyConfig(), fetchFn });

      await alerts.fire({ type: "taskFailed", severity: "warn", task: "tsk_1" });
      assert.strictEqual(calls[0].options.headers.Title, "taskFailed (task=tsk_1)");
      assert.strictEqual(calls[0].options.body, "taskFailed (task=tsk_1)");
    });

    it("skips ntfy when disabled or topic is missing", async () => {
      const disabled = makeFetch();
      const alerts1 = createAlerts({
        config: baseConfig({ sinks: { ntfy: { enabled: false, topic: "t1" } } }),
        fetchFn: disabled.fetchFn,
      });
      await alerts1.fire(baseEvent);
      assert.strictEqual(disabled.calls.length, 0);

      const noTopic = makeFetch();
      const alerts2 = createAlerts({
        config: baseConfig({ sinks: { ntfy: { enabled: true, topic: "" } } }),
        fetchFn: noTopic.fetchFn,
      });
      await alerts2.fire(baseEvent);
      assert.strictEqual(noTopic.calls.length, 0);
    });

    it("isolates ntfy failures from other sinks (retry once, never throws)", async () => {
      const { calls, fetchFn } = makeFetch({ failUrls: ["https://ntfy.example/fleet-alerts"] });
      const alerts = createAlerts({
        config: baseConfig({
          sinks: {
            ntfy: { enabled: true, server: "https://ntfy.example", topic: "fleet-alerts" },
            webhooks: [{ url: "https://hook.example/up", events: ["*"] }],
          },
        }),
        fetchFn,
        retryDelayMs: 5,
      });

      const result = await alerts.fire(baseEvent);
      assert.strictEqual(result.fired, true);
      assert.strictEqual(result.dispatched, 2);
      assert.strictEqual(result.delivered, 1); // webhook only
      const ntfyCalls = calls.filter((c) => c.url.includes("ntfy.example"));
      assert.strictEqual(ntfyCalls.length, 2); // initial attempt + one retry
    });
  });

  describe("getRecent()", () => {
    it("returns newest first, respecting limit", async () => {
      const alerts = createAlerts({ config: baseConfig(), fetchFn: makeFetch().fetchFn });
      await alerts.fire({ ...baseEvent, node: "n1" });
      await alerts.fire({ ...baseEvent, node: "n2" });
      await alerts.fire({ ...baseEvent, node: "n3" });

      const recent = alerts.getRecent(2);
      assert.strictEqual(recent.length, 2);
      assert.strictEqual(recent[0].node, "n3");
      assert.strictEqual(recent[1].node, "n2");
    });

    it("caps the ring buffer at 200 entries", async () => {
      const alerts = createAlerts({ config: baseConfig(), fetchFn: makeFetch().fetchFn });
      for (let i = 0; i < 205; i++) {
        await alerts.fire({ ...baseEvent, node: `n${i}` });
      }

      const recent = alerts.getRecent(500);
      assert.strictEqual(recent.length, 200);
      assert.strictEqual(recent[0].node, "n204"); // Newest kept
      assert.strictEqual(recent[199].node, "n5"); // Oldest 5 evicted
    });

    it("filters by type/node/severity/since", async () => {
      const clock = makeClock(100000);
      const alerts = createAlerts({
        config: baseConfig(),
        fetchFn: makeFetch().fetchFn,
        nowFn: clock.nowFn,
      });
      await alerts.fire({ type: "taskFailed", severity: "critical", task: "t1", message: "x" });
      clock.advance(1000);
      await alerts.fire({ type: "taskStale", severity: "warn", task: "t2", message: "y" });
      clock.advance(1000);
      await alerts.fire({ ...baseEvent, node: "n1" });

      assert.strictEqual(alerts.getRecent(50, { type: "taskStale" }).length, 1);
      assert.strictEqual(alerts.getRecent(50, { node: "n1" })[0].type, "nodeOffline");
      assert.strictEqual(alerts.getRecent(50, { severity: "warn" }).length, 1);
      assert.strictEqual(alerts.getRecent(50, { since: 101000 }).length, 2);
      assert.strictEqual(alerts.getRecent(50, { since: String(102000) }).length, 1);
    });
  });

  describe("mutes", () => {
    function mutedConfig(mutes) {
      return baseConfig({
        mutes,
        sinks: { webhooks: [{ url: "https://hook.example/1", events: ["*"] }] },
      });
    }

    it("skips alerts matching a node mute and counts them", async () => {
      const { calls, fetchFn } = makeFetch();
      const alerts = createAlerts({ config: mutedConfig([{ node: "hermes-1" }]), fetchFn });

      const muted = await alerts.fire(baseEvent);
      assert.strictEqual(muted.fired, false);
      assert.strictEqual(muted.reason, "muted");
      assert.strictEqual(alerts.getMutedCount(), 1);
      assert.strictEqual(calls.length, 0);
      assert.strictEqual(alerts.getRecent().length, 0);

      // Other nodes are unaffected
      const other = await alerts.fire({ ...baseEvent, node: "hermes-2" });
      assert.strictEqual(other.fired, true);
    });

    it("matches rule-only and rule+node mutes precisely", async () => {
      const { fetchFn } = makeFetch();
      const alerts = createAlerts({
        config: mutedConfig([{ rule: "taskFailed" }, { rule: "nodeOffline", node: "n2" }]),
        fetchFn,
      });

      assert.strictEqual(
        (await alerts.fire({ type: "taskFailed", task: "t", message: "x" })).reason,
        "muted",
      );
      assert.strictEqual((await alerts.fire({ ...baseEvent, node: "n2" })).reason, "muted");
      assert.strictEqual((await alerts.fire({ ...baseEvent, node: "n3" })).fired, true);
      assert.strictEqual(alerts.getMutedCount(), 2);
    });

    it("honors `until` expiry and ignores empty catch-all entries", async () => {
      const clock = makeClock(1000000);
      const { fetchFn } = makeFetch();
      const alerts = createAlerts({
        config: mutedConfig([{ node: "hermes-1", until: 1000000 + 60000 }, {}]),
        fetchFn,
        nowFn: clock.nowFn,
      });

      assert.strictEqual((await alerts.fire(baseEvent)).reason, "muted");
      clock.advance(61000);
      assert.strictEqual((await alerts.fire(baseEvent)).fired, true);
      // The empty {} entry never muted anything
      assert.strictEqual(alerts.getMutedCount(), 1);
    });

    it("does not let a muted alert consume the dedupe slot", async () => {
      const clock = makeClock(500000);
      const { fetchFn } = makeFetch();
      const alerts = createAlerts({
        config: mutedConfig([{ node: "hermes-1", until: 500000 + 1000 }]),
        fetchFn,
        nowFn: clock.nowFn,
      });

      assert.strictEqual((await alerts.fire(baseEvent)).reason, "muted");
      clock.advance(2000); // mute expired, still inside the 5-min dedupe window
      assert.strictEqual((await alerts.fire(baseEvent)).fired, true);
    });
  });
});

describe("alert history (JSONL persistence)", () => {
  function makeLogsDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "ofc-alerts-history-"));
  }

  function historyAlerts(logsDir, { clock, extra } = {}) {
    return createAlerts({
      config: {
        enabled: true,
        rules: {},
        sinks: { webhooks: [] },
      },
      logsDir,
      fetchFn: makeFetch().fetchFn,
      ...(clock ? { nowFn: clock.nowFn } : {}),
      ...extra,
    });
  }

  it("appends every FIRED alert to logs/alerts.jsonl (and only fired ones)", async () => {
    const logsDir = makeLogsDir();
    const alerts = historyAlerts(logsDir);

    await alerts.fire(baseEvent); // fired
    await alerts.fire(baseEvent); // deduped -> NOT appended
    await alerts.fire({ type: "taskFailed", severity: "critical", task: "t1", message: "boom" });

    const lines = fs
      .readFileSync(path.join(logsDir, "alerts.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[0].type, "nodeOffline");
    assert.strictEqual(lines[1].type, "taskFailed");
    assert.match(lines[0].id, /^alr_/);
    fs.rmSync(logsDir, { recursive: true, force: true });
  });

  it("query() reads newest-first with type/node/severity/since filters and a 500 cap", async () => {
    const logsDir = makeLogsDir();
    const clock = makeClock(1000000);
    const alerts = historyAlerts(logsDir, { clock });

    await alerts.fire({ type: "taskFailed", severity: "critical", task: "t1", message: "a" });
    clock.advance(1000);
    await alerts.fire({ type: "nodeUnreachable", severity: "warn", node: "n1", message: "b" });
    clock.advance(1000);
    await alerts.fire({ type: "nodeOffline", severity: "critical", node: "n2", message: "c" });

    const all = alerts.query();
    assert.strictEqual(all.length, 3);
    assert.strictEqual(all[0].type, "nodeOffline"); // newest first
    assert.strictEqual(all[2].type, "taskFailed");

    assert.strictEqual(alerts.query({ type: "nodeUnreachable" }).length, 1);
    assert.strictEqual(alerts.query({ node: "n2" })[0].severity, "critical");
    assert.strictEqual(alerts.query({ severity: "warn" }).length, 1);
    assert.strictEqual(alerts.query({ since: 1001000 }).length, 2);
    assert.strictEqual(alerts.query({ limit: 2 }).length, 2);
    assert.strictEqual(alerts.query({ limit: 99999 }).length, 3); // cap applied silently
    assert.throws(() => alerts.query({ limit: 0 }), /limit/i);
    assert.throws(() => alerts.query({ severity: "panic" }), /severity/i);
    fs.rmSync(logsDir, { recursive: true, force: true });
  });

  it("rotates at the size threshold and keeps a bounded set of files", async () => {
    const logsDir = makeLogsDir();
    const alerts = historyAlerts(logsDir, {
      extra: { historyMaxBytes: 400, historyKeepFiles: 2 },
    });

    for (let i = 0; i < 30; i++) {
      await alerts.fire({ type: "taskFailed", task: `t${i}`, message: "x".repeat(60) });
    }

    const files = fs.readdirSync(logsDir).filter((f) => /^alerts\..*jsonl$/.test(f));
    const rotated = files.filter((f) => f !== "alerts.jsonl");
    assert.ok(rotated.length >= 1, "should have rotated at least once");
    assert.ok(rotated.length <= 2, `should keep at most 2 rotated files (got ${rotated.length})`);
    assert.ok(files.includes("alerts.jsonl"), "active file should exist");

    // query() spans active + rotated files, newest first
    const results = alerts.query({ limit: 500 });
    assert.strictEqual(results[0].task, "t29");
    assert.ok(results.length > 5, "rotated entries should be readable");
    fs.rmSync(logsDir, { recursive: true, force: true });
  });

  it("survives malformed lines and returns [] without a logsDir", async () => {
    const logsDir = makeLogsDir();
    const alerts = historyAlerts(logsDir);
    await alerts.fire(baseEvent);
    fs.appendFileSync(path.join(logsDir, "alerts.jsonl"), 'not-json\n{"half":\n', "utf8");
    await alerts.fire({ type: "taskFailed", task: "t9", message: "ok" });

    assert.strictEqual(alerts.query().length, 2);

    const noHistory = createAlerts({ config: { enabled: true }, fetchFn: makeFetch().fetchFn });
    assert.deepStrictEqual(noHistory.query(), []);
    fs.rmSync(logsDir, { recursive: true, force: true });
  });
});

describe("test-mode delivery suppression (defense in depth)", () => {
  // These tests run under `node --test`, so NODE_TEST_CONTEXT is set in this
  // process — exactly the environment the guard protects against.
  it("no-ops sinks when using the ambient global fetch under node --test", async () => {
    assert.ok(process.env.NODE_TEST_CONTEXT, "expected to run under node --test");
    const alerts = createAlerts({
      // NO fetchFn injected -> engine would use globalThis.fetch
      config: baseConfig({
        sinks: {
          ntfy: { enabled: true, server: "https://ntfy.sh", topic: "real-topic-do-not-hit" },
          webhooks: [{ url: "https://hook.example/never", events: ["*"] }],
        },
      }),
    });

    const result = await alerts.fire(baseEvent);
    assert.strictEqual(result.fired, true);
    assert.strictEqual(result.suppressed, true);
    assert.strictEqual(result.dispatched, 0);
    assert.strictEqual(result.delivered, 0);
    // Still recorded for the UI ring buffer
    assert.strictEqual(alerts.getRecent().length, 1);
  });

  it("honors OFC_DISABLE_ALERT_DELIVERY=1 explicitly", async () => {
    const previous = process.env.OFC_DISABLE_ALERT_DELIVERY;
    process.env.OFC_DISABLE_ALERT_DELIVERY = "1";
    try {
      const alerts = createAlerts({
        config: baseConfig({
          sinks: { ntfy: { enabled: true, topic: "real-topic-do-not-hit" } },
        }),
      });
      const result = await alerts.fire(baseEvent);
      assert.strictEqual(result.suppressed, true);
      assert.strictEqual(result.dispatched, 0);
    } finally {
      if (previous === undefined) delete process.env.OFC_DISABLE_ALERT_DELIVERY;
      else process.env.OFC_DISABLE_ALERT_DELIVERY = previous;
    }
  });

  it("does NOT suppress when a fetch stub is injected (unit tests stay deterministic)", async () => {
    const { calls, fetchFn } = makeFetch();
    const alerts = createAlerts({
      config: baseConfig({
        sinks: { webhooks: [{ url: "https://hook.example/1", events: ["*"] }] },
      }),
      fetchFn,
    });

    const result = await alerts.fire(baseEvent);
    assert.strictEqual(result.fired, true);
    assert.strictEqual(result.suppressed, undefined);
    assert.strictEqual(calls.length, 1);
  });
});

describe("createNodeAlertTracker (flap suppression + recovery)", () => {
  const NODE = { id: "node-1", hostname: "hermes-1" };

  function makeTracker({ flap, start = 1000000 } = {}) {
    const clock = makeClock(start);
    const fired = [];
    const tracker = createNodeAlertTracker({
      flap,
      fire: (event) => fired.push(event),
      nowFn: clock.nowFn,
    });
    return { tracker, fired, clock };
  }

  /** One failed-poll observation with the given streak count. */
  function failPoll(tracker, streak, status = "unreachable", node = NODE) {
    return tracker.observe(node, status, { consecutiveFailures: streak });
  }

  it("requires a fire function", () => {
    assert.throws(() => createNodeAlertTracker(), /fire/);
  });

  it("does not alert before the consecutive-failures threshold", () => {
    const { tracker, fired, clock } = makeTracker(); // defaults 3 / 60s
    failPoll(tracker, 1);
    clock.advance(120000); // duration satisfied, streak not
    failPoll(tracker, 2);
    assert.strictEqual(fired.length, 0);
  });

  it("does not alert before minDurationMs even with the streak satisfied", () => {
    const { tracker, fired, clock } = makeTracker();
    failPoll(tracker, 1);
    clock.advance(15000);
    failPoll(tracker, 2);
    clock.advance(15000);
    failPoll(tracker, 3); // streak ok, only 30s elapsed
    assert.strictEqual(fired.length, 0);
  });

  it("alerts exactly once when BOTH streak and duration thresholds are met", () => {
    const { tracker, fired, clock } = makeTracker();
    failPoll(tracker, 1);
    clock.advance(30000);
    failPoll(tracker, 2);
    clock.advance(30000);
    failPoll(tracker, 3, "offline"); // 60s elapsed + 3 consecutive
    assert.strictEqual(fired.length, 1);
    assert.strictEqual(fired[0].type, "nodeOffline");
    assert.strictEqual(fired[0].severity, "critical");
    assert.strictEqual(fired[0].node, "hermes-1");

    // Latch: continued failures do not re-fire
    clock.advance(15000);
    failPoll(tracker, 4, "offline");
    clock.advance(15000);
    failPoll(tracker, 5, "offline");
    assert.strictEqual(fired.length, 1);
  });

  it("uses the status at threshold-crossing time (unreachable -> warn)", () => {
    const { tracker, fired, clock } = makeTracker({ flap: { consecutive: 2, minDurationMs: 0 } });
    failPoll(tracker, 1, "offline");
    clock.advance(1000);
    failPoll(tracker, 2, "unreachable");
    assert.strictEqual(fired.length, 1);
    assert.strictEqual(fired[0].type, "nodeUnreachable");
    assert.strictEqual(fired[0].severity, "warn");
  });

  it("a flapping node (recovers before threshold) never alerts", () => {
    const { tracker, fired, clock } = makeTracker();
    for (let cycle = 0; cycle < 5; cycle++) {
      failPoll(tracker, 1);
      clock.advance(15000);
      failPoll(tracker, 2);
      clock.advance(15000);
      tracker.observe(NODE, "online", { consecutiveFailures: 0 }); // back before 3rd failure
      clock.advance(15000);
    }
    assert.strictEqual(fired.length, 0); // no node alerts, no recovery alerts
  });

  it("fires nodeRecovered exactly once when a previously-alerted node returns", () => {
    const { tracker, fired, clock } = makeTracker({ flap: { consecutive: 2, minDurationMs: 0 } });
    failPoll(tracker, 1);
    clock.advance(1000);
    failPoll(tracker, 2);
    assert.strictEqual(fired.length, 1);

    tracker.observe(NODE, "online", { consecutiveFailures: 0 });
    assert.strictEqual(fired.length, 2);
    assert.strictEqual(fired[1].type, "nodeRecovered");
    assert.strictEqual(fired[1].severity, "info");
    assert.strictEqual(fired[1].node, "hermes-1");

    // Staying online does not re-fire recovery
    tracker.observe(NODE, "online", { consecutiveFailures: 0 });
    tracker.observe(NODE, "online", { consecutiveFailures: 0 });
    assert.strictEqual(fired.length, 2);
  });

  it("tracks nodes independently", () => {
    const other = { id: "node-2", hostname: "drone-2" };
    const { tracker, fired, clock } = makeTracker({ flap: { consecutive: 2, minDurationMs: 0 } });
    failPoll(tracker, 1);
    failPoll(tracker, 1, "unreachable", other);
    clock.advance(1000);
    failPoll(tracker, 2); // only hermes-1 crosses
    assert.strictEqual(fired.length, 1);
    assert.strictEqual(fired[0].node, "hermes-1");
  });

  it("setFlapConfig hot-applies new thresholds without losing streak state", () => {
    const { tracker, fired, clock } = makeTracker(); // 3 / 60s
    failPoll(tracker, 1);
    clock.advance(30000);
    failPoll(tracker, 2);
    assert.strictEqual(fired.length, 0);

    tracker.setFlapConfig({ consecutive: 2, minDurationMs: 10000 });
    clock.advance(1000);
    failPoll(tracker, 3); // failingSince preserved -> 31s >= 10s, streak 3 >= 2
    assert.strictEqual(fired.length, 1);
  });

  it("normalizes invalid flap config to defaults", () => {
    const { tracker, fired, clock } = makeTracker({
      flap: { consecutive: -5, minDurationMs: "soon" },
    });
    failPoll(tracker, 1);
    clock.advance(59000);
    failPoll(tracker, 3); // 59s < default 60s
    assert.strictEqual(fired.length, 0);
    clock.advance(2000);
    failPoll(tracker, 4);
    assert.strictEqual(fired.length, 1);
  });
});
