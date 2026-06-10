const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createFederation,
  validateBaseUrl,
  extractRemoteSummary,
  DEFAULT_INTERVAL_MS,
} = require("../src/federation");

const REMOTE_URL = "https://atlas.test-tailnet.ts.net";

/** A representative remote /api/state payload. */
function remoteStateBody(overrides = {}) {
  return {
    vitals: { hostname: "atlas" },
    fleet: {
      mesh: { nodes: 3, online: 2 },
      kanban: { counts: { inbox: 1, done: 4 }, staleCount: 1 },
      evolution: { gate: true, pendingCount: 2 },
      alerts: { recent: 5 },
    },
    ...overrides,
  };
}

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

describe("federation module", () => {
  let stateDir;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "federation-test-"));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  /** Federation with a recording fetch stub. */
  function makeFederation(overrides = {}) {
    const fetchLog = [];
    const federation = createFederation({
      stateDir,
      fetchFn: async (url, init) => {
        fetchLog.push({ url, init: init || {} });
        return okResponse(remoteStateBody());
      },
      ...overrides,
    });
    return { federation, fetchLog };
  }

  // -----------------------------------------------------------------------
  // URL validation
  // -----------------------------------------------------------------------

  describe("validateBaseUrl()", () => {
    it("accepts https URLs and strips trailing slashes", () => {
      assert.strictEqual(validateBaseUrl(`${REMOTE_URL}/`), REMOTE_URL);
      assert.strictEqual(validateBaseUrl(`${REMOTE_URL}:8443/dash/`), `${REMOTE_URL}:8443/dash`);
    });

    it("rejects http:// URLs", () => {
      assert.throws(() => validateBaseUrl("http://atlas.example.com"), /only https/);
    });

    it("rejects javascript: URLs", () => {
      assert.throws(() => validateBaseUrl("javascript:alert(1)"), /only https|not a parseable/);
    });

    it("rejects credentials embedded in the URL", () => {
      assert.throws(() => validateBaseUrl("https://user:secret@atlas.example.com"), /credentials/);
      assert.throws(() => validateBaseUrl("https://user@atlas.example.com"), /credentials/);
    });

    it("rejects non-string and unparseable input", () => {
      assert.throws(() => validateBaseUrl(undefined), /non-empty string/);
      assert.throws(() => validateBaseUrl(""), /non-empty string/);
      assert.throws(() => validateBaseUrl("not a url"), /not a parseable/);
    });
  });

  // -----------------------------------------------------------------------
  // Registry CRUD
  // -----------------------------------------------------------------------

  describe("registry CRUD", () => {
    it("adds a remote, persists it atomically, and reloads from disk", () => {
      const { federation } = makeFederation();
      const remote = federation.addRemote({
        label: "Atlas HQ",
        baseUrl: REMOTE_URL,
        addedBy: "aaron",
      });

      assert.ok(remote.id);
      assert.strictEqual(remote.label, "Atlas HQ");
      assert.strictEqual(remote.baseUrl, REMOTE_URL);
      assert.strictEqual(remote.addedBy, "aaron");
      assert.ok(remote.addedAt);

      const onDisk = JSON.parse(fs.readFileSync(path.join(stateDir, "federation.json"), "utf8"));
      assert.strictEqual(onDisk.remotes.length, 1);
      assert.strictEqual(onDisk.remotes[0].baseUrl, REMOTE_URL);

      // A fresh instance over the same stateDir sees the registry.
      const { federation: reloaded } = makeFederation();
      assert.strictEqual(reloaded.getState().remotes.length, 1);
    });

    it("rejects duplicate baseUrls (after normalization)", () => {
      const { federation } = makeFederation();
      federation.addRemote({ label: "A", baseUrl: REMOTE_URL });
      assert.throws(
        () => federation.addRemote({ label: "B", baseUrl: `${REMOTE_URL}/` }),
        /already registered/,
      );
    });

    it("rejects invalid labels", () => {
      const { federation } = makeFederation();
      assert.throws(() => federation.addRemote({ baseUrl: REMOTE_URL }), /Invalid label/);
      assert.throws(
        () => federation.addRemote({ label: "x".repeat(121), baseUrl: REMOTE_URL }),
        /at most 120/,
      );
    });

    it("removes a remote by id and persists the removal", () => {
      const { federation } = makeFederation();
      const remote = federation.addRemote({ label: "Atlas", baseUrl: REMOTE_URL });
      const removed = federation.removeRemote(remote.id);
      assert.strictEqual(removed.id, remote.id);
      assert.strictEqual(federation.getState().remotes.length, 0);

      const onDisk = JSON.parse(fs.readFileSync(path.join(stateDir, "federation.json"), "utf8"));
      assert.strictEqual(onDisk.remotes.length, 0);
    });

    it("throws when removing an unknown remote", () => {
      const { federation } = makeFederation();
      assert.throws(() => federation.removeRemote("nope"), /Unknown remote/);
    });
  });

  // -----------------------------------------------------------------------
  // Token redaction
  // -----------------------------------------------------------------------

  describe("token redaction", () => {
    it("never exposes tokens through getState / addRemote / removeRemote", () => {
      const { federation } = makeFederation();
      const added = federation.addRemote({
        label: "Atlas",
        baseUrl: REMOTE_URL,
        token: "super-secret",
      });
      assert.strictEqual(added.token, undefined);
      assert.strictEqual(added.hasToken, true);

      const state = federation.getState();
      assert.strictEqual(state.remotes[0].token, undefined);
      assert.strictEqual(state.remotes[0].hasToken, true);
      assert.ok(!JSON.stringify(state).includes("super-secret"));

      const removed = federation.removeRemote(added.id);
      assert.strictEqual(removed.token, undefined);
      assert.strictEqual(removed.hasToken, true);
    });

    it("reports hasToken: false when no token was provided", () => {
      const { federation } = makeFederation();
      const added = federation.addRemote({ label: "Atlas", baseUrl: REMOTE_URL });
      assert.strictEqual(added.hasToken, false);
      assert.strictEqual(federation.getState().remotes[0].hasToken, false);
    });
  });

  // -----------------------------------------------------------------------
  // Polling
  // -----------------------------------------------------------------------

  describe("polling", () => {
    it("polls <baseUrl>/api/state and records latency + summary on success", async () => {
      let clock = 1000;
      const { federation } = makeFederation({
        fetchFn: async () => {
          clock += 42; // simulated network time
          return okResponse(remoteStateBody());
        },
        nowFn: () => clock,
      });
      const remote = federation.addRemote({ label: "Atlas", baseUrl: REMOTE_URL });
      await federation._pollOnce();

      const entry = federation.getState().remotes.find((r) => r.id === remote.id);
      assert.strictEqual(entry.status.reachable, true);
      assert.strictEqual(entry.status.latencyMs, 42);
      assert.strictEqual(entry.status.lastError, null);
      assert.deepStrictEqual(entry.status.summary.mesh, { nodes: 3, online: 2 });
      assert.strictEqual(entry.status.summary.hostname, "atlas");
    });

    it("sends Authorization: Bearer when a token is configured", async () => {
      const { federation, fetchLog } = makeFederation();
      federation.addRemote({ label: "Atlas", baseUrl: REMOTE_URL, token: "tok-123" });
      await federation._pollOnce();

      assert.ok(fetchLog.length >= 1);
      for (const { url, init } of fetchLog) {
        assert.strictEqual(url, `${REMOTE_URL}/api/state`);
        assert.strictEqual(init.headers.Authorization, "Bearer tok-123");
      }
    });

    it("omits the Authorization header without a token", async () => {
      const { federation, fetchLog } = makeFederation();
      federation.addRemote({ label: "Atlas", baseUrl: REMOTE_URL });
      await federation._pollOnce();
      for (const { init } of fetchLog) {
        assert.strictEqual(init.headers.Authorization, undefined);
      }
    });

    it("marks the remote unreachable on timeout/error and keeps the last summary", async () => {
      let fail = false;
      const { federation } = makeFederation({
        fetchFn: async () => {
          if (fail) throw new Error("The operation was aborted due to timeout");
          return okResponse(remoteStateBody());
        },
      });
      const remote = federation.addRemote({ label: "Atlas", baseUrl: REMOTE_URL });
      await federation._pollOnce();

      fail = true;
      await federation._pollOnce();

      const entry = federation.getState().remotes.find((r) => r.id === remote.id);
      assert.strictEqual(entry.status.reachable, false);
      assert.match(entry.status.lastError, /timeout/);
      assert.strictEqual(entry.status.latencyMs, null);
      // Last-known summary survives the outage.
      assert.deepStrictEqual(entry.status.summary.mesh, { nodes: 3, online: 2 });
    });

    it("marks the remote unreachable on non-2xx responses", async () => {
      const { federation } = makeFederation({
        fetchFn: async () => ({ ok: false, status: 401, json: async () => ({}) }),
      });
      const remote = federation.addRemote({ label: "Atlas", baseUrl: REMOTE_URL });
      await federation._pollOnce();
      const entry = federation.getState().remotes.find((r) => r.id === remote.id);
      assert.strictEqual(entry.status.reachable, false);
      assert.strictEqual(entry.status.lastError, "HTTP 401");
    });

    it("fires onChange on reachability transitions only", async () => {
      const events = [];
      let fail = false;
      const { federation } = makeFederation({
        fetchFn: async () => {
          if (fail) throw new Error("boom");
          return okResponse(remoteStateBody());
        },
        onChange: (event) => events.push(event),
      });
      federation.addRemote({ label: "Atlas", baseUrl: REMOTE_URL });
      // addRemote fires an initial async probe; let it settle.
      await new Promise((resolve) => setImmediate(resolve));

      await federation._pollOnce(); // still reachable — no new event
      fail = true;
      await federation._pollOnce(); // -> unreachable
      await federation._pollOnce(); // still unreachable — no new event
      fail = false;
      await federation._pollOnce(); // -> reachable again

      const transitions = events.map((e) => `${e.previousReachable}->${e.reachable}`);
      assert.deepStrictEqual(transitions, ["null->true", "true->false", "false->true"]);
      // onChange payloads must be redacted too.
      for (const event of events) {
        assert.strictEqual(event.remote.token, undefined);
      }
    });

    it("getState counts reachable remotes", async () => {
      const { federation } = makeFederation({
        fetchFn: async (url) =>
          url.startsWith("https://up.")
            ? okResponse(remoteStateBody())
            : { ok: false, status: 500, json: async () => ({}) },
      });
      federation.addRemote({ label: "Up", baseUrl: "https://up.ts.net" });
      federation.addRemote({ label: "Down", baseUrl: "https://down.ts.net" });
      await federation._pollOnce();

      const { counts } = federation.getState();
      assert.deepStrictEqual(counts, { remotes: 2, reachable: 1 });
    });

    it("uses the default 30s interval", () => {
      assert.strictEqual(DEFAULT_INTERVAL_MS, 30000);
      const { federation } = makeFederation();
      assert.strictEqual(federation.getState().intervalMs, 30000);
    });
  });

  // -----------------------------------------------------------------------
  // Summary extraction tolerance
  // -----------------------------------------------------------------------

  describe("extractRemoteSummary()", () => {
    it("returns nulls when the fleet block is missing", () => {
      const summary = extractRemoteSummary({ version: "1.5.0" });
      assert.deepStrictEqual(summary, {
        hostname: null,
        mesh: null,
        kanban: null,
        evolution: null,
        alerts: null,
      });
    });

    it("tolerates partially malformed fleet blocks", () => {
      const summary = extractRemoteSummary({
        vitals: { hostname: 42 },
        fleet: {
          mesh: { nodes: "three", online: 2 },
          kanban: { counts: "nope" },
          evolution: { gate: "open" },
        },
      });
      assert.strictEqual(summary.hostname, null);
      assert.deepStrictEqual(summary.mesh, { nodes: null, online: 2 });
      assert.deepStrictEqual(summary.kanban, { counts: {}, staleCount: null });
      assert.deepStrictEqual(summary.evolution, { gate: null, pendingCount: null });
      assert.strictEqual(summary.alerts, null);
    });

    it("returns null for non-object payloads", () => {
      assert.strictEqual(extractRemoteSummary(null), null);
      assert.strictEqual(extractRemoteSummary("nope"), null);
    });
  });

  // -----------------------------------------------------------------------
  // Read-only guarantee
  // -----------------------------------------------------------------------

  describe("read-only guarantee", () => {
    it("never issues a non-GET request across a full lifecycle", async () => {
      const { federation, fetchLog } = makeFederation();
      const remote = federation.addRemote({
        label: "Atlas",
        baseUrl: REMOTE_URL,
        token: "tok",
      });
      await new Promise((resolve) => setImmediate(resolve)); // initial probe
      await federation._pollOnce();
      await federation._pollOnce();
      federation.removeRemote(remote.id);
      await federation._pollOnce(); // empty cycle

      assert.ok(fetchLog.length >= 3);
      for (const { url, init } of fetchLog) {
        const method = (init.method || "GET").toUpperCase();
        assert.strictEqual(method, "GET", `non-GET request detected: ${method} ${url}`);
        assert.match(url, /^https:\/\//);
      }
    });
  });
});
