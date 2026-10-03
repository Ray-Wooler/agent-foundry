# ADR-0009: Immutable Release Packaging

Status: ACCEPTED
Date: 2026-10-03

## Decision

Agent Foundry packages a RELEASED AgentVersion into an immutable, integrity-addressed release bundle.

A release package is a distribution artifact. It must not mutate the canonical APS, evaluation evidence, or compilation artifacts it references.

## Minimum Release Contents

- release manifest
- canonical APS document
- at least one compiled runtime artifact
- corresponding compilation manifest(s)
- required evaluation evidence
- provenance summary
- integrity digest(s)

## Release Preconditions

1. AgentVersion status is CERTIFIED or RELEASED.
2. Required evaluations are complete and satisfy release policy.
3. Compilation artifacts pass compiler verification.
4. Source/provenance state is recorded.
5. Commercial/distribution rights are compatible with the intended release mode.
6. Package contents are immutable after release creation.

## Release Identity

Each release records:
- agent ID
- agent version
- release version
- APS version
- release timestamp
- package SHA-256
- artifact digests
- evaluation references
- provenance/rights status

## Immutability

A released package is never modified in place. Any content change creates a new release version and package digest.

## Failure Behaviour

Release creation must fail closed when:
- certification state is insufficient;
- required evaluation evidence is missing;
- artifact digests do not match;
- rights status prohibits distribution;
- package contents differ from the manifest.
