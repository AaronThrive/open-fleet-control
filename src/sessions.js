const fs = require("fs");
const path = require("path");
const { detectTopics } = require("./topics");

// Channel ID to name mapping (auto-populated from Slack)
const CHANNEL_MAP = {
  c0aax7y80np: "#cc-meta",
  c0ab9f8sdfe: "#cc-research",
  c0aan4rq7v5: "#cc-finance",
  c0abxulk1qq: "#cc-properties",
  c0ab5nz8mkl: "#cc-ai",
  c0aan38tzv5: "#cc-dev",
  c0ab7wwhqvc: "#cc-home",
  c0ab1pjhxef: "#cc-health",
  c0ab7txvcqd: "#cc-legal",
  c0aay2g3n3r: "#cc-social",
  c0aaxrw2wqp: "#cc-business",
  c0ab19f3lae: "#cc-random",
  c0ab0r74y33: "#cc-food",
  c0ab0qrq3r9: "#cc-travel",
  c0ab0sbqqlg: "#cc-family",
  c0ab0slqdba: "#cc-games",
  c0ab1ps7ef2: "#cc-music",
  c0absbnrsbe: "#cc-dashboard",
};

// Parse session key into readable label
function parseSessionLabel(key) {
  // Pattern: agent:main:slack:channel:CHANNEL_ID:thread:TIMESTAMP
  // or: agent:main:slack:channel:CHANNEL_ID
  // or: agent:main:main (telegram main)

  const parts = key.split(":");

  if (parts.includes("slack")) {
    const channelIdx = parts.indexOf("channel");
    if (channelIdx >= 0 && parts[channelIdx + 1]) {
      const channelId = parts[channelIdx + 1].toLowerCase();
      const channelName = CHANNEL_MAP[channelId] || `#${channelId}`;

      // Check if it's a thread
      if (parts.includes("thread")) {
        const threadTs = parts[parts.indexOf("thread") + 1];
        // Convert timestamp to rough time
        const ts = parseFloat(threadTs);
        const date = new Date(ts * 1000);
        const timeStr = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        return `${channelName} thread @ ${timeStr}`;
      }
      return channelName;
    }
  }

  if (key.includes("telegram")) {
    return "📱 Telegram";
  }

  if (key === "agent:main:main") {
    return "🏠 Main Session";
  }

  // Fallback: truncate key
  return key.length > 40 ? key.slice(0, 37) + "..." : key;
}

/**
 * Derive the CLI-compatible session `kind` from a store entry + key.
 * Matches the openclaw CLI classification (verified live: 46/46 parity):
 *   spawn-child — spawned sub-agent sessions
 *   cron        — cron-triggered sessions
 *   group       — group chats (slack threads/channels, telegram groups)
 *   direct      — everything else
 */
function deriveKind(key, entry = {}) {
  if (entry.spawnedBy || entry.subagentRole || key.includes(":subagent:")) return "spawn-child";
  if (key.includes(":cron:")) return "cron";
  if (entry.chatType === "group" || entry.groupId) return "group";
  return "direct";
}

/**
 * Create a sessions module with bound dependencies.
 * @param {Object} deps
 * @param {Function} deps.getOpenClawDir - Returns the OpenClaw directory path
 * @param {Function} deps.getOperatorBySlackId - Look up operator by Slack ID
 * @param {Function} deps.runOpenClaw - Run OpenClaw command synchronously (legacy, unused on request paths)
 * @param {Function} deps.runOpenClawAsync - Run OpenClaw command asynchronously
 * @param {Function} deps.extractJSON - Extract JSON from command output
 * @param {string} [deps.sessionsSource] - "files" (default) or "cli"
 * @param {number} [deps.refreshMs] - Background refresh interval (default 30000)
 * @param {boolean} [deps.enabled] - When false, never spawn CLI nor parse stores
 * @returns {Object} Session management functions
 */
function createSessionsModule(deps) {
  const { getOpenClawDir, getOperatorBySlackId, runOpenClawAsync, extractJSON } = deps;
  const sessionsSource = deps.sessionsSource === "cli" ? "cli" : "files";
  const refreshMs = Number.isFinite(deps.refreshMs) && deps.refreshMs > 0 ? deps.refreshMs : 30000;
  const enabled = deps.enabled !== false;

  // SESSION CACHE — refreshed by a single coalesced background worker.
  // ALL request paths serve this cache instantly (stale-while-revalidate).
  let sessionsCache = { sessions: [], raw: [], timestamp: 0 };
  let refreshInFlight = null;
  let refreshTimer = null;

  // Store-file parse cache (mtime/size based — re-parse only on change)
  let storeFileCache = { mtimeMs: 0, size: -1, entries: null };

  // Per-transcript memoization for originator/topic (keyed by sessionId,
  // invalidated when the transcript file's mtime changes).
  const originatorMemo = new Map();
  const topicMemo = new Map();
  const MEMO_MAX = 2000;

  /**
   * Find transcript file for a session ID.
   * Handles both plain (sessionId.jsonl) and topic-suffixed (sessionId-topic-XXX.jsonl) files.
   * @param {string} sessionId - Session UUID
   * @returns {string|null} - Full path to transcript file or null if not found
   */
  function findTranscriptPath(sessionId) {
    if (!sessionId) return null;

    const openclawDir = getOpenClawDir();
    const sessionsDir = path.join(openclawDir, "agents", "main", "sessions");

    // Try exact match first (most common case)
    const exactPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    if (fs.existsSync(exactPath)) return exactPath;

    // Search for topic-suffixed files (e.g., sessionId-topic-TIMESTAMP.jsonl)
    try {
      const files = fs.readdirSync(sessionsDir);
      const prefix = `${sessionId}-`;
      const match = files.find(
        (f) => f.startsWith(prefix) && f.endsWith(".jsonl") && !f.includes(".deleted."),
      );
      if (match) return path.join(sessionsDir, match);
    } catch (e) {
      // Directory read failed
    }

    return null;
  }

  /** Memo helper: get cached value if transcript unchanged, else recompute. */
  function memoized(memo, sessionId, transcriptPath, compute) {
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(transcriptPath).mtimeMs;
    } catch (e) {
      return compute();
    }
    const hit = memo.get(sessionId);
    if (hit && hit.mtimeMs === mtimeMs) return hit.value;
    const value = compute();
    if (memo.size >= MEMO_MAX) memo.clear();
    memo.set(sessionId, { mtimeMs, value });
    return value;
  }

  // Extract session originator from transcript
  function getSessionOriginator(sessionId) {
    try {
      if (!sessionId) return null;

      const transcriptPath = findTranscriptPath(sessionId);
      if (!transcriptPath) return null;

      return memoized(originatorMemo, sessionId, transcriptPath, () =>
        computeSessionOriginator(transcriptPath),
      );
    } catch (e) {
      return null;
    }
  }

  function computeSessionOriginator(transcriptPath) {
    try {
      // Only the first user message matters — read the head of the file
      // instead of the entire transcript (transcripts can be many MB).
      const fd = fs.openSync(transcriptPath, "r");
      const buffer = Buffer.alloc(131072);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      fs.closeSync(fd);
      if (bytesRead === 0) return null;

      const content = buffer.toString("utf8", 0, bytesRead);
      const lines = content.trim().split("\n");

      // Find the first user message to extract originator
      for (let i = 0; i < Math.min(lines.length, 10); i++) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type !== "message" || !entry.message) continue;

          const msg = entry.message;
          if (msg.role !== "user") continue;

          let text = "";
          if (typeof msg.content === "string") {
            text = msg.content;
          } else if (Array.isArray(msg.content)) {
            const textPart = msg.content.find((c) => c.type === "text");
            if (textPart) text = textPart.text || "";
          }

          if (!text) continue;

          // Extract Slack user from message patterns:
          // Format 1 (old): "[Slack #channel +6m 2026-01-27 15:31 PST] username (USERID): message"
          // Format 2 (new): Conversation info JSON with "sender_id": "USERID" and "sender": "username"
          const slackUserMatch = text.match(/\]\s*([\w.-]+)\s*\(([A-Z0-9]+)\):/);

          if (slackUserMatch) {
            const username = slackUserMatch[1];
            const userId = slackUserMatch[2];

            const operator = getOperatorBySlackId(userId);

            return {
              userId,
              username,
              displayName: operator?.name || username,
              role: operator?.role || "user",
              avatar: operator?.avatar || null,
            };
          }

          // Try new format: Conversation info JSON block
          // Look for "sender_id": "USERID" and "sender": "username"
          const senderIdMatch = text.match(/"sender_id":\s*"([A-Z0-9]+)"/);
          const senderMatch = text.match(/"sender":\s*"([^"]+)"/);

          if (senderIdMatch) {
            const userId = senderIdMatch[1];
            const username = senderMatch ? senderMatch[1] : userId;

            const operator = getOperatorBySlackId(userId);

            return {
              userId,
              username,
              displayName: operator?.name || username,
              role: operator?.role || "user",
              avatar: operator?.avatar || null,
            };
          }
        } catch (e) {}
      }

      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Get quick topic for a session by reading first portion of transcript
   * @param {string} sessionId - Session ID
   * @returns {string|null} - Primary topic or null
   */
  function getSessionTopic(sessionId) {
    if (!sessionId) return null;
    try {
      const transcriptPath = findTranscriptPath(sessionId);
      if (!transcriptPath) return null;
      return memoized(topicMemo, sessionId, transcriptPath, () =>
        computeSessionTopic(transcriptPath),
      );
    } catch (e) {
      return null;
    }
  }

  function computeSessionTopic(transcriptPath) {
    try {
      // Read first 50KB of transcript (enough for topic detection, fast)
      const fd = fs.openSync(transcriptPath, "r");
      const buffer = Buffer.alloc(50000);
      const bytesRead = fs.readSync(fd, buffer, 0, 50000, 0);
      fs.closeSync(fd);

      if (bytesRead === 0) return null;

      const content = buffer.toString("utf8", 0, bytesRead);
      const lines = content.split("\n").filter((l) => l.trim());

      // Extract text from messages
      // Transcript format: {type: "message", message: {role: "user"|"assistant", content: [...]}}
      let textSamples = [];
      for (const line of lines.slice(0, 30)) {
        // First 30 entries
        try {
          const entry = JSON.parse(line);
          if (entry.type === "message" && entry.message?.content) {
            const msgContent = entry.message.content;
            if (Array.isArray(msgContent)) {
              msgContent.forEach((c) => {
                if (c.type === "text" && c.text) {
                  textSamples.push(c.text.slice(0, 500));
                }
              });
            } else if (typeof msgContent === "string") {
              textSamples.push(msgContent.slice(0, 500));
            }
          }
        } catch (e) {
          /* skip malformed lines */
        }
      }

      if (textSamples.length === 0) return null;

      const topics = detectTopics(textSamples.join(" "));
      return topics.length > 0 ? topics.slice(0, 2).join(", ") : null;
    } catch (e) {
      return null;
    }
  }

  // Helper to map a single session (extracted from getSessions)
  function mapSession(s) {
    const minutesAgo = s.ageMs ? s.ageMs / 60000 : Infinity;

    // Determine channel type from key (messaging platform)
    let channel = "other";
    if (s.key.includes("slack")) channel = "slack";
    else if (s.key.includes("telegram")) channel = "telegram";
    else if (s.key.includes("discord")) channel = "discord";
    else if (s.key.includes("signal")) channel = "signal";
    else if (s.key.includes("whatsapp")) channel = "whatsapp";

    // Determine session type (main, subagent, cron, channel-based).
    // Prefer the CLI/store `kind` field — live keys are not guaranteed to
    // contain ":subagent:" (spawn-child kind is authoritative), so key
    // matching is only the fallback.
    let sessionType = "channel";
    if (s.kind === "spawn-child" || s.key.includes(":subagent:")) sessionType = "subagent";
    else if (s.kind === "cron" || s.key.includes(":cron:")) sessionType = "cron";
    else if (s.key === "agent:main:main" || s.key.startsWith("agent:main:main:"))
      sessionType = "main";

    const originator = getSessionOriginator(s.sessionId);
    const label = s.groupChannel || s.displayName || parseSessionLabel(s.key);
    const topic = getSessionTopic(s.sessionId);

    const totalTokens = s.totalTokens || 0;
    const sessionAgeMinutes = Math.max(1, Math.min(minutesAgo, 24 * 60));
    const burnRate = Math.round(totalTokens / sessionAgeMinutes);

    return {
      sessionKey: s.key,
      sessionId: s.sessionId,
      label: label,
      groupChannel: s.groupChannel || null,
      displayName: s.displayName || null,
      kind: s.kind,
      channel: channel,
      sessionType: sessionType,
      active: minutesAgo < 15,
      recentlyActive: minutesAgo < 60,
      minutesAgo: Math.round(minutesAgo),
      tokens: s.totalTokens || 0,
      model: s.model,
      originator: originator,
      topic: topic,
      metrics: {
        burnRate: burnRate,
        toolCalls: 0,
        minutesActive: Math.max(1, Math.min(Math.round(minutesAgo), 24 * 60)),
      },
    };
  }

  /** Path of the session store JSON the openclaw CLI reads ("files" source). */
  function getStorePath() {
    return path.join(getOpenClawDir(), "agents", "main", "sessions", "sessions.json");
  }

  /**
   * Default model/provider from openclaw.json (agents.defaults.model.primary,
   * e.g. "openai/gpt-5.5") — the CLI fills these in for store entries that
   * have no per-session model, so the files source does the same.
   */
  function getDefaultModel() {
    try {
      const configPath = path.join(getOpenClawDir(), "openclaw.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const primary = config?.agents?.defaults?.model?.primary;
      if (typeof primary === "string" && primary.length > 0) {
        const slash = primary.indexOf("/");
        return slash > 0
          ? { model: primary.slice(slash + 1), modelProvider: primary.slice(0, slash) }
          : { model: primary, modelProvider: undefined };
      }
    } catch (e) {
      // No config or unreadable — leave model fields unset
    }
    return { model: undefined, modelProvider: undefined };
  }

  /**
   * Read raw sessions directly from the OpenClaw session store file,
   * producing the same shape `openclaw sessions --json` emits. Re-parses
   * only when the store file's mtime/size changes.
   * @returns {Array<Object>} raw session entries (CLI shape), newest first
   */
  function listSessionsFromStore() {
    const storePath = getStorePath();
    let stat;
    try {
      stat = fs.statSync(storePath);
    } catch (e) {
      return [];
    }

    const now = Date.now();
    if (
      storeFileCache.entries &&
      storeFileCache.mtimeMs === stat.mtimeMs &&
      storeFileCache.size === stat.size
    ) {
      // Recompute ageMs against "now"; everything else is unchanged.
      return storeFileCache.entries.map((s) => ({ ...s, ageMs: now - (s.updatedAt || 0) }));
    }

    let store;
    try {
      store = JSON.parse(fs.readFileSync(storePath, "utf8"));
    } catch (e) {
      console.error("[Sessions Files] Store parse error:", e.message);
      return storeFileCache.entries
        ? storeFileCache.entries.map((s) => ({ ...s, ageMs: now - (s.updatedAt || 0) }))
        : [];
    }

    const defaults = getDefaultModel();
    const entries = Object.entries(store)
      .filter(([, v]) => v && typeof v === "object")
      .map(([key, v]) => ({
        key,
        sessionId: v.sessionId,
        updatedAt: v.updatedAt || 0,
        ageMs: now - (v.updatedAt || 0),
        totalTokens: v.totalTokens ?? (v.inputTokens || 0) + (v.outputTokens || 0),
        inputTokens: v.inputTokens,
        outputTokens: v.outputTokens,
        model: v.model || defaults.model,
        modelProvider: v.modelProvider || defaults.modelProvider,
        contextTokens: v.contextTokens,
        kind: deriveKind(key, v),
        displayName: v.displayName,
        groupChannel: v.groupChannel,
        label: v.label,
        agentId: "main",
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    storeFileCache = { mtimeMs: stat.mtimeMs, size: stat.size, entries };
    return entries;
  }

  /** Fetch raw sessions from the chosen source (worker context only). */
  async function fetchRawSessions() {
    if (sessionsSource === "files") {
      return listSessionsFromStore();
    }
    const output = await runOpenClawAsync("sessions --json 2>/dev/null");
    const jsonStr = extractJSON(output);
    if (!jsonStr) return null;
    return JSON.parse(jsonStr).sessions || [];
  }

  /**
   * Refresh the sessions cache. Coalesced: concurrent callers share one
   * in-flight refresh. Never throws.
   * @returns {Promise<void>}
   */
  function refreshSessionsCache() {
    if (!enabled) return Promise.resolve();
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
      try {
        const raw = await fetchRawSessions();
        if (raw) {
          const mapped = raw.map((s) => mapSession(s));
          sessionsCache = { sessions: mapped, raw, timestamp: Date.now() };
        }
      } catch (e) {
        console.error("[Sessions Cache] Refresh error:", e.message);
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }

  /** Age of the sessions cache in ms (Infinity when never refreshed). */
  function getCacheAgeMs() {
    return sessionsCache.timestamp ? Date.now() - sessionsCache.timestamp : Infinity;
  }

  // Get sessions from cache, trigger async refresh if stale
  function getSessionsCached() {
    if (enabled && getCacheAgeMs() > refreshMs) {
      // Trigger async refresh (don't await — return stale data immediately)
      refreshSessionsCache();
    }
    return sessionsCache.sessions;
  }

  /** Raw (CLI-shaped) sessions from the cache. */
  function getRawSessionsCached() {
    getSessionsCached();
    return sessionsCache.raw;
  }

  /**
   * List sessions. ALWAYS serves the background-refreshed cache — never
   * spawns the CLI nor parses stores on the request path.
   */
  function getSessions(options = {}) {
    const limit = Object.prototype.hasOwnProperty.call(options, "limit") ? options.limit : 20;
    const returnCount = options.returnCount || false;

    const cached = getSessionsCached();
    const totalCount = cached.length;
    const sessions = limit == null ? cached : cached.slice(0, limit);
    return returnCount ? { sessions, totalCount } : sessions;
  }

  /** Start the background refresh worker (idempotent). */
  function startSessionsRefresh() {
    if (!enabled || refreshTimer) return;
    refreshSessionsCache();
    refreshTimer = setInterval(() => refreshSessionsCache(), refreshMs);
    if (refreshTimer.unref) refreshTimer.unref();
    console.log(
      `[Sessions Cache] Background refresh started (source=${sessionsSource}, ${refreshMs}ms)`,
    );
  }

  /** Stop the background refresh worker. */
  function stopSessionsRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  /**
   * Resolve a session ID to its transcript path — but ONLY for IDs present
   * in the session store (the adapter's known session list). This is the
   * path-traversal-safe entry point for the transcript tail API: unknown or
   * malformed IDs resolve to null and never touch the filesystem layout.
   * @param {string} sessionId
   * @returns {Promise<string|null>}
   */
  async function resolveTranscriptForId(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) return null;
    // Defense in depth: store IDs are UUID-like; anything with path
    // separators or dots-as-segments is rejected before any fs access.
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
    if (sessionsCache.timestamp === 0) await refreshSessionsCache();
    const known = sessionsCache.raw.some((s) => s && s.sessionId === sessionId);
    if (!known) return null;
    return findTranscriptPath(sessionId);
  }

  // Read session transcript from JSONL file
  function readTranscript(sessionId) {
    const transcriptPath = findTranscriptPath(sessionId);

    try {
      if (!transcriptPath) return [];
      const content = fs.readFileSync(transcriptPath, "utf8");
      return content
        .trim()
        .split("\n")
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch (e) {
      console.error("Failed to read transcript:", e.message);
      return [];
    }
  }

  // Get detailed session info (served from the background-refreshed cache —
  // warms the cache first if it has never been populated).
  async function getSessionDetail(sessionKey) {
    try {
      if (sessionsCache.timestamp === 0) {
        await refreshSessionsCache();
      }
      const sessionInfo = sessionsCache.raw.find((s) => s.key === sessionKey);

      if (!sessionInfo) {
        return { error: "Session not found" };
      }

      // Read transcript directly from JSONL file
      const transcript = readTranscript(sessionInfo.sessionId);
      let messages = [];
      let tools = {};
      let facts = [];
      let needsAttention = [];

      // Aggregate token usage from transcript
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCacheRead = 0;
      let totalCacheWrite = 0;
      let totalCost = 0;
      let detectedModel = sessionInfo.model || null;

      // Process transcript entries (format: {type: "message", message: {role, content, usage}})
      transcript.forEach((entry) => {
        if (entry.type !== "message" || !entry.message) return;

        const msg = entry.message;
        if (!msg.role) return;

        // Extract token usage from messages (typically on assistant messages)
        if (msg.usage) {
          totalInputTokens += msg.usage.input || msg.usage.inputTokens || 0;
          totalOutputTokens += msg.usage.output || msg.usage.outputTokens || 0;
          totalCacheRead += msg.usage.cacheRead || msg.usage.cacheReadTokens || 0;
          totalCacheWrite += msg.usage.cacheWrite || msg.usage.cacheWriteTokens || 0;
          if (msg.usage.cost?.total) totalCost += msg.usage.cost.total;
        }

        // Detect model from assistant messages
        if (msg.role === "assistant" && msg.model && !detectedModel) {
          detectedModel = msg.model;
        }

        let text = "";
        if (typeof msg.content === "string") {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          const textPart = msg.content.find((c) => c.type === "text");
          if (textPart) text = textPart.text || "";

          // Count tool calls
          msg.content
            .filter((c) => c.type === "toolCall" || c.type === "tool_use")
            .forEach((tc) => {
              const name = tc.name || tc.tool || "unknown";
              tools[name] = (tools[name] || 0) + 1;
            });
        }

        if (text && msg.role !== "toolResult") {
          messages.push({ role: msg.role, text, timestamp: entry.timestamp });
        }

        // Extract insights from user messages
        if (msg.role === "user" && text) {
          const lowerText = text.toLowerCase();

          // Look for questions
          if (text.includes("?")) {
            const questions = text.match(/[^.!?\n]*\?/g) || [];
            questions.slice(0, 2).forEach((q) => {
              if (q.length > 15 && q.length < 200) {
                needsAttention.push(`❓ ${q.trim()}`);
              }
            });
          }

          // Look for action items
          if (
            lowerText.includes("todo") ||
            lowerText.includes("remind") ||
            lowerText.includes("need to")
          ) {
            const match = text.match(/(?:todo|remind|need to)[^.!?\n]*/i);
            if (match) needsAttention.push(`📋 ${match[0].slice(0, 100)}`);
          }
        }

        // Extract facts from assistant messages
        if (msg.role === "assistant" && text) {
          const lowerText = text.toLowerCase();

          // Look for completions
          ["✅", "done", "created", "updated", "fixed", "deployed"].forEach((keyword) => {
            if (lowerText.includes(keyword)) {
              const lines = text.split("\n").filter((l) => l.toLowerCase().includes(keyword));
              lines.slice(0, 2).forEach((line) => {
                if (line.length > 5 && line.length < 150) {
                  facts.push(line.trim().slice(0, 100));
                }
              });
            }
          });
        }
      });

      // Generate summary from recent messages
      let summary = "No activity yet.";
      const userMessages = messages.filter((m) => m.role === "user");
      const assistantMessages = messages.filter((m) => m.role === "assistant");
      let topics = [];

      if (messages.length > 0) {
        summary = `${messages.length} messages (${userMessages.length} user, ${assistantMessages.length} assistant). `;

        // Identify main topics from all text using pattern matching
        const allText = messages.map((m) => m.text).join(" ");
        topics = detectTopics(allText);

        if (topics.length > 0) {
          summary += `Topics: ${topics.join(", ")}.`;
        }
      }

      // Convert tools to array
      const toolsArray = Object.entries(tools)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

      // Calculate last active time
      const ageMs = sessionInfo.ageMs || 0;
      const lastActive =
        ageMs < 60000
          ? "Just now"
          : ageMs < 3600000
            ? `${Math.round(ageMs / 60000)} minutes ago`
            : ageMs < 86400000
              ? `${Math.round(ageMs / 3600000)} hours ago`
              : `${Math.round(ageMs / 86400000)} days ago`;

      // Determine readable channel name
      // Priority: groupChannel > displayName > parsed from key > fallback
      let channelDisplay = "Other";
      if (sessionInfo.groupChannel) {
        channelDisplay = sessionInfo.groupChannel;
      } else if (sessionInfo.displayName) {
        channelDisplay = sessionInfo.displayName;
      } else if (sessionKey.includes("slack")) {
        // Try to parse channel name from key
        const parts = sessionKey.split(":");
        const channelIdx = parts.indexOf("channel");
        if (channelIdx >= 0 && parts[channelIdx + 1]) {
          const channelId = parts[channelIdx + 1].toLowerCase();
          channelDisplay = CHANNEL_MAP[channelId] || `#${channelId}`;
        } else {
          channelDisplay = "Slack";
        }
      } else if (sessionKey.includes("telegram")) {
        channelDisplay = "Telegram";
      }

      // Use parsed totals or fallback to session info
      const finalTotalTokens = totalInputTokens + totalOutputTokens || sessionInfo.totalTokens || 0;
      const finalInputTokens = totalInputTokens || sessionInfo.inputTokens || 0;
      const finalOutputTokens = totalOutputTokens || sessionInfo.outputTokens || 0;

      // Format model name (strip prefix)
      const modelDisplay = (detectedModel || sessionInfo.model || "-")
        .replace("anthropic/", "")
        .replace("openai/", "");

      return {
        key: sessionKey,
        kind: sessionInfo.kind,
        channel: channelDisplay,
        groupChannel: sessionInfo.groupChannel || channelDisplay,
        model: modelDisplay,
        tokens: finalTotalTokens,
        inputTokens: finalInputTokens,
        outputTokens: finalOutputTokens,
        cacheRead: totalCacheRead,
        cacheWrite: totalCacheWrite,
        estCost: totalCost > 0 ? `$${totalCost.toFixed(4)}` : null,
        lastActive,
        summary,
        topics, // Array of detected topics
        facts: [...new Set(facts)].slice(0, 8),
        needsAttention: [...new Set(needsAttention)].slice(0, 5),
        tools: toolsArray.slice(0, 10),
        messages: messages
          .slice(-15)
          .reverse()
          .map((m) => ({
            role: m.role,
            text: m.text.slice(0, 500),
          })),
      };
    } catch (e) {
      console.error("Failed to get session detail:", e.message);
      return { error: e.message };
    }
  }

  return {
    findTranscriptPath,
    getSessionOriginator,
    getSessionTopic,
    mapSession,
    refreshSessionsCache,
    getSessionsCached,
    getRawSessionsCached,
    getSessions,
    getCacheAgeMs,
    listSessionsFromStore,
    startSessionsRefresh,
    stopSessionsRefresh,
    readTranscript,
    resolveTranscriptForId,
    getSessionDetail,
    parseSessionLabel,
  };
}

module.exports = { createSessionsModule, CHANNEL_MAP, deriveKind };
