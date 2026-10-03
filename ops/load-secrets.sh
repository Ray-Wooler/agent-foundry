#!/bin/sh
set -eu

load_optional_secret_file() {
  name="$1"
  file_var="${name}_FILE"
  eval "file=\${$file_var:-}"
  if [ -z "${file:-}" ]; then
    file="/run/secrets/$(printf '%s' "$name" | tr 'A-Z' 'a-z')"
  fi
  if [ -r "$file" ]; then
    value=$(cat "$file")
    export "$name=$value"
  fi
}

for name in DATABASE_URL OBJECT_STORAGE_ACCESS_KEY OBJECT_STORAGE_SECRET_KEY; do
  load_optional_secret_file "$name"
done
