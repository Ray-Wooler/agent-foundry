# Phase 4 — Evaluation Orchestration & Certification Readiness

Status: IN PROGRESS

## Objective

Connect semantically approved CANDIDATE versions to actual evaluation suites, execute machine and human evaluation requirements, aggregate outcomes, transition through VALIDATED and EVALUATED, and keep certification eligibility as a separate governed decision.

## Flow

```text
CANDIDATE
   |
   v
Select + freeze required suites
   |
   v
VALIDATED
   |
   +--> machine suite execution
   |
   +--> human suite -> AWAITING_HUMAN
   |                     |
   |                     v
   |               reviewer evidence
   |                     |
   +---------------------+
   |
   v
Aggregate required outcomes
   |
   v
EVALUATED
   |
   +--> PASS    -> readiness review may mark ELIGIBLE
   |
   +--> FAIL    -> readiness review may mark NOT_ELIGIBLE
   |
   v
CERTIFICATION READINESS ONLY
(actual CERTIFIED transition remains blocked)
```

## Key Boundaries

- semantic approval is prerequisite to evaluation;
- suite selection is frozen before VALIDATED;
- human evaluation evidence is immutable;
- EVALUATED means evaluation completed, not necessarily passed;
- PASS does not automatically confer certification eligibility;
- ELIGIBLE does not mean CERTIFIED;
- release remains a later lifecycle concern.
