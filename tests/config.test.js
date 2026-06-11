const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");

describe("config module", () => {
  // Save original env to restore after tests
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env vars after each test
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);

    // Clear require cache so config reloads fresh
    for (const key of Object.keys(require.cache)) {
      if (key.includes("config.js")) {
        delete require.cache[key];
      }
    }
  });

  describe("expandPath()", () => {
    it("expands ~ to home directory", () => {
      const { expandPath } = require("../src/config");
      const result = expandPath("~/some/path");
      assert.strictEqual(result, path.join(os.homedir(), "some", "path"));
    });

    it("expands $HOME to home directory", () => {
      const { expandPath } = require("../src/config");
      const result = expandPath("$HOME/docs");
      assert.strictEqual(result, path.join(os.homedir(), "docs"));
    });

    it("expands ${HOME} to home directory", () => {
      const { expandPath } = require("../src/config");
      const result = expandPath("${HOME}/docs");
      assert.strictEqual(result, path.join(os.homedir(), "docs"));
    });

    it("returns null/undefined as-is", () => {
      const { expandPath } = require("../src/config");
      assert.strictEqual(expandPath(null), null);
      assert.strictEqual(expandPath(undefined), undefined);
    });

    it("returns path unchanged when no expansion needed", () => {
      const { expandPath } = require("../src/config");
      assert.strictEqual(expandPath("/absolute/path"), "/absolute/path");
    });
  });

  describe("detectWorkspace()", () => {
    it("returns a string path", () => {
      const { detectWorkspace } = require("../src/config");
      const result = detectWorkspace();
      assert.strictEqual(typeof result, "string");
      assert.ok(result.length > 0, "workspace path should not be empty");
    });

    it("returns an absolute path", () => {
      const { detectWorkspace } = require("../src/config");
      const result = detectWorkspace();
      assert.ok(path.isAbsolute(result), `Expected absolute path, got: ${result}`);
    });
  });

  describe("loadConfig()", () => {
    it("returns an object with all required top-level keys", () => {
      const { loadConfig } = require("../src/config");
      const config = loadConfig();
      assert.ok(config.server, "config should have server");
      assert.ok(config.paths, "config should have paths");
      assert.ok(config.auth, "config should have auth");
      assert.ok(config.branding, "config should have branding");
      assert.ok(config.integrations, "config should have integrations");
    });

    it("has default port of 3333", () => {
      const { loadConfig } = require("../src/config");
      const config = loadConfig();
      assert.strictEqual(config.server.port, 3333);
    });

    it("has default auth mode of 'none'", () => {
      const { loadConfig } = require("../src/config");
      const config = loadConfig();
      assert.strictEqual(config.auth.mode, "none");
    });

    it("has default host of localhost", () => {
      const { loadConfig } = require("../src/config");
      const config = loadConfig();
      assert.strictEqual(config.server.host, "localhost");
    });

    it("has workspace path set", () => {
      const { loadConfig } = require("../src/config");
      const config = loadConfig();
      assert.ok(config.paths.workspace, "workspace path should be set");
      assert.strictEqual(typeof config.paths.workspace, "string");
    });

    it("has memory path set", () => {
      const { loadConfig } = require("../src/config");
      const config = loadConfig();
      assert.ok(config.paths.memory, "memory path should be set");
    });
  });

  describe("environment variable overrides", () => {
    it("PORT env var overrides default port", () => {
      process.env.PORT = "9999";
      // Clear cache to force re-require
      for (const key of Object.keys(require.cache)) {
        if (key.includes("config.js")) {
          delete require.cache[key];
        }
      }
      const { loadConfig } = require("../src/config");
      const config = loadConfig();
      assert.strictEqual(config.server.port, 9999);
    });

    it("HOST env var overrides default host", () => {
      process.env.HOST = "0.0.0.0";
      for (const key of Object.keys(require.cache)) {
        if (key.includes("config.js")) {
          delete require.cache[key];
        }
      }
      const { loadConfig } = require("../src/config");
      const config = loadConfig();
      assert.strictEqual(config.server.host, "0.0.0.0");
    });

    it("DASHBOARD_AUTH_MODE env var overrides auth mode", () => {
      process.env.DASHBOARD_AUTH_MODE = "token";
      for (const key of Object.keys(require.cache)) {
        if (key.includes("config.js")) {
          delete require.cache[key];
        }
      }
      const { loadConfig } = require("../src/config");
      const config = loadConfig();
      assert.strictEqual(config.auth.mode, "token");
    });
  });

  describe("op:// secret resolution at config load", () => {
    const SECRET = "RESOLVED-hunter2";

    function freshLoadConfig(options) {
      for (const key of Object.keys(require.cache)) {
        if (key.includes("config.js")) {
          delete require.cache[key];
        }
      }
      const { loadConfig } = require("../src/config");
      // Isolate from the developer's real config/dashboard.local.json (which
      // may legitimately contain op:// refs) so assertions only see the
      // FLEET_CONFIG_JSON fixture set by each test.
      const noLocal = require("path").join(require("os").tmpdir(), "ofc-test-no-local.json");
      return loadConfig({ localPath: noLocal, ...options });
    }

    /** Fake secrets layer backed by an injected exec — never runs the real op CLI. */
    function fakeSecrets({ fail = null } = {}) {
      const { createSecrets } = require("../src/secrets");
      const calls = [];
      const execSyncFn = (cmd, args) => {
        calls.push({ cmd, args });
        if (fail) throw fail;
        return `${SECRET}\n`;
      };
      return { secrets: createSecrets({ execSyncFn }), calls };
    }

    it("resolves op:// refs anywhere in the fleet config (ntfy topic, openrouter key)", () => {
      process.env.FLEET_CONFIG_JSON = JSON.stringify({
        alerts: { sinks: { ntfy: { enabled: true, topic: "op://Vault/ntfy/topic" } } },
        usage: { openrouterKey: "op://Vault/openrouter/key" },
      });
      const { secrets } = fakeSecrets();
      const config = freshLoadConfig({ secrets });

      assert.strictEqual(config.fleet.alerts.sinks.ntfy.topic, SECRET);
      assert.strictEqual(config.fleet.usage.openrouterKey, SECRET);
      // Non-ref strings pass through untouched.
      assert.strictEqual(config.fleet.alerts.sinks.ntfy.enabled, true);
      assert.strictEqual(config.auth.mode, "none");
    });

    it("keeps the literal op:// string in place when resolution fails", () => {
      process.env.FLEET_CONFIG_JSON = JSON.stringify({
        usage: { openrouterKey: "op://Vault/openrouter/key" },
      });
      const err = new Error("denied");
      err.status = 1;
      const { secrets } = fakeSecrets({ fail: err });
      const config = freshLoadConfig({ secrets });

      // Downstream code sees an obviously-invalid credential, never undefined.
      assert.strictEqual(config.fleet.usage.openrouterKey, "op://Vault/openrouter/key");
      // …and the failure is surfaced in the secrets status (ref only, no value).
      const status = secrets.getStatus();
      assert.strictEqual(status.failed, 1);
      assert.strictEqual(status.refs[0].ref, "op://Vault/openrouter/key");
    });

    it("never spawns a resolver process when the config contains no refs", () => {
      delete process.env.FLEET_CONFIG_JSON;
      const { secrets, calls } = fakeSecrets();
      freshLoadConfig({ secrets });
      assert.strictEqual(calls.length, 0);
    });
  });

  describe("fleet.agents source config", () => {
    function freshLoadConfig() {
      for (const key of Object.keys(require.cache)) {
        if (key.includes("config.js")) {
          delete require.cache[key];
        }
      }
      const { loadConfig } = require("../src/config");
      return loadConfig();
    }

    it("defaults preserve current behavior (source=openclaw)", () => {
      delete process.env.FLEET_CONFIG_JSON;
      const config = freshLoadConfig();
      assert.strictEqual(config.fleet.agents.source, "openclaw");
      assert.strictEqual(config.fleet.agents.openclawConfigPath, "");
      assert.strictEqual(config.fleet.agents.agentsDir, "");
      assert.strictEqual(config.fleet.agents.hermesDir, path.join(os.homedir(), ".hermes"));
    });

    it("FLEET_CONFIG_JSON can switch the source to hermes", () => {
      process.env.FLEET_CONFIG_JSON = JSON.stringify({ agents: { source: "hermes" } });
      const config = freshLoadConfig();
      assert.strictEqual(config.fleet.agents.source, "hermes");
      // Untouched keys keep their defaults.
      assert.strictEqual(config.fleet.agents.hermesDir, path.join(os.homedir(), ".hermes"));
    });

    it("expands ~ and $HOME in agents paths", () => {
      process.env.FLEET_CONFIG_JSON = JSON.stringify({
        agents: {
          source: "openclaw",
          openclawConfigPath: "~/custom/openclaw.json",
          agentsDir: "$HOME/custom/agents",
          hermesDir: "~/elsewhere/.hermes",
        },
      });
      const config = freshLoadConfig();
      assert.strictEqual(
        config.fleet.agents.openclawConfigPath,
        path.join(os.homedir(), "custom", "openclaw.json"),
      );
      assert.strictEqual(
        config.fleet.agents.agentsDir,
        path.join(os.homedir(), "custom", "agents"),
      );
      assert.strictEqual(
        config.fleet.agents.hermesDir,
        path.join(os.homedir(), "elsewhere", ".hermes"),
      );
    });
  });
});
