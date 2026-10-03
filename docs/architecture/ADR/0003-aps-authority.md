# ADR-0003: APS Is the Canonical Agent Specification

Status: ACCEPTED
Date: 2026-10-02

## Decision

APS is authoritative for an agent definition. Runtime prompts and target-specific packages are generated artifacts.

## Consequences

- Runtime artifacts must identify the APS source version from which they were compiled.
- Manual runtime edits do not silently modify the canonical agent.
- Material runtime-specific exceptions must be represented through governed target configuration or an APS change.
- Recompilation must be reproducible from the accepted specification and compiler version.
