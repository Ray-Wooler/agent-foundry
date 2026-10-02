# ADR-0002: Modular Monolith for V1

Status: ACCEPTED
Date: 2026-10-02

## Decision

Agent Foundry V1 will use a modular monolith with explicit internal bounded contexts: Intake, PromptForge, APS, Evaluation, Compiler, Release and FrankAI Integration.

## Rationale

The product requires strong semantic boundaries but does not yet have operational evidence justifying distributed-system complexity. A modular monolith preserves transactional simplicity, local development ergonomics and refactorability while keeping future extraction possible.

## Constraints

- Bounded contexts must not bypass defined service/domain interfaces.
- Shared database infrastructure does not permit arbitrary cross-context table access.
- No microservice extraction without an accepted ADR based on demonstrated requirements.
