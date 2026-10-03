# ADR-0014: Certification Authority and Release Approval

Status: ACCEPTED
Date: 2026-10-03

## Decision

Certification and release approval are separate immutable human governance decisions.

Certification is the only Phase 5 authority allowed to transition an AgentVersion from EVALUATED to CERTIFIED.

Release approval is a later decision that authorizes packaging eligibility. It does not package, publish, or register the agent.

## Certification Preconditions

CERTIFY requires:

- AgentVersion status EVALUATED;
- completed evaluation plan with aggregate PASS;
- immutable certification-readiness decision ELIGIBLE;
- lifecycle certification status ELIGIBLE;
- exact canonical APS digest captured in the certification record;
- non-empty certification evidence bundle;
- certifier identity and role;
- certifier role OWNER or ADMIN.

A DENY decision records evidence but leaves the AgentVersion EVALUATED.

## Release Approval Preconditions

APPROVE requires:

- AgentVersion status CERTIFIED;
- immutable CERTIFY record;
- lifecycle certification decision status CERTIFIED;
- distribution-compatible rights state;
- approver identity and role;
- approver role OWNER or ADMIN;
- intended distribution and rationale.

A DENY release decision is permitted even when rights are not distribution-compatible.

## Stage Separation

The following are independent stages:

1. certification;
2. release approval;
3. packaging;
4. publication;
5. FrankAI registration.

No earlier stage automatically creates a later-stage record.

Certification does not create release approval.
Release approval does not create a release package.
Packaging does not publish.
Publication does not imply FrankAI registration.

## AgentVersion State

CERTIFIED is stable for the AgentVersion. Release/package/publication state is represented by separate records rather than by changing the AgentVersion to RELEASED.

## Evidence

Immutable evidence includes:

- certification record;
- certification evidence bundle;
- certifier identity/role/rationale;
- release approval record;
- approver identity/role/rationale;
- intended distribution;
- rights snapshot;
- release package records;
- publication records;
- FrankAI registration records;
- audit records.
