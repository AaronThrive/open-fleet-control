---
type: meta
report_kind: contradiction-report
date: 2026-06-18
status: open
tags:
  - meta
  - contradiction-report
  - dispatch
---

# Contradiction Report — 2026-06-18

Daily journal of contract changes / documentation-vs-code contradictions detected during scans. Stage B supplementary scan of `src/dispatch.js`, `src/mesh.js`, `src/agents-roster.js`.

## Stage B — remote-dispatch-is-unbuilt (documentation contradicts code)

- **Old page:** [[concepts/agent-node-routing]] (and the `src/dispatch.js:31` header comment + `ensureLocalNode` error string `src/dispatch.js:494`)
- **New page:** [[concepts/local-vs-remote-dispatch]]
- **Reason:** Prior framing asserts remote agent-run is unbuilt / `ensureLocalNode` always refuses foreign nodes / board+chain are single-node "until Phase 3". The dispatch.js code proves a full remote agent-run POST path (`runRemote` → `${baseUrl}/api/action`, `src/dispatch.js:362-412`) exists and is wired in production (`resolveAgentNode`, `src/index.js:283`). `ensureLocalNode` throws ONLY in the no-resolver legacy fallback (`src/dispatch.js:427-431`).
- **Commit:** `3bc56c1` — "release: v2.4.3 — node→node dispatch token auth (coexists with verifyServeOrigin)" — BroClaw2, 2026-06-17 (path made functional earlier at `cbb7fa0` v2.4.1, introduced `3fdd0cb` v2.3.0).
- **Severity:** warning
- **Impact:** This contradiction directly governs Phase 3 sizing. If the doc framing were correct, Phase 3 would need to build a remote agent-run path (LARGE). Because the code already has it, the Phase 3 dispatch-side change is SMALL — the work is in the board/chain caller supplying remote-resolving agent refs + a worker-pool admission step.
- **Resolution suggestion:** [[questions/is-result_text-vs-note-conflation-a-bug]] is a related Phase 3 question; the routing contradiction itself is resolved by [[concepts/local-vs-remote-dispatch]]. The stale source-comment in `src/dispatch.js:31` should be corrected by a human (wiki is read-only on source).
