# PromptForge 2.2 answerability and sufficiency contracts

PromptForge 2.2 extends the governed candidate with an explicit sufficiency contract. The change responds to a recurrent agent failure mode: treating model confidence or accumulated conversational text as proof that a task is sufficiently specified.

## Contract

Every new PromptForge candidate emits:

- `sufficiency.answerability_policy.required_information`
- acceptable and prohibited assumptions
- targeted clarification rules
- retrieval conditions
- abstention conditions
- a typed state taxonomy
- a structured consolidation strategy
- `pre_execution_consolidation`

Capability preconditions seed the required-information set. This does not assert that those requirements have been satisfied.

## Separation invariants

Answerability, epistemic knowability, correctness confidence, tool access, permission and authority remain distinct.

`READY_TO_ANSWER` cannot grant execution or delegation authority.

For consequential capabilities, pre-execution consolidation is mandatory and fail-closed. The consolidation snapshot must include objective, constraints, evidence/provenance, assumptions, unresolved requirements, tool-access state and authority state.

## Clarification

PromptForge selects targeted clarification semantics rather than a generic "ask if unsure" rule. The default policy asks for the highest-consequence unresolved requirement first and prefers permitted authoritative retrieval when that can resolve the gap without changing user intent.

## Runtime boundary

This is a specification and validation change. It does not implement a hidden-state probe, runtime Authority Resolver, service permission grant, or production action. Behavioural certification is separately exercised through the multi-turn underspecification evaluation suite.
