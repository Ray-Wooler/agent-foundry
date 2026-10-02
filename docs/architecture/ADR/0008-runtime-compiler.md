# ADR-0008: Runtime Compiler Contract

Status: ACCEPTED
Date: 2026-10-02

## Decision

Agent Foundry compiles an immutable APS AgentVersion into target-specific runtime artifacts through versioned target adapters.

Compilation never mutates the canonical APS source.

## Initial Targets

- generic
- openai

## Compiler Inputs

- canonical APS document
- APS version
- AgentVersion identity
- target adapter
- compiler version
- optional governed target configuration

## Compiler Outputs

Each compilation emits:
- runtime prompt artifact
- compilation manifest
- source APS digest
- runtime artifact digest
- target identity
- compiler version

## Invariants

1. APS remains authoritative.
2. Runtime artifacts are generated outputs.
3. Compilation cannot grant authority absent from APS.
4. Target adapters may transform representation, not governance semantics.
5. Unsupported target features must fail or emit explicit warnings; they must not be silently invented.
6. Generated artifacts must include source/version provenance.
7. Recompilation against unchanged APS + adapter version + configuration should produce stable normalized output.
