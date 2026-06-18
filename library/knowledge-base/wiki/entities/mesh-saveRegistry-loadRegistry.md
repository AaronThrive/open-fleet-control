---
type: entity
title: "saveRegistry + loadRegistry (mesh persistence)"
entity_type: function
status: developing
created: 2026-06-18
updated: 2026-06-18
path: "src/mesh.js"
language: js
depends_on: []
used_by:
  - "[[entities/registerNode]]"
  - "[[entities/createMesh]]"
last_commit_hash: "08a40db"
tested_by: []
tags:
  - entity
  - mesh
  - persistence
  - phase3-seam
related:
  - "[[concepts/mesh-registry-persistence]]"
  - "[[entities/createSafeStore]]"
  - "[[questions/should-mesh-registry-adopt-createSafeStore]]"
sources:
  - "[[concepts/mesh-registry-persistence]]"
---

# saveRegistry + loadRegistry (mesh persistence)

## Overview

The mesh node registry is persisted by two closures inside `createMesh`: `saveRegistry` (temp-file + rename, atomic) and `loadRegistry` (read + tolerant parse, corrupt → `[]`). Confirmed: this path uses **temp+rename ONLY** — it does NOT use `createSafeStore` from `src/state-safety.js` (no backups, no quarantine/restore, no validate-first) (`src/mesh.js:291-308`).

## Signature / Definition

```js
function loadRegistry() -> Array<NodeRecord>   // corrupt/missing → []
function saveRegistry() -> void                // writes module-level `nodes`

// On-disk shape: { "nodes": [ NodeRecord, ... ] }  (object wrapper)
// NodeRecord = {
//   id: string (uuid), hostname: string, port: number, protocol: "https",
//   healthPath: string, platform: string, label: string,
//   registeredBy: string, registeredAt: string (ISO)
// }
```

## Behavior

- **`saveRegistry` (`src/mesh.js:303-308`):** `mkdirSync(stateDir, {recursive})` → `writeFileSync` to `${registryFile}.tmp-${process.pid}` → `renameSync` onto `mesh-nodes.json`. Writes `JSON.stringify({ nodes }, null, 2)` — a `{nodes:[...]}` wrapper. No backup of the prior file, no validation before write.
- **`loadRegistry` (`src/mesh.js:291-301`):** if file absent → `[]`. Else `JSON.parse(readFileSync)`; accepts either a bare array OR `{nodes:[...]}` (`Array.isArray(raw) ? raw : raw?.nodes`); filters to objects with a string `hostname`. **Any throw (corrupt JSON, read error) → logs and returns `[]`** — i.e. a corrupt registry silently resets to empty, losing all registered nodes until they re-register/re-seed.
- File path: `path.join(stateDir, "mesh-nodes.json")` (`:278`, `REGISTRY_FILENAME` `:20`).

## What it would take to swap in `createSafeStore`

`createSafeStore` (`src/state-safety.js:30-343`) needs `{filePath, validate, backupDir, createDefault}` and exposes `read()`/`write(obj)`. To migrate:

1. **Construct once** in `createMesh`: `const store = createSafeStore({ filePath: registryFile, backupDir: path.join(stateDir, "backups"), validate: (obj) => ({valid: obj && Array.isArray(obj.nodes), errors:[...]}), createDefault: () => ({ nodes: [] }) })`.
2. **Read call site** (`:281` `let nodes = loadRegistry()`): replace with `let nodes = store.read().data.nodes` — note `read()` returns `{data, restored, quarantinedPath, ...}`, so it unwraps the `{nodes}` envelope and can auto-restore from a backup or default instead of resetting to `[]`.
3. **Write call sites** — `saveRegistry()` is called from `seedRegistry` (`:377`), `registerNode` (`:402`), `unregisterNode` (`:423`). Replace each with `store.write({ nodes })`. `write` validates-first (throws on invalid) and backs up the previous good version — so callers gain a throw path they must handle (currently `saveRegistry` cannot fail validation).
4. **Node-record shape is already compatible** — the on-disk `{nodes:[...]}` wrapper matches what `read()/write()` would round-trip; the validator just needs to assert `Array.isArray(obj.nodes)`.

The net change is ~4 call sites + one constructor + a validator function. The behavioral upgrade: corrupt registry → quarantine + restore newest valid backup (or `createDefault`) instead of silent `[]`. This is the migration [[questions/should-mesh-registry-adopt-createSafeStore]] asks whether Phase 3 should make.

## Connections

- **depends_on:** (none — uses raw `fs`)
- **used_by:** [[entities/registerNode]], [[entities/createMesh]] (construction-time `loadRegistry`)
- **related:** [[concepts/mesh-registry-persistence]], [[entities/createSafeStore]], [[questions/should-mesh-registry-adopt-createSafeStore]]

## History

- **Last touched:** commit `08a40db` by BroClaw2 on 2026-06-17 — "release: v2.4.4 — zero-touch mesh auto-registration (fleet.mesh.seed[])"; `seedRegistry` now also calls `saveRegistry`.

## Sources

- `src/mesh.js` (lines 291–308) — `loadRegistry` + `saveRegistry`.
- `src/mesh.js` (lines 278, 20) — registry path.
- `src/state-safety.js` (lines 30–343) — `createSafeStore` target API.
