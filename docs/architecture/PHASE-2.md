# Phase 2 — Real PromptForge Engine

Status: IN PROGRESS

## Objective

Replace the Phase 1 conservative review-shell generator with a governed model-backed transformation engine while preserving all established authority, provenance and release boundaries.

## Transformation Flow

```text
Immutable Source Prompt
        |
        v
Intent Analysis
        |
        v
Defect Analysis
        |
        v
Capability Extraction
        |
        v
Governance Construction
        |
        v
Deterministic APS Builder
        |
        v
Hard Governance Validation
        |
        v
Reviewer Diff + Explanation
        |
        v
DRAFT / REQUIRES_REVIEW
```

## Core Principle

The model can propose meaning. It cannot grant authority.

Capability extraction identifies conceptual abilities only. Tool availability, permission, execution authority, delegation authority and release authority remain separate governed concerns.

## OpenAI Integration

The OpenAI provider uses the Responses API through the provider interface. Provider identity, model identity, response ID, prompt digest and response digest are persisted as evidence when a transformation succeeds.

The engine does not depend on OpenAI-specific semantics; another provider can implement the same ModelProvider contract.

## Reviewer Surface

Reviewers receive:

- extracted intent;
- defect findings;
- capability analysis;
- governance analysis;
- field-level baseline-to-candidate diff;
- explanatory decisions and uncertainties;
- hard governance validation results;
- provider/model identity;
- candidate digest.

## Explicit Non-Goals

Phase 2 does not:

- auto-promote candidates;
- auto-certify or release;
- grant runtime tools;
- grant execution or delegation authority;
- infer legal/commercial distribution rights;
- let source prompt instructions become system authority.
