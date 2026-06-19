const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createEvolution, parseLedger } = require("../src/evolution");

describe("evolution module", () => {
  let tmpDir;
  let workspaceDir;
  let stateDir;
  let events;

  function makeEvolution(extra = {}) {
    return createEvolution({
      workspaceDir,
      stateDir,
      onChange: (event) => events.push(event),
      ...extra,
    });
  }

  function ledgerContent() {
    return fs.readFileSync(path.join(workspaceDir, "lessons_learned.md"), "utf8");
  }

  function approvedContent() {
    const file = path.join(workspaceDir, "lessons_learned.approved.md");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evolution-test-"));
    workspaceDir = path.join(tmpDir, "workspace");
    stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    events = [];
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("createEvolution()", () => {
    it("requires workspaceDir and stateDir", () => {
      assert.throws(() => createEvolution({ stateDir }), /workspaceDir/);
      assert.throws(() => createEvolution({ workspaceDir }), /stateDir/);
    });

    it("defaults the gate to ON, honoring getGateDefault when provided", () => {
      assert.strictEqual(makeEvolution().getGate(), true);
      assert.strictEqual(makeEvolution({ getGateDefault: () => false }).getGate(), false);
    });
  });

  describe("addLesson() with gate ON", () => {
    it("appends a pending section and parses it back (round-trip)", () => {
      const evolution = makeEvolution();
      const lesson = evolution.addLesson({
        title: "Always run lint",
        body: "Lint catches style drift early.\nRun it before commits.",
        author: "agent-7",
      });

      assert.match(lesson.id, /^les_[0-9a-f]{6}$/);
      assert.strictEqual(lesson.status, "pending");

      const content = ledgerContent();
      assert.ok(content.includes("## [LESSON] Always run lint"));
      assert.ok(content.includes("- status: pending"));
      assert.ok(content.includes(`- id: ${lesson.id}`));
      assert.ok(content.includes("- author: agent-7"));

      const listed = makeEvolution().listLessons();
      assert.strictEqual(listed.length, 1);
      assert.strictEqual(listed[0].id, lesson.id);
      assert.strictEqual(listed[0].title, "Always run lint");
      assert.strictEqual(listed[0].status, "pending");
      assert.strictEqual(listed[0].author, "agent-7");
      assert.strictEqual(listed[0].body, "Lint catches style drift early.\nRun it before commits.");

      // Pending queue metadata persisted in state file.
      const state = evolution.getState();
      assert.strictEqual(state.pending.length, 1);
      assert.strictEqual(state.pending[0].id, lesson.id);

      // Not in the approved merged file.
      assert.strictEqual(approvedContent(), null);

      assert.strictEqual(events.filter((e) => e.type === "lesson.add").length, 1);
    });

    it("validates title, body, and author inputs", () => {
      const evolution = makeEvolution();
      assert.throws(() => evolution.addLesson({ title: "", body: "x" }), /title/);
      assert.throws(() => evolution.addLesson({ title: "a\nb", body: "x" }), /newlines/);
      assert.throws(() => evolution.addLesson({ title: "ok", body: "" }), /body/);
      assert.throws(() => evolution.addLesson({ title: "ok", body: 42 }), /body/);
      const lesson = evolution.addLesson({ title: "ok", body: "x" });
      assert.strictEqual(lesson.author, "unknown");
    });
  });

  describe("approve()", () => {
    it("rewrites only the status line, preserving the rest byte-for-byte", () => {
      const evolution = makeEvolution();
      evolution.addLesson({ title: "First", body: "Body one.", author: "a1" });
      const second = evolution.addLesson({ title: "Second", body: "Body two.", author: "a2" });

      const before = ledgerContent();
      evolution.approve(second.id, "reviewer");
      const after = ledgerContent();

      // Expected: only the status line within the second lesson's section flips.
      const expected = before.replace(
        `- status: pending\n- id: ${second.id}`,
        `- status: approved\n- id: ${second.id}`,
      );
      assert.strictEqual(after, expected);

      // First lesson untouched.
      const lessons = evolution.listLessons();
      assert.strictEqual(lessons.find((l) => l.title === "First").status, "pending");
      assert.strictEqual(lessons.find((l) => l.title === "Second").status, "approved");

      // Body appended to the approved merged file.
      const approved = approvedContent();
      assert.ok(approved.includes("## [LESSON] Second"));
      assert.ok(approved.includes("Body two."));
      assert.ok(!approved.includes("Body one."));

      // Pending queue updated, event fired.
      assert.deepStrictEqual(
        evolution.getState().pending.map((p) => p.id),
        [evolution.listLessons()[0].id],
      );
      const approveEvents = events.filter((e) => e.type === "lesson.approve");
      assert.strictEqual(approveEvents.length, 1);
      assert.strictEqual(approveEvents[0].actor, "reviewer");
    });

    it("throws for unknown ids, bad ids, and non-pending lessons", () => {
      const evolution = makeEvolution();
      const lesson = evolution.addLesson({ title: "T", body: "B" });
      assert.throws(() => evolution.approve("les_zzzzzz", "x"), /les_<6hex>/);
      assert.throws(() => evolution.approve("les_000000", "x"), /not found/);
      evolution.approve(lesson.id, "x");
      assert.throws(() => evolution.approve(lesson.id, "x"), /approved/);
    });
  });

  describe("reject()", () => {
    it("flips status to rejected without touching the approved file", () => {
      const evolution = makeEvolution();
      const lesson = evolution.addLesson({ title: "Bad idea", body: "Nope." });
      const before = ledgerContent();

      evolution.reject(lesson.id, "reviewer");

      const expected = before.replace(
        `- status: pending\n- id: ${lesson.id}`,
        `- status: rejected\n- id: ${lesson.id}`,
      );
      assert.strictEqual(ledgerContent(), expected);
      assert.strictEqual(approvedContent(), null);
      assert.deepStrictEqual(evolution.getState().pending, []);
      assert.strictEqual(events.filter((e) => e.type === "lesson.reject").length, 1);
    });
  });

  describe("gate OFF auto-approve", () => {
    it("records the lesson as approved in the ledger AND the approved file", () => {
      const evolution = makeEvolution();
      evolution.setGate(false, "admin");
      const lesson = evolution.addLesson({ title: "Fast path", body: "Ship it.", author: "bot" });

      assert.strictEqual(lesson.status, "approved");

      // Full audit trail: still present in the ledger with status approved.
      const ledger = ledgerContent();
      assert.ok(ledger.includes("## [LESSON] Fast path"));
      assert.ok(ledger.includes(`- id: ${lesson.id}`));
      assert.strictEqual(evolution.listLessons("approved").length, 1);

      // Merged into the active approved file.
      const approved = approvedContent();
      assert.ok(approved.includes("## [LESSON] Fast path"));
      assert.ok(approved.includes("Ship it."));

      // Nothing queued as pending.
      assert.deepStrictEqual(evolution.getState().pending, []);
    });
  });

  describe("lessonsVaultDir (gbrain vault mirror)", () => {
    function vaultDir() {
      return path.join(tmpDir, "vault", "lessons");
    }
    function vaultFile(id) {
      return path.join(vaultDir(), `${id}.md`);
    }

    it("writes a frontmatter markdown file when a lesson is approved via approve()", () => {
      const evolution = makeEvolution({ lessonsVaultDir: vaultDir() });
      const lesson = evolution.addLesson({
        title: "Mirror me",
        body: "Body line one.\nBody line two.",
        author: "agent-9",
      });

      // Pending: nothing written to the vault yet.
      assert.strictEqual(fs.existsSync(vaultFile(lesson.id)), false);

      evolution.approve(lesson.id, "reviewer");

      const file = vaultFile(lesson.id);
      assert.ok(fs.existsSync(file), "expected the vault markdown file to exist");
      const content = fs.readFileSync(file, "utf8");
      const expected =
        "---\n" +
        "type: lesson\n" +
        `id: ${lesson.id}\n` +
        "title: Mirror me\n" +
        "author: agent-9\n" +
        `ts: ${lesson.ts}\n` +
        "status: approved\n" +
        "---\n\n" +
        "Body line one.\nBody line two.\n";
      assert.strictEqual(content, expected);
    });

    it("writes the vault file on the gate-OFF auto-approve path too", () => {
      const evolution = makeEvolution({ lessonsVaultDir: vaultDir() });
      evolution.setGate(false, "admin");
      const lesson = evolution.addLesson({ title: "Fast", body: "Ship it.", author: "bot" });

      assert.strictEqual(lesson.status, "approved");
      const content = fs.readFileSync(vaultFile(lesson.id), "utf8");
      assert.ok(content.startsWith("---\ntype: lesson\n"));
      assert.ok(content.includes(`id: ${lesson.id}\n`));
      assert.ok(content.includes("title: Fast\n"));
      assert.ok(content.includes("status: approved\n"));
      assert.ok(content.endsWith("Ship it.\n"));
    });

    it("is a no-op when lessonsVaultDir is empty or unset", () => {
      // Unset.
      const a = makeEvolution();
      const l1 = a.addLesson({ title: "No vault", body: "x" });
      a.approve(l1.id, "r");
      assert.strictEqual(fs.existsSync(path.join(tmpDir, "vault")), false);

      // Explicit empty string.
      const b = makeEvolution({ lessonsVaultDir: "" });
      b.setGate(false, "admin");
      const l2 = b.addLesson({ title: "Still no vault", body: "y" });
      assert.strictEqual(l2.status, "approved");
      assert.strictEqual(fs.existsSync(path.join(tmpDir, "vault")), false);
    });

    it("never throws into the lesson path when the vault write fails", () => {
      // Point the vault at a path whose parent is a FILE — mkdirSync will throw,
      // and the mirror must swallow it without breaking lesson recording.
      const blocker = path.join(tmpDir, "blocker");
      fs.writeFileSync(blocker, "not a dir");
      const evolution = makeEvolution({ lessonsVaultDir: path.join(blocker, "nested") });
      evolution.setGate(false, "admin");

      const lesson = evolution.addLesson({ title: "Resilient", body: "Recorded anyway." });
      // Ledger (source of truth) still got the lesson.
      assert.strictEqual(lesson.status, "approved");
      assert.strictEqual(evolution.listLessons("approved").length, 1);
      assert.ok(approvedContent().includes("Recorded anyway."));
    });
  });

  describe("gate state", () => {
    it("setGate persists and fires onChange", () => {
      const evolution = makeEvolution();
      const result = evolution.setGate(false, "admin");
      assert.strictEqual(result.gate, false);
      assert.strictEqual(evolution.getGate(), false);

      const stateFile = JSON.parse(fs.readFileSync(path.join(stateDir, "evolution.json"), "utf8"));
      assert.strictEqual(stateFile.gate, false);

      const toggles = events.filter((e) => e.type === "gate.toggle");
      assert.strictEqual(toggles.length, 1);
      assert.strictEqual(toggles[0].gate, false);
      assert.strictEqual(toggles[0].actor, "admin");
    });
  });

  describe("malformed section tolerance", () => {
    it("surfaces malformed sections as parseError entries without crashing", () => {
      const evolution = makeEvolution();
      const good = evolution.addLesson({ title: "Good", body: "Fine." });

      // Corrupt the ledger with a half-written section.
      fs.appendFileSync(
        path.join(workspaceDir, "lessons_learned.md"),
        "\n## [LESSON] Broken one\nno metadata here at all\n",
      );

      const lessons = evolution.listLessons();
      assert.strictEqual(lessons.length, 2);
      const broken = lessons.find((l) => l.parseError);
      assert.ok(broken, "expected a parseError entry");
      assert.ok(broken.raw.includes("Broken one"));
      const valid = lessons.find((l) => !l.parseError);
      assert.strictEqual(valid.id, good.id);

      // Filtering by status skips malformed entries but works.
      assert.strictEqual(evolution.listLessons({ status: "pending" }).length, 1);

      // Approve still works with garbage in the file.
      evolution.approve(good.id, "reviewer");
      assert.strictEqual(evolution.listLessons("approved").length, 1);
    });

    it("parseLedger handles empty content", () => {
      assert.deepStrictEqual(parseLedger(""), []);
    });
  });

  describe("persistence across re-instantiation", () => {
    it("gate, pending queue, and lessons survive a new instance", () => {
      const first = makeEvolution();
      first.setGate(true, "admin");
      const lesson = first.addLesson({ title: "Persisted", body: "Still here.", author: "a" });
      first.setGate(false, "admin");

      const second = makeEvolution();
      assert.strictEqual(second.getGate(), false);
      assert.deepStrictEqual(
        second.getState().pending.map((p) => p.id),
        [lesson.id],
      );
      const lessons = second.listLessons();
      assert.strictEqual(lessons.length, 1);
      assert.strictEqual(lessons[0].status, "pending");

      // The pending lesson can still be approved by the new instance.
      second.approve(lesson.id, "reviewer");
      assert.deepStrictEqual(second.getState().pending, []);
      assert.ok(approvedContent().includes("Still here."));
    });
  });
});
