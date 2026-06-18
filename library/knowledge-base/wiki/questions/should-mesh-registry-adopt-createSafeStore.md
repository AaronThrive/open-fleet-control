---
type: question
title: "Should the mesh registry adopt createSafeStore?"
question: "Should the mesh node registry's persistence be migrated onto src/state-safety.js createSafeStore, given Phase 3's reconcile code will sit beside state-safety?"
answer_quality: draft
created: 2026-06-18
updated: 2026-06-18
status: developing
tags:
  - question
  - persistence
  - phase3-seam
related:
  - "[[concepts/mesh-registry-persistence]]"
  - "[[entities/createSafeStore]]"
sources:
  - "[[concepts/mesh-registry-persistence]]"
---

# Should the mesh registry adopt createSafeStore?

**Question:** Should the mesh node registry's persistence (`mesh.js` inline `saveRegistry`, temp+rename only) be migrated onto the hardened `createSafeStore` (`src/state-safety.js`), or is the current weaker path acceptable for Phase 3 to reconcile against?

## Answer

Unresolved — flagged for human/architect judgment. Facts:

- The mesh registry uses temp+rename atomicity ONLY (`src/mesh.js:303-308`), with no backup rotation and no corrupt-file quarantine/restore.
- `createSafeStore` (`src/state-safety.js:30-343`) provides validate-first writes, rotated backups, quarantine + auto-restore on corrupt reads, and an external-write watcher.
- The Stage B brief states Phase 3's "SQLite + reconcile code will sit beside" state-safety. If Phase 3 reconciles worker/node state against the mesh registry, the asymmetric durability guarantees are a latent risk (a corrupt mesh registry silently resets to `[]` via `loadRegistry`, `src/mesh.js:292-301`).

What would resolve it: an explicit Phase 3 design decision on whether mesh registry durability must match the dedup/fencing store's durability.

(Source: [[concepts/mesh-registry-persistence]], `src/mesh.js:292-308`, `src/state-safety.js:30-343`)

## Confidence

draft — this is a design question, not a defect; raised so the Phase 3 PRD can decide explicitly rather than inherit the asymmetry by accident.

## Related

- [[concepts/mesh-registry-persistence]]
- [[entities/createSafeStore]]
- [[entities/handleMesh-nodes]]
