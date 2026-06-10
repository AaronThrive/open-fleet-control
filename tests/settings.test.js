const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createSettings } = require("../src/settings");

let tmpDir;
let configPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofc-settings-"));
  configPath = path.join(tmpDir, "dashboard.local.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(obj) {
  fs.writeFileSync(configPath, JSON.stringify(obj, null, 2));
}

function readConfig() {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

describe("settings module", () => {
  describe("createSettings()", () => {
    it("requires a configPath", () => {
      assert.throws(() => createSettings(), /configPath/);
      assert.throws(() => createSettings({ configPath: "" }), /configPath/);
    });

    it("rejects a non-function onChange", () => {
      assert.throws(() => createSettings({ configPath, onChange: "nope" }), /onChange/);
    });
  });

  describe("get()", () => {
    it("returns full defaults when the file does not exist", () => {
      const settings = createSettings({ configPath });
      const result = settings.get();

      assert.strictEqual(result.alerts.enabled, false);
      assert.deepStrictEqual(result.alerts.rules, {
        nodeOffline: true,
        nodeUnreachable: true,
        taskFailed: true,
        taskStale: true,
        lessonPending: true,
      });
      assert.deepStrictEqual(result.alerts.sinks.slack, {
        enabled: false,
        gatewayUrl: "",
        channel: "",
      });
      assert.deepStrictEqual(result.alerts.sinks.ntfy, {
        enabled: false,
        server: "https://ntfy.sh",
        topic: "",
      });
      assert.deepStrictEqual(result.alerts.sinks.webhooks, []);
      assert.strictEqual(result.mesh.intervalMs, 15000);
      assert.strictEqual(result.federation.intervalMs, 30000);
      assert.strictEqual(result.watchdog.thresholdMs, 1800000);
      assert.strictEqual(result.validationGate.default, true);
    });

    it("reflects persisted overrides merged over defaults", () => {
      writeConfig({
        fleet: {
          mesh: { intervalMs: 60000 },
          alerts: { enabled: true, sinks: { ntfy: { enabled: true, topic: "ops" } } },
        },
      });
      const settings = createSettings({ configPath });
      const result = settings.get();

      assert.strictEqual(result.mesh.intervalMs, 60000);
      assert.strictEqual(result.federation.intervalMs, 30000); // untouched default
      assert.strictEqual(result.alerts.enabled, true);
      assert.strictEqual(result.alerts.sinks.ntfy.topic, "ops");
      assert.strictEqual(result.alerts.sinks.ntfy.server, "https://ntfy.sh"); // default fills in
    });

    it("REDACTS webhook secrets everywhere — only hasSecret is exposed", () => {
      const secret = "super-secret-hmac-key";
      writeConfig({
        fleet: {
          alerts: {
            sinks: {
              webhooks: [
                { id: "wh_aaa", url: "https://hook.example/1", secret, events: ["*"] },
                { id: "wh_bbb", url: "https://hook.example/2", events: ["taskFailed"] },
              ],
            },
          },
        },
      });
      const settings = createSettings({ configPath });
      const result = settings.get();

      assert.deepStrictEqual(result.alerts.sinks.webhooks, [
        { id: "wh_aaa", url: "https://hook.example/1", events: ["*"], hasSecret: true },
        { id: "wh_bbb", url: "https://hook.example/2", events: ["taskFailed"], hasSecret: false },
      ]);
      assert.ok(!JSON.stringify(result).includes(secret), "secret leaked in get()");
    });

    it("assigns stable derived ids to hand-edited webhooks without one", () => {
      writeConfig({
        fleet: { alerts: { sinks: { webhooks: [{ url: "https://hook.example/legacy" }] } } },
      });
      const settings = createSettings({ configPath });

      const first = settings.get().alerts.sinks.webhooks[0];
      const second = settings.get().alerts.sinks.webhooks[0];
      assert.match(first.id, /^wh_[0-9a-f]{10}$/);
      assert.strictEqual(first.id, second.id); // deterministic across reads
    });
  });

  describe("update() validation", () => {
    it("rejects non-object and empty patches", () => {
      const settings = createSettings({ configPath });
      assert.throws(() => settings.update(null), /patch/);
      assert.throws(() => settings.update({}), /patch/);
      assert.throws(() => settings.update([1]), /patch/);
    });

    it("rejects unknown keys at every level", () => {
      const settings = createSettings({ configPath });
      assert.throws(() => settings.update({ hacker: true }), /unknown key "hacker"/);
      assert.throws(() => settings.update({ alerts: { boom: 1 } }), /unknown key "boom"/);
      assert.throws(
        () => settings.update({ alerts: { rules: { madeUpRule: true } } }),
        /unknown key "madeUpRule"/,
      );
      assert.throws(
        () => settings.update({ alerts: { sinks: { slack: { token: "x" } } } }),
        /unknown key "token"/,
      );
    });

    it("rejects non-http(s) and malformed URLs", () => {
      const settings = createSettings({ configPath });
      assert.throws(
        () => settings.update({ alerts: { sinks: { ntfy: { server: "ftp://x" } } } }),
        /http/,
      );
      assert.throws(
        () => settings.update({ alerts: { sinks: { slack: { gatewayUrl: "not a url" } } } }),
        /valid URL/,
      );
      assert.throws(
        () =>
          settings.update({
            alerts: { sinks: { webhooks: { add: [{ url: "javascript:alert(1)" }] } } },
          }),
        /http/,
      );
    });

    it("rejects out-of-bounds and non-integer intervals", () => {
      const settings = createSettings({ configPath });
      assert.throws(() => settings.update({ mesh: { intervalMs: 4999 } }), /between/);
      assert.throws(() => settings.update({ mesh: { intervalMs: 3600001 } }), /between/);
      assert.throws(() => settings.update({ federation: { intervalMs: 1.5 } }), /between/);
      assert.throws(() => settings.update({ watchdog: { thresholdMs: "60000" } }), /between/);
    });

    it("accepts boundary interval values (5s and 1h)", () => {
      const settings = createSettings({ configPath });
      assert.strictEqual(
        settings.update({ mesh: { intervalMs: 5000 } }).applied.mesh.intervalMs,
        5000,
      );
      assert.strictEqual(
        settings.update({ watchdog: { thresholdMs: 3600000 } }).applied.watchdog.thresholdMs,
        3600000,
      );
    });

    it("rejects bad booleans, ntfy topics, and webhook events", () => {
      const settings = createSettings({ configPath });
      assert.throws(() => settings.update({ alerts: { enabled: "yes" } }), /boolean/);
      assert.throws(() => settings.update({ validationGate: { default: 1 } }), /boolean/);
      assert.throws(
        () => settings.update({ alerts: { sinks: { ntfy: { topic: "has spaces!" } } } }),
        /topic/,
      );
      assert.throws(
        () =>
          settings.update({
            alerts: {
              sinks: { webhooks: { add: [{ url: "https://h.example", events: ["nope"] }] } },
            },
          }),
        /unknown event/,
      );
    });

    it("does not write the file when validation fails", () => {
      const settings = createSettings({ configPath });
      assert.throws(() => settings.update({ mesh: { intervalMs: 1 } }));
      assert.strictEqual(fs.existsSync(configPath), false);
    });
  });

  describe("update() merge behavior", () => {
    it("preserves unrelated config (cortex paths, non-fleet sections) on write", () => {
      writeConfig({
        server: { port: 4444 },
        fleet: {
          cortex: { gbrainCli: "/home/u/gbrain/bin/gbrain-cli", lcmDb: "/home/u/lcm.db" },
          stateDir: "custom-state",
        },
      });
      const settings = createSettings({ configPath });
      settings.update({ mesh: { intervalMs: 20000 } });

      const onDisk = readConfig();
      assert.strictEqual(onDisk.server.port, 4444);
      assert.strictEqual(onDisk.fleet.cortex.gbrainCli, "/home/u/gbrain/bin/gbrain-cli");
      assert.strictEqual(onDisk.fleet.cortex.lcmDb, "/home/u/lcm.db");
      assert.strictEqual(onDisk.fleet.stateDir, "custom-state");
      assert.strictEqual(onDisk.fleet.mesh.intervalMs, 20000);
    });

    it("writes atomically: valid JSON on disk, no tmp file left behind", () => {
      const settings = createSettings({ configPath });
      settings.update({ alerts: { enabled: true } });

      assert.doesNotThrow(() => readConfig());
      const leftovers = fs.readdirSync(tmpDir).filter((f) => f.includes(".tmp-"));
      assert.deepStrictEqual(leftovers, []);
    });

    it("deep-merges patches without clobbering sibling settings", () => {
      const settings = createSettings({ configPath });
      settings.update({ alerts: { sinks: { ntfy: { enabled: true, topic: "ops" } } } });
      settings.update({ alerts: { sinks: { slack: { enabled: true, channel: "#ops" } } } });
      settings.update({ alerts: { rules: { taskFailed: false } } });

      const result = settings.get();
      assert.strictEqual(result.alerts.sinks.ntfy.topic, "ops"); // survived later patches
      assert.strictEqual(result.alerts.sinks.slack.channel, "#ops");
      assert.strictEqual(result.alerts.rules.taskFailed, false);
      assert.strictEqual(result.alerts.rules.nodeOffline, true);
    });

    it("does not rewrite the file for a no-op patch", () => {
      writeConfig({ fleet: { mesh: { intervalMs: 15000 } } });
      const before = fs.statSync(configPath).mtimeMs;
      const settings = createSettings({ configPath });
      const result = settings.update({ mesh: { intervalMs: 15000 } });

      assert.deepStrictEqual(result.restartRequired, []);
      assert.strictEqual(fs.statSync(configPath).mtimeMs, before);
    });
  });

  describe("webhook operations", () => {
    it("add: generates an id, persists the secret, never returns it", () => {
      const settings = createSettings({ configPath });
      const { applied } = settings.update({
        alerts: {
          sinks: {
            webhooks: {
              add: [{ url: "https://hook.example/1", secret: "hush", events: ["taskFailed"] }],
            },
          },
        },
      });

      const [webhook] = applied.alerts.sinks.webhooks;
      assert.match(webhook.id, /^wh_[0-9a-f]{10}$/);
      assert.strictEqual(webhook.url, "https://hook.example/1");
      assert.strictEqual(webhook.hasSecret, true);
      assert.deepStrictEqual(webhook.events, ["taskFailed"]);
      assert.ok(!JSON.stringify(applied).includes("hush"), "secret leaked in applied");

      // Secret IS persisted server-side (write-only contract).
      const onDisk = readConfig().fleet.alerts.sinks.webhooks[0];
      assert.strictEqual(onDisk.secret, "hush");
      assert.strictEqual(onDisk.id, webhook.id);
    });

    it("add: defaults events to ['*']", () => {
      const settings = createSettings({ configPath });
      const { applied } = settings.update({
        alerts: { sinks: { webhooks: { add: [{ url: "https://hook.example/1" }] } } },
      });
      assert.deepStrictEqual(applied.alerts.sinks.webhooks[0].events, ["*"]);
    });

    it("update by id: replaces the secret and events; null clears the secret", () => {
      const settings = createSettings({ configPath });
      const added = settings.update({
        alerts: {
          sinks: { webhooks: { add: [{ url: "https://hook.example/1", secret: "old" }] } },
        },
      });
      const id = added.applied.alerts.sinks.webhooks[0].id;

      const replaced = settings.update({
        alerts: {
          sinks: { webhooks: { update: [{ id, secret: "new", events: ["nodeOffline"] }] } },
        },
      });
      const webhook = replaced.applied.alerts.sinks.webhooks[0];
      assert.strictEqual(webhook.hasSecret, true);
      assert.deepStrictEqual(webhook.events, ["nodeOffline"]);
      assert.strictEqual(readConfig().fleet.alerts.sinks.webhooks[0].secret, "new");

      const cleared = settings.update({
        alerts: { sinks: { webhooks: { update: [{ id, secret: null }] } } },
      });
      assert.strictEqual(cleared.applied.alerts.sinks.webhooks[0].hasSecret, false);
      assert.strictEqual(readConfig().fleet.alerts.sinks.webhooks[0].secret, undefined);
    });

    it("remove by id deletes only that webhook", () => {
      const settings = createSettings({ configPath });
      const added = settings.update({
        alerts: {
          sinks: {
            webhooks: {
              add: [{ url: "https://hook.example/1" }, { url: "https://hook.example/2" }],
            },
          },
        },
      });
      const [first, second] = added.applied.alerts.sinks.webhooks;

      const { applied } = settings.update({
        alerts: { sinks: { webhooks: { remove: [first.id] } } },
      });
      assert.deepStrictEqual(
        applied.alerts.sinks.webhooks.map((w) => w.id),
        [second.id],
      );
    });

    it("rejects operations against unknown ids", () => {
      const settings = createSettings({ configPath });
      assert.throws(
        () => settings.update({ alerts: { sinks: { webhooks: { remove: ["wh_nope"] } } } }),
        /Unknown webhook id/,
      );
      assert.throws(
        () =>
          settings.update({
            alerts: { sinks: { webhooks: { update: [{ id: "wh_nope", secret: "x" }] } } },
          }),
        /Unknown webhook id/,
      );
    });

    it("rejects empty-string secrets (write-only set/replace contract)", () => {
      const settings = createSettings({ configPath });
      assert.throws(
        () =>
          settings.update({
            alerts: { sinks: { webhooks: { add: [{ url: "https://h.example", secret: "" }] } } },
          }),
        /secret/,
      );
    });
  });

  describe("restartRequired semantics", () => {
    it("interval/threshold/gate changes always require a restart", () => {
      const settings = createSettings({ configPath });
      const result = settings.update({
        mesh: { intervalMs: 10000 },
        federation: { intervalMs: 45000 },
        watchdog: { thresholdMs: 900000 },
        validationGate: { default: false },
      });
      assert.deepStrictEqual(result.restartRequired.sort(), [
        "federation.intervalMs",
        "mesh.intervalMs",
        "validationGate.default",
        "watchdog.thresholdMs",
      ]);
    });

    it("without an onChange hook, alerts changes are reported as restartRequired", () => {
      const settings = createSettings({ configPath });
      const result = settings.update({ alerts: { enabled: true } });
      assert.deepStrictEqual(result.restartRequired, ["alerts.enabled"]);
    });

    it("with an onChange hook, alerts changes hot-apply and invoke the hook", () => {
      const received = [];
      const settings = createSettings({ configPath, onChange: (cfg) => received.push(cfg) });
      const result = settings.update({
        alerts: { enabled: true, sinks: { ntfy: { enabled: true, topic: "ops" } } },
      });

      assert.deepStrictEqual(result.restartRequired, []);
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0].enabled, true);
      assert.strictEqual(received[0].sinks.ntfy.topic, "ops");
    });

    it("does not invoke onChange for non-alerts changes", () => {
      const received = [];
      const settings = createSettings({ configPath, onChange: (cfg) => received.push(cfg) });
      const result = settings.update({ mesh: { intervalMs: 20000 } });

      assert.deepStrictEqual(result.restartRequired, ["mesh.intervalMs"]);
      assert.strictEqual(received.length, 0);
    });

    it("a throwing onChange hook never fails the update", () => {
      const settings = createSettings({
        configPath,
        onChange: () => {
          throw new Error("reload exploded");
        },
      });
      const result = settings.update({ alerts: { enabled: true } });
      assert.deepStrictEqual(result.restartRequired, []);
      assert.strictEqual(settings.get().alerts.enabled, true);
    });
  });

  describe("getAlertsConfig()", () => {
    it("returns the UNREDACTED effective alerts config for engine rewiring", () => {
      writeConfig({
        fleet: {
          alerts: {
            enabled: true,
            sinks: {
              ntfy: { enabled: true, topic: "ops" },
              webhooks: [{ id: "wh_aaa", url: "https://hook.example/1", secret: "hush" }],
            },
          },
        },
      });
      const settings = createSettings({ configPath });
      const cfg = settings.getAlertsConfig();

      assert.strictEqual(cfg.enabled, true);
      assert.strictEqual(cfg.sinks.ntfy.server, "https://ntfy.sh"); // defaults filled
      assert.strictEqual(cfg.sinks.webhooks[0].secret, "hush"); // secrets intact for HMAC
      assert.deepStrictEqual(cfg.rules, {
        nodeOffline: true,
        nodeUnreachable: true,
        taskFailed: true,
        taskStale: true,
        lessonPending: true,
      });
    });
  });
});
