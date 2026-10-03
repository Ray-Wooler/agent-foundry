# Phase 7 — Production Hardening & Operations

Status: IN PROGRESS

## Objective

Make Agent Foundry deployable, durable, observable, recoverable and operationally governable in production, then deploy and accept `foundry.frankai.online`.

## Production Topology

```text
Internet
   |
   v
 Caddy / TLS
   |
   +--> Web
   |
   +--> API ---- PostgreSQL
          |
          +---- MinIO object storage
          |
          +---- FrankAI registry
   |
 Worker ---- PostgreSQL
   |
   +-------- MinIO

Prometheus --> API /metrics
Grafana ----> Prometheus
```

## Operational Controls

- file-mounted secrets;
- immutable object-storage artifact evidence;
- operational retry queue;
- dead-letter state with security event;
- worker heartbeat;
- readiness and metrics endpoints;
- production operations dashboard;
- tenant-scoped artifact keys and immutable agent/workspace binding;
- backup/checksum/restore verification;
- HTTPS/security headers;
- Docker/Compose production deployment.

## Acceptance Separation

Repository production readiness and live deployment are separate gates.

A green CI production-operations gate means the stack is deployable and recoverable.

It does not mean `foundry.frankai.online` is live.

Live deployment requires:
- authorized execution target online;
- production secrets provisioned;
- DNS resolving to the production host;
- TLS certificate issued;
- migrations applied;
- /api/ready success;
- worker heartbeat current;
- object storage write/verify success;
- backup generated and verified.
