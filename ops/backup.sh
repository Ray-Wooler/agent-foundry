#!/bin/sh
set -eu
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
root="${BACKUP_ROOT:-/backups}"
mkdir -p "$root/$timestamp"
pg_dump --format=custom --file="$root/$timestamp/foundry.dump" "$DATABASE_URL"
sha256sum "$root/$timestamp/foundry.dump" > "$root/$timestamp/foundry.dump.sha256"
if command -v mc >/dev/null 2>&1; then
  mc mirror --overwrite foundry/agent-foundry "$root/$timestamp/object-storage"
fi
tar -C "$root" -czf "$root/agent-foundry-$timestamp.tgz" "$timestamp"
sha256sum "$root/agent-foundry-$timestamp.tgz" > "$root/agent-foundry-$timestamp.tgz.sha256"
printf "%s\n" "$root/agent-foundry-$timestamp.tgz"
