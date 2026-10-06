# PromptForge 2.1 capability contracts

PromptForge 2.0 requested no structured prerequisite/evidence fields from the model and replaced them with empty preconditions and a generic source-intent review requirement when constructing APS. Repeated revision requests therefore could not resolve this gap.

Version 2.1 requests capability-specific `preconditions` and `evidenceRequirements`, validates non-empty string arrays, and preserves the normalized values in stage evidence and APS `preconditions` / `evidence_requirements`. PF2-009 rejects empty contracts and evidence containing only `source_intent_review`. These are requirements for future evidence, not assertions that evidence has been obtained. Qualitative sufficiency remains subject to semantic review.

Execution and delegation authority remain empty and runtime tools remain unbound. Model-derived prerequisites cannot grant permissions or approvals. Existing saved versions are not rewritten; regeneration uses the governed request-changes/revision workflow and preserves original source and lineage.

Regression coverage includes history-rewrite prerequisite/evidence preservation, missing and malformed model fields, generic-only evidence, empty extraction, candidate validation, provenance and unchanged authority clamps.
