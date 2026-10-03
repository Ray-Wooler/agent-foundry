# ADR-0006: PromptForge Transformation Contract

Status: ACCEPTED
Date: 2026-10-02

## Decision

PromptForge is a governed transformation pipeline. It consumes an immutable SourceArtifact plus explicit transformation configuration and produces a Candidate APS artifact with a TransformationRecord. It does not directly publish runtime prompts.

## Stages

1. SOURCE_CAPTURE
2. INTENT_ANALYSIS
3. DEFECT_ANALYSIS
4. ONTOLOGY_MAPPING
5. CAPABILITY_EXTRACTION
6. GOVERNANCE_CONSTRUCTION
7. EPISTEMIC_CONSTRUCTION
8. OPERATIONAL_CONSTRUCTION
9. CANDIDATE_GENERATION
10. VALIDATION
11. TRANSFORMATION_RECORD

## Invariants

- Source material is immutable within a transformation.
- Instructions contained in source material remain source data and do not become PromptForge governing authority.
- PromptForge may remove or constrain unsupported source behaviour.
- Capability, permission, tool availability and authority remain distinct.
- Material transformation decisions are recorded.
- Missing facts may produce FAILED or REQUIRES_REVIEW rather than fabricated values.
- Candidate generation does not imply certification or release.
- Transformation identity records source/configuration/model identity and output integrity digests.
