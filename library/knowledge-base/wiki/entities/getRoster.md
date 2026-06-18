---
type: entity
title: "getRoster (agents-roster aggregation)"
entity_type: function
status: developing
created: 2026-06-18
updated: 2026-06-18
path: "src/agents-roster.js"
language: js
depends_on:
  - "[[entities/getLocalRoster]]"
  - "[[entities/collectRemoteAgents]]"
  - "[[entities/buildRoster]]"
used_by:
  - "[[entities/getAssignees]]"
  - "[[entities/resolveAgentNode]]"
last_commit_hash: "21a66cb"
tested_by: []
tags:
  - entity
  - roster
  - phase3-seam
related:
  - "[[concepts/agent-node-routing]]"
sources:
  - "[[entities/createAgentsRoster]]"
---

# getRoster (agents-roster aggregation)

## Overview

`getRoster` builds the unified fleet-wide agent roster — local agents + mesh-node agents + federation-remote agents — grouped by node and cached for `fleetCacheMs` (60s default) (`src/agents-roster.js:455-465`). This is the roster shape `resolveAgentNode` consumes (via the injected `rosterFn`) to decide which node hosts an agent, and the shape a Phase 3 worker-spawn admission step would read.

## Signature / Definition

```js
async getRoster() -> {
  agents: Array<AgentRecord>,
  byNode: { [nodeName: string]: AgentRecord[] },
  counts: { total: number, active: number, nodes: number },
  timestamp: number
}

// AgentRecord (the fields the locator + admission step read):
// {
//   id: string,             // bare agent id — the routing key
//   name: string,
//   model: string|null,
//   workspace: string|null,
//   subagentsMax: number|null,
//   sessionCount: number,
//   lastActiveAt: number|null,
//   active: boolean,        // session touched < ACTIVE_THRESHOLD_MS (10min)
//   source: "openclaw"|"hermes"|"none",
//   node: string,           // node binding — THE field resolveAgentNode matches on
//   via?: "mesh"|"federation" // remote-attribution transport (local omits it)
// }
```

## Behavior

- **Cache check** (`:456-457`): returns cached roster if `now - fleetCache.at < fleetCacheMs`.
- **Local** (`:459`, `buildRoster(getLocalRoster().agents, ...)`): local agents get `node: hostname` stamped in `buildRoster` (`:432`). Local agent fields come from `parseAgentsConfig` (openclaw.json) enriched with session activity (`:267-278`).
- **Mesh remotes** (`:459-460`, `collectRemoteAgents`): every ONLINE registered mesh node is GET-queried at `<base>/api/agents`; each agent attributed with `node: <hostname>, via:"mesh"` (`:317-333`, `:336-372`).
- **Federation remotes** (`:461`, `collectFederationAgents`): reachable federation remotes queried the same way, deduped against mesh hostnames (`:385-428`).
- **`byNode`** (`:434-437`): agents grouped by their `node` field — this is the per-node index a worker-pool selector would scan.

### What the locator reads

[[entities/resolveAgentNode]] filters `roster.agents` by `a.id === agentId`, then selects a node by: explicit `@node` pin → `a.node === selfNode` (local) → `matches[0]` (first remote). So the two load-bearing fields for routing are **`id`** (match key) and **`node`** (binding). `active`, `subagentsMax`, and `sessionCount` are the natural inputs a Phase 3 warm-worker admission step would gate on (e.g. "pick the least-loaded ONLINE worker whose `subagentsMax` is not saturated").

## Connections

- **depends_on:** [[entities/getLocalRoster]], [[entities/collectRemoteAgents]], [[entities/buildRoster]]
- **used_by:** [[entities/getAssignees]] (kanban dropdown), [[entities/resolveAgentNode]] (via `rosterFn`)
- **related:** [[concepts/agent-node-routing]]

## History

- **Last touched:** commit `21a66cb` by BroClaw2 on 2026-06-10 — "feat: v1.8 wave B — kanban dispatch, cost budgets, 1Password secrets, session control, Hermes agents".

## Sources

- `src/agents-roster.js` (lines 455–465) — `getRoster`.
- `src/agents-roster.js` (lines 431–449) — `buildRoster` (record + `byNode` shape).
- `src/agents-roster.js` (lines 316–334) — `attributeRemoteAgent` (remote record fields).
- `src/agents-roster.js` (lines 472–480) — `getAssignees` (id + `id@node` forms).
