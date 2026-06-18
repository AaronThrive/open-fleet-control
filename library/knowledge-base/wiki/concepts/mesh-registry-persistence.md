---
type: concept
title: "Mesh Registry Persistence (and its decoupling from state-safety)"
complexity: intermediate
domain: "persistence"
aliases:
  - "saveRegistry"
created: 2026-06-18
updated: 2026-06-18
status: developing
tags:
  - concept
  - persistence
  - mesh
  - phase3-seam
related:
  - "[[entities/handleMesh-nodes]]"
  - "[[concepts/atomic-json-state-store]]"
sources:
  - "[[entities/handleMesh-nodes]]"
---

# Mesh Registry Persistence

## Definition

The mesh node registry persists its node list to `state/<REGISTRY_FILENAME>` as `{ nodes: [...] }` via `mesh.js`'s OWN inline atomic write — NOT via the generic [[entities/createSafeStore]] helper in `src/state-safety.js`.

## How it works

`saveRegistry` (`src/mesh.js:303-308`): `fs.mkdirSync(stateDir, {recursive:true})`, write to `${registryFile}.tmp-<pid>`, then `fs.renameSync` over the target. `loadRegistry` (`src/mesh.js:292-301`) tolerates both a bare array and `{nodes:[...]}` and filters to objects with a string hostname; on parse failure it logs and returns `[]` (no quarantine, no backup).

A node record persisted by `registerNode` (`src/mesh.js:382-390`): `{ id: randomUUID, hostname, port, protocol:"https", healthPath, platform, label, registeredBy, registeredAt }`.

## Why it matters

This is a **surprising decoupling and an integration risk for Phase 3**: the repo has a hardened atomic-JSON store (`createSafeStore`: validate-first, rotated backups, corrupt-file quarantine + auto-restore, external-write watcher) but the mesh registry does not use it — it has only temp+rename atomicity, with NO backup rotation and NO quarantine/restore on corruption. If Phase 3's reconcile logic "sits beside" state-safety as the brief says, it should be aware that the mesh registry it reconciles against is on the weaker persistence path. Aligning mesh onto `createSafeStore` (or vice-versa) is an open decision — see [[questions/should-mesh-registry-adopt-createSafeStore]].

## Examples in this codebase

- [[entities/handleMesh-nodes]] — the HTTP surface that mutates the registry.
- [[entities/createSafeStore]] — the hardened store the registry does NOT use.

## Connections

- **involves entities:** [[entities/handleMesh-nodes]], [[entities/createSafeStore]]
- **related concepts:** [[concepts/atomic-json-state-store]], [[concepts/node-sqlite-databasesync-pattern]]

## Sources

- `src/mesh.js` (lines 292–308) — load/save registry.
- `src/mesh.js` (lines 382–390) — node record shape.
- `src/state-safety.js` (lines 30–343) — the unused (by mesh) hardened alternative.
