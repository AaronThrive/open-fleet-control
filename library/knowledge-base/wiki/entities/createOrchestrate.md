---
type: entity
title: "createOrchestrate"
entity_type: service
status: developing
created: 2026-06-18
updated: 2026-06-18
path: "src/orchestrate.js"
language: js
endpoints:
  - "[[entities/handleOrchestrate]]"
env_vars: []
depends_on:
  - "[[entities/createRunRegistry]]"
  - "[[entities/normalizeTimeoutSec]]"
used_by:
  - "[[entities/index-bootstrap]]"
last_commit_hash: "f396b27"
tested_by:
  - "[[entities/orchestrate-test]] (`tests/orchestrate.test.js`)"
tags:
  - entity
  - orchestration
  - phase3-seam
related:
  - "[[entities/runBoard]]"
  - "[[entities/runChain]]"
  - "[[concepts/orchestrate-run-registry]]"
sources:
  - "[[entities/orchestrate-module]]"
---

# createOrchestrate

## Overview

`createOrchestrate` is the orchestration module factory — the composition root that closes over `kanban`, `dispatch`, the config section, and a `createRunRegistry` instance, and returns the orchestration API `{runSingle, runBoard, runChain, getStatus, getRun, waitForRun}` (`src/orchestrate.js:300-865`). It is the object Phase 3 extends/wraps.

## Signature / Definition

```js
createOrchestrate({
  kanban,                  // from createKanban() — REQUIRED
  dispatch,                // from createDispatch() — REQUIRED
  onEvent,                 // (event) => void lifecycle hook
  config = {},             // fleet.orchestrate section: {enabled=true, timeoutSec, sequentialBoard}
  nowFn = Date.now,
  setTimerFn = setTimeout,
}) -> { runSingle, runBoard, runChain, getStatus, getRun, waitForRun }
```

## Behavior

- Throws if `kanban` or `dispatch` is missing (`:309-310`).
- `enabled = config.enabled !== false` (`:312`).
- `defaultTimeoutSec = normalizeTimeoutSec(config.timeoutSec, 1200)` (`:313`).
- `defaultSequentialBoard = config.sequentialBoard === true` (`:319`) — the baked-in single-box reliability default; clients inherit it because the installer ships no orchestrate config knob.
- Builds `registry = createRunRegistry({nowFn, emit, setTimerFn})` (`:324`).
- `runSingle(taskId, opts)` is a thin pass-through to `dispatch.dispatchTask` (`:479-482`).
- `getStatus()` → `{available, enabled, timeoutSec}` (`:861-863`), mirroring `dispatch.getStatus` shape.

**Wiring (`src/index.js:296-321`):** `createOrchestrate({ kanban: fleet.kanban, dispatch, config: CONFIG.fleet.orchestrate || {}, onEvent })`. The `onEvent` hook broadcasts `orchestration.completed` over the `fleet.orchestration` SSE channel and card-lifecycle events over `fleet.kanban`.

## Connections

- **depends_on:** [[entities/createRunRegistry]], [[entities/normalizeTimeoutSec]], [[entities/dispatchTask]] (injected)
- **endpoints:** [[entities/handleOrchestrate]]
- **used_by:** [[entities/index-bootstrap]]
- **related:** [[concepts/orchestrate-run-registry]]

## Tested by

- [[entities/orchestrate-test]] (`tests/orchestrate.test.js`)
- [[entities/orchestrate-async-test]] (`tests/orchestrate-async.test.js`)

## History

- **Last touched:** commit `f396b27` by BroClaw2 on 2026-06-18 — added `defaultSequentialBoard`.
- **Introduced:** v2.3.0 orchestration (`3fdd0cb`).

## Sources

- `src/orchestrate.js` (lines 284–865) — `createOrchestrate`.
- `src/index.js` (lines 291–321) — wiring.
