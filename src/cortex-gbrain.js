/**
 * Cortex gbrain adapter — read-only access to the gbrain knowledge graph CLI.
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
const DEFAULT_GRAPH_LIMIT = 200;

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
 * Parse `gbrain extract links --dry-run --json` output. The real CLI emits
 * NDJSON candidate lines ({"action":"add_link","from":...,"to":...,"type":...})
 * followed by a pretty-printed summary object — not a single JSON array.
 * Also accepts a plain JSON array or { links: [...] } envelope for
 * forward-compatibility. Returns an array of link records, or null when the
 * output is unusable.
 */
function parseExtractLinks(text) {
  if (!text || typeof text !== "string") return null;
  const links = [];
  for (const line of text.split("\n")) {
    const candidate = line.trim();
    if (!candidate.startsWith("{")) continue;
    try {
      const obj = JSON.parse(candidate);
      if (obj && obj.action === "add_link") links.push(obj);
    } catch (e) {
      // Not a complete single-line JSON object (e.g. part of the
      // pretty-printed summary) — skip.
    }
  }
  if (links.length > 0) return links;

  const payload = parseJsonOutput(text);
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.links)) return payload.links;
  // A bare summary object ({ links_created: 0, ... }) means the extract ran
  // and found zero candidates — a valid empty edge list.
  if (payload && typeof payload === "object") return [];
  return null;
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

/** Normalize a gbrain page record into a graph node. */
function toGraphNode(page) {
  if (!page || typeof page !== "object") return null;
  const id = page.slug ?? page.id ?? null;
  if (!id) return null;
  return {
    id,
    title: page.title ?? page.name ?? id,
    type: page.type ?? page.page_type ?? "page",
  };
}

/** Normalize a gbrain link record into a graph edge. */
function toGraphEdge(link) {
  if (!link || typeof link !== "object") return null;
  const from = link.from ?? link.source ?? link.from_slug ?? null;
  const to = link.to ?? link.target ?? link.to_slug ?? null;
  if (!from || !to) return null;
  return {
    from,
    to,
    kind: link.kind ?? link.type ?? link.link_type ?? "link",
  };
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
   * Build graph data { nodes, edges } from the CLI.
   * Nodes come from `gbrain list --json`; edges are best-effort via
   * `gbrain extract links --source db --dry-run --json` (failure to extract
   * links degrades to an empty edge list with a note).
   */
  async function getGraph({ limit = DEFAULT_GRAPH_LIMIT } = {}) {
    const listRes = await runCli(["list", "--limit", String(limit), "--json"]);
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
    const nodes = pages.map(toGraphNode).filter(Boolean);

    let edges = [];
    let note = null;
    const linksRes = await runCli(["extract", "links", "--source", "db", "--dry-run", "--json"]);
    if (linksRes.error) {
      note = `link extraction unavailable: ${linksRes.error.message || linksRes.error}`;
    } else {
      const links = parseExtractLinks(linksRes.stdout) ?? parseExtractLinks(linksRes.stderr);
      if (links) {
        edges = links.map(toGraphEdge).filter(Boolean);
      } else {
        note = "link extraction returned no usable JSON";
      }
    }

    // Provenance: where the nodes come from. `list` caps its output (100 in
    // gbrain 0.12.x), so the TRUE page count comes from `gbrain stats`;
    // dbLinks is the committed link count in the db (0 until the user runs
    // `gbrain extract links`). lastUpdated rides on the newest list row
    // (list output is sorted most-recently-updated first).
    const provenance = {
      totalPages: nodes.length,
      dbLinks: null,
      lastUpdated: pages.find((p) => p && p.updated_at)?.updated_at ?? null,
    };
    const statsRes = await runCli(["stats"]);
    if (!statsRes.error) {
      const stats = parseStatsText(statsRes.stdout) ?? parseStatsText(statsRes.stderr);
      if (stats) {
        if (Number.isFinite(stats.pages)) provenance.totalPages = stats.pages;
        if (Number.isFinite(stats.links)) provenance.dbLinks = stats.links;
      }
    }

    const graph = { nodes, edges, provenance };
    if (note) graph.note = note;
    return graph;
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

  return { available, getGraph, getPage };
}

module.exports = {
  createGbrain,
  parseJsonOutput,
  parseTsvPages,
  parseExtractLinks,
  parseStatsText,
};
