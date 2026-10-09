# ADR-0008 — Authority Decision Persistence and Task Capability Tokens

Status: PROPOSED

## Context

ADR-0007 established a deterministic runtime Authority Resolver but deliberately stopped before persistence and execution credentials. A resolver decision that exists only in process memory is insufficient for durable audit, revocation, replay control or downstream enforcement.

The next bounded gate persists canonical resolver decisions and issues a short-lived task capability token only from a final `ALLOW` decision.

## Decision

Add immutable authority decision persistence, short-lived signed task capability tokens and durable token revocation state.

An authority decision record stores:

- the SHA-256 decision identifier;
- the decision status, now included inside canonical decision evidence;
- resolver version;
- task, plan and optional session identity;
- CAC SHA-256;
- complete canonical decision evidence and its digest;
- recording timestamp.

The decision record is immutable after insertion.

A capability token is issued only when:

- resolver status and evidence status are both `ALLOW`;
- the decision identifier matches canonical evidence;
- selected roles/capabilities match the evidence projection;
- there are no missing, unauthorized, denied or delegation-exceeded capabilities;
- there is no unresolved post-untrusted-context expansion;
- supporting authorization evidence is present and unexpired.

## Token format

The first implementation uses an Agent Foundry compact Ed25519-signed token:

`afct1.<base64url canonical payload>.<Ed25519 signature>`

The payload binds:

- token UUID;
- issuer and token version;
- algorithm and signing-key identifier;
- authority decision ID;
- CAC digest;
- task, plan and optional session identity;
- active role IDs and capabilities;
- issue and expiry times.

The bearer token itself and the signing key are never persisted. Persistence stores only the token SHA-256 and non-secret claims required for audit/revocation.

The issuer receives an Ed25519 private key from the trusted control plane; verifiers receive only the corresponding public key. This prevents the later Policy Enforcement Point from gaining token-minting authority merely by being able to verify tokens. Key storage and rotation infrastructure remain deployment concerns; the token carries a key ID so rotation can be introduced without changing the token contract.

## Lifetime

Default token TTL is 300 seconds and maximum TTL is 900 seconds. Token issuance must occur no more than 300 seconds after the underlying authority decision; an older decision must be recomputed before a new token can be minted.

The issuer clamps token expiry to the earliest supporting authorization expiry. A task token therefore cannot remain valid beyond the authorization evidence from which it was derived.

## Replay semantics

Task capability tokens are not single-use tokens. Reuse within the same bound task and plan is permitted until expiry or revocation because a task may require multiple governed invocations.

Replay into another task, plan or session fails closed. Expired, revoked, tampered, non-canonical, wrong-key and decision-mismatched tokens fail closed. Token verification rejects non-canonical Base64URL signature text before revocation lookup so equivalent signature encodings cannot create a second token hash.

The subsequent Policy Enforcement Point gate must consult durable token state before every protected invocation. The pure verifier accepts revocation state as an explicit trusted input; it does not silently assume a token is unrevoked.

## Persistence and revocation

`authority_decision_records` is immutable.

`capability_token_records` has immutable identity and claims. The only permitted lifecycle mutation is one-way revocation with a mandatory reason. Revocation cannot be removed or rewritten and token rows cannot be deleted.

Database enforcement cross-checks decision status and identity against canonical evidence, and prevents creation of a capability-token record unless its referenced decision is `ALLOW`, its task/plan/session/CAC/roles/capabilities match that persisted decision, its lifetime is no more than 900 seconds, its issuance is within the 300-second decision-freshness window, and its expiry does not exceed supporting authorization.

## Explicit non-decisions

This gate does not implement:

- Policy Enforcement Point interception;
- credential brokering;
- connector/OAuth credential exchange;
- resource/argument enforcement;
- quota/budget enforcement;
- approval UI or approval workflow persistence;
- distributed key management or HSM/KMS integration;
- automatic token refresh.

Those remain subsequent gates.

## Acceptance

This ADR becomes ACCEPTED when:

- resolver and token package tests pass;
- migrations apply cleanly to PostgreSQL;
- immutable decision/token constraints are verified;
- persistence is idempotent for identical evidence;
- token issuance from non-ALLOW decisions is rejected;
- expiry, revocation, signature tampering and task/plan replay behavior are verified;
- exact-head CI is green;
- independent review identifies no unresolved high-consequence defect.
