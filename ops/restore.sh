#!/bin/sh
set -eu
archive="$1"
restore_root="${RESTORE_ROOT:-/tmp/agent-foundry-restore}"
rm -rf "$restore_root"
mkdir -p "$restore_root"
tar -C "$restore_root" -xzf "$archive"
dump="$(find "$restore_root" -name foundry.dump -type f | head -n 1)"
test -n "$dump"
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$dump"
objects="$(find "$restore_root" -type d -name object-storage | head -n 1 || true)"
if [ -n "$objects" ] && command -v mc >/dev/null 2>&1; then
  mc mirror --overwrite "$objects" foundry/agent-foundry
fi
