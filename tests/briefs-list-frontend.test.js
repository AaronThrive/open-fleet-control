/**
 * Tests for the pure (DOM-free) helpers used by the Briefs detail-list view:
 * row mapping, size formatting, filename normalization, and the safe
 * markdown renderer. The module is browser ESM, loaded via dynamic import.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert");

let toBriefRow;
let formatSize;
let normalizeBriefName;
let renderMarkdown;

before(async () => {
  const mod = await import("../public/js/views/briefs.js");
  toBriefRow = mod.toBriefRow;
  formatSize = mod.formatSize;
  normalizeBriefName = mod.normalizeBriefName;
  renderMarkdown = mod.renderMarkdown;
});

describe("toBriefRow()", () => {
  it("flattens a brief onto sortable/filterable row keys", () => {
    const brief = {
      name: "deploy-sop.md",
      size: 2048,
      updatedAt: "2026-06-10T12:00:00.000Z",
      firstHeading: "Deploy SOP",
    };
    const row = toBriefRow(brief);
    assert.strictEqual(row.id, "deploy-sop.md");
    assert.strictEqual(row.name, "deploy-sop.md");
    assert.strictEqual(row.heading, "Deploy SOP");
    assert.strictEqual(row.size, 2048);
    assert.strictEqual(row.updatedAt, "2026-06-10T12:00:00.000Z");
    assert.strictEqual(row.brief, brief);
  });

  it("normalizes missing fields", () => {
    const row = toBriefRow({ name: "bare.md" });
    assert.strictEqual(row.heading, "");
    assert.strictEqual(row.size, null);
    assert.strictEqual(row.updatedAt, "");
  });
});

describe("formatSize()", () => {
  it("formats bytes and kilobytes", () => {
    assert.strictEqual(formatSize(512), "512 B");
    assert.strictEqual(formatSize(2048), "2.0 KB");
  });

  it("returns empty string for non-finite input", () => {
    assert.strictEqual(formatSize(null), "");
    assert.strictEqual(formatSize(undefined), "");
  });
});

describe("normalizeBriefName()", () => {
  it("appends .md and accepts safe names", () => {
    assert.strictEqual(normalizeBriefName("runbook"), "runbook.md");
    assert.strictEqual(normalizeBriefName("deploy-sop.md"), "deploy-sop.md");
    assert.strictEqual(normalizeBriefName("  spaced  "), "spaced.md");
  });

  it("rejects traversal, hidden files, and junk", () => {
    assert.strictEqual(normalizeBriefName("../evil"), null);
    assert.strictEqual(normalizeBriefName(".hidden"), null);
    assert.strictEqual(normalizeBriefName("a b"), null);
    assert.strictEqual(normalizeBriefName(""), null);
    assert.strictEqual(normalizeBriefName(null), null);
  });
});

describe("renderMarkdown()", () => {
  it("renders headings, lists, and inline styles", () => {
    const html = renderMarkdown("# Title\n\n- one\n- two\n\n**bold** and `code`");
    assert.match(html, /<h1>Title<\/h1>/);
    assert.match(html, /<ul>\n<li>one<\/li>\n<li>two<\/li>\n<\/ul>/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<code>code<\/code>/);
  });

  it("escapes raw HTML — never passes user markup through", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="x">');
    assert.ok(!html.includes("<script>"));
    assert.ok(!html.includes("<img"));
    assert.match(html, /&lt;script&gt;/);
  });

  it("only links http(s) URLs", () => {
    const html = renderMarkdown("[ok](https://example.com) [bad](javascript:alert(1))");
    assert.match(html, /<a href="https:\/\/example\.com"/);
    assert.ok(!html.includes('href="javascript:'));
  });

  it("renders fenced code blocks verbatim (escaped)", () => {
    const html = renderMarkdown("```\nconst a = '<b>';\n```");
    assert.match(html, /<pre><code>const a = &#39;&lt;b&gt;&#39;;<\/code><\/pre>/);
  });
});
