/**
 * Agent Spawn — on-demand isolated-worker pool controller (Phase 3, PRD-001).
 *
 * Manages a warm pool of pre-stopped worker containers: starts them with
 * `docker start`, gates registration behind a readiness probe, leases them for
 * a single run, and recycles/reaps/reconciles the pool — all self-healing.
 *
 * The controller is a no-op when `config.fleet.spawn.enabled !== true` (AC-1):
 * constructing it touches neither docker nor mesh, and every public method
 * fails closed with a typed reason.
 *
 * Worker identity is `(nodeId, generation)` everywhere (lease, fencing stamp,
 * reconcile). `generation` increments on every `docker start` of a given
 * container, so an ABA (recycled container reused after a recycle) can never
 * alias a stale lease or a stale result.
 *
 * Implemented ACs: AC-1 (factory/gate), AC-2 (warm start), AC-3 (cap verify),
 * AC-4 (idle reaper), AC-5 (readiness gate), AC-6 (atomic CAS state machine),
 * AC-7 (leaked-registration eviction), AC-8 (reconcile loop), AC-9 (max-lifetime
 * recycle), AC-10 (bounded per-agent queue), AC-12 (drain semantics), AC-15
 * (capacity governor).
 *
 * Dependencies are injected so tests stub them:
 *   docker  — { ps, start, stop, inspect, subscribeEvents }
 *   mesh    — { registerNode, unregisterNode, getState } (the existing mesh)
 *   roster  — { getRoster } (admission reads byNode active/subagentsMax)
 *   store   — { nextToken } (fencing tokens from spawn-store)
 *   logger  — { info, warn, error }
 */

// Pool label every warm worker container carries — discovered, never hard-coded.
const POOL_LABEL = "com.ofc.pool";
const POOL_LABEL_VALUE = "worker";

// Worker lifecycle states (AC-6).
const STATE = Object.freeze({
  IDLE: "idle",
  LEASED: "leased",
  DRAINING: "draining",
  REMOVED: "removed",
});

// Typed admission/lease rejection reasons (AC-10 / AC-15 / AC-22).
const REASON = Object.freeze({
  DISABLED: "disabled",
  QUEUED: "queued",
  QUEUE_FULL: "queue_full",
  QUEUE_TIMEOUT: "queue_timeout",
  CAPACITY: "capacity",
  READINESS: "readiness",
  MISCAP: "miscap",
  NO_WORKER: "no_worker",
});

const BYTES_PER_GIB = 1024 * 1024 * 1024;

/** Escape a string for safe literal embedding in a RegExp (H-2 prefix). */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Create the spawn controller.
 *
 * @param {object} options
 * @param {object} options.config - resolved config; reads config.fleet.spawn.*
 * @param {object} options.mesh - mesh module ({registerNode, unregisterNode, getState})
 * @param {object} options.roster - roster module ({getRoster})
 * @param {object} options.store - spawn store ({nextToken})
 * @param {object} options.docker - injected docker interface ({ps,start,stop,inspect,subscribeEvents})
 * @param {object} [options.logger=console] - logger ({info,warn,error})
 * @param {function} [options.nowFn=Date.now] - injectable clock
 * @param {function} [options.jitterFn] - injectable [0,1) jitter (for AC-9 spread)
 * @returns {object} controller
 */
function createAgentSpawn({
  config,
  mesh,
  roster,
  store,
  docker,
  logger = console,
  nowFn = Date.now,
  jitterFn = Math.random,
  probeHealthFn = null,
  readMemAvailableFn = null,
} = {}) {
  const spawnCfg = (config && config.fleet && config.fleet.spawn) || {};
  const enabled = spawnCfg.enabled === true;

  // H-2 — instance-scoped roster prefix. Pool membership is bound to a rendered
  // name `^<prefix>-worker-[a-z0-9-]+$`, NOT the bare `com.ofc.pool` label, so a
  // foreign container that merely carries the label cannot be adopted into THIS
  // controller's roster. The prefix is sourced from config (explicit
  // `fleet.spawn.workerNamePrefix`, else the instance identity
  // `fleet.dispatch.node`). When unset we FAIL CLOSED: no name can match, so the
  // controller registers nothing (defence in depth — an unconfigured controller
  // never trusts a label alone).
  const workerNamePrefix =
    (spawnCfg.workerNamePrefix && String(spawnCfg.workerNamePrefix).trim()) ||
    (config &&
      config.fleet &&
      config.fleet.dispatch &&
      typeof config.fleet.dispatch.node === "string" &&
      config.fleet.dispatch.node.trim()) ||
    "";
  // Built only when a prefix is known; null = fail closed (matches nothing).
  const workerNamePattern = workerNamePrefix
    ? new RegExp(`^${escapeRegExp(workerNamePrefix)}-worker-[a-z0-9-]+$`)
    : null;

  /**
   * Whether a container name belongs to THIS instance's worker roster.
   * Fail closed when no prefix is configured (pattern null → never matches).
   * @param {string} name
   * @returns {boolean}
   */
  function isInstanceWorkerName(name) {
    if (typeof name !== "string" || name.length === 0) return false;
    if (!workerNamePattern) return false;
    return workerNamePattern.test(name);
  }

  // ---------------------------------------------------------------------
  // In-memory pool state. Keyed by workerId (the container name/id, stable
  // across docker start). Each entry carries the CAS-guarded (state, generation)
  // pair plus bookkeeping for the reaper/recycle/reconcile loops.
  // ---------------------------------------------------------------------
  // workerId -> {
  //   workerId, containerName, nodeId|null, generation, state,
  //   idleSince, startedAt, recycleAt, token|null, registered
  // }
  const pool = new Map();

  // Per-advisor bounded queues (AC-10). advisorId -> Array<queueEntry>.
  const queues = new Map();

  // Docker /events unsubscribe handle (AC-7).
  let eventsUnsub = null;
  // Loop timers (AC-4 reaper, AC-8 reconcile).
  let reaperTimer = null;
  let reconcileTimer = null;
  let registrationTimer = null;

  // -------------------------------------------------------------------------
  // AC-6 — Atomic compare-and-set state machine.
  //
  // Every transition is compare-and-set on (workerId, expectedState,
  // expectedGeneration). A CAS that loses (worker gone, state mismatch, or
  // generation mismatch) returns false and performs NO side effect. This is
  // the single mutual-exclusion primitive that gates leasing, reaping,
  // draining and recycling — eliminating the reaper-vs-dispatch TOCTOU.
  //
  // JS is single-threaded, but async interleaving between awaits is the real
  // race surface: two callers can each read `idle` before either commits.
  // CAS makes the read+write indivisible (no await between check and set).
  // -------------------------------------------------------------------------
  const VALID_TRANSITIONS = new Map([
    [`${STATE.IDLE}->${STATE.LEASED}`, true],
    [`${STATE.IDLE}->${STATE.DRAINING}`, true],
    [`${STATE.LEASED}->${STATE.IDLE}`, true],
    [`${STATE.LEASED}->${STATE.DRAINING}`, true],
    [`${STATE.DRAINING}->${STATE.REMOVED}`, true],
  ]);

  /**
   * Compare-and-set a worker's state. Returns true only when the worker exists,
   * its current state === expectedState, its generation === expectedGeneration,
   * and the transition is legal. Otherwise returns false and mutates nothing.
   *
   * @param {string} workerId
   * @param {string} expectedState
   * @param {string} nextState
   * @param {number} expectedGeneration
   * @param {object} [patch] - extra fields to merge atomically on success
   * @returns {boolean}
   */
  function cas(workerId, expectedState, nextState, expectedGeneration, patch = {}) {
    const w = pool.get(workerId);
    if (!w) return false;
    if (w.state !== expectedState) return false;
    if (w.generation !== expectedGeneration) return false;
    if (!VALID_TRANSITIONS.get(`${expectedState}->${nextState}`)) return false;
    // Indivisible commit — no await between the checks above and this write.
    w.state = nextState;
    if (nextState === STATE.IDLE) w.idleSince = nowFn();
    Object.assign(w, patch);
    return true;
  }

  // -------------------------------------------------------------------------
  // AC-15 — Capacity governor.
  //
  // Before any spawn, refuse if the projected footprint would breach the RAM
  // budget OR a live free-RAM read is below the next worker's footprint + a
  // safety margin. Swap is NEVER counted as headroom.
  // -------------------------------------------------------------------------
  function activeWorkerCount() {
    let n = 0;
    for (const w of pool.values()) {
      if (w.state === STATE.LEASED || w.state === STATE.IDLE || w.state === STATE.DRAINING) n++;
    }
    return n;
  }

  /**
   * @param {function} [readMemAvailableFn] - returns MemAvailable bytes (live free RAM)
   * @returns {{ ok: boolean, reason: string|null }}
   */
  function admitCapacity(readMemAvailableFn) {
    const workerMem = Number(spawnCfg.workerMemBytes) || Math.round(2.5 * BYTES_PER_GIB);
    const poolCeiling = Number(spawnCfg.poolCeiling) || 8;
    const ramBudget = Number(spawnCfg.ramBudgetBytes) || Math.floor(0.8 * 32 * BYTES_PER_GIB);
    const baseBytes = 5 * BYTES_PER_GIB; // ~5 GiB base (OFC + sidecar + OS)
    const margin = Math.round(0.5 * BYTES_PER_GIB); // safety margin above next footprint

    const active = activeWorkerCount();

    // Hard count ceiling first (target peak 4–6, ceiling ~8).
    if (active >= poolCeiling) return { ok: false, reason: REASON.CAPACITY };

    // Projected footprint after spawning one more: (active+1)*workerMem + base.
    const projected = (active + 1) * workerMem + baseBytes;
    if (projected > ramBudget) return { ok: false, reason: REASON.CAPACITY };

    // Live free-RAM read: refuse if MemAvailable < next worker footprint + margin.
    if (typeof readMemAvailableFn === "function") {
      let memAvailable;
      try {
        memAvailable = Number(readMemAvailableFn());
      } catch (e) {
        memAvailable = NaN;
      }
      if (Number.isFinite(memAvailable) && memAvailable < workerMem + margin) {
        return { ok: false, reason: REASON.CAPACITY };
      }
    }

    return { ok: true, reason: null };
  }

  // -------------------------------------------------------------------------
  // AC-2 — Warm start: discover a pre-stopped, pool-labelled container and
  // `docker start` it (NOT docker run, NOT CRIU). Names are discovered from
  // `docker ps -a` filtered by the pool label — never hard-coded.
  // -------------------------------------------------------------------------

  /**
   * List pool containers (running + stopped) via docker ps -a, filtered by the
   * pool label. Returns the raw container descriptors the docker iface yields.
   */
  async function listPoolContainers() {
    return docker.ps({
      all: true,
      filters: { label: [`${POOL_LABEL}=${POOL_LABEL_VALUE}`] },
    });
  }

  /**
   * Find a pre-stopped pool container not already tracked in the pool.
   * @param {Array} containers
   * @returns {object|null}
   */
  function findStoppedWorker(containers) {
    if (!Array.isArray(containers)) return null;
    for (const c of containers) {
      const name = containerName(c);
      const state = String(c.State || c.state || "").toLowerCase();
      const tracked = pool.get(name);
      const isStopped = state !== "running" || c.running === false;
      if (isStopped && (!tracked || tracked.state === STATE.REMOVED)) {
        return c;
      }
    }
    return null;
  }

  function containerName(c) {
    if (!c) return "";
    if (Array.isArray(c.Names) && c.Names.length) return c.Names[0].replace(/^\//, "");
    if (typeof c.Name === "string") return c.Name.replace(/^\//, "");
    if (typeof c.name === "string") return c.name.replace(/^\//, "");
    if (typeof c.Id === "string") return c.Id;
    if (typeof c.id === "string") return c.id;
    return "";
  }

  // -------------------------------------------------------------------------
  // AC-3 — Verify the started container's resource cap (memory.max = 2.5 GiB,
  // swap.max = 0, i.e. MemorySwap === Memory). Mis-capped → drain + fail closed.
  // -------------------------------------------------------------------------
  function verifyCap(inspect) {
    const hostConfig = (inspect && (inspect.HostConfig || inspect.hostConfig)) || {};
    const mem = Number(hostConfig.Memory);
    const memSwap = Number(hostConfig.MemorySwap);
    const expected = Number(spawnCfg.workerMemBytes) || 2684354560;
    if (mem !== expected) return false;
    if (memSwap !== mem) return false;
    return true;
  }

  // -------------------------------------------------------------------------
  // AC-5 — Readiness gate: poll the worker's /health and register in the mesh
  // LAST, only after N consecutive OKs within readinessTimeoutMs. Permanent
  // failure → drain, never register.
  // -------------------------------------------------------------------------
  /**
   * @param {object} worker - pool entry
   * @param {function} probeFn - async () => boolean (one /health probe)
   * @returns {Promise<boolean>} true once N consecutive OKs are observed
   */
  async function awaitReadiness(worker, probeFn) {
    const needed = Number(spawnCfg.readinessOks) || 3;
    const timeoutMs = Number(spawnCfg.readinessTimeoutMs) || 10000;
    const deadline = nowFn() + timeoutMs;
    let consecutive = 0;
    while (nowFn() < deadline) {
      let ok = false;
      try {
        ok = (await probeFn(worker)) === true;
      } catch (e) {
        ok = false;
      }
      consecutive = ok ? consecutive + 1 : 0;
      if (consecutive >= needed) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // AC-12 — Drain semantics: CAS→draining, refuse new leases, let the in-flight
  // lease settle (the caller awaits the lease completion before stop), then
  // graceful `docker stop` (stop_grace_period) and unregister. Never docker
  // kill a live lease.
  // -------------------------------------------------------------------------
  /**
   * Begin draining a worker. From idle this is immediate; from leased it just
   * marks draining (the lease settles, then settleAndRemove finishes it).
   * @returns {boolean} whether the drain transition was applied
   */
  function beginDrain(workerId) {
    const w = pool.get(workerId);
    if (!w) return false;
    if (w.state === STATE.IDLE) return cas(workerId, STATE.IDLE, STATE.DRAINING, w.generation);
    if (w.state === STATE.LEASED) return cas(workerId, STATE.LEASED, STATE.DRAINING, w.generation);
    return false; // already draining/removed
  }

  /**
   * Finish a draining worker: graceful stop + unregister + CAS-remove. Safe to
   * call only on a worker already in `draining`.
   */
  async function settleAndRemove(workerId) {
    const w = pool.get(workerId);
    if (!w || w.state !== STATE.DRAINING) return false;
    const gen = w.generation;
    // Graceful stop (stop_grace_period honoured by docker). NEVER kill.
    try {
      await docker.stop(w.containerName, { graceful: true });
    } catch (e) {
      logger.warn(`[AgentSpawn] docker stop failed for ${w.containerName}: ${e.message}`);
    }
    await unregisterWorker(w);
    // CAS draining→removed; losing means someone else already removed it.
    cas(workerId, STATE.DRAINING, STATE.REMOVED, gen, { registered: false, nodeId: null });
    pool.delete(workerId);
    return true;
  }

  /** Unregister a worker's mesh node (tolerating 404 / already-gone). */
  async function unregisterWorker(w) {
    if (!w || !w.nodeId) return;
    try {
      await mesh.unregisterNode(w.nodeId);
    } catch (e) {
      // Tolerate 404 / unknown-node — the registration is gone either way.
      logger.warn(`[AgentSpawn] unregister tolerated for ${w.nodeId}: ${e.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // AC-7 — Leaked-registration eviction.
  //   (a) TTL refresh while alive; a lapsed TTL → unregister + CAS-remove.
  //   (b) Docker /events subscription: on worker die/oom/stop → auto-DELETE the
  //       node (tolerate 404) + CAS-remove from the pool.
  // -------------------------------------------------------------------------
  function refreshRegistrations() {
    const ttl = Number(spawnCfg.registrationTtlMs) || 300000;
    const now = nowFn();
    for (const w of [...pool.values()]) {
      if (!w.registered) continue;
      if (w.registeredAt != null && now - w.registeredAt > ttl) {
        // TTL lapsed — treat as leaked; evict (unregister + CAS-remove).
        logger.warn(`[AgentSpawn] registration TTL lapsed for ${w.nodeId}; evicting`);
        void evictDead(w.workerId);
      } else {
        // Still alive — refresh the TTL window.
        w.registeredAt = now;
      }
    }
  }

  /** Auto-unregister + CAS-remove a worker the daemon told us has died. */
  async function evictDead(workerId) {
    const w = pool.get(workerId);
    if (!w) return;
    await unregisterWorker(w);
    // Force-remove regardless of current state: a dead container can't serve.
    w.state = STATE.DRAINING; // normalise so settle/remove is legal
    cas(workerId, STATE.DRAINING, STATE.REMOVED, w.generation, {
      registered: false,
      nodeId: null,
    });
    pool.delete(workerId);
  }

  function onDockerEvent(evt) {
    if (!evt || typeof evt !== "object") return;
    const action = String(evt.Action || evt.action || "").toLowerCase();
    const isDeath = action === "die" || action === "oom" || action === "stop" || action === "kill";
    if (!isDeath) return;

    // H-1 (a) — re-verify the event actor still carries OUR pool label. A die
    // event for a like-named container that is NOT a pool worker (no
    // `com.ofc.pool=worker` label) must be ignored — it is not ours to evict.
    if (!eventCarriesPoolLabel(evt)) return;

    const name = eventContainerName(evt);
    if (!name) return;
    const tracked = pool.get(name);
    if (!tracked) return;

    // H-1 (b) — bind eviction to the tracked container's recorded ID. The event
    // ID must match the generation we are tracking under this name; a name
    // collision across recycle generations (same name, different container ID)
    // must NOT evict the live worker. If we never recorded an ID we fall back to
    // name-only (legacy adopt path) — but a present, mismatched ID is rejected.
    const evtId = eventContainerId(evt);
    if (tracked.containerId && evtId && evtId !== tracked.containerId) {
      logger.warn(
        `[AgentSpawn] ignoring die event for ${name}: container id ${evtId} ` +
          `does not match tracked id ${tracked.containerId} (name collision)`,
      );
      return;
    }

    void evictDead(name);
  }

  /**
   * H-1 — true when the docker event's actor attributes carry our pool label.
   * Docker stamps the container's labels onto `Actor.Attributes` for lifecycle
   * events, so `com.ofc.pool` is observable on the event itself.
   */
  function eventCarriesPoolLabel(evt) {
    const actor = evt.Actor || evt.actor;
    const attrs = (actor && (actor.Attributes || actor.attributes)) || null;
    if (!attrs || typeof attrs !== "object") return false;
    return attrs[POOL_LABEL] === POOL_LABEL_VALUE;
  }

  function eventContainerName(evt) {
    const actor = evt.Actor || evt.actor;
    const attrs = (actor && (actor.Attributes || actor.attributes)) || null;
    if (attrs && typeof attrs.name === "string") {
      return attrs.name.replace(/^\//, "");
    }
    if (typeof evt.name === "string") return evt.name.replace(/^\//, "");
    return "";
  }

  /** The container ID an event refers to (Actor.ID is the docker truth). */
  function eventContainerId(evt) {
    const actor = evt.Actor || evt.actor;
    if (actor && typeof actor.ID === "string" && actor.ID) return actor.ID;
    if (actor && typeof actor.id === "string" && actor.id) return actor.id;
    if (typeof evt.id === "string" && evt.id) return evt.id;
    if (typeof evt.Id === "string" && evt.Id) return evt.Id;
    return null;
  }

  // -------------------------------------------------------------------------
  // AC-8 — Reconciliation loop. Rebuild pool from docker ps (live truth) vs the
  // mesh registry vs the desired pool size. Present-but-unregistered → register
  // (after readiness) or stop; registered-but-absent → unregister. Converges.
  //
  // Injected probes keep this unit-testable; the live wiring supplies HTTP
  // /health + /proc/meminfo readers.
  // -------------------------------------------------------------------------
  /**
   * @param {object} [opts]
   * @param {function} [opts.probeFn] - readiness probe for present-but-unregistered
   * @returns {Promise<{registered: number, unregistered: number, stopped: number}>}
   */
  async function reconcile(opts = {}) {
    if (!enabled) return { registered: 0, unregistered: 0, stopped: 0 };
    const probeFn = opts.probeFn || probeHealthFn || (async () => true);

    const [containers, meshState] = await Promise.all([
      listPoolContainers().catch(() => []),
      Promise.resolve(mesh.getState ? mesh.getState() : { nodes: [] }).catch(() => ({ nodes: [] })),
    ]);
    const meshNodes = Array.isArray(meshState && meshState.nodes) ? meshState.nodes : [];
    const meshByName = new Map();
    for (const n of meshNodes) {
      if (n && typeof n.hostname === "string") meshByName.set(n.hostname, n);
    }

    const liveNames = new Set();
    let registered = 0;
    let unregistered = 0;
    let stopped = 0;

    // Pass 1: walk live containers (docker ps truth).
    for (const c of Array.isArray(containers) ? containers : []) {
      const name = containerName(c);
      if (!name) continue;
      const state = String(c.State || c.state || "").toLowerCase();
      const isRunning = state === "running" || c.running === true;
      if (!isRunning) continue;

      // H-2 — the `com.ofc.pool` label is NOT a fleet-trust boundary. A container
      // is only this instance's worker if its name ALSO matches the rendered
      // instance pattern `^<prefix>-worker-...$`. A labelled-but-non-matching
      // container is foreign: never register, never adopt, never count it live
      // (so Pass 2 won't unregister a genuine node on its behalf).
      if (!isInstanceWorkerName(name)) {
        logger.warn(
          `[AgentSpawn] reconcile: container ${name} carries the pool label but does not ` +
            `match this instance's worker pattern; refusing to register/adopt`,
        );
        continue;
      }
      liveNames.add(name);

      const inMesh = meshByName.has(name);
      const tracked = pool.get(name);

      if (inMesh && tracked) continue; // already converged

      // present-but-unregistered: bring it into the desired pool if there is
      // room, else stop it.
      if (!inMesh) {
        const cap = admitCapacity(opts.readMemAvailableFn || readMemAvailableFn);
        if (!cap.ok) {
          try {
            await docker.stop(name, { graceful: true });
            stopped++;
          } catch (e) {
            logger.warn(`[AgentSpawn] reconcile stop failed for ${name}: ${e.message}`);
          }
          continue;
        }
        const worker = trackWorker(name, { running: true, containerId: containerIdOf(c) });
        const ready = await awaitReadiness(worker, probeFn);
        if (!ready) {
          beginDrain(worker.workerId);
          await settleAndRemove(worker.workerId);
          stopped++;
          continue;
        }
        const ok = await registerWorker(worker, c);
        if (ok) registered++;
      } else if (inMesh && !tracked) {
        // mesh knows it, pool lost track (post-crash): re-adopt as registered.
        const node = meshByName.get(name);
        const worker = trackWorker(name, { running: true, containerId: containerIdOf(c) });
        worker.registered = true;
        worker.nodeId = node && node.id ? node.id : null;
        worker.registeredAt = nowFn();
        cas(worker.workerId, STATE.IDLE, STATE.IDLE, worker.generation); // idempotent touch
      }
    }

    // Pass 2: registered-but-absent — mesh node with no live container → unregister.
    for (const n of meshNodes) {
      if (!n || typeof n.hostname !== "string") continue;
      if (!isPoolNode(n)) continue;
      if (liveNames.has(n.hostname)) continue;
      try {
        await mesh.unregisterNode(n.id || n.hostname);
        unregistered++;
      } catch (e) {
        logger.warn(`[AgentSpawn] reconcile unregister tolerated: ${e.message}`);
      }
      const tracked = pool.get(n.hostname);
      if (tracked) {
        tracked.state = STATE.DRAINING;
        cas(n.hostname, STATE.DRAINING, STATE.REMOVED, tracked.generation);
        pool.delete(n.hostname);
      }
    }

    return { registered, unregistered, stopped };
  }

  /** Whether a mesh node record belongs to this pool (by label convention). */
  function isPoolNode(node) {
    // Pool nodes are registered by this controller with registeredBy "spawn".
    return node && (node.registeredBy === "spawn" || node.label === POOL_LABEL_VALUE);
  }

  // -------------------------------------------------------------------------
  // Worker tracking + registration helpers.
  // -------------------------------------------------------------------------
  /**
   * Create or re-key a pool entry, bumping the generation on each (re)start so
   * an ABA recycled container never aliases a stale lease (worker identity is
   * (nodeId, generation)).
   */
  function trackWorker(containerName, { running, containerId } = {}) {
    const existing = pool.get(containerName);
    const generation = existing ? existing.generation + 1 : 0;
    const worker = {
      workerId: containerName,
      containerName,
      // H-1 — record the docker container ID so eviction can bind to the exact
      // tracked container, not just the name (a recycled-name collision across
      // generations must never evict a different container).
      containerId: containerId || null,
      nodeId: null,
      generation,
      state: STATE.IDLE,
      idleSince: nowFn(),
      startedAt: nowFn(),
      recycleAt: computeRecycleAt(),
      token: null,
      registered: false,
      registeredAt: null,
    };
    pool.set(containerName, worker);
    return worker;
  }

  /** Extract the docker container ID from a ps/inspect descriptor. */
  function containerIdOf(c) {
    if (!c) return null;
    if (typeof c.Id === "string" && c.Id) return c.Id;
    if (typeof c.id === "string" && c.id) return c.id;
    return null;
  }

  function computeRecycleAt() {
    const base = Number(spawnCfg.maxLifetimeMs) || 3600000;
    const jitterWindow = Number(spawnCfg.recycleJitterMs) || 5000;
    const jitter = Math.floor(jitterFn() * jitterWindow);
    return nowFn() + base + jitter;
  }

  /** Register a ready worker in the mesh LAST (AC-5), recording its node id. */
  async function registerWorker(worker, container) {
    // H-2 — fail closed: never register a worker whose container name is not in
    // THIS instance's roster pattern. This is the single registration choke
    // point, so the pattern check here guards acquireWorker AND reconcile, and
    // an unconfigured controller (no prefix → pattern null) registers nothing.
    if (!isInstanceWorkerName(worker.containerName)) {
      logger.warn(
        `[AgentSpawn] refusing to register ${worker.containerName}: not an instance worker name`,
      );
      return false;
    }
    try {
      const port = workerPort(container);
      const record = await mesh.registerNode({
        hostname: worker.containerName,
        port,
        healthPath: workerHealthPath(container),
        platform: "linux",
        label: POOL_LABEL_VALUE,
        registeredBy: "spawn",
      });
      worker.nodeId = record && record.id ? record.id : null;
      worker.registered = true;
      worker.registeredAt = nowFn();
      return true;
    } catch (e) {
      logger.warn(`[AgentSpawn] register failed for ${worker.containerName}: ${e.message}`);
      return false;
    }
  }

  // H-2 — the health-probe / dispatch port is pinned from the controller's OWN
  // config (`fleet.spawn.workerPort`), NOT read from a container label as
  // authority. A container can set `com.ofc.pool.port` to anything; trusting it
  // would let a foreign/compromised container redirect the controller's probes
  // and dispatch to an arbitrary port. When a pinned port is configured it wins
  // unconditionally; only when UNPINNED do we fall back to the label value (and
  // even then only after the name-pattern trust check in reconcile/register has
  // already passed).
  function pinnedWorkerPort() {
    const p = Number(spawnCfg.workerPort);
    return Number.isInteger(p) && p > 0 && p <= 65535 ? p : null;
  }

  function workerPort(container) {
    const pinned = pinnedWorkerPort();
    if (pinned !== null) return pinned;
    const labels = (container && (container.Labels || container.labels)) || {};
    const p = Number(labels[`${POOL_LABEL}.port`]);
    return Number.isInteger(p) && p > 0 && p <= 65535 ? p : 443;
  }

  function workerHealthPath(container) {
    const labels = (container && (container.Labels || container.labels)) || {};
    const hp = labels[`${POOL_LABEL}.healthPath`];
    return typeof hp === "string" && hp.startsWith("/") ? hp : "/api/health";
  }

  // -------------------------------------------------------------------------
  // AC-2 + AC-3 + AC-5 — acquireWorker: the full warm-acquire path, fail-closed.
  // -------------------------------------------------------------------------
  /**
   * Acquire (warm-start + verify + ready + register) a worker for an advisor.
   *
   * @param {string} advisorId
   * @param {object} [opts]
   * @param {function} [opts.probeFn] - readiness probe (async worker => boolean)
   * @param {function} [opts.readMemAvailableFn] - live MemAvailable bytes reader
   * @returns {Promise<{ok: boolean, worker?: object, reason?: string}>}
   */
  async function acquireWorker(advisorId, opts = {}) {
    if (!enabled) return { ok: false, reason: REASON.DISABLED };

    // AC-15 — capacity governor BEFORE any spawn.
    const cap = admitCapacity(opts.readMemAvailableFn || readMemAvailableFn);
    if (!cap.ok) return { ok: false, reason: cap.reason };

    // AC-2 — discover a pre-stopped, labelled container; docker start it.
    const containers = await listPoolContainers();
    const target = findStoppedWorker(containers);
    if (!target) return { ok: false, reason: REASON.NO_WORKER };

    const name = containerName(target);
    await docker.start(name);
    const worker = trackWorker(name, { running: true, containerId: containerIdOf(target) });

    // AC-3 — verify the cap on the *started* container; mis-cap → drain + fail.
    const inspect = await docker.inspect(name);
    if (!verifyCap(inspect)) {
      logger.warn(`[AgentSpawn] worker ${name} mis-capped; draining`);
      beginDrain(worker.workerId);
      await settleAndRemove(worker.workerId);
      return { ok: false, reason: REASON.MISCAP };
    }

    // AC-5 — readiness gate; register LAST after N consecutive OKs.
    // Use the caller-supplied probeFn first, then the constructor-injected
    // probeHealthFn (the live HTTP probe wired in src/index.js when enabled),
    // and finally the always-true stub so disabled-path unit tests stay inert.
    const probeFn = opts.probeFn || probeHealthFn || (async () => true);
    const ready = await awaitReadiness(worker, probeFn);
    if (!ready) {
      logger.warn(`[AgentSpawn] worker ${name} never reached readiness; draining`);
      beginDrain(worker.workerId);
      await settleAndRemove(worker.workerId);
      return { ok: false, reason: REASON.READINESS };
    }

    const registered = await registerWorker(worker, inspect.Config ? inspect : target);
    if (!registered) {
      beginDrain(worker.workerId);
      await settleAndRemove(worker.workerId);
      return { ok: false, reason: REASON.READINESS };
    }

    return { ok: true, worker };
  }

  // -------------------------------------------------------------------------
  // Leasing — CAS idle→leased, stamp a fencing token (AC-6 + AC-14 stamp).
  // -------------------------------------------------------------------------
  /**
   * Lease an idle worker. CAS idle→leased; on success stamp a fresh fencing
   * token. Returns the lease handle, or null when the CAS lost (someone else
   * leased/drained it first).
   *
   * @param {string} workerId
   * @returns {{ workerId, nodeId, generation, token }|null}
   */
  function lease(workerId) {
    if (!enabled) return null;
    const w = pool.get(workerId);
    if (!w || w.state !== STATE.IDLE) return null;
    const token = store && typeof store.nextToken === "function" ? store.nextToken() : null;
    const ok = cas(workerId, STATE.IDLE, STATE.LEASED, w.generation, { token });
    if (!ok) return null;
    return { workerId, nodeId: w.nodeId, generation: w.generation, token };
  }

  /**
   * Release a lease back to idle (lease settled). CAS leased→idle keyed on the
   * lease's generation; a generation mismatch (worker was recycled) loses.
   * @returns {boolean}
   */
  function release(workerId, generation) {
    const w = pool.get(workerId);
    if (!w) return false;
    return cas(workerId, STATE.LEASED, STATE.IDLE, generation);
  }

  // -------------------------------------------------------------------------
  // AC-4 — Idle reaper. idle >= idleReapMs → drain + stop + unregister.
  // Never touches leased/draining workers.
  // -------------------------------------------------------------------------
  async function reapIdle() {
    if (!enabled) return 0;
    const idleReapMs = Number(spawnCfg.idleReapMs) || 60000;
    const now = nowFn();
    let reaped = 0;
    for (const w of [...pool.values()]) {
      if (w.state !== STATE.IDLE) continue; // never leased/draining
      if (now - w.idleSince < idleReapMs) continue;
      if (beginDrain(w.workerId)) {
        await settleAndRemove(w.workerId);
        reaped++;
      }
    }
    return reaped;
  }

  // -------------------------------------------------------------------------
  // AC-9 — Max-lifetime recycle. Worker older than recycleAt (maxLifetime +
  // jitter) is drained (finish current lease, refuse new), then stopped +
  // unregistered, optionally respawned. NEVER kills an in-flight run.
  // -------------------------------------------------------------------------
  async function recycleAged() {
    if (!enabled) return 0;
    const now = nowFn();
    let recycled = 0;
    for (const w of [...pool.values()]) {
      if (w.state === STATE.DRAINING || w.state === STATE.REMOVED) continue;
      if (now < w.recycleAt) continue;
      if (w.state === STATE.LEASED) {
        // Drain: refuse new leases; the in-flight lease finishes on release().
        cas(w.workerId, STATE.LEASED, STATE.DRAINING, w.generation);
        // settleAndRemove is deferred to release()/explicit settle — do not
        // stop a live lease here (AC-12: never docker kill a live lease).
        recycled++;
      } else if (w.state === STATE.IDLE) {
        if (beginDrain(w.workerId)) {
          await settleAndRemove(w.workerId);
          recycled++;
        }
      }
    }
    return recycled;
  }

  // -------------------------------------------------------------------------
  // AC-10 — Bounded per-advisor queue + deadline. Typed reasons. Never
  // unbounded, never deadlocks.
  // -------------------------------------------------------------------------
  /**
   * Try to admit a request for an advisor. Returns a typed decision. The caller
   * (Slack/board) uses the reason to drive the user-facing message.
   *
   * @param {string} advisorId
   * @param {object} [opts]
   * @param {function} [opts.readMemAvailableFn]
   * @returns {{ admitted: boolean, reason: string }}
   */
  function admit(advisorId, opts = {}) {
    if (!enabled) return { admitted: false, reason: REASON.DISABLED };

    // Is there an idle worker right now?
    if (hasIdleWorker()) return { admitted: true, reason: REASON.QUEUED };

    // No idle worker — can we spawn one (capacity)? If yes, admit (caller will
    // acquireWorker). If capacity is the blocker, reject typed.
    const cap = admitCapacity(opts.readMemAvailableFn);
    if (cap.ok) return { admitted: true, reason: REASON.QUEUED };

    // Can't serve now and can't spawn — try to queue.
    const queueMax = Number(spawnCfg.queueMax) || 100;
    const q = queues.get(advisorId) || [];
    if (q.length >= queueMax) return { admitted: false, reason: REASON.QUEUE_FULL };

    const entry = { advisorId, enqueuedAt: nowFn() };
    q.push(entry);
    queues.set(advisorId, q);
    return { admitted: false, reason: REASON.QUEUED };
  }

  function hasIdleWorker() {
    for (const w of pool.values()) {
      if (w.state === STATE.IDLE) return true;
    }
    return false;
  }

  /**
   * Sweep queued entries past their deadline → queue_timeout. Returns the timed
   * out entries so the caller can fail-close their Slack threads (AC-16).
   * @returns {Array<{advisorId: string, reason: string}>}
   */
  function sweepQueueDeadlines() {
    const deadlineMs = Number(spawnCfg.queueDeadlineMs) || 30000;
    const now = nowFn();
    const timedOut = [];
    for (const [advisorId, q] of queues) {
      const kept = [];
      for (const entry of q) {
        if (now - entry.enqueuedAt >= deadlineMs) {
          timedOut.push({ advisorId, reason: REASON.QUEUE_TIMEOUT });
        } else {
          kept.push(entry);
        }
      }
      if (kept.length) queues.set(advisorId, kept);
      else queues.delete(advisorId);
    }
    return timedOut;
  }

  function queueDepth(advisorId) {
    const q = queues.get(advisorId);
    return q ? q.length : 0;
  }

  // -------------------------------------------------------------------------
  // Lifecycle: start/stop loops + docker /events subscription (AC-1 gate).
  // -------------------------------------------------------------------------
  function start() {
    if (!enabled) return; // AC-1: dark when disabled — no docker/mesh calls.

    // AC-7(b) — subscribe to docker /events for die/oom/stop eviction.
    if (typeof docker.subscribeEvents === "function" && !eventsUnsub) {
      eventsUnsub = docker.subscribeEvents(onDockerEvent);
    }

    // AC-8 — reconcile on startup AND every reconcileMs.
    void reconcile().catch((e) => logger.error(`[AgentSpawn] reconcile failed: ${e.message}`));
    const reconcileMs = Number(spawnCfg.reconcileMs) || 5000;
    reconcileTimer = setInterval(() => {
      void reconcile().catch((e) => logger.error(`[AgentSpawn] reconcile failed: ${e.message}`));
    }, reconcileMs);
    if (reconcileTimer.unref) reconcileTimer.unref();

    // AC-4 — idle reaper loop.
    const idleReapMs = Number(spawnCfg.idleReapMs) || 60000;
    reaperTimer = setInterval(() => {
      void reapIdle().catch((e) => logger.error(`[AgentSpawn] reaper failed: ${e.message}`));
      void recycleAged().catch((e) => logger.error(`[AgentSpawn] recycle failed: ${e.message}`));
    }, idleReapMs);
    if (reaperTimer.unref) reaperTimer.unref();

    // AC-7(a) — TTL refresh loop.
    const ttlMs = Math.max(1000, Math.floor((Number(spawnCfg.registrationTtlMs) || 300000) / 4));
    registrationTimer = setInterval(() => refreshRegistrations(), ttlMs);
    if (registrationTimer.unref) registrationTimer.unref();

    logger.info("[AgentSpawn] controller started (pool enabled)");
  }

  function stop() {
    if (eventsUnsub) {
      try {
        eventsUnsub();
      } catch (e) {
        /* best-effort */
      }
      eventsUnsub = null;
    }
    for (const t of [reconcileTimer, reaperTimer, registrationTimer]) {
      if (t) clearInterval(t);
    }
    reconcileTimer = reaperTimer = registrationTimer = null;
  }

  // -------------------------------------------------------------------------
  // Introspection (tests + UI).
  // -------------------------------------------------------------------------
  function getPoolState() {
    return {
      enabled,
      workers: [...pool.values()].map((w) => ({
        workerId: w.workerId,
        nodeId: w.nodeId,
        generation: w.generation,
        state: w.state,
        registered: w.registered,
        token: w.token,
      })),
      counts: {
        total: pool.size,
        idle: [...pool.values()].filter((w) => w.state === STATE.IDLE).length,
        leased: [...pool.values()].filter((w) => w.state === STATE.LEASED).length,
        draining: [...pool.values()].filter((w) => w.state === STATE.DRAINING).length,
      },
    };
  }

  return {
    enabled,
    start,
    stop,
    // Core engine
    acquireWorker,
    lease,
    release,
    beginDrain,
    settleAndRemove,
    cas,
    // Loops (also exposed for deterministic test driving)
    reapIdle,
    recycleAged,
    reconcile,
    refreshRegistrations,
    admit,
    sweepQueueDeadlines,
    // Helpers
    admitCapacity,
    awaitReadiness,
    verifyCap,
    trackWorker,
    getPoolState,
    queueDepth,
    onDockerEvent,
    // Constants for tests / wiring
    STATE,
    REASON,
    POOL_LABEL,
    POOL_LABEL_VALUE,
  };
}

module.exports = {
  createAgentSpawn,
  STATE,
  REASON,
  POOL_LABEL,
  POOL_LABEL_VALUE,
};
