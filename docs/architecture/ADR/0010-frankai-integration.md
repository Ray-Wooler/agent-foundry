# ADR-0010: FrankAI Integration Boundary

Status: ACCEPTED
Date: 2026-10-03

## Decision

Agent Foundry integrates with FrankAI through explicit versioned release contracts.

FrankAI must never depend on Foundry working-state tables, draft transformations, mutable candidates, or internal evaluator state.

## Publication Boundary

Only immutable RELEASED packages may cross into FrankAI.

Published integration payloads identify:
- agent ID and version
- release ID and release version
- APS version
- package integrity digest
- available runtime targets
- capability references
- evaluation summary
- provenance/rights state

## Consumption Model

FrankAI may:
- register the released agent identity/version;
- associate deployment profiles;
- reference published capabilities;
- fetch approved runtime artifacts;
- record runtime observations independently.

FrankAI may not:
- mutate the Foundry release package;
- reinterpret Foundry draft state as released state;
- infer permissions or authority beyond the released APS/runtime contract.

## Integration Invariants

1. Only RELEASED packages are publishable.
2. Package digest must match the release manifest.
3. Rights state must permit the intended distribution/use.
4. Integration payloads are versioned and immutable.
5. FrankAI registration is idempotent by release identity.
6. No hidden database coupling.
7. Runtime observations in FrankAI do not rewrite Foundry provenance/evaluation history.
8. Failed/partial publication must be retryable without duplicate registration.
