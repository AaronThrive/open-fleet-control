/**
 * Tailscale adapter for Open Fleet Control mesh networking.
 *
 * Tailnet-agnostic: the MagicDNS suffix is always derived at runtime from
 * Self.DNSName — no tailnet name is ever hardcoded.
 *
 * Fallback chain for status:
 *   1. `tailscale status --json` via exec (host / dev mode)
 *   2. HTTP GET to the sidecar LocalAPI proxy (default
 *      http://127.0.0.1:9002/api/status, overridable via
 *      TAILSCALE_LOCAL_API_ENDPOINT)
 *
 * Resilience behaviors:
 *   - The path (CLI vs LocalAPI) that last succeeded is tried first on the
 *     next refresh.
 *   - After LOCALAPI_MAX_CONSECUTIVE_FAILURES consecutive LocalAPI failures
 *     the LocalAPI fallback is skipped (it does not exist on bare hosts and
 *     only adds a guaranteed second failure). It is re-probed after
 *     LOCALAPI_REPROBE_INTERVAL_MS.
 *   - Negative results are cached for a shorter TTL than positive ones so
 *     recovery is noticed quickly without hammering the daemon.
 *   - A transition to unavailable is logged once (not once per poll).
 *
 * Never throws to callers: when tailscale is unavailable, getStatus()
 * resolves to `{ available: false, error, self: null, peers: [] }`.
 */

const { runCmdSafe } = require("./utils");

const DEFAULT_LOCAL_API_ENDPOINT = "http://127.0.0.1:9002/api/status";
const STATUS_CACHE_TTL = 10000; // 10 seconds — avoid hammering the daemon
const NEGATIVE_STATUS_CACHE_TTL = 3000; // 3 seconds — re-check failures sooner
const EXEC_TIMEOUT_MS = 10000; // 10 seconds — slow hosts need headroom
const LOCALAPI_MAX_CONSECUTIVE_FAILURES = 3;
const LOCALAPI_REPROBE_INTERVAL_MS = 60 * 60 * 1000; // re-probe hourly

/**
 * Strip a single trailing dot from a DNS name (tailscale FQDNs end with ".").
 * @param {string} name
 * @returns {string}
 */
function stripTrailingDot(name) {
  if (typeof name !== "string") return "";
  return name.endsWith(".") ? name.slice(0, -1) : name;
}

/**
 * Derive the MagicDNS suffix from a node's DNSName at runtime.
 * e.g. "hermes.example-tailnet.ts.net." -> "example-tailnet.ts.net"
 * @param {string} dnsName
 * @returns {string} suffix, or "" when it cannot be derived
 */
function deriveMagicDnsSuffix(dnsName) {
  const fqdn = stripTrailingDot(dnsName || "");
  const firstDot = fqdn.indexOf(".");
  if (firstDot === -1) return "";
  return fqdn.slice(firstDot + 1);
}

/**
 * Normalize a single raw tailscale peer entry.
 * @param {object} peer - raw peer object from tailscale status JSON
 * @returns {{id: string, hostname: string, fqdn: string, ips: string[], online: boolean, lastSeen: string|null, os: string}}
 */
function normalizePeer(peer) {
  return {
    id: peer.ID || peer.PublicKey || "",
    hostname: peer.HostName || "",
    fqdn: stripTrailingDot(peer.DNSName || ""),
    ips: Array.isArray(peer.TailscaleIPs) ? [...peer.TailscaleIPs] : [],
    online: peer.Online === true,
    lastSeen: peer.LastSeen || null,
    os: peer.OS || "unknown",
  };
}

/**
 * Normalize a raw tailscale status payload (CLI or LocalAPI — both produce
 * the same JSON shape) into the fleet-control status shape.
 * @param {object} raw - parsed tailscale status JSON
 * @returns {{available: true, self: object, peers: object[]}}
 * @throws {Error} when the payload is not a recognizable status document
 */
function normalizeStatus(raw) {
  if (!raw || typeof raw !== "object" || !raw.Self || typeof raw.Self !== "object") {
    throw new Error("Unrecognized tailscale status payload (missing Self)");
  }

  const self = raw.Self;
  const magicDnsSuffix =
    deriveMagicDnsSuffix(self.DNSName) || stripTrailingDot(raw.MagicDNSSuffix || "");
  const rawPeers = raw.Peer && typeof raw.Peer === "object" ? Object.values(raw.Peer) : [];

  return {
    available: true,
    self: {
      hostname: self.HostName || "",
      fqdn: stripTrailingDot(self.DNSName || ""),
      tailscaleIPs: Array.isArray(self.TailscaleIPs) ? [...self.TailscaleIPs] : [],
      magicDnsSuffix,
    },
    peers: rawPeers.map(normalizePeer),
  };
}

/**
 * Create a tailscale adapter with injectable dependencies (for testability).
 *
 * @param {object} [deps]
 * @param {function} [deps.execFn] - async (cmd) => stdout string
 * @param {function} [deps.fetchFn] - fetch-compatible function
 * @param {number} [deps.cacheTtlMs] - positive-status cache TTL (default 10s)
 * @param {number} [deps.negativeCacheTtlMs] - failure cache TTL (default 3s)
 * @param {string} [deps.localApiEndpoint] - override the LocalAPI status URL
 * @param {function} [deps.nowFn] - clock function (default Date.now)
 * @param {function} [deps.warnFn] - warning logger (default console.warn)
 * @returns {{getStatus: function(): Promise<object>}}
 */
function createTailscaleAdapter(deps = {}) {
  const {
    // Default runner: execFile (no shell — the command + args are never parsed
    // by /bin/sh). Signature is (file, args[]) so injected test mocks receive
    // the same discrete vector. Migrated off the shell-based runCmd footgun.
    execFn = (file, args = []) => runCmdSafe(file, args, { timeout: EXEC_TIMEOUT_MS }),
    fetchFn = (...args) => globalThis.fetch(...args),
    cacheTtlMs = STATUS_CACHE_TTL,
    negativeCacheTtlMs = NEGATIVE_STATUS_CACHE_TTL,
    localApiEndpoint = null,
    nowFn = Date.now,
    warnFn = (...args) => console.warn(...args),
  } = deps;

  let cachedStatus = null;
  let lastStatusUpdate = 0;

  // Availability transition tracking (null = never resolved yet).
  let lastAvailable = null;

  // The path that last produced a successful status ("cli" | "localapi").
  let preferredPath = "cli";

  // LocalAPI circuit breaker: skip the fallback after repeated failures.
  let localApiConsecutiveFailures = 0;
  let localApiDisabledUntil = 0;

  function getLocalApiEndpoint() {
    return (
      localApiEndpoint || process.env.TAILSCALE_LOCAL_API_ENDPOINT || DEFAULT_LOCAL_API_ENDPOINT
    );
  }

  async function fetchViaCli() {
    const stdout = await execFn("tailscale", ["status", "--json"]);
    return normalizeStatus(JSON.parse(stdout));
  }

  async function fetchViaLocalApi() {
    const res = await fetchFn(getLocalApiEndpoint());
    if (!res || res.ok !== true) {
      throw new Error(`LocalAPI returned HTTP ${res ? res.status : "no response"}`);
    }
    return normalizeStatus(await res.json());
  }

  function isLocalApiCircuitOpen(now) {
    return (
      localApiConsecutiveFailures >= LOCALAPI_MAX_CONSECUTIVE_FAILURES &&
      now < localApiDisabledUntil
    );
  }

  function recordLocalApiFailure(now) {
    localApiConsecutiveFailures++;
    if (localApiConsecutiveFailures >= LOCALAPI_MAX_CONSECUTIVE_FAILURES) {
      localApiDisabledUntil = now + LOCALAPI_REPROBE_INTERVAL_MS;
      if (localApiConsecutiveFailures === LOCALAPI_MAX_CONSECUTIVE_FAILURES) {
        warnFn(
          `[tailscale] LocalAPI fallback disabled after ${localApiConsecutiveFailures} consecutive failures; re-probing in ${LOCALAPI_REPROBE_INTERVAL_MS / 60000} minutes`,
        );
      }
    }
  }

  /**
   * Attempt one path. Returns the status on success, null on failure
   * (recording the error in `errors`).
   */
  async function tryPath(pathName, errors, now) {
    if (pathName === "localapi") {
      if (isLocalApiCircuitOpen(now)) {
        errors.push({ path: "localapi", message: "skipped (circuit open)" });
        return null;
      }
      try {
        const status = await fetchViaLocalApi();
        localApiConsecutiveFailures = 0;
        localApiDisabledUntil = 0;
        preferredPath = "localapi";
        return status;
      } catch (e) {
        errors.push({ path: "localapi", message: e.message });
        recordLocalApiFailure(now);
        return null;
      }
    }

    try {
      const status = await fetchViaCli();
      preferredPath = "cli";
      return status;
    } catch (e) {
      errors.push({ path: "cli", message: e.message });
      return null;
    }
  }

  /**
   * Get the normalized tailscale status (cached; positives for cacheTtlMs,
   * negatives for negativeCacheTtlMs).
   * Never throws: returns { available: false, error } on failure.
   * @returns {Promise<object>}
   */
  async function getStatus() {
    const now = nowFn();
    if (cachedStatus) {
      const ttl = cachedStatus.available ? cacheTtlMs : negativeCacheTtlMs;
      if (now - lastStatusUpdate < ttl) {
        return cachedStatus;
      }
    }

    const order = preferredPath === "localapi" ? ["localapi", "cli"] : ["cli", "localapi"];
    const errors = [];
    let status = null;

    for (const pathName of order) {
      status = await tryPath(pathName, errors, now);
      if (status) break;
    }

    if (!status) {
      const detail = errors.map((e) => `${e.path}: ${e.message}`).join("; ");
      status = {
        available: false,
        error: `tailscale unavailable (${detail})`,
        self: null,
        peers: [],
      };
    }

    // Log once on the transition to unavailable — not on every failed poll.
    if (status.available === false && lastAvailable !== false) {
      warnFn(`[tailscale] mesh status unavailable: ${status.error}`);
    }
    lastAvailable = status.available;

    cachedStatus = status;
    lastStatusUpdate = now;
    return status;
  }

  return { getStatus };
}

module.exports = {
  createTailscaleAdapter,
  normalizeStatus,
  stripTrailingDot,
  deriveMagicDnsSuffix,
  DEFAULT_LOCAL_API_ENDPOINT,
  STATUS_CACHE_TTL,
  NEGATIVE_STATUS_CACHE_TTL,
  EXEC_TIMEOUT_MS,
  LOCALAPI_MAX_CONSECUTIVE_FAILURES,
  LOCALAPI_REPROBE_INTERVAL_MS,
};
