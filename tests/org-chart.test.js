/**
 * Unit tests for src/org-chart.js — schema validation (validateChart /
 * normalizeChart), tree move + orphan handling via full-tree replace, and the
 * safe-store behaviors (atomic writes, rolling backups under .backups/,
 * quarantine + restore on corruption).
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  CHART_VERSION,
  validateChart,
  createEmptyChart,
  normalizeChart,
  countNodes,
  createOrgChart,
} = require("../src/org-chart");

function node(agentId, children = [], title = null) {
  return { agentId, title, children };
}

function chart(roots = [], unassigned = []) {
  return { version: CHART_VERSION, updated_at: new Date().toISOString(), roots, unassigned };
}

function reasons(result) {
  return result.errors.map((e) => `${e.path}: ${e.reason}`).join("; ");
}

describe("org-chart schema", () => {
  it("accepts an empty chart", () => {
    const result = validateChart(createEmptyChart());
    assert.strictEqual(result.valid, true, reasons(result));
  });

  it("accepts a nested tree with titles and unassigned ids", () => {
    const candidate = chart(
      [node("ceo", [node("lead-a", [node("worker-1"), node("worker-2")], "Lead — Marketing")])],
      ["bench-1"],
    );
    const result = validateChart(candidate);
    assert.strictEqual(result.valid, true, reasons(result));
  });

  it("rejects non-object charts and wrong versions", () => {
    assert.strictEqual(validateChart(null).valid, false);
    assert.strictEqual(validateChart([]).valid, false);
    const bad = { ...chart(), version: 2 };
    const result = validateChart(bad);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === "version"));
  });

  it("rejects unknown chart and node fields", () => {
    const result = validateChart({ ...chart(), extra: true });
    assert.ok(result.errors.some((e) => e.path === "extra"));

    const nodeResult = validateChart(chart([{ ...node("a"), color: "red" }]));
    assert.ok(nodeResult.errors.some((e) => e.path === "roots[0].color"));
  });

  it("rejects bad agentIds, titles and children", () => {
    for (const bad of [node(""), node(42), node("x".repeat(129))]) {
      assert.strictEqual(validateChart(chart([bad])).valid, false);
    }
    assert.strictEqual(validateChart(chart([node("a", [], "t".repeat(121))])).valid, false);
    assert.strictEqual(
      validateChart(chart([{ agentId: "a", title: null, children: {} }])).valid,
      false,
    );
  });

  it("rejects duplicate agentIds across tree and unassigned", () => {
    const dupInTree = validateChart(chart([node("a", [node("a")])]));
    assert.ok(dupInTree.errors.some((e) => /duplicate agentId 'a'/.test(e.reason)));

    const dupAcross = validateChart(chart([node("a")], ["a"]));
    assert.ok(dupAcross.errors.some((e) => /duplicate agentId 'a'/.test(e.reason)));

    const dupInTray = validateChart(chart([], ["b", "b"]));
    assert.ok(dupInTray.errors.some((e) => /duplicate agentId 'b'/.test(e.reason)));
  });

  it("rejects malformed unassigned entries", () => {
    assert.strictEqual(validateChart(chart([], [""])).valid, false);
    assert.strictEqual(validateChart(chart([], [7])).valid, false);
    assert.strictEqual(validateChart({ ...chart(), unassigned: "nope" }).valid, false);
  });

  it("rejects trees deeper than the depth limit", () => {
    let deep = node("leaf");
    for (let i = 0; i < 12; i++) deep = node(`level-${i}`, [deep]);
    const result = validateChart(chart([deep]));
    assert.ok(
      result.errors.some((e) => /deeper than/.test(e.reason)),
      reasons(result),
    );
  });

  it("rejects charts exceeding the node count limit", () => {
    const roots = [];
    for (let i = 0; i < 501; i++) roots.push(node(`agent-${i}`));
    const result = validateChart(chart(roots));
    assert.ok(
      result.errors.some((e) => /exceeds 500 nodes/.test(e.reason)),
      reasons(result),
    );
  });
});

describe("org-chart normalizeChart", () => {
  it("applies defaults (version, updated_at, empty arrays, null titles)", () => {
    const result = normalizeChart({ roots: [{ agentId: "a", children: [] }] });
    assert.strictEqual(result.version, CHART_VERSION);
    assert.ok(!Number.isNaN(Date.parse(result.updated_at)));
    assert.deepStrictEqual(result.unassigned, []);
    assert.strictEqual(result.roots[0].title, null);
  });

  it("coerces empty-string titles to null", () => {
    const result = normalizeChart({ roots: [{ agentId: "a", title: "", children: [] }] });
    assert.strictEqual(result.roots[0].title, null);
  });

  it("throws with an errors property on invalid input", () => {
    assert.throws(
      () =>
        normalizeChart({
          roots: [
            { agentId: "a", children: [] },
            { agentId: "a", children: [] },
          ],
        }),
      (err) => Array.isArray(err.errors) && /duplicate agentId/.test(err.message),
    );
    assert.throws(() => normalizeChart("nope"), /must be an object/);
    assert.throws(
      () => normalizeChart({ roots: {} }),
      (err) => Array.isArray(err.errors),
    );
  });

  it("does not mutate its input", () => {
    const input = { roots: [{ agentId: "a", children: [{ agentId: "b", children: [] }] }] };
    const snapshot = JSON.parse(JSON.stringify(input));
    normalizeChart(input);
    assert.deepStrictEqual(input, snapshot);
  });
});

describe("org-chart countNodes", () => {
  it("counts every placed node", () => {
    assert.strictEqual(countNodes([]), 0);
    assert.strictEqual(countNodes([node("a", [node("b"), node("c", [node("d")])])]), 4);
  });
});

describe("org-chart engine", () => {
  let tmpDir;
  let events;
  let engine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofc-org-chart-"));
    events = [];
    engine = createOrgChart({ stateDir: tmpDir, onChange: (e) => events.push(e) });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("requires a stateDir", () => {
    assert.throws(() => createOrgChart({}), /stateDir is required/);
  });

  it("returns an empty default chart before any write", () => {
    const data = engine.getChart();
    assert.strictEqual(data.version, CHART_VERSION);
    assert.deepStrictEqual(data.roots, []);
    assert.deepStrictEqual(data.unassigned, []);
  });

  it("replaceChart persists, fires org.updated and survives re-read", () => {
    const persisted = engine.replaceChart(
      { roots: [node("ceo", [node("lead", [node("worker")])])], unassigned: ["bench"] },
      "owner@example.com",
    );
    assert.strictEqual(persisted.roots[0].agentId, "ceo");

    const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, "org-chart.json"), "utf8"));
    assert.strictEqual(onDisk.roots[0].children[0].agentId, "lead");
    assert.deepStrictEqual(onDisk.unassigned, ["bench"]);

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, "org.updated");
    assert.strictEqual(events[0].actor, "owner@example.com");
    assert.strictEqual(events[0].nodes, 3);
    assert.strictEqual(events[0].unassigned, 1);

    assert.strictEqual(engine.getChart().roots[0].children[0].children[0].agentId, "worker");
  });

  it("full-tree replace implements moves (re-parenting)", () => {
    engine.replaceChart({ roots: [node("ceo", [node("a"), node("b")])] }, "owner");
    // Move "b" under "a" — the UI PUTs the whole re-parented tree.
    engine.replaceChart({ roots: [node("ceo", [node("a", [node("b")])])] }, "owner");
    const data = engine.getChart();
    assert.strictEqual(data.roots[0].children.length, 1);
    assert.strictEqual(data.roots[0].children[0].children[0].agentId, "b");
  });

  it("tolerates orphan agentIds that no longer exist in any roster", () => {
    // The chart references agents by id only; a deleted agent must not
    // invalidate the stored tree (the UI ghosts it instead).
    const persisted = engine.replaceChart(
      { roots: [node("ghost-agent-gone", [node("still-here")])] },
      "owner",
    );
    assert.strictEqual(persisted.roots[0].agentId, "ghost-agent-gone");
  });

  it("rejects invalid replacements without touching the stored chart", () => {
    engine.replaceChart({ roots: [node("keep")] }, "owner");
    assert.throws(
      () => engine.replaceChart({ roots: [node("dup"), node("dup")] }, "owner"),
      /duplicate agentId/,
    );
    assert.strictEqual(engine.getChart().roots[0].agentId, "keep");
    assert.strictEqual(events.length, 1); // no event for the rejected write
  });

  it("keeps rolling backups under .backups/", () => {
    engine.replaceChart({ roots: [node("v1")] }, "owner");
    engine.replaceChart({ roots: [node("v2")] }, "owner");
    const backupDir = path.join(tmpDir, ".backups");
    const backups = fs.readdirSync(backupDir).filter((f) => f.startsWith("org-chart."));
    assert.ok(backups.length >= 1, "expected at least one rolling backup");
    const restored = JSON.parse(fs.readFileSync(path.join(backupDir, backups[0]), "utf8"));
    assert.strictEqual(restored.roots[0].agentId, "v1");
  });

  it("quarantines a corrupt state file and restores the newest backup", () => {
    engine.replaceChart({ roots: [node("good")] }, "owner");
    engine.replaceChart({ roots: [node("better")] }, "owner");
    fs.writeFileSync(path.join(tmpDir, "org-chart.json"), "{not json", "utf8");

    // Backups hold the PREVIOUS good version of each write — the newest
    // backup after writing v1+v2 is v1 ("good").
    const recovered = engine.getChart();
    assert.strictEqual(recovered.roots[0].agentId, "good");

    const quarantined = fs.readdirSync(tmpDir).filter((f) => f.startsWith("org-chart.quarantine."));
    assert.strictEqual(quarantined.length, 1);
  });

  it("falls back to an empty chart when no valid backup exists", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "org-chart.json"), '{"version":99}', "utf8");
    const data = engine.getChart();
    assert.deepStrictEqual(data.roots, []);
  });
});
