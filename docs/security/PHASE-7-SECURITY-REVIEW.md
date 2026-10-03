# Phase 7 Security Review

Status: ACCEPTED FOR PRODUCTION READINESS TESTING
Date: 2026-10-04

## Scope

Review of the production boundary introduced in Phase 7:
- public ingress;
- authentication/session handling;
- tenant isolation;
- PostgreSQL;
- S3-compatible object storage;
- operational jobs;
- secrets;
- observability;
- backup/restore;
- deployment.

## Controls

### Public ingress
- Caddy terminates HTTPS.
- HSTS is enabled.
- X-Content-Type-Options is nosniff.
- X-Frame-Options is DENY.
- restrictive Referrer-Policy and Permissions-Policy are set.
- /api/metrics is blocked at public ingress.

### Authentication
- opaque session tokens are stored only as SHA-256 digests.
- passwords use scrypt.
- disabled users cannot authenticate.
- production bootstrap password is file-mounted secret material.

### Tenant isolation
- workspace is the tenant boundary.
- resource access checks join through workspace membership.
- agents receive one immutable workspace binding.
- durable object keys include workspace ID.
- Phase 7 acceptance creates a second workspace and proves cross-workspace transformation access returns 404 and authority-state access returns 403.

### Secrets
- repository contains no production secret values.
- Compose uses Docker secret files.
- application entrypoint converts *_FILE secret references into process environment at runtime.
- secret files are expected to be root-owned and mode 0600 on the production host.

### Database
- PostgreSQL is not attached to the public edge network.
- production backend network is internal.
- migrations are explicit and run before rollout.
- governance/evidence tables retain their existing immutability triggers.

### Object storage
- S3-compatible object storage is backend-only.
- versioning is enabled on the artifact bucket.
- artifacts are integrity-addressed with SHA-256.
- upload is asynchronous through a retry/dead-letter outbox.
- successful writes are verified before STORED state.

### Operational jobs
- SKIP LOCKED claim semantics prevent concurrent duplicate claims.
- bounded max attempts.
- exponential retry delay.
- DEAD jobs create HIGH security events.

### Observability
- Prometheus endpoint is backend-facing only.
- operational dashboard surfaces dead letters, durability failures, heartbeat age and security events.
- production logs are JSON at the ingress boundary.

## Residual risks

1. Single-host Docker Compose remains a host-level availability dependency.
2. PostgreSQL and external S3-compatible object storage durability still depend on off-host backup custody.
3. The current application authorization layer is enforced in service queries rather than PostgreSQL RLS.
4. Production OpenAI and FrankAI endpoints require external service availability.
5. A dedicated external secret manager is not yet integrated; file-mounted secrets are the Phase 7 baseline.

## Required operational follow-ups

- off-host encrypted backup copy;
- quarterly restore drill;
- rotate production secrets after any operator change;
- investigate PostgreSQL RLS as a future defense-in-depth layer;
- review host firewall and SSH access at deployment acceptance;
- patch images regularly and rebuild on security updates.
