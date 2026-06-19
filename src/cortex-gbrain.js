/**
 * Cortex gbrain adapter — READ-ONLY access to the gbrain knowledge store CLI.
 *
 * gbrain is the system of record for the Cortex memory browser; writes happen
 * out-of-band via a nightly sync, so this adapter NEVER mutates gbrain. It
 * exposes the memory-browser surface (list / search / get / stats) over the
 * gbrain page set.
 *
 * IMPORTANT: never opens the PGLite database directly (single-writer lock).
 * All access shells out to the gbrain CLI with execFile semantics (args
 * arrays, no shell, 15s timeouts). If the CLI is broken or absent the
 * adapter degrades gracefully: available() reports false with a reason and
 * methods return { error } instead of throwing.
 */

const os = require("os");
const path = require("path");

const CLI_TIMEOUT_MS = 15000;

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
        maxBuffer: 16 * 1024 * 1024,
        env: getSafeEnv(),
      },
      (error, stdout, stderr) => {
        resolve({ error: error || null, stdout: stdout || "", stderr: stderr || "" });
      },
    );
  });
}

/** Parse JSON from CLI output, tolerating leading/trailing noise. */
function parseJsonOutput(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    // Fall through to a scan for an embedded JSON payload
  }
  for (const opener of ["[", "{"]) {
    const start = trimmed.indexOf(opener);
    if (start === -1) continue;
    const closer = opener === "[" ? "]" : "}";
    const end = trimmed.lastIndexOf(closer);
    if (end <= start) continue;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch (e2) {
      // Keep trying other openers
    }
  }
  return null;
}

/**
 * Parse gbrain's `list` TSV output (slug\ttype\tdate\ttitle per line) into
 * page records. gbrain <= 0.12.x has no --json on `list`; TSV is what real
 * binaries emit. Returns null when the text is not TSV page output (e.g. a
 * broken-bundle error line), so callers can treat it as "CLI broken".
 */
function parseTsvPages(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^no pages found\.?$/i.test(trimmed)) return [];
  const pages = [];
  for (const line of trimmed.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 2 || !parts[0]) return null;
    pages.push({
      slug: parts[0],
      type: parts[1] || "page",
      updated_at: parts[2] || null,
      title: parts[3] || parts[0],
    });
  }
  return pages;
}

/**
 * Parse `gbrain stats` text output ("Pages:     383\nLinks:     0\n…") into
 * counts. gbrain 0.12.x has no JSON mode for stats; the labelled-number lines
 * are the stable contract. Returns null when no Pages line is present (e.g.
 * a broken-bundle error).
 */
function parseStatsText(text) {
  if (!text || typeof text !== "string") return null;
  const grab = (label) => {
    const match = text.match(new RegExp(`^${label}:\\s*(\\d+)\\s*$`, "mi"));
    return match ? Number(match[1]) : null;
  };
  const pages = grab("Pages");
  if (pages === null) return null;
  return {
    pages,
    chunks: grab("Chunks"),
    embedded: grab("Embedded"),
    links: grab("Links"),
    tags: grab("Tags"),
  };
}

/** Normalize a gbrain page record into a memory-browser list item. */
/**
 * gbrain `list` TSV dates omit the year (e.g. "Fri Jun 19"), which Date.parse
 * resolves to year 2001 → the UI showed "25 years ago". Normalize to a full
 * date: prefer a YYYY-MM-DD embedded in the slug (most gbrain pages carry one),
 * else assume the current year. Returns an ISO-ish string Date.parse handles, or
 * the original value when it already has a 4-digit year, or null.
 */
function normalizeGbrainDate(raw, slug) {
  const slugDate = typeof slug === "string" ? slug.match(/\b\d{4}-\d{2}-\d{2}\b/) : null;
  if (slugDate) return slugDate[0];
  if (typeof raw !== "string" || !raw.trim()) return null;
  const r = raw.trim();
  if (/\b\d{4}\b/.test(r)) return r; // already year-qualified
  const ms = Date.parse(`${r} ${new Date().getFullYear()}`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function toMemoryItem(page) {
  if (!page || typeof page !== "object") return null;
  const id = page.slug ?? page.id ?? null;
  if (!id) return null;
  return {
    id,
    title: page.title ?? page.name ?? id,
    type: page.type ?? page.page_type ?? "page",
    updatedAt: normalizeGbrainDate(page.updated_at ?? page.updatedAt ?? null, id),
  };
}

/**
 * The newest updated_at across a page list. gbrain `list` is sorted
 * most-recently-updated first, so the first row carrying a date is the
 * freshest — but we scan to tolerate rows with missing dates up front.
 */
function newestUpdatedAt(pages) {
  if (!Array.isArray(pages)) return null;
  for (const page of pages) {
    const value = page && (page.updated_at ?? page.updatedAt);
    if (value) return value;
  }
  return null;
}

/**
 * Create the gbrain adapter.
 *
 * @param {object} [options]
 * @param {string} [options.cliPath] - path to the gbrain CLI binary
 * @param {function} [options.execFn] - (cmd, args, opts) => Promise<{error, stdout, stderr}>
 */
function createGbrain(options = {}) {
  const cliPath = options.cliPath || path.join(os.homedir(), "gbrain", "bin", "gbrain");
  const execFn = options.execFn || defaultExecFn;

  let cachedAvailability = null;

  async function runCli(args) {
    try {
      return await execFn(cliPath, args, { timeoutMs: CLI_TIMEOUT_MS });
    } catch (e) {
      return { error: e, stdout: "", stderr: "" };
    }
  }

  /**
   * Probe availability by listing one page as JSON. The probe catches both a
   * missing binary AND a present-but-broken CLI (e.g. a bundle that cannot
   * open its PGLite data), which is why a simple existsSync is not enough.
   */
  async function available() {
    if (cachedAvailability) return cachedAvailability;

    const res = await runCli(["list", "--limit", "1", "--json"]);
    if (res.error) {
      cachedAvailability = {
        available: false,
        reason: `gbrain CLI failed at ${cliPath}: ${res.error.message || res.error}`,
      };
      return cachedAvailability;
    }
    const parsed =
      parseJsonOutput(res.stdout) ?? parseJsonOutput(res.stderr) ?? parseTsvPages(res.stdout);
    if (!Array.isArray(parsed)) {
      const firstLine =
        `${res.stdout}\n${res.stderr}`.trim().split("\n")[0]?.slice(0, 200) || "no output";
      cachedAvailability = {
        available: false,
        reason: `gbrain CLI returned no usable JSON or TSV (likely broken data bundle): ${firstLine}`,
      };
      return cachedAvailability;
    }
    cachedAvailability = { available: true, reason: null };
    return cachedAvailability;
  }

  /**
   * Fetch ALL gbrain pages as normalized records. The memory browser shows
   * the whole brain, so we do NOT cap the `list` output — gbrain `list`
   * returns every page. Returns { pages } on success or { error }.
   */
  async function listPages() {
    // gbrain `list` hard-caps results (100 in TSV mode, 50 in --json mode) and
    // exposes NO --offset/pagination, so the full page set (hundreds) can't be
    // fetched in one call today. Use TSV + --limit 100 to surface the MAX gbrain
    // will return (100 vs 50). The true total is shown separately via stats
    // (pageCount). Lifting this to ALL pages needs a gbrain CLI pagination flag.
    const listRes = await runCli(["list", "--limit", "100"]);
    if (listRes.error) {
      return { error: `gbrain list failed: ${listRes.error.message || listRes.error}` };
    }
    const pages =
      parseJsonOutput(listRes.stdout) ??
      parseJsonOutput(listRes.stderr) ??
      parseTsvPages(listRes.stdout);
    if (!Array.isArray(pages)) {
      return { error: "gbrain list returned no usable JSON or TSV" };
    }
    return { pages };
  }

  /**
   * List gbrain pages for the memory browser. Returns the FULL page set
   * shaped as { items: [{ id, title, type, updatedAt }], total }. `query`
   * filters by case-insensitive substring on title/slug; limit/offset paginate
   * the already-filtered set (total is the filtered count).
   */
  async function list({ limit, offset = 0, query } = {}) {
    const loaded = await listPages();
    if (loaded.error) return { error: loaded.error };

    let items = loaded.pages.map(toMemoryItem).filter(Boolean);

    if (typeof query === "string" && query.trim() !== "") {
      const needle = query.trim().toLowerCase();
      items = items.filter(
        (item) =>
          String(item.title).toLowerCase().includes(needle) ||
          String(item.id).toLowerCase().includes(needle),
      );
    }

    const total = items.length;
    const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
    const sliced =
      Number.isFinite(limit) && limit >= 0 ? items.slice(start, start + Math.floor(limit)) : items.slice(start);
    return { items: sliced, total };
  }

  /** Search gbrain pages by query — a thin filter over list(). */
  async function search(query, opts = {}) {
    if (typeof query !== "string" || query.trim() === "") {
      return { error: "search query must be a non-empty string" };
    }
    return list({ ...opts, query });
  }

  /** Fetch a single page's content by slug/id → { id, content }. */
  async function get(id) {
    return getPage(id);
  }

  /**
   * Memory statistics for the cortex state payload. Prefers `gbrain stats`
   * (the TRUE page count); falls back to counting the page list. lastUpdated
   * rides on the newest list row (list is sorted most-recently-updated first).
   * Returns { pageCount, lastUpdated } or { error }.
   */
  async function stats() {
    const loaded = await listPages();
    if (loaded.error) return { error: loaded.error };

    let pageCount = loaded.pages.length;
    const lastUpdated = newestUpdatedAt(loaded.pages);

    const statsRes = await runCli(["stats"]);
    if (!statsRes.error) {
      const parsed = parseStatsText(statsRes.stdout) ?? parseStatsText(statsRes.stderr);
      if (parsed && Number.isFinite(parsed.pages)) pageCount = parsed.pages;
    }
    return { pageCount, lastUpdated };
  }

  /** Fetch a page's content by slug/id. */
  async function getPage(id) {
    if (!id || typeof id !== "string") {
      return { error: "page id must be a non-empty string" };
    }
    const res = await runCli(["get", id]);
    if (res.error) {
      return { error: `gbrain get failed: ${res.error.message || res.error}` };
    }
    const content = (res.stdout || "").trim();
    if (!content) {
      return { error: `gbrain returned no content for page: ${id}` };
    }
    return { id, content };
  }

  return { available, list, search, get, stats, getPage };
}

module.exports = {
  createGbrain,
  parseJsonOutput,
  parseTsvPages,
  parseStatsText,
  toMemoryItem,
};
