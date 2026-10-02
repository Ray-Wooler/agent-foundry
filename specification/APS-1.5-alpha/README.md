# Agent Prompt Specification (APS) v1.5-alpha

Status: ALPHA

APS describes governed agents. Prompts are compiled runtime artifacts.

## Canonical Layers

### Identity & Behaviour
Agent, Identity, Mandate, Objective, Capability, Task, Workflow, State, Event, Artifact, OutputContract.

### Governance
AuthorityGrant, Permission, Policy, HumanApproval, Delegation, SideEffect, ResourceBudget, InformationHandling.

### Epistemic
Source, Evidence, Claim, Provenance, Confidence, TemporalValidity, EvidenceRelation.

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

## Next Step

Represent this ontology as machine-validatable schemas without silently changing semantics. Schema changes require an ADR or specification changelog entry.
