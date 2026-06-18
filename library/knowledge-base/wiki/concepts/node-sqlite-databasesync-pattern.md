---
type: concept
title: "node:sqlite DatabaseSync Persistence Pattern"
complexity: intermediate
domain: "persistence"
aliases:
  - "DatabaseSync"
  - "durable SQLite trail"
created: 2026-06-18
updated: 2026-06-18
status: developing
tags:
  - concept
  - persistence
  - sqlite
  - phase3-seam
related:
  - "[[entities/createFleetChat]]"
  - "[[concepts/atomic-json-state-store]]"
sources:
  - "[[entities/createFleetChat]]"
---

# node:sqlite DatabaseSync Persistence Pattern

## Definition

The repo's one established pattern for durable structured state is Node's built-in `node:sqlite` `DatabaseSync`, used exactly once today in [[entities/createFleetChat]] (`src/fleet-chat.js`). Phase 3's dedup + fencing tables are specified to reuse this identical pattern.

## How it works

The canonical sequence (`src/fleet-chat.js`):
1. `const { DatabaseSync } = require("node:sqlite");` (`:14`).
2. `fs.mkdirSync(stateDir, {recursive:true})` then `new DatabaseSync(path.join(stateDir, "fleet-chat.db"))` — synchronous open at module construction (`:95-99`).
3. `db.exec("CREATE TABLE IF NOT EXISTS … ; CREATE INDEX IF NOT EXISTS …")` — idempotent schema (`:101-113`).
4. `const stmt = db.prepare("INSERT … VALUES (?, …)")` once; `stmt.run(...)` per write (`:115-225`).
5. Parameterized reads: `db.prepare(sql).all(...params, limit)` / `.get()`; LIKE wildcards escaped with `ESCAPE '\\'` (`:283-350`).
6. `Number(row.col)` to coerce INTEGER columns (`:127`, `:336`).
7. `db.close()` in try/catch for shutdown/tests (`:364-370`).

## Why it matters

Phase 3 must NOT introduce a different SQLite binding (e.g. better-sqlite3) — `node:sqlite` is already a zero-dependency builtin in use. The fencing-table GC can mirror `prune()`'s delete-by-age + keep-newest-N idiom (`:314-339`). The store lives under `state/` beside fleet-chat.db; the atomic-JSON store ([[concepts/atomic-json-state-store]]) is the sibling for non-SQLite state.

## Examples in this codebase

- [[entities/createFleetChat]] — the only DatabaseSync usage; the precedent.

## Connections

- **involves entities:** [[entities/createFleetChat]]
- **related concepts:** [[concepts/atomic-json-state-store]]

## Sources

- `src/fleet-chat.js` (lines 14, 95–117, 218–350) — DatabaseSync open/schema/run/query/prune.
