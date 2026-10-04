# Hostinger shared-ingress deployment

Use compose.production.yml with compose.hostinger.yml on srv1661521.

The existing host Caddy retains ports 80/443. The overlay publishes only
loopback web/API ports 4520/4521. Operator-only storage, Grafana, and Prometheus
use loopback 4522/4523/4524. Import ops/Caddyfile.hostinger from host Caddy
after backing up and validating its existing configuration.

The dedicated MinIO service uses a pinned image digest and an isolated data
volume. Set OBJECT_STORAGE_ENDPOINT=http://minio:9000,
OBJECT_STORAGE_BUCKET=agent-foundry and OBJECT_STORAGE_FORCE_PATH_STYLE=true.
Initialize the bucket with scripts/init_object_storage.mjs and explicitly enable
bucket versioning before acceptance.

File-mounted secrets remain in /etc/agent-foundry/secrets (0700 directory,
0600 files). Generate independent database, object-storage, bootstrap and
Grafana credentials. Never copy another application's database or storage keys.

If no owner email has been supplied, owner@foundry.frankai.online may be used as
a temporary local login identifier. This is not a provisioned email mailbox.
Deliver its generated password through a private operator handoff.

Keep PROMPTFORGE_PROVIDER=openai. If no model credential/model has been supplied,
leave those values empty rather than substitute the deterministic CI provider.
The worker initializes its model only when processing a transformation, so
operational storage/heartbeat processing stays available. A model request with
missing configuration fails visibly and cannot grant certification or release.
Leave FRANKAI_REGISTRY_URL unset until the actual versioned endpoint is known;
registration then returns frankai_registry_not_configured.

## Release procedure

1. Require passing source checks and record the exact pushed commit.
2. Transfer git archive of that commit into /opt/agent-foundry/releases/<SHA>.
3. Load /etc/agent-foundry/production.env and set APP_VERSION to that SHA.
4. Validate the combined Compose file; build; start postgres/minio.
5. Run database migrations and initialize/version the object bucket.
6. Start api/web/worker/prometheus/grafana with both Compose files.
7. Install the additive host Caddy snippet, validate, then reload Caddy.
8. Check HTTPS, redirect, readiness version, login, worker heartbeat, metrics,
   private ports, versioned object round-trip, backup and restore.
9. Preserve the previous ingress configuration and record rollback evidence.

Live infrastructure acceptance is distinct from OpenAI and FrankAI integration
acceptance. Report unconfigured integrations explicitly.
