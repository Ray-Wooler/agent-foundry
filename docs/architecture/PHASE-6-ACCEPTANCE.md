# Phase 6 Acceptance Matrix

| Gate | Criterion | Status |
|---|---|---|
| P6-G0 | Phase 5 merged and Certification Authority enforced | PASS / VERIFIED / ENFORCED |
| P6-G1 | Real canonical immutable package content | IMPLEMENTED |
| P6-G2 | Package includes runtime artifacts and governance evidence | IMPLEMENTED |
| P6-G3 | Packaging requires independent release approval | IMPLEMENTED |
| P6-G4 | Explicit publication action | IMPLEMENTED |
| P6-G5 | Real outbound FrankAI registration boundary | IMPLEMENTED |
| P6-G6 | Package idempotency | IMPLEMENTED |
| P6-G7 | Publication idempotency | IMPLEMENTED |
| P6-G8 | Registration idempotency | IMPLEMENTED |
| P6-G9 | Immutable package/publication/registration evidence | IMPLEMENTED |
| P6-G10 | Distribution audit records | IMPLEMENTED |
| P6-G11 | Distribution operator UI | IMPLEMENTED |
| P6-G12 | Controlled Distribution CI | PASS / VERIFIED — run 37126928728 |

Phase 6 is not accepted until Controlled Distribution passes on the exact PR head and is enforced on protected main.


## Phase 6 Decision

**CONTROLLED PACKAGING, PUBLICATION & FRANKAI REGISTRATION PASS / VERIFIED / AWAITING ENFORCEMENT**

Evidence from Controlled Distribution run `37126928728`:

- migration `0007_controlled_distribution.sql` applied successfully;
- packaging before release approval was rejected;
- approved certified version produced one immutable canonical package;
- package included certified APS, deterministic generic/OpenAI runtime artifacts, evaluation references, certification evidence and release-approval snapshot;
- database-computed package SHA-256: `9f5faef75ae9090fcbafedab645e15ec0201ac717ad27ea1ebd4ca88c222dddb`;
- retrying packaging with the same idempotency key returned the same package record and digest;
- conflicting packaging intent with a new key was rejected;
- publication was a separate explicit action and created exactly one immutable publication record;
- publication retry with the same key returned the original publication;
- FrankAI registration was a separate outbound HTTP action using an `Idempotency-Key` header;
- returned FrankAI registration reference: `frankai-reg-0001`;
- registration retry with the same key returned the original local registration and did not call the registry again;
- outbound registry request count remained exactly `1`;
- conflicting registration intent was rejected;
- package, publication and registration records were proven immutable;
- append-only audit evidence exists for package creation, publication and FrankAI registration.

Phase 6 preserves the AgentVersion as `CERTIFIED`; packaging/publication/registration state is tracked separately.
