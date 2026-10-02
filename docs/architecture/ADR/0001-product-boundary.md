# ADR-0001: Agent Foundry Product Boundary

Status: ACCEPTED
Date: 2026-10-02

## Context

Agent Foundry emerged from PromptForge and APS work but has a distinct lifecycle from the FrankAI runtime/control plane.

## Decision

Agent Foundry will be an independently releasable application within the FrankAI product family.

Agent Foundry owns construction and certification: intake, PromptForge, APS, evaluation, compilation, provenance, packaging and release.

FrankAI owns runtime registration, deployment-profile configuration, authorization, orchestration and operational observation.

Released artifacts cross the boundary through explicit versioned interfaces. Direct database coupling is prohibited.

## Consequences

- Agent Foundry can be distributed or commercialised independently.
- APS can evolve as a specification without coupling to one runtime.
- FrankAI can consume immutable released agent packages.
- Shared concepts such as Agent and Capability require explicit integration contracts rather than duplicated hidden state.
