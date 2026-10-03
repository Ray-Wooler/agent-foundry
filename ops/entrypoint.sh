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

for name in DATABASE_URL BOOTSTRAP_ADMIN_PASSWORD OBJECT_STORAGE_ACCESS_KEY OBJECT_STORAGE_SECRET_KEY OPENAI_API_KEY FRANKAI_REGISTRY_TOKEN; do
  load_secret "$name"
done

exec "$@"
