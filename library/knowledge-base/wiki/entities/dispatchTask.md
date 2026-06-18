---
type: entity
title: "dispatchTask"
entity_type: function
status: developing
created: 2026-06-18
updated: 2026-06-18
path: "src/dispatch.js"
language: js
depends_on:
  - "[[entities/resolveAgentNode]]"
  - "[[entities/startRun]]"
  - "[[entities/composeKickoffMessage]]"
  - "[[entities/canonicalResultText]]"
used_by:
  - "[[entities/runBoard]]"
  - "[[entities/runChain]]"
last_commit_hash: "3bc56c1"
tested_by: []
tags:
  - entity
  - dispatch
  - phase3-seam
related:
  - "[[concepts/agent-node-routing]]"
  - "[[concepts/local-vs-remote-dispatch]]"
sources:
  - "[[entities/startRun]]"
  - "[[entities/runRemote]]"
---

# dispatchTask

## Overview

`dispatchTask` is the dispatch primitive: it fires ONE agent run for a kanban card and records the attempt, resolving as soon as the run has been *started* — it never awaits the agent turn itself (`src/dispatch.js:695-769`). It is the single entry point the board (`runBoard`) and chain (`runChain`) orchestration runners call per seat. The `{agent, actor, isBoard}` options shape the board passes through here verbatim.

## Signature / Definition

```js
dispatchTask(taskId: string, opts?: {
  agent: string,        // bare id OR "id@node" routing ref (REQUIRED)
  node?: string,        // explicit node pin (legacy local-only guard input)
  actor?: string,       // attribution; default "operator"
  isBoard?: boolean,    // board framing → "#ceo-boardroom" + "@Chief" lead
  slackChannel?: string // overrides derived "#<agent>-command"
}) -> {
  task,          // latest card snapshot
  sessionKey,    // "agent:<bareId>:kanban-<taskId>-<startedMs>"
  agent,         // BARE id (any @node stripped)
  attemptIndex,  // stable index of the open dispatched attempt
  completion     // Promise<void> resolving when the run settles (watcher)
}
```

## Behavior

- **Validation order** (throws `httpError` with status before any bookkeeping): `ensureAvailable` (503 if disabled / no `openclaw` on PATH) → `requireAgent` (400 if empty) → legacy-only `ensureLocalNode(opts.node)` *only when no resolver is wired* (`:696-708`) → `requireTask` (404) → `hasOpenDispatch` (409) → `countOpenDispatches >= maxConcurrent` (429, default 3) (`:712-720`).
- **`@node` handling:** the ref may carry `id@node`; ROUTING uses the full ref, but the `--agent` arg, session key, remote body, and attempt record all use the BARE id (`agentRef.slice(0, indexOf("@"))`, `:703`). Forwarding the pinned form previously caused an "Invalid agent id" failure.
- **Run start:** `startRun(opts.node, {args, agent, agentRef, message, sessionKey})` is fired NOW, never awaited (`:743-748`). `startRun` decides local vs remote (see [[entities/startRun]]).
- **Bookkeeping:** `kanban.addAttempt` (the OPEN attempt IS the dispatch lock) → move `inbox`→`assigned` only if still in inbox → comment → emit `task.dispatched` (`:752-761`).
- **Settlement:** `completion = settledPromise.then(settled => handleRunSettled(...))` (`:763-765`). The watcher closes the attempt, sets `result_text`, auto-moves the card, and fires the `dispatchComplete` alert.

### `result_text` population (the truncation risk)

`result_text` is the canonical full answer stored on the attempt. It is set in `handleRunSettled` ONLY on the success branch (`src/dispatch.js:625-630`):

```js
const fullText = run.outputText ? canonicalResultText(run.outputText) : null;
closeAttempt(..., { result: "success", note: noteParts.join(" · "), result_text: fullText });
```

- `run.outputText` comes from `parseRunResult` → `extractOutputText` (`:207-221`), which reads, in order: `result.payloads[].text` (joined), then `result.text`, `result.output`, `parsed.output`, `parsed.text`. If NONE are present, `outputText` is `null` and **`result_text` is `null`** (not the 300-char note).
- The 300-char value is a *different* field: the attempt `note` carries `result: <snippet(outputText)>` capped at `RESULT_SNIPPET_MAX = 300` (`:61`, `:189-194`, `:620-624`). `snippet()` collapses whitespace; `canonicalResultText()` preserves newlines and caps at `RESULT_TEXT_MAX = 12 KiB` (`:62`, `:201-205`).
- **Reliable when:** the CLI/remote JSON yields parseable output text via one of the keys above → `result_text` = full answer (≤12 KiB). **Falls back to `null` when:** stdout is unparseable, the agent emitted no text, or the run failed/timed out (the failure branch `settleFailure` never sets `result_text`, `:591-608`). There is no path where `result_text` itself is the 300-char note — that conflation is the risk to correct in the PRD: the UI one-liner (note) and the canonical answer (`result_text`) are separate, and `result_text` is null-or-full, never truncated to 300.

## Connections

- **depends_on:** [[entities/resolveAgentNode]] (via the `resolveAgentNode` closure), [[entities/startRun]], [[entities/composeKickoffMessage]], [[entities/canonicalResultText]]
- **used_by:** [[entities/runBoard]], [[entities/runChain]]
- **related concepts:** [[concepts/agent-node-routing]], [[concepts/local-vs-remote-dispatch]]

## History

- **Last touched:** commit `3bc56c1` by BroClaw2 on 2026-06-17 — "release: v2.4.3 — node→node dispatch token auth (coexists with verifyServeOrigin)".
- **Recent activity:**
  - `3bc56c1` — node→node dispatch token auth (2026-06-17)
  - `cbb7fa0` — fix remote-dispatch @node-strip; cross-node dispatch works live (2026-06-17)
  - `3fdd0cb` — Phase 2 remote dispatch (agent→node locator, fail-closed action-guard) (2026-06-16)

## Sources

- `src/dispatch.js` (lines 695–769) — `dispatchTask`.
- `src/dispatch.js` (lines 610–643) — `handleRunSettled` (where `result_text` is set).
- `src/dispatch.js` (lines 189–205) — `snippet` vs `canonicalResultText`.
