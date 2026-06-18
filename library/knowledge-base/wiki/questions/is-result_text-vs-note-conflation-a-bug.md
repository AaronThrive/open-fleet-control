---
type: question
title: "Is the result_text vs note (300-char) conflation a bug?"
question: "On a dispatched attempt, result_text is null-or-full-answer (≤12KiB) while the 300-char value lives only in the attempt note. Is the first scan's 'result_text truncation risk' actually a real defect, or a confusion of the two fields?"
answer_quality: draft
created: 2026-06-18
updated: 2026-06-18
status: developing
tags:
  - question
  - dispatch
  - phase3-seam
related:
  - "[[entities/dispatchTask]]"
sources:
  - "[[entities/dispatchTask]]"
---

# Is the result_text vs note (300-char) conflation a bug?

**Question:** The first Stage A scan flagged a "result_text truncation risk" (falling back to a 300-char note). Reading the code: are `result_text` and the 300-char snippet the same field, and is there a real defect?

## Answer

They are TWO DISTINCT fields. No truncation of `result_text` to 300 chars occurs anywhere.

- **`result_text`** (canonical full answer) is set ONLY on the success branch of `handleRunSettled` via `canonicalResultText(run.outputText)`, capped at `RESULT_TEXT_MAX = 12 KiB`, newlines preserved (`src/dispatch.js:625-630`, `:201-205`, `:62`). When `run.outputText` is falsy → `result_text` is **null**, never the 300-char note.
- **The 300-char value** is the attempt `note` suffix `result: <snippet(outputText)>`, where `snippet()` collapses whitespace and caps at `RESULT_SNIPPET_MAX = 300` for the one-line UI (`src/dispatch.js:189-194`, `:620-624`, `:61`).
- `result_text` is null-or-full; the note is the truncated one-liner. The only "risk" is the UI showing the 300-char note when `result_text` is null (no parseable output text) — which is a degraded-display case, not a truncation of the stored answer.

What would resolve it: confirmation from the Phase 3 PRD author that the distribution feature reads `result_text` (full) and not the note. If the worker-pool path surfaces results from the note, that IS a real truncation — but the fix is "read result_text", not "untruncate".

## Confidence

draft — code is unambiguous (`src/dispatch.js:189-205`, `:610-643`); raised so the Phase 3 PRD does not propagate the "result_text is truncated to 300" misreading.

## Related

- [[entities/dispatchTask]]
