---
type: entity
title: "fleet.dispatch.* / fleet.orchestrate.* config keys"
entity_type: config-key
status: developing
created: 2026-06-18
updated: 2026-06-18
path: "src/config.js"
language: js
loader: json
name: "fleet.dispatch.* / fleet.orchestrate.*"
read_at:
  - file: "src/config.js"
    line: 274
  - file: "src/config.js"
    line: 295
  - file: "src/orchestrate.js"
    line: 312
  - file: "src/index.js"
    line: 299
last_commit_hash: "f396b27"
tested_by:
  - "[[entities/config-test]] (`tests/config.test.js`)"
tags:
  - entity
  - config
  - phase3-seam
related:
  - "[[entities/runBoard]]"
  - "[[entities/createOrchestrate]]"
sources:
  - "[[entities/config-module]]"
---

# fleet.dispatch.* / fleet.orchestrate.* config keys

## Overview

The dispatch + orchestrate config sections, defined in `FLEET_DEFAULTS` (`src/config.js:197-324`). Priority order: env > `config/dashboard.json` > `dashboard.local.json` > defaults; deep-merged via `deepMerge` + optional `FLEET_CONFIG_JSON` env override (`src/config.js:336-345`). Phase 3 must respect or extend these.

## Loader / Schema

`buildFleetConfig` (`src/config.js:336-396`) assembles defaults ← file ← `FLEET_CONFIG_JSON`. `dispatch.token`/`dispatch.identity` also honor dedicated env vars `FLEET_DISPATCH_TOKEN` / `FLEET_DISPATCH_IDENTITY` (`:382-386`).

### `fleet.dispatch` (`src/config.js:274-286`)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | dispatch module on/off |
| `baseUrl` | `""` | empty → `http://127.0.0.1:<port>` (resolved in index.js) |
| `maxConcurrent` | `3` | open-attempt cap; exceeding it throws **429** per dispatch |
| `timeoutSec` | `1200` | per-agent run timeout (agent CLI `--timeout` + open-attempt TTL). **Raised 600→1200** in `f396b27` — the load-bearing timeout |
| `node` | `""` | this node's hostname; empty → `os.hostname()` (the `selfNode` pivot for the locator) |
| `token` | `""` | shared Bearer secret for node→node agent-run auth; supports `op://` refs |
| `identity` | `""` | this node's Tailscale-User-Login on node→node calls |

### `fleet.orchestrate` (`src/config.js:295-298`)

| Key | Default | Meaning |
|---|---|---|
| `sequentialBoard` | `true` | when true, board councils dispatch advisors ONE-AT-A-TIME (single-box reliability default). Read at `src/orchestrate.js:319` → `defaultSequentialBoard = config.sequentialBoard === true`. A per-run `sequential` flag on POST /api/fleet/orchestrate overrides it |
| `timeoutSec` | `1200` | runner's per-seat WAIT budget; kept ≥ `dispatch.timeoutSec` so the runner never gives up before the agent process is killed. Read at `src/orchestrate.js:313` (clamped ≤3600 by `normalizeTimeoutSec`) |

Note: `fleet.orchestrate.enabled` is NOT in `FLEET_DEFAULTS` — `createOrchestrate` treats absence as enabled (`enabled = config.enabled !== false`, `src/orchestrate.js:312`).

Also relevant to Phase 3: `mesh.seed[]` (`src/config.js:220`) — fleet-wide node list auto-registered on boot (zero-touch join); `mesh.intervalMs` (15000); `budgets.*` (the dispatch/orchestration ceiling guards, `:302-308`).

## Read sites

- `FLEET_DEFAULTS.dispatch` / `.orchestrate` — `src/config.js:274-298`
- `buildFleetConfig` resolution — `src/config.js:336-396`
- `defaultSequentialBoard` / `defaultTimeoutSec` consumption — `src/orchestrate.js:312-319`
- Wiring — `src/index.js:274` (dispatch), `:299` (orchestrate)

## Connections

- **related:** [[entities/runBoard]], [[entities/createOrchestrate]], [[entities/resolveAgentNode]] (reads `dispatch.node` as `selfNode`)

## Tested by

- [[entities/config-test]] (`tests/config.test.js`)

## History

- **Last touched:** commit `f396b27` by BroClaw2 on 2026-06-18 — "added the `fleet.orchestrate` block (`sequentialBoard`, `timeoutSec` 1200); `dispatch.timeoutSec` 600→1200."

## Sources

- `src/config.js` (lines 197–324) — `FLEET_DEFAULTS`.
- `src/config.js` (lines 336–396) — `buildFleetConfig`.
