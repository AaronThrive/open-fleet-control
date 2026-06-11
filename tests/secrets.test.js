const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createSecrets, isSecretRef, DEFAULT_SECRET_KEYS } = require("../src/secrets");

const SECRET = "SUPERSECRET-hunter2";
const REF = "op://Vault/item/field";

/** Sync exec mock resolving every ref to SECRET; records calls. */
function makeExecSync({ value = SECRET, fail = null } = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (fail) throw fail;
    return `${value}\n`;
  };
  fn.calls = calls;
  return fn;
}

/** Async (callback-style) exec mock. */
function makeExecAsync({ value = SECRET, fail = null } = {}) {
  const calls = [];
  const fn = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts });
    setImmediate(() => {
      if (fail) cb(fail);
      else cb(null, `${value}\n`, "");
    });
  };
  fn.calls = calls;
  return fn;
}

describe("secrets module", () => {
  describe("isSecretRef()", () => {
    it("detects op:// references and rejects everything else", () => {
      assert.strictEqual(isSecretRef("op://Vault/item/field"), true);
      assert.strictEqual(isSecretRef("  op://Vault/item/field  "), true); // trimmed
      assert.strictEqual(isSecretRef("op://Vault/item/section/field"), true); // section refs
      // 1Password vault/item names may contain spaces ("CEO Scale").
      assert.strictEqual(isSecretRef("op://CEO Scale/OPENROUTER_API_KEY/credential"), true);
      assert.strictEqual(isSecretRef("op://Vault/My Item Name/field"), true);
      assert.strictEqual(isSecretRef("op:/Vault/item"), false);
      // A full <vault>/<item>/<field> path is required.
      assert.strictEqual(isSecretRef("op://Vault"), false);
      assert.strictEqual(isSecretRef("op://Vault/item"), false);
      assert.strictEqual(isSecretRef("https://example.com"), false);
      assert.strictEqual(isSecretRef("literal-secret"), false);
      assert.strictEqual(isSecretRef(""), false);
      assert.strictEqual(isSecretRef("op:// has spaces"), false);
      assert.strictEqual(isSecretRef(null), false);
      assert.strictEqual(isSecretRef(42), false);
    });
  });

  describe("resolveSync()", () => {
    it("passes non-ref values through without spawning anything", () => {
      const execSyncFn = makeExecSync();
      const secrets = createSecrets({ execSyncFn });
      assert.deepStrictEqual(secrets.resolveSync("plain-key"), {
        ok: true,
        ref: null,
        value: "plain-key",
      });
      assert.strictEqual(execSyncFn.calls.length, 0);
    });

    it("resolves an op:// ref via `op read --no-newline` with a timeout", () => {
      const execSyncFn = makeExecSync();
      const secrets = createSecrets({ execSyncFn, opPath: "/usr/bin/op" });
      const result = secrets.resolveSync(REF);
      assert.deepStrictEqual(result, { ok: true, ref: REF, value: SECRET });
      assert.strictEqual(execSyncFn.calls.length, 1);
      const call = execSyncFn.calls[0];
      assert.strictEqual(call.cmd, "/usr/bin/op");
      assert.deepStrictEqual(call.args, ["read", "--no-newline", REF]);
      assert.strictEqual(call.opts.timeout, 10000);
    });

    it("caches resolved refs and honors the TTL", () => {
      let now = 1000000;
      const execSyncFn = makeExecSync();
      const secrets = createSecrets({ execSyncFn, cacheTtlMs: 5000, nowFn: () => now });

      secrets.resolveSync(REF);
      secrets.resolveSync(REF);
      assert.strictEqual(execSyncFn.calls.length, 1); // cache hit

      now += 5001; // TTL expired
      secrets.resolveSync(REF);
      assert.strictEqual(execSyncFn.calls.length, 2);
    });

    it("returns {ok:false, ref, error} on op failure — never throws, never leaks", () => {
      const err = new Error("Command failed");
      err.status = 1;
      err.stdout = `${SECRET}-partial-leak`;
      err.stderr = "[ERROR] could not resolve item\nsecond line";
      const secrets = createSecrets({ execSyncFn: makeExecSync({ fail: err }) });

      const result = secrets.resolveSync(REF);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.ref, REF);
      assert.match(result.error, /exit 1/);
      assert.match(result.error, /could not resolve item/);
      assert.ok(!result.error.includes(SECRET), "error must not contain stdout/secret material");
      assert.ok(!result.error.includes("second line"), "only first stderr line is kept");
    });

    it("maps ENOENT to a friendly 'op CLI not found' error", () => {
      const err = new Error("spawn op ENOENT");
      err.code = "ENOENT";
      const secrets = createSecrets({ execSyncFn: makeExecSync({ fail: err }) });
      assert.strictEqual(secrets.resolveSync(REF).error, "op CLI not found");
    });
  });

  describe("resolve() (async)", () => {
    it("resolves refs and passes through literals", async () => {
      const execFn = makeExecAsync();
      const secrets = createSecrets({ execFn });
      assert.deepStrictEqual(await secrets.resolve("literal"), {
        ok: true,
        ref: null,
        value: "literal",
      });
      assert.deepStrictEqual(await secrets.resolve(REF), { ok: true, ref: REF, value: SECRET });
      assert.strictEqual(execFn.calls.length, 1);
    });

    it("single-flights concurrent resolutions of the same ref", async () => {
      const execFn = makeExecAsync();
      const secrets = createSecrets({ execFn });
      const [a, b] = await Promise.all([secrets.resolve(REF), secrets.resolve(REF)]);
      assert.strictEqual(a.value, SECRET);
      assert.strictEqual(b.value, SECRET);
      assert.strictEqual(execFn.calls.length, 1);
    });

    it("surfaces failures without leaking and shares the cache with resolveSync", async () => {
      const err = new Error("boom");
      err.status = 6;
      err.stdout = SECRET;
      const secrets = createSecrets({ execFn: makeExecAsync({ fail: err }), execSyncFn: makeExecSync() });
      const failed = await secrets.resolve(REF);
      assert.strictEqual(failed.ok, false);
      assert.ok(!JSON.stringify(failed).includes(SECRET));

      // Failures are not cached: the sync path can still succeed afterwards.
      assert.strictEqual(secrets.resolveSync(REF).value, SECRET);
      // …and the async path now serves the warmed cache without exec.
      const cached = await secrets.resolve(REF);
      assert.strictEqual(cached.value, SECRET);
    });
  });

  describe("resolveDeepSync()", () => {
    const config = Object.freeze({
      alerts: {
        sinks: {
          slack: { enabled: true, gatewayUrl: "op://Vault/slack/url", channel: "#ops" },
          ntfy: { enabled: true, server: "https://ntfy.sh", topic: "op://Vault/ntfy/topic" },
          webhooks: [
            { id: "wh_1", url: "https://hook.example", secret: "op://Vault/hook/secret" },
            { id: "wh_2", url: "https://hook2.example", secret: "literal-hmac" },
          ],
        },
      },
      usage: { openrouterKey: "op://Vault/openrouter/key", nineRouterDb: "op://looks-like-ref" },
      // Not on the legacy key allowlist — must still resolve (any string).
      custom: { ntfyToken: "op://Vault/ntfy/token" },
      mesh: { intervalMs: 15000 },
    });

    it("resolves any op:// string value (no key allowlist), never mutates the input", () => {
      const secrets = createSecrets({ execSyncFn: makeExecSync() });
      const { value, failures } = secrets.resolveDeepSync(config);

      assert.deepStrictEqual(failures, []);
      assert.strictEqual(value.alerts.sinks.slack.gatewayUrl, SECRET);
      assert.strictEqual(value.alerts.sinks.ntfy.topic, SECRET);
      assert.strictEqual(value.alerts.sinks.webhooks[0].secret, SECRET);
      assert.strictEqual(value.alerts.sinks.webhooks[1].secret, "literal-hmac");
      assert.strictEqual(value.usage.openrouterKey, SECRET);
      // Resolution is keyed on the VALUE shape, not the key name.
      assert.strictEqual(value.custom.ntfyToken, SECRET);
      // Not a full op://<vault>/<item>/<field> ref: left alone.
      assert.strictEqual(value.usage.nineRouterDb, "op://looks-like-ref");
      assert.strictEqual(value.mesh.intervalMs, 15000);
      // input untouched
      assert.strictEqual(config.alerts.sinks.slack.gatewayUrl, "op://Vault/slack/url");
    });

    it("short-circuits (no exec, same object) when no refs are present", () => {
      const execSyncFn = makeExecSync();
      const secrets = createSecrets({ execSyncFn });
      const plain = { alerts: { sinks: { slack: { gatewayUrl: "https://gw.example" } } } };
      const { value, failures } = secrets.resolveDeepSync(plain);
      assert.strictEqual(value, plain);
      assert.deepStrictEqual(failures, []);
      assert.strictEqual(execSyncFn.calls.length, 0);
    });

    it("on failure: the literal op:// ref stays in place; failures list {path, ref, error} without the secret", () => {
      const err = new Error("denied");
      err.status = 1;
      err.stdout = SECRET;
      const secrets = createSecrets({ execSyncFn: makeExecSync({ fail: err }) });
      const { value, failures } = secrets.resolveDeepSync(config);

      // Failed refs keep the obviously-invalid op:// literal (never undefined/"").
      assert.strictEqual(value.alerts.sinks.slack.gatewayUrl, "op://Vault/slack/url");
      assert.strictEqual(value.usage.openrouterKey, "op://Vault/openrouter/key");
      assert.strictEqual(failures.length, 5);
      const paths = failures.map((f) => f.path);
      assert.ok(paths.includes("alerts.sinks.slack.gatewayUrl"));
      assert.ok(paths.includes("alerts.sinks.webhooks[0].secret"));
      assert.ok(paths.includes("usage.openrouterKey"));
      assert.ok(paths.includes("custom.ntfyToken"));
      assert.ok(!JSON.stringify(failures).includes(SECRET));
    });

    it("respects an explicit key allowlist when one is provided", () => {
      const secrets = createSecrets({ execSyncFn: makeExecSync() });
      const { value } = secrets.resolveDeepSync(config, ["openrouterKey"]);
      assert.strictEqual(value.usage.openrouterKey, SECRET);
      assert.strictEqual(value.alerts.sinks.slack.gatewayUrl, "op://Vault/slack/url");
    });
  });

  describe("resolveDeep() (async)", () => {
    it("resolves distinct refs concurrently and matches the sync walk", async () => {
      const execFn = makeExecAsync();
      const secrets = createSecrets({ execFn });
      const obj = {
        usage: { openrouterKey: "op://Vault/openrouter/key" },
        federation: { remotes: [{ token: "op://Vault/remote/token" }] },
      };
      const { value, failures } = await secrets.resolveDeep(obj);
      assert.deepStrictEqual(failures, []);
      assert.strictEqual(value.usage.openrouterKey, SECRET);
      assert.strictEqual(value.federation.remotes[0].token, SECRET);
      assert.strictEqual(execFn.calls.length, 2);
    });
  });

  describe("getStatus()", () => {
    it("summarizes refs configured / ok / failed and exposes per-ref entries, NEVER values", () => {
      const failure = new Error("denied");
      failure.status = 1;
      failure.stdout = SECRET;
      let failNext = false;
      const execSyncFn = () => {
        if (failNext) throw failure;
        return `${SECRET}\n`;
      };
      const secrets = createSecrets({ execSyncFn });

      secrets.resolveSync(REF);
      failNext = true;
      secrets.resolveSync("op://Vault/other/field");

      const status = secrets.getStatus();
      assert.strictEqual(status.configured, 2);
      assert.strictEqual(status.ok, 1);
      assert.strictEqual(status.failed, 1);
      assert.strictEqual(status.refs.length, 2);
      const okEntry = status.refs.find((r) => r.ref === REF);
      assert.strictEqual(okEntry.ok, true);
      assert.strictEqual(okEntry.error, null);
      const failedEntry = status.refs.find((r) => r.ref === "op://Vault/other/field");
      assert.strictEqual(failedEntry.ok, false);
      assert.match(failedEntry.error, /exit 1/);
      assert.ok(!JSON.stringify(status).includes(SECRET));
    });

    it("starts empty when nothing has been resolved", () => {
      const secrets = createSecrets({ execSyncFn: makeExecSync() });
      assert.deepStrictEqual(secrets.getStatus(), { configured: 0, ok: 0, failed: 0, refs: [] });
    });
  });

  describe("DEFAULT_SECRET_KEYS", () => {
    it("covers the documented secret-bearing config keys", () => {
      for (const key of ["secret", "gatewayUrl", "topic", "openrouterKey", "token"]) {
        assert.ok(DEFAULT_SECRET_KEYS.includes(key), key);
      }
    });
  });
});
