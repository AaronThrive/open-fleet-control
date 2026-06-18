---
type: entity
title: "handleOrchestrate (POST/GET /api/fleet/orchestrate)"
entity_type: endpoint
status: developing
created: 2026-06-18
updated: 2026-06-18
path: "src/fleet-routes.js"
language: js
http_method: "POST, GET"
route_path: "/api/fleet/orchestrate[/:runId]"
handler: "[[entities/handleOrchestrate]]"
auth_required: true
depends_on:
  - "[[entities/runBoard]]"
  - "[[entities/runChain]]"
  - "[[entities/requireRosterAgent]]"
  - "[[entities/refuseOrchestration]]"
used_by: []
last_commit_hash: "f396b27"
tested_by:
  - "[[entities/orchestrate-routes-test]] (`tests/orchestrate-routes.test.js`)"
tags:
  - entity
  - endpoint
  - orchestration
  - phase3-seam
related:
  - "[[entities/runBoard]]"
  - "[[concepts/orchestrate-run-registry]]"
sources:
  - "[[entities/fleet-routes-module]]"
---

# handleOrchestrate

## Overview

`handleOrchestrate` is the REST front door over the orchestration module (`src/fleet-routes.js:580-727`). It is where `runBoard`/`runChain` are invoked and where the `sequential` flag is threaded through as boolean-or-undefined.

## HTTP method + route

| Method | Path | Behavior |
|---|---|---|
| `POST` | `/api/fleet/orchestrate` `{mode:"single"}` | `200` dispatchTask wrapper (`:630-645`) |
| `POST` | `/api/fleet/orchestrate` `{mode:"board"}` | `202 {runId, status:"running"}` (or `200` snapshot on `wait`) (`:647-688`) |
| `POST` | `/api/fleet/orchestrate` `{mode:"chain"}` | `202 {runId}` (or `200` on `wait`) (`:690-724`) |
| `GET` | `/api/fleet/orchestrate/:runId` | `200` run snapshot \| `404` (`:590-599`) |

## Behavior

- `503` if orchestrate not configured (`:581-584`).
- GET poll: read-only, no rate-limit token; `orchestrate.getRun(runId)` → `200 {success, ...snapshot}` or `404` (`:590-599`).
- POST: `guardMutation` (rate-limit) (`:603-604`), parse body (`:606`).
- `budgetMode` defaults `"closed"` (`:612`); pre-dispatch gate `refuseOrchestration` runs BEFORE any card (`:618`). A `budgetCheck` closure is built for the mid-run CLOSED-ceiling re-check and passed into runBoard/runChain (`:624-628`).
- **Board (`:647-688`):** requires non-empty `agents[]` (400, `:648-649`); validates EACH agent against the local roster via `requireRosterAgent` (fail-closed) BEFORE any card (`:651`); calls `orchestrate.runBoard({title, question, agents, actor, timeoutSec, sequential: typeof body.sequential === "boolean" ? body.sequential : undefined, budgetCheck})` (`:654-667`). **CRITICAL: `sequential` is passed boolean-or-undefined — omitting it lets the server default (`fleet.orchestrate.sequentialBoard`) fire; do NOT coerce absent→false** (`:660-666`). Async returns `202`; `wait:true`/`?wait=true` awaits `orchestrate.waitForRun` → `200` (`:673-687`).
- **Chain (`:690-724`):** requires non-empty `steps[]` (400); validates each `step.agent` (`:694`); `orchestrate.runChain({title, steps, actor, timeoutSec, budgetCheck})` (`:697-703`); same 202/wait pattern.
- Unknown mode → `400 "Body 'mode' must be one of: single, board, chain"` (`:726`).

## Handler

This IS the handler. Routed from `routeRequest` `case "orchestrate"` (`src/fleet-routes.js:1278-1279`).

## Connections

- **depends_on:** [[entities/runBoard]], [[entities/runChain]], [[entities/requireRosterAgent]], [[entities/refuseOrchestration]]
- **related:** [[concepts/orchestrate-run-registry]]

## Tested by

- [[entities/orchestrate-routes-test]] (`tests/orchestrate-routes.test.js`)

## History

- **Last touched:** commit `f396b27` by BroClaw2 on 2026-06-18 — threaded `sequential` as boolean-or-undefined so the server default fires when the caller omits it.
- **Introduced:** async 202+poll registry, v2.3.0 (`3fdd0cb`).

## Sources

- `src/fleet-routes.js` (lines 557–727) — `handleOrchestrate` + `refuseOrchestration`.
- `src/fleet-routes.js` (lines 432–448) — `requireRosterAgent` (fail-closed roster validation).
