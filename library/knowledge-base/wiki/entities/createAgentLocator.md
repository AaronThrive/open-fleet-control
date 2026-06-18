---
type: entity
title: "createAgentLocator"
entity_type: function
status: developing
created: 2026-06-18
updated: 2026-06-18
path: "src/agent-locator.js"
language: js
depends_on:
  - "[[entities/resolveAgentNode]]"
used_by:
  - "[[entities/index-bootstrap]]"
last_commit_hash: "c16dac8"
tested_by:
  - "[[entities/agent-locator-test]] (`tests/agent-locator.test.js`)"
tags:
  - entity
  - dispatch
  - routing
related:
  - "[[concepts/agent-node-routing]]"
sources:
  - "[[entities/agent-locator-module]]"
---

# createAgentLocator

## Overview

`createAgentLocator` is the locator factory: it validates its dependencies and returns `{resolve}` (`src/agent-locator.js:73-119`). It is built ONCE in `src/index.js` (`:450-454`) after `agentsRoster` and `fleet.mesh` exist, and the dispatch module holds a lazy closure over the module-level `agentLocator` binding so it is only invoked at dispatch time.

## Signature / Definition

```js
createAgentLocator({
  rosterFn,   // async () => { agents: [{ id, node, ... }] }   REQUIRED
  meshFn,     // async () => { nodes: [{ hostname, url, healthPath, health }] }  REQUIRED
  selfNode,   // this node's hostname — local-vs-remote pivot
}) -> { resolve }
```

## Behavior

- Throws if `rosterFn` or `meshFn` is not a function (`:74-79`).
- Returns `{resolve}` ([[entities/resolveAgentNode]]).
- **Wiring (`src/index.js:450-454`):** `rosterFn: () => agentsRoster.getRoster()`, `meshFn: () => fleet.mesh.getState()`, `selfNode: CONFIG.fleet.dispatch.node || os.hostname()`.

## Connections

- **depends_on:** [[entities/resolveAgentNode]] (returned), `agentsRoster` + `fleet.mesh` (injected)
- **used_by:** [[entities/index-bootstrap]]
- **related:** [[concepts/agent-node-routing]]

## Tested by

- [[entities/agent-locator-test]] (`tests/agent-locator.test.js`)

## History

- **Last touched:** commit `c16dac8` by BroClaw2 on 2026-06-17 (v2.4.0).
- **Introduced:** Phase 2 remote dispatch, v2.3.0 (`3fdd0cb`).

## Sources

- `src/agent-locator.js` (lines 64–121) — factory + export.
- `src/index.js` (lines 450–454) — wiring.
