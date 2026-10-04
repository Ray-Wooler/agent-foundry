# Foundry production deployment — 4 October 2026

Host: srv1661521 / 76.13.180.125. URL: https://foundry.frankai.online.

Initial merged application release: 79d57cd9dd108b0125968f08f19ce5082f371edd.
Shared-ingress and operational corrections: PR 14. The final release directory,
APP_VERSION and current symlink must identify the merged corrective release.

## Observed acceptance

- HTTPS certificate validated through normal TLS verification.
- HTTP redirected to HTTPS with 308.
- API readiness returned ready and all 10 migrations.
- Web sign-in page loaded.
- Generated temporary local owner logged in with OWNER membership; test sessions
  were revoked after checks.
- Unauthenticated protected API access returned 401.
- Public metrics returned 404 after correction of Caddy handler ordering.
- Application and operator ports bound exclusively to 127.0.0.1.
- Worker heartbeat age was approximately 10 seconds; no operational DEAD jobs
  or security events were present in the new database.
- MinIO bucket versioning enabled. Two object versions, read-back content and
  SHA-256 metadata verified.
- Prometheus targets reported up. Grafana database health reported ok.
- Full database/object backup created and checksum verified:
  /etc/agent-foundry/backups/agent-foundry-20261004T075427Z.tgz.
- Backup restored into an isolated test database: 10 migrations and one owner
  membership. The test database was removed after verification.
- Objects imported into a separate acceptance bucket and compared with their
  production contents.
- Additive Foundry ingress rollback removed public readiness; reapplying the
  saved configuration restored it. Existing unrelated routes were retained.
  This verifies initial-deployment ingress rollback, not prior-version database
  rollback; no previous Foundry production release existed.

## Operational handoff and limits

The owner login is owner@foundry.frankai.online, a local application identifier.
No mailbox was provisioned. Generated login credentials were saved privately on
frank in /home/ray/.config/frankai/foundry-owner.txt with mode 0600.

OpenAI credentials/model and the production FrankAI registration endpoint remain
unconfigured. PROMPTFORGE_PROVIDER is openai; the deterministic CI provider was
not substituted. Storage/heartbeat processing runs independently, while missing
model configuration prevents model transformations. Registration fails closed.

Backup restoration was verified locally. Automated off-site custody and a
recurring backup schedule are not established by this deployment evidence.
