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

/**
 * Startup secure-posture guard for the resolved auth + bind configuration.
 *
 * Refuses to start the dashboard in the one combination that exposes an
 * unauthenticated control plane to the whole network: auth.mode "none" while
 * the server binds all interfaces (resolveBindHost → null). A client who copies
 * the example, flips mode back to "none", and forgets bindHost would otherwise
 * ship a wide-open fleet console. Also emits a loud warning when running the
 * Tailscale mode without Serve-origin verification (spoofable identity header).
 *
 * Pure + injectable: returns the verdict so it is unit-testable without exiting
 * the process; the boot site decides whether to throw/exit on `fatal`.
 *
 * @param {object} authConfig - resolved CONFIG.auth ({mode, tailscale:{verifyServeOrigin}})
 * @param {string} [bindHost] - CONFIG.server.bindHost (raw, pre-resolution)
 * @param {object} [opts]
 * @param {function} [opts.warn=console.warn] - injected warning sink (testing)
 * @returns {{fatal: boolean, errors: string[], warnings: string[]}}
 */
function assertSecureBindPosture(authConfig, bindHost, { warn = console.warn } = {}) {
  const errors = [];
  const warnings = [];
  const mode = authConfig && typeof authConfig.mode === "string" ? authConfig.mode : "none";
  const bindsAllInterfaces = resolveBindHost(bindHost) === null;

  if (mode === "none" && bindsAllInterfaces) {
    errors.push(
      "REFUSING TO START: auth.mode is \"none\" while the server binds ALL interfaces " +
        "(server.bindHost is unset/0.0.0.0). This would expose an UNAUTHENTICATED fleet " +
        "control plane to the entire network. Set auth.mode to \"tailscale\"/\"cloudflare\"/" +
        "\"token\"/\"allowlist\", or set server.bindHost to \"127.0.0.1\" (loopback only).",
    );
  }

  if (mode === "tailscale") {
    const verify = !!(authConfig && authConfig.tailscale && authConfig.tailscale.verifyServeOrigin);
    if (!verify) {
      warnings.push(
        "SECURITY WARNING: auth.mode is \"tailscale\" but auth.tailscale.verifyServeOrigin is " +
          "false. The tailscale-user-login identity header is then trusted as-is and can be " +
          "forged by any direct tailnet connection to the bound port. Set " +
          "auth.tailscale.verifyServeOrigin=true and bind loopback behind Tailscale Serve.",
      );
    }
  }

  for (const w of warnings) warn(`[SECURITY] ${w}`);

  return { fatal: errors.length > 0, errors, warnings };
}

module.exports = { resolveBindHost, assertSecureBindPosture };
