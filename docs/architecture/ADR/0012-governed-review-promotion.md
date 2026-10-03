# ADR-0012: Governed Review and Promotion Workflow

Status: ACCEPTED
Date: 2026-10-03

## Decision

Semantic review is a first-class immutable governance event.

PromptForge candidates remain DRAFT / REQUIRES_REVIEW until an authorized human reviewer records one immutable decision:

- APPROVE
- REJECT
- REQUEST_CHANGES

## Promotion Boundary

Only APPROVE may transition an AgentVersion from DRAFT to CANDIDATE.

The database independently requires:
- a semantic review for the same AgentVersion;
- decision = APPROVE;
- reviewed candidate digest = canonical APS digest.

Application logic cannot bypass this gate.

## Reviewer Identity

Each semantic review records:
- reviewer user ID;
- reviewer workspace role;
- candidate digest;
- rationale;
- requested changes when applicable;
- immutable review timestamp.

## Revision Model

REQUEST_CHANGES never mutates the reviewed candidate.

It creates a new queued PromptForge transformation that:
- reuses the same immutable source artifact;
- carries the human change request separately from source content;
- creates a new AgentVersion under the same Agent identity;
- records immutable parent/child lineage;
- remains DRAFT / REQUIRES_REVIEW.

## Lifecycle Separation

Semantic approval is distinct from evaluation, certification and release.

On semantic APPROVE:
- AgentVersion => CANDIDATE
- semantic approval => APPROVED
- evaluation readiness => READY
- certification => NOT_ELIGIBLE
- release => NOT_ELIGIBLE

No Phase 3 action may certify or release an agent.

## Immutability

Semantic reviews and finalized revision lineage are immutable.

The lineage row may be finalized once with the child AgentVersion ID after worker creation; all other mutation is prohibited.
