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
        nodeRecovered: true,
        taskFailed: true,
        taskStale: true,
        lessonPending: true,
        budgetBreach: true,
        dispatchComplete: false,
      });
      assert.deepStrictEqual(result.alerts.flap, { consecutive: 3, minDurationMs: 60000 });
      assert.deepStrictEqual(result.alerts.mutes, []);
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

  describe("flap config (alerts.flap)", () => {
    it("accepts a valid flap patch and merges per-field", () => {
      const settings = createSettings({ configPath });
      settings.update({ alerts: { flap: { consecutive: 5 } } });
      assert.deepStrictEqual(settings.get().alerts.flap, { consecutive: 5, minDurationMs: 60000 });

      settings.update({ alerts: { flap: { minDurationMs: 120000 } } });
      assert.deepStrictEqual(settings.get().alerts.flap, {
        consecutive: 5, // survived the second patch
        minDurationMs: 120000,
      });
    });

    it("rejects out-of-bounds, non-integer, unknown-key, and empty flap patches", () => {
      const settings = createSettings({ configPath });
      assert.throws(() => settings.update({ alerts: { flap: { consecutive: 0 } } }), /consecutive/);
      assert.throws(
        () => settings.update({ alerts: { flap: { consecutive: 21 } } }),
        /consecutive/,
      );
      assert.throws(
        () => settings.update({ alerts: { flap: { consecutive: 2.5 } } }),
        /consecutive/,
      );
      assert.throws(
        () => settings.update({ alerts: { flap: { minDurationMs: -1 } } }),
        /minDurationMs/,
      );
      assert.throws(
        () => settings.update({ alerts: { flap: { minDurationMs: 3600001 } } }),
        /minDurationMs/,
      );
      assert.throws(() => settings.update({ alerts: { flap: { bogus: 1 } } }), /unknown key/);
      assert.throws(() => settings.update({ alerts: { flap: {} } }), /flap/);
    });

    it("accepts boundary values (1 consecutive, 0ms / 1h duration)", () => {
      const settings = createSettings({ configPath });
      settings.update({ alerts: { flap: { consecutive: 1, minDurationMs: 0 } } });
      assert.deepStrictEqual(settings.get().alerts.flap, { consecutive: 1, minDurationMs: 0 });
      settings.update({ alerts: { flap: { consecutive: 20, minDurationMs: 3600000 } } });
      assert.deepStrictEqual(settings.get().alerts.flap, {
        consecutive: 20,
        minDurationMs: 3600000,
      });
    });
  });

  describe("mutes (alerts.mutes)", () => {
    it("accepts node / rule / rule+node mutes and normalizes until to ISO", () => {
      const settings = createSettings({ configPath });
      settings.update({
        alerts: {
          mutes: [
            { node: "hermes-1", until: "2030-01-01T00:00:00.000Z" },
            { rule: "taskStale" },
            { rule: "nodeOffline", node: "drone-2", until: 1893456000000 },
          ],
        },
      });

      const mutes = settings.get().alerts.mutes;
      assert.strictEqual(mutes.length, 3);
      assert.deepStrictEqual(mutes[0], { node: "hermes-1", until: "2030-01-01T00:00:00.000Z" });
      assert.deepStrictEqual(mutes[1], { rule: "taskStale" });
      assert.strictEqual(mutes[2].until, new Date(1893456000000).toISOString());
      // getAlertsConfig carries mutes to the engine
      assert.strictEqual(settings.getAlertsConfig().mutes.length, 3);
    });

    it("PATCH replaces the whole mutes array (unmute = send the list minus the entry)", () => {
      const settings = createSettings({ configPath });
      settings.update({ alerts: { mutes: [{ node: "a" }, { node: "b" }] } });
      settings.update({ alerts: { mutes: [{ node: "b" }] } });
      assert.deepStrictEqual(settings.get().alerts.mutes, [{ node: "b" }]);
      settings.update({ alerts: { mutes: [] } });
      assert.deepStrictEqual(settings.get().alerts.mutes, []);
    });

    it("rejects malformed mute entries", () => {
      const settings = createSettings({ configPath });
      assert.throws(() => settings.update({ alerts: { mutes: "nope" } }), /array/);
      assert.throws(() => settings.update({ alerts: { mutes: [{}] } }), /rule and\/or node/);
      assert.throws(
        () => settings.update({ alerts: { mutes: [{ rule: "noSuchRule" }] } }),
        /unknown rule/,
      );
      assert.throws(() => settings.update({ alerts: { mutes: [{ node: "" }] } }), /node/);
      assert.throws(
        () => settings.update({ alerts: { mutes: [{ node: "x".repeat(121) }] } }),
        /node/,
      );
      assert.throws(
        () => settings.update({ alerts: { mutes: [{ node: "a", until: "not-a-date" }] } }),
        /until/,
      );
      assert.throws(
        () => settings.update({ alerts: { mutes: [{ node: "a", extra: 1 }] } }),
        /unknown key/,
      );
      const tooMany = Array.from({ length: 51 }, (_, i) => ({ node: `n${i}` }));
      assert.throws(() => settings.update({ alerts: { mutes: tooMany } }), /Too many mutes/);
    });

    it("hot-applies flap + mutes changes through onChange (no restart required)", () => {
      const received = [];
      const settings = createSettings({ configPath, onChange: (cfg) => received.push(cfg) });

      const result = settings.update({
        alerts: { flap: { consecutive: 4 }, mutes: [{ node: "hermes-1" }] },
      });
      assert.deepStrictEqual(result.restartRequired, []);
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0].flap.consecutive, 4);
      assert.deepStrictEqual(received[0].mutes, [{ node: "hermes-1" }]);
      // nodeRecovered rule exists and is patchable
      settings.update({ alerts: { rules: { nodeRecovered: false } } });
      assert.strictEqual(settings.get().alerts.rules.nodeRecovered, false);
      assert.strictEqual(received[1].rules.nodeRecovered, false);
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
        nodeRecovered: true,
        taskFailed: true,
        taskStale: true,
        lessonPending: true,
        budgetBreach: true,
        dispatchComplete: false,
      });
      assert.deepStrictEqual(cfg.flap, { consecutive: 3, minDurationMs: 60000 }); // engine-ready
      assert.deepStrictEqual(cfg.mutes, []);
    });
  });

  describe("budgets (fleet.budgets)", () => {
    it("get() returns budgets defaults when nothing is persisted", () => {
      const settings = createSettings({ configPath });
      assert.deepStrictEqual(settings.get().budgets, {
        enabled: false,
        daily: { totalUSD: 0, perProvider: {} },
        weekly: { totalUSD: 0, perProvider: {} },
        checkIntervalMs: 900000,
        enforce: { enabled: false },
      });
    });

    it("accepts a full valid budgets patch and persists it", () => {
      const settings = createSettings({ configPath });
      const { applied, restartRequired } = settings.update({
        budgets: {
          enabled: true,
          daily: { totalUSD: 10, perProvider: { kimi: 5, openrouter: 2.5 } },
          weekly: { totalUSD: 50 },
          checkIntervalMs: 60000,
        },
      });

      assert.deepStrictEqual(applied.budgets, {
        enabled: true,
        daily: { totalUSD: 10, perProvider: { kimi: 5, openrouter: 2.5 } },
        weekly: { totalUSD: 50, perProvider: {} },
        checkIntervalMs: 60000,
        enforce: { enabled: false },
      });
      // No onBudgetsChange hook → honestly restartRequired.
      assert.ok(restartRequired.some((p) => p.startsWith("budgets.")));
      assert.deepStrictEqual(readConfig().fleet.budgets.daily.perProvider, {
        kimi: 5,
        openrouter: 2.5,
      });
    });

    it("perProvider is a FULL replacement; totalUSD merges per-field", () => {
      writeConfig({
        fleet: {
          budgets: {
            enabled: true,
            daily: { totalUSD: 10, perProvider: { kimi: 5, openrouter: 2 } },
          },
        },
      });
      const settings = createSettings({ configPath });
      const { applied } = settings.update({
        budgets: { daily: { perProvider: { kimi: 7 } } },
      });
      assert.deepStrictEqual(applied.budgets.daily, {
        totalUSD: 10, // untouched
        perProvider: { kimi: 7 }, // openrouter entry dropped (full replacement)
      });
    });

    it("rejects malformed budgets patches", () => {
      const settings = createSettings({ configPath });
      const bad = [
        { budgets: {} },
        { budgets: { enabled: "yes" } },
        { budgets: { nope: true } },
        { budgets: { daily: {} } },
        { budgets: { daily: { totalUSD: -1 } } },
        { budgets: { daily: { totalUSD: "10" } } },
        { budgets: { daily: { totalUSD: Infinity } } },
        { budgets: { daily: { perProvider: { kimi: 0 } } } },
        { budgets: { daily: { perProvider: { "bad\nname": 5 } } } },
        { budgets: { daily: { perProvider: 5 } } },
        { budgets: { weekly: { totalUSD: 1000001 } } },
        { budgets: { checkIntervalMs: 59999 } },
        { budgets: { checkIntervalMs: 86400001 } },
        { budgets: { checkIntervalMs: 900000.5 } },
      ];
      for (const patch of bad) {
        assert.throws(() => settings.update(patch), { statusCode: 400 }, JSON.stringify(patch));
      }
    });

    it("rejects more than 50 perProvider entries", () => {
      const settings = createSettings({ configPath });
      const perProvider = {};
      for (let i = 0; i < 51; i++) perProvider[`prov${i}`] = 1;
      assert.throws(() => settings.update({ budgets: { daily: { perProvider } } }), {
        statusCode: 400,
      });
    });

    it("hot-applies budgets changes through onBudgetsChange (no restart required)", () => {
      const calls = [];
      const settings = createSettings({
        configPath,
        onBudgetsChange: (cfg) => calls.push(cfg),
      });
      const { restartRequired } = settings.update({
        budgets: { enabled: true, daily: { totalUSD: 25 } },
      });
      assert.deepStrictEqual(restartRequired, []);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].enabled, true);
      assert.strictEqual(calls[0].daily.totalUSD, 25);
    });

    it("does not invoke onBudgetsChange for non-budgets changes", () => {
      const calls = [];
      const settings = createSettings({ configPath, onBudgetsChange: () => calls.push(1) });
      settings.update({ alerts: { enabled: true } });
      assert.strictEqual(calls.length, 0);
    });

    it("getBudgetsConfig() returns the effective engine-ready budgets config", () => {
      writeConfig({ fleet: { budgets: { enabled: true, weekly: { totalUSD: 99 } } } });
      const settings = createSettings({ configPath });
      const cfg = settings.getBudgetsConfig();
      assert.strictEqual(cfg.enabled, true);
      assert.strictEqual(cfg.weekly.totalUSD, 99);
      assert.strictEqual(cfg.checkIntervalMs, 900000); // default filled
    });
  });

  describe("1Password refs (op://...)", () => {
    it("accepts op:// refs for slack.gatewayUrl and ntfy.topic", () => {
      const settings = createSettings({ configPath });
      const { applied } = settings.update({
        alerts: {
          sinks: {
            slack: { gatewayUrl: "op://Vault/slack-gateway/url" },
            ntfy: { topic: "op://Vault/ntfy/topic" },
          },
        },
      });
      // Refs are not secrets — returned verbatim for the UI badge.
      assert.strictEqual(applied.alerts.sinks.slack.gatewayUrl, "op://Vault/slack-gateway/url");
      assert.strictEqual(applied.alerts.sinks.ntfy.topic, "op://Vault/ntfy/topic");
    });

    it("still rejects non-ref malformed gateway URLs and topics", () => {
      const settings = createSettings({ configPath });
      assert.throws(
        () => settings.update({ alerts: { sinks: { slack: { gatewayUrl: "op:/typo/ref" } } } }),
        { statusCode: 400 },
      );
      assert.throws(
        () => settings.update({ alerts: { sinks: { ntfy: { topic: "not/a/valid topic" } } } }),
        { statusCode: 400 },
      );
    });

    it("webhook secret stored as an op:// ref exposes secretRef (and never a literal secret)", () => {
      const settings = createSettings({ configPath });
      settings.update({
        alerts: {
          sinks: {
            webhooks: {
              add: [
                { url: "https://hook.example/op", secret: "op://Vault/hook/secret" },
                { url: "https://hook.example/literal", secret: "hush-literal" },
              ],
            },
          },
        },
      });
      const [opHook, literalHook] = settings.get().alerts.sinks.webhooks;
      assert.strictEqual(opHook.hasSecret, true);
      assert.strictEqual(opHook.secretRef, "op://Vault/hook/secret");
      assert.strictEqual(literalHook.hasSecret, true);
      assert.strictEqual(literalHook.secretRef, undefined);
      assert.ok(!JSON.stringify(settings.get()).includes("hush-literal"));
    });
  });
});

// ---------------------------------------------------------------------------
// Alert rule sink routing (alerts.routing) — v2 alert-rules-ui
// ---------------------------------------------------------------------------

describe("alerts.routing (per-rule sink routing)", () => {
  const ALL_RULES = [
    "nodeOffline",
    "nodeUnreachable",
    "nodeRecovered",
    "taskFailed",
    "taskStale",
    "lessonPending",
    "budgetBreach",
    "dispatchComplete",
  ];

  it('get() defaults every rule to ["*"]', () => {
    const settings = createSettings({ configPath });
    const routing = settings.get().alerts.routing;
    assert.deepStrictEqual(Object.keys(routing).sort(), [...ALL_RULES].sort());
    for (const rule of ALL_RULES) {
      assert.deepStrictEqual(routing[rule], ["*"], `routing.${rule} should default to ["*"]`);
    }
  });

  it("applies and persists a per-rule routing patch", () => {
    const settings = createSettings({ configPath });
    const { applied } = settings.update({
      alerts: { routing: { nodeOffline: ["ntfy"], taskFailed: ["slack", "webhooks"] } },
    });
    assert.deepStrictEqual(applied.alerts.routing.nodeOffline, ["ntfy"]);
    assert.deepStrictEqual(applied.alerts.routing.taskFailed, ["slack", "webhooks"]);
    assert.deepStrictEqual(applied.alerts.routing.nodeRecovered, ["*"]); // untouched

    const onDisk = readConfig();
    assert.deepStrictEqual(onDisk.fleet.alerts.routing.nodeOffline, ["ntfy"]);

    // Survives a fresh service instance
    const reloaded = createSettings({ configPath }).get();
    assert.deepStrictEqual(reloaded.alerts.routing.nodeOffline, ["ntfy"]);
  });

  it("merges per rule: a later patch keeps earlier rules", () => {
    const settings = createSettings({ configPath });
    settings.update({ alerts: { routing: { nodeOffline: ["ntfy"] } } });
    const { applied } = settings.update({ alerts: { routing: { taskFailed: ["slack"] } } });
    assert.deepStrictEqual(applied.alerts.routing.nodeOffline, ["ntfy"]);
    assert.deepStrictEqual(applied.alerts.routing.taskFailed, ["slack"]);
  });

  it('normalizes "*" mixed with sink names to ["*"] and dedupes', () => {
    const settings = createSettings({ configPath });
    const { applied } = settings.update({
      alerts: { routing: { nodeOffline: ["*", "ntfy"], taskStale: ["ntfy", "ntfy", "slack"] } },
    });
    assert.deepStrictEqual(applied.alerts.routing.nodeOffline, ["*"]);
    assert.deepStrictEqual(applied.alerts.routing.taskStale, ["slack", "ntfy"]);
  });

  it("rejects garbage routing patches with 400-style errors", () => {
    const settings = createSettings({ configPath });
    const cases = [
      [{ alerts: { routing: { bogusRule: ["ntfy"] } } }, /unknown key "bogusRule"/],
      [{ alerts: { routing: { nodeOffline: ["smoke-signals"] } } }, /unknown sink/],
      [{ alerts: { routing: { nodeOffline: [] } } }, /non-empty array/],
      [{ alerts: { routing: { nodeOffline: "ntfy" } } }, /non-empty array/],
      [{ alerts: { routing: [] } }, /object/],
      [{ alerts: { routing: {} } }, /at least one rule/],
    ];
    for (const [patch, re] of cases) {
      assert.throws(() => settings.update(patch), re, JSON.stringify(patch));
      const err = (() => {
        try {
          settings.update(patch);
          return null;
        } catch (e) {
          return e;
        }
      })();
      assert.strictEqual(err.statusCode, 400);
    }
  });

  it("hot-applies routing changes through the onChange hook (no restart)", () => {
    let received = null;
    const settings = createSettings({ configPath, onChange: (cfg) => (received = cfg) });
    const { restartRequired } = settings.update({
      alerts: { routing: { nodeOffline: ["ntfy"] } },
    });
    assert.deepStrictEqual(restartRequired, []);
    assert.ok(received, "onChange should be invoked");
    assert.deepStrictEqual(received.routing.nodeOffline, ["ntfy"]);
  });

  it("normalizes hand-edited garbage in the config file to safe defaults", () => {
    writeConfig({
      fleet: {
        alerts: {
          routing: {
            nodeOffline: ["ntfy", "smoke-signals"],
            taskFailed: "nope",
            taskStale: [],
            unknownRule: ["slack"],
          },
        },
      },
    });
    const routing = createSettings({ configPath }).get().alerts.routing;
    assert.deepStrictEqual(routing.nodeOffline, ["ntfy"]); // unknown sink dropped
    assert.deepStrictEqual(routing.taskFailed, ["*"]); // non-array → default
    assert.deepStrictEqual(routing.taskStale, ["*"]); // empty → default
    assert.strictEqual(routing.unknownRule, undefined); // unknown rule dropped
  });
});
