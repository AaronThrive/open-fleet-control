/**
 * End-to-end tests for op:// secret references in config:
 *
 *   1. usage-sources: an op:// OpenRouter API key resolves (lazily, through
 *      the injected secrets layer — never the real op CLI) before any API
 *      call, and a failed resolution degrades gracefully without leaking.
 *   2. settings read path: GET-shaped reads return op:// fields as the
 *      REFERENCE string, never a resolved value.
 *   3. fleet routes: GET /api/fleet/secrets exposes the read-only resolution
 *      status summary (refs + ok/failed counts, never values).
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createSecrets } = require("../src/secrets");
const { createUsageSources } = require("../src/usage-sources");
const { createSettings } = require("../src/settings");
const { createFleetRoutes } = require("../src/fleet-routes");

const SECRET = "sk-or-v1-RESOLVED-do-not-leak";
const KEY_REF = "op://Vault/openrouter/api-key";

/** Fake secrets layer: every ref resolves to SECRET (or fails). */
function fakeSecrets({ fail = null } = {}) {
  const calls = [];
  const execSyncFn = (cmd, args) => {
    calls.push({ cmd, args });
    if (fail) throw fail;
    return `${SECRET}\n`;
  };
  return { secrets: createSecrets({ execSyncFn }), calls };
}

/** fetch stub recording calls. */
function fakeFetch(body = { data: { total_credits: 10, total_usage: 4 } }) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchFn, calls };
}

describe("op:// refs end-to-end", () => {
  describe("usage-sources OpenRouter key", () => {
    it("counts an op:// key as configured and resolves it before the API call", async () => {
      const { secrets, calls: execCalls } = fakeSecrets();
      const { fetchFn, calls } = fakeFetch();
      const usage = createUsageSources({ openrouterKey: KEY_REF, fetchFn, secrets });

      assert.strictEqual(usage.sources.openrouter.available, true);
      // Lazy: nothing resolved until a request actually needs the key.
      assert.strictEqual(execCalls.length, 0);

      const credits = await usage.sources.openrouter.getCredits();
      assert.strictEqual(credits.remaining, 6);
      // The HTTP call carries the RESOLVED key, not the ref.
      assert.strictEqual(calls[0].options.headers.Authorization, `Bearer ${SECRET}`);
      assert.strictEqual(execCalls.length, 1);
      assert.deepStrictEqual(execCalls[0].args, ["read", "--no-newline", KEY_REF]);
    });

    it("caches the resolved key across calls (one exec for many requests)", async () => {
      const { secrets, calls: execCalls } = fakeSecrets();
      const { fetchFn } = fakeFetch();
      const usage = createUsageSources({ openrouterKey: KEY_REF, fetchFn, secrets });

      await usage.sources.openrouter.getCredits();
      await usage.sources.openrouter.getKeyInfo();
      assert.strictEqual(execCalls.length, 1);
    });

    it("fails gracefully (no fetch, no leak) when the ref cannot be resolved", async () => {
      const err = new Error("denied");
      err.status = 1;
      err.stdout = SECRET;
      const { secrets } = fakeSecrets({ fail: err });
      const { fetchFn, calls } = fakeFetch();
      const usage = createUsageSources({ openrouterKey: KEY_REF, fetchFn, secrets });

      const credits = await usage.sources.openrouter.getCredits();
      assert.strictEqual(calls.length, 0, "must not call the API without a resolved key");
      assert.match(credits.error, /could not be resolved/);
      assert.ok(!JSON.stringify(credits).includes(SECRET));
    });

    it("literal keys keep working unchanged without touching the resolver", async () => {
      const { secrets, calls: execCalls } = fakeSecrets();
      const { fetchFn, calls } = fakeFetch();
      const usage = createUsageSources({ openrouterKey: "sk-literal", fetchFn, secrets });

      await usage.sources.openrouter.getCredits();
      assert.strictEqual(calls[0].options.headers.Authorization, "Bearer sk-literal");
      assert.strictEqual(execCalls.length, 0);
    });
  });

  describe("settings read path masking", () => {
    it("returns op:// fields as the reference string, never a resolved value", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofc-secrets-settings-"));
      const configPath = path.join(tmpDir, "dashboard.local.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          fleet: {
            alerts: {
              enabled: true,
              sinks: {
                slack: { enabled: true, gatewayUrl: "op://Vault/slack/url", channel: "#ops" },
                ntfy: { enabled: true, server: "https://ntfy.sh", topic: "op://Vault/ntfy/topic" },
                webhooks: [
                  { id: "wh_1", url: "https://hook.example", secret: "op://Vault/hook/secret" },
                ],
              },
            },
          },
        }),
      );

      const settings = createSettings({ configPath });
      const view = settings.get();

      assert.strictEqual(view.alerts.sinks.slack.gatewayUrl, "op://Vault/slack/url");
      // ntfy topic literal is redacted (bearer-equivalent secret); the op:// ref
      // is surfaced as topicRef (refs are not secrets) for the UI badge.
      assert.strictEqual(view.alerts.sinks.ntfy.topic, undefined);
      assert.strictEqual(view.alerts.sinks.ntfy.topicSet, true);
      assert.strictEqual(view.alerts.sinks.ntfy.topicRef, "op://Vault/ntfy/topic");
      const webhook = view.alerts.sinks.webhooks[0];
      assert.strictEqual(webhook.hasSecret, true);
      assert.strictEqual(webhook.secretRef, "op://Vault/hook/secret");
      assert.strictEqual(webhook.secret, undefined);
      assert.ok(!JSON.stringify(view).includes(SECRET));

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("a PATCH that submits an op:// string stores and echoes the reference", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofc-secrets-settings-"));
      const configPath = path.join(tmpDir, "dashboard.local.json");
      const settings = createSettings({ configPath, onChange: () => {} });

      const { applied } = settings.update({
        alerts: { sinks: { ntfy: { enabled: true, topic: "op://Vault/ntfy/topic" } } },
      });
      // HTTP surface: literal redacted, op:// ref echoed as topicRef.
      assert.strictEqual(applied.alerts.sinks.ntfy.topic, undefined);
      assert.strictEqual(applied.alerts.sinks.ntfy.topicRef, "op://Vault/ntfy/topic");

      // The config FILE keeps the literal ref (unredacted) so apply-time
      // resolution still works.
      const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
      assert.strictEqual(persisted.fleet.alerts.sinks.ntfy.topic, "op://Vault/ntfy/topic");

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe("GET /api/fleet/secrets status route", () => {
    function makeRes() {
      const res = { statusCode: null, body: null };
      res.writeHead = (code) => {
        res.statusCode = code;
      };
      res.end = (data) => {
        res.body = JSON.parse(data);
      };
      return res;
    }

    it("exposes the read-only resolution summary (refs + counts, never values)", async () => {
      const { secrets } = fakeSecrets();
      secrets.resolveSync(KEY_REF);

      const routes = createFleetRoutes({
        fleet: { rateLimiter: { check: () => ({ allowed: true }) }, audit: { record() {} } },
        secretsStatusFn: () => secrets.getStatus(),
      });
      const res = makeRes();
      await routes.handle({ method: "GET", headers: {} }, res, "/api/fleet/secrets", null);

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(
        { configured: res.body.configured, ok: res.body.ok, failed: res.body.failed },
        { configured: 1, ok: 1, failed: 0 },
      );
      assert.strictEqual(res.body.refs[0].ref, KEY_REF);
      assert.ok(!JSON.stringify(res.body).includes(SECRET));
    });

    it("rejects non-GET methods with 404 (read-only surface)", async () => {
      const routes = createFleetRoutes({
        fleet: { rateLimiter: { check: () => ({ allowed: true }) }, audit: { record() {} } },
        secretsStatusFn: () => ({ configured: 0, ok: 0, failed: 0, refs: [] }),
      });
      const res = makeRes();
      await routes.handle({ method: "POST", headers: {} }, res, "/api/fleet/secrets", null);
      assert.strictEqual(res.statusCode, 404);
    });
  });
});
