---
type: concept
title: "Local vs Remote Dispatch (the remote agent-run POST path is built)"
complexity: advanced
domain: "dispatch"
aliases:
  - "remote dispatch"
  - "runRemote"
  - "agent-run POST"
created: 2026-06-18
updated: 2026-06-18
status: developing
tags:
  - concept
  - dispatch
  - routing
  - phase3-seam
related:
  - "[[entities/startRun]]"
  - "[[entities/dispatchTask]]"
  - "[[entities/resolveAgentNode]]"
  - "[[concepts/agent-node-routing]]"
sources:
  - "[[entities/startRun]]"
  - "[[entities/dispatchTask]]"
---

# Local vs Remote Dispatch

> [!contradiction]
> Supersedes the "remote dispatch is unbuilt" framing in [[concepts/agent-node-routing]] (which states "dispatch.ensureLocalNode refuses remote nodes today... board/chain are single-node until Phase 3", `src/orchestrate.js:24-26` header note) AND the stale header comment in `src/dispatch.js:31` ("remote nodes are v-next: node != self → clean error") and the `ensureLocalNode` error string "remote dispatch not yet supported" (`src/dispatch.js:494`).
> Prior contract (as documented): a foreign node always yields a clean 400; remote agent-run is unbuilt.
> Actual contract (code, commit `3bc56c1`, 2026-06-17): a full remote agent-run POST path (`runRemote` → `${baseUrl}/api/action`) exists and is wired in production via `resolveAgentNode` (`src/index.js:283`). `ensureLocalNode` throws ONLY when no resolver is injected (legacy fallback).

## Definition

A dispatch runs the agent either LOCALLY (`runLocal` → `openclaw` CLI via `execFile`) or REMOTELY (`runRemote` → HTTP POST `agent-run` to a mesh node's `/api/action`). `startRun` (`src/dispatch.js:427-459`) is the fork. Both branches return the same `{ok, stdout} | {ok:false, error}` so the settlement watcher is transport-agnostic.

## How it works

1. `dispatchTask` fires `startRun(opts.node, ctx)` without awaiting (`src/dispatch.js:743-748`).
2. **No resolver wired** → legacy local-only: `ensureLocalNode(node)` throws 400 on a foreign node, then `runLocal` (`:428-431`). This is the ONLY path where "remote dispatch not yet supported" fires.
3. **Resolver wired** (production, `src/index.js:283`) → `await resolveAgentNode(ref)`, branch on `route.kind`: `local`→`runLocal`; `unknown`/`unreachable`/offline→`{ok:false,error}`; `remote`+online→`runRemote` (`:437-457`).
4. `runRemote` POSTs `{action:"agent-run", agent, message, sessionKey, timeoutSec}` with `Tailscale-User-Login`, `X-OFC-Dispatch:1`, and optional `Authorization: Bearer <dispatchToken>` (`:362-412`), then maps the envelope through `synthStdout` so settlement is identical to local.

## Why it matters for Phase 3

Distributing board seats / direct queries to a warm worker pool is a **SMALL** change on the dispatch side: the remote POST path already exists and consumes `route.kind:"remote"` + `route.baseUrl`. The Phase 3 work is in the *caller* — having `runBoard`/`runChain` supply agent refs that resolve to remote worker nodes (`id@node` pins or a roster binding to a remote), plus a worker-pool admission/selection step. See [[entities/startRun]] "What Phase 3 would have to change".

## Connections

- **involves entities:** [[entities/startRun]], [[entities/dispatchTask]], [[entities/resolveAgentNode]], [[entities/synthStdout]]
- **related concepts:** [[concepts/agent-node-routing]]

## Sources

- `src/dispatch.js` (lines 427–459) — `startRun` fork.
- `src/dispatch.js` (lines 362–412) — `runRemote` POST.
- `src/dispatch.js` (lines 492–496) — `ensureLocalNode` legacy gate.
- `src/index.js` (line 283) — `resolveAgentNode` wiring.
- commit `3bc56c1` (2026-06-17, v2.4.3) — node→node dispatch token auth.
