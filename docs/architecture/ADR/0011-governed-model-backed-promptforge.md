# ADR-0011: Governed Model-Backed PromptForge Engine

Status: ACCEPTED
Date: 2026-10-03

## Decision

PromptForge becomes a staged model-backed transformation engine, but model output remains advisory data.

The model may analyse intent, defects, capabilities and governance requirements. It does not write canonical authority-bearing APS fields directly.

## Stages

1. INTENT_ANALYSIS
2. DEFECT_ANALYSIS
3. CAPABILITY_EXTRACTION
4. GOVERNANCE_CONSTRUCTION
5. REVIEW_EXPLANATION

Each stage emits normalized JSON plus provider/model/request metadata and cryptographic digests.

## Hard Boundary

The deterministic APS builder, not the model, owns these fields:

- execution authority
- delegation authority
- runtime tool bindings
- promotion/certification/release approval gates
- retrieved-content-is-data policy
- source digest and rights state
- review state

For model-backed candidates:

- execution authority is always empty;
- delegation authority is always empty;
- runtime tools are always unbound;
- consequential capabilities become approval requirements, not execution grants;
- model-proposed recommendation scopes are constrained to a safe allowlist;
- candidates remain DRAFT / REQUIRES_REVIEW.

## Provider Boundary

PromptForge exposes a provider-neutral ModelProvider interface.

Initial providers:

- deterministic-ci — reproducible non-network provider used by CI and local acceptance;
- openai — Responses API adapter used only in credentialed environments.

Provider-specific response formats do not become APS semantics.

## Evidence

PromptForge stores append-only:

- model-call metadata;
- normalized stage outputs;
- stage digests;
- review explanation;
- baseline-to-candidate diff;
- validation result;
- provenance and audit records.

## Failure Behavior

A candidate is persisted only after all stages complete and hard validation passes.

A failed transformation remains FAILED and cannot self-promote, certify or release.
