/**
 * Resolve the network interface the HTTP server binds to.
 *
 * The dashboard has always bound ALL interfaces (server.listen(PORT) with no
 * host → 0.0.0.0), regardless of the legacy CONFIG.server.host default of
 * "localhost" (that field was never passed to listen()). To avoid silently
 * flipping live deployments to loopback when this resolution is introduced, the
 * default MUST remain all-interfaces. Loopback binding is opt-in via an explicit
 * CONFIG.server.bindHost of "127.0.0.1" or "localhost" — the Tailscale Serve
 * cutover, where OFC binds loopback and Serve fronts it.
 *
 * Mapping:
 *   unset / "" / "0.0.0.0" / "all" / "*"  → null (Node binds all interfaces)
 *   "127.0.0.1" / "localhost"             → "127.0.0.1" (loopback only)
 *   "::1"                                 → "::1" (IPv6 loopback only)
 *   any other explicit value              → that value verbatim
 *
 * @param {string} [bindHost] - CONFIG.server.bindHost
 * @returns {string|null} host arg for server.listen (null = all interfaces)
 */
function resolveBindHost(bindHost) {
  const value = typeof bindHost === "string" ? bindHost.trim().toLowerCase() : "";
  if (value === "" || value === "0.0.0.0" || value === "all" || value === "*") {
    return null; // bind all interfaces — preserves today's live behavior
  }
  if (value === "localhost" || value === "127.0.0.1") return "127.0.0.1";
  if (value === "::1") return "::1";
  return bindHost.trim();
}

module.exports = { resolveBindHost };
