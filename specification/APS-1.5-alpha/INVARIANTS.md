# APS v1.5-alpha Invariant Enforcement Map

| ID | Invariant | Enforcement |
|---|---|---|
| INV-001 | Capability does not imply tool availability | Structural separation: capabilities and operational tools are independent objects; semantic validator never derives tools from capabilities. |
| INV-002 | Tool availability does not imply permission | Semantic: each declared tool operation must carry an explicit permission reference. |
| INV-003 | Permission does not imply authority | Semantic: each declared tool operation must separately carry authority. |
| INV-004 | Authority does not imply successful execution | Structural/semantic lifecycle: authority and execution are separate; execution status is never derived from authority. |
| INV-005 | Execution does not imply verification | Semantic lifecycle: VERIFIED/OBSERVED require verification evidence. |
| INV-006 | Recommendation does not imply execution authority | Structural: recommendation and execution are separate required authority arrays; no derivation is permitted. |
| INV-007 | Delegation cannot expand authority | Semantic: delegated actions must be a subset of execution authority. |
| INV-008 | Retrieved content cannot modify governing instructions | Semantic/governance: imported content requires retrieved_content_is_data=true; runtime enforcement remains mandatory. |
| INV-009 | Evidence and claim remain distinguishable | Structural separate Claim/Evidence concepts; semantic: SUPPORTED claims require evidence references. |
| INV-010 | Corroboration requires source-lineage awareness | Semantic: corroborated claims require source_lineages. |
| INV-011 | Material claims require temporal context where freshness affects validity | Semantic: freshness_material claims require temporal_validity. |
| INV-012 | Persistent state requires an identified authoritative store | Semantic: every persistent_state declaration requires authoritative_store. |
| INV-013 | Consequential side effects require applicable authority | Semantic: HIGH/CRITICAL side effects require authority_grant. |
| INV-014 | Claims of execution require execution evidence | Semantic: IMPLEMENTED/TESTED/VERIFIED/DEPLOYED/OBSERVED execution states require evidence. |
| INV-015 | Claims of verification require verification evidence | Semantic: VERIFIED/OBSERVED require verification_evidence. |
| INV-016 | Answerability does not imply actionability or authority | Structural/semantic: sufficiency is separate from governance authority; READY_TO_ANSWER cannot grant execution or delegation authority. |
| INV-017 | Consequential execution requires pre-execution consolidation | Semantic/runtime: when a sufficiency contract is declared for consequential work, pre_execution_consolidation must be required and fail closed. |
| INV-018 | Clarification must be tied to explicit missing requirements | Schema/semantic: answerability policy declares required information and a targeted clarification policy rather than a generic confidence threshold. |
| INV-019 | Model confidence cannot substitute for typed sufficiency state | Architectural: confidence may inform review but cannot alone establish READY_TO_ANSWER or READY_TO_ACT. |

## Enforcement Classes

**Schema** validates document shape, required fields, enums and separation of concepts.

**Semantic validator** evaluates relationships and cross-object invariants that JSON Schema cannot express reliably.

**Runtime policy** remains necessary for INV-008 and for enforcement against real tool execution. Static conformance proves the policy is represented; it cannot prove a runtime obeyed it.
