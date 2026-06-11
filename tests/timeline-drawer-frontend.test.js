/**
 * Tests for the pure (DOM-free) helpers used by the timeline drawer
 * component. The module is browser ESM, so it is loaded via dynamic import.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert");

let groupEventsByDay;
let typeIcon;
let rangeToWindow;
let buildTimelineUrl;
let EVENT_TYPES;

before(async () => {
  const mod = await import("../public/js/components/timeline-drawer.js");
  groupEventsByDay = mod.groupEventsByDay;
  typeIcon = mod.typeIcon;
  rangeToWindow = mod.rangeToWindow;
  buildTimelineUrl = mod.buildTimelineUrl;
  EVENT_TYPES = mod.EVENT_TYPES;
});

/** Local YYYY-MM-DD for an epoch ms — same formula the component uses. */
function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

describe("groupEventsByDay()", () => {
  it("buckets newest-first events by local day, preserving order", () => {
    const dayA = Date.parse("2026-06-11T15:00:00");
    const dayB = Date.parse("2026-06-10T09:00:00");
    const events = [
      { ts: new Date(dayA).toISOString(), title: "1" },
      { ts: new Date(dayA - 3600000).toISOString(), title: "2" },
      { ts: new Date(dayB).toISOString(), title: "3" },
    ];
    const groups = groupEventsByDay(events);
    assert.strictEqual(groups.length, 2);
    assert.strictEqual(groups[0].day, localDay(dayA));
    assert.deepStrictEqual(
      groups[0].events.map((e) => e.title),
      ["1", "2"],
    );
    assert.strictEqual(groups[1].day, localDay(dayB));
  });

  it("tolerates empty/invalid input", () => {
    assert.deepStrictEqual(groupEventsByDay([]), []);
    assert.deepStrictEqual(groupEventsByDay(null), []);
    const groups = groupEventsByDay([{ ts: "garbage" }]);
    assert.strictEqual(groups[0].day, "unknown");
  });
});

describe("typeIcon()", () => {
  it("maps every known event type and falls back for unknowns", () => {
    for (const type of EVENT_TYPES) {
      assert.notStrictEqual(typeIcon(type), "•");
    }
    assert.strictEqual(typeIcon("mystery"), "•");
  });
});

describe("rangeToWindow()", () => {
  const NOW = Date.parse("2026-06-11T12:30:00");

  it("today starts at local midnight", () => {
    const { sinceMs, untilMs } = rangeToWindow("today", NOW);
    assert.strictEqual(untilMs, NOW);
    const start = new Date(sinceMs);
    assert.strictEqual(start.getHours(), 0);
    assert.strictEqual(start.getMinutes(), 0);
    assert.strictEqual(localDay(sinceMs), localDay(NOW));
  });

  it("24h and 7d are fixed offsets ending now", () => {
    assert.deepStrictEqual(rangeToWindow("24h", NOW), {
      sinceMs: NOW - 24 * 3600 * 1000,
      untilMs: NOW,
    });
    assert.deepStrictEqual(rangeToWindow("7d", NOW), {
      sinceMs: NOW - 7 * 24 * 3600 * 1000,
      untilMs: NOW,
    });
  });
});

describe("buildTimelineUrl()", () => {
  it("encodes the agent id and window params", () => {
    const url = buildTimelineUrl("ghl monitor", { sinceMs: 100, untilMs: 200, limit: 50 });
    assert.strictEqual(
      url,
      "/api/fleet/agents/ghl%20monitor/timeline?since=100&until=200&limit=50",
    );
  });

  it("omits the types param when all types are selected", () => {
    const all = buildTimelineUrl("main", { types: [...EVENT_TYPES] });
    assert.ok(!all.includes("types="));
    const some = buildTimelineUrl("main", { types: ["audit", "cron.run"] });
    assert.ok(some.includes(`types=${encodeURIComponent("audit,cron.run")}`));
  });

  it("produces a bare path with no options", () => {
    assert.strictEqual(buildTimelineUrl("main"), "/api/fleet/agents/main/timeline");
  });
});
