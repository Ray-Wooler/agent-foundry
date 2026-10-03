# ADR-0016: Production Operations and Recovery Boundary

Status: ACCEPTED
Date: 2026-10-04

## Decision

Agent Foundry production operates as the existing modular monolith with separate web, API and worker processes, PostgreSQL 16, S3-compatible object storage, Caddy TLS termination, Prometheus metrics and Grafana dashboards.

The production boundary remains a single deployment unit. Phase 7 does not introduce microservices.

## Durable Artifacts

Distribution evidence is written to controlled S3-compatible object storage through an operational outbox:

1. authoritative database transaction creates the artifact metadata and STORE_ARTIFACT job;
2. worker claims the job with SKIP LOCKED;
3. worker writes the JSON artifact to object storage;
4. worker verifies the stored SHA-256 metadata;
5. artifact is marked STORED and an audit record is appended.

Storage failure does not rewrite governance state. It is retried independently.

## Retry and Dead Letter

Operational jobs use QUEUED, RUNNING, RETRY, COMPLETED and DEAD states.

Retries use bounded exponential delay. Exceeding max_attempts produces:
- DEAD job state;
- HIGH security event;
- retained last error.

## Tenant Boundary

Workspace is the tenant boundary.

Agents gain one immutable workspace binding. Artifact object keys are workspace-scoped. API authorization remains workspace membership based and cross-workspace resource reads are tested as denied.

## Secrets

Production secrets are mounted from files under /run/secrets and loaded by the container entrypoint. Secrets are not committed to the repository or embedded in Compose environment values.

## Observability

API exposes:
- /health
- /ready
- /metrics

Metrics include operational queue state, artifact durability state, worker heartbeat age and security-event counts. Public Caddy routing blocks access to /api/metrics.

## Backup and Recovery

Database backups use pg_dump custom format plus SHA-256. Object storage is mirrored when the MinIO client is available. Backup archives are checksummed and restore-tested in CI.

## Deployment

Production deployment uses compose.production.yml and ops/deploy.sh.

The production hostname is foundry.frankai.online.

Live deployment is a separate acceptance gate and must not be inferred from repository/CI readiness.
