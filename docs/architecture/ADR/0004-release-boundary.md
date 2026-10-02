# ADR-0004: Immutable Release Boundary

Status: ACCEPTED
Date: 2026-10-02

## Decision

Only immutable RELEASED agent versions may be published to FrankAI or distributed as certified Foundry packages.

Working candidates remain mutable but cannot masquerade as releases.

## Minimum Release Identity

A release must identify:
- agent ID and version
- APS version
- compiler/target identity where applicable
- evaluation state
- provenance state
- integrity reference
- release timestamp

FrankAI consumes released artifacts through versioned interfaces and must not depend on Foundry working-state tables.
