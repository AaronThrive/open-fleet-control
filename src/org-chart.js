/**
 * Org chart — owner-defined agent hierarchy (purely organizational; drives
 * nothing). Persisted at <stateDir>/org-chart.json with the same safety
 * pattern as the kanban board: hand-rolled schema validation, atomic writes,
 * rolling backups (state/.backups/), quarantine + auto-restore on corruption.
 *
 * Chart shape (v1):
 *   {
 *     version: 1,
 *     updated_at: ISO datetime,
 *     roots: [ { agentId, title|null, children: [...] } ],
 *     unassigned: [ agentId ]
 *   }
 *
 * Nodes reference agents from the /api/agents roster by id. Ids that no
 * longer exist in the roster are tolerated (the UI renders them as ghosts
 * with a remove affordance) — the chart never breaks when an agent is
 * deleted. Every agentId may appear at most once across tree + unassigned.
 */

const path = require("path");
const { createSafeStore } = require("./state-safety");

const CHART_VERSION = 1;
const NODE_FIELDS = Object.freeze(["agentId", "title", "children"]);
const AGENT_ID_MAX = 128;
const TITLE_MAX = 120;
const MAX_NODES = 500; // total placed nodes (roots + all descendants)
const MAX_DEPTH = 12;

// ---------------------------------------------------------------------------
// Primitive validators
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isIsoDateTime(v) {
  return (
    typeof v === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v) &&
    !Number.isNaN(Date.parse(v))
  );
}

function isAgentId(v) {
  return typeof v === "string" && v.length > 0 && v.length <= AGENT_ID_MAX;
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

/**
 * Validate one tree node (recursively). Pushes {path, reason} entries into
 * `errors`; tracks duplicates + node count in `seen` ({ids: Set, count}).
 */
function collectNodeErrors(node, basePath, depth, seen, errors) {
  if (!isPlainObject(node)) {
    errors.push({ path: basePath, reason: "node must be an object" });
    return;
  }
  seen.count += 1;
  if (seen.count > MAX_NODES) {
    if (!seen.overflow) {
      seen.overflow = true;
      errors.push({ path: basePath, reason: `chart exceeds ${MAX_NODES} nodes` });
    }
    return;
  }
  if (depth > MAX_DEPTH) {
    errors.push({ path: basePath, reason: `tree deeper than ${MAX_DEPTH} levels` });
    return;
  }
  for (const key of Object.keys(node)) {
    if (!NODE_FIELDS.includes(key)) {
      errors.push({ path: `${basePath}.${key}`, reason: "unknown node field" });
    }
  }
  if (!isAgentId(node.agentId)) {
    errors.push({
      path: `${basePath}.agentId`,
      reason: `agentId must be a non-empty string of at most ${AGENT_ID_MAX} characters`,
    });
  } else if (seen.ids.has(node.agentId)) {
    errors.push({ path: `${basePath}.agentId`, reason: `duplicate agentId '${node.agentId}'` });
  } else {
    seen.ids.add(node.agentId);
  }
  if (node.title !== null && (typeof node.title !== "string" || node.title.length > TITLE_MAX)) {
    errors.push({
      path: `${basePath}.title`,
      reason: `title must be null or a string of at most ${TITLE_MAX} characters`,
    });
  }
  if (!Array.isArray(node.children)) {
    errors.push({ path: `${basePath}.children`, reason: "children must be an array" });
    return;
  }
  node.children.forEach((child, i) => {
    collectNodeErrors(child, `${basePath}.children[${i}]`, depth + 1, seen, errors);
  });
}

/**
 * Validate a full chart object.
 * @param {object} obj - candidate chart
 * @returns {{valid: boolean, errors: Array<{path: string, reason: string}>}}
 */
function validateChart(obj) {
  const errors = [];
  if (!isPlainObject(obj)) {
    return { valid: false, errors: [{ path: "chart", reason: "chart must be an object" }] };
  }
  for (const key of Object.keys(obj)) {
    if (!["version", "updated_at", "roots", "unassigned"].includes(key)) {
      errors.push({ path: key, reason: "unknown chart field" });
    }
  }
  if (obj.version !== CHART_VERSION) {
    errors.push({ path: "version", reason: `version must be ${CHART_VERSION}` });
  }
  if (!isIsoDateTime(obj.updated_at)) {
    errors.push({ path: "updated_at", reason: "updated_at must be an ISO datetime" });
  }
  const seen = { ids: new Set(), count: 0, overflow: false };
  if (!Array.isArray(obj.roots)) {
    errors.push({ path: "roots", reason: "roots must be an array" });
  } else {
    obj.roots.forEach((node, i) => {
      collectNodeErrors(node, `roots[${i}]`, 1, seen, errors);
    });
  }
  if (!Array.isArray(obj.unassigned)) {
    errors.push({ path: "unassigned", reason: "unassigned must be an array" });
  } else {
    obj.unassigned.forEach((id, i) => {
      if (!isAgentId(id)) {
        errors.push({
          path: `unassigned[${i}]`,
          reason: `unassigned entries must be non-empty strings of at most ${AGENT_ID_MAX} characters`,
        });
      } else if (seen.ids.has(id)) {
        errors.push({ path: `unassigned[${i}]`, reason: `duplicate agentId '${id}'` });
      } else {
        seen.ids.add(id);
      }
    });
  }
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------

/** Create an empty, valid chart. */
function createEmptyChart() {
  return {
    version: CHART_VERSION,
    updated_at: new Date().toISOString(),
    roots: [],
    unassigned: [],
  };
}

/** Immutably normalize one input node: defaults applied, unknown keys kept
 *  (so validation can reject them with a precise path). */
function normalizeNode(node) {
  if (!isPlainObject(node)) return node;
  const extra = {};
  for (const [key, value] of Object.entries(node)) {
    if (!NODE_FIELDS.includes(key)) extra[key] = value;
  }
  return {
    ...extra,
    agentId: node.agentId,
    title: node.title === undefined || node.title === "" ? null : node.title,
    children: Array.isArray(node.children) ? node.children.map(normalizeNode) : node.children,
  };
}

/**
 * Build a full chart from partial input ({roots?, unassigned?, version?}),
 * applying defaults and a fresh updated_at. Throws (with an `errors`
 * property) when the result is invalid.
 * @param {object} input - partial chart fields
 * @returns {object} fully-populated valid chart
 */
function normalizeChart(input = {}) {
  if (!isPlainObject(input)) {
    const err = new Error("normalizeChart: chart must be an object");
    err.errors = [{ path: "chart", reason: "chart must be an object" }];
    throw err;
  }
  const chart = {
    version: input.version === undefined ? CHART_VERSION : input.version,
    updated_at: new Date().toISOString(),
    roots: Array.isArray(input.roots) ? input.roots.map(normalizeNode) : (input.roots ?? []),
    unassigned: input.unassigned ?? [],
  };
  const result = validateChart(chart);
  if (!result.valid) {
    const summary = result.errors.map((e) => `${e.path}: ${e.reason}`).join("; ");
    const err = new Error(`Invalid org chart — ${summary}`);
    err.errors = result.errors;
    throw err;
  }
  return chart;
}

/** Total placed nodes in a (valid) chart tree. */
function countNodes(roots) {
  let count = 0;
  const stack = Array.isArray(roots) ? [...roots] : [];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isPlainObject(node)) continue;
    count += 1;
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Engine factory
// ---------------------------------------------------------------------------

/**
 * Create an org chart engine over the safe JSON store.
 *
 * @param {object} options
 * @param {string} options.stateDir - directory holding org-chart.json (+ .backups/)
 * @param {function} [options.onChange] - (eventDetail) => void, fired after every mutation
 * @param {number} [options.debounceMs] - watch debounce override (passed to safe store)
 * @returns {object} org chart API
 */
function createOrgChart(options = {}) {
  const { stateDir, onChange, debounceMs } = options;
  if (!stateDir) throw new Error("createOrgChart: stateDir is required");

  const store = createSafeStore({
    filePath: path.join(stateDir, "org-chart.json"),
    backupDir: path.join(stateDir, ".backups"),
    validate: validateChart,
    createDefault: () => createEmptyChart(),
    debounceMs,
  });

  function emit(type, detail) {
    if (typeof onChange === "function") {
      onChange({ type, ts: new Date().toISOString(), ...detail });
    }
  }

  /** Read the persisted chart (recovering from corruption if needed). */
  function getChart() {
    return store.read().data;
  }

  /**
   * Full-tree replace: normalize + validate the incoming chart, persist it
   * atomically (previous good version backed up), fire org.updated.
   * @param {object} input - {roots, unassigned} (version optional)
   * @param {string} actor - who performed the action
   * @returns {object} the persisted chart
   */
  function replaceChart(input, actor) {
    const chart = normalizeChart(input);
    store.write(chart);
    emit("org.updated", {
      actor,
      roots: chart.roots.length,
      nodes: countNodes(chart.roots),
      unassigned: chart.unassigned.length,
    });
    return chart;
  }

  /**
   * Watch org-chart.json for direct external edits. Invalid writes are
   * quarantined + restored by the safe store; either way an event fires.
   * @returns {{close: function}}
   */
  function watch() {
    return store.watch((result) => {
      emit("org.external_change", {
        restored: result.restored,
        quarantinedPath: result.quarantinedPath,
        usedDefault: result.usedDefault,
      });
    });
  }

  return { getChart, replaceChart, watch };
}

module.exports = {
  CHART_VERSION,
  validateChart,
  createEmptyChart,
  normalizeChart,
  countNodes,
  createOrgChart,
};
