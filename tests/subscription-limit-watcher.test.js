const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  createSubscriptionLimitWatcher,
  normalizeConfig,
  DEFAULT_WARN_PCT,
  DEFAULT_CRITICAL_PCT,
} = require("../src/subscription-limit-watcher");

const ENABLED = { enabled: true, warnPct: 80, criticalPct: 95, pollIntervalMs: 60000 };

/** Build a watcher whose windows come from a mutable array. */
function harness(windowsRef, configOverride = {}) {
  const alerts = [];
  const watcher = createSubscriptionLimitWatcher({
    config: { ...ENABLED, ...configOverride },
    getProviderWindows: () => windowsRef.value,
    onAlert: (event) => alerts.push(event),
    log: { error: () => {}, warn: () => {} },
  });
  return { watcher, alerts };
}

describe("subscription-limit-watcher", () => {
  describe("normalizeConfig", () => {
    it("defaults to disabled with 80/95 thresholds and a 5-min poll", () => {
      const cfg = normalizeConfig(undefined);
      assert.strictEqual(cfg.enabled, false);
      assert.strictEqual(cfg.warnPct, DEFAULT_WARN_PCT);
      assert.strictEqual(cfg.criticalPct, DEFAULT_CRITICAL_PCT);
      assert.strictEqual(cfg.pollIntervalMs, 5 * 60 * 1000);
    });

    it("rejects out-of-range thresholds and a sub-floor poll interval", () => {
      const cfg = normalizeConfig({ enabled: true, warnPct: 0, criticalPct: 250, pollIntervalMs: 5 });
      assert.strictEqual(cfg.warnPct, DEFAULT_WARN_PCT);
      assert.strictEqual(cfg.criticalPct, DEFAULT_CRITICAL_PCT);
      assert.strictEqual(cfg.pollIntervalMs, 5 * 60 * 1000);
    });

    it("forces critical >= warn", () => {
      const cfg = normalizeConfig({ enabled: true, warnPct: 90, criticalPct: 50 });
      assert.ok(cfg.criticalPct >= cfg.warnPct);
    });
  });

  it("does nothing while disabled", async () => {
    const ref = { value: [{ provider: "claude", window: "5h", utilizationPct: 99, stale: false }] };
    const alerts = [];
    const watcher = createSubscriptionLimitWatcher({
      config: { enabled: false },
      getProviderWindows: () => ref.value,
      onAlert: (e) => alerts.push(e),
    });
    const res = await watcher.evaluate();
    assert.strictEqual(res.checked, false);
    assert.strictEqual(alerts.length, 0);
  });

  it("fires warn once at >=80% and does not re-fire on the same threshold", async () => {
    const ref = { value: [{ provider: "claude", window: "5h", utilizationPct: 82, stale: false }] };
    const { watcher, alerts } = harness(ref);

    await watcher.evaluate();
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].severity, "warn");
    assert.strictEqual(alerts[0].type, "subscriptionLimit");
    assert.strictEqual(alerts[0].provider, "claude");
    assert.strictEqual(alerts[0].window, "5h");

    // Same window still hot — must NOT re-fire.
    ref.value = [{ provider: "claude", window: "5h", utilizationPct: 88, stale: false }];
    await watcher.evaluate();
    assert.strictEqual(alerts.length, 1, "warn re-fired while staying in warn band");
  });

  it("escalates warn -> critical exactly once, then holds", async () => {
    const ref = { value: [{ provider: "codex", window: "7d", utilizationPct: 81, stale: false }] };
    const { watcher, alerts } = harness(ref);

    await watcher.evaluate(); // warn
    ref.value = [{ provider: "codex", window: "7d", utilizationPct: 96, stale: false }];
    await watcher.evaluate(); // critical
    ref.value = [{ provider: "codex", window: "7d", utilizationPct: 98, stale: false }];
    await watcher.evaluate(); // hold

    assert.strictEqual(alerts.length, 2);
    assert.deepStrictEqual(
      alerts.map((a) => a.severity),
      ["warn", "critical"],
    );
  });

  it("re-fires after the window drops below warn and crosses again", async () => {
    const ref = { value: [{ provider: "claude", window: "5h", utilizationPct: 85, stale: false }] };
    const { watcher, alerts } = harness(ref);

    await watcher.evaluate(); // warn
    ref.value = [{ provider: "claude", window: "5h", utilizationPct: 40, stale: false }];
    await watcher.evaluate(); // clears latch, no alert
    ref.value = [{ provider: "claude", window: "5h", utilizationPct: 84, stale: false }];
    await watcher.evaluate(); // crosses again -> warn

    assert.strictEqual(alerts.length, 2);
    assert.deepStrictEqual(
      alerts.map((a) => a.severity),
      ["warn", "warn"],
    );
  });

  it("suppresses alerts for stale data and counts it", async () => {
    const ref = { value: [{ provider: "claude", window: "5h", utilizationPct: 99, stale: true }] };
    const { watcher, alerts } = harness(ref);

    const res = await watcher.evaluate();
    assert.strictEqual(alerts.length, 0, "fired off stale data");
    assert.strictEqual(res.skippedStale, 1);
    assert.strictEqual(res.fired, 0);
  });

  it("skips a missing/absent provider window instead of firing or crashing", async () => {
    const ref = {
      value: [
        { provider: "claude", window: "5h", utilizationPct: 90, stale: false },
        { provider: "codex", window: "7d", utilizationPct: null, stale: false }, // no data for codex
        { window: "5h", utilizationPct: 99, stale: false }, // no provider name
      ],
    };
    const { watcher, alerts } = harness(ref);

    const res = await watcher.evaluate();
    assert.strictEqual(alerts.length, 1, "only the provider with real data should alert");
    assert.strictEqual(alerts[0].provider, "claude");
    assert.strictEqual(res.skippedMissing, 2);
    assert.strictEqual(res.fired, 1);
  });

  it("tolerates a non-array provider result without throwing", async () => {
    const ref = { value: null };
    const { watcher, alerts } = harness(ref);
    const res = await watcher.evaluate();
    assert.strictEqual(res.checked, false);
    assert.strictEqual(alerts.length, 0);
  });

  it("never lets a throwing onAlert abort the evaluation loop", async () => {
    const watcher = createSubscriptionLimitWatcher({
      config: ENABLED,
      getProviderWindows: () => [
        { provider: "claude", window: "5h", utilizationPct: 99, stale: false },
        { provider: "codex", window: "7d", utilizationPct: 99, stale: false },
      ],
      onAlert: () => {
        throw new Error("sink down");
      },
      log: { error: () => {}, warn: () => {} },
    });
    const res = await watcher.evaluate();
    assert.strictEqual(res.checked, true);
    assert.strictEqual(res.fired, 2);
  });

  it("getState reflects config and latch progress", async () => {
    const ref = { value: [{ provider: "claude", window: "5h", utilizationPct: 96, stale: false }] };
    const { watcher } = harness(ref);
    await watcher.evaluate();
    const state = watcher.getState();
    assert.strictEqual(state.enabled, true);
    assert.strictEqual(state.warnPct, 80);
    assert.strictEqual(state.criticalPct, 95);
    assert.strictEqual(state.latched["claude::5h"], 2); // critical rank
  });

  it("applyConfig can disable a running watcher", () => {
    const ref = { value: [{ provider: "claude", window: "5h", utilizationPct: 90, stale: false }] };
    const { watcher } = harness(ref);
    watcher.applyConfig({ enabled: false });
    assert.strictEqual(watcher.getState().enabled, false);
    assert.strictEqual(watcher.getState().running, false);
  });
});
