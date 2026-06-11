/**
 * Unit tests for the v2.2 settings PATCH surface additions in
 * src/settings.js: the fleet.digest section (enabled/schedule/hourUtc/sinks)
 * and budgets.enforce, including hot-apply via the onDigestChange /
 * onBudgetsChange hooks and honest restartRequired reporting without them.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createSettings } = require("../src/settings");

let tmpDir;
let configPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofc-settings-digest-"));
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

describe("settings digest + budgets.enforce", () => {
  describe("digest (fleet.digest)", () => {
    it("get() returns digest defaults when nothing is persisted", () => {
      const settings = createSettings({ configPath });
      assert.deepStrictEqual(settings.get().digest, {
        enabled: false,
        schedule: "daily",
        hourUtc: 8,
        sinks: ["*"],
      });
    });

    it("accepts a full valid digest patch and persists it", () => {
      const settings = createSettings({ configPath });
      const { applied, restartRequired } = settings.update({
        digest: { enabled: true, schedule: "weekly", hourUtc: 6, sinks: ["ntfy", "webhooks"] },
      });
      assert.deepStrictEqual(applied.digest, {
        enabled: true,
        schedule: "weekly",
        hourUtc: 6,
        sinks: ["ntfy", "webhooks"],
      });
      // No onDigestChange hook → honestly restartRequired.
      assert.ok(restartRequired.some((p) => p.startsWith("digest.")));
      assert.deepStrictEqual(readConfig().fleet.digest.sinks, ["ntfy", "webhooks"]);
    });

    it("merges scalars per-field; sinks is a FULL replacement", () => {
      writeConfig({
        fleet: { digest: { enabled: true, schedule: "weekly", hourUtc: 6, sinks: ["ntfy"] } },
      });
      const settings = createSettings({ configPath });
      const { applied } = settings.update({ digest: { sinks: ["slack"] } });
      assert.deepStrictEqual(applied.digest, {
        enabled: true,
        schedule: "weekly",
        hourUtc: 6,
        sinks: ["slack"],
      });
    });

    it("hot-applies through onDigestChange (no restartRequired)", () => {
      const applied = [];
      const settings = createSettings({
        configPath,
        onDigestChange: (cfg) => applied.push(cfg),
      });
      const { restartRequired } = settings.update({ digest: { enabled: true } });
      assert.deepStrictEqual(restartRequired, []);
      assert.strictEqual(applied.length, 1);
      assert.deepStrictEqual(applied[0], {
        enabled: true,
        schedule: "daily",
        hourUtc: 8,
        sinks: ["*"],
      });
    });

    it("getDigestConfig() returns the effective section for the orchestrator", () => {
      writeConfig({ fleet: { digest: { enabled: true, hourUtc: 22 } } });
      const settings = createSettings({ configPath });
      assert.deepStrictEqual(settings.getDigestConfig(), {
        enabled: true,
        schedule: "daily",
        hourUtc: 22,
        sinks: ["*"],
      });
    });

    it("rejects malformed digest patches with 400-style errors", () => {
      const settings = createSettings({ configPath });
      for (const [patch, re] of [
        [{ digest: {} }, /at least one/],
        [{ digest: { schedule: "hourly" } }, /schedule/],
        [{ digest: { hourUtc: 24 } }, /hourUtc/],
        [{ digest: { hourUtc: 8.5 } }, /hourUtc/],
        [{ digest: { sinks: [] } }, /sinks/],
        [{ digest: { sinks: ["email"] } }, /unknown sink/],
        [{ digest: { enabled: "yes" } }, /boolean/],
        [{ digest: { bogus: 1 } }, /unknown key/],
      ]) {
        assert.throws(() => settings.update(patch), re, JSON.stringify(patch));
      }
    });

    it('collapses "*" mixed with named sinks to ["*"]', () => {
      const settings = createSettings({ configPath });
      const { applied } = settings.update({ digest: { sinks: ["ntfy", "*"] } });
      assert.deepStrictEqual(applied.digest.sinks, ["*"]);
    });
  });

  describe("budgets.enforce", () => {
    it("defaults to disabled and round-trips through a patch", () => {
      const settings = createSettings({ configPath });
      assert.deepStrictEqual(settings.get().budgets.enforce, { enabled: false });

      const { applied } = settings.update({ budgets: { enforce: { enabled: true } } });
      assert.deepStrictEqual(applied.budgets.enforce, { enabled: true });
      assert.deepStrictEqual(readConfig().fleet.budgets.enforce, { enabled: true });
      assert.deepStrictEqual(settings.getBudgetsConfig().enforce, { enabled: true });
    });

    it("hot-applies through onBudgetsChange with the enforce flag included", () => {
      const applied = [];
      const settings = createSettings({
        configPath,
        onBudgetsChange: (cfg) => applied.push(cfg),
      });
      const { restartRequired } = settings.update({
        budgets: { enabled: true, daily: { totalUSD: 10 }, enforce: { enabled: true } },
      });
      assert.deepStrictEqual(restartRequired, []);
      assert.strictEqual(applied.length, 1);
      assert.strictEqual(applied[0].enforce.enabled, true);
      assert.strictEqual(applied[0].daily.totalUSD, 10);
    });

    it("rejects malformed enforce patches", () => {
      const settings = createSettings({ configPath });
      assert.throws(() => settings.update({ budgets: { enforce: {} } }), /enforce\.enabled/);
      assert.throws(() => settings.update({ budgets: { enforce: { enabled: "yes" } } }), /boolean/);
      assert.throws(
        () => settings.update({ budgets: { enforce: { enabled: true, extra: 1 } } }),
        /unknown key/,
      );
    });
  });
});
