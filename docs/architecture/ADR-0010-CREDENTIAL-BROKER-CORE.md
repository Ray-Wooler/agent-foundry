# ADR-0010 — Credential Broker Core

Status: ACCEPTED

## Context

ADR-0009 established the runtime Policy Enforcement Point (PEP) and deliberately stopped before credentials or connector execution. The next bounded gate is credential isolation: an allowed invocation may need a provider credential, but neither the agent/model nor the PEP should receive the underlying service credential.

The credential broker is part of the trusted control plane. A model, prompt, retrieved document, connector response or ordinary invocation request must not be able to choose a credential handle, weaken the operation binding, cross a workspace boundary, or retrieve secret material directly.

## Decision

Implement `@agent-foundry/credentials` as a deterministic credential-brokering boundary.

The broker receives:

- authenticated workspace identity from the trusted control plane;
- a canonical PEP decision with outcome `ALLOW`;
- the matching durable PEP evidence loaded from the authoritative audit ledger;
- current durable capability-token state loaded immediately before credential release;
- a workspace-scoped, non-secret credential binding loaded from the authoritative binding registry;
- trusted control-plane time;
- a secret resolver owned by the trusted control plane;
- a trusted credential consumer/connector-dispatch callback.

A credential binding contains only non-secret metadata:

- workspace and binding IDs;
- registry SHA-256;
- tool and operation identity;
- exact operation-binding ID;
- provider identity;
- opaque credential handle;
- ACTIVE/DISABLED status.

The credential material itself is never persisted by Agent Foundry and is not returned from the broker.

## Enforcement sequence

Before resolving any secret, the broker fails closed unless:

1. broker input, workspace ID and time are valid;
2. durable PEP evidence exists and is canonically identical to the in-memory PEP decision;
3. the PEP decision is `ALLOW`;
4. the PEP evidence ID is the SHA-256 of its canonical evidence;
5. PEP evidence records `authorized_capability_token` and no missing capabilities;
6. the signed token payload represented by the PEP decision matches task, plan, session, authority-decision and CAC identity;
7. current durable token state exactly matches the signed role/capability projection and is neither revoked, expired nor not-yet-valid;
8. credential binding structure is valid and ACTIVE;
9. credential binding workspace equals the authenticated control-plane workspace;
10. credential binding tool/operation matches the allowed PEP invocation;
11. credential binding references the exact PEP operation-binding ID;
12. credential binding registry SHA-256 matches the PEP registry SHA-256.

After these checks, the broker constructs a canonical `AUTHORIZED` evidence record and requires the trusted persistence callback to durably record it before the secret resolver is invoked. The persistence callback must return a receipt whose evidence ID exactly matches the authorization record and whose audit-record identity is a UUID. If durable authorization evidence cannot be recorded or the receipt is invalid, secret resolution does not begin.

Only after this pre-use audit succeeds may the trusted secret resolver receive the opaque workspace-scoped credential handle.

Resolved material must be non-empty and, when it carries an expiry, unexpired at broker evaluation time. Resolver and consumer exceptions are sanitized. Raw credential material is never written into broker evidence. If a trusted consumer accidentally returns the credential material in its result, the broker blocks the result and records `credential_exposure_blocked`.

## Workspace and tenant isolation

Credential bindings are keyed by `(workspace_id, binding_id)`. Lookup and administrative status changes require both values. The broker separately receives authenticated workspace context and refuses a credential binding from another workspace before secret resolution.

This gate does not add a workspace claim to the existing task capability token. Workspace identity therefore remains a trusted control-plane input at this boundary rather than model- or token-supplied data. A future authority-contract revision may make workspace identity an end-to-end signed claim; that is not required for this bounded credential-isolation gate because the broker never accepts workspace identity from agent/model content.

## Durable binding and two-phase audit

Migration `0013_credential_broker_audit.sql` creates `credential_binding_records`.

Binding identity is immutable. ACTIVE bindings may be disabled, but disabled bindings cannot be reactivated in place; reauthorization requires a new binding identity. Credential handles are restricted to simple opaque URI-like references without user-info, query strings, fragments or path traversal. The table stores the opaque credential handle but never the secret represented by that handle.

Every broker state transition produces canonical evidence. Evidence contains only a SHA-256 of the credential handle, never the handle itself. A durable `AUTHORIZED` record is written before secret release. Final `EXECUTED`, `DENY`, or `FAILED` evidence is then recorded as applicable, with executed evidence linked to the pre-use authorization evidence ID.

The database is a second fail-closed authority boundary. An `AUTHORIZED` or `EXECUTED` row is accepted only when:

- the referenced PEP evidence exists and is an allowed protected invocation;
- PEP task, plan, session, token, authority, tool, operation, operation-binding and registry identities match;
- capability-token durable state is active at broker evaluation time;
- the referenced workspace credential binding exists, is ACTIVE, and matches registry/tool/operation/operation-binding/provider identity;
- the stored credential handle hashes to the evidence handle digest;
- raw credential-handle text is absent from broker evidence.

An `EXECUTED` row additionally requires the matching durable `AUTHORIZED` broker record with identical workspace, authority, invocation, operation-binding, credential-binding, registry and handle-digest identity. This leaves a durable pre-use trail even if the connector or process fails after credential release.

## Trust boundary

The credential handle is configuration/control-plane data, not agent data. Secret resolution must be implemented by trusted infrastructure such as a secret manager, encrypted credential service, OS secret mount, HSM/KMS-backed service or equivalent deployment-specific adapter.

The credential consumer is also trusted control-plane code. It is the only callback that receives secret material. Agent/model code must not be supplied as the resolver or consumer.

## Explicit non-decisions

This gate does not implement:

- provider-specific OAuth refresh flows;
- interactive OAuth consent;
- connector-specific HTTP/API clients;
- resource-level authorization;
- argument validation;
- quota or budget enforcement;
- distributed credential caching;
- HSM/KMS integration;
- secret-manager product selection;
- policy-administration UI;
- a signed workspace claim in authority decisions/capability tokens.

Those remain subsequent gates.

## Security properties

- No model call occurs in the credential broker.
- PEP DENY cannot cause secret resolution.
- Tampered or mismatched PEP evidence fails closed before secret resolution.
- Revoked, expired or mismatched durable token state fails closed before secret resolution.
- Cross-workspace credential binding fails closed before secret resolution.
- Disabled credential bindings fail closed before secret resolution.
- Secret material is not persisted in Agent Foundry audit evidence.
- Secret resolver and consumer errors are sanitized.
- Expired credential material is rejected.
- Consumer output that exposes the credential is blocked.
- Secret resolution cannot begin until durable pre-use authorization evidence is recorded.
- Executed broker audit evidence must be backed by an allowed PEP record, active token state, ACTIVE workspace credential binding, and matching pre-use broker authorization.
- The broker does not grant authority; it consumes previously established authority.

## Acceptance

This ADR becomes ACCEPTED when:

- the credentials package typechecks and builds;
- unit/adversarial tests pass;
- PostgreSQL migration and durable integration tests pass;
- workspace regression tests pass;
- exact-head CI is green;
- independent review finds no unresolved high-consequence defect.

## Acceptance evidence

Exact PR head `c7551deffc0b82cd86101da53fc045c4b4651255` completed all 18 associated CI workflows successfully, including Credential Broker, Policy Enforcement Point, Authority Token Issuance and Production Operations. The exit review found no unresolved high-consequence defect in the bounded credential-isolation scope.
