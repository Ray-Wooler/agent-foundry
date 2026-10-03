# Incremental encrypted off-site backup

This design keeps the Foundry S3-compatible primary on the Hostinger host and
stores encrypted recovery material on a separate Webcentral filesystem. It does
not require Docker on Webcentral.

The primary should use the repository’s existing `ArtifactStore` S3-compatible
interface with a dedicated Hostinger-local S3 service/bucket and private
container-network endpoint. It must not reuse ACC’s MinIO instance or bucket.
The service choice and credentials remain a provisioning decision; this branch
does not install or configure a live object-storage service.

## Storage and isolation targets

- Foundry primary object-storage target: at most 10 GB initially.
- Webcentral recovery target: at most 30 GB initially.
- These are fail-closed operating limits, not quotas provisioned by this change.
- Webcentral backup paths and credentials must be separate from Jaymz/ACC data.
- No deletion or retention policy is applied automatically. Old immutable object
  blobs may remain until an operator-approved retention process is added.

## Flow

`ops/backup-incremental.sh`:

1. Lists primary objects and reads digest, byte-size, and media-type metadata.
2. Compares the snapshot with a local metadata-only manifest.
3. Downloads only new or changed objects and verifies their digest.
4. Creates a new full manifest; removed keys become absent from that manifest.
5. Encrypts changed object payloads, the manifest, and a PostgreSQL custom dump
   with GnuPG AES-256 before transfer.
6. Uses `rsync --checksum` to a local filesystem path or an SSH filesystem
   receiver. Objects are content-addressed by digest, so unchanged payloads are
   not retransferred.
7. Publishes `LATEST` only after encrypted files transfer successfully.
8. Verifies quota/free-space conditions before transfer and fails closed if they
   cannot be measured or would be exceeded.

`ops/restore-incremental.sh` pulls the selected generation, decrypts and verifies
all referenced payloads and the database dump, restores PostgreSQL, then imports
the manifest’s current object set into an empty target bucket.

## Required handoff values

```text
OBJECT_STORAGE_*                 Hostinger primary S3-compatible storage
BACKUP_ENCRYPTION_KEY_FILE       separate recovery encryption secret
BACKUP_REMOTE_PATH                local mounted receiver, or
BACKUP_SSH_TARGET + BACKUP_SSH_PATH  Webcentral filesystem receiver
BACKUP_QUOTA_BYTES                approved recovery capacity, <=30 GB initially
BACKUP_MIN_FREE_BYTES             approved safety headroom
DATABASE_URL                      source/restore database target
```

No values belong in Git, command history, or this document.

## Dependencies and security

- Existing Node/AWS SDK storage adapter remains the primary storage interface.
- A Hostinger-local S3-compatible service is an additional deployment dependency;
  if MinIO is selected, record its applicable license and keep it isolated from
  ACC networks, volumes, users, and buckets.
- Webcentral needs `rsync`, `ssh`, `gpg`, and filesystem access only; Docker is
  not required.
- GnuPG is an external Debian package (GPL-3-or-later); it is not added to the
  Node dependency graph. Its symmetric key must be held separately from the
  Webcentral SSH key and database credentials.
- Application credentials, backup transfer credentials, and restore credentials
  must be separate. No remote key or account is provisioned by this change.

## RPO/RTO and operational limits

Run daily after capacity and bandwidth measurements. A full manifest is small,
but only changed object payloads and the database dump transfer each day. The
first run is a full seed. Restore drills must use a clean database and empty
object bucket, verify all digests, and record elapsed time. A failed capacity,
encryption, digest, transfer, or restore validation must stop the run without
deleting prior recovery generations.

The current repository’s existing `ops/backup.sh` remains a full local export;
this workflow is the separate incremental/off-site path.
