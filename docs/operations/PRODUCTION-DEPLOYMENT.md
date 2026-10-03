# Production Deployment Runbook — foundry.frankai.online

## Host prerequisites

- Debian 12/13 or equivalent supported Linux.
- Docker Engine + Compose v2.
- ports 80/443 reachable.
- DNS A/AAAA for `foundry.frankai.online` points to the host.
- outbound HTTPS access for ACME, OpenAI and FrankAI registry.
- SSH administrative access using a non-root operator with sudo.

## Secret files

Create `/etc/agent-foundry/secrets` owned by root and mode 0700.

Required files:
- postgres_password
- database_url
- bootstrap_admin_password
- openai_api_key
- object_storage_access_key
- object_storage_secret_key
- grafana_admin_password

Each file should be root-owned and mode 0600.

## Environment

Set:
- APP_VERSION=<accepted commit SHA>
- ACME_EMAIL=<operations email>
- BOOTSTRAP_ADMIN_EMAIL=<production owner>
- BOOTSTRAP_WORKSPACE_NAME=Production
- PROMPTFORGE_PROVIDER=openai
- OPENAI_MODEL=<approved model>
- FRANKAI_REGISTRY_URL=<production FrankAI endpoint>

## Deploy

```bash
git fetch origin
git checkout <accepted commit>
export APP_VERSION=<accepted commit>
export ACME_EMAIL=...
export BOOTSTRAP_ADMIN_EMAIL=...
export OPENAI_MODEL=...
export FRANKAI_REGISTRY_URL=...
sh ops/deploy.sh
```

## Acceptance

Record evidence for:
- DNS resolution.
- certificate validity.
- HTTP redirect to HTTPS.
- `https://foundry.frankai.online/api/ready` returns ready.
- web login page loads.
- worker heartbeat age < 60 seconds.
- PostgreSQL healthy.
- S3-compatible object storage healthy and bucket versioning enabled.
- durable artifact write reaches STORED.
- Prometheus target healthy.
- Grafana dashboard loads through an operator-only access path.
- backup archive produced and verified.
- no DEAD operational jobs.
- no unexpected HIGH/CRITICAL security events.

## Deployment status

Live deployment remains BLOCKED while the authorized Desktop Commander device `frank` is offline. Repository production readiness must not be represented as live deployment acceptance.
