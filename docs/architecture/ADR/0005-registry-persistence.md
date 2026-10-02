# ADR-0005: Registry Persistence and Immutability

Status: ACCEPTED
Date: 2026-10-02

## Decision

Agent Foundry V1 uses PostgreSQL as the authoritative persistent store for registry metadata and lifecycle state.

The registry separates stable identity from immutable versioned content:

- Agent is the stable logical identity.
- AgentVersion is an immutable version snapshot once its lifecycle leaves DRAFT.
- Capability is a stable reusable identity; capability definitions are versioned through CapabilityVersion.
- APSSpecification belongs to exactly one AgentVersion and records the canonical APS document plus integrity digest.
- ProvenanceRecord is append-only evidence describing source/transform lineage.
- EvaluationSuite defines reusable tests; EvaluationRun records an execution against one AgentVersion; EvaluationResult records case-level outcomes.
- Compilation records a target-specific generated artifact from one immutable AgentVersion.
- Release points to exactly one AgentVersion and is immutable once RELEASED.
- AuditRecord is append-only.

## Storage Boundary

PostgreSQL stores queryable registry/lifecycle metadata and canonical structured APS JSON.

Large source artifacts, generated packages and evaluation evidence may later live in object storage; PostgreSQL stores their identity, integrity digest and location.

## Lifecycle

AgentVersion states:

DRAFT → CANDIDATE → VALIDATED → EVALUATED → CERTIFIED → RELEASED

Exceptional terminal/side states:

REJECTED, SUPERSEDED, RETIRED, QUARANTINED

Only DRAFT versions may mutate canonical APS content in place. Advancement from DRAFT creates an integrity digest and freezes version content. Later change requires a new AgentVersion.

## Integrity Rules

1. Agent IDs and slugs are unique.
2. Agent semantic versions are unique per Agent.
3. Capability semantic versions are unique per Capability.
4. One canonical APSSpecification exists per AgentVersion.
5. Non-DRAFT AgentVersion canonical content is immutable.
6. RELEASED releases are immutable and integrity-addressed.
7. A Release cannot reference an AgentVersion below CERTIFIED.
8. Compilation records identify target and source AgentVersion.
9. EvaluationRun identifies the suite/version under test and preserves results.
10. Provenance and audit records are append-only.
11. Deleting an Agent must not cascade-delete historical released/evidence records.
12. Timestamps use UTC-capable PostgreSQL timestamptz.

## Why PostgreSQL

The domain is relational and integrity-heavy: versions, capabilities, provenance, evaluations, compilations and releases require referential constraints and transactional lifecycle changes. JSONB remains appropriate for canonical APS documents and structured evidence metadata, but does not replace relational identity/lifecycle constraints.
