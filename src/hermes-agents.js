/**
 * Hermes agents adapter for Open Fleet Control — READ-ONLY.
 *
 * Hermes (the NousResearch hermes-agent system) keeps its runtime data under
 * a single directory (default ~/.hermes):
 *   <hermesDir>/sessions/sessions.json — one JSON object keyed by session_key
 *     ("agent:<agentId>:<platform>:<chatType>:<chatId>:<threadId>"), values
 *     carry created_at/updated_at ISO timestamps and token/cost counters.
 *   <hermesDir>/config.yaml — model.default + model.provider at the top.
 *   <hermesDir>/workspace — the agent's working directory.
 *
 * Hermes is effectively single-agent: every observed session key names the
 * "main" agent (personalities are prompt skins, not separate agents). This
 * adapter still enumerates DISTINCT agent ids from the session keys so a
 * future multi-agent Hermes shows up automatically; when no sessions exist
 * at all it degrades to a single zeroed "hermes" entry.
 *
 * Output shape matches the OpenClaw roster entries produced by
 * src/agents-roster.js getLocalRoster() so the fleet aggregation can merge
 * both sources without translation:
 *   {id, name, model, workspace, subagentsMax, sessionCount, lastActiveAt,
 *    active, source: "hermes"}
 *
 * Every failure (missing dir, malformed JSON/YAML) degrades to the fallback
 * entry or null fields — never a throw.
 */

const fs = require("fs");
const path = require("path");

const ACTIVE_THRESHOLD_MS = 10 * 60 * 1000; // mirrors agents-roster.js

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Extract the agent id from a Hermes session key
 * ("agent:main:slack:dm:D123:171.5" → "main"). Unknown shapes → "hermes".
 *
 * @param {string} sessionKey
 * @returns {string}
 */
function agentIdFromSessionKey(sessionKey) {
  if (typeof sessionKey !== "string") return "hermes";
  const parts = sessionKey.split(":");
  if (parts[0] === "agent" && typeof parts[1] === "string" && parts[1].length > 0) {
    return parts[1];
  }
  return "hermes";
}

/** Parse an ISO timestamp (Hermes writes local-time, no offset) → ms or null. */
function parseTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Group a parsed sessions.json body into per-agent activity summaries.
 * Tolerates any malformed shape — always returns an object map.
 *
 * @param {object|null|undefined} sessionsBody - parsed sessions.json
 * @returns {Object<string, {sessionCount: number, lastActiveAt: number|null}>}
 */
function summarizeHermesSessions(sessionsBody) {
  const summaries = {};
  if (!sessionsBody || typeof sessionsBody !== "object" || Array.isArray(sessionsBody)) {
    return summaries;
  }
  for (const [key, session] of Object.entries(sessionsBody)) {
    const agentId = agentIdFromSessionKey(
      session && typeof session.session_key === "string" ? session.session_key : key,
    );
    const prev = summaries[agentId] || { sessionCount: 0, lastActiveAt: null };
    const updatedAt =
      parseTimestamp(session && session.updated_at) ??
      parseTimestamp(session && session.created_at);
    summaries[agentId] = {
      sessionCount: prev.sessionCount + 1,
      lastActiveAt:
        updatedAt !== null && (prev.lastActiveAt === null || updatedAt > prev.lastActiveAt)
          ? updatedAt
          : prev.lastActiveAt,
    };
  }
  return summaries;
}

/**
 * Extract "provider/default" from the top-level `model:` block of Hermes's
 * config.yaml without a YAML dependency. Returns null when absent.
 *
 * @param {string|null|undefined} yamlText
 * @returns {string|null}
 */
function parseHermesModel(yamlText) {
  if (typeof yamlText !== "string") return null;
  const lines = yamlText.split("\n");
  const start = lines.findIndex((line) => /^model:\s*$/.test(line));
  if (start === -1) return null;

  let model = null;
  let provider = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s/.test(line)) break; // end of the indented block
    const match = line.match(/^\s+(default|provider):\s*(.+?)\s*$/);
    if (!match) continue;
    const value = match[2].replace(/^['"]|['"]$/g, "");
    if (match[1] === "default") model = value || null;
    else provider = value || null;
  }
  if (!model) return null;
  return provider ? `${provider}/${model}` : model;
}

// ---------------------------------------------------------------------------
// Module factory
// ---------------------------------------------------------------------------

/**
 * Create the Hermes agents adapter.
 *
 * @param {object} options
 * @param {string} options.hermesDir - Hermes data directory (e.g. ~/.hermes)
 * @param {function} [options.nowFn] - clock (default Date.now)
 * @returns {{listAgents: function(): Array}}
 */
function createHermesAgents(options = {}) {
  const { hermesDir, nowFn = Date.now } = options;
  if (!hermesDir || typeof hermesDir !== "string") {
    throw new Error("createHermesAgents requires a hermesDir string");
  }

  /** Read + parse sessions.json. Missing/malformed → {}. */
  function readSessions() {
    const sessionsPath = path.join(hermesDir, "sessions", "sessions.json");
    let raw;
    try {
      raw = fs.readFileSync(sessionsPath, "utf8");
    } catch (err) {
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      console.error(`[HermesAgents] Malformed sessions.json at ${sessionsPath}:`, err.message);
      return {};
    }
  }

  /** Best-effort model string from config.yaml. */
  function readModel() {
    try {
      return parseHermesModel(fs.readFileSync(path.join(hermesDir, "config.yaml"), "utf8"));
    } catch (err) {
      return null;
    }
  }

  /** Workspace path when it exists on disk, else null. */
  function readWorkspace() {
    const workspace = path.join(hermesDir, "workspace");
    try {
      return fs.statSync(workspace).isDirectory() ? workspace : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Enumerate Hermes agents with session activity. Always returns at least
   * one entry (the zeroed "hermes" fallback) so the instance is visible in
   * the fleet roster even before its first session.
   */
  function listAgents() {
    const now = nowFn();
    const model = readModel();
    const workspace = readWorkspace();
    const summaries = summarizeHermesSessions(readSessions());

    const ids = Object.keys(summaries);
    if (ids.length === 0) {
      return [
        {
          id: "hermes",
          name: "Hermes",
          model,
          workspace,
          subagentsMax: null,
          sessionCount: 0,
          lastActiveAt: null,
          active: false,
          source: "hermes",
        },
      ];
    }

    return ids.sort().map((id) => {
      const { sessionCount, lastActiveAt } = summaries[id];
      return {
        id,
        name: id === "main" || id === "hermes" ? "Hermes" : `Hermes ${id}`,
        model,
        workspace,
        subagentsMax: null,
        sessionCount,
        lastActiveAt,
        active: lastActiveAt !== null && now - lastActiveAt < ACTIVE_THRESHOLD_MS,
        source: "hermes",
      };
    });
  }

  return { listAgents };
}

module.exports = {
  createHermesAgents,
  summarizeHermesSessions,
  agentIdFromSessionKey,
  parseHermesModel,
  ACTIVE_THRESHOLD_MS,
};
