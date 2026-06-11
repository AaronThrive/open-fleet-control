/**
 * 1Password secrets layer — resolves `op://<vault>/<item>/<field>` references
 * through the 1Password CLI (`op read`) with caching and strict no-leak
 * guarantees.
 *
 * Design notes:
 *   - ANY string value matching op://<vault>/<item>/<field> is eligible:
 *     resolveDeep* walks the whole tree and resolves on the VALUE shape, not
 *     the key name (an explicit key allowlist is still accepted to narrow
 *     the scope). Values that do NOT look like op:// references pass through
 *     untouched, so literals and env-sourced secrets keep working unchanged.
 *   - Resolved values are cached per ref (default TTL 5 minutes) and are
 *     NEVER logged, never included in error messages, and never exposed via
 *     getStatus(). Error scrubbing deliberately ignores the child process
 *     stdout (which could contain a partial secret) and keeps only the exit
 *     condition + first line of stderr.
 *   - Failures resolve to {ok:false, ref, error}; resolveDeep* keeps the
 *     LITERAL op:// string in place so downstream code sees an obviously
 *     invalid credential (never a silent ""/undefined) and a later retry —
 *     e.g. the settings hot-apply path or a lazy consumer — can recover.
 *
 * RESOLUTION TIMING (documented decision): the dashboard builds CONFIG as a
 * synchronous singleton at require time (src/config.js) and src/index.js —
 * which may not be modified — consumes resolved values (e.g.
 * fleet.usage.openrouterKey) immediately. The least invasive integration is
 * therefore SYNCHRONOUS boot-time resolution via execFileSync over the whole
 * config tree inside loadConfig (resolveDeepSync), plus sync re-resolution
 * on the settings hot-apply path (fleet.applyAlertsConfig). resolveDeepSync
 * short-circuits without spawning anything when the config contains no
 * op:// refs, so the common case (and the test suite) never shells out.
 */

const { execFile, execFileSync } = require("child_process");

// Full op://<vault>/<item>/<field> shape (a field may itself contain `/`
// when a section is addressed: op://vault/item/section/field). Vault and
// item names may contain spaces ("op://CEO Scale/ITEM/credential").
const OP_REF_RE = /^op:\/\/[^/\n]+\/[^/\n]+\/[^\n]+$/;
const DEFAULT_OP_PATH = "op";
const DEFAULT_CACHE_TTL_MS = 300000; // 5 min
const DEFAULT_TIMEOUT_MS = 10000; // 10 s
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_ERROR_LENGTH = 300;

/**
 * Documented secret-bearing config keys (webhook HMAC secret, Slack gateway
 * URL w/ embedded token, ntfy topic, fleet.usage.openrouterKey, federation
 * remote bearer token). Kept as an OPTIONAL narrowing allowlist for callers
 * that want it — by default resolveDeep* resolves any op:// string value
 * regardless of key.
 */
const DEFAULT_SECRET_KEYS = Object.freeze([
  "secret",
  "gatewayUrl",
  "topic",
  "openrouterKey",
  "token",
]);

/** True when the value is a 1Password secret reference (op://...). */
function isSecretRef(value) {
  return typeof value === "string" && OP_REF_RE.test(value.trim());
}

/**
 * Build a safe error message from an exec failure. NEVER includes stdout
 * (could contain a partial secret); keeps exit condition + first stderr line.
 */
function scrubExecError(err) {
  if (!err) return "unknown error";
  const parts = [];
  if (err.code === "ENOENT") return "op CLI not found";
  if (err.killed || err.signal === "SIGTERM") parts.push("timed out");
  if (typeof err.status === "number") parts.push(`exit ${err.status}`);
  else if (typeof err.code === "number") parts.push(`exit ${err.code}`);
  const stderr = err.stderr != null ? String(err.stderr) : "";
  const firstLine = stderr.split("\n").find((line) => line.trim().length > 0);
  if (firstLine) parts.push(firstLine.trim().slice(0, MAX_ERROR_LENGTH));
  return parts.length > 0 ? parts.join(": ") : "op read failed";
}

/** True when this key is eligible (null allowlist = every key). */
function keyAllowed(key, allowKeys) {
  return allowKeys === null || allowKeys.includes(key);
}

/** Depth-first scan: does this object tree contain any eligible op:// ref? */
function containsSecretRef(node, allowKeys) {
  if (typeof node === "string") {
    return allowKeys === null && isSecretRef(node);
  }
  if (Array.isArray(node)) {
    return node.some((item) => containsSecretRef(item, allowKeys));
  }
  if (node !== null && typeof node === "object") {
    return Object.entries(node).some(([key, value]) => {
      if (typeof value === "string") return keyAllowed(key, allowKeys) && isSecretRef(value);
      return containsSecretRef(value, allowKeys);
    });
  }
  return false;
}

/**
 * Create a secrets resolver.
 *
 * @param {object} [options]
 * @param {function} [options.execFn=execFile] - async exec (cmd, args, opts, cb)
 * @param {function} [options.execSyncFn=execFileSync] - sync exec (cmd, args, opts)
 * @param {string} [options.opPath] - op binary path (default: $OP_CLI_PATH or "op")
 * @param {number} [options.cacheTtlMs=300000]
 * @param {number} [options.timeoutMs=10000]
 * @param {function} [options.nowFn=Date.now]
 * @returns {{isSecretRef, resolve, resolveSync, resolveDeep, resolveDeepSync, getStatus, clearCache}}
 */
function createSecrets({
  execFn = execFile,
  execSyncFn = execFileSync,
  opPath = process.env.OP_CLI_PATH || DEFAULT_OP_PATH,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  nowFn = Date.now,
} = {}) {
  const cache = new Map(); // ref -> { value, expiresAt }
  const status = new Map(); // ref -> { ref, ok, error|null, ts } (never values)
  const pending = new Map(); // ref -> Promise (async single-flight)

  const execOptions = () => ({
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
    encoding: "utf8",
    windowsHide: true,
  });

  function cached(ref) {
    const entry = cache.get(ref);
    if (entry && entry.expiresAt > nowFn()) return entry;
    return null;
  }

  function recordSuccess(ref, value) {
    cache.set(ref, { value, expiresAt: nowFn() + cacheTtlMs });
    status.set(ref, { ref, ok: true, error: null, ts: nowFn() });
    return { ok: true, ref, value };
  }

  function recordFailure(ref, err) {
    const error = scrubExecError(err);
    status.set(ref, { ref, ok: false, error, ts: nowFn() });
    return { ok: false, ref, error };
  }

  /**
   * Resolve one value synchronously. Non-refs pass through unchanged.
   * @returns {{ok: boolean, ref: string|null, value?: string, error?: string}}
   */
  function resolveSync(value) {
    if (!isSecretRef(value)) return { ok: true, ref: null, value };
    const ref = value.trim();
    const hit = cached(ref);
    if (hit) return { ok: true, ref, value: hit.value };
    try {
      const out = execSyncFn(opPath, ["read", "--no-newline", ref], execOptions());
      return recordSuccess(ref, String(out).replace(/\n+$/, ""));
    } catch (err) {
      return recordFailure(ref, err);
    }
  }

  /**
   * Resolve one value asynchronously (single-flight per ref).
   * Same result shape as resolveSync.
   */
  function resolve(value) {
    if (!isSecretRef(value)) return Promise.resolve({ ok: true, ref: null, value });
    const ref = value.trim();
    const hit = cached(ref);
    if (hit) return Promise.resolve({ ok: true, ref, value: hit.value });
    if (pending.has(ref)) return pending.get(ref);

    const promise = new Promise((resolveP) => {
      execFn(opPath, ["read", "--no-newline", ref], execOptions(), (err, stdout) => {
        if (err) resolveP(recordFailure(ref, err));
        else resolveP(recordSuccess(ref, String(stdout).replace(/\n+$/, "")));
      });
    }).finally(() => pending.delete(ref));

    pending.set(ref, promise);
    return promise;
  }

  /**
   * Walk a config tree and resolve eligible op:// string values (any key by
   * default; restricted when an explicit allowlist is given), using the
   * provided per-value resolver. Returns a NEW tree (input is never
   * mutated); failed refs KEEP the literal op:// string in place and are
   * reported in `failures` as {path, ref, error} — never the secret.
   */
  function deepWalk(node, allowKeys, path, failures, resolveValue) {
    const resolveLeaf = (value, leafPath) => {
      const result = resolveValue(value);
      if (result.ok) return result.value;
      failures.push({ path: leafPath, ref: result.ref, error: result.error });
      return value; // keep the obviously-invalid ref literal in place
    };
    if (Array.isArray(node)) {
      return node.map((item, i) => {
        const childPath = `${path}[${i}]`;
        if (typeof item === "string" && allowKeys === null && isSecretRef(item)) {
          return resolveLeaf(item, childPath);
        }
        return deepWalk(item, allowKeys, childPath, failures, resolveValue);
      });
    }
    if (node !== null && typeof node === "object") {
      const out = {};
      for (const [key, value] of Object.entries(node)) {
        const childPath = path ? `${path}.${key}` : key;
        if (typeof value === "string" && keyAllowed(key, allowKeys) && isSecretRef(value)) {
          out[key] = resolveLeaf(value, childPath);
        } else if (value !== null && typeof value === "object") {
          out[key] = deepWalk(value, allowKeys, childPath, failures, resolveValue);
        } else {
          out[key] = value;
        }
      }
      return out;
    }
    return node;
  }

  /**
   * Synchronous deep resolution (boot path). Short-circuits — returning the
   * ORIGINAL object — when no allowlisted op:// refs exist, so no process is
   * ever spawned for ref-free configs.
   *
   * @param {object} obj - config tree (never mutated)
   * @param {string[]|null} [keyAllowlist=null] - null = any key (default);
   *   pass an array (e.g. DEFAULT_SECRET_KEYS) to narrow the scope
   * @returns {{value: object, failures: Array<{path, ref, error}>}}
   */
  function resolveDeepSync(obj, keyAllowlist = null) {
    if (!containsSecretRef(obj, keyAllowlist)) return { value: obj, failures: [] };
    const failures = [];
    const value = deepWalk(obj, keyAllowlist, "", failures, resolveSync);
    return { value, failures };
  }

  /**
   * Async deep resolution: pre-resolves every distinct ref concurrently,
   * then performs the same walk against the warmed cache.
   */
  async function resolveDeep(obj, keyAllowlist = null) {
    if (!containsSecretRef(obj, keyAllowlist)) return { value: obj, failures: [] };
    const refs = new Set();
    (function collect(node) {
      if (typeof node === "string") {
        if (keyAllowlist === null && isSecretRef(node)) refs.add(node.trim());
        return;
      }
      if (Array.isArray(node)) return node.forEach(collect);
      if (node !== null && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          if (typeof value === "string" && keyAllowed(key, keyAllowlist) && isSecretRef(value)) {
            refs.add(value.trim());
          } else {
            collect(value);
          }
        }
      }
    })(obj);
    const resolved = new Map();
    await Promise.all(
      [...refs].map(async (ref) => {
        resolved.set(ref, await resolve(ref));
      }),
    );
    const failures = [];
    const value = deepWalk(obj, keyAllowlist, "", failures, (v) => resolved.get(v.trim()));
    return { value, failures };
  }

  /**
   * Resolution status — refs and scrubbed errors only, NEVER values.
   * @returns {{configured: number, ok: number, failed: number,
   *            refs: Array<{ref, ok, error, ts}>}}
   */
  function getStatus() {
    const refs = [...status.values()].map((entry) => ({ ...entry }));
    const ok = refs.filter((entry) => entry.ok).length;
    return { configured: refs.length, ok, failed: refs.length - ok, refs };
  }

  function clearCache() {
    cache.clear();
    pending.clear();
  }

  return { isSecretRef, resolve, resolveSync, resolveDeep, resolveDeepSync, getStatus, clearCache };
}

// Shared process-wide resolver: config.js (boot) and fleet.js (settings
// hot-apply) use the same instance so the ref cache is shared.
const defaultSecrets = createSecrets();

module.exports = { createSecrets, isSecretRef, DEFAULT_SECRET_KEYS, defaultSecrets };
