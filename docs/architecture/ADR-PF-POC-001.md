# ADR-PF-POC-001 — Governed component design and PoC evidence

Status: PROPOSED
Base: main acd0e1c35481a5858abae211f890cdbec5e9dc9e
Date: 2026-10-09

## Context
PromptForge transformation produces APS 1.5-alpha governed candidates. A supplied design protocol outlines use-case analysis, component decomposition, convention compliance and dependency review. Its provenance and licensing remain unresolved (source header FRANKAI; internal checklist references MIT). We therefore do not copy or relicense the source protocol.

## Decision
1. Retain APS 1.5-alpha and PromptForge transformation contract 1.0 as authoritative machine interfaces; never construct another competing APS or manifest.
2. Establish a versioned, review-only design methodology and a proof-of-concept evidence gate as additive components within the existing packages/promptforge boundary.
3. Separate design, implementation, test evidence, measured feasibility and adoption decisions. A PoC is not validated by a design document or a model assertion.
4. Require measurable hypotheses, baselines, thresholds, reproducibility context, known limitations, source lineage and documented authority. Negative or missing evidence blocks GO.
5. No generated model output may self-approve execution, credential access, publication or promotion. Contextual authority remains inactive by default and runtime enforcement remains outside this gate.
6. The proposed evaluator is a *document/evidence completeness* check, not empirical verification that experiments ran or results are truthful.
7. Source licensing is UNKNOWN pending review of the authoritative origin and copyright terms. Store only original identifiers, cited descriptions and independently authored controls.

## Boundaries
No database migration, no APS schema changes, no release-policy bypass, no production PoC execution, no secrets, no new permission grants.

## Acceptance
- Deterministic tests: complete reviewed evidence permits conditional GO; missing evidence fails; failed threshold blocks GO; unknown rights blocks GO; authorization absent blocks GO; experiment not actually executed blocks GO.
- Verify tests at exact branch head with CI. Record results separately from this ADR.

## Consequences
Review and source-license clearance remain required before the methodology is distributed as a derivative. A GO from this evidence gate only means provided metadata passes policy checks; it does not certify business value or deployment readiness.
