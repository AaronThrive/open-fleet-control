---
type: concept
title: "Sequential vs Parallel Board Dispatch"
complexity: advanced
domain: "orchestration"
aliases:
  - "sequentialBoard"
  - "single-box reliability"
created: 2026-06-18
updated: 2026-06-18
status: developing
tags:
  - concept
  - orchestration
  - phase3-seam
related:
  - "[[concepts/board-fan-in-pattern]]"
  - "[[entities/runBoard]]"
sources:
  - "[[entities/runBoard]]"
---

# Sequential vs Parallel Board Dispatch

## Definition

A board council can fan its question to N agents either ONE-AT-A-TIME (sequential) or ALL-AT-ONCE (parallel). The mode is chosen in [[entities/runBoard]] by `const sequential = params.sequential === undefined ? defaultSequentialBoard : params.sequential === true` (`src/orchestrate.js:537-538`). The server default is `fleet.orchestrate.sequentialBoard` (currently `true`).

## How it works

- **Sequential branch (`src/orchestrate.js:569-601`):** a `for` loop dispatches one advisor, awaits its OWN fresh `budgetMs` deadline via `withTimeout`, collects, then the next. Only ONE open dispatch ever exists.
- **Parallel branch (`src/orchestrate.js:602-644`):** `agents.map` dispatches all seats up front, then `Promise.all` races every completion against ONE shared deadline.
- Both branches preserve board semantics: same independent question to each agent, collect-all, no chain-style short-circuit.

## Why it matters

`f396b27` (2026-06-18) flipped the default to sequential because a parallel council co-saturated the single Node gateway event loop and thrashed the box (event-loop delay ~99s, load 32, swap exhausted, all advisors timed out). **Phase 3 (on-demand isolated-worker pool) intends to flip this back to parallel** — once workers are isolated, the co-saturation root cause is removed. The flag is a per-run override; the durable default lives in config so it does not depend on the LLM caller remembering to pass it. Misreading the boolean-or-undefined coercion (`src/fleet-routes.js:660-666`) would silently disable the default for the common omitted-field case.

## Examples in this codebase

- [[entities/runBoard]] — both branches.
- [[entities/handleOrchestrate]] — threads `sequential` as boolean-or-undefined.
- [[entities/fleet-dispatch-orchestrate-config]] — the `sequentialBoard` default.

## Connections

- **involves entities:** [[entities/runBoard]], [[entities/withTimeout]], [[entities/handleOrchestrate]]
- **related concepts:** [[concepts/board-fan-in-pattern]]

## Sources

- `src/orchestrate.js` (lines 537–644) — branch selection + both branches.
- commit `f396b27` (2026-06-18) — introduced the sequential branch + default.
