---
type: entity
title: "Mesh node registry endpoints (POST/DELETE /api/fleet/mesh/nodes)"
entity_type: endpoint
status: developing
created: 2026-06-18
updated: 2026-06-18
path: "src/fleet-routes.js"
language: js
http_method: "POST, DELETE"
route_path: "/api/fleet/mesh/nodes[/:idOrHostname]"
handler: "[[entities/handleMesh]]"
auth_required: true
depends_on:
  - "[[entities/registerNode]]"
  - "[[entities/unregisterNode]]"
used_by: []
last_commit_hash: "f396b27"
tested_by:
  - "[[entities/fleet-routes-test]] (`tests/fleet-routes.test.js`)"
  - "[[entities/mesh-test]] (`tests/mesh.test.js`)"
tags:
  - entity
  - endpoint
  - mesh
  - phase3-seam
related:
  - "[[entities/registerNode]]"
  - "[[entities/unregisterNode]]"
  - "[[concepts/mesh-registry-persistence]]"
sources:
  - "[[entities/fleet-routes-module]]"
---

# Mesh node registry endpoints

## Overview

The mesh registry HTTP surface, handled inside `handleMesh` (`src/fleet-routes.js:178-205`). Phase 3's worker pool registers/unregisters nodes through this contract.

## HTTP method + route

| Method | Path | Lines |
|---|---|---|
| `GET` | `/api/fleet/mesh` | `:179-181` (full mesh state) |
| `GET` | `/api/fleet/mesh/discover` | `:183-185` |
| `POST` | `/api/fleet/mesh/nodes` | `:187-195` (register) |
| `DELETE` | `/api/fleet/mesh/nodes/:idOrHostname` | `:196-203` (unregister) |

## Request / Response schema

**POST /api/fleet/mesh/nodes** (`:187-195`):
- Guarded: rate-limit token (`guardMutation` → 429 `{error, retryAfterMs}` on overflow) + audit.
- Body (≤64KB, JSON object): `{hostname, port?, healthPath?, platform?, label?}` — validated by `mesh.registerNode` via `validateNodeInput` (`src/mesh.js:98-141`).
  - `hostname` (required, lowercase `[a-z0-9-]`), `port` (default 443, 1–65535), `healthPath` (default `/health`, must start `/`), `platform` (default `unknown`, from `VALID_PLATFORMS`), `label` (default = hostname, ≤MAX_LABEL_LENGTH).
- Server injects `registeredBy: user` (`:191`).
- **Success: `200` + `{ success: true, node }`** (`:194`). NOTE: register returns **200, not 201**.
- The persisted node record (`src/mesh.js:382-390`): `{ id: crypto.randomUUID(), hostname, port, protocol: "https", healthPath, platform, label, registeredBy, registeredAt: ISO }`.
- Duplicate INSTANCE (same hostname+port) → `registerNode` throws `Error("Node already registered: …")` (`src/mesh.js:391-399`, message verified `/already registered/` in `tests/mesh.test.js:189`). `statusForError` (`src/fleet-routes.js:34-41`) has no rule matching `"already registered"`, so it falls through to the default `return 400` → **HTTP 400** `{error}`.
- Invalid field (bad hostname/port/platform) → `validateNodeInput` throws `"Invalid …"` → also **400** (default branch).

**DELETE /api/fleet/mesh/nodes/:idOrHostname** (`:196-203`):
- Guarded: rate-limit token + audit.
- Path segment `segments[2]` is the id, instance key (`hostname:port`), or bare hostname (`mesh.unregisterNode`, `src/mesh.js:412-426`).
- **Success: `200` + `{ success: true, node: removed }`** (`:201`) — returns the full removed record.
- Unknown node → `unregisterNode` throws `"Unknown node: …"` → mapped to **404** (`statusForError` `/^Unknown (node|task|remote)/` rule, `:37`).

## Handler

- [[entities/handleMesh]] (`src/fleet-routes.js:178-205`) → delegates to `fleet.mesh.registerNode` / `fleet.mesh.unregisterNode`.

## Persistence

Mesh registry persists to `state/<REGISTRY_FILENAME>` via `mesh.js`'s OWN inline atomic write (`saveRegistry`: temp file + `fs.renameSync`, `src/mesh.js:303-308`). **It does NOT use `createSafeStore` from `src/state-safety.js`** — see [[concepts/mesh-registry-persistence]] and the integration-risk note in [[meta/2026-06-18-stageB-contract-summary]].

## Connections

- **depends_on:** [[entities/registerNode]], [[entities/unregisterNode]]
- **handler:** [[entities/handleMesh]]
- **related:** [[concepts/mesh-registry-persistence]]

## Tested by

- [[entities/fleet-routes-test]] (`tests/fleet-routes.test.js`)
- [[entities/mesh-test]] (`tests/mesh.test.js`)

## History

- **Last touched:** commit `f396b27` by BroClaw2 on 2026-06-18 (file-level; route shape unchanged since v2.4.4 zero-touch seed work, `08a40db`).
- **Mesh seed auto-registration:** added v2.4.4 (`08a40db`, 2026-06-17) — `fleet.mesh.seed[]` auto-registers nodes on boot, removing the manual POST step.

## Sources

- `src/fleet-routes.js` (lines 178–205) — `handleMesh`.
- `src/mesh.js` (lines 98–141) — `validateNodeInput` (node record fields).
- `src/mesh.js` (lines 382–426) — `registerNode` / `unregisterNode` / persistence.
