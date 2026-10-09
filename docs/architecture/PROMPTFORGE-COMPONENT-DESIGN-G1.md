# PromptForge component design protocol — governed integration profile

Status: PROPOSED | Scope: design-time review | Target: APS 1.5-alpha

This is an independently authored integration profile based on four general design activities identified in a user-supplied document. The source has conflicting licensing signals and must not be copied or distributed as a licensed derivative until ownership and permission are established.

## Stage D1 — Define the task
Document target users, exact inputs, expected outputs, observable business outcome, constraints and non-goals. Record unknowns without inventing requirements. Capture origin and rights status.

## Stage D2 — Reuse before building
Inspect existing PromptForge transformation stages, APS schema, domain validation and evaluator. Decide whether changes belong to a prompt composition pattern, capability contract, review workflow or code. Avoid new component categories until a missing capability is evidenced.

## Stage D3 — Contract mapping
Map the design to APS `1.5-alpha`: identity, mandate, capabilities, governance, epistemic evidence, operational tools and extensions. Preserve PromptForge transformation `1.0` as a separate contract. Define capability preconditions, outputs, acceptance criteria and evidence requirements.

## Stage D4 — Control boundaries
Classify proposed side effects and sensitive resources; document human approvals, contextual authority, least privilege, source provenance, answerability and sufficiency. No model-selected tool bindings or self-granted permissions.

## Stage D5 — Design for validation
Write a falsifiable hypothesis, quantitative thresholds, baseline, environment, methodology, negative cases, reproducibility requirements, limitations and planned independent review. A design plan is not test execution evidence.

## Stage D6 — Review and disposition
Check duplication, schema validity, rights, dependencies, threat exposure, missing information, acceptance evidence and rollback strategy. Status: DRAFT -> REVIEW_REQUIRED -> APPROVED_FOR_IMPLEMENTATION. Implementation, tests, verified results and publication remain separate gates.

## Skill 1.1.2 mapping
Mission: develop bounded technical PoCs testing feasibility, performance characteristics and business value before scale-up.
Inputs: architectural hypothesis, business KPI, test environment, acceptance threshold, operational constraints and explicitly authorized execution scope.
Outputs: PoC plan, proposed minimal prototype, measurement manifest, raw evidence references, deviations, recommendation and a documented decision.
Not authorized by this profile: production deployment, acquiring credentials, contacting outside systems, spending money or assigning approval.
Code-level metadata gate: `packages/promptforge/src/poc-evidence.ts`.
Limit: the gate assesses declared evidence fields only and cannot independently substantiate measured outcomes.

## Provenance
Source: user-supplied `promptforge-design.md`, 2026-10-09; copyright/licence reconciliation pending. This document contains newly drafted integration decisions rather than verbatim source implementation.
