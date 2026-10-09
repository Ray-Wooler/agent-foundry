# ADR-0017: Answerability and Sufficiency Contract

Status: PROPOSED
Date: 2026-10-08

## Context

Agent Foundry already separates capability, tools, permission, authority, execution and verification. It did not explicitly represent whether the current task state contains enough information and evidence to answer or proceed.

The reviewed research on latent underspecification signals found that single-turn answerability probes do not reliably transfer to multi-turn dialogue, while explicit context consolidation can outperform detector-gated clarification. A universal confidence or hidden-state score is therefore not an adequate control-plane primitive.

## Decision

APS v1.5-alpha gains an optional `sufficiency` contract containing:

- `answerability_policy`
- `pre_execution_consolidation`

New PromptForge candidates emit this contract. Existing stored APS documents remain valid and are not silently rewritten.

Answerability, epistemic knowability, correctness confidence, capability, tool availability, permission and authority remain separate states. `READY_TO_ANSWER` does not imply `READY_TO_ACT`.

Clarification is targeted at explicit missing requirements. Retrieval is preferred when the missing requirement is knowable, an authoritative source is available and access is permitted. Abstention or qualification is required when necessary information remains unavailable or the requested fact is epistemically unknowable.

Consequential work requires a fail-closed pre-execution consolidation contract covering objective, constraints, evidence and provenance, assumptions, unresolved requirements, tool-access state and authority state.

## Evaluation

Certification planning adds a required multi-turn underspecification suite covering:

1. premature answer prevention;
2. targeted clarification;
3. state reconstruction after clarification;
4. separation of answerability from execution authority.

Until a production dialogue harness exists, these behavioural assertions require recorded human review. They must not be represented as machine-verified.

## Non-decision

This ADR does not authorize a hidden-state probe, runtime Authority Resolver, model self-grant of authority, or deployment change. Latent probes may later be evaluated only as secondary signals against simpler baselines.
