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

    it("rejects http:// URLs for non-loopback hosts", () => {
      assert.throws(() => validateBaseUrl("http://atlas.example.com"), /only https/);
      assert.throws(() => validateBaseUrl("http://10.0.0.5:3333"), /only https/);
    });

    it("allows http:// for loopback hosts only (test/dev escape hatch)", () => {
      assert.strictEqual(validateBaseUrl("http://localhost:4444/"), "http://localhost:4444");
      assert.strictEqual(validateBaseUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
      assert.strictEqual(validateBaseUrl("http://[::1]:9999"), "http://[::1]:9999");
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
      const allowedUrls = [
        `${REMOTE_URL}/api/state`,
        `${REMOTE_URL}/api/fleet/evolution`,
        // Drill-down detail enrichment (read-only, added in v2)
        `${REMOTE_URL}/api/fleet/mesh`,
        `${REMOTE_URL}/api/fleet/kanban`,
        `${REMOTE_URL}/api/fleet/alerts?limit=10`,
      ];
      for (const { url, init } of fetchLog) {
        assert.ok(allowedUrls.includes(url), `unexpected poll URL: ${url}`);
        assert.strictEqual(init.headers.Authorization, "Bearer tok-123");
      }
      // Both the state poll and the lessons enrichment carry the token.
      assert.ok(fetchLog.some(({ url }) => url === `${REMOTE_URL}/api/state`));
      assert.ok(fetchLog.some(({ url }) => url === `${REMOTE_URL}/api/fleet/evolution`));
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
  // allowWrites opt-in (default off, persisted, toggleable)
  // -----------------------------------------------------------------------

  describe("allowWrites opt-in", () => {
    it("defaults to false and persists across reloads", () => {
      const { federation } = makeFederation();
      const remote = federation.addRemote({ label: "Atlas", baseUrl: REMOTE_URL });
      assert.strictEqual(remote.allowWrites, false);

      const onDisk = JSON.parse(fs.readFileSync(path.join(stateDir, "federation.json"), "utf8"));
      assert.strictEqual(onDisk.remotes[0].allowWrites, false);

      const { federation: reloaded } = makeFederation();
      assert.strictEqual(reloaded.getState().remotes[0].allowWrites, false);
    });

    it("normalizes pre-v1.6 registry records (missing field) to false", () => {
      fs.writeFileSync(
        path.join(stateDir, "federation.json"),
        JSON.stringify({
          remotes: [{ id: "old-1", label: "Old", baseUrl: REMOTE_URL, token: null }],
        }),
      );
      const { federation } = makeFederation();
      assert.strictEqual(federation.getState().remotes[0].allowWrites, false);
    });

    it("rejects non-boolean allowWrites on addRemote", () => {
      const { federation } = makeFederation();
      assert.throws(
        () => federation.addRemote({ label: "A", baseUrl: REMOTE_URL, allowWrites: "yes" }),
        /Invalid allowWrites/,
      );
    });

    it("setRemoteWrites toggles, persists, and stays redacted", () => {
      const { federation } = makeFederation();
      const remote = federation.addRemote({ label: "Atlas", baseUrl: REMOTE_URL, token: "tok" });

      const enabled = federation.setRemoteWrites(remote.id, true);
      assert.strictEqual(enabled.allowWrites, true);
      assert.strictEqual(enabled.token, undefined);
      assert.strictEqual(enabled.hasToken, true);

      const onDisk = JSON.parse(fs.readFileSync(path.join(stateDir, "federation.json"), "utf8"));
      assert.strictEqual(onDisk.remotes[0].allowWrites, true);
      // ...and the token survives the toggle, server-side only.
      assert.strictEqual(onDisk.remotes[0].token, "tok");

      const disabled = federation.setRemoteWrites(remote.id, false);
      assert.strictEqual(disabled.allowWrites, false);
    });

    it("setRemoteWrites validates input and remote id", () => {
      const { federation } = makeFederation();
      const remote = federation.addRemote({ label: "Atlas", baseUrl: REMOTE_URL });
      assert.throws(() => federation.setRemoteWrites(remote.id, "on"), /must be a boolean/);
      assert.throws(() => federation.setRemoteWrites("nope", true), /Unknown remote/);
    });
  });

  // -----------------------------------------------------------------------
  // Write proxy (whitelisted actions)
  // -----------------------------------------------------------------------

  describe("performRemoteAction()", () => {
    /** Federation + a writes-enabled remote + a programmable fetch stub. */
    function makeWriteSetup({ respond, token = "tok-9" } = {}) {
      const fetchLog = [];
      const federation = createFederation({
        stateDir,
        fetchFn: async (url, init) => {
          fetchLog.push({ url, init: init || {} });
          if (respond) return respond(url, init);
          return okResponse({ success: true });
        },
      });
      const remote = federation.addRemote({ label: "Atlas", baseUrl: REMOTE_URL, token });
      federation.setRemoteWrites(remote.id, true);
      return { federation, remote, fetchLog };
    }

    function writes(fetchLog) {
      return fetchLog.filter(({ init }) => (init.method || "GET").toUpperCase() !== "GET");
    }

    it("rejects unknown actions with a 400-style error before any request", async () => {
      const { federation, remote, fetchLog } = makeWriteSetup();
      await assert.rejects(
        federation.performRemoteAction(remote.id, "node.unregister", {}),
        (err) => /Unsupported federation action/.test(err.message) && err.statusCode === 400,
      );
      assert.strictEqual(writes(fetchLog).length, 0);
    });

    it("refuses with 403 when allowWrites is disabled, without contacting the remote", async () => {
      const { federation, remote, fetchLog } = makeWriteSetup();
      federation.setRemoteWrites(remote.id, false);
      await assert.rejects(
        federation.performRemoteAction(remote.id, "lesson.approve", { lessonId: "les_a1b2c3" }),
        (err) => /Write actions are disabled/.test(err.message) && err.statusCode === 403,
      );
      assert.strictEqual(writes(fetchLog).length, 0);
    });

    it("throws Unknown remote for unregistered ids", async () => {
      const { federation } = makeWriteSetup();
      await assert.rejects(
        federation.performRemoteAction("ghost", "lesson.approve", { lessonId: "les_a1b2c3" }),
        /Unknown remote/,
      );
    });

    it("lesson.approve hits the right URL with Authorization + forwarded identity", async () => {
      const { federation, remote, fetchLog } = makeWriteSetup();
      const result = await federation.performRemoteAction(
        remote.id,
        "lesson.approve",
        { lessonId: "les_a1b2c3" },
        { actor: "operator@example.com" },
      );

      const [call] = writes(fetchLog);
      assert.strictEqual(call.url, `${REMOTE_URL}/api/fleet/evolution/lessons/les_a1b2c3/approve`);
      assert.strictEqual(call.init.method, "POST");
      assert.strictEqual(call.init.headers.Authorization, "Bearer tok-9");
      assert.strictEqual(call.init.headers["Tailscale-User-Login"], "operator@example.com");
      assert.deepStrictEqual(result, {
        ok: true,
        action: "lesson.approve",
        remoteId: remote.id,
        remoteStatus: 200,
        remoteBody: { success: true },
      });
    });

    it("lesson.reject hits the /reject endpoint", async () => {
      const { federation, remote, fetchLog } = makeWriteSetup();
      await federation.performRemoteAction(remote.id, "lesson.reject", { lessonId: "les_0fF1ce" });
      const [call] = writes(fetchLog);
      assert.strictEqual(call.url, `${REMOTE_URL}/api/fleet/evolution/lessons/les_0fF1ce/reject`);
      assert.strictEqual(call.init.method, "POST");
    });

    it("gate.set PUTs the gate boolean", async () => {
      const { federation, remote, fetchLog } = makeWriteSetup();
      await federation.performRemoteAction(
        remote.id,
        "gate.set",
        { gate: false },
        { actor: "ops" },
      );
      const [call] = writes(fetchLog);
      assert.strictEqual(call.url, `${REMOTE_URL}/api/fleet/evolution/gate`);
      assert.strictEqual(call.init.method, "PUT");
      assert.deepStrictEqual(JSON.parse(call.init.body), { gate: false });
      assert.strictEqual(call.init.headers["Tailscale-User-Login"], "ops");
    });

    it("task.move POSTs status and optional order", async () => {
      const { federation, remote, fetchLog } = makeWriteSetup();
      await federation.performRemoteAction(remote.id, "task.move", {
        taskId: "tsk_ab12cd",
        status: "review",
        order: 2,
      });
      const [call] = writes(fetchLog);
      assert.strictEqual(call.url, `${REMOTE_URL}/api/fleet/kanban/tasks/tsk_ab12cd/move`);
      assert.strictEqual(call.init.method, "POST");
      assert.deepStrictEqual(JSON.parse(call.init.body), { status: "review", order: 2 });
    });

    it("works without a token (tailnet sharing) but still forwards identity", async () => {
      const { federation, remote, fetchLog } = makeWriteSetup({ token: null });
      await federation.performRemoteAction(remote.id, "gate.set", { gate: true });
      const [call] = writes(fetchLog);
      assert.strictEqual(call.init.headers.Authorization, undefined);
      assert.strictEqual(call.init.headers["Tailscale-User-Login"], "anonymous");
    });

    it("strictly validates params before any request is issued", async () => {
      const { federation, remote, fetchLog } = makeWriteSetup();
      const cases = [
        ["lesson.approve", {}],
        ["lesson.approve", { lessonId: "../../etc/passwd" }],
        ["lesson.approve", { lessonId: "les_xyz!" }],
        ["gate.set", { gate: "open" }],
        ["task.move", { taskId: "tsk_ab12cd", status: "shipped" }],
        ["task.move", { taskId: "not-an-id", status: "done" }],
        ["task.move", { taskId: "tsk_ab12cd", status: "done", order: "first" }],
      ];
      for (const [action, params] of cases) {
        await assert.rejects(
          federation.performRemoteAction(remote.id, action, params),
          (err) => err.statusCode === 400,
          `expected 400 for ${action} ${JSON.stringify(params)}`,
        );
      }
      assert.strictEqual(writes(fetchLog).length, 0);
    });

    it("passes remote 4xx/5xx through as { ok: false, remoteStatus, remoteBody }", async () => {
      const { federation, remote } = makeWriteSetup({
        respond: (url, init) =>
          (init.method || "GET") === "GET"
            ? okResponse(remoteStateBody())
            : { ok: false, status: 409, json: async () => ({ error: "already approved" }) },
      });
      const result = await federation.performRemoteAction(remote.id, "lesson.approve", {
        lessonId: "les_a1b2c3",
      });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.remoteStatus, 409);
      assert.deepStrictEqual(result.remoteBody, { error: "already approved" });
    });

    it("truncates oversized remote bodies to 4KB", async () => {
      const huge = "x".repeat(10000);
      const { federation, remote } = makeWriteSetup({
        respond: (url, init) =>
          (init.method || "GET") === "GET"
            ? okResponse(remoteStateBody())
            : { ok: true, status: 200, text: async () => huge },
      });
      const result = await federation.performRemoteAction(remote.id, "gate.set", { gate: true });
      assert.strictEqual(typeof result.remoteBody, "string");
      assert.strictEqual(result.remoteBody.length, 4096);
    });

    it("maps network failures to a 502-style error", async () => {
      const { federation, remote } = makeWriteSetup({
        respond: (url, init) => {
          if ((init.method || "GET") !== "GET") throw new Error("connect ECONNREFUSED");
          return okResponse(remoteStateBody());
        },
      });
      await assert.rejects(
        federation.performRemoteAction(remote.id, "gate.set", { gate: true }),
        (err) => /Remote request failed/.test(err.message) && err.statusCode === 502,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Pending lessons enrichment
  // -----------------------------------------------------------------------

  describe("pending lessons enrichment", () => {
    function lessonsBody(count, extra = {}) {
      return {
        gate: true,
        lessons: Array.from({ length: count }, (_, i) => ({
          id: `les_${String(i).padStart(6, "0")}`,
          title: `Lesson ${i}`,
          status: "pending",
          author: "agent-1",
          ts: "2026-06-09T00:00:00Z",
          body: "SECRET BODY SHOULD BE TRIMMED",
          ...extra,
        })),
      };
    }

    it("stores trimmed pending lessons (max 10, id/title/author/ts only)", async () => {
      const { federation } = makeFederation({
        fetchFn: async (url) =>
          url.endsWith("/api/fleet/evolution")
            ? okResponse(lessonsBody(12))
            : okResponse(remoteStateBody()),
      });
      const remote = federation.addRemote({ label: "Atlas", baseUrl: REMOTE_URL });
      await federation._pollOnce();

      const entry = federation.getState().remotes.find((r) => r.id === remote.id);
      const lessons = entry.status.pendingLessons;
      assert.strictEqual(lessons.length, 10);
      assert.deepStrictEqual(lessons[0], {
        id: "les_000000",
        title: "Lesson 0",
        author: "agent-1",
        ts: "2026-06-09T00:00:00Z",
      });
      assert.ok(!JSON.stringify(lessons).includes("SECRET BODY"));
    });

    it("only includes pending lessons", async () => {
      const body = lessonsBody(2);
      body.lessons[1].status = "approved";
      const { federation } = makeFederation({
        fetchFn: async (url) =>
          url.endsWith("/api/fleet/evolution") ? okResponse(body) : okResponse(remoteStateBody()),
      });
      const remote = federation.addRemote({ label: "Atlas", baseUrl: REMOTE_URL });
      await federation._pollOnce();
      const entry = federation.getState().remotes.find((r) => r.id === remote.id);
      assert.deepStrictEqual(
        entry.status.pendingLessons.map((l) => l.id),
        ["les_000000"],
      );
    });

    it("tolerates older remotes without the endpoint (404) silently", async () => {
      const { federation } = makeFederation({
        fetchFn: async (url) =>
          url.endsWith("/api/fleet/evolution")
            ? { ok: false, status: 404, json: async () => ({}) }
            : okResponse(remoteStateBody()),
      });
      const remote = federation.addRemote({ label: "Old", baseUrl: REMOTE_URL });
      await federation._pollOnce();
      const entry = federation.getState().remotes.find((r) => r.id === remote.id);
      assert.strictEqual(entry.status.reachable, true); // state poll unaffected
      assert.strictEqual(entry.status.pendingLessons, null);
    });

    it("tolerates enrichment network errors silently", async () => {
      const { federation } = makeFederation({
        fetchFn: async (url) => {
          if (url.endsWith("/api/fleet/evolution")) throw new Error("boom");
          return okResponse(remoteStateBody());
        },
      });
      const remote = federation.addRemote({ label: "Atlas", baseUrl: REMOTE_URL });
      await federation._pollOnce();
      const entry = federation.getState().remotes.find((r) => r.id === remote.id);
      assert.strictEqual(entry.status.reachable, true);
      assert.strictEqual(entry.status.pendingLessons, null);
    });

    it("extractPendingLessons tolerates malformed payloads", () => {
      const { extractPendingLessons } = require("../src/federation");
      assert.strictEqual(extractPendingLessons(null), null);
      assert.strictEqual(extractPendingLessons("nope"), null);
      assert.strictEqual(extractPendingLessons({ lessons: "nope" }), null);
      assert.deepStrictEqual(
        extractPendingLessons({ lessons: [{ status: "pending" }, null, 7] }),
        [],
      );
    });
  });

  // -----------------------------------------------------------------------
  // Read-only guarantee (still holds whenever allowWrites is off)
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

    it("holds even when write actions are attempted with allowWrites=false", async () => {
      const { federation, fetchLog } = makeFederation();
      const remote = federation.addRemote({ label: "Atlas", baseUrl: REMOTE_URL });
      await new Promise((resolve) => setImmediate(resolve)); // initial probe
      await federation._pollOnce();

      await assert.rejects(
        federation.performRemoteAction(remote.id, "lesson.approve", { lessonId: "les_a1b2c3" }),
        (err) => err.statusCode === 403,
      );
      await assert.rejects(
        federation.performRemoteAction(remote.id, "gate.set", { gate: true }),
        (err) => err.statusCode === 403,
      );

      for (const { url, init } of fetchLog) {
        const method = (init.method || "GET").toUpperCase();
        assert.strictEqual(method, "GET", `non-GET request detected: ${method} ${url}`);
      }
    });
  });
});
