# Changelog

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
