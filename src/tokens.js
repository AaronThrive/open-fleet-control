const fs = require("fs");
const path = require("path");
const { formatNumber, formatTokens } = require("./utils");

// Claude Opus 4 pricing (per 1M tokens). This is the DEFAULT rate table used
// when a model has no provider-specific entry in PROVIDER_TOKEN_RATES below.
const TOKEN_RATES = {
  input: 15.0, // $15/1M input tokens
  output: 75.0, // $75/1M output tokens
  cacheRead: 1.5, // $1.50/1M (90% discount from input)
  cacheWrite: 18.75, // $18.75/1M (25% premium on input)
};

// Per-provider per-token reference rates (per 1M tokens). Used so a model's
// hypothetical "if billed per-token" projection reflects ITS OWN list price
// instead of pricing everything at Opus rates. Keyed by the coarse provider
// id from modelToProvider(). Codex/gpt-5.5 tokens are priced at the GPT-5.5
// list price; Claude/Opus tokens at the Opus rate. Providers absent from this
// map fall back to TOKEN_RATES (Opus). These are sensible, overridable list
// prices — NOT secrets.
const PROVIDER_TOKEN_RATES = {
  // Anthropic Claude (Opus 4) — same as the default table.
  "claude-code": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  // OpenAI Codex runtime (GPT-5.5). List price per 1M tokens; cache reads at the
  // standard cached-input discount, cache writes at the input rate.
  codex: { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 1.25 },
};

// Resolve the per-token rate table for a model. Looks up the model's coarse
// provider in PROVIDER_TOKEN_RATES; falls back to the supplied default table
// (TOKEN_RATES / Opus) when the provider has no specific entry.
function ratesForModel(model, defaultRates = TOKEN_RATES) {
  const provider = modelToProvider(model);
  return PROVIDER_TOKEN_RATES[provider] || defaultRates;
}

// Billing-mode constants. "subscription" providers are paid via a flat
// monthly OAuth/subscription plan (Codex OAuth, Claude Code Max, …) and have
// NO per-token marginal cost — their dollar figures are purely hypothetical
// ("if billed per-token"). "per-token" providers (OpenRouter, raw API keys)
// incur real marginal spend per request.
const BILLING_SUBSCRIPTION = "subscription";
const BILLING_PER_TOKEN = "per-token";
const DEFAULT_BILLING_MODE = BILLING_PER_TOKEN;

// Default flat-fee subscription plans. Each plan is a flat monthly cost spread
// across all usage attributed to its provider key(s), with ~$0 marginal token
// cost (same margin model Claude has always had). Defaults are sensible,
// overridable list prices — NOT secrets:
//   - Claude Code Max  → $200/mo (config.billing.claudePlanCost)
//   - Codex subscription → $200/mo (config.billing.codexPlanCost)
// `providers` lists the coarse provider keys (see modelToProvider) whose usage
// is attributed to that plan's flat line.
const DEFAULT_CLAUDE_PLAN_COST = 200;
const DEFAULT_CLAUDE_PLAN_NAME = "Claude Code Max";
const DEFAULT_CODEX_PLAN_COST = 200;
const DEFAULT_CODEX_PLAN_NAME = "Codex subscription";

// Build the list of flat-fee subscription plans from config.billing.
//
// Backward-compatible: if config.billing.claudePlanCost / claudePlanName are
// set they map into the "claude" plan. A "codex" plan is always added (default
// DEFAULT_CODEX_PLAN_COST, overridable via config.billing.codexPlanCost /
// codexPlanName). config.billing.plans (an array of {id,label,planCost,
// providers}) is honored verbatim when present and takes precedence over the
// legacy scalar keys, so callers can declare arbitrary plans.
//
// Returns an array of normalized plan objects:
//   { id, label, planCost, providers: string[] }
function getBillingPlans(config) {
  const billing = (config && config.billing) || {};

  // Explicit plans[] declaration wins when present and well-formed.
  if (Array.isArray(billing.plans)) {
    const plans = billing.plans
      .filter((p) => p && typeof p === "object")
      .map((p) => ({
        id: String(p.id || "").trim() || "plan",
        label: String(p.label || p.id || "Subscription plan"),
        planCost: Number.isFinite(Number(p.planCost)) ? Number(p.planCost) : 0,
        providers: Array.isArray(p.providers)
          ? p.providers.map((x) => String(x)).filter(Boolean)
          : [],
      }));
    if (plans.length > 0) return plans;
  }

  // Legacy scalar keys → canonical Claude + Codex plans.
  const claudeCost = Number.isFinite(Number(billing.claudePlanCost))
    ? Number(billing.claudePlanCost)
    : DEFAULT_CLAUDE_PLAN_COST;
  const codexCost = Number.isFinite(Number(billing.codexPlanCost))
    ? Number(billing.codexPlanCost)
    : DEFAULT_CODEX_PLAN_COST;

  return [
    {
      id: "claude",
      label: String(billing.claudePlanName || DEFAULT_CLAUDE_PLAN_NAME),
      planCost: claudeCost,
      providers: ["claude-code"],
    },
    {
      id: "codex",
      label: String(billing.codexPlanName || DEFAULT_CODEX_PLAN_NAME),
      planCost: codexCost,
      providers: ["codex"],
    },
  ];
}

// Total flat plan cost across every configured subscription plan.
function totalPlanCost(plans) {
  return plans.reduce((sum, plan) => sum + (Number(plan.planCost) || 0), 0);
}

// Neutral descriptor for the SUMMED flat-plan card. The summed card spans every
// configured plan, so a single plan's label misrepresents it. Derive a short
// human label from the plan ids/labels:
//   - one plan  → that plan's label
//   - 2-3 plans → short names joined ("Claude + Codex")
//   - 4+ plans  → "<n> subscription plans"
// Falls back to "Subscription plans" when no plans are configured.
function describePlanSet(plans) {
  const list = Array.isArray(plans) ? plans.filter(Boolean) : [];
  if (list.length === 0) return "Subscription plans";
  if (list.length === 1) return String(list[0].label || list[0].id || "Subscription plan");
  if (list.length > 3) return `${list.length} subscription plans`;
  // Prefer the short id (Capitalized) over the verbose label for the join.
  const shortName = (plan) => {
    const id = String(plan.id || "").trim();
    if (id) return id.charAt(0).toUpperCase() + id.slice(1);
    return String(plan.label || "Plan");
  };
  return list.map(shortName).join(" + ");
}

// Map a raw model id (e.g. "gpt-5.3-codex", "claude-opus-4", "anthropic/…")
// to a coarse provider key matching the keys used in
// config.billing.providerBillingModes. Heuristic + backward-compatible:
// unknown shapes fall through to the literal model id so an explicit
// per-model entry in the config map can still match.
function modelToProvider(model) {
  const id = String(model || "").toLowerCase();
  if (!id || id === "unknown") return "unknown";
  // Codex-via-OAuth runtime. The 2026 provider migration renamed model refs from
  // "codex/gpt-5.5" to "openai/gpt-5.5" (still routed through the Codex OAuth
  // backend, NOT the metered OpenAI API). Detect the Codex runtime BEFORE the
  // generic "vendor/model" → openrouter branch so this OAuth usage keeps
  // mapping to the subscription-billed "codex" provider. We strip an optional
  // "codex/" or "openai/" vendor prefix; any remaining slug is a genuine
  // OpenRouter route and stays per-token below.
  const bare = id.replace(/^(?:codex|openai)\//, "");
  if (bare.includes("codex") || bare === "gpt-5.5" || bare.startsWith("gpt-5.5-")) return "codex";
  // OpenRouter-style "vendor/model" slugs → the vendor segment is the route,
  // but the marginal cost is OpenRouter's, so bill under "openrouter".
  if (id.includes("/")) return "openrouter";
  if (id.includes("codex")) return "codex";
  if (id.startsWith("claude") || id.includes("anthropic")) return "claude-code";
  if (id.startsWith("gpt") || id.startsWith("o1") || id.startsWith("o3") || id.includes("openai"))
    return "codex";
  if (id.startsWith("gemini") || id.includes("google")) return "gemini";
  return id;
}

// Resolve the billing mode for a provider/model from an optional
// providerBillingModes map. Unknown providers default to "per-token" so the
// honest worst-case (real marginal $) is assumed unless config says otherwise.
function resolveBillingMode(provider, providerBillingModes) {
  const map =
    providerBillingModes && typeof providerBillingModes === "object" ? providerBillingModes : {};
  const mode = map[provider];
  return mode === BILLING_SUBSCRIPTION || mode === BILLING_PER_TOKEN ? mode : DEFAULT_BILLING_MODE;
}

// Read the providerBillingModes map off a config object (never throws,
// tolerates absent config.billing).
function getProviderBillingModes(config) {
  const modes = config && config.billing && config.billing.providerBillingModes;
  return modes && typeof modes === "object" && !Array.isArray(modes) ? modes : {};
}

// True when this model id is billed via a flat subscription (zero marginal $).
function isSubscriptionModel(model, providerBillingModes) {
  return resolveBillingMode(modelToProvider(model), providerBillingModes) === BILLING_SUBSCRIPTION;
}

// Token usage cache with async background refresh
let tokenUsageCache = { data: null, timestamp: 0, refreshing: false };
const TOKEN_USAGE_CACHE_TTL = 30000; // 30 seconds

// Reference to background refresh interval (set by startTokenUsageRefresh)
let refreshInterval = null;

// Create empty usage bucket
function emptyUsageBucket() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0 };
}

// Accumulate one usage entry into a bucket (mutates the bucket accumulator)
function addUsageToBucket(bucket, usage) {
  bucket.input += usage.input || 0;
  bucket.output += usage.output || 0;
  bucket.cacheRead += usage.cacheRead || 0;
  bucket.cacheWrite += usage.cacheWrite || 0;
  bucket.cost += usage.cost?.total || 0;
  bucket.requests++;
}

// Accumulate one usage entry into a per-model map (keyed by model id)
function addUsageToModelMap(modelMap, model, usage) {
  const key = model || "unknown";
  if (!modelMap[key]) modelMap[key] = emptyUsageBucket();
  addUsageToBucket(modelMap[key], usage);
}

// Recursively collect Claude Code transcript (.jsonl) files under a projects
// dir (project dir -> subagents/ -> nested transcripts). Mirrors the scan in
// src/usage-sources/claude-code.js so Opus / Claude Code usage is ingested
// into the same per-model byModel map as the OpenClaw session store.
const CLAUDE_PROJECTS_SCAN_DEPTH = 4;
async function collectClaudeCodeFiles(dir, depth, out) {
  if (depth > CLAUDE_PROJECTS_SCAN_DEPTH) return;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return; // unreadable / missing directory — skip silently
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectClaudeCodeFiles(full, depth + 1, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
}

// Normalize a Claude Code assistant `message.usage` block (snake_case token
// keys) into the camelCase shape addUsageToBucket expects. Claude Code never
// reports a per-message dollar cost, so `cost` is omitted (estimated later at
// the per-model rate).
function claudeCodeUsageToBucketUsage(usage) {
  return {
    input: Number(usage.input_tokens) || 0,
    output: Number(usage.output_tokens) || 0,
    cacheRead: Number(usage.cache_read_input_tokens) || 0,
    cacheWrite: Number(usage.cache_creation_input_tokens) || 0,
  };
}

// Ingest Claude Code transcripts into the four time-windowed buckets + per-model
// maps, mirroring the OpenClaw-session ingestion below. Reads the assistant
// `message.model` (e.g. "claude-opus-4-...") so Opus shows up in the per-model
// breakdown and the model filter. Mutates the passed accumulators; never throws.
async function ingestClaudeCodeUsage(projectsDir, windows, byModels, thresholds) {
  const files = [];
  await collectClaudeCodeFiles(projectsDir, 0, files);
  if (files.length === 0) return;

  const { oneDayAgo, threeDaysAgo, sevenDaysAgo, thirtyDaysAgo } = thresholds;
  const batchSize = 50;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (filePath) => {
        try {
          const stat = await fs.promises.stat(filePath);
          if (stat.mtimeMs < thirtyDaysAgo) return;
          const content = await fs.promises.readFile(filePath, "utf8");
          for (const line of content.split("\n")) {
            if (!line.trim()) continue;
            let entry;
            try {
              entry = JSON.parse(line);
            } catch (e) {
              continue; // malformed line — skip
            }
            if (entry.type !== "assistant" || !entry.message?.usage) continue;
            const model = entry.message.model;
            if (!model || model === "<synthetic>") continue;
            const entryTime = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
            if (!Number.isFinite(entryTime) || entryTime < thirtyDaysAgo) continue;
            const u = claudeCodeUsageToBucketUsage(entry.message.usage);
            if (entryTime >= oneDayAgo) {
              addUsageToBucket(windows.usage24h, u);
              addUsageToModelMap(byModels.byModel24h, model, u);
            }
            if (entryTime >= threeDaysAgo) {
              addUsageToBucket(windows.usage3d, u);
              addUsageToModelMap(byModels.byModel3d, model, u);
            }
            if (entryTime >= sevenDaysAgo) {
              addUsageToBucket(windows.usage7d, u);
              addUsageToModelMap(byModels.byModel7d, model, u);
            }
            addUsageToBucket(windows.usage30d, u);
            addUsageToModelMap(byModels.byModel30d, model, u);
          }
        } catch (e) {
          // unreadable file — skip
        }
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Async token usage refresh - runs in background, doesn't block.
//
// Ingests usage from TWO sources into one per-model byModel map so the model
// filter, per-model table, and per-token cost cover BOTH runtimes:
//   1. OpenClaw session store (~/.openclaw/agents/main/sessions/*.jsonl) —
//      Codex/gpt-5.5 turns routed through the OpenClaw gateway.
//   2. Claude Code transcripts (~/.claude/projects/**/*.jsonl) — local Claude
//      Code / Opus terminal sessions (getClaudeProjectsDir, default
//      ~/.claude/projects).
async function refreshTokenUsageAsync(getOpenClawDir, getClaudeProjectsDir) {
  if (tokenUsageCache.refreshing) return;
  tokenUsageCache.refreshing = true;

  try {
    const sessionsDir = path.join(getOpenClawDir(), "agents", "main", "sessions");
    let jsonlFiles = [];
    try {
      const files = await fs.promises.readdir(sessionsDir);
      jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
    } catch (e) {
      // No OpenClaw session store — Claude Code ingestion below can still run.
      jsonlFiles = [];
    }

    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

    // Track usage for each time window
    const usage24h = emptyUsageBucket();
    const usage3d = emptyUsageBucket();
    const usage7d = emptyUsageBucket();
    const usage30d = emptyUsageBucket();

    // Track usage per model for each time window
    const byModel24h = {};
    const byModel3d = {};
    const byModel7d = {};
    const byModel30d = {};

    // Process files in batches to avoid overwhelming the system
    const batchSize = 50;
    for (let i = 0; i < jsonlFiles.length; i += batchSize) {
      const batch = jsonlFiles.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async (file) => {
          const filePath = path.join(sessionsDir, file);
          try {
            const stat = await fs.promises.stat(filePath);
            // Skip files not modified in the widest window (30 days)
            if (stat.mtimeMs < thirtyDaysAgo) return;

            const content = await fs.promises.readFile(filePath, "utf8");
            const lines = content.trim().split("\n");

            for (const line of lines) {
              if (!line) continue;
              try {
                const entry = JSON.parse(line);
                const entryTime = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;

                // Skip entries older than the widest window (30 days)
                if (entryTime < thirtyDaysAgo) continue;

                if (entry.message?.usage) {
                  const u = entry.message.usage;
                  const model = entry.message.model || "unknown";

                  // Add to appropriate buckets (cumulative - each window is a
                  // subset of the next: 24h ⊂ 3d ⊂ 7d ⊂ 30d)
                  if (entryTime >= oneDayAgo) {
                    addUsageToBucket(usage24h, u);
                    addUsageToModelMap(byModel24h, model, u);
                  }
                  if (entryTime >= threeDaysAgo) {
                    addUsageToBucket(usage3d, u);
                    addUsageToModelMap(byModel3d, model, u);
                  }
                  if (entryTime >= sevenDaysAgo) {
                    addUsageToBucket(usage7d, u);
                    addUsageToModelMap(byModel7d, model, u);
                  }
                  // Always add to 30d (already filtered above)
                  addUsageToBucket(usage30d, u);
                  addUsageToModelMap(byModel30d, model, u);
                }
              } catch (e) {
                // Skip invalid lines
              }
            }
          } catch (e) {
            // Skip unreadable files
          }
        }),
      );

      // Yield to event loop between batches
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Also ingest Claude Code / Opus transcripts so Opus appears in the model
    // filter + per-model table alongside the OpenClaw (Codex) usage above.
    const claudeProjectsDir =
      typeof getClaudeProjectsDir === "function"
        ? getClaudeProjectsDir()
        : path.join(require("os").homedir(), ".claude", "projects");
    await ingestClaudeCodeUsage(
      claudeProjectsDir,
      { usage24h, usage3d, usage7d, usage30d },
      { byModel24h, byModel3d, byModel7d, byModel30d },
      { oneDayAgo, threeDaysAgo, sevenDaysAgo, thirtyDaysAgo },
    );

    // Helper to finalize bucket with computed fields
    const finalizeBucket = (bucket, byModel) => ({
      ...bucket,
      tokensNoCache: bucket.input + bucket.output,
      tokensWithCache: bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite,
      ...(byModel ? { byModel } : {}),
    });

    const result = {
      // Primary (24h) for backward compatibility
      ...finalizeBucket(usage24h),
      // All four windows (with per-model breakdowns)
      windows: {
        "24h": finalizeBucket(usage24h, byModel24h),
        "3d": finalizeBucket(usage3d, byModel3d),
        "7d": finalizeBucket(usage7d, byModel7d),
        "30d": finalizeBucket(usage30d, byModel30d),
      },
    };

    tokenUsageCache = { data: result, timestamp: Date.now(), refreshing: false };
    console.log(
      `[Token Usage] Cached: 24h=${usage24h.requests} 3d=${usage3d.requests} 7d=${usage7d.requests} 30d=${usage30d.requests} requests`,
    );
  } catch (e) {
    console.error("[Token Usage] Refresh error:", e.message);
    tokenUsageCache.refreshing = false;
  }
}

// Returns cached token usage, triggers async refresh if stale
function getDailyTokenUsage(getOpenClawDir) {
  const now = Date.now();
  const isStale = now - tokenUsageCache.timestamp > TOKEN_USAGE_CACHE_TTL;

  // Trigger async refresh if stale (don't await)
  if (isStale && !tokenUsageCache.refreshing && getOpenClawDir) {
    refreshTokenUsageAsync(getOpenClawDir);
  }

  const emptyResult = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    requests: 0,
    tokensNoCache: 0,
    tokensWithCache: 0,
    windows: {
      "24h": {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        requests: 0,
        tokensNoCache: 0,
        tokensWithCache: 0,
      },
      "3d": {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        requests: 0,
        tokensNoCache: 0,
        tokensWithCache: 0,
      },
      "7d": {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        requests: 0,
        tokensNoCache: 0,
        tokensWithCache: 0,
      },
      "30d": {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        requests: 0,
        tokensNoCache: 0,
        tokensWithCache: 0,
      },
    },
  };

  // Always return cache (may be stale or null on cold start)
  return tokenUsageCache.data || emptyResult;
}

// Calculate cost for a usage bucket.
//
// `billingMode` (optional, default "per-token") controls how `totalCost` is
// reported. For a subscription bucket the per-token line items
// (input/output/cache*) and `hypotheticalTotal` are still computed and
// returned — so a UI can show "if billed per-token" — but `totalCost`
// (the REAL marginal spend) is forced to 0. Existing callers that omit the
// param get the unchanged per-token behavior, where totalCost ===
// hypotheticalTotal.
function calculateCostForBucket(bucket, rates = TOKEN_RATES, billingMode = DEFAULT_BILLING_MODE) {
  const inputCost = (bucket.input / 1_000_000) * rates.input;
  const outputCost = (bucket.output / 1_000_000) * rates.output;
  const cacheReadCost = (bucket.cacheRead / 1_000_000) * rates.cacheRead;
  const cacheWriteCost = (bucket.cacheWrite / 1_000_000) * rates.cacheWrite;
  const hypotheticalTotal = inputCost + outputCost + cacheReadCost + cacheWriteCost;
  const subscription = billingMode === BILLING_SUBSCRIPTION;
  return {
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    billingMode: subscription ? BILLING_SUBSCRIPTION : BILLING_PER_TOKEN,
    // "if billed per-token" projection (always the raw token math)
    hypotheticalTotal,
    // REAL marginal spend: 0 under a flat subscription
    marginalTotal: subscription ? 0 : hypotheticalTotal,
    // Backward-compatible: real spend (0 for subscription, per-token otherwise)
    totalCost: subscription ? 0 : hypotheticalTotal,
  };
}

// Aggregate a per-window per-model map into subscription-aware totals, so a
// window's marginal spend counts ONLY per-token models while the per-token
// projection counts everything. Returns:
//   { marginalTotal, hypotheticalTotal, subscriptionTotal }
// where subscriptionTotal is the per-token value of subscription-billed models
// (i.e. the money NOT spent because of the flat plan).
function aggregateModelCosts(byModel = {}, rates = TOKEN_RATES, providerBillingModes = {}) {
  let marginalTotal = 0;
  let hypotheticalTotal = 0;
  let subscriptionTotal = 0;
  for (const row of summarizeModelUsage(byModel, rates, providerBillingModes)) {
    hypotheticalTotal += row.hypotheticalCost;
    marginalTotal += row.marginalCost;
    if (row.subscription) subscriptionTotal += row.hypotheticalCost;
  }
  return {
    marginalTotal: Math.round(marginalTotal * 1e6) / 1e6,
    hypotheticalTotal: Math.round(hypotheticalTotal * 1e6) / 1e6,
    subscriptionTotal: Math.round(subscriptionTotal * 1e6) / 1e6,
  };
}

// Attribute a window's per-model usage to the configured flat-fee plans.
//
// Each plan line carries the SAME margin treatment Claude has always had: a
// flat plan cost spread across that plan's usage, ~$0 marginal token cost, and
// the hypothetical "if billed per-token" projection for that plan's models.
// Codex-runtime usage (provider "codex") lands on the Codex plan; Claude usage
// (provider "claude-code") on the Claude plan; per-token providers are never
// attributed to a flat plan.
//
// Returns one row per plan:
//   { id, label, planCost, providers, hypotheticalCost, marginalCost,
//     requests, models: [modelId, ...] }
function aggregatePlanCosts(
  byModel = {},
  plans = [],
  rates = TOKEN_RATES,
  providerBillingModes = {},
) {
  // provider → plan index, for O(1) attribution.
  const providerToPlan = new Map();
  plans.forEach((plan, index) => {
    for (const provider of plan.providers || []) providerToPlan.set(provider, index);
  });

  const lines = plans.map((plan) => ({
    id: plan.id,
    label: plan.label,
    planCost: Number(plan.planCost) || 0,
    providers: [...(plan.providers || [])],
    hypotheticalCost: 0,
    marginalCost: 0,
    requests: 0,
    models: [],
  }));

  for (const row of summarizeModelUsage(byModel, rates, providerBillingModes)) {
    const index = providerToPlan.get(row.provider);
    if (index === undefined) continue;
    const line = lines[index];
    line.hypotheticalCost += row.hypotheticalCost;
    line.marginalCost += row.marginalCost;
    line.requests += row.requests;
    line.models.push(row.model);
  }

  return lines.map((line) => ({
    ...line,
    hypotheticalCost: Math.round(line.hypotheticalCost * 1e6) / 1e6,
    marginalCost: Math.round(line.marginalCost * 1e6) / 1e6,
  }));
}

// Summarize a per-model usage map into a sorted array with honest costs.
//
// Billing-aware semantics (never conflate the three):
//   - `hypotheticalCost`  — always the per-token estimate at `rates` (or the
//                            provider-reported figure when present). For
//                            subscription models this is the "if billed
//                            per-token" projection, NOT money spent.
//   - `marginalCost`      — REAL incremental spend. 0 for subscription models
//                            (flat plan), equal to `hypotheticalCost` for
//                            per-token models.
//   - `cost`              — backward-compatible field: the displayable figure.
//                            Kept as the per-token/reported value so existing
//                            callers don't change, but `billingMode` +
//                            `marginalCost` let honest UIs override it.
//
// `providerBillingModes` is the optional config map; absent → everything
// defaults to per-token (the honest worst case).
function summarizeModelUsage(byModel = {}, rates = TOKEN_RATES, providerBillingModes = {}) {
  return Object.entries(byModel)
    .map(([model, bucket]) => {
      // Price each model at ITS OWN per-token rate (Codex/gpt-5.5 at the GPT
      // list price, Claude/Opus at the Opus rate) rather than Opus-for-all.
      const estCost = calculateCostForBucket(bucket, ratesForModel(model, rates)).totalCost;
      const reportedCost = bucket.cost || 0;
      const hypotheticalCost = reportedCost > 0 ? reportedCost : estCost;
      const provider = modelToProvider(model);
      const billingMode = resolveBillingMode(provider, providerBillingModes);
      const subscription = billingMode === BILLING_SUBSCRIPTION;
      const marginalCost = subscription ? 0 : hypotheticalCost;
      return {
        model,
        provider,
        billingMode,
        subscription,
        input: bucket.input,
        output: bucket.output,
        cacheRead: bucket.cacheRead,
        cacheWrite: bucket.cacheWrite,
        requests: bucket.requests,
        reportedCost,
        estCost,
        // Explicit, never-conflated figures:
        marginalCost, // real $ — 0 for subscription
        hypotheticalCost, // "if billed per-token" projection
        // Backward-compatible display field (unchanged meaning):
        cost: hypotheticalCost,
      };
    })
    .sort((a, b) => b.hypotheticalCost - a.hypotheticalCost);
}

// Get detailed cost breakdown for the modal.
//
// Honesty contract — the returned object NEVER conflates these:
//   - marginal* fields  → REAL incremental dollars (per-token providers only;
//                          subscription providers contribute $0).
//   - hypothetical* fields → "if EVERYTHING were billed per-token" projection
//                          at TOKEN_RATES. This is the old (misleading)
//                          "monthlyProjected" number, now explicitly labeled.
//   - planCost / planName → the flat monthly subscription fee, a SEPARATE line.
// Token counts are always real regardless of billing mode.
function getCostBreakdown(config, getSessions, getOpenClawDir) {
  const usage = getDailyTokenUsage(getOpenClawDir);
  if (!usage) {
    return { error: "Failed to get usage data" };
  }

  const providerBillingModes = getProviderBillingModes(config);

  // Per-token line-item breakdown for 24h (the hypothetical math).
  const costs = calculateCostForBucket(usage);

  // Flat-fee subscription plans (Claude Code Max + Codex subscription by
  // default). Each is rendered as its own flat line; `planCost` is the SUM of
  // every plan's flat fee (preserves the old single-plan semantics where
  // actualMonthlySpend = planCost + marginal).
  const plans = getBillingPlans(config);
  const planCost = totalPlanCost(plans);
  // The summed "Flat plan cost" card covers EVERY configured plan, so a single
  // plan's label (the old "Claude Code Max") is misleading when the sum spans
  // Claude + Codex. Use a neutral descriptor: the plan provider names joined
  // (e.g. "Claude + Codex"), or the plan count when there are many. The
  // per-plan breakdown lines (`plans`) carry each plan's real label.
  const planName = describePlanSet(plans);

  // Calculate moving averages for each window
  const windowConfigs = {
    "24h": { days: 1, label: "24h" },
    "3d": { days: 3, label: "3dma" },
    "7d": { days: 7, label: "7dma" },
    "30d": { days: 30, label: "30dma" },
  };

  const windows = {};
  for (const [key, windowConfig] of Object.entries(windowConfigs)) {
    const bucket = usage.windows?.[key] || usage;
    const byModel = summarizeModelUsage(bucket.byModel, TOKEN_RATES, providerBillingModes);
    // Split totals by billing mode using the per-model provider map. When no
    // per-model data exists, fall back to the aggregate per-token math (the
    // honest worst case: treat it as per-token / hypothetical).
    const split = bucket.byModel
      ? aggregateModelCosts(bucket.byModel, TOKEN_RATES, providerBillingModes)
      : (() => {
          const c = calculateCostForBucket(bucket);
          return {
            marginalTotal: c.totalCost,
            hypotheticalTotal: c.totalCost,
            subscriptionTotal: 0,
          };
        })();

    // Per-plan flat-fee lines: each plan's flat cost spread across its usage,
    // ~$0 marginal, plus the per-plan hypothetical projection. Codex usage →
    // Codex plan, Claude usage → Claude plan.
    const planLines = aggregatePlanCosts(
      bucket.byModel || {},
      plans,
      TOKEN_RATES,
      providerBillingModes,
    ).map((line) => {
      const hypotheticalMonthly = (line.hypotheticalCost / windowConfig.days) * 30;
      const marginalMonthly = (line.marginalCost / windowConfig.days) * 30;
      // The flat plan covers this plan's usage; "actual" = flat fee + marginal.
      const actualMonthlySpend = line.planCost + marginalMonthly;
      const savings = hypotheticalMonthly - actualMonthlySpend;
      return {
        ...line,
        // `days` is the basis the monthly figures were extrapolated from, so the
        // UI can say "≈ $X/mo at the {window} burn rate". hypotheticalMonthly is
        // a RATE projection (cumulative / days * 30), not a cumulative total.
        days: windowConfig.days,
        hypotheticalMonthly,
        marginalMonthly,
        actualMonthlySpend,
        monthlySavings: savings > 0 ? savings : 0,
      };
    });

    const marginalDailyAvg = split.marginalTotal / windowConfig.days;
    const hypotheticalDailyAvg = split.hypotheticalTotal / windowConfig.days;

    // REAL marginal monthly spend (per-token providers only).
    const marginalMonthly = marginalDailyAvg * 30;
    // HYPOTHETICAL monthly if every provider were billed per-token.
    const hypotheticalMonthly = hypotheticalDailyAvg * 30;

    // Savings = what a fully-per-token bill WOULD have been, minus what we
    // actually pay (flat plan + any real marginal spend).
    const actualMonthlySpend = planCost + marginalMonthly;
    const monthlySavings = hypotheticalMonthly - actualMonthlySpend;

    windows[key] = {
      label: windowConfig.label,
      days: windowConfig.days,

      // REAL marginal spend (≈0 when everything is subscription-billed)
      marginalCost: split.marginalTotal,
      marginalDailyAvg,
      marginalMonthly,

      // HYPOTHETICAL "if billed per-token" projection (clearly labeled)
      hypotheticalCost: split.hypotheticalTotal,
      hypotheticalDailyAvg,
      hypotheticalMonthly,
      // Portion of the hypothetical attributable to subscription models
      // (i.e. the dollars NOT spent because of the flat plan).
      subscriptionCoveredCost: split.subscriptionTotal,

      // Flat plan + real marginal = what is actually paid this month.
      // planCost is the SUM of all plan fees; `plans` is the per-plan
      // breakdown (one flat-fee line per subscription).
      planCost,
      plans: planLines,
      actualMonthlySpend,
      monthlySavings,
      savingsPercent:
        monthlySavings > 0 && hypotheticalMonthly > 0
          ? Math.round((monthlySavings / hypotheticalMonthly) * 100)
          : 0,

      // ---- Backward-compatible aliases (deprecated; do NOT treat as real $)
      // `totalCost`/`monthlyProjected` historically meant the per-token
      // projection. Kept pointing at the hypothetical figures so old callers
      // don't break, but honest UIs should read marginal*/hypothetical*.
      totalCost: split.hypotheticalTotal,
      dailyAvg: hypotheticalDailyAvg,
      monthlyProjected: hypotheticalMonthly,

      requests: bucket.requests,
      tokens: {
        input: bucket.input,
        output: bucket.output,
        cacheRead: bucket.cacheRead,
        cacheWrite: bucket.cacheWrite,
      },
      byModel,
    };
  }

  const primary = windows["24h"];

  return {
    // Raw token counts (24h for backward compatibility) — always real
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    requests: usage.requests,

    // Pricing rates (per-token reference rates; apply to the hypothetical math)
    rates: {
      input: TOKEN_RATES.input.toFixed(2),
      output: TOKEN_RATES.output.toFixed(2),
      cacheRead: TOKEN_RATES.cacheRead.toFixed(2),
      cacheWrite: TOKEN_RATES.cacheWrite.toFixed(2),
    },

    // Per-token line-item breakdown (24h) — this is the HYPOTHETICAL math.
    // Labeled so a UI never presents it as money spent.
    calculation: {
      inputCost: costs.inputCost,
      outputCost: costs.outputCost,
      cacheReadCost: costs.cacheReadCost,
      cacheWriteCost: costs.cacheWriteCost,
      hypotheticalTotal: costs.hypotheticalTotal,
      note: "per-token projection — not money spent for subscription providers",
    },

    // ---- Honest top-level totals (24h) -------------------------------------
    // REAL marginal spend (per-token providers only; ≈0 for subscriptions)
    marginalCost: primary.marginalCost,
    marginalMonthly: primary.marginalMonthly,
    // HYPOTHETICAL "if billed per-token" projection (the old misleading number)
    hypotheticalCost: primary.hypotheticalCost,
    hypotheticalMonthly: primary.hypotheticalMonthly,
    // Flat subscription plan — a SEPARATE line, never summed into marginal.
    // planCost is the SUM across all plans; `plans` is the per-plan breakdown
    // (Claude + Codex by default), each its own flat-fee line with the same
    // margin model. planName is the first plan's label (backward compatible).
    planCost,
    planName,
    plans: primary.plans,
    // What is actually paid this month: flat plan + real marginal spend
    actualMonthlySpend: primary.actualMonthlySpend,

    // Billing-mode map echoed back so the UI can label each provider row
    providerBillingModes,

    // ---- Backward-compatible alias (deprecated) ----------------------------
    // Historically `totalCost` was the per-token projection. Preserved as the
    // hypothetical figure so existing callers don't break.
    totalCost: primary.hypotheticalCost,

    // Period
    period: "24 hours",

    // Multi-window data for moving averages
    windows,

    // Top sessions by tokens
    topSessions: getTopSessionsByTokens(5, getSessions),
  };
}

// Get top sessions sorted by token usage
function getTopSessionsByTokens(limit = 5, getSessions) {
  try {
    const sessions = getSessions({ limit: null });
    return sessions
      .filter((s) => s.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, limit)
      .map((s) => ({
        label: s.label,
        tokens: s.tokens,
        channel: s.channel,
        active: s.active,
      }));
  } catch (e) {
    console.error("[TopSessions] Error:", e.message);
    return [];
  }
}

// Calculate aggregate token stats
function getTokenStats(sessions, capacity, config = {}) {
  // Use capacity data if provided, otherwise compute from sessions
  let activeMainCount = capacity?.main?.active ?? 0;
  let activeSubagentCount = capacity?.subagent?.active ?? 0;
  let activeCount = activeMainCount + activeSubagentCount;
  let mainLimit = capacity?.main?.max ?? 12;
  let subagentLimit = capacity?.subagent?.max ?? 24;

  // Fallback: count from sessions if capacity not provided
  if (!capacity && sessions && sessions.length > 0) {
    activeCount = 0;
    activeMainCount = 0;
    activeSubagentCount = 0;
    sessions.forEach((s) => {
      if (s.active) {
        activeCount++;
        if (s.key && s.key.includes(":subagent:")) {
          activeSubagentCount++;
        } else {
          activeMainCount++;
        }
      }
    });
  }

  // Get accurate usage from JSONL files (includes all windows)
  const usage = getDailyTokenUsage();
  const totalInput = usage?.input || 0;
  const totalOutput = usage?.output || 0;
  const total = totalInput + totalOutput;

  const providerBillingModes = getProviderBillingModes(config);

  // Subscription-aware 24h split. `estCost` stays the HYPOTHETICAL per-token
  // figure (backward compatible) while `marginalCost` is the REAL spend.
  const split24h = usage?.byModel
    ? aggregateModelCosts(usage.byModel, TOKEN_RATES, providerBillingModes)
    : (() => {
        const c = calculateCostForBucket(usage);
        return { marginalTotal: c.totalCost, hypotheticalTotal: c.totalCost, subscriptionTotal: 0 };
      })();
  const estCost = split24h.hypotheticalTotal; // hypothetical per-token (legacy meaning)
  const marginalCost = split24h.marginalTotal; // real marginal $ (≈0 for subs)

  // Calculate savings vs plan cost (compare monthly to monthly). planCost is
  // the SUM of every flat-fee subscription plan (Claude + Codex by default).
  const plans = getBillingPlans(config);
  const planCost = totalPlanCost(plans);
  const planName = plans[0]?.label || DEFAULT_CLAUDE_PLAN_NAME;
  const monthlyApiCost = estCost * 30; // HYPOTHETICAL: project per-token daily → monthly
  const marginalMonthly = marginalCost * 30; // REAL marginal monthly spend
  const actualMonthlySpend = planCost + marginalMonthly;
  const monthlySavings = monthlyApiCost - actualMonthlySpend;
  const savingsPositive = monthlySavings > 0;

  // Calculate per-session averages
  const sessionCount = sessions?.length || 1;
  const avgTokensPerSession = Math.round(total / sessionCount);
  const avgCostPerSession = estCost / sessionCount;

  // Calculate savings for all windows (24h, 3dma, 7dma, 30dma)
  const windowConfigs = {
    "24h": { days: 1, label: "24h" },
    "3dma": { days: 3, label: "3dma" },
    "7dma": { days: 7, label: "7dma" },
    "30dma": { days: 30, label: "30dma" },
  };

  const savingsWindows = {};
  for (const [key, windowConfig] of Object.entries(windowConfigs)) {
    // Map '3dma' -> '3d' for bucket lookup
    const bucketKey = key.replace("dma", "d").replace("24h", "24h");
    const bucket = usage.windows?.[bucketKey === "24h" ? "24h" : bucketKey] || usage;
    const wSplit = bucket.byModel
      ? aggregateModelCosts(bucket.byModel, TOKEN_RATES, providerBillingModes)
      : (() => {
          const c = calculateCostForBucket(bucket);
          return {
            marginalTotal: c.totalCost,
            hypotheticalTotal: c.totalCost,
            subscriptionTotal: 0,
          };
        })();
    // dailyAvg/monthlyProjected remain the HYPOTHETICAL per-token figures for
    // backward compatibility; marginal* are the REAL spend.
    const dailyAvg = wSplit.hypotheticalTotal / windowConfig.days;
    const monthlyProjected = dailyAvg * 30;
    const marginalMonthlyW = (wSplit.marginalTotal / windowConfig.days) * 30;
    const windowActualSpend = planCost + marginalMonthlyW;
    const windowSavings = monthlyProjected - windowActualSpend;
    const windowSavingsPositive = windowSavings > 0;

    savingsWindows[key] = {
      label: windowConfig.label,
      // legacy fields = hypothetical per-token projection
      estCost: `$${formatNumber(dailyAvg)}`,
      estMonthlyCost: `$${Math.round(monthlyProjected).toLocaleString()}`,
      // explicit honest fields
      marginalMonthlyCost: `$${Math.round(marginalMonthlyW).toLocaleString()}`,
      hypotheticalMonthlyCost: `$${Math.round(monthlyProjected).toLocaleString()}`,
      estSavings: windowSavingsPositive ? `$${formatNumber(windowSavings)}/mo` : null,
      savingsPercent:
        windowSavingsPositive && monthlyProjected > 0
          ? Math.round((windowSavings / monthlyProjected) * 100)
          : 0,
      requests: bucket.requests,
    };
  }

  return {
    total: formatTokens(total),
    input: formatTokens(totalInput),
    output: formatTokens(totalOutput),
    cacheRead: formatTokens(usage?.cacheRead || 0),
    cacheWrite: formatTokens(usage?.cacheWrite || 0),
    requests: usage?.requests || 0,
    activeCount,
    activeMainCount,
    activeSubagentCount,
    mainLimit,
    subagentLimit,
    // estCost stays the hypothetical per-token daily figure (legacy meaning)
    estCost: `$${formatNumber(estCost)}`,
    // REAL marginal spend (≈$0 when everything is subscription-billed)
    marginalCost: `$${formatNumber(marginalCost)}`,
    marginalMonthlyCost: `$${Math.round(marginalMonthly).toLocaleString()}`,
    // The flat plan, a SEPARATE line; and the true monthly outlay
    planCost: `$${planCost.toFixed(0)}`,
    planName,
    actualMonthlyCost: `$${Math.round(actualMonthlySpend).toLocaleString()}`,
    // 24h savings (backward compatible)
    estSavings: savingsPositive ? `$${formatNumber(monthlySavings)}/mo` : null,
    savingsPercent:
      savingsPositive && monthlyApiCost > 0
        ? Math.round((monthlySavings / monthlyApiCost) * 100)
        : 0,
    // estMonthlyCost = hypothetical per-token monthly (the old "$513" number)
    estMonthlyCost: `$${Math.round(monthlyApiCost).toLocaleString()}`,
    hypotheticalMonthlyCost: `$${Math.round(monthlyApiCost).toLocaleString()}`,
    // Multi-window savings (24h, 3da, 7da)
    savingsWindows,
    // Per-session averages
    avgTokensPerSession: formatTokens(avgTokensPerSession),
    avgCostPerSession: `$${avgCostPerSession.toFixed(2)}`,
    sessionCount,
  };
}

// Start background token usage refresh on an interval
// Call this once during server startup instead of auto-starting on module load
function startTokenUsageRefresh(getOpenClawDir) {
  // Do an initial refresh
  refreshTokenUsageAsync(getOpenClawDir);

  // Set up periodic refresh
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
  refreshInterval = setInterval(() => {
    refreshTokenUsageAsync(getOpenClawDir);
  }, TOKEN_USAGE_CACHE_TTL);

  return refreshInterval;
}

module.exports = {
  TOKEN_RATES,
  PROVIDER_TOKEN_RATES,
  ratesForModel,
  describePlanSet,
  BILLING_SUBSCRIPTION,
  BILLING_PER_TOKEN,
  DEFAULT_BILLING_MODE,
  modelToProvider,
  resolveBillingMode,
  getProviderBillingModes,
  isSubscriptionModel,
  getBillingPlans,
  totalPlanCost,
  aggregatePlanCosts,
  emptyUsageBucket,
  addUsageToBucket,
  addUsageToModelMap,
  summarizeModelUsage,
  aggregateModelCosts,
  refreshTokenUsageAsync,
  getDailyTokenUsage,
  calculateCostForBucket,
  getCostBreakdown,
  getTopSessionsByTokens,
  getTokenStats,
  startTokenUsageRefresh,
};
