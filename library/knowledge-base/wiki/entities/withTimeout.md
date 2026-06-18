---
type: entity
title: "withTimeout"
entity_type: function
status: developing
created: 2026-06-18
updated: 2026-06-18
path: "src/orchestrate.js"
language: js
depends_on: []
used_by:
  - "[[entities/runBoard]]"
  - "[[entities/runChain]]"
  - "[[entities/waitForRun]]"
last_commit_hash: "f396b27"
tested_by:
  - "[[entities/orchestrate-test]] (`tests/orchestrate.test.js`)"
tags:
  - entity
  - orchestration
  - phase3-seam
related:
  - "[[entities/runBoard]]"
sources:
  - "[[entities/orchestrate-module]]"
---

# withTimeout

## Overview

`withTimeout` is the never-rejecting race primitive that lets the board/chain runners stop AWAITING a dispatch `completion` Promise after `ms` without killing the underlying agent run (`src/orchestrate.js:199-225`). The underlying promise keeps running (the dispatch watcher still closes its attempt); `withTimeout` just resolves `{settled:false}` on timeout.

## Signature / Definition

```js
withTimeout(promise, ms, setTimer = setTimeout)
  -> Promise<{ settled: boolean, value?: T }>
```

## Behavior

- Returns a Promise that resolves (never rejects) to `{settled:true, value}` when `promise` resolves first, or `{settled:false}` when the `ms` timer fires first (`src/orchestrate.js:200-224`).
- The timer is `unref`'d so a pending wait never keeps the process alive (`:207`).
- Defensive: even if the awaited promise rejects (dispatch.completion is documented never to reject), it resolves `{settled:true, value:undefined}` (`:216-222`).
- `setTimer` is injectable for deterministic tests (`:199`).

This is the exact mechanism Phase 3 must respect for per-seat / per-step deadlines: SEQUENTIAL board gives each seat its OWN fresh `budgetMs` via a separate `withTimeout` call (`:598`); PARALLEL board shares ONE `budgetMs` deadline across all seats (`:640`).

## Connections

- **depends_on:** (none — leaf primitive)
- **used_by:** [[entities/runBoard]] (`:598`, `:640`), [[entities/runChain]] (`:814`), [[entities/waitForRun]] (`:465`)

## Tested by

- [[entities/orchestrate-test]] (`tests/orchestrate.test.js`)

## History

- **Last touched:** commit `f396b27` by BroClaw2 on 2026-06-18 (file-level; helper exported unchanged in shape).
- **Introduced:** v2.3.0 orchestration (`3fdd0cb`).

## Sources

- `src/orchestrate.js` (lines 187–225) — `withTimeout`.
- Exported at `src/orchestrate.js:872`.
