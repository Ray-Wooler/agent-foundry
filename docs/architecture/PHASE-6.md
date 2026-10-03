# Phase 6 — Controlled Packaging, Publication & FrankAI Registration

Status: IN PROGRESS

## Objective

Turn an approved certified AgentVersion into an immutable package, explicitly publish it, and separately register the published release with FrankAI while proving authorization order, idempotency and auditability.

## Flow

```text
CERTIFIED
   |
   v
Release APPROVED
   |
   v
PACKAGE action
   |
   +--> immutable canonical bundle
   +--> package SHA-256
   +--> release/package records
   |
   v
PACKAGED
   |
   v
PUBLISH action
   |
   +--> immutable publication payload
   |
   v
PUBLISHED
   |
   v
REGISTER WITH FRANKAI action
   |
   +--> outbound versioned payload
   +--> Idempotency-Key
   +--> stable registration reference
   |
   v
REGISTERED
```

## Core Principle

Each transition is independently authorized and independently persisted.

Certification does not package.
Release approval does not package.
Packaging does not publish.
Publication does not register.
Registration does not rewrite prior evidence.

## Idempotent Retry Rule

Safe retry with the same idempotency key returns the original record.

Conflicting retry with a different key after the stage already exists is rejected.
