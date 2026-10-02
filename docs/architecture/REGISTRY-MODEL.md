# Registry Persistence Model

## Aggregate Boundaries

### Agent Aggregate
Agent → AgentVersion → APSSpecification
AgentVersion → AgentCapability → CapabilityVersion

### Evaluation Aggregate
EvaluationSuite → EvaluationCase
AgentVersion → EvaluationRun → EvaluationResult

### Release Aggregate
AgentVersion → Compilation
AgentVersion → Release → ReleaseArtifact

### Evidence / Governance
SourceArtifact → ProvenanceRecord
All material mutations → AuditRecord

## Immutability

Stable identities may accumulate versions. Historical versions are never rewritten to represent a newer state.

DRAFT is the only mutable authoring state. Promotion freezes the canonical APS digest. A correction after promotion produces a new version rather than mutating history.

## Deletion

Prefer lifecycle retirement over destructive deletion. Released, certified, provenance, evaluation and audit history must remain referentially valid.

## Integrity Digests

Canonical APS, source artifacts, compilations and release artifacts use SHA-256 integrity digests. The digest proves byte/content identity, not truth or safety.

## IDs

Use UUID primary keys internally. Human-facing registry identifiers such as AGR-0001 remain separate stable display identifiers and must not be used as database primary keys.
