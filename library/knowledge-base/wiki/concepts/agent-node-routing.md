---
type: concept
title: "Agent → Node Routing (@node syntax + dispatch resolution)"
complexity: advanced
domain: "dispatch"
aliases:
  - "resolveAgentNode"
  - "remote dispatch routing"
created: 2026-06-18
updated: 2026-06-18
status: developing
tags:
  - concept
  - dispatch
  - routing
  - phase3-seam
related:
  - "[[entities/resolveAgentNode]]"
sources:
  - "[[entities/resolveAgentNode]]"
---

# Agent → Node Routing

> [!stale]
> The "Why it matters" claim below — that `dispatch.ensureLocalNode refuses remote nodes today` and `board/chain are single-node until Phase 3` — is contradicted by the dispatch.js code as of commit `3bc56c1` (2026-06-17). `ensureLocalNode` throws ONLY when no `resolveAgentNode` resolver is injected; production wires one (`src/index.js:283`), so the remote agent-run POST path (`runRemote`) is live. See [[concepts/local-vs-remote-dispatch]] and [[entities/startRun]]. The remaining Phase 3 work is in the board/chain CALLER, not in building a remote path.

## Definition

A dispatch targets a node by resolving an agent reference (`id` or `id@node`) into one of four decision kinds: `local`, `remote`, `unknown`, `unreachable`. The pure resolver is [[entities/resolveAgentNode]] (`src/agent-locator.js:86-116`); the dispatch module holds it as the injected `resolveAgentNode` closure (`src/index.js:283`) and branches on the returned kind.

## How it works

1. The HTTP layer first validates the agent against the local roster (`requireRosterAgent`, `src/fleet-routes.js:432-448`), stripping any `@node` and requiring id+node to match when a node is pinned — fail-closed.
2. `resolveAgentNode` then picks the node: explicit `@node` wins → local (`a.node === selfNode`) → first remote. `selfNode = CONFIG.fleet.dispatch.node || os.hostname()`.
3. For a remote, `pickDashboardNode` disambiguates duplicate mesh records for one hostname, preferring the OFC dashboard's `/api/health` over a gateway proxy's `/health`, and `nodeBaseUrl` strips the health path to get the agent-run base URL.

## Why it matters

This is the seam that decides WHERE a worker runs. Phase 3's isolated-worker pool routes through this exact resolution. The `@node` pin syntax is the only way to force a specific node; without it, local is always preferred (cheapest, matches legacy local-only behaviour). The orchestration board/chain runners currently dispatch LOCAL only — `dispatch.ensureLocalNode` refuses remote nodes today (`src/orchestrate.js:24-26` header note), so board/chain are single-node until Phase 3 (or a coordinated dispatch change) lifts that.

## Examples in this codebase

- [[entities/resolveAgentNode]] — the resolution function.
- [[entities/createAgentLocator]] — the factory + wiring.
- [[entities/handleMesh-nodes]] — where nodes are registered into the mesh the resolver reads.

## Connections

- **involves entities:** [[entities/resolveAgentNode]], [[entities/createAgentLocator]], [[entities/dispatchTask]]
- **related concepts:** [[concepts/mesh-registry-persistence]]

## Sources

- `src/agent-locator.js` (lines 53–116) — resolution + dashboard-node pick.
- `src/index.js` (lines 271, 283, 450–454) — wiring + `selfNode`.
- commit `c16dac8` (2026-06-17, v2.4.0) — cross-node remote dispatch made functional.
