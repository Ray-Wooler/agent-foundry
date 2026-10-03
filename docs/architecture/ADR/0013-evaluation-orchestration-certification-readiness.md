# ADR-0013: Evaluation Orchestration and Certification Readiness

Status: ACCEPTED
Date: 2026-10-03

## Decision

Semantically approved CANDIDATE AgentVersions enter a governed evaluation plan before certification is considered.

Evaluation and certification are separate lifecycle concerns.

## Lifecycle

1. CANDIDATE
2. evaluation plan selected and frozen
3. VALIDATED
4. required suites execute
5. plan aggregate completes
6. EVALUATED
7. separate human certification-readiness decision
8. certification eligibility may become ELIGIBLE
9. actual CERTIFIED transition remains outside Phase 4

## Suite Selection

An evaluation plan contains immutable required suite selections.

Phase 4 includes two built-in suites:

- core-governance-v1 — deterministic machine assertions
- human-semantic-quality-v1 — required human review assertion

## Execution

Machine assertions are executed by the worker.

Human-review assertions pause the suite at AWAITING_HUMAN until an authorized reviewer records:
- reviewer identity;
- workspace role;
- outcome;
- rationale;
- evidence.

## Aggregation

A plan does not complete until every required suite is completed.

Aggregate outcomes:
- PASS when all required suites PASS;
- PARTIAL when no required suite FAILS and at least one is PARTIAL;
- FAIL when any required suite FAILS.

A completed plan transitions VALIDATED -> EVALUATED regardless of pass/fail. The aggregate outcome is preserved separately.

## Certification Readiness

Evaluation success alone does not change certification status.

A separate immutable certification-readiness decision is required.

ELIGIBLE requires:
- AgentVersion status EVALUATED;
- completed evaluation plan;
- aggregate outcome PASS;
- authorized human reviewer decision ELIGIBLE.

Phase 4 does not implement certification itself. Direct transition to CERTIFIED is blocked.

## Evidence

Evaluation evidence is retained through:
- evaluation plan and immutable suite selections;
- suite execution records;
- machine assertion evidence;
- evaluation_runs and evaluation_results;
- immutable human evaluation records;
- aggregate outcome;
- immutable certification-readiness decision;
- audit records.
