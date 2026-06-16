/**
 * Quick actions — the home-page Quick Actions buttons and the bulk runner
 * both execute through here (GET /api/action?action=<name>).
 *
 * v2.2 fix: "Clean Stale Sessions" used to only COUNT stale sessions and
 * print a suggestion to run `openclaw sessions prune` — a command that does
 * not exist (the real maintenance command is `openclaw sessions cleanup`).
 * On top of that the UI sends action=prune-stale, which was never in the
 * allowlist, so the button always came back "Unknown action". Both are
 * fixed: prune-stale is an accepted alias and the action now actually runs
 * `openclaw sessions cleanup --enforce --json` and reports what it removed.
 *
 * All CLI work goes through the injected async runner (deps.runOpenClawAsync,
 * 20s timeout) so slow maintenance runs cannot trip the 3s sync timeout that
 * silently nulled results before. Every result follows
 * { success, action, output, error } — `output` is a short human summary the
 * existing toast renderer shows verbatim; `detail` carries structured data.
 */

const ALLOWED_ACTIONS = new Set([
  "gateway-status",
  "gateway-restart",
  "sessions-list",
  "cron-list",
  "health-check",
  "clear-stale-sessions",
  "agent-run", // node→node remote dispatch: run a local agent turn, return the parsed result
]);

// Front-end / legacy names → canonical action names.
const ACTION_ALIASES = {
  "prune-stale": "clear-stale-sessions",
  "clean-stale-sessions": "clear-stale-sessions",
};

const DEFAULT_STALE_MINUTES = 24 * 60;
const MIN_STALE_MINUTES = 5;
const MAX_STALE_MINUTES = 30 * 24 * 60;

// agent-run boundary validation (input arrives over the tailnet — fail closed).
const AGENT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SESSION_KEY_PATTERN = /^[a-zA-Z0-9:_.-]{1,200}$/;
const AGENT_RUN_MAX_TIMEOUT_SEC = 1800;
const AGENT_RUN_DEFAULT_TIMEOUT_SEC = 600;
const AGENT_RUN_MESSAGE_MAX = 64 * 1024;
const AGENT_RUN_SNIPPET_MAX = 300;

/** Clamp a requested agent-run timeout (seconds) into a sane range. */
function clampAgentTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return AGENT_RUN_DEFAULT_TIMEOUT_SEC;
  return Math.min(AGENT_RUN_MAX_TIMEOUT_SEC, Math.max(30, Math.round(n)));
}

/** Collapse whitespace and cap text for a one-line summary. */
function snippetOneLine(text) {
  const collapsed = String(text).replace(/\s+/g, " ").trim();
  if (collapsed.length <= AGENT_RUN_SNIPPET_MAX) return collapsed;
  return `${collapsed.slice(0, AGENT_RUN_SNIPPET_MAX)}…`;
}

/** Resolve an incoming action name to its canonical allowlisted form. */
function normalizeAction(action) {
  const name = typeof action === "string" ? action.trim() : "";
  return ACTION_ALIASES[name] || name;
}

/** Clamp a requested staleness window (minutes) into a sane range. */
function clampStaleMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_STALE_MINUTES;
  return Math.min(MAX_STALE_MINUTES, Math.max(MIN_STALE_MINUTES, Math.round(n)));
}

/**
 * Parse the multi-line `openclaw gateway status` dump into a compact
 * summary. The "Runtime:" line reports the systemd unit (often "stopped"
 * even when the gateway answers), so reachability keys on the connectivity
 * probe, with the listening line as a fallback signal.
 */
function parseGatewayStatus(raw) {
  const text = String(raw || "");
  const probeOk = /Connectivity probe:\s*ok/i.test(text);
  const listening = /Listening:\s*\S/i.test(text);
  const runtimeMatch = text.match(/Runtime:\s*([^\n(]+)/i);
  const portMatch = text.match(/port=(\d+)/i);
  const versionMatch = text.match(/Gateway version:\s*([^\s\n]+)/i);
  return {
    reachable: probeOk || listening,
    probeOk,
    runtime: runtimeMatch ? runtimeMatch[1].trim() : null,
    port: portMatch ? parseInt(portMatch[1], 10) : null,
    version: versionMatch ? versionMatch[1] : null,
  };
}

/** One-line human summary of a parsed gateway status. */
function summarizeGateway(gw) {
  const bits = [gw.reachable ? "reachable" : "NOT reachable"];
  if (gw.port) bits.push(`port ${gw.port}`);
  if (gw.version) bits.push(`v${gw.version}`);
  if (gw.runtime && !gw.reachable) bits.push(`runtime ${gw.runtime}`);
  return `Gateway ${bits.join(", ")}`;
}

/** Parse `openclaw sessions cleanup --json` output into a summary. */
function parseCleanupResult(raw, extractJSON) {
  const jsonStr = extractJSON ? extractJSON(raw) : raw;
  if (!jsonStr) return null;
  try {
    const data = JSON.parse(jsonStr);
    if (!data || typeof data !== "object") return null;
    return data;
  } catch (e) {
    return null;
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const MB = 1024 * 1024;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * Count sessions older than the staleness window from the injected raw
 * sessions list (the cached store-backed sessions backend). Returns null
 * when no provider is wired — the summary then simply omits the count.
 */
function countStaleSessions(getRawSessions, staleMinutes) {
  if (typeof getRawSessions !== "function") return null;
  try {
    const raw = getRawSessions();
    if (!Array.isArray(raw)) return null;
    const cutoffMs = staleMinutes * 60 * 1000;
    return raw.filter((s) => s && Number.isFinite(s.ageMs) && s.ageMs > cutoffMs).length;
  } catch (e) {
    return null;
  }
}

/** Total known sessions from the injected provider, or null. */
function countSessions(getRawSessions) {
  if (typeof getRawSessions !== "function") return null;
  try {
    const raw = getRawSessions();
    return Array.isArray(raw) ? raw.length : null;
  } catch (e) {
    return null;
  }
}

/**
 * Execute a quick action.
 *
 * @param {string} action - action name (aliases accepted, see ACTION_ALIASES)
 * @param {object} deps
 * @param {function} deps.runOpenClawAsync - async (args) => stdout|null
 * @param {function} deps.extractJSON - (output) => json string|null
 * @param {number} deps.PORT - dashboard port (health summary)
 * @param {function} [deps.getRawSessions] - () => raw session entries (ageMs)
 * @param {function} [deps.runAgent] - async (argv[], {timeoutMs}) => stdout|null;
 *   long-timeout openclaw agent runner used by the agent-run verb (an agent
 *   turn needs minutes, not the 20s runOpenClawAsync budget)
 * @param {object} [opts]
 * @param {number} [opts.staleMinutes] - staleness window for clear-stale-sessions
 * @returns {Promise<{success: boolean, action: string, output: string, error: string|null, detail?: object}>}
 */
async function executeAction(action, deps, opts = {}) {
  const { runOpenClawAsync, extractJSON, PORT, getRawSessions } = deps;
  const canonical = normalizeAction(action);
  const results = { success: false, action: canonical, output: "", error: null };

  if (!ALLOWED_ACTIONS.has(canonical)) {
    results.action = typeof action === "string" ? action : String(action);
    results.error = `Unknown action: ${results.action}`;
    return results;
  }
  // agent-run uses its own long-timeout runner (deps.runAgent), validated in
  // the case body; every other action goes through the 20s runOpenClawAsync.
  if (canonical !== "agent-run" && typeof runOpenClawAsync !== "function") {
    results.error = "OpenClaw runner unavailable";
    return results;
  }

  try {
    switch (canonical) {
      case "gateway-status": {
        const raw = await runOpenClawAsync("gateway status");
        if (raw === null || raw === undefined) {
          results.error = "openclaw gateway status failed or timed out";
          break;
        }
        const gw = parseGatewayStatus(raw);
        results.output = summarizeGateway(gw);
        results.detail = { ...gw, raw: String(raw).trim() };
        results.success = true;
        break;
      }
      case "gateway-restart":
        results.output = "To restart gateway, run: openclaw gateway restart";
        results.note = "Dashboard cannot restart gateway for safety";
        results.success = true;
        break;
      case "sessions-list": {
        const raw = await runOpenClawAsync("sessions");
        results.output = raw || "No sessions";
        results.success = raw !== null && raw !== undefined;
        if (!results.success) results.error = "openclaw sessions failed or timed out";
        break;
      }
      case "cron-list": {
        const raw = await runOpenClawAsync("cron list");
        results.output = raw || "No cron jobs";
        results.success = raw !== null && raw !== undefined;
        if (!results.success) results.error = "openclaw cron list failed or timed out";
        break;
      }
      case "health-check": {
        const raw = await runOpenClawAsync("gateway status");
        const gw = parseGatewayStatus(raw || "");
        const sessionCount = countSessions(getRawSessions);
        results.output = [
          gw.reachable ? "Gateway: OK reachable" : "Gateway: NOT reachable",
          `Sessions: ${sessionCount !== null ? sessionCount : "unknown"}`,
          `Dashboard: OK running on port ${PORT}`,
        ].join("\n");
        results.detail = { gateway: gw, sessionCount };
        // success mirrors actual health so the toast says pass/fail honestly.
        results.success = gw.reachable;
        if (!gw.reachable) {
          results.error = raw
            ? "Gateway connectivity probe failed"
            : "openclaw gateway status failed or timed out";
        }
        break;
      }
      case "clear-stale-sessions": {
        const staleMinutes = clampStaleMinutes(opts.staleMinutes);
        const staleCount = countStaleSessions(getRawSessions, staleMinutes);
        const raw = await runOpenClawAsync("sessions cleanup --enforce --json");
        const data = parseCleanupResult(raw, extractJSON);
        if (!data) {
          results.error = "openclaw sessions cleanup failed or timed out";
          break;
        }
        const pruned = Number.isFinite(data.pruned) ? data.pruned : 0;
        const capped = Number.isFinite(data.capped) ? data.capped : 0;
        const missing = Number.isFinite(data.missing) ? data.missing : 0;
        const artifacts =
          data.unreferencedArtifacts && typeof data.unreferencedArtifacts === "object"
            ? data.unreferencedArtifacts
            : {};
        const removedFiles = Number.isFinite(artifacts.removedFiles) ? artifacts.removedFiles : 0;
        const freedBytes = Number.isFinite(artifacts.freedBytes) ? artifacts.freedBytes : 0;
        const parts = [`Cleanup done: ${pruned + capped + missing} session entries removed`];
        if (Number.isFinite(data.beforeCount) && Number.isFinite(data.afterCount)) {
          parts.push(`store ${data.beforeCount} → ${data.afterCount}`);
        }
        if (removedFiles > 0) {
          parts.push(`${removedFiles} unreferenced files removed (${formatBytes(freedBytes)})`);
        }
        if (staleCount !== null) {
          parts.push(`${staleCount} sessions idle >${Math.round(staleMinutes / 60)}h`);
        }
        results.output = parts.join(" · ");
        results.detail = {
          staleMinutes,
          staleCount,
          pruned,
          capped,
          missing,
          removedFiles,
          freedBytes,
          beforeCount: Number.isFinite(data.beforeCount) ? data.beforeCount : null,
          afterCount: Number.isFinite(data.afterCount) ? data.afterCount : null,
        };
        results.success = true;
        break;
      }
      case "agent-run": {
        // opts: { agent, message, sessionKey, timeoutSec }. This is the server
        // side of remote dispatch — a remote OFC POSTs here to make THIS node
        // run the agent locally and return the parsed result.
        const agent = typeof opts.agent === "string" ? opts.agent.trim() : "";
        const message = typeof opts.message === "string" ? opts.message : "";
        const sessionKey = typeof opts.sessionKey === "string" ? opts.sessionKey.trim() : "";
        const timeoutSec = clampAgentTimeout(opts.timeoutSec);

        // Validate at the boundary (untrusted: arrives over the tailnet).
        if (!AGENT_ID_PATTERN.test(agent)) {
          results.error = "Invalid agent id";
          break;
        }
        if (sessionKey && !SESSION_KEY_PATTERN.test(sessionKey)) {
          results.error = "Invalid sessionKey";
          break;
        }
        if (message.length === 0 || message.length > AGENT_RUN_MESSAGE_MAX) {
          results.error = "message must be 1..64KB";
          break;
        }
        if (typeof deps.runAgent !== "function") {
          results.error = "Agent runner unavailable on this node";
          break;
        }

        // argv as a no-shell array — injection-safe even though validated.
        const args = [
          "agent",
          "--agent",
          agent,
          ...(sessionKey ? ["--session-key", sessionKey] : []),
          "--message",
          message,
          "--json",
          "--timeout",
          String(timeoutSec),
        ];
        const stdout = await deps.runAgent(args, { timeoutMs: timeoutSec * 1000 + 5000 });
        if (stdout === null || stdout === undefined) {
          results.error = "openclaw agent failed or timed out";
          break;
        }
        // Reuse the dispatch parser so local & remote yield identical fields.
        const parsed = require("./dispatch").parseRunResult(stdout);
        results.output = parsed.outputText
          ? snippetOneLine(parsed.outputText)
          : "agent run complete";
        results.detail = {
          sessionId: parsed.sessionId,
          outputText: parsed.outputText, // FULL text — the caller stores result_text
          cliError: parsed.error, // CLI-reported error inside a clean exit
        };
        // success here means "the CLI ran"; a CLI-reported error is surfaced
        // via detail.cliError and re-mapped to failure by the CALLER so local
        // and remote success/failure semantics line up.
        results.success = parsed.error ? false : true;
        if (parsed.error) results.error = parsed.error;
        break;
      }
    }
  } catch (e) {
    results.error = e.message;
    results.success = false;
  }

  return results;
}

module.exports = {
  executeAction,
  normalizeAction,
  parseGatewayStatus,
  clampAgentTimeout,
  snippetOneLine,
  ALLOWED_ACTIONS,
  ACTION_ALIASES,
  DEFAULT_STALE_MINUTES,
  AGENT_ID_PATTERN,
  SESSION_KEY_PATTERN,
  AGENT_RUN_MAX_TIMEOUT_SEC,
  AGENT_RUN_DEFAULT_TIMEOUT_SEC,
};
