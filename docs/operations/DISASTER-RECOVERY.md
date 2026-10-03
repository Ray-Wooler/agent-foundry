# Disaster Recovery Runbook

## Recovery objectives

Initial Phase 7 targets:
- RPO: 24 hours maximum from scheduled backup; lower when backup cadence is increased.
- RTO: 4 hours for single-host recovery under normal infrastructure availability.

These are operational targets, not guarantees.

## Backup contents

A full recovery set includes:
1. PostgreSQL custom-format dump.
2. SHA-256 checksum for the dump.
3. S3/S3-compatible object storage artifact mirror when available.
4. compressed recovery archive.
5. SHA-256 checksum for the recovery archive.
6. deployment commit SHA and production environment metadata.

## Backup procedure

Run:
```bash
DATABASE_URL=... BACKUP_ROOT=/var/backups/agent-foundry sh ops/backup.sh
```

Verify:
```bash
sh ops/backup-verify.sh /var/backups/agent-foundry/agent-foundry-<timestamp>.tgz
```

Copy the verified archive and checksum off-host.

## Restore procedure

1. Provision a clean supported host.
2. Install Docker Engine and Compose.
3. Checkout the authoritative GitHub commit.
4. Restore secret files under `/etc/agent-foundry/secrets`.
5. Start PostgreSQL and external S3-compatible object storage only.
6. Set the target DATABASE_URL.
7. Run:
   ```bash
   sh ops/restore.sh <verified-backup.tgz>
   ```
8. Validate migration count and critical tables.
9. Start API/worker/web.
10. Verify `/api/ready`.
11. Verify worker heartbeat age.
12. Read and verify at least one stored artifact.
13. Start Caddy.
14. Verify TLS and end-to-end login.
15. Record recovery evidence and incident timeline.

## Rollback

For a failed application deployment with healthy data services:
1. identify previous accepted Git commit/image;
2. stop API, worker and web;
3. checkout previous accepted commit;
4. rebuild/redeploy application containers;
5. do not reverse irreversible database migrations unless the migration explicitly provides a tested rollback;
6. verify /api/ready and critical workflow smoke tests.

If a migration causes data corruption, restore from the most recent verified backup to a clean database and perform incident recovery rather than attempting ad-hoc SQL reversal.

## Restore drill

At least quarterly:
- restore latest backup into an isolated database;
- compare migration count;
- verify users/workspaces/agents/evidence row counts;
- verify an object-storage artifact digest;
- record elapsed recovery time;
- update RPO/RTO assumptions.
