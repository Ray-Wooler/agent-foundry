#!/bin/sh
set -eu
if [ -f "$(dirname "$0")/load-secrets.sh" ]; then . "$(dirname "$0")/load-secrets.sh"; fi
: "${BACKUP_ENCRYPTION_KEY_FILE:?BACKUP_ENCRYPTION_KEY_FILE is required}"
: "${RESTORE_ROOT:?RESTORE_ROOT is required}"
: "${DATABASE_URL:?DATABASE_URL is required}"
test -r "$BACKUP_ENCRYPTION_KEY_FILE"
command -v gpg >/dev/null; command -v rsync >/dev/null; command -v pg_restore >/dev/null
case "${BACKUP_REMOTE_PATH:-}" in
  /*) remote_kind=local; remote_root=$BACKUP_REMOTE_PATH ;;
  *) : "${BACKUP_SSH_TARGET:?BACKUP_REMOTE_PATH or BACKUP_SSH_TARGET/BACKUP_SSH_PATH is required}"; : "${BACKUP_SSH_PATH:?BACKUP_SSH_PATH is required}"; remote_kind=ssh; remote_root=$BACKUP_SSH_PATH ;;
esac
case "$remote_root" in *[!A-Za-z0-9._/-]*) echo "unsafe backup path" >&2; exit 1;; esac
rm -rf "$RESTORE_ROOT"
mkdir -p "$RESTORE_ROOT/manifests" "$RESTORE_ROOT/objects" "$RESTORE_ROOT/plain"
if [ "$remote_kind" = local ]; then
  latest=$(cat "$remote_root/LATEST")
  cp "$remote_root/manifests/$latest.manifest.gpg" "$RESTORE_ROOT/manifests/"
  cp "$remote_root/db/$latest.dump.gpg" "$RESTORE_ROOT/"
  rsync -a "$remote_root/objects/" "$RESTORE_ROOT/objects/"
else
  latest=$(ssh -o BatchMode=yes "$BACKUP_SSH_TARGET" "cat -- '$remote_root/LATEST'")
  rsync -a "$BACKUP_SSH_TARGET:$remote_root/manifests/$latest.manifest.gpg" "$RESTORE_ROOT/manifests/"
  rsync -a "$BACKUP_SSH_TARGET:$remote_root/db/$latest.dump.gpg" "$RESTORE_ROOT/"
  rsync -a "$BACKUP_SSH_TARGET:$remote_root/objects/" "$RESTORE_ROOT/objects/"
fi
case "$latest" in *[!A-Za-z0-9T:_-]*) echo "unsafe backup generation" >&2; exit 1;; esac
gpg --batch --pinentry-mode loopback --passphrase-file "$BACKUP_ENCRYPTION_KEY_FILE" --decrypt --output "$RESTORE_ROOT/manifest.json" "$RESTORE_ROOT/manifests/$latest.manifest.gpg"
node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1]));for(const x of new Set(Object.values(m.objects).map(v=>v.sha256))) console.log(x)' "$RESTORE_ROOT/manifest.json" | while IFS= read -r digest; do
  gpg --batch --pinentry-mode loopback --passphrase-file "$BACKUP_ENCRYPTION_KEY_FILE" --decrypt --output "$RESTORE_ROOT/plain/$digest.payload" "$RESTORE_ROOT/objects/$digest.payload.gpg"
  printf '%s  %s\n' "$digest" "$RESTORE_ROOT/plain/$digest.payload" > "$RESTORE_ROOT/plain/$digest.sha256"
  sha256sum -c "$RESTORE_ROOT/plain/$digest.sha256" >/dev/null
done
gpg --batch --pinentry-mode loopback --passphrase-file "$BACKUP_ENCRYPTION_KEY_FILE" --decrypt --output "$RESTORE_ROOT/foundry.dump" "$RESTORE_ROOT/$latest.dump.gpg"
db_sha256=$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1])).database?.sha256??"")' "$RESTORE_ROOT/manifest.json")
test -n "$db_sha256"
printf '%s  %s\n' "$db_sha256" "$RESTORE_ROOT/foundry.dump" > "$RESTORE_ROOT/foundry.dump.sha256"
sha256sum -c "$RESTORE_ROOT/foundry.dump.sha256" >/dev/null
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$RESTORE_ROOT/foundry.dump"
node scripts/import_incremental_objects.mjs "$RESTORE_ROOT/manifest.json" "$RESTORE_ROOT/plain"
printf '%s\n' "{\"status\":\"PASS\",\"generation\":\"$latest\",\"encrypted\":true}"
