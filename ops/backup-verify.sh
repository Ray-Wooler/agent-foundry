#!/bin/sh
set -eu
archive="$1"
sha_file="$archive.sha256"
test -f "$archive"
test -f "$sha_file"
cd "$(dirname "$archive")"
sha256sum -c "$(basename "$sha_file")"
tar -tzf "$(basename "$archive")" | grep -q "foundry.dump"
echo "backup verification PASS"
