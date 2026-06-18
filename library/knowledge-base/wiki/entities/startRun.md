---
type: entity
title: "startRun + runRemote (dispatch routing core)"
entity_type: function
status: developing
created: 2026-06-18
updated: 2026-06-18
path: "src/dispatch.js"
language: js
depends_on:
  - "[[entities/resolveAgentNode]]"
  - "[[entities/ensureLocalNode]]"
  - "[[entities/synthStdout]]"
used_by:
  - "[[entities/dispatchTask]]"
last_commit_hash: "3bc56c1"
tested_by: []
tags:
  - entity
  - dispatch
  - routing
  - phase3-seam
related:
  - "[[concepts/local-vs-remote-dispatch]]"
  - "[[concepts/agent-node-routing]]"
sources:
  - "[[entities/dispatchTask]]"
---

# startRun + runRemote (dispatch routing core)

## Overview

`startRun` is the local-vs-remote fork inside `createDispatch`. It is THE function Phase 3 cares about: it is where a dispatch either runs the agent locally (`runLocal` → `openclaw` CLI) or POSTs an `agent-run` verb to a remote mesh node (`runRemote`). Both branches produce the identical `Promise<{ok, stdout} | {ok:false, error}>` contract the watcher consumes (`src/dispatch.js:427-459`). **The remote agent-run POST path is fully built and wired today** — it is NOT unbuilt.

## Signature / Definition

```js
function startRun(node, { args, agent, agentRef, message, sessionKey })
  -> Promise<{ ok: true, stdout: string } | { ok: false, error: Error }>

async function runRemote(route, { agent, message, sessionKey })
  // route = { kind:"remote", node, baseUrl, online } from resolveAgentNode
  // POSTs to `${route.baseUrl}/api/action`
```

## Behavior

### The LOCAL-ONLY gate (`ensureLocalNode`)

`ensureLocalNode(node)` (`src/dispatch.js:492-496`) is the refusal point:

```js
function ensureLocalNode(node) {
  if (node && node !== selfNode) {
    throw httpError(400, `remote dispatch not yet supported (this node is '${selfNode}')`);
  }
}
```

It throws **only when NO resolver is wired**. `startRun` (`:427-431`):

```js
if (typeof resolveAgentNode !== "function") {
  ensureLocalNode(node);   // legacy guard/throw — back-compat
  return runLocal(args);
}
```

So `ensureLocalNode` is the *legacy fallback*, active **only** when `createDispatch` is constructed WITHOUT a `resolveAgentNode` option. In production `src/index.js:283` wires `resolveAgentNode: (agentRef) => agentLocator.resolve(agentRef)` — meaning the gate is bypassed and remote routing IS live. `ensureLocalNode` is still called eagerly in `previewDispatch` (`:675`) and `dispatchTask` (`:708`) but ONLY guarded by `typeof resolveAgentNode !== "function"`.

### The remote path (already built)

When a resolver IS wired, `startRun` awaits `resolveAgentNode(ref)` and branches on `route.kind` (`:437-457`):
- `local` (or null route) → `runLocal(args)`
- `unknown` → `{ok:false, error:"Unknown agent '<id>' in fleet roster"}`
- `unreachable` → `{ok:false, error:"No mesh node hosts agent '<id>' (node <node>)"}`
- `remote` + `online === false` → `{ok:false, error:"Target node <node> is offline (mesh precheck)"}`
- `remote` + online → `runRemote(route, {agent, message, sessionKey})`

`runRemote` (`:362-412`) POSTs `{action:"agent-run", agent, message, sessionKey, timeoutSec}` to `${route.baseUrl}/api/action` with headers `Tailscale-User-Login: <meshIdentity>`, `X-OFC-Dispatch: 1`, and (when `dispatchToken` is set) `Authorization: Bearer <token>` — the only auth branch that passes the receiver's `guardActionPost` with `verifyServeOrigin` ON. The remote envelope `{success, error, detail}` is mapped back through [[entities/synthStdout]] so `handleRunSettled` records `sessionId` + `result_text` identically to a local run.

### What Phase 3 would have to change to route board/chain runs remotely

Almost nothing in dispatch.js — the remote path is complete. To make `dispatchTask` (and therefore `runBoard` / `runChain`) route a seat to a REMOTE worker-pool node, the caller must:
1. Pass an agent ref that resolves to a remote node — either `agent: "id@<workerNode>"` (explicit pin) or a roster where the agent's only binding is a remote node (`resolveAgentNode` then returns `kind:"remote"`).
2. Ensure `createDispatch` is constructed WITH `resolveAgentNode`, `meshIdentity`, and `dispatchToken` (already true in `src/index.js`).
3. The remote node must have a registered + ONLINE mesh record (so `route.online !== false`) and accept the `agent-run` action with the shared Bearer token.

There is no code in dispatch.js that needs writing for remote agent-run — `runRemote`/`synthStdout`/`startRun` already consume `route.kind:"remote"` and the `baseUrl`. The Phase 3 core change is therefore SMALL on the dispatch side: the work is in the *caller* (board/chain wiring an agent ref that resolves remote, plus a warm-worker admission step that picks a worker node), not in building a remote POST path.

## Connections

- **depends_on:** [[entities/resolveAgentNode]] (injected closure), [[entities/ensureLocalNode]], [[entities/synthStdout]]
- **used_by:** [[entities/dispatchTask]]
- **related concepts:** [[concepts/local-vs-remote-dispatch]], [[concepts/agent-node-routing]]

## History

- **Last touched:** commit `3bc56c1` by BroClaw2 on 2026-06-17 — node→node dispatch token auth (`Authorization: Bearer` branch in `runRemote`).
- **Introduced:** `runRemote` / `startRun` added in Phase 2 remote dispatch, v2.3.0 (`3fdd0cb`, 2026-06-16); made functional v2.4.0/v2.4.1 (`cbb7fa0`).

## Sources

- `src/dispatch.js` (lines 427–459) — `startRun`.
- `src/dispatch.js` (lines 362–412) — `runRemote`.
- `src/dispatch.js` (lines 492–496) — `ensureLocalNode`.
- `src/dispatch.js` (lines 91–104) — `synthStdout`.
