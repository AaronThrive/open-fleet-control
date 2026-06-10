/**
 * Briefs — SOP/markdown repository over a `briefs/` directory.
 *
 * Stores operating procedures and reference documents as plain `*.md` files.
 * Security model (defense in depth, both layers always applied):
 *   1. `validateBriefName()` — strict allowlist regex: /^[a-zA-Z0-9._-]+\.md$/
 *      (no slashes, no backslashes, no dotfiles, must end in .md).
 *   2. `resolveBriefPath()` — resolves the joined path and verifies the result
 *      stays inside the briefs directory, rejecting anything that escapes it.
 *
 * Error messages are descriptive but never include absolute server paths.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BRIEF_NAME_RE = /^[a-zA-Z0-9._-]+\.md$/;
const MAX_BRIEF_BYTES = 1024 * 1024; // 1MB

/**
 * Layer 1: strict filename allowlist.
 * @param {string} name - candidate brief filename
 * @returns {string} the validated name
 * @throws {Error} when the name is not a safe `*.md` filename
 */
function validateBriefName(name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Brief name must be a non-empty string");
  }
  if (name.startsWith(".")) {
    throw new Error("Invalid brief name: dotfiles and names starting with '.' are not allowed");
  }
  if (!BRIEF_NAME_RE.test(name)) {
    throw new Error(
      "Invalid brief name: only letters, digits, '.', '_', '-' are allowed, " +
        "and the name must end with '.md'",
    );
  }
  return name;
}

/**
 * Layer 2: resolve() containment check (defense in depth).
 * Joins `name` onto `briefsDir`, resolves it, and verifies the resolved path
 * is a direct child of the briefs directory.
 * @param {string} briefsDir - root directory for briefs
 * @param {string} name - brief filename (already or not yet regex-validated)
 * @returns {string} absolute resolved path inside briefsDir
 * @throws {Error} when the resolved path escapes briefsDir
 */
function resolveBriefPath(briefsDir, name) {
  const root = path.resolve(briefsDir);
  const resolved = path.resolve(root, String(name));
  const relative = path.relative(root, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Invalid brief name: resolved path escapes the briefs directory");
  }
  if (relative.includes(path.sep) || relative.includes("/")) {
    throw new Error("Invalid brief name: nested paths are not allowed");
  }
  return resolved;
}

/**
 * Extract the first markdown heading from content.
 * @param {string} content
 * @returns {string|null}
 */
function extractFirstHeading(content) {
  const match = content.match(/^#{1,6}[ \t]+(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Creates a briefs repository bound to a directory.
 *
 * @param {object} options
 * @param {string} options.briefsDir - directory holding the *.md briefs
 * @returns {{list: function, read: function, write: function, remove: function}}
 */
function createBriefs({ briefsDir } = {}) {
  if (typeof briefsDir !== "string" || briefsDir.length === 0) {
    throw new Error("createBriefs requires a briefsDir option");
  }

  // Both validation layers, always applied together.
  function safePath(name) {
    validateBriefName(name);
    return resolveBriefPath(briefsDir, name);
  }

  function ensureDir() {
    fs.mkdirSync(briefsDir, { recursive: true });
  }

  /**
   * List all briefs (*.md regular files only; dotfiles and subdirs ignored).
   * @returns {Array<{name: string, size: number, updatedAt: string, firstHeading: string|null}>}
   */
  function list() {
    let entries;
    try {
      entries = fs.readdirSync(briefsDir, { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw new Error(`Failed to list briefs (${e.code || "unknown error"})`);
    }

    const briefs = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.startsWith(".")) continue;
      if (!BRIEF_NAME_RE.test(entry.name)) continue;
      try {
        const filePath = path.join(briefsDir, entry.name);
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, "utf8");
        briefs.push({
          name: entry.name,
          size: stat.size,
          updatedAt: stat.mtime.toISOString(),
          firstHeading: extractFirstHeading(content),
        });
      } catch (e) {
        // Skip files that disappear or are unreadable mid-listing.
      }
    }
    return briefs.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Read a brief's content plus metadata.
   * @param {string} name
   * @returns {{name: string, content: string, size: number, updatedAt: string, firstHeading: string|null}}
   */
  function read(name) {
    const filePath = safePath(name);
    let content;
    let stat;
    try {
      content = fs.readFileSync(filePath, "utf8");
      stat = fs.statSync(filePath);
    } catch (e) {
      if (e.code === "ENOENT") {
        throw new Error(`Brief not found: "${name}"`);
      }
      throw new Error(`Failed to read brief "${name}" (${e.code || "unknown error"})`);
    }
    return {
      name,
      content,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
      firstHeading: extractFirstHeading(content),
    };
  }

  /**
   * Write (create or replace) a brief atomically (temp file + rename).
   * @param {string} name
   * @param {string} content - markdown content, max 1MB
   * @returns {{name: string, size: number, updatedAt: string}}
   */
  function write(name, content) {
    const filePath = safePath(name);
    if (typeof content !== "string") {
      throw new Error("Brief content must be a string");
    }
    const byteLength = Buffer.byteLength(content, "utf8");
    if (byteLength > MAX_BRIEF_BYTES) {
      throw new Error(
        `Brief content too large: ${byteLength} bytes (max ${MAX_BRIEF_BYTES} bytes)`,
      );
    }
    ensureDir();
    const tmpPath = path.join(briefsDir, `.${name}.${crypto.randomBytes(6).toString("hex")}.tmp`);
    try {
      fs.writeFileSync(tmpPath, content, "utf8");
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      try {
        fs.unlinkSync(tmpPath);
      } catch (cleanupErr) {
        // Temp file already gone — nothing to clean up.
      }
      throw new Error(`Failed to write brief "${name}" (${e.code || "unknown error"})`);
    }
    const stat = fs.statSync(filePath);
    return { name, size: stat.size, updatedAt: stat.mtime.toISOString() };
  }

  /**
   * Delete a brief.
   * @param {string} name
   * @returns {{name: string, removed: boolean}}
   */
  function remove(name) {
    const filePath = safePath(name);
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      if (e.code === "ENOENT") {
        throw new Error(`Brief not found: "${name}"`);
      }
      throw new Error(`Failed to remove brief "${name}" (${e.code || "unknown error"})`);
    }
    return { name, removed: true };
  }

  return { list, read, write, remove };
}

module.exports = {
  createBriefs,
  validateBriefName,
  resolveBriefPath,
  BRIEF_NAME_RE,
  MAX_BRIEF_BYTES,
};
