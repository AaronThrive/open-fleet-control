const { describe, it } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { createAlerts } = require("../src/alerts");

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
  });
});
