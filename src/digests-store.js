/**
 * Digests store — persists composed fleet digests as browsable `*.md` files
 * under a `digests/` directory so the "Digests" tab can list, read, and
 * delete them. This is the persistence half of src/digest.js: every digest
 * that is composed + dispatched to alert sinks is ALSO written here.
 *
 * Filename shape: `digest-<schedule>-<YYYYMMDDtHHMMSSz>.md`
 *   schedule = "daily" | "weekly" (sanitized to the allowlist below)
 *   timestamp = UTC, derived from the digest's generatedAt
 *
 * Security model mirrors src/briefs.js (defense in depth, both layers always
 * applied):
 *   1. validateDigestName() — strict allowlist regex (no slashes, no
 *      backslashes, no dotfiles, must end in .md).
 *   2. resolveDigestPath() — resolves the joined path and verifies the result
 *      stays a direct child of the digests directory, rejecting any escape.
 *
 * Error messages are descriptive but never include absolute server paths.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DIGEST_NAME_RE = /^[a-zA-Z0-9._-]+\.md$/;
const DIGEST_SCHEDULES = ["daily", "weekly"];
const DEFAULT_SCHEDULE = "daily";
// Parse the schedule + timestamp back out of a digest filename for list().
const DIGEST_FILE_RE = /^digest-([a-z]+)-(\d{8}t\d{6}z)\.md$/;
const MAX_DIGEST_BYTES = 1024 * 1024; // 1MB

/**
 * Layer 1: strict filename allowlist (mirrors validateBriefName).
 * @param {string} name - candidate digest filename
 * @returns {string} the validated name
 * @throws {Error} when the name is not a safe `*.md` filename
 */
function validateDigestName(name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Digest name must be a non-empty string");
  }
  if (name.startsWith(".")) {
    throw new Error("Invalid digest name: dotfiles and names starting with '.' are not allowed");
  }
  if (!DIGEST_NAME_RE.test(name)) {
    throw new Error(
      "Invalid digest name: only letters, digits, '.', '_', '-' are allowed, " +
        "and the name must end with '.md'",
    );
  }
  return name;
}

/**
 * Layer 2: resolve() containment check (mirrors resolveBriefPath).
 * @param {string} digestsDir - root directory for digests
 * @param {string} name - digest filename
 * @returns {string} absolute resolved path inside digestsDir
 * @throws {Error} when the resolved path escapes digestsDir
 */
function resolveDigestPath(digestsDir, name) {
  const root = path.resolve(digestsDir);
  const resolved = path.resolve(root, String(name));
  const relative = path.relative(root, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Invalid digest name: resolved path escapes the digests directory");
  }
  if (relative.includes(path.sep) || relative.includes("/")) {
    throw new Error("Invalid digest name: nested paths are not allowed");
  }
  return resolved;
}

/** Normalize a schedule value to the allowlist (defaults to daily). */
function normalizeSchedule(schedule) {
  return DIGEST_SCHEDULES.includes(schedule) ? schedule : DEFAULT_SCHEDULE;
}

/**
 * UTC timestamp slug `YYYYMMDDtHHMMSSz` from an epoch-ms value.
 * @param {number} ms
 * @returns {string}
 */
function timestampSlug(ms) {
  const date = new Date(Number.isFinite(ms) ? ms : Date.now());
  return (
    `${date.getUTCFullYear()}` +
    `${String(date.getUTCMonth() + 1).padStart(2, "0")}` +
    `${String(date.getUTCDate()).padStart(2, "0")}` +
    `t${String(date.getUTCHours()).padStart(2, "0")}` +
    `${String(date.getUTCMinutes()).padStart(2, "0")}` +
    `${String(date.getUTCSeconds()).padStart(2, "0")}z`
  );
}

/** Build the dated digest filename. */
function buildDigestName(schedule, generatedAt) {
  return `digest-${normalizeSchedule(schedule)}-${timestampSlug(generatedAt)}.md`;
}

/** Extract the first markdown heading from content (best-effort title). */
function extractFirstHeading(content) {
  const match = content.match(/^#{1,6}[ \t]+(.+)$/m);
  if (match) return match[1].trim();
  // Digests open with a bold title line: **Fleet digest (daily) — ...**
  const bold = content.match(/^\*\*(.+?)\*\*\s*$/m);
  return bold ? bold[1].trim() : null;
}

/**
 * Parse a digest filename into {schedule, generatedAt} when it matches the
 * canonical shape; returns nulls for foreign `*.md` files.
 */
function parseDigestName(name) {
  const match = DIGEST_FILE_RE.exec(name);
  if (!match) return { schedule: null, generatedAt: null };
  const [, schedule, slug] = match;
  const iso = `${slug.slice(0, 4)}-${slug.slice(4, 6)}-${slug.slice(6, 8)}T${slug.slice(
    9,
    11,
  )}:${slug.slice(11, 13)}:${slug.slice(13, 15)}Z`;
  const ms = Date.parse(iso);
  return {
    schedule: DIGEST_SCHEDULES.includes(schedule) ? schedule : null,
    generatedAt: Number.isFinite(ms) ? new Date(ms).toISOString() : null,
  };
}

/**
 * Creates a digests store bound to a directory.
 *
 * @param {object} options
 * @param {string} options.digestsDir - directory holding the *.md digests
 * @returns {{write: function, list: function, read: function, remove: function}}
 */
function createDigestsStore({ digestsDir } = {}) {
  if (typeof digestsDir !== "string" || digestsDir.length === 0) {
    throw new Error("createDigestsStore requires a digestsDir option");
  }

  // Both validation layers, always applied together.
  function safePath(name) {
    validateDigestName(name);
    return resolveDigestPath(digestsDir, name);
  }

  function ensureDir() {
    fs.mkdirSync(digestsDir, { recursive: true });
  }

  /**
   * Persist a composed digest as a dated markdown file (atomic temp+rename).
   *
   * @param {object} digest
   * @param {string} [digest.title] - optional digest title (informational)
   * @param {string} digest.markdown - the composed markdown body (required)
   * @param {string} [digest.schedule] - "daily" | "weekly" (default daily)
   * @param {number} [digest.generatedAt] - epoch ms (default now)
   * @returns {{name: string, schedule: string, title: string|null, generatedAt: string, size: number}}
   */
  function write({ title = null, markdown, schedule, generatedAt } = {}) {
    if (typeof markdown !== "string") {
      throw new Error("Digest markdown must be a string");
    }
    const byteLength = Buffer.byteLength(markdown, "utf8");
    if (byteLength > MAX_DIGEST_BYTES) {
      throw new Error(
        `Digest markdown too large: ${byteLength} bytes (max ${MAX_DIGEST_BYTES} bytes)`,
      );
    }
    const normalizedSchedule = normalizeSchedule(schedule);
    const generatedMs = Number.isFinite(generatedAt) ? generatedAt : Date.now();
    const name = buildDigestName(normalizedSchedule, generatedMs);
    const filePath = safePath(name);

    ensureDir();
    const tmpPath = path.join(
      digestsDir,
      `.${name}.${crypto.randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      fs.writeFileSync(tmpPath, markdown, "utf8");
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      try {
        fs.unlinkSync(tmpPath);
      } catch (cleanupErr) {
        // Temp file already gone — nothing to clean up.
      }
      throw new Error(`Failed to write digest "${name}" (${e.code || "unknown error"})`);
    }
    const stat = fs.statSync(filePath);
    return {
      name,
      schedule: normalizedSchedule,
      title,
      generatedAt: new Date(generatedMs).toISOString(),
      size: stat.size,
    };
  }

  /**
   * List persisted digests (*.md regular files only), newest-first.
   * @returns {Array<{name: string, schedule: string|null, title: string|null, generatedAt: string|null, size: number}>}
   */
  function list() {
    let entries;
    try {
      entries = fs.readdirSync(digestsDir, { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw new Error(`Failed to list digests (${e.code || "unknown error"})`);
    }

    const digests = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.startsWith(".")) continue;
      if (!DIGEST_NAME_RE.test(entry.name)) continue;
      try {
        const filePath = path.join(digestsDir, entry.name);
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, "utf8");
        const parsed = parseDigestName(entry.name);
        digests.push({
          name: entry.name,
          schedule: parsed.schedule,
          title: extractFirstHeading(content),
          // Prefer the timestamp encoded in the filename; fall back to mtime.
          generatedAt: parsed.generatedAt || stat.mtime.toISOString(),
          size: stat.size,
        });
      } catch (e) {
        // Skip files that disappear or are unreadable mid-listing.
      }
    }
    // Newest-first by generatedAt, then by name as a stable tiebreaker.
    return digests.sort((a, b) => {
      const at = a.generatedAt || "";
      const bt = b.generatedAt || "";
      if (at !== bt) return bt.localeCompare(at);
      return b.name.localeCompare(a.name);
    });
  }

  /**
   * Read a persisted digest's content plus metadata.
   * @param {string} name
   * @returns {{name: string, title: string|null, content: string, generatedAt: string|null}}
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
        throw new Error(`Digest not found: "${name}"`);
      }
      throw new Error(`Failed to read digest "${name}" (${e.code || "unknown error"})`);
    }
    const parsed = parseDigestName(name);
    return {
      name,
      title: extractFirstHeading(content),
      content,
      generatedAt: parsed.generatedAt || stat.mtime.toISOString(),
    };
  }

  /**
   * Delete a persisted digest.
   * @param {string} name
   * @returns {{name: string, removed: boolean}}
   */
  function remove(name) {
    const filePath = safePath(name);
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      if (e.code === "ENOENT") {
        throw new Error(`Digest not found: "${name}"`);
      }
      throw new Error(`Failed to remove digest "${name}" (${e.code || "unknown error"})`);
    }
    return { name, removed: true };
  }

  return { write, list, read, remove };
}

module.exports = {
  createDigestsStore,
  validateDigestName,
  resolveDigestPath,
  buildDigestName,
  parseDigestName,
  DIGEST_NAME_RE,
  DIGEST_SCHEDULES,
  MAX_DIGEST_BYTES,
};
