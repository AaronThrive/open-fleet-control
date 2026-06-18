---
type: entity
title: "synthStdout (remote→local settlement adapter)"
entity_type: function
status: developing
created: 2026-06-18
updated: 2026-06-18
path: "src/dispatch.js"
language: js
depends_on: []
used_by:
  - "[[entities/startRun]]"
last_commit_hash: "3bc56c1"
tested_by: []
tags:
  - entity
  - dispatch
  - routing
related:
  - "[[concepts/local-vs-remote-dispatch]]"
sources:
  - "[[entities/startRun]]"
---

# synthStdout (remote→local settlement adapter)

## Overview

`synthStdout` rebuilds a minimal CLI-shaped stdout JSON from a remote `agent-run` envelope so `parseRunResult` records the `sessionId` + `result_text` identically whether the run was local (real `openclaw` stdout) or remote (HTTP envelope) (`src/dispatch.js:91-104`). It is the small but load-bearing adapter that lets the settlement watcher be transport-agnostic.

## Signature / Definition

```js
function synthStdout(body: { success, error, detail }) -> string  // JSON

// produces: { result: { meta: { agentMeta: { sessionId } }, text }, error }
// reading body.detail.sessionId, body.detail.outputText,
// body.detail.cliError / body.error
```

## Behavior

- Reads `body.detail` (defaulting to `{}` if absent) (`:92`).
- Emits `result.meta.agentMeta.sessionId = detail.sessionId || null` and `result.text = detail.outputText || null` — exactly the two keys `parseRunResult` reads (`:251-258`).
- `error` = `detail.cliError` OR (`body.success === false` → `body.error || "agent run reported failure"`) else `undefined` (`:98-103`).
- Called by `runRemote` on both the agent-reported-error path (`:402-404`) and the success path (`:411`), so a remote agent that reports a CLI error settles via `settleFailure` exactly like a local CLI error.

## Connections

- **used_by:** [[entities/startRun]] (`runRemote`)
- **related:** [[concepts/local-vs-remote-dispatch]]

## History

- **Last touched:** commit `3bc56c1` by BroClaw2 on 2026-06-17 — node→node dispatch token auth.

## Sources

- `src/dispatch.js` (lines 91–104) — `synthStdout`.
- `src/dispatch.js` (lines 241–259) — `parseRunResult` (the consumer).
