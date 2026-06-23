/**
 * Usage sources aggregator — instantiates the five backend usage adapters
 * from a single config object and exposes:
 *
 *   - sources:  { claudeCode, codex, nineRouter, planUsage, openrouter }
 *   - getAll(): parallel snapshot of every source, individually try/caught
 *               so one broken source never hides the others
 *   - routes:   plain async handlers the orchestrator can wire into the
 *               HTTP layer (see "Route handler contract" below)
 *
 * Route handler contract (matches src/fleet-routes.js conventions):
 *   Each entry in `routes` is `async (ctx) => jsonObject` where
 *   `ctx = { query }` and `query` is a URLSearchParams or a plain object of
 *   string/number values. Handlers never throw and never write to a
 *   response; the orchestrator adapts them like:
 *
 *     const handler = usageSources.routes["GET /api/usage/sources"];
 *     json(res, 200, await handler({ query: url.searchParams }));
 *
 * Supported query params: sinceMs (epoch ms), limit, days.
 */

const os = require("os");
const path = require("path");
const { createClaudeCodeSource } = require("./claude-code");
const { createCodexSource } = require("./codex");
const { createNineRouterSource } = require("./nine-router");
const { createPlanUsageSource } = require("./plan-usage");
const { createOpenRouterSource } = require("./openrouter");

const DEFAULT_SESSION_LIMIT = 10;

/** Read one query param from URLSearchParams or a plain object. */
function readQueryParam(query, name) {
  if (!query) return null;
  if (typeof query.get === "function") return query.get(name);
  return Object.prototype.hasOwnProperty.call(query, name) ? query[name] : null;
}

/** Numeric query param with fallback (invalid values fall back, never throw). */
function queryNumber(query, name, fallback = null) {
  const raw = readQueryParam(query, name);
  if (raw === null || raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** Await a promise; map a throw to a graceful unavailable payload. */
async function safe(promise) {
  try {
    return await promise;
  } catch (e) {
    return { available: false, error: e.message };
  }
}

/**
 * Create all usage sources from one config object.
 *
 * @param {object} [config]
 * @param {string} [config.claudeProjectsDir] - default ~/.claude/projects
 * @param {string} [config.codexDir] - default ~/.codex
 * @param {string} [config.nineRouterDb] - default ~/.openclaw/9router/data/db/data.sqlite
 * @param {string} [config.planUsageStats] - default ~/.local/state/openclaw-quota/subscription_state.json
 * @param {string} [config.openrouterKey] - OpenRouter API key (no env fallback here;
 *                                          the orchestrator wires it from env/config).
 *                                          May be an op://vault/item/field 1Password
 *                                          ref — resolved lazily before each API call.
 * @param {object} [config.secrets] - secrets resolver for op:// keys (default:
 *                                    shared resolver; injectable for tests)
 * @param {function} [config.psFn] [config.execFn] [config.fetchFn]
 *                   [config.sqliteLoader] [config.nowFn] - injectable deps for tests
 */
function createUsageSources(config = {}) {
  const home = os.homedir();
  const deps = {
    psFn: config.psFn,
    execFn: config.execFn,
    nowFn: config.nowFn,
  };

  const claudeCode = createClaudeCodeSource({
    projectsDir: config.claudeProjectsDir || path.join(home, ".claude", "projects"),
    ...deps,
  });
  const codex = createCodexSource({
    codexDir: config.codexDir || path.join(home, ".codex"),
    ...deps,
  });
  const nineRouter = createNineRouterSource({
    dbPath: config.nineRouterDb,
    sqliteLoader: config.sqliteLoader,
  });
  const planUsage = createPlanUsageSource({
    statsPath: config.planUsageStats,
    nowFn: config.nowFn,
  });
  const openrouter = createOpenRouterSource({
    apiKey: config.openrouterKey,
    fetchFn: config.fetchFn,
    secrets: config.secrets,
  });

  const sources = { claudeCode, codex, nineRouter, planUsage, openrouter };

  async function claudeCodeSnapshot(params = {}) {
    const status = claudeCode.describe();
    if (!status.available) return { available: false, reason: status.reason };
    const [sessions, live, windows] = await Promise.all([
      safe(claudeCode.getSessions({ sinceMs: params.sinceMs, limit: params.limit })),
      safe(claudeCode.getLive()),
      safe(claudeCode.getUsageWindows()),
    ]);
    return { available: true, live, sessions, windows };
  }

  async function codexSnapshot(params = {}) {
    const status = codex.describe();
    if (!status.available) return { available: false, reason: status.reason };
    const [activity, sessionFiles, live] = await Promise.all([
      safe(codex.getActivity({ sinceMs: params.sinceMs, limit: params.limit })),
      safe(codex.getSessionFiles({ sinceMs: params.sinceMs })),
      safe(codex.getLive()),
    ]);
    return { available: true, activity, sessionFiles, live };
  }

  async function nineRouterSnapshot(params = {}) {
    const status = nineRouter.describe();
    if (!status.available) return { available: false, reason: status.reason };
    const [usage, daily] = await Promise.all([
      safe(nineRouter.getUsage({ sinceMs: params.sinceMs })),
      safe(nineRouter.getDaily(params.days)),
    ]);
    return { available: true, usage, daily };
  }

  async function openrouterSnapshot() {
    if (!openrouter.available) return { available: false, reason: openrouter.reason };
    const [credits, keyInfo] = await Promise.all([
      safe(openrouter.getCredits()),
      safe(openrouter.getKeyInfo()),
    ]);
    return { available: true, credits, keyInfo };
  }

  /**
   * Parallel snapshot of every source. Each source is individually
   * try/caught; a failure in one shows up as { available:false } for that
   * source only.
   * @param {object} [params] - { sinceMs, limit, days }
   */
  async function getAll(params = {}) {
    const [claudeCodeData, codexData, nineRouterData, planUsageData, openrouterData] =
      await Promise.all([
        safe(claudeCodeSnapshot(params)),
        safe(codexSnapshot(params)),
        safe(nineRouterSnapshot(params)),
        safe(planUsage.getSubscription()),
        safe(openrouterSnapshot()),
      ]);
    return {
      claudeCode: claudeCodeData,
      codex: codexData,
      nineRouter: nineRouterData,
      planUsage: planUsageData,
      openrouter: openrouterData,
    };
  }

  /**
   * Subscription snapshot folded with the Codex plan-usage block. Both come
   * from the same plan-usage state file; the `codex` field degrades to
   * { available:false } independently of the Claude windows.
   */
  async function subscriptionSnapshot() {
    const [sub, codexPlan] = await Promise.all([
      safe(planUsage.getSubscription()),
      safe(planUsage.getCodex()),
    ]);
    return { ...sub, codex: codexPlan };
  }

  function paramsFromQuery(query) {
    return {
      sinceMs: queryNumber(query, "sinceMs"),
      limit: queryNumber(query, "limit", DEFAULT_SESSION_LIMIT),
      days: queryNumber(query, "days"),
    };
  }

  const routes = {
    "GET /api/usage/sources": async (ctx = {}) => getAll(paramsFromQuery(ctx.query)),
    "GET /api/usage/claude-code": async (ctx = {}) =>
      safe(claudeCodeSnapshot(paramsFromQuery(ctx.query))),
    "GET /api/usage/codex": async (ctx = {}) => safe(codexSnapshot(paramsFromQuery(ctx.query))),
    "GET /api/usage/nine-router": async (ctx = {}) =>
      safe(nineRouterSnapshot(paramsFromQuery(ctx.query))),
    "GET /api/usage/subscription": async () => safe(subscriptionSnapshot()),
    "GET /api/usage/openrouter": async () => safe(openrouterSnapshot()),
  };

  return { sources, getAll, routes };
}

module.exports = { createUsageSources };
