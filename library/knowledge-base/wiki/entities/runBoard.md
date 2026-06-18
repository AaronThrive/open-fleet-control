---
type: entity
title: "runBoard"
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
  - "[[entities/normalizeBudgetCheck]]"
  - "[[entities/normalizeTimeoutSec]]"
  - "[[entities/startRun]]"
  - "[[entities/dispatchTask]]"
used_by:
  - "[[entities/handleOrchestrate]]"
last_commit_hash: "f396b27"
tested_by:
  - "[[entities/orchestrate-test]] (`tests/orchestrate.test.js`)"
  - "[[entities/orchestrate-async-test]] (`tests/orchestrate-async.test.js`)"
tags:
  - entity
  - orchestration
  - phase3-seam
related:
  - "[[concepts/board-fan-in-pattern]]"
  - "[[concepts/sequential-vs-parallel-board]]"
  - "[[entities/runChain]]"
sources:
  - "[[entities/orchestrate-module]]"
---

# runBoard

## Overview

`runBoard` is the FAN-IN ("council") orchestration primitive: it asks ONE question to N agents and collects every answer, never synthesizing (the Chief reads `results` and writes the synthesis). It is the function Phase 3 (on-demand isolated-worker pool) will flip back to parallel. It returns SYNCHRONOUSLY with a `runId`; the council runs in the background via the run registry (`src/orchestrate.js:520-694`).

## Signature / Definition

```js
runBoard(params = {}) -> {
  runId: string,            // "orx_<16hex>"
  mode: "board",
  agents: string[],
  status: "running",
  startedAt: string,        // ISO
  completion: Promise        // background promise (for ?wait=true + tests)
}
```

Params it reads (`src/orchestrate.js:520-540`):

| Param | Required | Default source | Notes |
|---|---|---|---|
| `title` | yes | — | council question summary; `requireString` → 400 if empty |
| `question` | yes | — | the question every agent answers; `requireString` |
| `agents` | yes | — | non-empty `string[]`; each `requireString`'d (`:524-527`) |
| `actor` | no | `"operator"` | dispatching identity (`:528`) |
| `timeoutSec` | no | `defaultTimeoutSec` (config `fleet.orchestrate.timeoutSec`, default 1200; clamped by `normalizeTimeoutSec` to ≤3600) (`:529`) |
| `sequential` | no | `undefined` → server default `defaultSequentialBoard` (`config.sequentialBoard === true`); explicit `true`/`false` forces that mode (`:537-538`) |
| `budgetCheck` | no | disabled | `({spentUSD}) => block|null` mid-run CLOSED-ceiling guard (`:540`) |

## Behavior

1. `ensureEnabled()` → throws 503 if `fleet.orchestrate.enabled === false` (`:521`).
2. Validates title/question/agents/actor/timeoutSec/sequential/budgetCheck (`:522-540`).
3. Computes `sequential`: `params.sequential === undefined ? defaultSequentialBoard : params.sequential === true` (`:537-538`). **The server default (`config.sequentialBoard`) is the durable single-box reliability guarantee** — it does NOT rely on the LLM caller passing the flag.
4. Emits `orchestrate.board_started` (`:542`).
5. Defines a background `runner` async fn (`:548-683`) and hands it to `startRun({mode:"board", agents, runner})` (`:685`), returning the running snapshot immediately.

The `runner` (`:548-683`) — what Phase 3 hooks:

- **SEQUENTIAL branch** (`:569-601`): `for` loop over `agents`. Per agent: budget re-check via `checkBudget({spentUSD: i})` (`:583`); `kanban.createTask` (`:589`); `dispatch.dispatchTask(card.id, {agent, actor, isBoard: true})` (`:592`); `await withTimeout(dispatched.completion, budgetMs, setTimerFn)` against its OWN fresh per-seat deadline (`:598`); `collectOutcome` (`:599`). Only ONE open dispatch ever exists → never trips `maxConcurrent`, never co-saturates the gateway event loop. A failed/timed-out seat does NOT skip the rest (board semantics, unlike chain).
- **PARALLEL branch** (`:602-644`): `agents.map` builds all seats up front (budget re-check per seat at `:610`), dispatches all with `isBoard: true` (`:620`), then `Promise.all` races every `seat.dispatched.completion` against ONE shared `budgetMs` deadline (`:630-644`). **This is the branch Phase 3 will make the default again.**
- Maps `outcomes` → `results` (`{agent, taskId, text, ok, truncated}`) (`:647-653`), `missing` (timed-out / dispatch-refused / budget seats with reasons `"timeout"`/`"budget"`/`"dispatch refused: …"`) (`:654-664`), `truncatedAny` (`:665`).
- Emits `orchestrate.board_completed` (`:667-672`).
- Returns `{taskId, question, results, missing, truncatedAny, budgetHalt}` (`:674-682`) — consumed by the registry on settle.

**Call order inside runBoard:** `ensureEnabled` → validators → `normalizeBudgetCheck` → `emit(board_started)` → (per seat) `checkBudget` → `kanban.createTask` → `dispatch.dispatchTask` → `withTimeout` → `collectOutcome` → `emit(board_completed)` → `startRun`.

**Concurrency caveat (`:500-502`):** dispatch enforces `maxConcurrent` (default 3). In the PARALLEL branch, if `agents.length` exceeds it, later `dispatchTask` calls throw 429; runBoard surfaces that per-agent (`ok:false`, `dispatchError`) rather than aborting. The sequential branch never hits this.

## Connections

- **depends_on:** [[entities/withTimeout]], [[entities/collectOutcome]], [[entities/buildCardDescription]], [[entities/normalizeBudgetCheck]], [[entities/normalizeTimeoutSec]], [[entities/startRun]], [[entities/dispatchTask]]
- **used_by:** [[entities/handleOrchestrate]] (POST /api/fleet/orchestrate, board mode)
- **related concepts:** [[concepts/board-fan-in-pattern]], [[concepts/sequential-vs-parallel-board]]

## Tested by

- [[entities/orchestrate-test]] (`tests/orchestrate.test.js`)
- [[entities/orchestrate-async-test]] (`tests/orchestrate-async.test.js`)
- [[entities/orchestrate-routes-test]] (`tests/orchestrate-routes.test.js`)

## History

- **Last touched:** commit `f396b27` by BroClaw2 on 2026-06-18 — "feat: sequential board orchestration + raised timeouts for single-box reliability" (added the sequential branch + `config.sequentialBoard` default; raised `timeoutSec` 600→1200).
- **Introduced:** the board/chain orchestration shipped in v2.3.0 (`3fdd0cb`, 2026-06-16).

## Sources

- `src/orchestrate.js` (lines 484–694) — `runBoard` definition.
- `src/orchestrate.js` (lines 300–324) — `defaultSequentialBoard` / `defaultTimeoutSec` derivation from config.
