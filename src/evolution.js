/**
 * Evolution — lessons-learned ledger with a validation gate.
 *
 * Manages `lessons_learned.md` in a configurable workspace directory, plus
 * `evolution.json` in a configurable state directory (gate flag + pending
 * queue metadata). Approved lesson bodies are additionally appended to
 * `lessons_learned.approved.md` — the "active" merged file agents consume.
 *
 * Ledger format (lessons_learned.md): each lesson is a markdown section
 * appended as:
 *
 *   ## [LESSON] <title>
 *   - status: pending|approved|rejected
 *   - id: les_<6hex>
 *   - author: <agent>
 *   - ts: <ISO timestamp>
 *
 *   <body>
 *
 * Sections are separated by a blank line. Parsing is regex-based and
 * tolerant: malformed sections are surfaced as `{ parseError }` entries and
 * never crash the parser. Approve/reject rewrites ONLY the target section's
 * status line — every other byte of the ledger is preserved verbatim — and
 * the rewrite is atomic (temp file + rename).
 *
 * Gate semantics: when the gate is ON, new lessons are appended as `pending`
 * and must be approved; when OFF, lessons auto-approve but are still recorded
 * in the ledger with status `approved` (full audit trail). Gate state
 * persists in the state file; config wiring happens at integration time.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const LEDGER_FILE = "lessons_learned.md";
const APPROVED_FILE = "lessons_learned.approved.md";
const STATE_FILE = "evolution.json";
const LESSON_ID_RE = /^les_[0-9a-f]{6}$/;
const SECTION_HEADER_RE = /^## \[LESSON\] /gm;
const SECTION_RE =
  /^## \[LESSON\] (.+)\n- status: (pending|approved|rejected)[ \t]*\n- id: (les_[0-9a-f]{6})[ \t]*\n- author: ([^\n]*)\n- ts: ([^\n]*)\n\n?([\s\S]*)$/;

/**
 * Atomic write: temp file in the same directory, then rename.
 */
function atomicWriteFileSync(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch (cleanupErr) {
      // Temp file already gone — nothing to clean up.
    }
    throw e;
  }
}

/**
 * Parse the ledger into sections with byte offsets (for surgical rewrites).
 * Malformed sections become `{ parseError, raw, start, end }` entries.
 * @param {string} content - full ledger content
 * @returns {Array<object>} parsed lesson entries
 */
function parseLedger(content) {
  const sections = [];
  if (!content) return sections;

  const starts = [];
  SECTION_HEADER_RE.lastIndex = 0;
  let match;
  while ((match = SECTION_HEADER_RE.exec(content)) !== null) {
    starts.push(match.index);
  }

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : content.length;
    const raw = content.slice(start, end);
    const m = raw.match(SECTION_RE);
    if (!m) {
      sections.push({
        parseError: "Malformed lesson section: expected status/id/author/ts metadata lines",
        raw,
        start,
        end,
      });
      continue;
    }
    sections.push({
      title: m[1].trim(),
      status: m[2],
      id: m[3],
      author: m[4].trim(),
      ts: m[5].trim(),
      body: m[6].replace(/\s+$/, ""),
      raw,
      start,
      end,
    });
  }
  return sections;
}

/**
 * Format a lesson as a ledger section (without leading separator).
 */
function formatSection({ title, status, id, author, ts, body }) {
  return `## [LESSON] ${title}\n- status: ${status}\n- id: ${id}\n- author: ${author}\n- ts: ${ts}\n\n${body}\n`;
}

/**
 * Append a block to a markdown file, separated from prior content by a blank line.
 */
function appendBlock(filePath, block) {
  let existing = "";
  try {
    existing = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  let prefix = "";
  if (existing.length > 0) {
    prefix = existing.endsWith("\n") ? "\n" : "\n\n";
  }
  atomicWriteFileSync(filePath, existing + prefix + block);
}

/**
 * Creates the evolution module.
 *
 * @param {object} options
 * @param {string} options.workspaceDir - directory holding lessons_learned.md
 * @param {string} options.stateDir - directory holding evolution.json
 * @param {function} [options.onChange] - fired with an event object on every state change
 * @param {function} [options.getGateDefault] - returns the default gate value when no state persisted
 * @param {string} [options.lessonsVaultDir] - directory inside the gbrain-synced Obsidian
 *   vault where approved lessons are mirrored as markdown files (one per lesson). When
 *   unset/empty, no vault mirror is written — behavior is byte-identical to before.
 * @returns {{addLesson: function, listLessons: function, approve: function, reject: function, getGate: function, setGate: function, getState: function}}
 */
function createEvolution({ workspaceDir, stateDir, onChange, getGateDefault, lessonsVaultDir } = {}) {
  if (typeof workspaceDir !== "string" || workspaceDir.length === 0) {
    throw new Error("createEvolution requires a workspaceDir option");
  }
  if (typeof stateDir !== "string" || stateDir.length === 0) {
    throw new Error("createEvolution requires a stateDir option");
  }

  const ledgerPath = path.join(workspaceDir, LEDGER_FILE);
  const approvedPath = path.join(workspaceDir, APPROVED_FILE);
  const statePath = path.join(stateDir, STATE_FILE);
  const vaultDir =
    typeof lessonsVaultDir === "string" && lessonsVaultDir.trim().length > 0
      ? lessonsVaultDir.trim()
      : "";

  /**
   * Mirror an approved lesson into the gbrain-synced Obsidian vault as a single
   * markdown file (`<vaultDir>/<id>.md`) with YAML frontmatter. The nightly
   * `gbrain import "<vault>"` then ingests it — this is how approved lessons
   * reach the knowledge store.
   *
   * Best-effort and isolated: a vault-write failure NEVER propagates into the
   * lesson-recording path. The ledger remains the source of truth.
   *
   * @param {{id: string, title: string, author: string, ts: string, body: string}} lesson
   */
  function mirrorToVault(lesson) {
    if (!vaultDir) return; // No vault configured — no-op (byte-identical to before).
    try {
      // Titles are already validated to contain no newlines (addLesson). Trim
      // any stray surrounding whitespace so the YAML scalar stays single-line.
      const safeTitle = String(lesson.title).replace(/[\n\r]/g, " ").trim();
      const safeAuthor = String(lesson.author).replace(/[\n\r]/g, " ").trim();
      const frontmatter =
        "---\n" +
        "type: lesson\n" +
        `id: ${lesson.id}\n` +
        `title: ${safeTitle}\n` +
        `author: ${safeAuthor}\n` +
        `ts: ${lesson.ts}\n` +
        "status: approved\n" +
        "---\n\n";
      const filePath = path.join(vaultDir, `${lesson.id}.md`);
      fs.mkdirSync(vaultDir, { recursive: true });
      atomicWriteFileSync(filePath, frontmatter + lesson.body + "\n");
    } catch (e) {
      console.error("[Evolution] vault mirror failed:", e && e.message);
    }
  }

  function fire(event) {
    if (typeof onChange === "function") {
      try {
        onChange(event);
      } catch (e) {
        console.error("[Evolution] onChange handler failed:", e.message);
      }
    }
  }

  function defaultGate() {
    if (typeof getGateDefault === "function") {
      try {
        return !!getGateDefault();
      } catch (e) {
        console.error("[Evolution] getGateDefault failed:", e.message);
      }
    }
    return true; // Safe default: gated (lessons require approval).
  }

  function loadState() {
    try {
      const raw = fs.readFileSync(statePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        gate: typeof parsed.gate === "boolean" ? parsed.gate : defaultGate(),
        pending: Array.isArray(parsed.pending) ? parsed.pending : [],
        updatedAt: parsed.updatedAt || null,
      };
    } catch (e) {
      return { gate: defaultGate(), pending: [], updatedAt: null };
    }
  }

  function saveState(state) {
    const next = { ...state, updatedAt: new Date().toISOString() };
    atomicWriteFileSync(statePath, JSON.stringify(next, null, 2) + "\n");
    return next;
  }

  function readLedger() {
    let content = "";
    try {
      content = fs.readFileSync(ledgerPath, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") {
        throw new Error(`Failed to read lessons ledger (${e.code || "unknown error"})`);
      }
    }
    return { content, sections: parseLedger(content) };
  }

  function generateId(existingIds) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = `les_${crypto.randomBytes(3).toString("hex")}`;
      if (!existingIds.has(id)) return id;
    }
    throw new Error("Failed to generate a unique lesson id");
  }

  /**
   * Append a new lesson. Pending when the gate is ON; auto-approved when OFF
   * (still recorded in the ledger for a full audit trail).
   * @param {object} lesson
   * @param {string} lesson.title
   * @param {string} lesson.body
   * @param {string} [lesson.author]
   * @returns {{id: string, title: string, status: string, author: string, ts: string, body: string}}
   */
  function addLesson({ title, body, author } = {}) {
    if (typeof title !== "string" || title.trim().length === 0) {
      throw new Error("Lesson title must be a non-empty string");
    }
    if (/[\n\r]/.test(title)) {
      throw new Error("Lesson title must not contain newlines");
    }
    if (typeof body !== "string" || body.trim().length === 0) {
      throw new Error("Lesson body must be a non-empty string");
    }
    const safeAuthor =
      typeof author === "string" && author.trim().length > 0
        ? author.trim().replace(/[\n\r]/g, " ")
        : "unknown";

    const { sections } = readLedger();
    const existingIds = new Set(sections.filter((s) => !s.parseError).map((s) => s.id));
    const state = loadState();
    const gate = state.gate;
    const lesson = {
      id: generateId(existingIds),
      title: title.trim(),
      status: gate ? "pending" : "approved",
      author: safeAuthor,
      ts: new Date().toISOString(),
      body: body.replace(/\s+$/, ""),
    };

    appendBlock(ledgerPath, formatSection(lesson));

    if (lesson.status === "approved") {
      // Gate OFF: auto-approve — merge into the active approved file too.
      appendBlock(approvedPath, `## [LESSON] ${lesson.title}\n\n${lesson.body}\n`);
      mirrorToVault(lesson);
      saveState(state);
    } else {
      saveState({
        ...state,
        pending: [
          ...state.pending,
          { id: lesson.id, title: lesson.title, author: lesson.author, ts: lesson.ts },
        ],
      });
    }

    fire({ type: "lesson.add", lesson: { ...lesson } });
    return lesson;
  }

  /**
   * List lessons, optionally filtered by status.
   * @param {object|string} [filter] - `{ status }` object or a status string
   * @returns {Array<object>} lessons (and `{ parseError }` entries for malformed sections)
   */
  function listLessons(filter) {
    const status = typeof filter === "string" ? filter : filter && filter.status;
    const { sections } = readLedger();
    const mapped = sections.map((s) =>
      s.parseError
        ? { parseError: s.parseError, raw: s.raw }
        : {
            id: s.id,
            title: s.title,
            status: s.status,
            author: s.author,
            ts: s.ts,
            body: s.body,
          },
    );
    if (!status) return mapped;
    return mapped.filter((s) => !s.parseError && s.status === status);
  }

  function transition(id, actor, fromStatus, toStatus) {
    if (typeof id !== "string" || !LESSON_ID_RE.test(id)) {
      throw new Error("Lesson id must look like les_<6hex>");
    }
    const { content, sections } = readLedger();
    const section = sections.find((s) => !s.parseError && s.id === id);
    if (!section) {
      throw new Error(`Lesson not found: ${id}`);
    }
    if (section.status !== fromStatus) {
      throw new Error(`Lesson ${id} is "${section.status}", expected "${fromStatus}"`);
    }

    // Rewrite ONLY this section's status line; preserve every other byte.
    const newRaw = section.raw.replace(
      new RegExp(`^- status: ${fromStatus}[ \\t]*$`, "m"),
      `- status: ${toStatus}`,
    );
    const newContent = content.slice(0, section.start) + newRaw + content.slice(section.end);
    atomicWriteFileSync(ledgerPath, newContent);

    if (toStatus === "approved") {
      appendBlock(approvedPath, `## [LESSON] ${section.title}\n\n${section.body}\n`);
      mirrorToVault({
        id,
        title: section.title,
        author: section.author,
        ts: section.ts,
        body: section.body,
      });
    }

    const state = loadState();
    saveState({ ...state, pending: state.pending.filter((p) => p.id !== id) });

    fire({
      type: toStatus === "approved" ? "lesson.approve" : "lesson.reject",
      id,
      actor: actor || "unknown",
      lesson: { id, title: section.title, status: toStatus },
    });
    return {
      id,
      title: section.title,
      status: toStatus,
      author: section.author,
      ts: section.ts,
      body: section.body,
    };
  }

  /**
   * Approve a pending lesson: rewrites its status line and appends its body
   * to lessons_learned.approved.md.
   */
  function approve(id, actor) {
    return transition(id, actor, "pending", "approved");
  }

  /**
   * Reject a pending lesson: rewrites its status line only.
   */
  function reject(id, actor) {
    return transition(id, actor, "pending", "rejected");
  }

  /**
   * @returns {boolean} current gate state (ON = lessons require approval)
   */
  function getGate() {
    return loadState().gate;
  }

  /**
   * Toggle the validation gate. Persists to the state file.
   */
  function setGate(on, actor) {
    const state = loadState();
    const gate = !!on;
    const next = saveState({ ...state, gate });
    fire({ type: "gate.toggle", gate, actor: actor || "unknown" });
    return { gate: next.gate, updatedAt: next.updatedAt };
  }

  /**
   * @returns {{gate: boolean, pending: Array<object>, updatedAt: string|null}}
   */
  function getState() {
    const state = loadState();
    return {
      gate: state.gate,
      pending: state.pending.map((p) => ({ ...p })),
      updatedAt: state.updatedAt,
    };
  }

  return { addLesson, listLessons, approve, reject, getGate, setGate, getState };
}

module.exports = { createEvolution, parseLedger };
