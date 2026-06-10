/**
 * Cortex LanceDB memory adapter — reads/writes the OpenClaw memory-pro dataset.
 *
 * Reads (list/get) go straight to the LanceDB dataset (MVCC multi-process safe
 * for reads). Search and ALL writes go through the `openclaw memory-pro` CLI
 * because we have no embedding pipeline and direct table writes are unsafe.
 *
 * Everything is lazy and graceful: if @lancedb/lancedb is missing or the CLI
 * is absent, available() reports false with a reason and methods return
 * { error } instead of throwing.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRequire } = require("node:module");

// The openclaw CLI loads its full plugin stack on every invocation, which
// alone can take ~30s on a busy host (measured live). Writes additionally
// re-embed imported text through a remote embedding API, so they get a
// larger budget than reads.
const CLI_TIMEOUT_MS = 60000;
const CLI_WRITE_TIMEOUT_MS = 120000;
const EXPORT_FORMAT_VERSION = "1.0";
const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_LIST_LIMIT = 20;
const METADATA_SOURCE = "open-fleet-control-cortex";

/** Fields callers may change via update(). */
const EDITABLE_FIELDS = ["text", "category", "scope", "importance"];

/**
 * Default exec function: execFile semantics (args array, never a shell).
 * Resolves (never rejects) with { error, stdout, stderr }.
 */
function defaultExecFn(cmd, args, options = {}) {
  return new Promise((resolve) => {
    let execFile;
    try {
      execFile = require("child_process").execFile;
    } catch (e) {
      resolve({ error: e, stdout: "", stderr: "" });
      return;
    }
    const { getSafeEnv } = require("./openclaw");
    execFile(
      cmd,
      args,
      {
        encoding: "utf8",
        timeout: options.timeoutMs || CLI_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        env: getSafeEnv(),
      },
      (error, stdout, stderr) => {
        resolve({ error: error || null, stdout: stdout || "", stderr: stderr || "" });
      },
    );
  });
}

/**
 * Lazy loader for @lancedb/lancedb. Uses createRequire with a runtime path so
 * esbuild never tries to bundle the native module.
 */
function defaultLanceLoader() {
  const requireModule = createRequire(__filename);
  return requireModule("@lancedb/lancedb");
}

/**
 * Find the first parseable JSON value ({...} or [...]) inside noisy CLI
 * output (the openclaw CLI interleaves plugin logs with payloads, sometimes
 * on stderr).
 */
function extractJsonPayload(text) {
  if (!text || typeof text !== "string") return null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;
    const end = findBalancedEnd(text, i);
    if (end === -1) continue;
    try {
      return JSON.parse(text.slice(i, end + 1));
    } catch (e) {
      // Not valid JSON at this position - keep scanning
    }
  }
  return null;
}

/** Walk from an opening bracket to its balanced close (string-aware). */
function findBalancedEnd(text, start) {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return ch === close ? i : -1;
    }
  }
  return -1;
}

/** Escape a value for a LanceDB SQL-style filter string literal. */
function escapeFilterValue(value) {
  return String(value).replace(/'/g, "''");
}

/** Strip ANSI escape sequences from CLI output. */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\u001b\[[0-9;]*m/g, "");
}

/** Parse metadata JSON string into an object (best effort). */
function parseMetadata(metadata) {
  if (metadata && typeof metadata === "string") {
    try {
      return JSON.parse(metadata);
    } catch (e) {
      return metadata;
    }
  }
  return metadata ?? null;
}

/**
 * Validate the change-set passed to update(). Returns { fields } with only
 * the editable fields present, or { error } on the first invalid value.
 */
function validateUpdateChanges(changes) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    return { error: "update changes must be an object" };
  }
  const fields = {};
  for (const key of EDITABLE_FIELDS) {
    if (changes[key] !== undefined) fields[key] = changes[key];
  }
  if (Object.keys(fields).length === 0) {
    return { error: `update requires at least one editable field (${EDITABLE_FIELDS.join(", ")})` };
  }
  if (fields.text !== undefined && (typeof fields.text !== "string" || fields.text.trim() === "")) {
    return { error: "memory text must be a non-empty string" };
  }
  for (const key of ["category", "scope"]) {
    if (
      fields[key] !== undefined &&
      (typeof fields[key] !== "string" || fields[key].trim() === "")
    ) {
      return { error: `memory ${key} must be a non-empty string` };
    }
  }
  if (fields.importance !== undefined) {
    const value = Number(fields.importance);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      return { error: "memory importance must be a number between 0 and 1" };
    }
    fields.importance = value;
  }
  return { fields };
}

/**
 * Merge a row's (already parsed) metadata with an edit marker and return the
 * JSON string the export format expects. Non-object metadata is preserved
 * under `legacyMetadata` instead of being silently dropped.
 */
function buildUpdatedMetadata(currentMetadata) {
  const base =
    currentMetadata && typeof currentMetadata === "object" && !Array.isArray(currentMetadata)
      ? { ...currentMetadata }
      : currentMetadata !== null && currentMetadata !== undefined
        ? { legacyMetadata: currentMetadata }
        : {};
  return JSON.stringify({
    ...base,
    updatedBy: METADATA_SOURCE,
    updatedAt: new Date().toISOString(),
  });
}

/** Re-serialize a normalized row back into an export-format record. */
function toExportRecord(item) {
  return {
    id: item.id,
    text: item.text,
    category: item.category || "fact",
    scope: item.scope || "global",
    importance: item.importance ?? 0.7,
    timestamp: item.timestamp ?? Date.now(),
    metadata:
      typeof item.metadata === "string" ? item.metadata : JSON.stringify(item.metadata ?? {}),
  };
}

/** Normalize a raw memory row (drops the embedding vector). */
function normalizeMemoryRow(row) {
  if (!row || typeof row !== "object") return null;
  return {
    id: row.id ?? null,
    text: row.text ?? "",
    category: row.category ?? null,
    scope: row.scope ?? null,
    importance: row.importance ?? null,
    timestamp: row.timestamp ?? null,
    metadata: parseMetadata(row.metadata),
  };
}

/** Parse the plain-text output of `openclaw memory-pro stats`. */
function parseStatsText(text) {
  const clean = stripAnsi(text);
  const totalMatch = clean.match(/Total memories:\s*(\d+)/i);
  if (!totalMatch) return null;
  const stats = {
    totalMemories: parseInt(totalMatch[1], 10),
    byScope: {},
    byCategory: {},
    source: "cli",
  };
  let section = null;
  for (const line of clean.split("\n")) {
    if (/Memories by scope:/i.test(line)) {
      section = "byScope";
      continue;
    }
    if (/Memories by category:/i.test(line)) {
      section = "byCategory";
      continue;
    }
    // Keys may themselves contain colons (e.g. "agent:main"), so capture
    // greedily up to the final ":<count>" pair.
    const bullet = line.match(/[•*-]\s*(.+):\s*(\d+)\s*$/);
    if (section && bullet) {
      stats[section][bullet[1].trim()] = parseInt(bullet[2], 10);
    }
  }
  return stats;
}

/**
 * Create the LanceDB memory adapter.
 *
 * @param {object} [options]
 * @param {string} [options.dbPath] - LanceDB dataset directory
 * @param {function} [options.execFn] - (cmd, args, opts) => Promise<{error, stdout, stderr}>
 * @param {function} [options.lanceModuleLoader] - () => lancedb module (may throw)
 * @param {string} [options.cliCommand] - CLI binary name (default "openclaw")
 */
function createLanceMemory(options = {}) {
  const dbPath = options.dbPath || path.join(os.homedir(), ".openclaw", "memory", "lancedb-pro");
  const execFn = options.execFn || defaultExecFn;
  const lanceModuleLoader = options.lanceModuleLoader || defaultLanceLoader;
  const cliCommand = options.cliCommand || "openclaw";

  let cachedAvailability = null;

  function loadLanceModule() {
    try {
      return { module: lanceModuleLoader() };
    } catch (e) {
      return { error: e.message || String(e) };
    }
  }

  async function openMemoriesTable() {
    const loaded = loadLanceModule();
    if (loaded.error) {
      return { error: `@lancedb/lancedb not loadable: ${loaded.error}` };
    }
    if (!fs.existsSync(dbPath)) {
      return { error: `LanceDB dataset not found at ${dbPath}` };
    }
    try {
      const db = await loaded.module.connect(dbPath);
      const table = await db.openTable("memories");
      return { table };
    } catch (e) {
      return { error: `Failed to open memories table: ${e.message}` };
    }
  }

  /**
   * Run `memory-pro stats --json` and extract its JSON payload if any.
   * Quirk observed live: the command can exit non-zero (plugin warnings)
   * while still printing valid JSON — and it prints it to stderr. A CLI
   * that produced a payload is a working CLI regardless of exit code.
   */
  async function probeStatsJson() {
    try {
      const res = await execFn(cliCommand, ["memory-pro", "stats", "--json"], {
        timeoutMs: CLI_TIMEOUT_MS,
      });
      const payload =
        extractJsonPayload(res.stdout) ??
        extractJsonPayload(res.stderr) ??
        extractJsonPayload(res.error?.message);
      return { res, payload };
    } catch (e) {
      return { res: { error: e, stdout: "", stderr: "" }, payload: null };
    }
  }

  /** Check CLI and direct-read availability (cached after first call). */
  async function available() {
    if (cachedAvailability) return cachedAvailability;
    const reasons = [];

    let cliOk = false;
    const probe = await probeStatsJson();
    if (!probe.res.error || probe.payload) {
      cliOk = true;
    } else {
      reasons.push(`openclaw CLI unavailable: ${probe.res.error.message || probe.res.error}`);
    }

    let lanceOk = false;
    const loaded = loadLanceModule();
    if (loaded.error) {
      reasons.push(`@lancedb/lancedb not loadable: ${loaded.error}`);
    } else if (!fs.existsSync(dbPath)) {
      reasons.push(`LanceDB dataset not found at ${dbPath}`);
    } else {
      lanceOk = true;
    }

    cachedAvailability = {
      available: cliOk || lanceOk,
      cli: cliOk,
      lancedb: lanceOk,
      reason: reasons.length > 0 ? reasons.join("; ") : null,
    };
    return cachedAvailability;
  }

  /** Hybrid search via the CLI (we have no embedding pipeline of our own). */
  async function search(query, { limit = DEFAULT_SEARCH_LIMIT, scope } = {}) {
    if (typeof query !== "string" || query.trim() === "") {
      return { error: "search query must be a non-empty string" };
    }
    const args = ["memory-pro", "search", query, "--json", "--limit", String(limit)];
    if (scope) args.push("--scope", String(scope));

    const res = await execFn(cliCommand, args, { timeoutMs: CLI_TIMEOUT_MS });
    if (res.error) {
      return { error: `memory-pro search failed: ${res.error.message || res.error}` };
    }
    // The CLI may emit the JSON payload on stdout or stderr (plugin log noise)
    const parsed = extractJsonPayload(res.stdout) ?? extractJsonPayload(res.stderr);
    if (!Array.isArray(parsed)) {
      return { error: "could not parse JSON from memory-pro search output" };
    }
    const results = parsed
      .map((hit) => {
        const entry = hit && typeof hit === "object" && hit.entry ? hit.entry : hit;
        const normalized = normalizeMemoryRow(entry);
        if (!normalized) return null;
        const score = hit?.score ?? hit?.relevance ?? hit?.similarity ?? null;
        return score !== null ? { ...normalized, score } : normalized;
      })
      .filter(Boolean);
    return { results };
  }

  /** List memories via direct LanceDB table scan (read-only). */
  async function list({ limit = DEFAULT_LIST_LIMIT, scope, category } = {}) {
    const opened = await openMemoriesTable();
    if (opened.error) return { error: opened.error };
    try {
      let queryBuilder = opened.table.query();
      const filters = [];
      if (scope) filters.push(`scope = '${escapeFilterValue(scope)}'`);
      if (category) filters.push(`category = '${escapeFilterValue(category)}'`);
      if (filters.length > 0) queryBuilder = queryBuilder.where(filters.join(" AND "));
      const rows = await queryBuilder.limit(limit).toArray();
      return { items: rows.map(normalizeMemoryRow).filter(Boolean) };
    } catch (e) {
      return { error: `LanceDB list failed: ${e.message}` };
    }
  }

  /** Fetch a single memory by id via direct LanceDB read. */
  async function get(id) {
    if (!id || typeof id !== "string") {
      return { error: "memory id must be a non-empty string" };
    }
    const opened = await openMemoriesTable();
    if (opened.error) return { error: opened.error };
    try {
      const rows = await opened.table
        .query()
        .where(`id = '${escapeFilterValue(id)}'`)
        .limit(1)
        .toArray();
      if (!rows || rows.length === 0) return { error: `memory not found: ${id}` };
      return { item: normalizeMemoryRow(rows[0]) };
    } catch (e) {
      return { error: `LanceDB get failed: ${e.message}` };
    }
  }

  /**
   * Import export-format records via the CLI through a temp JSON file
   * (direct table.add is unsafe — single-writer through the CLI only).
   * Record ids are preserved by the import, which is what makes update()
   * possible as delete + re-import.
   */
  async function importViaCli(memories, scope) {
    const payload = {
      version: EXPORT_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      count: memories.length,
      filters: {},
      memories,
    };
    const tmpFile = path.join(
      os.tmpdir(),
      `cortex-import-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
    );
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), "utf8");
      const args = ["memory-pro", "import", tmpFile];
      if (scope) args.push("--scope", String(scope));
      const res = await execFn(cliCommand, args, { timeoutMs: CLI_WRITE_TIMEOUT_MS });
      if (res.error) {
        return { error: `memory-pro import failed: ${res.error.message || res.error}` };
      }
      return { ok: true };
    } catch (e) {
      return { error: `import failed: ${e.message}` };
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch (e) {
        // Temp file may already be gone - nothing to clean up
      }
    }
  }

  /** Delete a memory by id via the CLI (scope narrows access control). */
  async function deleteViaCli(id, scope) {
    const args = ["memory-pro", "delete", id];
    if (scope) args.push("--scope", String(scope));
    const res = await execFn(cliCommand, args, { timeoutMs: CLI_WRITE_TIMEOUT_MS });
    if (res.error) {
      return { error: `memory-pro delete failed: ${res.error.message || res.error}` };
    }
    return { ok: true };
  }

  /**
   * Store a memory. Writes a temp JSON file matching the
   * `openclaw memory-pro export` envelope, then imports it via the CLI.
   */
  async function store(text, { category = "fact", scope, importance = 0.7 } = {}) {
    if (typeof text !== "string" || text.trim() === "") {
      return { error: "memory text must be a non-empty string" };
    }
    const memory = {
      id: `cortex-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      text,
      category,
      scope: scope || "global",
      importance,
      timestamp: Date.now(),
      metadata: JSON.stringify({ source: METADATA_SOURCE }),
    };
    const imported = await importViaCli([memory], scope);
    if (imported.error) return { error: imported.error };
    return { ok: true, id: memory.id };
  }

  /**
   * Update a memory in place. The CLI has no update/edit command, so this is
   * delete + re-import of the merged record. The import format carries the
   * record id, and imports preserve it — so the id is stable across updates
   * (verified live against `openclaw memory-pro`). Unspecified fields and
   * the original timestamp are preserved; metadata gains an edit marker.
   * Requires a readable LanceDB dataset (the merge needs the current row).
   */
  async function update(id, changes = {}) {
    if (!id || typeof id !== "string") {
      return { error: "memory id must be a non-empty string" };
    }
    const validated = validateUpdateChanges(changes);
    if (validated.error) return { error: validated.error };
    const { fields } = validated;

    const existing = await get(id);
    if (existing.error) return { error: existing.error };
    const current = existing.item;

    const updated = {
      ...toExportRecord(current),
      ...(fields.text !== undefined ? { text: fields.text } : {}),
      ...(fields.category !== undefined ? { category: fields.category } : {}),
      ...(fields.scope !== undefined ? { scope: fields.scope } : {}),
      ...(fields.importance !== undefined ? { importance: fields.importance } : {}),
      metadata: buildUpdatedMetadata(current.metadata),
    };

    const deleted = await deleteViaCli(id, current.scope || null);
    if (deleted.error) return { error: `update failed (delete step): ${deleted.error}` };

    const imported = await importViaCli([updated], updated.scope);
    if (imported.error) {
      // The original row is already deleted — restore it so a failed
      // re-import never loses data.
      const restored = await importViaCli([toExportRecord(current)], current.scope || null);
      if (restored.error) {
        return {
          error:
            `update failed (import step): ${imported.error}; ` +
            `ROLLBACK FAILED — original memory may be lost: ${restored.error}`,
        };
      }
      return { error: `update failed (import step): ${imported.error}; original memory restored` };
    }
    return { ok: true, id, item: { ...updated, metadata: parseMetadata(updated.metadata) } };
  }

  /**
   * Delete a memory by id. Existence and scope are resolved via a direct
   * read when the dataset is readable (404-style error for unknown ids,
   * post-delete verification); otherwise the CLI delete runs blind.
   */
  async function remove(id) {
    if (!id || typeof id !== "string") {
      return { error: "memory id must be a non-empty string" };
    }
    let scope = null;
    let confirmedExists = false;
    const existing = await get(id);
    if (existing.item) {
      scope = existing.item.scope || null;
      confirmedExists = true;
    } else if (existing.error && existing.error.startsWith("memory not found")) {
      return { error: existing.error };
    }

    const deleted = await deleteViaCli(id, scope);
    if (deleted.error) return { error: deleted.error };

    if (confirmedExists) {
      const check = await get(id);
      if (check.item) {
        return { error: `delete did not take effect: memory ${id} is still present` };
      }
    }
    return { ok: true, id };
  }

  /**
   * Memory statistics. Order of preference:
   *  1. `stats --json` envelope ({ memory: { totalCount, ... } }, may arrive
   *     on stderr with a non-zero exit — see probeStatsJson)
   *  2. plain-text `stats` output
   *  3. direct LanceDB countRows
   */
  async function stats() {
    const probe = await probeStatsJson();
    const memorySection = probe.payload?.memory;
    if (memorySection && typeof memorySection.totalCount === "number") {
      return {
        totalMemories: memorySection.totalCount,
        byScope: memorySection.scopeCounts || {},
        byCategory: memorySection.categoryCounts || {},
        source: "cli",
      };
    }
    try {
      const res = await execFn(cliCommand, ["memory-pro", "stats"], {
        timeoutMs: CLI_TIMEOUT_MS,
      });
      if (!res.error) {
        const parsed = parseStatsText(`${res.stdout}\n${res.stderr}`);
        if (parsed) return parsed;
      }
    } catch (e) {
      // Fall through to direct read
    }
    const opened = await openMemoriesTable();
    if (opened.error) return { error: opened.error };
    try {
      const totalMemories = await opened.table.countRows();
      return { totalMemories, byScope: {}, byCategory: {}, source: "lancedb" };
    } catch (e) {
      return { error: `stats failed: ${e.message}` };
    }
  }

  return { available, search, list, get, store, update, remove, stats };
}

module.exports = {
  createLanceMemory,
  extractJsonPayload,
  parseStatsText,
  EXPORT_FORMAT_VERSION,
};
