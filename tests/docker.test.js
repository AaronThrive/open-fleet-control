const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  createDocker,
  parseHealth,
  computeCpuPct,
  computeMemStats,
  summarizePorts,
  isRunningPortainer,
  DOCKER_API_VERSION,
  STATS_CONCURRENCY,
} = require("../src/docker");

const V = DOCKER_API_VERSION;

// ---------------------------------------------------------------------------
// Fixtures (shapes mirror the Docker Engine API)
// ---------------------------------------------------------------------------

const PORTAINER_ID = "aaaaaaaaaaaa1111111111111111111111111111111111111111111111111111";
const OPENCLAW_ID = "bbbbbbbbbbbb2222222222222222222222222222222222222222222222222222";
const HERMES_ID = "cccccccccccc3333333333333333333333333333333333333333333333333333";

function containersFixture() {
  return [
    {
      Id: PORTAINER_ID,
      Names: ["/portainer"],
      Image: "portainer/portainer-ce:lts",
      State: "running",
      Status: "Up 41 hours (healthy)",
      Created: 1717200000,
      Ports: [
        { IP: "127.0.0.1", PrivatePort: 9000, PublicPort: 9000, Type: "tcp" },
        { PrivatePort: 8000, Type: "tcp" },
      ],
    },
    {
      Id: OPENCLAW_ID,
      Names: ["/openclaw"],
      Image: "openclaw:latest",
      State: "running",
      Status: "Up 2 days",
      Created: 1717100000,
      Ports: [
        { IP: "0.0.0.0", PrivatePort: 3000, PublicPort: 18789, Type: "tcp" },
        { IP: "::", PrivatePort: 3000, PublicPort: 18789, Type: "tcp" },
      ],
    },
    {
      Id: HERMES_ID,
      Names: ["/hermes"],
      Image: "hermes:1.2",
      State: "exited",
      Status: "Exited (0) 3 hours ago",
      Created: 1717000000,
      Ports: [],
    },
  ];
}

function statsFixture() {
  return {
    cpu_stats: {
      cpu_usage: { total_usage: 1_200_000, percpu_usage: [1, 2, 3, 4] },
      system_cpu_usage: 11_000_000,
      online_cpus: 4,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 1_000_000 },
      system_cpu_usage: 10_000_000,
    },
    memory_stats: {
      usage: 300 * 1024 * 1024,
      limit: 1024 * 1024 * 1024,
      stats: { inactive_file: 44 * 1024 * 1024 },
    },
  };
}

function inspectFixture(id, overrides = {}) {
  return {
    Id: id,
    RestartCount: overrides.restartCount ?? 0,
    State: {
      StartedAt: overrides.startedAt ?? "2026-06-08T12:00:00.000000000Z",
      ...(overrides.health ? { Health: { Status: overrides.health } } : {}),
    },
  };
}

/**
 * Fetch-shaped transport over fixtures. Logs every (path, options) call so
 * tests can assert the read-only guarantee. Routes:
 *   /containers/json?all=true      -> fixtures.list
 *   /containers/<id>/json          -> fixtures.inspect[id]
 *   /containers/<id>/stats?...     -> fixtures.stats[id] (throws if === Error)
 */
function makeFetchFn(fixtures, log) {
  return async (apiPath, opts) => {
    log.push({ path: apiPath, options: opts });
    if (apiPath === `/${V}/containers/json?all=true`) {
      if (fixtures.listError) throw fixtures.listError;
      return okResponse(fixtures.list);
    }
    const statsMatch = apiPath.match(new RegExp(`^/${V}/containers/([0-9a-f]+)/stats`));
    if (statsMatch) {
      const stats = fixtures.stats[statsMatch[1]];
      if (stats instanceof Error) throw stats;
      return okResponse(stats ?? statsFixture());
    }
    const inspectMatch = apiPath.match(new RegExp(`^/${V}/containers/([0-9a-f]+)/json$`));
    if (inspectMatch) {
      const inspect = fixtures.inspect[inspectMatch[1]];
      if (inspect instanceof Error) throw inspect;
      return okResponse(inspect ?? inspectFixture(inspectMatch[1]));
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

function defaultFixtures() {
  return {
    list: containersFixture(),
    stats: {},
    inspect: {
      [PORTAINER_ID]: inspectFixture(PORTAINER_ID, { health: "healthy" }),
      [OPENCLAW_ID]: inspectFixture(OPENCLAW_ID, { restartCount: 2 }),
      [HERMES_ID]: inspectFixture(HERMES_ID, { startedAt: "0001-01-01T00:00:00Z" }),
    },
  };
}

function makeDocker(fixtures, log, overrides = {}) {
  return createDocker({ fetchFn: makeFetchFn(fixtures, log), ...overrides });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("docker module", () => {
  describe("parseHealth()", () => {
    it('parses "(healthy)" from the Status string', () => {
      assert.strictEqual(parseHealth("Up 41 hours (healthy)", null), "healthy");
    });

    it('parses "(unhealthy)" and "(health: starting)"', () => {
      assert.strictEqual(parseHealth("Up 5 minutes (unhealthy)", null), "unhealthy");
      assert.strictEqual(parseHealth("Up 10 seconds (health: starting)", null), "starting");
    });

    it("prefers the inspect State.Health.Status when present", () => {
      assert.strictEqual(parseHealth("Up 41 hours (healthy)", "unhealthy"), "unhealthy");
    });

    it("returns null when no healthcheck is configured", () => {
      assert.strictEqual(parseHealth("Up 2 days", null), null);
      assert.strictEqual(parseHealth("Exited (0) 3 hours ago", "none"), null);
      assert.strictEqual(parseHealth(undefined, undefined), null);
    });
  });

  describe("computeCpuPct()", () => {
    it("applies the standard docker delta formula", () => {
      // (200000 / 1000000) * 4 cpus * 100 = 80%
      assert.strictEqual(computeCpuPct(statsFixture()), 80);
    });

    it("falls back to percpu_usage length when online_cpus is missing", () => {
      const stats = statsFixture();
      delete stats.cpu_stats.online_cpus;
      stats.cpu_stats.cpu_usage.percpu_usage = [1, 2];
      assert.strictEqual(computeCpuPct(stats), 40);
    });

    it("returns 0 for non-positive deltas", () => {
      const stats = statsFixture();
      stats.cpu_stats.cpu_usage.total_usage = stats.precpu_stats.cpu_usage.total_usage;
      assert.strictEqual(computeCpuPct(stats), 0);
    });

    it("returns null for missing counters (stopped container / failed fetch)", () => {
      assert.strictEqual(computeCpuPct(null), null);
      assert.strictEqual(computeCpuPct({ cpu_stats: {}, precpu_stats: {} }), null);
    });
  });

  describe("computeMemStats()", () => {
    it("subtracts inactive_file (cgroup v2) from usage and computes pct", () => {
      const { memUsageBytes, memLimitBytes, memPct } = computeMemStats(statsFixture());
      assert.strictEqual(memUsageBytes, 256 * 1024 * 1024);
      assert.strictEqual(memLimitBytes, 1024 * 1024 * 1024);
      assert.strictEqual(memPct, 25);
    });

    it("falls back to cache (cgroup v1) when inactive_file is absent", () => {
      const stats = statsFixture();
      stats.memory_stats.stats = { cache: 100 * 1024 * 1024 };
      const { memUsageBytes } = computeMemStats(stats);
      assert.strictEqual(memUsageBytes, 200 * 1024 * 1024);
    });

    it("returns nulls when memory stats are missing", () => {
      assert.deepStrictEqual(computeMemStats(null), {
        memUsageBytes: null,
        memLimitBytes: null,
        memPct: null,
      });
    });
  });

  describe("summarizePorts()", () => {
    it("formats published and internal ports", () => {
      const ports = summarizePorts(containersFixture()[0].Ports);
      assert.deepStrictEqual(ports, ["127.0.0.1:9000→9000/tcp", "8000/tcp"]);
    });

    it("collapses IPv4/IPv6 wildcard duplicates", () => {
      const ports = summarizePorts(containersFixture()[1].Ports);
      assert.deepStrictEqual(ports, ["18789→3000/tcp"]);
    });

    it("tolerates missing/garbage input", () => {
      assert.deepStrictEqual(summarizePorts(null), []);
      assert.deepStrictEqual(summarizePorts([null, {}]), []);
    });
  });

  describe("isRunningPortainer()", () => {
    it("detects a running portainer container by image or name", () => {
      assert.strictEqual(
        isRunningPortainer({ state: "running", image: "portainer/portainer-ce:lts", name: "x" }),
        true,
      );
      assert.strictEqual(
        isRunningPortainer({ state: "running", image: "custom:1", name: "portainer" }),
        true,
      );
    });

    it("ignores stopped portainer and other containers", () => {
      assert.strictEqual(
        isRunningPortainer({ state: "exited", image: "portainer/portainer-ce:lts", name: "p" }),
        false,
      );
      assert.strictEqual(
        isRunningPortainer({ state: "running", image: "openclaw:latest", name: "openclaw" }),
        false,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Poller + cache
  // -------------------------------------------------------------------------

  describe("_pollOnce() snapshot", () => {
    it("caches all containers with merged list/inspect/stats fields", async () => {
      const log = [];
      const docker = makeDocker(defaultFixtures(), log);
      await docker._pollOnce();
      const state = docker.getState();

      assert.strictEqual(state.available, true);
      assert.strictEqual(state.error, null);
      assert.ok(Number.isFinite(state.lastChecked));
      assert.strictEqual(state.containers.length, 3);

      const portainer = state.containers.find((c) => c.name === "portainer");
      assert.strictEqual(portainer.id12, PORTAINER_ID.slice(0, 12));
      assert.strictEqual(portainer.image, "portainer/portainer-ce:lts");
      assert.strictEqual(portainer.state, "running");
      assert.strictEqual(portainer.health, "healthy");
      assert.strictEqual(portainer.restartCount, 0);
      assert.strictEqual(portainer.createdAt, new Date(1717200000 * 1000).toISOString());
      assert.strictEqual(portainer.startedAt, "2026-06-08T12:00:00.000000000Z");
      assert.deepStrictEqual(portainer.ports, ["127.0.0.1:9000→9000/tcp", "8000/tcp"]);
      assert.strictEqual(portainer.cpuPct, 80);
      assert.strictEqual(portainer.memUsageBytes, 256 * 1024 * 1024);
      assert.strictEqual(portainer.memLimitBytes, 1024 * 1024 * 1024);
      assert.strictEqual(portainer.memPct, 25);

      const openclaw = state.containers.find((c) => c.name === "openclaw");
      assert.strictEqual(openclaw.health, null);
      assert.strictEqual(openclaw.restartCount, 2);

      const hermes = state.containers.find((c) => c.name === "hermes");
      assert.strictEqual(hermes.state, "exited");
      assert.strictEqual(hermes.startedAt, null); // zero-value StartedAt filtered
      assert.strictEqual(hermes.cpuPct, null);
      assert.strictEqual(hermes.memUsageBytes, null);
    });

    it("does not request stats for non-running containers", async () => {
      const log = [];
      const docker = makeDocker(defaultFixtures(), log);
      await docker._pollOnce();
      const statsCalls = log.filter((c) => c.path.includes("/stats"));
      assert.strictEqual(statsCalls.length, 2);
      assert.ok(statsCalls.every((c) => !c.path.includes(HERMES_ID)));
    });

    it("tolerates a per-container stats failure", async () => {
      const fixtures = defaultFixtures();
      fixtures.stats[OPENCLAW_ID] = new Error("stats boom");
      const docker = makeDocker(fixtures, []);
      await docker._pollOnce();
      const openclaw = docker.getState().containers.find((c) => c.name === "openclaw");
      assert.ok(openclaw, "container survives its stats failure");
      assert.strictEqual(openclaw.cpuPct, null);
      assert.strictEqual(openclaw.memPct, null);
    });

    it("tolerates a per-container inspect failure", async () => {
      const fixtures = defaultFixtures();
      fixtures.inspect[PORTAINER_ID] = new Error("inspect boom");
      const docker = makeDocker(fixtures, []);
      await docker._pollOnce();
      const portainer = docker.getState().containers.find((c) => c.name === "portainer");
      assert.ok(portainer);
      assert.strictEqual(portainer.restartCount, null);
      // Health still parsed from the Status string fallback.
      assert.strictEqual(portainer.health, "healthy");
    });

    it(`caps per-container fetch concurrency at ${STATS_CONCURRENCY}`, async () => {
      const list = Array.from({ length: 12 }, (_, i) => ({
        Id: `${String(i).padStart(2, "0")}${"e".repeat(62)}`,
        Names: [`/c${i}`],
        Image: "img:1",
        State: "running",
        Status: "Up 1 hour",
        Created: 1717000000,
        Ports: [],
      }));
      let inFlight = 0;
      let maxInFlight = 0;
      const fetchFn = async (apiPath, _opts) => {
        if (apiPath === `/${V}/containers/json?all=true`) return okResponse(list);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        if (apiPath.includes("/stats")) return okResponse(statsFixture());
        return okResponse(inspectFixture("x"));
      };
      const docker = createDocker({ fetchFn });
      await docker._pollOnce();
      // Each worker runs inspect+stats for one container in parallel (2 reqs),
      // so the request-level ceiling is 2 * STATS_CONCURRENCY.
      assert.ok(
        maxInFlight <= STATS_CONCURRENCY * 2,
        `max in-flight ${maxInFlight} exceeds container concurrency cap`,
      );
      assert.strictEqual(docker.getState().containers.length, 12);
    });
  });

  // -------------------------------------------------------------------------
  // Change events
  // -------------------------------------------------------------------------

  describe("onChange", () => {
    it("fires for every container on the first poll (previous null)", async () => {
      const events = [];
      const docker = makeDocker(defaultFixtures(), [], {
        onChange: (event) => events.push(event),
      });
      await docker._pollOnce();
      assert.strictEqual(events.length, 3);
      assert.ok(events.every((e) => e.previousState === null && e.previousHealth === null));
    });

    it("fires only for state/health transitions on later polls", async () => {
      const fixtures = defaultFixtures();
      const events = [];
      const docker = makeDocker(fixtures, [], { onChange: (e) => events.push(e) });
      await docker._pollOnce();
      events.length = 0;

      await docker._pollOnce(); // nothing changed
      assert.strictEqual(events.length, 0);

      fixtures.list[0].Status = "Up 42 hours (unhealthy)"; // portainer → unhealthy
      fixtures.inspect[PORTAINER_ID] = inspectFixture(PORTAINER_ID, { health: "unhealthy" });
      fixtures.list[2].State = "running"; // hermes restarts
      fixtures.list[2].Status = "Up 2 seconds";
      await docker._pollOnce();

      assert.strictEqual(events.length, 2);
      const unhealthy = events.find((e) => e.container.name === "portainer");
      assert.strictEqual(unhealthy.previousHealth, "healthy");
      assert.strictEqual(unhealthy.container.health, "unhealthy");
      const restarted = events.find((e) => e.container.name === "hermes");
      assert.strictEqual(restarted.previousState, "exited");
      assert.strictEqual(restarted.container.state, "running");
    });

    it("fires a removal event when a container disappears", async () => {
      const fixtures = defaultFixtures();
      const events = [];
      const docker = makeDocker(fixtures, [], { onChange: (e) => events.push(e) });
      await docker._pollOnce();
      events.length = 0;

      fixtures.list = fixtures.list.filter((c) => c.Id !== HERMES_ID);
      await docker._pollOnce();
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].container.state, "removed");
      assert.strictEqual(events[0].previousState, "exited");
    });

    it("survives a throwing onChange callback", async () => {
      const docker = makeDocker(defaultFixtures(), [], {
        onChange: () => {
          throw new Error("subscriber bug");
        },
      });
      await docker._pollOnce();
      assert.strictEqual(docker.getState().available, true);
    });
  });

  // -------------------------------------------------------------------------
  // Unavailability
  // -------------------------------------------------------------------------

  describe("unavailability", () => {
    it("reports a clear diagnostic when the socket is missing", async () => {
      const err = Object.assign(new Error("connect ENOENT /var/run/docker.sock"), {
        code: "ENOENT",
      });
      const docker = createDocker({
        fetchFn: async () => {
          throw err;
        },
        socketPath: "/var/run/docker.sock",
      });
      await docker._pollOnce();
      const state = docker.getState();
      assert.strictEqual(state.available, false);
      assert.deepStrictEqual(state.containers, []);
      assert.match(state.error, /Docker socket not found at \/var\/run\/docker\.sock/);
    });

    it("reports permission denied distinctly", async () => {
      const err = Object.assign(new Error("EACCES"), { code: "EACCES" });
      const docker = createDocker({
        fetchFn: async () => {
          throw err;
        },
      });
      await docker._pollOnce();
      assert.match(docker.getState().error, /Permission denied .* docker group/);
    });

    it("does not fire spurious change events across an outage", async () => {
      const fixtures = defaultFixtures();
      const events = [];
      const docker = makeDocker(fixtures, [], { onChange: (e) => events.push(e) });
      await docker._pollOnce();
      events.length = 0;

      fixtures.listError = Object.assign(new Error("down"), { code: "ECONNREFUSED" });
      await docker._pollOnce();
      assert.strictEqual(docker.getState().available, false);

      delete fixtures.listError;
      await docker._pollOnce(); // same containers come back unchanged
      assert.strictEqual(events.length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Read-only guarantee
  // -------------------------------------------------------------------------

  describe("read-only guarantee", () => {
    it("never issues a non-GET request across full poll cycles", async () => {
      const log = [];
      const docker = makeDocker(defaultFixtures(), log, { portainerUrl: "https://x:9445" });
      await docker._pollOnce();
      await docker._pollOnce();
      docker.getState();

      assert.ok(log.length >= 8, "expected list + inspect + stats calls to be logged");
      for (const call of log) {
        assert.strictEqual(call.options.method, "GET", `non-GET issued: ${call.path}`);
      }
    });

    it("exposes no mutation surface (only GET routes, no method params)", () => {
      const docker = createDocker({ fetchFn: async () => okResponse([]) });
      assert.deepStrictEqual(Object.keys(docker.routes), ["GET /api/docker"]);
      assert.deepStrictEqual(Object.keys(docker).sort(), [
        "_pollOnce",
        "getState",
        "routes",
        "start",
        "stop",
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Portainer link + routes map
  // -------------------------------------------------------------------------

  describe("portainer link", () => {
    it("exposes portainerUrl only when configured AND a portainer is running", async () => {
      const fixtures = defaultFixtures();
      const docker = makeDocker(fixtures, [], { portainerUrl: "https://host:9445" });
      await docker._pollOnce();
      assert.strictEqual(docker.getState().portainerUrl, "https://host:9445");

      fixtures.list[0].State = "exited";
      await docker._pollOnce();
      assert.strictEqual(docker.getState().portainerUrl, null);
    });

    it("omits the link when no portainerUrl is configured", async () => {
      const docker = makeDocker(defaultFixtures(), []);
      await docker._pollOnce();
      assert.strictEqual(docker.getState().portainerUrl, null);
    });
  });

  describe("routes map", () => {
    it("serves the cached state as JSON on GET /api/docker", async () => {
      const docker = makeDocker(defaultFixtures(), []);
      await docker._pollOnce();

      let statusCode = null;
      let headers = null;
      let body = null;
      const res = {
        writeHead: (code, hdrs) => {
          statusCode = code;
          headers = hdrs;
        },
        end: (payload) => {
          body = payload;
        },
      };
      await docker.routes["GET /api/docker"]({}, res);

      assert.strictEqual(statusCode, 200);
      assert.strictEqual(headers["Content-Type"], "application/json");
      const parsed = JSON.parse(body);
      assert.strictEqual(parsed.available, true);
      assert.strictEqual(parsed.containers.length, 3);
      assert.strictEqual(parsed.containers[0].id12.length, 12);
    });
  });
});
