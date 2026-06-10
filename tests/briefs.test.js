const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createBriefs, validateBriefName, resolveBriefPath } = require("../src/briefs");

describe("briefs module", () => {
  let tmpDir;
  let briefs;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "briefs-test-"));
    briefs = createBriefs({ briefsDir: tmpDir });
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("createBriefs()", () => {
    it("throws without a briefsDir", () => {
      assert.throws(() => createBriefs({}), /briefsDir/);
      assert.throws(() => createBriefs(), /briefsDir/);
    });
  });

  describe("path traversal protection (regex layer)", () => {
    const attacks = [
      "../evil.md",
      "..\\evil.md",
      "../../etc/passwd.md",
      "/etc/passwd.md",
      "/tmp/abs.md",
      "%2e%2e%2fevil.md",
      "..%2Fevil.md",
      "sub/nested.md",
      "a\\b.md",
      "notes.txt",
      "noextension",
      "trailing.md ",
      "name with space.md",
      "evil.md\n.md",
    ];

    for (const name of attacks) {
      it(`rejects ${JSON.stringify(name)}`, () => {
        assert.throws(() => briefs.read(name), /Invalid brief name|non-empty string/);
        assert.throws(() => briefs.write(name, "# x"), /Invalid brief name|non-empty string/);
        assert.throws(() => briefs.remove(name), /Invalid brief name|non-empty string/);
      });
    }

    it("rejects dotfiles and names starting with '.'", () => {
      assert.throws(() => briefs.write(".hidden.md", "# x"), /dotfiles|'\.'/);
      assert.throws(() => briefs.read(".env.md"), /dotfiles|'\.'/);
    });

    it("rejects empty and non-string names", () => {
      assert.throws(() => briefs.read(""), /non-empty string/);
      assert.throws(() => briefs.read(null), /non-empty string/);
      assert.throws(() => briefs.read(123), /non-empty string/);
      assert.throws(() => briefs.read(undefined), /non-empty string/);
    });

    it("validateBriefName accepts safe names", () => {
      assert.strictEqual(validateBriefName("sop-deploy_v2.1.md"), "sop-deploy_v2.1.md");
      assert.strictEqual(validateBriefName("A.md"), "A.md");
    });
  });

  describe("path traversal protection (resolve layer, defense in depth)", () => {
    it("independently rejects traversal even when the regex layer is bypassed", () => {
      // Call the resolve layer directly with names that the regex would have
      // caught — proving the second layer stands on its own.
      assert.throws(() => resolveBriefPath(tmpDir, "../escape.md"), /escapes|nested/);
      assert.throws(() => resolveBriefPath(tmpDir, "../../etc/passwd.md"), /escapes|nested/);
      assert.throws(() => resolveBriefPath(tmpDir, "/etc/passwd.md"), /escapes|nested/);
      assert.throws(() => resolveBriefPath(tmpDir, "sub/nested.md"), /escapes|nested/);
      assert.throws(() => resolveBriefPath(tmpDir, ".."), /escapes|nested/);
      assert.throws(() => resolveBriefPath(tmpDir, "."), /escapes|nested/);
    });

    it("keeps regex-passing dot-heavy names inside the briefs dir", () => {
      // "..md" passes the regex (dots are allowed characters) — verify the
      // resolve layer confirms it stays within briefsDir.
      const resolved = resolveBriefPath(tmpDir, "..md");
      assert.ok(resolved.startsWith(path.resolve(tmpDir) + path.sep));
      assert.strictEqual(path.basename(resolved), "..md");
    });

    it("returns the absolute path for safe names", () => {
      const resolved = resolveBriefPath(tmpDir, "ok.md");
      assert.strictEqual(resolved, path.join(path.resolve(tmpDir), "ok.md"));
    });
  });

  describe("CRUD round-trip", () => {
    it("writes, reads, lists, and removes a brief", () => {
      const meta = briefs.write("deploy.md", "# Deploy SOP\n\nSteps here.\n");
      assert.strictEqual(meta.name, "deploy.md");
      assert.ok(meta.size > 0);
      assert.ok(meta.updatedAt);

      const doc = briefs.read("deploy.md");
      assert.strictEqual(doc.content, "# Deploy SOP\n\nSteps here.\n");
      assert.strictEqual(doc.firstHeading, "Deploy SOP");
      assert.strictEqual(doc.name, "deploy.md");
      assert.ok(doc.size > 0);

      const listed = briefs.list();
      assert.strictEqual(listed.length, 1);
      assert.strictEqual(listed[0].name, "deploy.md");
      assert.strictEqual(listed[0].firstHeading, "Deploy SOP");
      assert.ok(listed[0].size > 0);
      assert.ok(listed[0].updatedAt);

      const removed = briefs.remove("deploy.md");
      assert.strictEqual(removed.removed, true);
      assert.deepStrictEqual(briefs.list(), []);
      assert.throws(() => briefs.read("deploy.md"), /not found/);
    });

    it("overwrites existing briefs atomically", () => {
      briefs.write("a.md", "# v1");
      briefs.write("a.md", "# v2");
      assert.strictEqual(briefs.read("a.md").content, "# v2");
      // No temp files left behind.
      const leftovers = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".tmp"));
      assert.deepStrictEqual(leftovers, []);
    });

    it("returns empty list when the directory does not exist", () => {
      const ghost = createBriefs({ briefsDir: path.join(tmpDir, "ghost") });
      assert.deepStrictEqual(ghost.list(), []);
    });

    it("list() only includes *.md files, skipping dotfiles, other types, and dirs", () => {
      briefs.write("keep.md", "# Keep");
      fs.writeFileSync(path.join(tmpDir, "skip.txt"), "nope");
      fs.writeFileSync(path.join(tmpDir, ".hidden.md"), "# hidden");
      fs.mkdirSync(path.join(tmpDir, "subdir.md"));
      const listed = briefs.list();
      assert.deepStrictEqual(
        listed.map((b) => b.name),
        ["keep.md"],
      );
    });

    it("reports null firstHeading when no heading exists", () => {
      briefs.write("plain.md", "just text, no heading");
      assert.strictEqual(briefs.read("plain.md").firstHeading, null);
    });

    it("remove() throws a descriptive not-found error", () => {
      assert.throws(() => briefs.remove("missing.md"), /Brief not found: "missing\.md"/);
    });
  });

  describe("write() validation", () => {
    it("rejects non-string content", () => {
      assert.throws(() => briefs.write("a.md", 42), /must be a string/);
      assert.throws(() => briefs.write("a.md", null), /must be a string/);
      assert.throws(() => briefs.write("a.md", { md: true }), /must be a string/);
    });

    it("rejects content larger than 1MB and accepts exactly 1MB", () => {
      const oneMb = "a".repeat(1024 * 1024);
      briefs.write("big.md", oneMb); // exactly 1MB is allowed
      assert.throws(() => briefs.write("big.md", oneMb + "a"), /too large/);
    });
  });

  describe("error hygiene", () => {
    it("never leaks the absolute briefs directory in error messages", () => {
      const failures = [
        () => briefs.read("missing.md"),
        () => briefs.remove("missing.md"),
        () => briefs.read("../evil.md"),
        () => briefs.write("../evil.md", "x"),
      ];
      for (const fn of failures) {
        try {
          fn();
          assert.fail("expected an error");
        } catch (e) {
          assert.ok(!e.message.includes(tmpDir), `error message leaked path: ${e.message}`);
        }
      }
    });
  });
});
