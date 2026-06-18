/**
 * Mesh networking backend for Open Fleet Control.
 *
 * Maintains a registry of fleet nodes (persisted atomically to
 * state/mesh-nodes.json), polls each registered node's health endpoint over
 * the tailnet, tracks latency history for sparklines, and collects
 * best-effort cost rollups and host vitals (cpu / memory / disk / uptime)
 * from remote command-center /api/state endpoints.
 *
 * Node URLs are composed at runtime from the MagicDNS suffix reported by the
 * tailscale adapter — no tailnet name is ever hardcoded, and no tokens are
 * stored in this module.
 */

const path = require("path");
const crypto = require("crypto");
const { createTailscaleAdapter } = require("./tailscale");
const { createSafeStore } = require("./state-safety");

const REGISTRY_FILENAME = "mesh-nodes.json";
const REGISTRY_BACKUP_DIRNAME = "mesh-nodes-backups";
const DEFAULT_INTERVAL_MS = 15000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5000;
const LATENCY_SAMPLE_LIMIT = 60; // ring buffer size for sparklines
// /api/state piggyback cadence: refresh remote vitals + costs every Nth health
// poll (N=4 at the default 15s interval => roughly once per minute) instead of
// the old once-only version probe, without adding any extra request types.
const STATE_REFRESH_EVERY_N_POLLS = 4;
const VALID_PLATFORMS = ["linux", "windows-wsl", "macos", "unknown"];
const HOSTNAME_PATTERN = /^[a-z0-9-]+$/;
const MAX_LABEL_LENGTH = 120;
const DEFAULT_NODE_PORT = 443;

/**
 * Effective port of a node record, for identity comparisons.
 * Registries written before the instance-identity fix may carry records
 * without a port field (or with a malformed one) — those are treated as the
 * https default (443), which is exactly what validateNodeInput() would have
 * assigned them at registration time. This keeps old records matching/merging
 * sanely against new registrations.
 *
 * @param {object|null} record - node-like record ({hostname, port?})
 * @returns {number}
 */
function instancePort(record) {
  const port = record ? record.port : undefined;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_NODE_PORT;
}

/**
 * Stable instance identity key: "<hostname>:<port>". Two dashboards on the
 * same host (e.g. oc-bot-1:3333 and hermes economy on :3334) get distinct
 * keys, while a legacy record without a port keys identically to a fresh
 * default-port registration.
 *
 * @param {object} record - node-like record ({hostname, port?})
 * @returns {string}
 */
function nodeInstanceKey(record) {
  return `${record.hostname}:${instancePort(record)}`;
}

/**
 * Migration-safe instance comparison: same hostname AND same effective port
 * (missing/malformed ports default to 443 on either side).
 *
 * @param {object|null} a
 * @param {object|null} b
 * @returns {boolean}
 */
function isSameInstance(a, b) {
  if (!a || typeof a !== "object" || !b || typeof b !== "object") return false;
  return a.hostname === b.hostname && instancePort(a) === instancePort(b);
}

/**
 * Compose a node URL at runtime: https://<hostname>.<magicDnsSuffix>[:port]<path>
 * The port is omitted when it is 443 (https default).
 *
 * @param {object} node - node record ({hostname, port, protocol, healthPath})
 * @param {string} magicDnsSuffix - suffix from tailscale ("" for bare hostname)
 * @param {string} [pathOverride] - path to use instead of node.healthPath
 * @returns {string}
 */
function composeNodeUrl(node, magicDnsSuffix, pathOverride) {
  const host = magicDnsSuffix ? `${node.hostname}.${magicDnsSuffix}` : node.hostname;
  const portPart = node.port === 443 ? "" : `:${node.port}`;
  const urlPath = pathOverride !== undefined ? pathOverride : node.healthPath;
  return `${node.protocol}://${host}${portPart}${urlPath}`;
}

/**
 * Validate raw registerNode() input and return a normalized node shape
 * (without id / registeredAt — those are added by registerNode).
 * Throws an Error with a clear message on any invalid field.
 *
 * @param {object} input
 * @returns {{hostname: string, port: number, protocol: "https", healthPath: string, platform: string, label: string, registeredBy: string}}
 */
function validateNodeInput(input) {
  if (!input || typeof input !== "object") {
    throw new Error("registerNode requires an options object");
  }

  const { hostname, port = 443, healthPath = "/health", platform = "unknown" } = input;

  if (typeof hostname !== "string" || !HOSTNAME_PATTERN.test(hostname)) {
    throw new Error(
      `Invalid hostname: must be lowercase letters, digits, and hyphens only (got ${JSON.stringify(hostname)})`,
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: must be an integer between 1 and 65535 (got ${port})`);
  }
  if (typeof healthPath !== "string" || !healthPath.startsWith("/")) {
    throw new Error(`Invalid healthPath: must be a string starting with "/" (got ${healthPath})`);
  }
  if (!VALID_PLATFORMS.includes(platform)) {
    throw new Error(
      `Invalid platform: must be one of ${VALID_PLATFORMS.join(", ")} (got ${platform})`,
    );
  }
  if (input.label !== undefined && typeof input.label !== "string") {
    throw new Error("Invalid label: must be a string");
  }
  if (input.label && input.label.length > MAX_LABEL_LENGTH) {
    throw new Error(`Invalid label: must be at most ${MAX_LABEL_LENGTH} characters`);
  }
  if (input.registeredBy !== undefined && typeof input.registeredBy !== "string") {
    throw new Error("Invalid registeredBy: must be a string");
  }

  return {
    hostname,
    port,
    protocol: "https",
    healthPath,
    platform,
    label: input.label || hostname,
    registeredBy: input.registeredBy || "unknown",
  };
}

/**
 * First finite number among the candidates, or null.
 */
function pickNumber(...candidates) {
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Validate a mesh-registry state object (nodes wrapper).
 * Enforces `{nodes: Array}` shape and checks that each entry is an object
 * with at least `id` and `hostname` strings — the minimum identity fields
 * required to distinguish nodes across reboots and migrations.
 *
 * Less-than-full records (missing port / registeredAt / etc.) are accepted
 * so that legacy registries written before individual fields were added
 * remain readable and survive the backup/restore cycle without corruption.
 * Missing fields receive their defaults at access time (e.g. instancePort()
 * defaults a missing port to 443).
 *
 * @param {object} obj
 * @returns {{ valid: boolean, errors: Array<{path: string, reason: string}> }}
 */
function validateRegistry(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return {
      valid: false,
      errors: [{ path: "", reason: "registry must be a non-array object" }],
    };
  }
  if (!Array.isArray(obj.nodes)) {
    return {
      valid: false,
      errors: [{ path: "nodes", reason: "nodes must be an array" }],
    };
  }
  const errors = [];
  for (let i = 0; i < obj.nodes.length; i++) {
    const n = obj.nodes[i];
    if (!n || typeof n !== "object") {
      errors.push({ path: `nodes[${i}]`, reason: "must be an object" });
      continue;
    }
    // Minimum identity fields: id + hostname. All other fields are optional
    // so that legacy/partial records survive the safe-store backup cycle.
    if (typeof n.id !== "string" || n.id.length === 0) {
      errors.push({ path: `nodes[${i}].id`, reason: "id must be a non-empty string" });
    }
    if (typeof n.hostname !== "string" || n.hostname.length === 0) {
      errors.push({ path: `nodes[${i}].hostname`, reason: "hostname must be a non-empty string" });
    }
  }
  return errors.length > 0 ? { valid: false, errors } : { valid: true, errors: [] };
}

/**
 * Best-effort extraction of llm-usage / cost totals from a remote
 * command-center /api/state payload. Tolerates any shape mismatch (nulls).
 *
 * @param {object|null} state - remote /api/state response body
 * @returns {{cost24h: number|null, cost7d: number|null, totalTokens: number|null, version: string|null}|null}
 */
function extractNodeCosts(state) {
  if (!state || typeof state !== "object") return null;
  const llmUsage = state.llmUsage && typeof state.llmUsage === "object" ? state.llmUsage : {};
  const tokenStats =
    state.tokenStats && typeof state.tokenStats === "object" ? state.tokenStats : {};
  return {
    cost24h: pickNumber(llmUsage.usage24h?.cost, llmUsage.cost24h, tokenStats.cost24h),
    cost7d: pickNumber(llmUsage.usage7d?.cost, llmUsage.cost7d, tokenStats.cost7d),
    totalTokens: pickNumber(tokenStats.totalTokens, tokenStats.total, llmUsage.totalTokens),
    version: typeof state.version === "string" ? state.version : null,
  };
}

/**
 * Best-effort extraction of host vitals from a remote command-center
 * /api/state payload. Mirrors this dashboard's own top-level `vitals` block
 * (hostname, uptime, cpu, memory, disk, temperature) — remote nodes run the
 * same software, but older versions may omit the block entirely and any
 * field may be missing or malformed, so every leaf degrades to null.
 *
 * @param {object|null} state - remote /api/state response body
 * @returns {{
 *   hostname: string|null,
 *   uptime: string|number|null,
 *   cpu: {load: number|null, percent: number|null, cores: number|null},
 *   memory: {used: number|null, total: number|null, pct: number|null},
 *   disk: {used: number|null, free: number|null, total: number|null, pct: number|null},
 *   temperature: number|null
 * }|null} null when the payload has no usable vitals block
 */
function extractNodeVitals(state) {
  if (!state || typeof state !== "object") return null;
  const vitals = state.vitals;
  if (!vitals || typeof vitals !== "object") return null;

  const cpu = vitals.cpu && typeof vitals.cpu === "object" ? vitals.cpu : {};
  const memory = vitals.memory && typeof vitals.memory === "object" ? vitals.memory : {};
  const disk = vitals.disk && typeof vitals.disk === "object" ? vitals.disk : {};
  const load = Array.isArray(cpu.loadAvg) ? pickNumber(cpu.loadAvg[0]) : pickNumber(cpu.load);
  const uptimeOk =
    typeof vitals.uptime === "string" ||
    (typeof vitals.uptime === "number" && Number.isFinite(vitals.uptime));

  return {
    hostname: typeof vitals.hostname === "string" ? vitals.hostname : null,
    uptime: uptimeOk ? vitals.uptime : null,
    cpu: {
      load,
      percent: pickNumber(cpu.usage, cpu.percent, cpu.pct),
      cores: pickNumber(cpu.cores),
    },
    memory: {
      used: pickNumber(memory.used),
      total: pickNumber(memory.total),
      pct: pickNumber(memory.percent, memory.pct),
    },
    disk: {
      used: pickNumber(disk.used),
      free: pickNumber(disk.free),
      total: pickNumber(disk.total),
      pct: pickNumber(disk.percent, disk.pct),
    },
    temperature: pickNumber(vitals.temperature),
  };
}

function createInitialHealth() {
  return {
    status: "unknown",
    latencyMs: null,
    lastChecked: null,
    lastOnline: null,
    consecutiveFailures: 0,
    latencySamples: [],
    version: null,
  };
}

/**
 * Create the mesh module with injectable dependencies.
 *
 * @param {object} options
 * @param {string} options.stateDir - directory for mesh-nodes.json persistence
 * @param {string} [options.configDir] - reserved for future config (unused)
 * @param {number} [options.intervalMs] - health poll interval (default 15s)
 * @param {number} [options.healthTimeoutMs] - per-request timeout (default 5s)
 * @param {function} [options.fetchFn] - fetch-compatible function (injectable)
 * @param {object} [options.tailscale] - tailscale adapter ({getStatus})
 * @param {function} [options.onChange] - callback({node, previousStatus, status, health}) fired when a node's status changes
 * @param {function} [options.onHealth] - callback({node, previousStatus, status, health}) fired after EVERY health poll
 *   (including no-transition polls) — consumed by the alert wiring's
 *   failure-streak / recovery tracking, which needs per-poll visibility
 * @param {function} [options.nowFn] - clock function (default Date.now)
 * @param {Array<object>} [options.seed] - fleet-wide seed list auto-registered
 *   into the registry ONCE during construction (idempotent across reboots);
 *   each entry is the same validateNodeInput shape (without id/registeredAt)
 * @param {string} [options.selfHostname] - this node's hostname; seed entries
 *   matching it are skipped (a node never seeds itself)
 * @returns {{start, stop, getState, registerNode, unregisterNode, discoverPeers, getFleetCosts, collectNodeStats, _pollOnce}}
 */
function createMesh(options = {}) {
  const {
    stateDir,
    intervalMs = DEFAULT_INTERVAL_MS,
    healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
    fetchFn = (...args) => globalThis.fetch(...args),
    tailscale = createTailscaleAdapter(),
    onChange = null,
    onHealth = null,
    nowFn = Date.now,
    seed = [],
    selfHostname = "",
  } = options;

  if (!stateDir || typeof stateDir !== "string") {
    throw new Error("createMesh requires a stateDir string");
  }

  // ---------------------------------------------------------------------
  // Registry persistence — createSafeStore (AC-20)
  //
  // Replaces the inline temp+rename write with createSafeStore, giving the
  // registry rotated backups + corrupt-file quarantine/auto-restore parity
  // with the rest of the safe-store ecosystem. A corrupt registry no longer
  // silently returns [] — the newest valid backup is auto-restored instead.
  // ---------------------------------------------------------------------

  const registryFile = path.join(stateDir, REGISTRY_FILENAME);
  const registryBackupDir = path.join(stateDir, REGISTRY_BACKUP_DIRNAME);

  const registryStore = createSafeStore({
    filePath: registryFile,
    validate: validateRegistry,
    backupDir: registryBackupDir,
    createDefault: () => ({ nodes: [] }),
  });

  function loadRegistry() {
    const { data, restored, quarantinedPath } = registryStore.read();
    if (restored) {
      console.warn(`[Mesh] Registry was corrupt; auto-restored. Quarantined: ${quarantinedPath}`);
    }
    if (!data || !Array.isArray(data.nodes)) return [];
    // Filter defensively in case a backup has partially-valid records
    return data.nodes.filter((n) => n && typeof n === "object" && typeof n.hostname === "string");
  }

  function saveRegistry() {
    registryStore.write({ nodes });
  }

  // Module-level state
  let nodes = loadRegistry();
  const health = {}; // nodeId -> health record (records replaced immutably)
  const nodeStats = {}; // nodeId -> { costs, vitals, vitalsAt } cached from /api/state
  let pollTimer = null;
  let pollCycle = 0; // increments once per _pollOnce; drives the Nth-poll state refresh

  // ---------------------------------------------------------------------
  // Seed auto-registration (zero-touch mesh join)
  //
  // Runs ONCE during construction, after the registry is loaded and before
  // health polling starts. Idempotent across reboots: an instance already
  // present (hostname + port) is never duplicated — it only has its mutable
  // metadata (healthPath / label / platform) corrected in place when a seed
  // entry disagrees with a stale manual record. New entries get a fresh id +
  // registeredAt. Self (by hostname) is always skipped, and a seed array of
  // [] is a complete no-op (zero disk writes), keeping pre-seed boots
  // byte-identical. Deliberately bypasses registerNode's throw-on-duplicate.
  // ---------------------------------------------------------------------

  /**
   * Auto-register each seed entry into the registry (see block comment).
   * @param {Array<object>} seedList - raw seed entries (validateNodeInput shape)
   * @param {string} self - this node's hostname (entries matching it are skipped)
   */
  function seedRegistry(seedList, self) {
    if (!Array.isArray(seedList) || seedList.length === 0) return;

    let changed = false;
    for (const raw of seedList) {
      let validated;
      try {
        validated = validateNodeInput({ ...raw, registeredBy: "seed" });
      } catch (e) {
        console.warn(`[Mesh] Skipping invalid seed entry: ${e.message}`);
        continue;
      }

      // A node never seeds itself.
      if (self && validated.hostname === self) continue;

      const existing = nodes.find((n) => isSameInstance(n, validated));
      if (existing) {
        // Correct stale mutable metadata in place (keyed on id). Never touch
        // hostname / port / id / registeredAt — those are the record identity.
        if (
          existing.healthPath !== validated.healthPath ||
          existing.label !== validated.label ||
          existing.platform !== validated.platform
        ) {
          const updated = {
            ...existing,
            healthPath: validated.healthPath,
            label: validated.label,
            platform: validated.platform,
          };
          nodes = nodes.map((n) => (n.id === existing.id ? updated : n));
          changed = true;
        }
        continue;
      }

      nodes = [
        ...nodes,
        {
          id: crypto.randomUUID(),
          ...validated,
          registeredAt: new Date(nowFn()).toISOString(),
        },
      ];
      changed = true;
    }

    // Only persist when something actually changed (no-op boot = no writes).
    if (changed) saveRegistry();
  }

  seedRegistry(seed, selfHostname);

  // ---------------------------------------------------------------------
  // Registry CRUD
  // ---------------------------------------------------------------------

  /**
   * Register a fleet node. Validates all inputs; throws on invalid input
   * or duplicate INSTANCE (hostname + port — two dashboards on one host with
   * different ports are distinct nodes). Returns the persisted node record.
   */
  function registerNode(input) {
    const validated = validateNodeInput(input);
    if (nodes.some((n) => isSameInstance(n, validated))) {
      throw new Error(`Node already registered: ${nodeInstanceKey(validated)}`);
    }
    const record = {
      id: crypto.randomUUID(),
      ...validated,
      registeredAt: new Date(nowFn()).toISOString(),
    };
    nodes = [...nodes, record];
    saveRegistry();
    return record;
  }

  /**
   * Unregister a node by id, instance key ("hostname:port"), or bare
   * hostname (first match — kept for backward compatibility with callers
   * predating multi-instance hosts). Throws when not found.
   * Returns the removed record.
   */
  function unregisterNode(idOrHostname) {
    const target = nodes.find(
      (n) =>
        n.id === idOrHostname || nodeInstanceKey(n) === idOrHostname || n.hostname === idOrHostname,
    );
    if (!target) {
      throw new Error(`Unknown node: ${idOrHostname}`);
    }
    nodes = nodes.filter((n) => n.id !== target.id);
    delete health[target.id];
    delete nodeStats[target.id];
    saveRegistry();
    return target;
  }

  // ---------------------------------------------------------------------
  // Health polling
  // ---------------------------------------------------------------------

  function timeoutSignal(ms) {
    if (globalThis.AbortSignal && typeof globalThis.AbortSignal.timeout === "function") {
      return globalThis.AbortSignal.timeout(ms);
    }
    return undefined;
  }

  function emitChange(node, previousStatus, nextHealth) {
    if (typeof onChange !== "function") return;
    try {
      onChange({ node, previousStatus, status: nextHealth.status, health: nextHealth });
    } catch (e) {
      console.error("[Mesh] onChange callback failed:", e.message);
    }
  }

  /**
   * Best-effort GET of a node's /api/state. Returns parsed body or null.
   */
  async function fetchNodeState(node, magicDnsSuffix) {
    try {
      const url = composeNodeUrl(node, magicDnsSuffix, "/api/state");
      const res = await fetchFn(url, { signal: timeoutSignal(healthTimeoutMs) });
      if (!res || res.ok !== true) return null;
      return await res.json();
    } catch (e) {
      // Best-effort only — version/cost fetch failures never fail health
      return null;
    }
  }

  /**
   * Refresh the per-node /api/state cache (costs + vitals) from an already
   * fetched remote state body. Never issues its own HTTP request; a null
   * body (failed fetch) keeps the last good cache so transient blips do not
   * wipe vitals. Records replaced immutably.
   */
  function updateNodeStatsCache(node, remoteState) {
    if (!remoteState) return;
    const vitals = extractNodeVitals(remoteState);
    nodeStats[node.id] = {
      costs: extractNodeCosts(remoteState),
      vitals,
      vitalsAt: vitals ? nowFn() : null,
    };
  }

  function failureHealth(prev, peer, checkedAt) {
    // Connection refused / timeout while the tailscale peer reports
    // Online=true means the host is up but the service is not exposed
    // (likely missing serve config) => "unreachable".
    // Peer Online=false => the host itself is "offline".
    const status = peer && peer.online === false ? "offline" : "unreachable";
    return {
      status,
      latencyMs: null,
      lastChecked: checkedAt,
      lastOnline: prev.lastOnline,
      consecutiveFailures: prev.consecutiveFailures + 1,
      latencySamples: prev.latencySamples,
      version: prev.version,
    };
  }

  async function pollNode(node, tsStatus, cycle) {
    const suffix = tsStatus.available && tsStatus.self ? tsStatus.self.magicDnsSuffix : "";
    const peer =
      tsStatus.available && Array.isArray(tsStatus.peers)
        ? tsStatus.peers.find((p) => p.hostname === node.hostname)
        : null;
    const prev = health[node.id] || createInitialHealth();
    const startedAt = nowFn();
    let next;

    try {
      const url = composeNodeUrl(node, suffix);
      const res = await fetchFn(url, { signal: timeoutSignal(healthTimeoutMs) });
      const latencyMs = nowFn() - startedAt;

      if (res && res.ok === true) {
        let version = prev.version;
        let body = null;
        try {
          body = await res.json();
        } catch (e) {
          // Health endpoint may not return JSON — that's fine
        }
        if (body && typeof body.version === "string") {
          version = body.version;
        }
        // Piggyback /api/state on every Nth poll cycle (replaces the old
        // once-only version probe) so cached vitals + costs stay fresh
        // (~1 min at the default 15s interval) without extra request types.
        // Fires immediately for never-cached nodes (first poll / freshly
        // registered) and while the version is still unknown. Best-effort:
        // never fails health.
        const stateDue =
          cycle % STATE_REFRESH_EVERY_N_POLLS === 0 || !nodeStats[node.id] || version === null;
        if (stateDue) {
          const remoteState = await fetchNodeState(node, suffix);
          updateNodeStatsCache(node, remoteState);
          if (remoteState && typeof remoteState.version === "string") {
            version = remoteState.version;
          }
        }
        next = {
          status: "online",
          latencyMs,
          lastChecked: startedAt,
          lastOnline: startedAt,
          consecutiveFailures: 0,
          latencySamples: [...prev.latencySamples, latencyMs].slice(-LATENCY_SAMPLE_LIMIT),
          version,
        };
      } else {
        next = failureHealth(prev, peer, startedAt);
      }
    } catch (e) {
      next = failureHealth(prev, peer, startedAt);
    }

    health[node.id] = next;
    if (prev.status !== next.status) {
      emitChange(node, prev.status, next);
    }
    // Per-poll hook (every poll, transition or not): feeds the alert
    // wiring's failure-streak + recovery tracking. Isolated like onChange.
    if (typeof onHealth === "function") {
      try {
        onHealth({ node, previousStatus: prev.status, status: next.status, health: next });
      } catch (e) {
        console.error("[Mesh] onHealth callback failed:", e.message);
      }
    }
  }

  /**
   * Run one full poll cycle across all registered nodes.
   * Exposed for testing (matches the repo's _resetForTesting convention).
   */
  async function _pollOnce() {
    const tsStatus = await tailscale.getStatus();
    const cycle = pollCycle++;
    await Promise.all(nodes.map((node) => pollNode(node, tsStatus, cycle)));
  }

  function start() {
    if (pollTimer) return;
    _pollOnce().catch((e) => console.error("[Mesh] Poll failed:", e.message));
    pollTimer = setInterval(() => {
      _pollOnce().catch((e) => console.error("[Mesh] Poll failed:", e.message));
    }, intervalMs);
    if (typeof pollTimer.unref === "function") pollTimer.unref();
    console.log(`[Mesh] Health poller started (${intervalMs}ms interval)`);
  }

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      console.log("[Mesh] Health poller stopped");
    }
  }

  // ---------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------

  /**
   * Merge tailscale peers with the registry into a candidates list,
   * each flagged registered/unregistered.
   */
  async function discoverPeers() {
    const tsStatus = await tailscale.getStatus();
    if (!tsStatus.available) {
      return {
        available: false,
        error: tsStatus.error || "tailscale unavailable",
        candidates: nodes.map((n) => ({
          hostname: n.hostname,
          fqdn: null,
          ips: [],
          online: null,
          os: n.platform,
          lastSeen: null,
          registered: true,
          nodeId: n.id,
        })),
      };
    }

    const candidates = tsStatus.peers.map((peer) => {
      const registeredNode = nodes.find((n) => n.hostname === peer.hostname);
      return {
        hostname: peer.hostname,
        fqdn: peer.fqdn,
        ips: peer.ips,
        online: peer.online,
        os: peer.os,
        lastSeen: peer.lastSeen,
        registered: !!registeredNode,
        nodeId: registeredNode ? registeredNode.id : null,
      };
    });

    // Registered nodes that have no matching tailscale peer
    const peerHostnames = new Set(tsStatus.peers.map((p) => p.hostname));
    const orphans = nodes
      .filter((n) => !peerHostnames.has(n.hostname))
      .map((n) => ({
        hostname: n.hostname,
        fqdn: null,
        ips: [],
        online: null,
        os: n.platform,
        lastSeen: null,
        registered: true,
        nodeId: n.id,
      }));

    return { available: true, candidates: [...candidates, ...orphans] };
  }

  // ---------------------------------------------------------------------
  // Cost rollup
  // ---------------------------------------------------------------------

  /**
   * Best-effort collection of one node's command-center stats
   * (llm-usage / cost totals from its /api/state). Returns nulls on any
   * shape mismatch; never throws.
   */
  async function collectNodeStats(node) {
    const tsStatus = await tailscale.getStatus();
    const suffix = tsStatus.available && tsStatus.self ? tsStatus.self.magicDnsSuffix : "";
    const remoteState = await fetchNodeState(node, suffix);
    // Opportunistic cache refresh — same fetch, no extra HTTP requests.
    updateNodeStatsCache(node, remoteState);
    return extractNodeCosts(remoteState);
  }

  /**
   * Aggregate cost stats across all registered nodes.
   * @returns {Promise<{byNode: object, totals: {cost24h: number, cost7d: number, nodesReporting: number}}>}
   */
  async function getFleetCosts() {
    const results = await Promise.all(
      nodes.map(async (node) => ({ node, stats: await collectNodeStats(node) })),
    );

    const byNode = {};
    let cost24h = 0;
    let cost7d = 0;
    let nodesReporting = 0;

    for (const { node, stats } of results) {
      byNode[node.id] = { hostname: node.hostname, label: node.label, stats };
      if (stats && (stats.cost24h !== null || stats.cost7d !== null)) {
        nodesReporting++;
        if (stats.cost24h !== null) cost24h += stats.cost24h;
        if (stats.cost7d !== null) cost7d += stats.cost7d;
      }
    }

    return { byNode, totals: { cost24h, cost7d, nodesReporting } };
  }

  // ---------------------------------------------------------------------
  // State snapshot for the UI
  // ---------------------------------------------------------------------

  /**
   * Everything the UI needs: self identity, registered nodes with health +
   * sparkline data + version + cached vitals, and discovery candidates.
   */
  async function getState() {
    const [tsStatus, discovery] = await Promise.all([tailscale.getStatus(), discoverPeers()]);
    const suffix = tsStatus.available && tsStatus.self ? tsStatus.self.magicDnsSuffix : "";

    return {
      self: tsStatus.available ? tsStatus.self : null,
      tailscale: {
        available: tsStatus.available,
        error: tsStatus.available ? null : tsStatus.error,
      },
      nodes: nodes.map((node) => {
        const stats = nodeStats[node.id];
        return {
          ...node,
          url: composeNodeUrl(node, suffix),
          health: health[node.id] || createInitialHealth(),
          vitals: stats ? stats.vitals : null,
          vitalsAt: stats ? stats.vitalsAt : null,
        };
      }),
      candidates: discovery.candidates,
      intervalMs,
      timestamp: nowFn(),
    };
  }

  return {
    start,
    stop,
    getState,
    registerNode,
    unregisterNode,
    discoverPeers,
    getFleetCosts,
    collectNodeStats,
    _pollOnce,
  };
}

module.exports = {
  createMesh,
  composeNodeUrl,
  validateNodeInput,
  validateRegistry,
  nodeInstanceKey,
  isSameInstance,
  extractNodeCosts,
  extractNodeVitals,
  LATENCY_SAMPLE_LIMIT,
  STATE_REFRESH_EVERY_N_POLLS,
  VALID_PLATFORMS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_HEALTH_TIMEOUT_MS,
};
