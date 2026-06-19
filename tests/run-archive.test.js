const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createRunArchive,
  runEntryToRecord,
  deriveSeats,
  recordIsFailure,
} = require("../src/run-archive");

function makeClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    nowFn: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

/** A representative settled BOARD registry entry (mirrors orchestrate.js). */
function boardEntry(over = {}) {
  return {
    runId: "orx_board1",
    mode: "board",
    status: "done",
    agents: ["alice", "bob", "carol"],
    question: "What is the plan?",
    title: "Strategy council",
    results: [
      { agent: "alice", taskId: "t1", text: "Plan A details", ok: true, truncated: false },
      { agent: "bob", taskId: "t2", text: null, ok: false, truncated: false },
      { agent: "carol", taskId: "t3", text: "Plan C", ok: true, truncated: true },
    ],
    missing: [{ agent: "bob", taskId: "t2", reason: "timeout" }],
    startedAt: new Date(1_700_000_000_000).toISOString(),
    endedAt: new Date(1_700_000_005_000).toISOString(),
    ...over,
  };
}

/** A representative settled CHAIN registry entry. */
function chainEntry(over = {}) {
  return {
    runId: "orx_chain1",
    mode: "chain",
    status: "done",
    agents: ["s1", "s2"],
    title: "Build pipeline",
    steps: [
      { agent: "s1", taskId: "c1", text: "step1 out", ok: true, truncated: false, skipped: false },
      { agent: "s2", taskId: "c2", text: "step2 out", ok: true, truncated: false, skipped: false },
    ],
    final: "step2 out",
    stoppedAt: null,
    startedAt: new Date(1_700_000_000_000).toISOString(),
    endedAt: new Date(1_700_000_003_000).toISOString(),
    ...over,
  };
}

describe("run-archive — pure mapping", () => {
  it("derives board seats with statuses from results + missing", () => {
    const seats = deriveSeats(boardEntry());
    assert.equal(seats.length, 3);
    assert.deepEqual(
      seats.map((s) => [s.agent, s.status]),
      [
        ["alice", "ok"],
        ["bob", "timeout"],
        ["carol", "ok"],
      ],
    );
    assert.equal(seats[2].truncated, true);
  });

  it("derives chain seats including skipped/timeout/error", () => {
    const entry = chainEntry({
      steps: [
        { agent: "s1", taskId: "c1", text: "ok", ok: true },
        { agent: "s2", taskId: "c2", text: null, ok: false, timedOut: true },
        { agent: "s3", taskId: null, text: null, ok: false, skipped: true },
      ],
    });
    const seats = deriveSeats(entry);
    assert.deepEqual(
      seats.map((s) => s.status),
      ["ok", "timeout", "skipped"],
    );
  });

  it("runEntryToRecord stamps the node column and computes counts/duration", () => {
    const record = runEntryToRecord(boardEntry(), { node: "node-7" });
    assert.equal(record.run.node, "node-7");
    assert.equal(record.run.seatCount, 3);
    assert.equal(record.run.okCount, 2);
    assert.equal(record.run.durationMs, 5000);
    assert.equal(record.run.mode, "board");
    assert.equal(record.run.question, "What is the plan?");
  });

  it("recordIsFailure flags a timed-out seat even when run status is done", () => {
    assert.equal(recordIsFailure(runEntryToRecord(boardEntry(), { node: "n" })), true);
  });

  it("recordIsFailure is false for an all-ok run", () => {
    const clean = boardEntry({
      results: [{ agent: "alice", taskId: "t1", text: "x", ok: true }],
      missing: [],
    });
    assert.equal(recordIsFailure(runEntryToRecord(clean, { node: "n" })), false);
  });
});

describe("run-archive — SQLite store", () => {
  let stateDir;
  let archive;
  let clock;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-archive-test-"));
    clock = makeClock();
    archive = createRunArchive({ stateDir, node: "node-A", nowFn: clock.nowFn });
  });

  afterEach(() => {
    if (archive) archive.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("creates flight-recorder.db with a node column on runs", () => {
    archive.archiveRun(boardEntry());
    assert.ok(fs.existsSync(path.join(stateDir, "flight-recorder.db")));
    const detail = archive.getRun("orx_board1");
    assert.equal(detail.run.node, "node-A");
  });

  it("archives a board run with all seats and returns detail", () => {
    archive.archiveRun(boardEntry());
    const detail = archive.getRun("orx_board1");
    assert.equal(detail.run.mode, "board");
    assert.equal(detail.run.status, "done");
    assert.equal(detail.seats.length, 3);
    assert.equal(detail.seats[0].agent, "alice");
    assert.equal(detail.seats[0].resultText, "Plan A details");
    assert.equal(detail.seats[1].status, "timeout");
  });

  it("archives a chain run", () => {
    archive.archiveRun(chainEntry());
    const detail = archive.getRun("orx_chain1");
    assert.equal(detail.run.mode, "chain");
    assert.equal(detail.seats.length, 2);
    assert.equal(detail.seats[1].resultText, "step2 out");
  });

  it("is idempotent on runId (double archive does not duplicate seats)", () => {
    archive.archiveRun(boardEntry());
    archive.archiveRun(boardEntry());
    const detail = archive.getRun("orx_board1");
    assert.equal(detail.seats.length, 3);
  });

  it("lists runs newest-first with paging cursor", () => {
    archive.archiveRun(boardEntry({ runId: "r1" }));
    clock.advance(10);
    archive.archiveRun(boardEntry({ runId: "r2" }));
    clock.advance(10);
    archive.archiveRun(boardEntry({ runId: "r3" }));

    const page1 = archive.listRuns({ limit: 2 });
    assert.equal(page1.runs.length, 2);
    assert.equal(page1.runs[0].runId, "r3");
    assert.equal(page1.runs[1].runId, "r2");
    assert.equal(page1.page.hasMore, true);
    assert.ok(page1.page.nextBefore);

    const page2 = archive.listRuns({ limit: 2, before: Date.parse(page1.page.nextBefore) });
    assert.equal(page2.runs.length, 1);
    assert.equal(page2.runs[0].runId, "r1");
    assert.equal(page2.page.hasMore, false);
  });

  it("filters by status and by agent", () => {
    archive.archiveRun(boardEntry({ runId: "ok-run", status: "done", missing: [] }));
    archive.archiveRun(boardEntry({ runId: "fail-run", status: "failed" }));

    const failed = archive.listRuns({ status: "failed" });
    assert.equal(failed.runs.length, 1);
    assert.equal(failed.runs[0].runId, "fail-run");

    const byAgent = archive.listRuns({ agent: "carol" });
    assert.equal(byAgent.runs.length, 2); // both entries include carol

    const noAgent = archive.listRuns({ agent: "nobody" });
    assert.equal(noAgent.runs.length, 0);
  });

  it("rejects an unknown status filter with a 400", () => {
    assert.throws(() => archive.listRuns({ status: "bogus" }), /Unknown status/);
  });

  it("prunes rows past the retention window", () => {
    const shortArchive = createRunArchive({
      stateDir,
      node: "node-A",
      retentionDays: 1,
      nowFn: clock.nowFn,
    });
    shortArchive.archiveRun(boardEntry({ runId: "old" }));
    // Advance well past the 1-day window, then archive a new run (triggers prune).
    clock.advance(3 * 24 * 60 * 60 * 1000);
    shortArchive.archiveRun(boardEntry({ runId: "fresh" }));
    assert.equal(shortArchive.getRun("old"), null);
    assert.ok(shortArchive.getRun("fresh"));
    shortArchive.close();
  });

  it("prunes beyond the maxRows cap (newest kept)", () => {
    const capped = createRunArchive({
      stateDir,
      node: "node-A",
      maxRows: 2,
      nowFn: clock.nowFn,
    });
    capped.archiveRun(boardEntry({ runId: "a" }));
    clock.advance(5);
    capped.archiveRun(boardEntry({ runId: "b" }));
    clock.advance(5);
    capped.archiveRun(boardEntry({ runId: "c" }));
    const all = capped.listRuns({ limit: 50 });
    assert.equal(all.runs.length, 2);
    assert.deepEqual(all.runs.map((r) => r.runId).sort(), ["b", "c"]);
    capped.close();
  });

  it("stats reports total and failed counts", () => {
    archive.archiveRun(boardEntry({ runId: "x1", status: "done", missing: [] }));
    archive.archiveRun(boardEntry({ runId: "x2", status: "failed" }));
    const s = archive.stats();
    assert.equal(s.total, 2);
    assert.equal(s.failed, 1);
  });
});
