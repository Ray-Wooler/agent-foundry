#!/bin/sh
set -eu
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
root="${BACKUP_ROOT:-/backups}"
mkdir -p "$root/$timestamp"
pg_dump --format=custom --file="$root/$timestamp/foundry.dump" "$DATABASE_URL"
sha256sum "$root/$timestamp/foundry.dump" > "$root/$timestamp/foundry.dump.sha256"
if [ -n "${OBJECT_STORAGE_BUCKET:-}" ]; then
  node scripts/export_object_storage.mjs "$root/$timestamp/object-storage" >/dev/null
fi
tar -C "$root" -czf "$root/agent-foundry-$timestamp.tgz" "$timestamp"
sha256sum "$root/agent-foundry-$timestamp.tgz" > "$root/agent-foundry-$timestamp.tgz.sha256"
printf "%s\n" "$root/agent-foundry-$timestamp.tgz"
