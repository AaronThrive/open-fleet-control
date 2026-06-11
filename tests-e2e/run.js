#!/usr/bin/env node
/**
 * E2E smoke suite — boots the built server (lib/server.js) against fresh
 * temp state/logs/briefs dirs, drives headless system Chrome via
 * playwright-core, and walks the core fleet journeys:
 *
 *   a. dashboard loads (gate toggle present, LIVE indicator connects)
 *   b. mesh: empty state -> API node registration -> node card renders
 *   c. kanban: API task -> card in inbox -> drag to In Progress -> counts
 *   d. evolution: pending lesson -> approve -> gate OFF -> survives restart
 *   e. briefs: API PUT -> listed -> row expands preview -> editor shows content
 *   f. logs: audit rows render; action filter narrows to lesson.approve
 *
 * Run with: npm run test:e2e
 */

"use strict";

/* global window, document -- page.evaluate callbacks execute in the browser */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const {
  findChrome,
  getFreePort,
  httpJson,
  sleep,
  waitFor,
  makeTempDirs,
  buildFleetConfigJson,
  startServer,
} = require("./helpers");

const ARTIFACTS_DIR = path.join(__dirname, "artifacts");
const NODE_HOSTNAME = "e2e-node-1";
const TASK_TITLE = "E2E smoke task";
const LESSON_TITLE = "E2E smoke lesson";
const BRIEF_NAME = "e2e-playbook.md";
const BRIEF_HEADING = "# E2E Playbook";

// Mutable run context shared by the journeys (assembled in main()).
const ctx = {
  baseUrl: "",
  port: 0,
  dirs: null,
  fleetConfigJson: "",
  server: null,
  browser: null,
  page: null,
  taskId: null,
  lessonId: null,
  dragMethod: "not attempted",
};

function api(pathname, options) {
  return httpJson(`${ctx.baseUrl}${pathname}`, options);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Navigate the SPA to a hash view and give the partial a tick to mount. */
async function gotoView(view) {
  await ctx.page.evaluate(
    (v) => {
      window.location.hash = v;
    },
    view ? `#view-${view}` : "#",
  );
  await sleep(100);
}

// ---------------------------------------------------------------------------
// Journeys
// ---------------------------------------------------------------------------

async function journeyDashboard() {
  await ctx.page.goto(ctx.baseUrl, { waitUntil: "domcontentloaded", timeout: 15000 });

  await ctx.page.waitForSelector("#validation-gate-toggle", { state: "attached", timeout: 10000 });

  await waitFor(
    async () => {
      const text = await ctx.page.locator("#connection-status").textContent();
      return (text || "").includes("LIVE");
    },
    { label: "LIVE indicator on #connection-status", timeoutMs: 15000 },
  );
}

async function journeyMesh() {
  await gotoView("mesh");
  await ctx.page.waitForSelector("#mesh-empty-state", { state: "visible", timeout: 10000 });

  const { status, body } = await api("/api/fleet/mesh/nodes", {
    method: "POST",
    body: { hostname: NODE_HOSTNAME, port: 443, platform: "linux", label: "E2E node" },
  });
  assert(status === 200 && body?.success, `node register failed: HTTP ${status}`);

  // The mesh poller (intervalMs=1000) transitions the unreachable node and
  // emits an SSE fleet.mesh event, which triggers the view's refetch. If the
  // event is missed, re-entering the view forces a fresh fetch.
  const cardSelector = `.mesh-node-card:has-text("${NODE_HOSTNAME}")`;
  try {
    await ctx.page.waitForSelector(cardSelector, { state: "visible", timeout: 8000 });
  } catch (e) {
    await gotoView(null);
    await gotoView("mesh");
    await ctx.page.waitForSelector(cardSelector, { state: "visible", timeout: 8000 });
  }
}

async function journeyKanban() {
  await gotoView("kanban");
  await ctx.page.waitForSelector("#kanban-view-section", { state: "attached", timeout: 10000 });

  const { status, body } = await api("/api/fleet/kanban/tasks", {
    method: "POST",
    body: { title: TASK_TITLE, status: "inbox", priority: 2 },
  });
  assert(status === 200 && body?.task?.id, `task create failed: HTTP ${status}`);
  ctx.taskId = body.task.id;

  // SSE fleet.kanban event triggers the board refresh; fall back to re-entry.
  const cardSelector = `.kb-list[data-status="inbox"] .kb-card[data-id="${ctx.taskId}"]`;
  try {
    await ctx.page.waitForSelector(cardSelector, { state: "visible", timeout: 8000 });
  } catch (e) {
    await gotoView(null);
    await gotoView("kanban");
    await ctx.page.waitForSelector(cardSelector, { state: "visible", timeout: 8000 });
  }

  // --- Drag the card to In Progress: real mouse drag first ---------------
  const moved = await dragCardToColumn(cardSelector, "inprogress");
  if (moved) {
    ctx.dragMethod = "real mouse drag (SortableJS)";
  } else {
    const fallback = await api(`/api/fleet/kanban/tasks/${ctx.taskId}/move`, {
      method: "POST",
      body: { status: "inprogress", order: 0 },
    });
    assert(fallback.status === 200, `move API fallback failed: HTTP ${fallback.status}`);
    ctx.dragMethod = "move API fallback (mouse drag did not persist)";
  }

  // Server is the source of truth: the task must be in 'inprogress'.
  await waitFor(
    async () => {
      const board = await api("/api/fleet/kanban");
      const task = (board.body?.tasks || []).find((t) => t.id === ctx.taskId);
      return task?.status === "inprogress";
    },
    { label: "task status 'inprogress' on the server", timeoutMs: 6000 },
  );

  // UI: card sits in the In Progress column and counts read 0 / 1.
  await ctx.page.waitForSelector(
    `.kb-list[data-status="inprogress"] .kb-card[data-id="${ctx.taskId}"]`,
    { state: "visible", timeout: 8000 },
  );
  await waitFor(
    async () => {
      const counts = await ctx.page.evaluate(() => {
        const read = (status) =>
          document.querySelector(`.kb-col[data-status="${status}"] .kb-count`)?.textContent?.trim();
        return { inbox: read("inbox"), inprogress: read("inprogress") };
      });
      return counts.inbox === "0" && counts.inprogress === "1";
    },
    { label: "kanban column counts inbox=0 / inprogress=1", timeoutMs: 6000 },
  );
}

/**
 * Attempt a real SortableJS drag with mouse events. Returns true when the
 * server records the task in the target column afterwards.
 */
async function dragCardToColumn(cardSelector, targetStatus) {
  try {
    const card = ctx.page.locator(cardSelector);
    const target = ctx.page.locator(`.kb-list[data-status="${targetStatus}"]`);
    const cardBox = await card.boundingBox();
    const targetBox = await target.boundingBox();
    if (!cardBox || !targetBox) return false;

    const from = { x: cardBox.x + cardBox.width / 2, y: cardBox.y + cardBox.height / 2 };
    const to = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + 30 };

    await ctx.page.mouse.move(from.x, from.y);
    await ctx.page.mouse.down();
    await ctx.page.mouse.move(from.x + 8, from.y + 8, { steps: 4 }); // exceed drag threshold
    await ctx.page.mouse.move(to.x, to.y, { steps: 16 });
    await sleep(150);
    await ctx.page.mouse.move(to.x + 2, to.y + 2, { steps: 2 });
    await ctx.page.mouse.up();

    await waitFor(
      async () => {
        const board = await api("/api/fleet/kanban");
        const task = (board.body?.tasks || []).find((t) => t.id === ctx.taskId);
        return task?.status === targetStatus;
      },
      { label: "drag persisted to server", timeoutMs: 4000 },
    );
    return true;
  } catch (e) {
    return false;
  }
}

async function journeyEvolution() {
  // Gate defaults ON, so a new lesson lands as 'pending'.
  const gateBefore = await api("/api/fleet/evolution/gate");
  assert(
    gateBefore.body?.gate === true,
    `expected gate ON by default, got ${gateBefore.body?.gate}`,
  );

  const seeded = await api("/api/fleet/evolution/lessons", {
    method: "POST",
    body: { title: LESSON_TITLE, body: "Always verify before declaring done.", author: "e2e" },
  });
  assert(
    seeded.status === 200 && seeded.body?.lesson?.id,
    `lesson seed failed: HTTP ${seeded.status}`,
  );
  assert(
    seeded.body.lesson.status === "pending",
    `expected pending lesson, got ${seeded.body.lesson.status}`,
  );
  ctx.lessonId = seeded.body.lesson.id;

  await gotoView("evolution");
  const cardSelector = `.evo-card[data-lesson-id="${ctx.lessonId}"]`;
  await ctx.page.waitForSelector(cardSelector, { state: "visible", timeout: 10000 });

  // Approve from the Pending tab.
  await ctx.page.click(`${cardSelector} button[data-action="approve"]`);
  await waitFor(
    async () => {
      const evo = await api("/api/fleet/evolution");
      const lesson = (evo.body?.lessons || []).find((l) => l.id === ctx.lessonId);
      return lesson?.status === "approved";
    },
    { label: "lesson approved on the server", timeoutMs: 6000 },
  );

  // The Approved tab now lists the lesson.
  await ctx.page.click('.evo-tab[data-status="approved"]');
  await ctx.page.waitForSelector(cardSelector, { state: "visible", timeout: 6000 });

  // Toggle the gate OFF via the header switch.
  await ctx.page.click("#validation-gate-toggle");
  await waitFor(
    async () => {
      const gate = await api("/api/fleet/evolution/gate");
      return gate.body?.gate === false;
    },
    { label: "gate=false after header toggle", timeoutMs: 6000 },
  );

  // Restart the server on the same state dirs and port: the gate must persist.
  await ctx.server.stop();
  ctx.server = await startServer({ port: ctx.port, fleetConfigJson: ctx.fleetConfigJson });

  const gateAfter = await api("/api/fleet/evolution/gate");
  assert(
    gateAfter.status === 200 && gateAfter.body?.gate === false,
    `gate did not persist across restart: HTTP ${gateAfter.status}, gate=${gateAfter.body?.gate}`,
  );

  // Fresh page load against the restarted server for the remaining journeys.
  await ctx.page.goto(ctx.baseUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
}

async function journeyBriefs() {
  const put = await api(`/api/fleet/briefs/${BRIEF_NAME}`, {
    method: "PUT",
    body: { content: `${BRIEF_HEADING}\n\nSmoke-test brief written by the e2e suite.\n` },
  });
  assert(put.status === 200 && put.body?.success, `brief PUT failed: HTTP ${put.status}`);

  await gotoView("briefs");
  // v2.2: briefs render as detail-list rows; clicking a row expands the
  // rendered markdown preview, and the Edit action opens the editor.
  const rowSelector = `#briefs-view-section .dl-row:has-text("${BRIEF_NAME}")`;
  await ctx.page.waitForSelector(rowSelector, { state: "visible", timeout: 10000 });
  await ctx.page.click(rowSelector);

  const headingText = BRIEF_HEADING.replace(/^#\s*/, "");
  await ctx.page.waitForSelector(
    `#briefs-view-section .dl-detail-row .briefs-preview h1:has-text("${headingText}")`,
    { state: "visible", timeout: 6000 },
  );

  await ctx.page.click(`#briefs-view-section .dl-detail-row .briefs-edit-btn`);
  await ctx.page.waitForSelector("#briefs-editor", { state: "visible", timeout: 6000 });
  await waitFor(
    async () => {
      const value = await ctx.page.locator("#briefs-textarea").inputValue();
      return value.includes(BRIEF_HEADING);
    },
    { label: "brief content visible in the editor", timeoutMs: 6000 },
  );
  const shownName = await ctx.page.locator("#briefs-editor-filename").textContent();
  assert((shownName || "").trim() === BRIEF_NAME, `editor filename mismatch: ${shownName}`);
}

async function journeyLogs() {
  await gotoView("logs");
  await ctx.page.waitForSelector("#logs-view-section", { state: "attached", timeout: 10000 });

  // Unfiltered: the earlier mutations produced several audit entries.
  await waitFor(async () => (await ctx.page.locator(".logs-row").count()) >= 3, {
    label: "at least 3 unfiltered audit rows",
    timeoutMs: 10000,
  });

  // Filter by action=lesson.approve (change event applies the filter).
  await ctx.page.selectOption("#logs-filter-action", "lesson.approve");
  await waitFor(
    async () => {
      const rows = await ctx.page.locator(".logs-row").count();
      if (rows < 1) return false;
      const text = await ctx.page.locator("#logs-rows").textContent();
      return (text || "").includes("lesson.approve");
    },
    { label: ">=1 audit row for action=lesson.approve", timeoutMs: 10000 },
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const JOURNEYS = [
  ["dashboard-loads", journeyDashboard],
  ["mesh-register-node", journeyMesh],
  ["kanban-create-and-drag", journeyKanban],
  ["evolution-gate-persistence", journeyEvolution],
  ["briefs-create-and-view", journeyBriefs],
  ["logs-audit-filter", journeyLogs],
];

async function screenshotOnFailure(name) {
  try {
    if (!ctx.page) return null;
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    const file = path.join(ARTIFACTS_DIR, `${name}-${Date.now()}.png`);
    await ctx.page.screenshot({ path: file, fullPage: true });
    return file;
  } catch (e) {
    return null;
  }
}

async function launchBrowser(executablePath) {
  try {
    return await chromium.launch({ executablePath, headless: true });
  } catch (e) {
    // Some hosts need the sandbox disabled (containers, restricted kernels).
    return await chromium.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  }
}

async function main() {
  const startedAt = Date.now();
  const chromePath = findChrome();
  console.log(`[e2e] Chrome: ${chromePath}`);

  ctx.dirs = makeTempDirs();
  ctx.fleetConfigJson = buildFleetConfigJson(ctx.dirs);
  ctx.port = await getFreePort();
  ctx.baseUrl = `http://localhost:${ctx.port}`;
  console.log(`[e2e] Server: ${ctx.baseUrl} (state under ${ctx.dirs.root})`);

  ctx.server = await startServer({ port: ctx.port, fleetConfigJson: ctx.fleetConfigJson });
  ctx.browser = await launchBrowser(chromePath);
  ctx.page = await ctx.browser.newPage({ viewport: { width: 1440, height: 900 } });
  ctx.page.setDefaultTimeout(10000);

  const results = [];
  for (const [name, fn] of JOURNEYS) {
    const t0 = Date.now();
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`PASS ${name} (${Date.now() - t0}ms)`);
    } catch (e) {
      const shot = await screenshotOnFailure(name);
      results.push({ name, ok: false, error: e.message });
      console.error(`FAIL ${name} (${Date.now() - t0}ms): ${e.message}`);
      if (shot) console.error(`     screenshot: ${shot}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `[e2e] ${results.length - failed.length}/${results.length} journeys passed ` +
      `in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — drag method: ${ctx.dragMethod}`,
  );
  return failed.length === 0 ? 0 : 1;
}

async function cleanup() {
  try {
    if (ctx.browser) await ctx.browser.close();
  } catch (e) {
    console.error(`[e2e] browser close failed: ${e.message}`);
  }
  try {
    if (ctx.server) await ctx.server.stop();
  } catch (e) {
    console.error(`[e2e] server stop failed: ${e.message}`);
  }
  try {
    if (ctx.dirs) fs.rmSync(ctx.dirs.root, { recursive: true, force: true });
  } catch (e) {
    console.error(`[e2e] temp dir cleanup failed: ${e.message}`);
  }
}

main()
  .then(async (code) => {
    await cleanup();
    process.exit(code);
  })
  .catch(async (e) => {
    console.error(`[e2e] Fatal: ${e.stack || e.message}`);
    await cleanup();
    process.exit(1);
  });
