# ADR-0015: Controlled Packaging, Publication and FrankAI Registration

Status: ACCEPTED
Date: 2026-10-03

## Decision

Packaging, publication and FrankAI registration are three independent, explicit and idempotent actions.

Each stage requires the prior governed stage to exist. No stage may infer or create a later stage automatically.

## Packaging

Packaging requires:
- AgentVersion status CERTIFIED;
- immutable CERTIFY record;
- explicit APPROVE release-approval record;
- lifecycle release approval status APPROVED;
- compatible rights snapshot.

The package is a canonical JSON bundle containing:
- certified APS and digest;
- deterministic generic and OpenAI runtime artifacts;
- evaluation plan and run references;
- certification evidence bundle;
- release-approval snapshot.

The database computes the authoritative SHA-256 over the stored package content.

Packaging creates:
- release record;
- immutable release_package_record;
- package manifest and package content;
- audit record.

It does not publish or register.

## Publication

Publication requires a persisted PACKAGED release package.

Publication creates a separate immutable publication record with:
- channel;
- external reference when applicable;
- publication payload;
- idempotency key;
- actor and audit evidence.

It does not register with FrankAI.

## FrankAI Registration

FrankAI registration requires an explicit PUBLISHED record.

The API sends the versioned registration payload to FRANKAI_REGISTRY_URL with an Idempotency-Key header.

A successful response must contain a stable registration reference.

The request and response payloads are persisted immutably.

## Idempotency

Each action accepts an idempotency key.

Retrying the same action with the same key returns the existing record without creating a duplicate side effect.

Using a different key after the stage already exists is rejected as a conflict.

## State Separation

AgentVersion remains CERTIFIED.

Distribution state is tracked separately:
- packaging_status;
- publication_status;
- frankai_registration_status.

## Audit

Each successful stage emits an append-only audit record:
- release_package_created;
- release_published;
- frankai_release_registered.
