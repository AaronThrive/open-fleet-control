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
 * Never throws to callers: when tailscale is unavailable, getStatus()
 * resolves to `{ available: false, error, self: null, peers: [] }`.
 */

const { runCmd } = require("./utils");

const DEFAULT_LOCAL_API_ENDPOINT = "http://127.0.0.1:9002/api/status";
const STATUS_CACHE_TTL = 10000; // 10 seconds — avoid hammering the daemon

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
 * @param {number} [deps.cacheTtlMs] - status cache TTL (default 10s)
 * @param {string} [deps.localApiEndpoint] - override the LocalAPI status URL
 * @param {function} [deps.nowFn] - clock function (default Date.now)
 * @returns {{getStatus: function(): Promise<object>}}
 */
function createTailscaleAdapter(deps = {}) {
  const {
    execFn = (cmd) => runCmd(cmd, { timeout: 5000 }),
    fetchFn = (...args) => globalThis.fetch(...args),
    cacheTtlMs = STATUS_CACHE_TTL,
    localApiEndpoint = null,
    nowFn = Date.now,
  } = deps;

  let cachedStatus = null;
  let lastStatusUpdate = 0;

  function getLocalApiEndpoint() {
    return (
      localApiEndpoint || process.env.TAILSCALE_LOCAL_API_ENDPOINT || DEFAULT_LOCAL_API_ENDPOINT
    );
  }

  async function fetchViaCli() {
    const stdout = await execFn("tailscale status --json");
    return normalizeStatus(JSON.parse(stdout));
  }

  async function fetchViaLocalApi() {
    const res = await fetchFn(getLocalApiEndpoint());
    if (!res || res.ok !== true) {
      throw new Error(`LocalAPI returned HTTP ${res ? res.status : "no response"}`);
    }
    return normalizeStatus(await res.json());
  }

  /**
   * Get the normalized tailscale status (cached for cacheTtlMs).
   * Never throws: returns { available: false, error } on failure.
   * @returns {Promise<object>}
   */
  async function getStatus() {
    const now = nowFn();
    if (cachedStatus && now - lastStatusUpdate < cacheTtlMs) {
      return cachedStatus;
    }

    let status = null;
    let cliError = null;

    try {
      status = await fetchViaCli();
    } catch (e) {
      cliError = e;
    }

    if (!status) {
      try {
        status = await fetchViaLocalApi();
      } catch (apiError) {
        status = {
          available: false,
          error: `tailscale unavailable (cli: ${cliError ? cliError.message : "failed"}; localapi: ${apiError.message})`,
          self: null,
          peers: [],
        };
      }
    }

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
};
