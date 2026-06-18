---
type: entity
title: "collectOutcome"
entity_type: function
status: developing
created: 2026-06-18
updated: 2026-06-18
path: "src/orchestrate.js"
language: js
depends_on:
  - "[[entities/readSettledAttempt]]"
  - "[[entities/attemptSucceeded]]"
  - "[[entities/readAttemptResultText]]"
used_by:
  - "[[entities/runBoard]]"
  - "[[entities/runChain]]"
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

# collectOutcome

## Overview

`collectOutcome` reads one agent's outcome back off its settled (or timed-out) kanban attempt and normalizes it into `{agent, text, ok, truncated, timedOut}` (`src/orchestrate.js:397-411`). Both `runBoard` and `runChain` call it once per dispatched seat/step after `withTimeout` resolves.

## Signature / Definition

```js
collectOutcome(taskId, dispatched, settled)
  -> { agent, text: string|null, ok: boolean, truncated: boolean, timedOut: boolean }
// dispatched: { agent, attemptIndex }
// settled:    did the completion Promise resolve in time?
```

## Behavior

- If `!settled` (timed out): returns `{agent, text:null, ok:false, truncated:false, timedOut:true}` (`:398-406`).
- Otherwise re-reads the settled attempt via `readSettledAttempt(taskId, dispatched.attemptIndex)` (`:407`), then `ok = attemptSucceeded(attempt)` (`:408`) and `{text, truncated} = readAttemptResultText(attempt)` (`:409`), returning `timedOut:false` (`:410`).

`readAttemptResultText` (`:239-253`) prefers `attempt.result_text` (the full agent output, a sibling dispatch.js change board/chain are designed around) and falls back to the 300-char `attempt.note` snippet flagged `truncated:true`. Phase 3 inherits this same full-result-text dependency.

## Connections

- **depends_on:** [[entities/readSettledAttempt]], [[entities/attemptSucceeded]], [[entities/readAttemptResultText]]
- **used_by:** [[entities/runBoard]] (`:599`, `:641`), [[entities/runChain]] (`:815`)

## Tested by

- [[entities/orchestrate-test]] (`tests/orchestrate.test.js`)

## History

- **Last touched:** commit `f396b27` by BroClaw2 on 2026-06-18 (file-level).
- **Introduced:** v2.3.0 orchestration (`3fdd0cb`).

## Sources

- `src/orchestrate.js` (lines 390–411) — `collectOutcome`.
- `src/orchestrate.js` (lines 227–258) — `readAttemptResultText` / `attemptSucceeded`.
