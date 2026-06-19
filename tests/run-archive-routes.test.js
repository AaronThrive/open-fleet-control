const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRunArchive, runEntryToRecord } = require("../src/run-archive");
const {
  createFlightRecorderRoutes,
  isFlightRecorderRoute,
} = require("../src/run-archive-routes");

/** Minimal mock res that captures status + parsed JSON body. */
function makeRes() {
  return {
    statusCode: null,
    body: null,
    headers: null,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(payload) {
      this.body = payload ? JSON.parse(payload) : null;
    },
  };
}

function q(params = {}) {
  return new URLSearchParams(params);
}

function boardEntry(over = {}) {
  return {
    runId: "orx_1",
    mode: "board",
    status: "done",
    agents: ["alice", "bob"],
    question: "Q?",
    title: "Council",
    results: [
      { agent: "alice", taskId: "t1", text: "A", ok: true },
      { agent: "bob", taskId: "t2", text: "B", ok: true },
    ],
    missing: [],
    startedAt: new Date(1_700_000_000_000).toISOString(),
    endedAt: new Date(1_700_000_001_000).toISOString(),
    ...over,
  };
}

describe("run-archive-routes", () => {
  let stateDir;
  let archive;
  let routes;
  let liveSnapshots;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-routes-test-"));
    archive = createRunArchive({ stateDir, node: "node-Z" });
    liveSnapshots = [];
    routes = createFlightRecorderRoutes({
      archive,
      orchestrate: {
        getRun: (id) => liveSnapshots.find((s) => s.runId === id) || null,
      },
      runEntryToRecord,
      listLiveRuns: () => liveSnapshots,
    });
  });

  afterEach(() => {
    archive.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("route matcher recognizes the four endpoints", () => {
    assert.ok(isFlightRecorderRoute("/api/fleet/flight-recorder/runs"));
    assert.ok(isFlightRecorderRoute("/api/fleet/flight-recorder/runs/orx_1"));
    assert.ok(isFlightRecorderRoute("/api/fleet/flight-recorder/live"));
    assert.ok(isFlightRecorderRoute("/api/fleet/flight-recorder/stats"));
    assert.ok(!isFlightRecorderRoute("/api/fleet/kanban"));
  });

  it("GET /runs lists archived runs", async () => {
    archive.archiveRun(boardEntry({ runId: "a" }));
    archive.archiveRun(boardEntry({ runId: "b" }));
    const res = makeRes();
    await routes.handle(
      { method: "GET" },
      res,
      "/api/fleet/flight-recorder/runs",
      q(),
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.runs.length, 2);
    assert.equal(res.body.runs[0].node, "node-Z");
  });

  it("GET /runs?status=failed filters", async () => {
    archive.archiveRun(boardEntry({ runId: "ok", status: "done" }));
    archive.archiveRun(boardEntry({ runId: "bad", status: "failed" }));
    const res = makeRes();
    await routes.handle(
      { method: "GET" },
      res,
      "/api/fleet/flight-recorder/runs",
      q({ status: "failed" }),
    );
    assert.equal(res.body.runs.length, 1);
    assert.equal(res.body.runs[0].runId, "bad");
  });

  it("GET /runs/:id returns full detail with seats", async () => {
    archive.archiveRun(boardEntry({ runId: "detail-me" }));
    const res = makeRes();
    await routes.handle(
      { method: "GET" },
      res,
      "/api/fleet/flight-recorder/runs/detail-me",
      q(),
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.run.runId, "detail-me");
    assert.equal(res.body.seats.length, 2);
    assert.equal(res.body.run.question, "Q?");
  });

  it("GET /runs/:id falls back to the live registry when not archived", async () => {
    liveSnapshots = [
      { runId: "orx_live", mode: "board", status: "running", agents: ["x", "y"], title: "Live one" },
    ];
    const res = makeRes();
    await routes.handle(
      { method: "GET" },
      res,
      "/api/fleet/flight-recorder/runs/orx_live",
      q(),
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.run.runId, "orx_live");
    assert.equal(res.body.live, true);
    // Pending seats are surfaced for the running run.
    assert.equal(res.body.seats.length, 2);
    assert.equal(res.body.seats[0].status, "running");
  });

  it("GET /runs/:id returns 404 for unknown run", async () => {
    const res = makeRes();
    await routes.handle(
      { method: "GET" },
      res,
      "/api/fleet/flight-recorder/runs/nope",
      q(),
    );
    assert.equal(res.statusCode, 404);
  });

  it("GET /live returns only running registry runs", async () => {
    liveSnapshots = [
      { runId: "r-run", mode: "board", status: "running", agents: ["a"], title: "Running" },
      { runId: "r-done", mode: "board", status: "done", agents: ["a"], title: "Done" },
    ];
    const res = makeRes();
    await routes.handle({ method: "GET" }, res, "/api/fleet/flight-recorder/live", q());
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.runs.length, 1);
    assert.equal(res.body.runs[0].run.runId, "r-run");
  });

  it("GET /stats reports totals", async () => {
    archive.archiveRun(boardEntry({ runId: "s1", status: "done" }));
    archive.archiveRun(boardEntry({ runId: "s2", status: "failed" }));
    const res = makeRes();
    await routes.handle({ method: "GET" }, res, "/api/fleet/flight-recorder/stats", q());
    assert.equal(res.body.total, 2);
    assert.equal(res.body.failed, 1);
  });

  it("rejects non-GET methods", async () => {
    const res = makeRes();
    await routes.handle({ method: "POST" }, res, "/api/fleet/flight-recorder/runs", q());
    assert.equal(res.statusCode, 405);
  });

  it("rejects an invalid limit with 400", async () => {
    const res = makeRes();
    await routes.handle(
      { method: "GET" },
      res,
      "/api/fleet/flight-recorder/runs",
      q({ limit: "abc" }),
    );
    assert.equal(res.statusCode, 400);
  });
});
