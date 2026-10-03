#!/bin/sh
set -eu

if [ -f "$(dirname "$0")/load-secrets.sh" ]; then . "$(dirname "$0")/load-secrets.sh"; fi
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${OBJECT_STORAGE_BUCKET:?OBJECT_STORAGE_BUCKET is required}"
: "${BACKUP_ENCRYPTION_KEY_FILE:?BACKUP_ENCRYPTION_KEY_FILE is required}"
: "${BACKUP_QUOTA_BYTES:?BACKUP_QUOTA_BYTES is required}"
: "${BACKUP_MIN_FREE_BYTES:?BACKUP_MIN_FREE_BYTES is required}"
test -r "$BACKUP_ENCRYPTION_KEY_FILE"
command -v gpg >/dev/null
command -v rsync >/dev/null
command -v pg_dump >/dev/null

case "${BACKUP_REMOTE_PATH:-}" in
  /*) remote_kind=local; remote_root=$BACKUP_REMOTE_PATH ;;
  *) : "${BACKUP_SSH_TARGET:?BACKUP_REMOTE_PATH or BACKUP_SSH_TARGET/BACKUP_SSH_PATH is required}"; : "${BACKUP_SSH_PATH:?BACKUP_SSH_PATH is required}"; remote_kind=ssh; remote_root=$BACKUP_SSH_PATH ;;
esac
case "$remote_root" in *[!A-Za-z0-9._/-]*) echo "unsafe backup path" >&2; exit 1;; esac

root="${BACKUP_ROOT:-/var/backups/agent-foundry}"
generation="$(date -u +%Y%m%dT%H%M%SZ)"
stage="$root/.staging-$generation"
state="${BACKUP_STATE_ROOT:-/var/lib/agent-foundry-backup}/manifest.json"
rm -rf "$stage"
mkdir -p "$stage/db" "$stage/manifests" "$stage/objects" "$(dirname "$state")"
cleanup(){ rm -rf "$stage"; }
trap cleanup EXIT

if [ "$remote_kind" = local ]; then
  mkdir -p "$remote_root"
  remote_used="$(du -sb "$remote_root" | awk '{print $1}')"
  remote_free="$(df -Pk "$remote_root" | awk 'NR==2{print $4*1024}')"
else
  remote_used="$(ssh -o BatchMode=yes "$BACKUP_SSH_TARGET" "mkdir -p -- '$remote_root' && du -sb -- '$remote_root' | awk '{print \$1}'")"
  remote_free="$(ssh -o BatchMode=yes "$BACKUP_SSH_TARGET" "df -Pk -- '$remote_root' | awk 'NR==2{print \$4*1024}'")"
fi
case "$remote_used:$remote_free" in *[!0-9:]*|:*) echo "unable to verify remote capacity" >&2; exit 1;; esac

export INCREMENTAL_BACKUP_STAGE="$stage" INCREMENTAL_BACKUP_STATE="$state" INCREMENTAL_BACKUP_GENERATION="$generation"
node scripts/prepare_incremental_object_backup.mjs
pg_dump --format=custom --file="$stage/db/foundry.dump" "$DATABASE_URL"
sha256sum "$stage/db/foundry.dump" > "$stage/db/foundry.dump.sha256"
db_sha256="$(awk '{print $1}' "$stage/db/foundry.dump.sha256")"
db_bytes="$(wc -c < "$stage/db/foundry.dump" | tr -d ' ')"
node -e 'const fs=require("fs");const p=process.argv[1];const m=JSON.parse(fs.readFileSync(p));m.database={sha256:process.argv[2],byteSize:Number(process.argv[3])};fs.writeFileSync(p,JSON.stringify(m,null,2)+"\n")' "$stage/manifest.json" "$db_sha256" "$db_bytes"

for payload in "$stage"/payloads/*.payload; do
  [ -f "$payload" ] || continue
  digest=$(basename "$payload" .payload)
  gpg --batch --yes --pinentry-mode loopback --passphrase-file "$BACKUP_ENCRYPTION_KEY_FILE" --symmetric --cipher-algo AES256 --output "$stage/objects/$digest.payload.gpg" "$payload"
done
gpg --batch --yes --pinentry-mode loopback --passphrase-file "$BACKUP_ENCRYPTION_KEY_FILE" --symmetric --cipher-algo AES256 --output "$stage/manifests/$generation.manifest.gpg" "$stage/manifest.json"
gpg --batch --yes --pinentry-mode loopback --passphrase-file "$BACKUP_ENCRYPTION_KEY_FILE" --symmetric --cipher-algo AES256 --output "$stage/db/$generation.dump.gpg" "$stage/db/foundry.dump"
rm -rf "$stage/payloads" "$stage/db/foundry.dump"
estimate="$(du -sb "$stage" | awk '{print $1}')"
if [ $((remote_used+estimate)) -gt "$BACKUP_QUOTA_BYTES" ] || [ $((estimate+BACKUP_MIN_FREE_BYTES)) -gt "$remote_free" ]; then
  echo "backup capacity check failed" >&2
  exit 1
fi

if [ "$remote_kind" = local ]; then
  mkdir -p "$remote_root/objects" "$remote_root/manifests" "$remote_root/db"
  rsync -a --checksum "$stage/objects/" "$remote_root/objects/"
  rsync -a --checksum "$stage/manifests/" "$remote_root/manifests/"
  rsync -a --checksum "$stage/db/$generation.dump.gpg" "$remote_root/db/"
  printf '%s\n' "$generation" > "$remote_root/LATEST.tmp" && mv "$remote_root/LATEST.tmp" "$remote_root/LATEST"
else
  ssh -o BatchMode=yes "$BACKUP_SSH_TARGET" "mkdir -p -- '$remote_root/objects' '$remote_root/manifests' '$remote_root/db'"
  rsync -a --checksum "$stage/objects/" "$BACKUP_SSH_TARGET:$remote_root/objects/"
  rsync -a --checksum "$stage/manifests/" "$BACKUP_SSH_TARGET:$remote_root/manifests/"
  rsync -a --checksum "$stage/db/$generation.dump.gpg" "$BACKUP_SSH_TARGET:$remote_root/db/"
  printf '%s\n' "$generation" | ssh -o BatchMode=yes "$BACKUP_SSH_TARGET" "cat > '$remote_root/LATEST.tmp' && mv '$remote_root/LATEST.tmp' '$remote_root/LATEST'"
fi
cp "$stage/manifest.json" "$state"
printf '%s\n' "{\"status\":\"PASS\",\"generation\":\"$generation\",\"encrypted\":true,\"remote_kind\":\"$remote_kind\"}"
