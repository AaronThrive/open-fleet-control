---
type: entity
title: "runChain"
entity_type: function
status: developing
created: 2026-06-18
updated: 2026-06-18
path: "src/orchestrate.js"
language: js
depends_on:
  - "[[entities/withTimeout]]"
  - "[[entities/collectOutcome]]"
  - "[[entities/buildCardDescription]]"
  - "[[entities/startRun]]"
  - "[[entities/dispatchTask]]"
used_by:
  - "[[entities/handleOrchestrate]]"
last_commit_hash: "f396b27"
tested_by:
  - "[[entities/orchestrate-test]] (`tests/orchestrate.test.js`)"
tags:
  - entity
  - orchestration
related:
  - "[[entities/runBoard]]"
  - "[[concepts/board-fan-in-pattern]]"
sources:
  - "[[entities/orchestrate-module]]"
---

# runChain

## Overview

`runChain` is the CHAIN ("assembly line") orchestration primitive: an ordered pipeline of `{agent, instruction}` steps where each settled step's full result is injected as context into the next step's card body (`src/orchestrate.js:723-854`). Steps run STRICTLY sequentially (k+1 needs k's answer). Sibling of [[entities/runBoard]].

## Signature / Definition

```js
runChain(params = {}) -> {
  runId, mode:"chain", agents, status:"running", startedAt, completion
}
// params: { title, steps:[{agent, instruction}], actor="operator", timeoutSec, budgetCheck }
// collected (in registry): { title, steps, final, ok, stoppedAt, budgetHalt }
```

## Behavior

- Validates `title` + non-empty `steps[]`, each with `requireString`'d `agent` + `instruction` (`:724-737`).
- `timeoutSec` is the PER-STEP budget (`:739`).
- Background `runner` (`:749-839`): `for` loop; once `stoppedAt !== null` remaining steps recorded `skipped:true`; CLOSED ceiling re-checked BEFORE each step via `checkBudget({spentUSD: i})` (`:775`); `buildCardDescription({instruction, context})` injects the prior step's full text (`:791`); `dispatch.dispatchTask(card.id, {agent, actor})` (NO `isBoard` — chain steps keep their own `#<agent>-command` channel) (`:799`); `withTimeout` (`:814`); `collectOutcome` (`:815`). A failed/timed-out step SHORT-CIRCUITS the chain (`stoppedAt = i`) — unlike board (`:826-830`). On success, `context = final = outcome.text` (`:832-833`).
- `ok = stoppedAt === null` (`:836`).

## Connections

- **depends_on:** [[entities/withTimeout]], [[entities/collectOutcome]], [[entities/buildCardDescription]], [[entities/startRun]], [[entities/dispatchTask]]
- **used_by:** [[entities/handleOrchestrate]] (chain mode)
- **related:** [[entities/runBoard]]

## Tested by

- [[entities/orchestrate-test]] (`tests/orchestrate.test.js`)

## History

- **Last touched:** commit `f396b27` by BroClaw2 on 2026-06-18 (file-level).
- **Introduced:** v2.3.0 orchestration (`3fdd0cb`).

## Sources

- `src/orchestrate.js` (lines 696–854) — `runChain`.
