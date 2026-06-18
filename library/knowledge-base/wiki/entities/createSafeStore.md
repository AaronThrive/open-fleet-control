---
type: entity
title: "createSafeStore"
entity_type: function
status: developing
created: 2026-06-18
updated: 2026-06-18
path: "src/state-safety.js"
language: js
depends_on: []
used_by: []
last_commit_hash: "917dad5"
tested_by:
  - "[[entities/state-safety-test]] (`tests/state-safety.test.js`)"
tags:
  - entity
  - persistence
  - phase3-seam
related:
  - "[[concepts/atomic-json-state-store]]"
  - "[[concepts/mesh-registry-persistence]]"
sources:
  - "[[entities/state-safety-module]]"
---

# createSafeStore

## Overview

`createSafeStore` is the generic, reusable safe JSON state store factory (`src/state-safety.js:30-343`). It guarantees validate-first atomic writes (temp + rename), rotated backups, never-throws-on-corrupt reads with quarantine + auto-restore, and a debounced external-write watcher with an EMFILE/ENOSPC stat-polling fallback. **Phase 3's SQLite + reconcile code "will sit beside it"** per the Stage B brief — but note the existing mesh registry does NOT use it (see risks).

## Signature / Definition

```js
createSafeStore({
  filePath,                 // absolute path of the JSON state file — REQUIRED
  validate,                 // (obj) => {valid, errors}             — REQUIRED
  backupDir,                // rotated backups directory            — REQUIRED
  maxBackups = 10,
  createDefault = () => null,
  debounceMs = 250,
}) -> { read, write, restore, listBackups, watch }
```

## Behavior

- `write(obj)` (`:165-177`): `safeValidate` first → throws `Error` with `.errors` if invalid; `ensureDirs`; `atomicWrite` (temp `${path}.tmp-<pid>-<ts>` + `fs.renameSync`, `:79-84`); back up the previous good content (`backupPrevious`, pruned to `maxBackups`).
- `read()` (`:185-245`): missing file → `createDefault()`; valid → data; corrupt/invalid → `quarantine()` the file then auto-restore the newest valid backup, else fresh default. Returns `{data, restored, quarantinedPath, restoredFrom, usedDefault}`. **Never throws.**
- `restore()` (`:251-261`): manually restore newest valid backup; null if none.
- `listBackups()` (`:108-120`): backup files newest-first.
- `watch(onExternalChange)` (`:270-340`): debounced `fs.watch` on the DIRECTORY (atomic rename swaps the inode, breaking per-file watchers); self-writes ignored via `lastWrittenContent`; on EMFILE/ENOSPC falls back to `fs.statSync` polling.

## Connections

- **depends_on:** (none — `fs`/`path` only)
- **used_by:** (no in-repo callers found in this chunk — see gap; Phase 3 is the intended first consumer alongside the SQLite store)
- **related:** [[concepts/atomic-json-state-store]], [[concepts/mesh-registry-persistence]]

## Tested by

- [[entities/state-safety-test]] (`tests/state-safety.test.js`)

## History

- **Last touched:** commit `917dad5` by BroClaw2 on 2026-06-10 — "feat: wave A" (initial introduction).

## Sources

- `src/state-safety.js` (lines 30–343) — `createSafeStore`.
- `src/state-safety.js` (lines 79–84) — `atomicWrite` (temp + rename).
