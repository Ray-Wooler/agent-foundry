#!/bin/sh
set -eu
: "${APP_VERSION:?APP_VERSION is required}"
: "${ACME_EMAIL:?ACME_EMAIL is required}"
: "${OPENAI_MODEL:?OPENAI_MODEL is required}"
: "${FRANKAI_REGISTRY_URL:?FRANKAI_REGISTRY_URL is required}"
docker compose -f compose.production.yml build --pull
docker compose -f compose.production.yml run --rm api pnpm db:migrate
docker compose -f compose.production.yml up -d --remove-orphans
docker compose -f compose.production.yml ps
curl -fsS https://foundry.frankai.online/api/ready
