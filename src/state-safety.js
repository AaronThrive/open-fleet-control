/**
 * Safe JSON state store — generic, reusable by any module that persists
 * JSON state which AI agents may also edit directly.
 *
 * Guarantees:
 *   - write(): validate first, atomic write (temp + rename), previous good
 *     version copied to backupDir, backups pruned to maxBackups.
 *   - read():  NEVER throws on corrupt state. Corrupt files are quarantined
 *     and the newest valid backup is auto-restored; if no valid backup
 *     exists, a fresh default is returned via createDefault().
 *   - watch(): debounced fs.watch on the file; invalid external writes get
 *     the same quarantine + restore treatment.
 */

const fs = require("fs");
const path = require("path");

/**
 * Create a safe JSON state store.
 *
 * @param {object} options
 * @param {string} options.filePath - absolute path of the JSON state file
 * @param {function} options.validate - (obj) => {valid, errors}
 * @param {string} options.backupDir - directory for rotated backups
 * @param {number} [options.maxBackups=10] - backups retained after pruning
 * @param {function} [options.createDefault] - () => default state object
 * @param {number} [options.debounceMs=250] - watch debounce window
 * @returns {{read: function, write: function, restore: function, listBackups: function, watch: function}}
 */
function createSafeStore(options = {}) {
  const {
    filePath,
    validate,
    backupDir,
    maxBackups = 10,
    createDefault = () => null,
    debounceMs = 250,
  } = options;

  if (!filePath) throw new Error("createSafeStore: filePath is required");
  if (typeof validate !== "function") throw new Error("createSafeStore: validate is required");
  if (!backupDir) throw new Error("createSafeStore: backupDir is required");

  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath, path.extname(filePath));

  // Content of the most recent write performed by THIS store. Used by the
  // watcher to distinguish self-writes from external modifications.
  let lastWrittenContent = null;
  // Monotonic per-process sequence so backups created within the same
  // millisecond still get unique, lexicographically sortable names.
  let backupSeq = 0;

  function fsTimestamp() {
    // ISO timestamp made filesystem-friendly (no colons/dots); replacement is
    // uniform so lexicographic order still matches chronological order.
    return new Date().toISOString().replace(/[:.]/g, "-");
  }

  function ensureDirs() {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });
  }

  function safeValidate(obj) {
    try {
      const result = validate(obj);
      if (result && typeof result.valid === "boolean") return result;
      return { valid: false, errors: [{ path: "", reason: "validator returned no result" }] };
    } catch (e) {
      return { valid: false, errors: [{ path: "", reason: `validator threw: ${e.message}` }] };
    }
  }

  function serialize(obj) {
    return JSON.stringify(obj, null, 2) + "\n";
  }

  function atomicWrite(targetPath, content) {
    const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, targetPath);
    if (targetPath === filePath) lastWrittenContent = content;
  }

  function readRaw() {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (e) {
      return null; // missing or unreadable — caller decides what to do
    }
  }

  /** Parse + validate a file; returns the data or null if invalid/corrupt. */
  function readValidFile(p) {
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      return safeValidate(data).valid ? data : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * List backup files, newest first.
   * @returns {Array<{name: string, path: string}>}
   */
  function listBackups() {
    let entries = [];
    try {
      entries = fs.readdirSync(backupDir);
    } catch (e) {
      return [];
    }
    return entries
      .filter((name) => name.startsWith(`${baseName}.`) && name.endsWith(".json"))
      .sort()
      .reverse()
      .map((name) => ({ name, path: path.join(backupDir, name) }));
  }

  function pruneBackups() {
    const backups = listBackups();
    for (const backup of backups.slice(maxBackups)) {
      try {
        fs.unlinkSync(backup.path);
      } catch (e) {
        // Best effort — a missing backup is not an error.
      }
    }
  }

  /** Copy the previous good (valid) file content into backupDir. */
  function backupPrevious(prevContent) {
    let prevData;
    try {
      prevData = JSON.parse(prevContent);
    } catch (e) {
      return; // previous content was corrupt — never back up garbage
    }
    if (!safeValidate(prevData).valid) return;
    backupSeq += 1;
    const seq = String(backupSeq).padStart(6, "0");
    const backupPath = path.join(backupDir, `${baseName}.${fsTimestamp()}-${seq}.json`);
    fs.writeFileSync(backupPath, prevContent, "utf8");
    pruneBackups();
  }

  /** Move the corrupt state file out of the way; returns the new path. */
  function quarantine() {
    const quarantinedPath = path.join(dir, `${baseName}.quarantine.${fsTimestamp()}.json`);
    try {
      fs.renameSync(filePath, quarantinedPath);
      return quarantinedPath;
    } catch (e) {
      return null;
    }
  }

  /**
   * Validate and persist new state atomically, backing up the previous
   * good version. Throws (with an `errors` property) if `obj` is invalid.
   * @param {object} obj - state to persist
   */
  function write(obj) {
    const result = safeValidate(obj);
    if (!result.valid) {
      const summary = result.errors.map((e) => `${e.path}: ${e.reason}`).join("; ");
      const err = new Error(`Refusing to write invalid state to ${filePath} — ${summary}`);
      err.errors = result.errors;
      throw err;
    }
    ensureDirs();
    const prev = readRaw();
    atomicWrite(filePath, serialize(obj));
    if (prev !== null) backupPrevious(prev);
  }

  /**
   * Read state. Never throws on corrupt state:
   *  - corrupt file → quarantined, newest valid backup auto-restored
   *  - no valid backup → fresh default via createDefault()
   * @returns {{data: object, restored: boolean, quarantinedPath: string|null, restoredFrom: string|null, usedDefault: boolean}}
   */
  function read() {
    if (!fs.existsSync(filePath)) {
      return {
        data: createDefault(),
        restored: false,
        quarantinedPath: null,
        restoredFrom: null,
        usedDefault: true,
      };
    }

    const data = readValidFile(filePath);
    if (data !== null) {
      return {
        data,
        restored: false,
        quarantinedPath: null,
        restoredFrom: null,
        usedDefault: false,
      };
    }

    // Corrupt or invalid: quarantine, then try backups newest-first.
    const quarantinedPath = quarantine();
    for (const backup of listBackups()) {
      const candidate = readValidFile(backup.path);
      if (candidate !== null) {
        try {
          ensureDirs();
          atomicWrite(filePath, serialize(candidate));
        } catch (e) {
          console.error(`[StateSafety] Failed to restore ${filePath}:`, e.message);
        }
        return {
          data: candidate,
          restored: true,
          quarantinedPath,
          restoredFrom: backup.path,
          usedDefault: false,
        };
      }
    }

    // No valid backup — fall back to a fresh default.
    const fallback = createDefault();
    if (fallback !== null) {
      try {
        ensureDirs();
        atomicWrite(filePath, serialize(fallback));
      } catch (e) {
        console.error(`[StateSafety] Failed to write default state to ${filePath}:`, e.message);
      }
    }
    return {
      data: fallback,
      restored: false,
      quarantinedPath,
      restoredFrom: null,
      usedDefault: true,
    };
  }

  /**
   * Manually restore the newest valid backup over the state file.
   * @returns {{data: object, restoredFrom: string}|null} null if no valid backup
   */
  function restore() {
    for (const backup of listBackups()) {
      const candidate = readValidFile(backup.path);
      if (candidate !== null) {
        ensureDirs();
        atomicWrite(filePath, serialize(candidate));
        return { data: candidate, restoredFrom: backup.path };
      }
    }
    return null;
  }

  /**
   * Watch the state file for external modification (agents edit these files
   * directly). Debounced; self-writes are ignored. Invalid external writes
   * get the standard quarantine + restore treatment via read().
   * @param {function} onExternalChange - receives the read() result
   * @returns {{close: function}}
   */
  function watch(onExternalChange) {
    ensureDirs();
    const fileName = path.basename(filePath);
    let timer = null;

    const handleEvent = () => {
      const raw = readRaw();
      // Ignore echoes of our own writes (including restore/recovery writes).
      if (raw !== null && raw === lastWrittenContent) return;
      const result = read();
      try {
        onExternalChange(result);
      } catch (e) {
        console.error(`[StateSafety] watch callback error for ${filePath}:`, e.message);
      }
    };

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(handleEvent, debounceMs);
    };

    // Watch the directory: atomic rename-based writes replace the file's
    // inode, which breaks per-file watchers. If inotify instances are
    // exhausted on the host (EMFILE/ENOSPC — common on machines running many
    // agents), fall back to stat-polling via fs.watchFile so external edits
    // are still detected.
    let watcher = null;
    let pollTimer = null;
    try {
      watcher = fs.watch(dir, (eventType, changedName) => {
        if (changedName && changedName !== fileName) return;
        schedule();
      });
    } catch (e) {
      if (e.code !== "EMFILE" && e.code !== "ENOSPC") throw e;
      const statSafe = () => {
        try {
          const s = fs.statSync(filePath);
          return { mtimeMs: s.mtimeMs, size: s.size };
        } catch (statErr) {
          return null;
        }
      };
      // Baseline captured synchronously so writes right after watch() are seen.
      let lastStat = statSafe();
      pollTimer = setInterval(
        () => {
          const current = statSafe();
          const changed =
            (current === null) !== (lastStat === null) ||
            (current !== null &&
              lastStat !== null &&
              (current.mtimeMs !== lastStat.mtimeMs || current.size !== lastStat.size));
          lastStat = current;
          if (changed) schedule();
        },
        Math.max(debounceMs, 50),
      );
      if (typeof pollTimer.unref === "function") pollTimer.unref();
    }

    return {
      close() {
        if (timer) clearTimeout(timer);
        timer = null;
        if (watcher) watcher.close();
        if (pollTimer) clearInterval(pollTimer);
      },
    };
  }

  return { read, write, restore, listBackups, watch };
}

module.exports = { createSafeStore };
