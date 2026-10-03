# Phase 1 — Application Foundation

Status: IN PROGRESS

## Objective

Turn the governed Phase Zero specification into an executable modular-monolith application foundation.

## Runtime Processes

- Web — browser UI for authentication, workspace/project selection, source intake and candidate review.
- API — identity/session boundary, authorization, intake capture and transformation status.
- Worker — queued PromptForge candidate generation and persistence.

## Shared Packages

- db — PostgreSQL pool, transactions and migration runner.
- auth — password hashing and opaque session token primitives.
- domain — canonical hashing, slugging and governed candidate construction.

## First Vertical Slice

1. Bootstrap an administrator and default workspace/project.
2. Authenticate and issue an opaque session.
3. Submit a source agent prompt.
4. Store the source immutably with provenance metadata.
5. Queue a PromptForge transformation.
6. Worker claims the queue item.
7. Generate a deliberately conservative APS candidate with no inferred capabilities or execution authority.
8. Persist Agent, AgentVersion, APS, provenance and audit records.
9. Mark transformation REQUIRES_REVIEW.
10. Surface the governed candidate in the web UI.

## Foundation Principle

Phase 1 does not pretend a model-backed semantic PromptForge transformer exists. The deterministic worker creates a safe review shell. Model-backed transformation is a later capability behind the same queue/domain contract.
