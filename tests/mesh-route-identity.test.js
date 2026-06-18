/**
 * M-5 — mesh registration route identity hardening (security remediation).
 *
 * Unit tests for the mesh write routes in src/fleet-routes.js:
 *   - `registeredBy: "spawn"` is RESERVED for the internal controller and is
 *     rejected (403) from the HTTP path.
 *   - A mutating mesh write (register/unregister) from an anonymous EXTERNAL
 *     identity is refused (403); internal/localhost calls still pass so the
 *     controller and local tooling are unaffected.
 *
 * Uses a mocked fleet runtime + fake req/res (no HTTP server), with full
 * control over the request identity header and the TCP peer address.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { createFleetRoutes } = require("../src/fleet-routes");

const MESH_NODES_PATH = "/api/fleet/mesh/nodes";

function makeFleet() {
  const audit = [];
  const fleet = {
    rateLimiter: { check: () => ({ allowed: true }) },
    audit: { record: (e) => audit.push(e) },
    kanban: { getBoard: () => ({ tasks: [] }) },
    mesh: {
      registerNode: (input) => ({ id: "node-1", hostname: input.hostname, ...input }),
      unregisterNode: (idOrHost) => ({ id: "node-1", hostname: idOrHost }),
      getState: async () => ({ nodes: [] }),
      discoverPeers: async () => [],
    },
    fireAlert: () => {},
  };
  return { fleet, audit };
}

/**
 * @param {object} opts
 * @param {string} [opts.identity] - tailscale-user-login header (omit = none)
 * @param {string} [opts.remoteAddress] - TCP peer (default loopback)
 * @param {boolean} [opts.forwarded] - inject x-forwarded-for (Serve-proxied)
 */
function makeReq(method, body, { identity, remoteAddress = "127.0.0.1", forwarded = false } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = {};
  if (identity !== undefined) req.headers["tailscale-user-login"] = identity;
  if (forwarded) req.headers["x-forwarded-for"] = "100.64.0.5";
  req.socket = { remoteAddress };
  process.nextTick(() => {
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

function makeRes() {
  const res = { statusCode: null, body: null };
  res.writeHead = (code) => {
    res.statusCode = code;
  };
  res.end = (payload) => {
    res.body = payload ? JSON.parse(payload) : null;
  };
  return res;
}

async function call(routes, method, pathname, body, reqOpts) {
  const req = makeReq(method, body, reqOpts);
  const res = makeRes();
  await routes.handle(req, res, pathname, new URLSearchParams(""));
  return res;
}

describe("M-5 — mesh route identity hardening", () => {
  it('rejects registeredBy:"spawn" from the HTTP path with 403', async () => {
    const { fleet } = makeFleet();
    const routes = createFleetRoutes({ fleet });
    const res = await call(
      routes,
      "POST",
      MESH_NODES_PATH,
      { hostname: "drone-1", registeredBy: "spawn" },
      { identity: "tester@example.com" },
    );
    assert.strictEqual(res.statusCode, 403);
    assert.match(res.body.error, /reserved/i);
  });

  it("an authenticated caller may register normally (registeredBy is the verified identity)", async () => {
    const { fleet } = makeFleet();
    const routes = createFleetRoutes({ fleet });
    const res = await call(
      routes,
      "POST",
      MESH_NODES_PATH,
      { hostname: "drone-1" },
      { identity: "tester@example.com" },
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.node.registeredBy, "tester@example.com");
  });

  it("refuses an anonymous EXTERNAL register (Serve-proxied, no identity) with 403", async () => {
    const { fleet } = makeFleet();
    const routes = createFleetRoutes({ fleet });
    // Loopback peer BUT x-forwarded-for present => external request behind Serve.
    const res = await call(routes, "POST", MESH_NODES_PATH, { hostname: "drone-1" }, {
      remoteAddress: "127.0.0.1",
      forwarded: true,
    });
    assert.strictEqual(res.statusCode, 403);
    assert.match(res.body.error, /authenticated identity/i);
  });

  it("refuses an anonymous register from a non-loopback peer with 403", async () => {
    const { fleet } = makeFleet();
    const routes = createFleetRoutes({ fleet });
    const res = await call(routes, "POST", MESH_NODES_PATH, { hostname: "drone-1" }, {
      remoteAddress: "100.64.0.9",
    });
    assert.strictEqual(res.statusCode, 403);
    assert.match(res.body.error, /authenticated identity/i);
  });

  it("ALLOWS an internal localhost register with no identity (controller / local CLI)", async () => {
    const { fleet } = makeFleet();
    const routes = createFleetRoutes({ fleet });
    // Genuine loopback, no x-forwarded-for => internal call, allowed.
    const res = await call(routes, "POST", MESH_NODES_PATH, { hostname: "drone-1" }, {
      remoteAddress: "127.0.0.1",
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.node.registeredBy, "anonymous");
  });

  it("refuses an anonymous EXTERNAL unregister with 403", async () => {
    const { fleet } = makeFleet();
    const routes = createFleetRoutes({ fleet });
    const res = await call(routes, "DELETE", `${MESH_NODES_PATH}/node-1`, undefined, {
      remoteAddress: "127.0.0.1",
      forwarded: true,
    });
    assert.strictEqual(res.statusCode, 403);
    assert.match(res.body.error, /authenticated identity/i);
  });

  it("ALLOWS an internal localhost unregister with no identity", async () => {
    const { fleet } = makeFleet();
    const routes = createFleetRoutes({ fleet });
    const res = await call(routes, "DELETE", `${MESH_NODES_PATH}/node-1`, undefined, {
      remoteAddress: "127.0.0.1",
    });
    assert.strictEqual(res.statusCode, 200);
  });
});
