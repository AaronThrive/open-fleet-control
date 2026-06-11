# Changelog

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
