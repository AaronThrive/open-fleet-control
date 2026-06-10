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
    const parsed = parseJsonOutput(res.stdout) ?? parseJsonOutput(res.stderr);
    if (!Array.isArray(parsed)) {
      const firstLine =
        `${res.stdout}\n${res.stderr}`.trim().split("\n")[0]?.slice(0, 200) || "no output";
      cachedAvailability = {
        available: false,
        reason: `gbrain CLI returned no usable JSON (likely broken data bundle): ${firstLine}`,
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
    const pages = parseJsonOutput(listRes.stdout) ?? parseJsonOutput(listRes.stderr);
    if (!Array.isArray(pages)) {
      return { error: "gbrain list returned no usable JSON" };
    }
    const nodes = pages.map(toGraphNode).filter(Boolean);

    let edges = [];
    let note = null;
    const linksRes = await runCli(["extract", "links", "--source", "db", "--dry-run", "--json"]);
    if (linksRes.error) {
      note = `link extraction unavailable: ${linksRes.error.message || linksRes.error}`;
    } else {
      const linkPayload = parseJsonOutput(linksRes.stdout) ?? parseJsonOutput(linksRes.stderr);
      const links = Array.isArray(linkPayload)
        ? linkPayload
        : Array.isArray(linkPayload?.links)
          ? linkPayload.links
          : null;
      if (links) {
        edges = links.map(toGraphEdge).filter(Boolean);
      } else {
        note = "link extraction returned no usable JSON";
      }
    }

    const graph = { nodes, edges };
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

module.exports = { createGbrain, parseJsonOutput };
