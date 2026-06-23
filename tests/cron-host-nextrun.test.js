"use strict";

// Unit coverage for the host-crontab next-run calculator + line mapper in
// src/cron.js (cronFieldValues, cronNextRunMs, hostCronLastRunMs, mapHostCronLine).
// These power the Cron view's host-source jobs (system crontab), which carry no
// scheduler metadata of their own — OFC computes next-run from the cron expr.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");

const { cronFieldValues, cronNextRunMs, hostCronLastRunMs, mapHostCronLine } = require("../src/cron");

test("cronFieldValues: star expands to the full inclusive range", () => {
  const v = cronFieldValues("*", 0, 59);
  assert.equal(v.size, 60);
  assert.ok(v.has(0) && v.has(59));
});

test("cronFieldValues: step, list, and range forms", () => {
  assert.deepEqual([...cronFieldValues("*/15", 0, 59)].sort((a, b) => a - b), [0, 15, 30, 45]);
  assert.deepEqual([...cronFieldValues("1,5,9", 0, 59)].sort((a, b) => a - b), [1, 5, 9]);
  assert.deepEqual([...cronFieldValues("8-11", 0, 23)].sort((a, b) => a - b), [8, 9, 10, 11]);
  assert.deepEqual([...cronFieldValues("0-20/5", 0, 59)].sort((a, b) => a - b), [0, 5, 10, 15, 20]);
});

test("cronFieldValues: rejects out-of-range / malformed → null", () => {
  assert.equal(cronFieldValues("99", 0, 59), null); // above max
  assert.equal(cronFieldValues("5-2", 0, 59), null); // inverted range
  assert.equal(cronFieldValues("*/0", 0, 59), null); // zero step
  assert.equal(cronFieldValues("abc", 0, 59), null); // non-numeric
});

test("cronNextRunMs: simple daily — next fire at the configured time", () => {
  // From 2026-06-23 08:00 local, '30 9 * * *' → same day 09:30.
  const from = new Date(2026, 5, 23, 8, 0, 0).getTime();
  const next = cronNextRunMs("30 9 * * *", from);
  const d = new Date(next);
  assert.equal(d.getHours(), 9);
  assert.equal(d.getMinutes(), 30);
  assert.equal(d.getDate(), 23);
});

test("cronNextRunMs: rolls to the next day when today's time has passed", () => {
  const from = new Date(2026, 5, 23, 10, 0, 0).getTime(); // 10:00, past 09:30
  const next = cronNextRunMs("30 9 * * *", from);
  assert.equal(new Date(next).getDate(), 24); // tomorrow
});

test("cronNextRunMs: hourly-at-:07 fires within the hour", () => {
  const from = new Date(2026, 5, 23, 4, 0, 0).getTime();
  const next = cronNextRunMs("7 * * * *", from);
  const d = new Date(next);
  assert.equal(d.getMinutes(), 7);
  assert.equal(d.getHours(), 4);
});

test("cronNextRunMs: dom AND dow both restricted → OR semantics (either matches)", () => {
  // '0 0 13 * 5' = midnight on the 13th OR any Friday. From Jun 1 2026 (a Mon),
  // the first match is the next Friday (Jun 5), NOT the 13th — proving OR, not AND.
  const from = new Date(2026, 5, 1, 0, 0, 0).getTime();
  const next = cronNextRunMs("0 0 13 * 5", from);
  const d = new Date(next);
  assert.equal(d.getDay(), 5); // Friday came first
  assert.equal(d.getDate(), 5);
});

test("cronNextRunMs: Sunday accepts both 0 and 7 in the dow field", () => {
  const from = new Date(2026, 5, 23, 0, 0, 0).getTime(); // Tue
  const via7 = cronNextRunMs("0 12 * * 7", from);
  const via0 = cronNextRunMs("0 12 * * 0", from);
  assert.equal(new Date(via7).getDay(), 0);
  assert.equal(new Date(via0).getDay(), 0);
  assert.equal(via7, via0);
});

test("cronNextRunMs: unparseable expression → null (no throw, no wrong time)", () => {
  assert.equal(cronNextRunMs("not a cron", Date.now()), null);
  assert.equal(cronNextRunMs("* *", Date.now()), null); // too few fields
});

test("hostCronLastRunMs: reads the redirect-log mtime under $HOME", () => {
  const logPath = path.join(os.tmpdir(), `cron-host-test-${process.pid}.log`);
  fs.writeFileSync(logPath, "x");
  try {
    // Only $HOME-relative targets are honored; a tmp path outside HOME must be
    // rejected (path-traversal guard), returning null.
    assert.equal(hostCronLastRunMs(`foo.sh >> ${logPath} 2>&1`), null);

    const homeLog = path.join(os.homedir(), `.ofc-cron-host-test-${process.pid}.log`);
    fs.writeFileSync(homeLog, "x");
    try {
      const ms = hostCronLastRunMs(`foo.sh >> ${homeLog} 2>&1`);
      assert.ok(Number.isFinite(ms), "returns the log mtime for a $HOME path");
    } finally {
      fs.unlinkSync(homeLog);
    }
  } finally {
    fs.unlinkSync(logPath);
  }
});

test("hostCronLastRunMs: no redirect / missing file → null", () => {
  assert.equal(hostCronLastRunMs("foo.sh"), null);
  assert.equal(hostCronLastRunMs("foo.sh >> /nonexistent/nope.log 2>&1"), null);
});

test("mapHostCronLine: builds a host job with computed next-run + distinct name", () => {
  const job = mapHostCronLine("7 * * * * /home/u/bin/vps-ntfy-monitor hourly >> ~/x.log 2>&1", 3, "oc-bot-1");
  assert.equal(job.source, "host");
  assert.equal(job.readOnly, true);
  assert.equal(job.node, "oc-bot-1");
  assert.equal(job.name, "vps-ntfy-monitor hourly"); // first arg appended for distinctness
  assert.ok(Number.isFinite(job.nextRunAtMs), "next-run computed from the expression");
  assert.equal(new Date(job.nextRunAtMs).getMinutes(), 7);
  assert.equal(job.lastStatus, null); // host cron status is genuinely untracked
});

test("mapHostCronLine: skips comments, blanks, and VAR=value lines", () => {
  assert.equal(mapHostCronLine("# a comment", 0, "n"), null);
  assert.equal(mapHostCronLine("", 1, "n"), null);
  assert.equal(mapHostCronLine("PATH=/usr/bin:/bin", 2, "n"), null);
  assert.equal(mapHostCronLine("0 9 *", 3, "n"), null); // too few fields
});
