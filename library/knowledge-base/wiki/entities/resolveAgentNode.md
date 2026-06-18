---
type: entity
title: "resolve (createAgentLocator)"
entity_type: function
status: developing
created: 2026-06-18
updated: 2026-06-18
path: "src/agent-locator.js"
language: js
depends_on:
  - "[[entities/pickDashboardNode]]"
  - "[[entities/nodeBaseUrl]]"
used_by:
  - "[[entities/dispatchTask]]"
  - "[[entities/index-bootstrap]]"
last_commit_hash: "c16dac8"
tested_by:
  - "[[entities/agent-locator-test]] (`tests/agent-locator.test.js`)"
tags:
  - entity
  - dispatch
  - routing
  - phase3-seam
related:
  - "[[entities/createAgentLocator]]"
  - "[[concepts/agent-node-routing]]"
sources:
  - "[[entities/agent-locator-module]]"
---

# resolve (createAgentLocator)

## Overview

`resolve` is the agent→node routing decision function returned by `createAgentLocator`. It maps an agent reference (`id` or `id@node`) to one of four routing-decision kinds the dispatch module branches on, using ONLY the injected `rosterFn`/`meshFn` (no network, no CLI — pure resolution) (`src/agent-locator.js:86-116`). In `src/index.js` the dispatch module is wired with `resolveAgentNode: (agentRef) => agentLocator.resolve(agentRef)` (`src/index.js:283`) — so `resolveAgentNode` IS this `resolve`.

## Signature / Definition

```js
async resolve(agentRef: string)
  -> { kind, agentId, node?, baseUrl?, online? }

// kinds:
//   { kind: "local",       agentId }                        — run on THIS node
//   { kind: "remote",      agentId, node, baseUrl, online } — POST agent-run to <node>
//   { kind: "unknown",     agentId }                        — agent not in fleet roster
//   { kind: "unreachable", agentId, node }                  — roster names a node with no mesh record
```

## Behavior

1. Split `agentRef` on `@` → `[agentId, pinnedNode]` (`:87`).
2. `await rosterFn()`; filter `roster.agents` to `a.id === agentId` (`:89-91`). No matches → `{kind:"unknown", agentId}` (`:92-94`).
3. **Node selection** (`:97-100`): explicit `@node` qualifier wins (`matches.find(a => a.node === pinnedNode)`); else prefer local (`a.node === selfNode`); else first remote match (`matches[0]`).
4. If `chosen.node === selfNode` → `{kind:"local", agentId}` (`:102`).
5. Else `await meshFn()`, then `pickDashboardNode(meshNodes, chosen.node)` (`:104-106`). No mesh record → `{kind:"unreachable", agentId, node}` (`:107`).
6. Else `{kind:"remote", agentId, node, baseUrl: nodeBaseUrl(node), online: node.health?.status === "online"}` (`:109-115`).

**Routing inputs:** the `@node` syntax IS supported and is the explicit pin path. `selfNode` is the local-vs-remote pivot, wired from `CONFIG.fleet.dispatch.node || os.hostname()` (`src/index.js:453`).

**`pickDashboardNode` (`:53-62`):** when a hostname has multiple mesh records (e.g. a gateway proxy advertising `/health` AND the real OFC dashboard advertising `/api/health`), it deterministically prefers the record whose `healthPath === "/api/health"`, else the one whose base URL ends `/api`, else the first match — so agent-run POSTs hit the dashboard, not the proxy.

## Connections

- **depends_on:** [[entities/pickDashboardNode]], [[entities/nodeBaseUrl]], `rosterFn` (injected), `meshFn` (injected)
- **used_by:** [[entities/dispatchTask]] (via the `resolveAgentNode` closure), [[entities/index-bootstrap]]
- **related:** [[concepts/agent-node-routing]]

## Tested by

- [[entities/agent-locator-test]] (`tests/agent-locator.test.js`)

## History

- **Last touched:** commit `c16dac8` by BroClaw2 on 2026-06-17 — "release: v2.4.0 — cross-node remote dispatch made functional"; added `pickDashboardNode` dashboard-vs-proxy disambiguation.
- **Introduced:** Phase 2 remote dispatch, v2.3.0 (`3fdd0cb`, 2026-06-16).

## Sources

- `src/agent-locator.js` (lines 73–119) — `createAgentLocator` + `resolve`.
- `src/agent-locator.js` (lines 53–62) — `pickDashboardNode`.
- `src/index.js` (lines 271, 283, 450–454) — lazy wiring + `selfNode`.
