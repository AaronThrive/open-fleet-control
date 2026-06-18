---
type: question
title: "Was f396b27 (sequential board default) an architectural decision worth an ADR?"
question: "Did commit f396b27 encode an architectural decision (parallel→sequential board dispatch as the default) worth filing as an ADR?"
answer_quality: draft
created: 2026-06-18
updated: 2026-06-18
status: developing
tags:
  - question
  - adr-candidate
  - orchestration
related:
  - "[[concepts/sequential-vs-parallel-board]]"
  - "[[entities/runBoard]]"
sources:
  - "[[entities/runBoard]]"
---

# Was f396b27 an architectural decision worth an ADR?

**Question:** Did commit `f396b27` ("feat: sequential board orchestration + raised timeouts for single-box reliability") encode an architectural decision worth filing as an ADR?

## Answer

Filed as a Tier-2 (low-confidence) ADR candidate per the ADR-detection protocol — NOT auto-promoted to a `decisions/` page, because the subject contains no Tier-1 switch-verb (`switch/migrate/replace/deprecate/adopt`), no `!:` breaking marker, and no `Decision:`/`Rationale:`/`BREAKING CHANGE:` footer.

However, the body reads like a decision record: it changes the DEFAULT dispatch shape (parallel → sequential), gives an empirical rationale (parallel co-saturated the single gateway event loop: event-loop delay ~99s, load 32, swap exhausted, all advisors timed out), and explicitly notes the trade-off is a temporary single-box reliability default that a per-run flag overrides. The Stage B brief itself says Phase 3 will "flip it back to parallel" — i.e. this commit is a reversible-by-design architecture choice.

Recommendation: a human may want to promote this to an ADR (Nygard: Context = single-box event-loop saturation; Decision = sequential board default via `fleet.orchestrate.sequentialBoard`; Consequences = serialized councils, slower wall-clock, removed thrash; superseded when Phase 3 isolates workers).

(Source: commit `f396b27` body, [[concepts/sequential-vs-parallel-board]], `src/orchestrate.js:537-538`)

## Confidence

draft — genuine Tier-2 ambiguity; deliberately NOT fabricated as an ADR.

## Related

- [[concepts/sequential-vs-parallel-board]]
- [[entities/runBoard]]
- [[entities/fleet-dispatch-orchestrate-config]]
