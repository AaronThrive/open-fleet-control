---
type: entity
title: "createFleetChat (node:sqlite DatabaseSync precedent)"
entity_type: function
status: developing
created: 2026-06-18
updated: 2026-06-18
path: "src/fleet-chat.js"
language: js
depends_on:
  - "[[entities/validateMessage]]"
used_by:
  - "[[entities/handleChat]]"
last_commit_hash: "917dad5"
tested_by:
  - "[[entities/fleet-chat-test]] (`tests/fleet-chat.test.js`)"
tags:
  - entity
  - persistence
  - sqlite
  - phase3-seam
related:
  - "[[concepts/node-sqlite-databasesync-pattern]]"
sources:
  - "[[entities/fleet-chat-module]]"
---

# createFleetChat

## Overview

`createFleetChat` is the agent-to-agent message bus: in-memory pub/sub with a durable trail (JSONL + SQLite) (`src/fleet-chat.js:81-373`). It is the **only existing `node:sqlite` `DatabaseSync` usage in the repo** and is the precedent Phase 3's durable dedup/fencing tables must reuse verbatim.

## Signature / Definition

```js
createFleetChat({
  stateDir,                 // SQLite db dir — REQUIRED non-empty string
  logsDir,                  // JSONL log dir — REQUIRED non-empty string
  maxLogBytes = 52428800,
  maxRotatedFiles = 5,
  nowFn = Date.now,
}) -> { publish, onMessage, query, prune, getState, close }
```

## Behavior — the DatabaseSync pattern (what Phase 3 copies)

1. **Import:** `const { DatabaseSync } = require("node:sqlite");` (`:14`).
2. **Open (synchronous, at construction):** `const db = new DatabaseSync(path.join(stateDir, DB_FILE_NAME));` (`:99`) — `DB_FILE_NAME = "fleet-chat.db"`. `fs.mkdirSync(stateDir, {recursive:true})` first (`:95`).
3. **Schema, idempotent:** `db.exec(\`CREATE TABLE IF NOT EXISTS messages (...); CREATE INDEX IF NOT EXISTS ...\`)` (`:101-113`).
4. **Prepared statements once:** `const insertStmt = db.prepare("INSERT INTO messages (...) VALUES (?, ?, ?, ?, ?, ?)");` (`:115-117`).
5. **Parameterized run:** `insertStmt.run(record.id, record.sender, ...);` (`:218-225`).
6. **Parameterized query:** build a `WHERE … AND …` clause + `params[]`, then `db.prepare(sql).all(...params, effectiveLimit)` (`:298-300`). LIKE wildcards escaped via `escapeLikePattern` + `ESCAPE '\\'` (`:66-68`, `:283`).
7. **Aggregate read:** `db.prepare("SELECT COUNT(*) … ").get()` (`:346-350`).
8. **Numeric coercion:** SQLite INTEGER columns come back needing `Number(row.ts)` / `Number(byAge.changes)` (`:127`, `:336-337`).
9. **Close:** `db.close()` wrapped in try/catch for tests/shutdown (`:364-370`).

`prune()` (`:314-339`) shows the delete-by-age + keep-newest-N retention idiom Phase 3's fencing-table GC can mirror.

## Connections

- **depends_on:** [[entities/validateMessage]], `node:sqlite` (Node builtin)
- **used_by:** [[entities/handleChat]] (POST /api/fleet/chat/publish, GET /api/fleet/chat)
- **related:** [[concepts/node-sqlite-databasesync-pattern]]

## Tested by

- [[entities/fleet-chat-test]] (`tests/fleet-chat.test.js`)

## History

- **Last touched:** commit `917dad5` by BroClaw2 on 2026-06-10 — "feat: wave A" (initial introduction).

## Sources

- `src/fleet-chat.js` (lines 11–373) — module.
- `src/fleet-chat.js` (lines 14, 95–117) — DatabaseSync open + schema.
- `src/fleet-chat.js` (lines 218–300) — prepared run/query pattern.
