#!/bin/sh
set -eu
if [ -f "$(dirname "$0")/load-secrets.sh" ]; then . "$(dirname "$0")/load-secrets.sh"; fi
archive="$1"
restore_root="${RESTORE_ROOT:-/tmp/agent-foundry-restore}"
rm -rf "$restore_root"
mkdir -p "$restore_root"
tar -C "$restore_root" -xzf "$archive"
dump="$(find "$restore_root" -name foundry.dump -type f | head -n 1)"
test -n "$dump"
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$dump"
objects="$(find "$restore_root" -type d -name object-storage | head -n 1 || true)"
if [ -n "$objects" ] && [ -n "${OBJECT_STORAGE_BUCKET:-}" ]; then
  node scripts/import_object_storage.mjs "$objects"
fi
