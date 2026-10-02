# ADR-0007: Evaluation Framework

Status: ACCEPTED
Date: 2026-10-02

## Decision

Agent Foundry evaluation is an independent governed subsystem. An agent specification does not certify itself.

The framework separates:
- EvaluationSuite — immutable versioned definition of what is tested.
- EvaluationCase — one scenario/input with expected constraints and assertions.
- EvaluationRun — one execution of one suite against one AgentVersion/runtime target.
- EvaluationResult — case-level outcome plus evidence.
- EvaluationAssertion — one machine- or human-checkable criterion.
- EvaluationEvidence — artifacts/logs/transcripts/metrics supporting an assertion.
- EvaluationPolicy — aggregation and release-gate rules.

## Evaluation Classes

1. CONFORMANCE — specification/schema/policy adherence.
2. FUNCTIONAL — expected task behaviour.
3. BOUNDARY — authority, permission and refusal/escalation behaviour.
4. ADVERSARIAL — prompt injection, pressure, ambiguity and abuse resistance.
5. REGRESSION — previously accepted behaviour remains intact.
6. OUTCOME — real operational/business outcome where measurable.

## Independence

- The subject agent may produce candidate outputs but must not be the sole authority deciding its own pass/fail.
- Machine assertions should be deterministic where feasible.
- Human-review assertions must record reviewer identity/role and rationale.
- Evaluation evidence is append-only for completed runs.
- A PASS requires every required assertion to satisfy suite policy.
- NOT_TESTED cannot be silently aggregated as PASS.

## Outcomes

PASS, PARTIAL, FAIL, NOT_APPLICABLE, NOT_TESTED.

## Release Relationship

CERTIFIED/RELEASED status may require specific suites and minimum outcomes. Release policy references immutable suite versions and completed EvaluationRuns.

## Reproducibility

Each run records AgentVersion, suite version, runtime/target identity, configuration, timestamps, evidence references, and result digest where applicable.
