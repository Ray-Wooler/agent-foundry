# ADR-0009 — Runtime Policy Enforcement Point Core

Status: ACCEPTED

## Context

ADR-0008 established immutable authority decisions and short-lived task capability tokens. The next bounded gate is to enforce those tokens at the invocation boundary before any connector, tool or credential broker is reached.

The Policy Enforcement Point (PEP) is part of the trusted control plane. Agent/model output must not be trusted to name the capability that authorizes an operation. Instead, the PEP receives a trusted operation-to-capability-set binding from the capability/tool registry and compares it with the signed, persisted active authority.

## Decision

Implement a deterministic, side-effect-free Policy Enforcement Point core as `@agent-foundry/enforcement`.

For each protected invocation the PEP requires:

- the bearer task capability token;
- the trusted Ed25519 verification key and expected key ID;
- trusted control-plane time;
- task, plan and optional session identity;
- tool and operation identity;
- a trusted operation-to-capability-set registry binding with immutable registry digest;
- the durable persisted capability-token state loaded by token SHA-256.

The PEP returns only `ALLOW` or `DENY`. The pure core remains side-effect-free; a database adapter persists canonical enforcement evidence into the existing append-only audit ledger.

## Enforcement sequence

The core fails closed unless all of the following hold:

1. enforcement input and registry binding are structurally valid;
2. the trusted binding matches the requested tool and operation;
3. the bearer token has durable persisted state loaded by the SHA-256 of the exact presented bearer;
4. persisted token SHA-256, signing-key and token state are structurally valid;
5. the Ed25519 bearer signature is valid;
6. token task, plan and session claims match the invocation context;
7. token is not expired or not-yet-valid;
8. durable revocation state does not revoke the token;
9. persisted token identity and authority claims exactly match the signed token;
10. every capability required by the trusted operation binding exists in both signed and persisted active capability sets.

The invocation cannot supply or override its own authority labels. The complete capability requirement set comes from the trusted registry binding.

## Evidence

Every enforcement decision records:

- PEP version;
- evaluation time;
- ALLOW/DENY outcome and reason;
- bearer-token SHA-256;
- token, decision and CAC identifiers when available;
- task, plan and session identity;
- tool and operation;
- registry binding ID and registry SHA-256;
- required capability set and any missing capabilities;
- active signed capabilities.

The evidence ID is the SHA-256 digest of canonical enforcement evidence. The database adapter stores ALLOW and DENY evidence in the pre-existing append-only `audit_records` ledger, uses the evidence ID as the target identity, and serializes concurrent idempotent writes with a transaction-scoped advisory lock.

## Trust boundary

The caller must obtain persisted token state from the authoritative datastore using the SHA-256 of the presented bearer token. A caller-supplied in-memory claim that a token is unrevoked is insufficient.

The operation binding must originate from a trusted capability/tool registry or equivalent signed/configuration-controlled source. Agent prompts, model output, retrieved documents, connector responses and user-provided tool descriptions are not authoritative operation bindings.

## Explicit non-decisions

This gate does not implement:

- credential brokering or OAuth credential exchange;
- connector-specific invocation dispatch;
- resource-level constraints;
- argument validation;
- quota or budget enforcement;
- distributed revocation propagation/caching;
- policy administration UI;
- automatic approval;
- HSM/KMS integration.

Those remain subsequent gates.

## Security properties

- No model call occurs in the PEP.
- Missing durable token state fails closed.
- Durable state for a different bearer-token SHA-256 fails closed.
- Revocation is checked on every invocation.
- Task, plan and session replay fail closed.
- A tool operation cannot self-declare a weaker capability requirement set.
- Signed token claims must match durable token state.
- A capability absent from active contextual authority cannot authorize the operation.
- Enforcement evidence is deterministic for identical inputs.
- The PEP has no connector or credential side effects.

## Acceptance

This ADR becomes ACCEPTED when:

- the enforcement package typechecks and builds;
- boundary and adversarial tests pass;
- exact-head CI is green;
- durable-state integration is verified against PostgreSQL;
- independent review finds no unresolved high-consequence defect.

## Acceptance evidence

PR #24 was merged as `bd29c347ac669841b5abe0484635d8aebf05a8cb`. Its exact reviewed head `e8fae6ab6b98f2be4d7062fb6821874c2ca3ddb0` completed all 17 associated CI workflows successfully, including Policy Enforcement Point and Production Operations.
