#!/bin/sh
set -eu

load_secret() {
  name="$1"
  file_var="${name}_FILE"
  eval "file=\${$file_var:-}"
  if [ -n "${file:-}" ]; then
    if [ ! -r "$file" ]; then
      echo "secret file for $name is not readable: $file" >&2
      exit 1
    fi
    value="$(cat "$file")"
    export "$name=$value"
  fi
}

for name in DATABASE_URL OBJECT_STORAGE_ACCESS_KEY OBJECT_STORAGE_SECRET_KEY; do
  load_secret "$name"
done

: "${DATABASE_URL:?DATABASE_URL or DATABASE_URL_FILE is required}"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
root="${BACKUP_ROOT:-/backups}"
mkdir -p "$root/$timestamp"
pg_dump --format=custom --file="$root/$timestamp/foundry.dump" "$DATABASE_URL"
sha256sum "$root/$timestamp/foundry.dump" > "$root/$timestamp/foundry.dump.sha256"
if [ -n "${OBJECT_STORAGE_BUCKET:-}" ]; then
  : "${OBJECT_STORAGE_ACCESS_KEY:?OBJECT_STORAGE_ACCESS_KEY or OBJECT_STORAGE_ACCESS_KEY_FILE is required}"
  : "${OBJECT_STORAGE_SECRET_KEY:?OBJECT_STORAGE_SECRET_KEY or OBJECT_STORAGE_SECRET_KEY_FILE is required}"
  node scripts/export_object_storage.mjs "$root/$timestamp/object-storage" >/dev/null
fi
tar -C "$root" -czf "$root/agent-foundry-$timestamp.tgz" "$timestamp"
sha256sum "$root/agent-foundry-$timestamp.tgz" > "$root/agent-foundry-$timestamp.tgz.sha256"
printf "%s\n" "$root/agent-foundry-$timestamp.tgz"
