# Agent Prompt Specification (APS) v1.5-alpha

Status: ALPHA

APS describes governed agents. Prompts are compiled runtime artifacts.

## Canonical Layers

### Identity & Behaviour
Agent, Identity, Mandate, Objective, Capability, Task, Workflow, State, Event, Artifact, OutputContract.

### Governance
AuthorityGrant, Permission, Policy, HumanApproval, Delegation, SideEffect, ResourceBudget, InformationHandling, ContextualAuthorityContract.

The Contextual Authority Contract (CAC) separates reusable authorization from task-active authority and defines inactive-by-default contextual activation, expiring task/plan binding, fail-closed runtime enforcement requirements, credential isolation, replanning escalation, subset-only delegation and audit evidence. See `CONTEXTUAL-AUTHORITY-CONTRACT.md`.

### Sufficiency
AnswerabilityPolicy, ClarificationPolicy, ConsolidationPolicy, MissingInformationState, PreExecutionConsolidation.

### Epistemic
Source, Evidence, Claim, Provenance, Confidence, TemporalValidity, EvidenceRelation. Confidence is evidence metadata, not a substitute for answerability or authority.

### Operational
Tool, Environment, DeploymentProfile, Execution, ExecutionEvidence, ReleaseGate, RollbackPolicy, AuditRecord, Handoff.

## Domain Extensions

Domain-specific concepts should remain outside core where possible. Initial extension namespaces:

- ai-ml
- cyber-intelligence
- automation
- orchestration

## Conformance Invariants

APS conformance must enforce the architectural invariants in `docs/REPOSITORY-AUTHORITY.md`.

## Current extension

CAC v1.0 is represented in the machine schema and semantic validator under `governance.contextual_authority`. Authority-bearing APS documents must carry a conforming CAC before certification readiness can be marked eligible.

Static CAC conformance is not runtime enforcement. The runtime Authority Resolver, task capability tokens, credential broker and enforcement gateway remain separate future implementation work.

## Change governance

Schema changes require an ADR or specification changelog entry. CAC v1.0 is governed by ADR-0006.
