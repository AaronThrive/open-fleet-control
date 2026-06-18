---
type: prd
prd: "001"
slug: on-demand-isolated-worker-pool
title: "On-Demand Isolated-Worker Pool — caller-side remote routing + spawn controller + durable bits"
status: backlog
repo: open-fleet-control
created: 2026-06-18
owner: library-guardian
phase: 3
source_plan: "~/tasks/fleet-reliability-CURRENT-20260618.md"
depends_on:
  - "prd-001 (openclaw-stack) — warm-worker image + pool compose (the spawn target)"
related_wiki:
  - "library/knowledge-base/wiki/entities/dispatchTask.md"
  - "library/knowledge-base/wiki/entities/startRun.md"
  - "library/knowledge-base/wiki/entities/resolveAgentNode.md"
  - "library/knowledge-base/wiki/entities/getRoster.md"
  - "library/knowledge-base/wiki/entities/handleMesh-nodes.md"
  - "library/knowledge-base/wiki/entities/runBoard.md"
  - "library/knowledge-base/wiki/entities/runChain.md"
  - "library/knowledge-base/wiki/entities/createSafeStore.md"
  - "library/knowledge-base/wiki/entities/fleet-dispatch-orchestrate-config.md"
  - "library/knowledge-base/wiki/concepts/node-sqlite-databasesync-pattern.md"
  - "library/knowledge-base/wiki/concepts/mesh-registry-persistence.md"
tags: [phase3, worker-pool, dispatch, mesh, sqlite, self-healing, thanos]
---

# PRD-001 (OFC) — On-Demand Isolated-Worker Pool

> **Schema note (v1→v2 migration needed).** This repo's `library/` is still schema v1
> (`library/knowledge-base/` only; no `library/requirements/`). This PRD is authored at
> the correct **v2** path `library/requirements/backlog/prd-001-…/`. The existing wiki
> under `library/knowledge-base/wiki/` is a legacy v1 location; do not relocate it as
> part of this PRD. Run `pnpm standardize-library --repository open-fleet-control`
> (if the deployment ships it) to migrate the rest of the tree. The wiki pages are cited
> by their current v1 paths above and remain valid source-of-truth.

## 1. Summary

Deliver an **on-demand pool of isolated worker containers** on the single Hostinger KVM8
box so that (a) board councils ("ask N advisors one question") run in **parallel** again
without co-saturating the gateway event loop, and (b) **multiple Slack users can query
the fleet concurrently** without a silent hang. Each worker is a pre-built, pre-stopped
container started with `docker start` (warm pool), registered over the **existing** mesh
API, leased for a single run, and recycled. The dispatch core is **not rewritten** — the
remote `agent-run` POST path is already built and wired (`src/dispatch.js` `startRun`/
`runRemote`, `src/index.js:283`). Phase 3 is **caller-side**: `runBoard`/`runChain` supply
agent refs that resolve to remote worker nodes, a new `src/agent-spawn.js` controller manages
the pool + leases, two durable SQLite bits guarantee exactly-once Slack handling and stale-
result rejection, and the `sequentialBoard` config default flips to parallel once spawn is on.

This PRD is the **Thanos Gauntlet** input: every acceptance criterion (AC) below is numbered
and independently testable. Thanos tracks each to zero-open.

## 2. Goals

- Parallel board councils on one box without OOM, 429 storms, or event-loop starvation.
- Concurrent multi-user Slack querying with an enforced ack ≤3s → "working…" → result → bounded-timeout-fallback contract — **never a silent hang**.
- Self-healing: the pool reconstructs correct state from `docker ps` after any crash/reboot, evicts leaked registrations, and rejects stale results.
- Capacity-governed: admission refuses a spawn that would breach the RAM budget; target peak 4–6 workers, hard ceiling ~8.

## 3. Non-Goals / Out of Scope

- **CRIU checkpoint/restore is REJECTED.** Workers share a netns with the Tailscale sidecar
  (`network_mode: service:<sidecar>`); the tunnel crypto session lives outside the checkpoint
  tree (confirmed broken on Docker + Ubuntu 24.04). The pool uses `docker start` of pre-stopped
  containers only. See `docs/overload-safety-hardening.md` ("Phase 3 note: CRIU is NOT viable").
- **Multi-node mesh is DEFERRED** (Stage F: Alienware GPU overflow, 2nd KVM8 twin, Postgres
  replication). This PRD is single-box only.
- **No Redis / Valkey / Postgres for pool state.** A daemon that dies headlessly, or coupling
  OFC liveness to an external memory DB, is rejected. Durable state is `node:sqlite` only (AC-13/14).
- **No new SQLite binding.** `node:sqlite` `DatabaseSync` only — never better-sqlite3 (AC-13).
- **No dispatch-core rewrite.** `runRemote`/`startRun`/`synthStdout` already consume
  `route.kind:"remote"`; this PRD does not touch the remote POST path itself.
- **zram/zswap tuning, host cgroup/oomd config** — owned by Phase 2 (`docs/overload-safety-hardening.md`) and Stage A installer parity, not here.
- The **warm-worker image, render/compose, installer wiring, and Node-version pin** live in the **openclaw-stack PRD-001**, not this one.

## 4. Architecture (against real contracts)

| Seam | Contract (from Stage B wiki scan) | Phase 3 change |
|---|---|---|
| Remote agent-run | `startRun` forks on `route.kind`; `runRemote` POSTs `{action:"agent-run",agent,message,sessionKey,timeoutSec}` to `${baseUrl}/api/action` w/ `Authorization: Bearer <token>` + `X-OFC-Dispatch:1` (`src/dispatch.js:362-412,427-459`). Already built + wired (`src/index.js:283`). | None to the POST path. Caller must supply a ref that resolves remote. |
| Routing | `resolveAgentNode(agentRef)` → `{kind: local\|remote\|unknown\|unreachable, agentId, node?, baseUrl?, online?}` (`src/agent-locator.js:86-116`); `selfNode = CONFIG.fleet.dispatch.node \|\| os.hostname()` (`src/index.js:453`). | Workers registered as remote nodes hosting the advisor → `kind:"remote"`. |
| Dispatch primitive | `dispatchTask(taskId,{agent,actor,isBoard})` resolves at run-START; `completion` is the settlement promise; `result_text` is null-or-full ≤12 KiB (`canonicalResultText`, `RESULT_TEXT_MAX`), the 300-char value is the separate `note` (`src/dispatch.js:625-630,695-769`). | Read `result_text`, never the note (AC-19). Lease/health-gate hangs off `completion`. |
| Mesh API | `POST /api/fleet/mesh/nodes` → **200** `{success,node}`; duplicate → **400**; `DELETE /api/fleet/mesh/nodes/:idOrHostname` → **200**/**404**; record `{id(uuid),hostname,port,protocol:"https",healthPath,platform,label,registeredBy,registeredAt}`; `validateNodeInput` rules (`src/fleet-routes.js:178-205`, `src/mesh.js:98-141,382-426`). | Spawn controller register/unregister via this contract; handle **200 (not 201)** and **400 (not 409)** on duplicate. |
| Roster / admission | `getRoster()` → `{agents,byNode,counts,timestamp}`; `AgentRecord` has `active`, `subagentsMax`, `sessionCount`, `node` (`src/agents-roster.js:455-465,431-449`). | Admission reads `byNode` + per-worker `active`/`subagentsMax`/`sessionCount`. |
| Board / chain | `runBoard` parallel branch (`src/orchestrate.js:602-644`) vs sequential (`:569-601`); default from `config.sequentialBoard===true` (`:319`). `runChain` strictly sequential (`:723-854`). | Flip default to parallel when spawn enabled (AC-17); route seats to workers. |
| Config | `fleet.dispatch.maxConcurrent`(3), `.timeoutSec`(1200), `.node`; `fleet.orchestrate.sequentialBoard`(true), `.timeoutSec`(1200) (`src/config.js:274-298`). | Add `fleet.spawn.*`; raise `maxConcurrent` in lockstep (AC-18). |
| Durable store | `node:sqlite` `DatabaseSync` precedent in `src/fleet-chat.js:14,95-117`; PRAGMAs WAL/NORMAL/busy_timeout (`concepts/node-sqlite-databasesync-pattern.md`). | New `src/spawn-store.js` (dedup + fencing) copies this idiom verbatim. |
| Safe JSON | `createSafeStore` (`src/state-safety.js:30-343`): validate-first atomic write, rotated backups, quarantine+restore. Mesh registry does NOT use it (`src/mesh.js:303-308`) — weaker temp+rename, no backup/quarantine. | Migrate mesh registry to `createSafeStore` (AC-20). |

### Worker identity
Every worker is identified by **`(node-id, generation)`** everywhere — lease, fencing stamp,
reconcile, and Slack progress message. The generation increments each `docker start` of a
given container, so an ABA (same container reused after a recycle) never aliases a stale lease
or a stale result. The `node-id` is the mesh-record `id` (uuid) returned by the register POST.

## 5. Acceptance Criteria (numbered, independently testable)

> Convention: each AC is **PASS** only when an automated test (unit/integration) or a scripted
> live check proves it. `[dep: AC-n]` marks a hard dependency that must pass first. Thanos drives
> all to zero-open. ACs are grouped; the 8 self-healing mechanisms are AC-5 through AC-12.

### Group A — Spawn / pool controller (`src/agent-spawn.js`)

- **AC-1.** A new module `src/agent-spawn.js` exports a controller factory (e.g. `createAgentSpawn({config, mesh, roster, store, docker, logger})`) with no top-level side effects; constructing it with spawn disabled (`fleet.spawn.enabled !== true`) is a no-op that leaves dispatch/orchestrate behaviour byte-identical to today. *(Test: construct with `enabled:false`; assert no `docker`/`mesh` calls.)*
- **AC-2.** **Warm start.** `acquireWorker(advisorId)` starts a pre-stopped worker container via `docker start <name>` (NOT `docker run`, NOT CRIU). The container name/pool is discovered from `docker ps -a` filtered by the pool label (AC-7 label), never hard-coded. *(Test: stub docker; assert `start` called with a labelled, pre-existing container.)*
- **AC-3.** **Per-worker resource cap is asserted, not assumed.** On acquire, the controller verifies the started container's `HostConfig.Memory == 2.5 GiB` (`2684354560`) and `HostConfig.MemorySwap == HostConfig.Memory` (swap.max=0); if a worker is mis-capped it is drained and the acquire fails closed (no uncapped worker ever serves). *(Test: stub `docker inspect` returning wrong cap → acquire throws/drains.)* `[dep: AC-2]`
- **AC-4.** **Idle reaper.** A worker that has been `idle` for ≥ `fleet.spawn.idleReapMs` is `docker stop`-ped (drain, not kill — AC-12) and its mesh registration removed (AC-7). The reaper never stops a `leased` or `draining` worker. *(Test: advance fake clock; assert only idle workers stopped.)* `[dep: AC-6]`

### Group B — The 8 self-healing mechanisms

- **AC-5. Readiness gate (mechanism 1).** After `docker start`, the controller polls the worker's `/health` (the worker's `healthPath`) and registers it in the mesh **LAST**, only after **N consecutive** OK responses (`fleet.spawn.readinessOks`, default 3) within `fleet.spawn.readinessTimeoutMs`. A worker that never reaches N OKs is drained and the acquire fails closed; it is **never** registered. *(Test: stub health returning flapping then steady; assert register called once, after N OKs, and not at all on permanent failure.)* `[dep: AC-2]`
- **AC-6. Atomic CAS state machine (mechanism 3).** Worker lifecycle is an in-process state machine `idle → leased`, `idle → draining`, `leased → idle`, `leased → draining`, `draining → (removed)`. Every transition is a **compare-and-set** on `(workerId, expectedState, expectedGeneration)`; a CAS that loses (state or generation mismatch) returns false and performs no side effect. This eliminates the reaper-vs-dispatch TOCTOU. *(Test: concurrent `lease` + `drain` on the same idle worker → exactly one wins, the other is a no-op; generation mismatch always loses.)*
- **AC-7. Leaked-registration eviction (mechanism 4).** (a) Every worker is registered with a **TTL** and the controller refreshes it while the worker is alive; a registration whose TTL lapses is unregistered. (b) The controller subscribes to Docker `/events` and, on a worker container `die`/`oom`/`stop`, **auto-unregisters** that node from the mesh (DELETE, tolerating 404) and CAS-removes it from the pool. No dead worker remains in `getRoster()`. *(Test: emit a fake `die` event → DELETE issued for that node; lapse a TTL → unregister issued.)* `[dep: AC-6]`
- **AC-8. Reconciliation loop (mechanism 7).** On startup AND every `fleet.spawn.reconcileMs`, the controller rebuilds in-memory pool state from `docker ps` (the live truth) reconciled against the desired pool size and the mesh registry: containers present-but-unregistered get registered (after AC-5 readiness) or stopped; registered-but-absent nodes get unregistered. Docker daemon `live-restore` is assumed ON so containers survive a dockerd restart. This is the universal backstop after any crash/reboot. *(Test: seed a divergent `docker ps` vs mesh vs desired; assert the loop converges to desired and the mesh matches `docker ps`.)* `[dep: AC-6, AC-7]`
- **AC-9. Max-lifetime recycle (mechanism 8).** A worker older than `fleet.spawn.maxLifetimeMs` (plus per-worker **jitter** so the whole pool never recycles at once) is **drained** (finish its current lease, refuse new leases) and then stopped + unregistered, then optionally re-spawned to maintain desired size. Recycle never kills an in-flight run. *(Test: age a worker past max-lifetime mid-lease → it finishes the lease, then drains; assert jitter spreads recycle times across workers.)* `[dep: AC-6, AC-12]`
- **AC-10. Bounded per-agent queue + deadline (mechanism 6).** Per advisor there is a bounded request queue (`fleet.spawn.queueMax`). A request that cannot be admitted (no idle worker, spawn would breach capacity, queue full, or wait exceeds `fleet.spawn.queueDeadlineMs`) is rejected deterministically with a typed reason (`"queued"` / `"queue_full"` / `"queue_timeout"` / `"capacity"`), surfaced to the caller for the Slack "you're in line / try again" message (AC-16). The queue never grows unbounded and never deadlocks. *(Test: saturate workers + fill queue → next request gets `queue_full`; a queued request past its deadline gets `queue_timeout`.)* `[dep: AC-6, AC-15]`
- **AC-11. Slack ack ≤3s + event_id dedup BEFORE spawn (mechanism 2).** The Slack entry path (a) acknowledges the Slack event within **3 seconds** (HTTP 200 to Slack) **before** any worker spawn, and (b) records the Slack `event_id` in the durable dedup table (AC-13) **before** spawning; if the insert reports the row already existed (`changes === 0`), the handler treats it as a duplicate Slack retry and does **not** spawn a second worker. Without this, one Slack message that Slack retries up to 4× would spawn up to 4 workers. *(Test: feed the same `event_id` twice → first spawns, second is a no-op; assert the ack path returns < 3s independent of spawn latency.)* `[dep: AC-13]`
- **AC-12. Drain semantics (mechanism 8 cont.) + per-worker cgroup cap.** "Drain" means: mark `draining` via CAS (AC-6), refuse new leases, allow the in-flight lease to settle (bounded by the run `timeoutSec`), then `docker stop` (graceful, `stop_grace_period`) and unregister. A worker is never `docker kill`-ed while a lease is live. The per-worker cgroup cap (memory.max = 2.5 GiB, swap.max = 0) is the openclaw-stack image's responsibility but is **verified** here at acquire (AC-3). *(Test: drain a leased worker → stop is deferred until the lease settles or times out.)* `[dep: AC-6]`

### Group C — Capacity governor (explicit)

- **AC-15. Capacity governor.** Before any spawn, admission computes the projected footprint
  `Σ(active workers) × 2.5 GiB + ~5 GiB base` and **refuses** the spawn if it would exceed
  `0.8 × 32 GiB ≈ 25.6 GiB`, OR if a live free-RAM read (`/proc/meminfo` MemAvailable or
  `docker`/cgroup equivalent) is below the next worker's 2.5 GiB footprint plus a safety margin.
  Target peak is 4–6 workers; the hard ceiling is **~8**. Admission never relies on swap as
  headroom (Phase 2: swap is contain-only, not capacity). *(Test: simulate 8 active workers →
  9th spawn refused with `capacity`; simulate low MemAvailable → refused even below the count
  ceiling.)* `[dep: AC-6]`

### Group D — Slack UX contract

- **AC-16. Slack working→result→fallback, never silent.** For every Slack query, the user sees:
  (1) ack ≤3s (AC-11), (2) a "working…" message posted promptly, (3) a `chat.update` of that
  same message with the run's `result_text` (AC-19) on success, and (4) on a bounded timeout
  (`fleet.spawn.slackDeadlineMs`, ≥ run `timeoutSec`) or admission rejection (AC-10), a
  `chat.update` to a "couldn't complete — try again" message. There is **no code path** where a
  Slack query leaves the "working…" message unresolved. *(Test: success path updates the message
  with result text; timeout path updates it to the try-again copy; assert the working message is
  always terminally updated.)* `[dep: AC-10, AC-11, AC-19]`

### Group E — Caller-side routing + parallel flip

- **AC-17. Caller-side remote routing + parallel flip.** When `fleet.spawn.enabled === true`:
  (a) `runBoard`/`runChain` route each seat to a pool worker by supplying an agent ref that
  `resolveAgentNode` returns `kind:"remote"` for (either an `id@<workerNode>` pin or a roster
  whose advisor binding is the worker node), leasing a worker per seat via the controller; and
  (b) the effective board default becomes **parallel** — `defaultSequentialBoard` is driven by
  `config.sequentialBoard`, whose default flips to `false` **only when spawn is enabled** (a guard,
  not an unconditional flip). With spawn disabled, behaviour is unchanged (sequential default
  preserved). The dispatch core (`startRun`/`runRemote`) is **not modified**. *(Test: spawn-enabled
  board run dispatches all seats in parallel to leased remote workers; spawn-disabled run still
  runs sequentially; assert no edits to the `runRemote` POST body.)* `[dep: AC-1, AC-5, AC-6, AC-18]`
- **AC-18. `maxConcurrent` raised in lockstep.** `fleet.dispatch.maxConcurrent` is raised together
  with the pool size so a parallel board of K seats does not hit the per-dispatch 429 cap
  (`src/dispatch.js` open-attempt cap). The relationship is explicit and configured (e.g.
  `maxConcurrent ≥ pool ceiling`), and a parallel board at the target peak does not produce a 429.
  *(Test: parallel board of 6 seats with pool ceiling 6 and `maxConcurrent` raised accordingly →
  zero 429s; lowering `maxConcurrent` below seat count reproduces the 429 to prove the linkage.)*
  `[dep: AC-17]`

### Group F — Durable bits (SQLite) + the two resolved decisions

- **AC-13. SQLite dedup table (mechanism 2 storage).** A new `src/spawn-store.js` opens a
  `node:sqlite` `DatabaseSync` DB under `state/` (beside `fleet-chat.db`), copying the
  `src/fleet-chat.js` idiom verbatim (require `node:sqlite`, sync open at construction, idempotent
  `CREATE TABLE IF NOT EXISTS`, prepared statements). It creates
  `slack_event_dedup(event_id TEXT PRIMARY KEY, seen_at INTEGER, expires_at INTEGER)` and exposes
  an insert that uses `INSERT … ON CONFLICT DO NOTHING` and reports `changes === 0` as "duplicate".
  A 10-minute TTL with lazy GC (delete-by-age, mirroring `fleet-chat.js` `prune()`) bounds the
  table. PRAGMAs: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`. **No better-sqlite3.**
  *(Test: insert same event_id twice → second reports duplicate; expired rows GC'd.)*
- **AC-14. SQLite fencing counter (mechanism 5 storage).** The same store creates
  `fencing_counter(id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER)` and exposes a monotonic
  `nextToken()` implemented as `UPDATE fencing_counter SET value = value + 1 WHERE id = 1 RETURNING value`
  (seeded to 0 once). The returned token is **strictly increasing across process restarts**. Each
  lease is stamped with a fencing token; results carry their token; the result sink **rejects a
  result whose token is older than the latest accepted token for that `(node-id, generation)`**, so
  a zombie/slow worker's stale answer can never overwrite a fresh one. *(Test: tokens strictly
  increase across a simulated restart; the sink rejects a stale-token result and accepts the newest.)*
  `[dep: AC-13]`
- **AC-19. RESOLVED DECISION — read `result_text`, not the note = YES.** All Phase 3 result-
  surfacing (Slack `chat.update`, board `results`, chain `final`) reads the attempt's
  **`result_text`** (canonical, null-or-full ≤12 KiB), never the 300-char `note`. Where
  `result_text` is `null` (unparseable stdout / no output / failure), the UX shows the explicit
  failure/try-again copy (AC-16), not a truncated note. *(Test: a run with full output surfaces the
  full `result_text`; a null `result_text` surfaces the failure copy, never the note string.)*
- **AC-20. RESOLVED DECISION — migrate mesh registry to `createSafeStore` = YES.** `src/mesh.js`
  `saveRegistry`/`loadRegistry` are migrated from the inline temp+rename write (`src/mesh.js:303-308`)
  to `createSafeStore` (`src/state-safety.js`) with a `validate` that enforces the node-record shape
  (`{id,hostname,port,protocol,healthPath,platform,label,registeredBy,registeredAt}`), giving the
  registry rotated backups + corrupt-file quarantine/auto-restore parity with the reconcile store.
  All ~4 mesh call sites + the validator are updated; existing `tests/mesh.test.js` and
  `tests/fleet-routes.test.js` still pass (200-on-register, 400-on-duplicate, 404-on-unknown
  contract preserved). A corrupt registry file no longer silently returns `[]`. *(Test: corrupt the
  registry file → read auto-restores from backup instead of returning empty; register/unregister
  HTTP contract unchanged.)*

### Group G — Config + safety

- **AC-21. New config block, defaults safe.** A `fleet.spawn.*` block is added to `FLEET_DEFAULTS`
  (`src/config.js`) with `enabled` defaulting to **false** and all tunables present with sane
  defaults: `poolCeiling`(8), `targetPeak`(6), `workerMemBytes`(2684354560), `readinessOks`(3),
  `readinessTimeoutMs`, `idleReapMs`, `reconcileMs`, `maxLifetimeMs`, `recycleJitterMs`, `queueMax`,
  `queueDeadlineMs`, `slackDeadlineMs`, `ramBudgetBytes`(`0.8×32GiB`), `registrationTtlMs`. Config
  resolution honours env > file > defaults exactly as the existing block does
  (`src/config.js:336-396`). *(Test: defaults load; `enabled:false` keeps the whole feature dark.)*
- **AC-22. Fail-closed everywhere.** Every spawn/lease/admission failure path fails **closed**: a
  worker that fails readiness, mis-caps, loses a CAS, or breaches capacity is never used; a Slack
  query that cannot be served is terminally updated to the try-again copy (AC-16). There is no path
  that serves an unverified worker or leaves a Slack thread hanging. *(Test: inject each failure
  class → assert no worker serves and no Slack thread is left unresolved.)* `[dep: AC-3, AC-5, AC-6, AC-15, AC-16]`

## 6. Files this PRD will touch

| File | Change |
|---|---|
| `src/agent-spawn.js` | **NEW** — pool/lease/CAS/reaper/reconcile/Docker-events controller (AC-1–AC-12, AC-15) |
| `src/spawn-store.js` | **NEW** — `node:sqlite` dedup + fencing tables (AC-13, AC-14) |
| `src/orchestrate.js` | caller-side remote routing in `runBoard`/`runChain`; parallel-flip guard (AC-17) |
| `src/config.js` | add `fleet.spawn.*`; raise `fleet.dispatch.maxConcurrent` in lockstep (AC-18, AC-21) |
| `src/mesh.js` | migrate `saveRegistry`/`loadRegistry` to `createSafeStore` + validator (AC-20) |
| `src/index.js` | wire `createAgentSpawn` into bootstrap; pass roster/mesh/store/config (AC-1) |
| Slack entry path (the gateway handler that currently posts to the fleet) | ack ≤3s, dedup-before-spawn, working→update→fallback (AC-11, AC-16, AC-19) |
| `tests/*` | unit + integration coverage for every AC above |

> The Slack entry handler's exact file is **flagged as a question** in §9 — not pinned to a wiki
> contract. Do not fabricate the path; confirm before editing.

## 7. Sub-PRDs

This PRD is decomposed into sub-PRDs for Thanos waves (see §8 build order). Sub-PRD files (to be
authored as the work is claimed) follow the canonical naming
`prd-001<letter>-on-demand-isolated-worker-pool-<feature>.md`:

- `prd-001a-…-durable-store` — AC-13, AC-14 (the SQLite store; zero deps on other ACs)
- `prd-001b-…-mesh-safestore` — AC-20 (mesh → createSafeStore; independent)
- `prd-001c-…-spawn-controller` — AC-1–AC-12, AC-15, AC-21 (the pool engine)
- `prd-001d-…-caller-routing-parallel` — AC-17, AC-18 (board/chain routing + flip)
- `prd-001e-…-slack-ux` — AC-11, AC-16, AC-19, AC-22 (Slack contract + fail-closed)

## 8. Build order (Thanos waves)

**Wave 1 (parallel, no cross-deps):**
- `prd-001a` durable store (AC-13, AC-14) — independent.
- `prd-001b` mesh→createSafeStore (AC-20) — independent.
- `prd-001` config block scaffolding (AC-21) — independent.

**Wave 2 (sequential after Wave 1):**
- `prd-001c` spawn controller (AC-1–AC-12, AC-15). Internally: AC-6 CAS state machine FIRST
  (it gates AC-4, AC-7, AC-8, AC-9, AC-10, AC-12, AC-15), then AC-5 readiness, then AC-7 eviction,
  then AC-8 reconcile, then AC-15 capacity governor, then AC-9 recycle. Depends on AC-13/14 (store)
  from Wave 1.

**Wave 3 (sequential after Wave 2; the parallel-flip gate):**
- `prd-001e` Slack UX (AC-11 depends on AC-13; AC-16 depends on AC-10/AC-11/AC-19).
- `prd-001d` caller routing + parallel flip (AC-17 depends on controller + AC-18). **AC-18 (raise
  `maxConcurrent`) MUST be verified PASS before the parallel flip in AC-17 is enabled** — otherwise a
  parallel board hits 429s. This is the single must-verify-before-flip gate.

**Verification gate before flipping `sequentialBoard` default to parallel:** AC-5 (readiness),
AC-6 (CAS), AC-8 (reconcile), AC-15 (capacity governor), and AC-18 (maxConcurrent) must all be
PASS. Only then enable `fleet.spawn.enabled` + parallel default. Run the openclaw-stack PRD-001
(warm image + pool) to completion first — there is nothing to `docker start` without it.

## 9. Open questions (NOT fabricated — flag, do not assume)

- **Q1 — Slack entry handler file.** The Stage B wiki scan extracted the dispatch/orchestrate/mesh
  seams but did **not** extract the Slack gateway handler that receives the Slack event, posts the
  "working…" message, and calls the fleet. AC-11/AC-16/AC-19 depend on that file. Its exact path
  and the current ack mechanism are **not pinned to a real contract** in the available wiki pages.
  **Action:** confirm the Slack handler file (and whether ack is already ≤3s today) before editing —
  do not invent it. Everything else in this PRD is built against extracted, line-referenced contracts.

## 10. Open Questions — RESOLVED (2026-06-18, pre-Thanos)
**Q1 (Slack ack + dedup boundary) — RESOLVED: design A. Phase 3 does NOT modify the openclaw npm package.**
- openclaw's Slack provider (`@openclaw/slack@2026.5.22` / `@slack/bolt@4.7.2` socket mode) ALREADY acks ≤3s (Bolt auto-acks event subscriptions; expensive work runs detached after ack) AND ALREADY dedups retries on `channel:ts` (durable delivery record). → **AC-11 "ack ≤3s" is satisfied upstream; build NO ack path in OFC.**
- Human→agent runs IN-PROCESS in openclaw and never reaches OFC's spawner. The ONLY path to the Phase-3 spawner is **Chief → `POST /api/fleet/orchestrate`** (HTTP/tool call).
- **OFC obligation = AC-13 (dedup) only:** add optional `event_id`/`dedup_key` to the orchestrate route body (`fleet-routes.js:606`, hand-parsed, no zod) → `spawn-store.insertDedup(event_id)` before spawn; `changes===0` ⇒ duplicate no-op. ~50–80 LOC additive, no migration.
- **openclaw-side change = config/skill layer only (NOT the package):** Chief's outbound orchestrate call adds `event_id: body.event_id`. One-line follow-up in the Chief skill; track as a non-blocking item.

## 11. Build sequencing note (for Thanos)
Two repos. Cross-repo gate: stack **Node-24 pin (AC-9)** before OFC SQLite work; full stack worker-pool before OFC spawn controller can be live-verified. Within OFC, verify AC-5/AC-6/AC-8/AC-15/AC-18 BEFORE the parallel flip (sequentialBoard default change).
