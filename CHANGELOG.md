# Changelog

## 2.3.0 — 2026-06-16

- Multi-agent orchestration: new `src/orchestrate.js` composes the single-agent dispatch
  primitive into fan-in (runBoard — ask N agents the same question in parallel, collect every
  answer for the Chief to synthesize) and chain (runChain — a pipeline where each step's output
  feeds the next step's context) patterns; async fire-and-forget with an in-memory run registry
  (open → running → done/failed), `getRun`/`waitForRun` lifecycle, TTL reaping, and an
  `orchestration.completed` SSE emit. `POST /api/fleet/orchestrate` returns 202 + runId
  instantly; `GET /api/fleet/orchestrate/:runId` polls to completion (with a `?wait=true`
  bounded-sync escape hatch).
- Dispatch verbs single/board/chain wired through `src/dispatch.js`, `src/index.js`, and
  `src/fleet-routes.js`; canonical `result_text` captured per attempt; board results route to
  `#ceo-boardroom` (chain/single to each agent's command channel); Chief-orchestrator router
  selects the pattern and synthesizes.
- Budget gate on orchestration (`src/budgets.js`): OPEN/CLOSED guard re-checked before each
  seat/step; CLOSED ceiling halts mid-run with a clear block descriptor.
- Phase 2 remote dispatch: new `src/agent-locator.js` resolves agent → node
  (local/remote/unknown/unreachable, `agent@node` qualifier, mesh-health precheck); the
  dispatch remote branch POSTs an `agent-run` verb to the target node and synthesizes stdout so
  the existing watcher records attempts byte-for-byte identically to a local run (full
  back-compat — with no resolver wired, behavior is unchanged). New `src/action-guard.js`
  fail-closed authorization for the privileged `agent-run` POST verb (localhost / registered
  mesh peer / bearer token).
- Tests: +46 new (orchestrate sync/async/routes, budget-orchestration gate, agent-locator,
  remote dispatch, action-guard, action POST route, actions agent-run); full suite 1573 green.

## 2.2.0 — 2026-06-11

- Overview and Memory are separate tabs; System Vitals merged into the Overview's uniform
  compact cards (skeleton placeholders, no dangling dashes); the giant About block removed —
  a compact About now lives at the bottom of Settings
- Sessions page converted to a max-visibility detail list (status/tokens/burn/cost columns,
  deep detail panel with lazy cost/cache/tools data, raw JSON expander); Federation and
  Briefs converted to detail lists too (briefs keep the full editor)
- Validation gate has one control surface: a Settings card (top-bar switcher and Evolution
  page button removed; Evolution shows read-only state)
- Settings "Restarting…" hang fixed (root cause: missing [hidden] CSS guard rendered the
  overlay permanently); restart now reliably reloads on success and reports timeouts
- Quick actions actually work: Clean Stale Sessions had a triple fault (action-name
  mismatch, count-only handler, nonexistent CLI suggestion) — now runs a real
  `sessions cleanup --enforce` with honest result summaries
- Fleet bulk operations: POST /api/fleet/bulk (kill-stale-sessions / health-check /
  gateway-status / dispatch-task / chat-broadcast across up to 50 targets, per-target
  results, audited) + Ctrl+K command palette + mesh multi-select bulk bar
- Agent Flight Recorder: per-agent unified timeline (sessions, dispatches, cron runs,
  audit, tokens) in a drawer off the Agents page; per-agent session stores read directly
  so all agents get correct attribution
- Editable Org Chart tab: drag-and-drop agent tree with unassigned tray, titles, keyboard
  move mode, kanban-grade state safety
- Cortex gauges rebuilt per engine with honest states: headroom = subscription-window
  meter (it is a quota meter, not a compressor) with explicit stale-poll state; lean-ctx =
  throughput card; lossless-claw = historical badge when idle; "active context engine"
  strip; knowledge-graph provenance line (pages from gbrain/Obsidian export, link count,
  extract hint)
- Scheduled fleet digest (daily/weekly via existing alert sinks, test-send button) and
  budget guardrails: dispatch blocking at 100% with operator ack; budgets finally read
  real spend (root cause: the usage provider was never wired into the fleet runtime)
- Tokens page enriched: per-window / per-model / per-day / by-source detail lists
- Fixed a pre-existing console error from the home page's SSE handler on non-dashboard views

## 2.1.0 — 2026-06-11

- Detail lists everywhere: Cron, AI Jobs, Agents, Cerebro, Operators, Cortex memory, and Logs use the shared dense detail-list component (sortable, filterable, expandable rows) instead of card grids
- Cerebro and Operators extracted from the home page into their own sidebar tabs (home page no longer fetches their data)
- Single kanban board: Fleet Board merged into Kanban — federated cards render in the same columns with origin chips, read-only locking, and remote moves proxied for writable remotes
- Cortex gauges fixed: headroom no longer renders zeros (empty path override + null poll state both handled honestly); lean-ctx shows real totals instead of a meaningless 0% savings; knowledge graph moved below the memory browser
- Settings page: sections render independently (one failed fetch no longer wedges the page), fetches time out with a Retry chip, restart-required is a calm info banner with a working "Restart service" button (POST /api/fleet/admin/restart riding systemd Restart=on-failure)
- Privacy feature removed entirely (hide buttons, hostname blur, /api/privacy, settings card)
- Audit everything: every mutating route now writes an audit entry (10 new actions incl. settings.update, chat.publish, action.execute, job.run, service.restart); Logs page gains dynamic action/actor filters, free-text search, pagination, and a count summary
- i18n: 138 keys backfilled, 46 orphans pruned

## 1.7.0 — 2026-06-10

- Rebrand: OpenFleetControl, built by Aaron May; English-only (zh-CN removed)
- Independent pages: Sessions (+ subagents strip + terminal sessions), Cron, Vitals, LLM Usage, Tokens; compact overview home
- Usage sources: Claude Code terminal sessions, Codex activity, Nine Router (SQLite), Claude Max subscription (headroom), OpenRouter credits
- Read-only Docker containers panel with Portainer deep-links
- Settings page: alert rules/sinks/webhooks editable + hot-applied; ntfy sink
- Unified fleet Agents roster (/api/agents[/fleet]) + kanban assignee dropdown
- Memory editor: update/delete via memory-pro CLI (id-preserving), live-verified
- Per-node vitals on mesh cards; per-model cost breakdown in cost modal
- Hermes OFC instance + two-way federation; Windows node onboarding kit
- Fixes: tailscale adapter circuit breaker + logging, cerebro init, session detail alias route

## Unreleased

### Changed

- **Rebrand** — the dashboard is now **OpenFleetControl**, built by Aaron May. All user-visible
  "OpenClaw Command Center" / "Command Center" strings in the UI, page titles, sidebar, About
  panel, and docs were renamed; upstream attribution now lives in the README Credits line and
  the LICENSE file.

### Removed

- **zh-CN locale** — the dashboard is English-only: `public/locales/zh-CN.json` and
  `README.zh-CN.md` were deleted, the header language switcher was removed, `public/js/i18n.js`
  was simplified to an English-only loader (the `t()` / `data-i18n` machinery and its
  English-fallback chain are unchanged), and `scripts/checks/i18n-coverage.mjs` now validates
  `en.json` only.

## 1.6.0 — 2026-06-10

### Added

- **Full panel i18n (en / zh-CN)** — every JS-generated runtime string across the eight fleet
  views (Mesh, Fleet Chat, Kanban, Briefs, Cortex, Evolution, Federation, Audit Logs) and the
  header validation-gate toggle is now keyed through the runtime translator
  (`window.t(key, params, fallback)` / `t()` from `public/js/utils.js`). Toasts, confirm
  dialogs, prompts, empty/error states, aria-labels, screen-reader announcements, tooltips and
  relative-time strings all render localized; missing keys fall back to English, never to a
  raw key path. Remaining hardcoded English in the view partials (including the federation
  write-actions note) is now `data-i18n`-bound, and ~300 new keys ship in both
  `public/locales/en.json` and `public/locales/zh-CN.json`.
- **i18n coverage check** — `scripts/checks/i18n-coverage.mjs` extracts every `data-i18n*`
  attribute and `t("…")` call from the frontend and fails when a referenced key is missing
  from either locale file (unused locale keys are warn-only).
- **Kanban keyboard accessibility** (shipped in the v1.6 wave 1 commit, now documented):
  `Tab` navigation, `Enter`/`Space` drawer with focus trap, `M` move mode with arrow-key
  column/position moves, `Enter` confirm / `Esc` cancel-and-restore, `aria-live`
  announcements.
- **Federation write-actions** (shipped in the v1.6 wave 1 commit, now documented): per-remote
  `allowWrites` opt-in (`PATCH /api/fleet/federation/remotes/:id`), server-side proxy
  (`POST …/remotes/:id/actions`) restricted to the hardcoded whitelist `lesson.approve` /
  `lesson.reject` / `gate.set` / `task.move`, with the local operator identity forwarded as
  `Tailscale-User-Login` and audited on both sides.

### Changed

- `t()` lookup order is now active locale → English bundle → inline fallback → key, so a
  late-loading or partial locale can never surface raw key paths.
- Federation panel subtitle and note updated to reflect opt-in write actions (the v1
  `views.federation.readOnlyNote` key was removed); the add-remote form is fully localized.
- READMEs (en + zh-CN): the three delivered v1.6 roadmap items moved into the feature
  documentation, fresh v1.7 idea list (federation remote-node drill-down, graph edge
  extraction scheduling, alert rule UI).

## 1.5.0

- Read-only dashboard federation (fleet-of-fleets), gbrain graph adapter fixes, v1.6 wave 1
  (kanban keyboard a11y, federation write-actions, gbrain graph live).
