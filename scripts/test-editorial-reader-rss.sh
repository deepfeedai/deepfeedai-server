#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
name="dfa-reader-test-$(date +%s)-$$"
network="$name-network"
database="$name-db"
runner="$name-runner"
image="$name-app"
cleanup() {
  docker rm -f "$runner" "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT
# Dependency/image downloads are setup only. No production env files are passed.
docker build -t "$image" -f tests/acceptance/Dockerfile .
docker image inspect pgvector/pgvector:pg16-bookworm >/dev/null 2>&1 || docker pull pgvector/pgvector:pg16-bookworm
docker network create --internal "$network" >/dev/null
docker run -d --name "$database" --network "$network" --memory 768m --cpus .5 \
  --tmpfs /var/lib/postgresql/data -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=publishing_acceptance pgvector/pgvector:pg16-bookworm >/dev/null
for attempt in $(seq 1 30); do
  if docker exec "$database" pg_isready -U postgres -d publishing_acceptance >/dev/null 2>&1; then break; fi
  if [ "$attempt" = 30 ]; then echo 'Disposable database did not become ready' >&2; exit 1; fi
  sleep 1
done
docker run --rm --name "$runner" --network "$network" --memory 1536m --cpus 1 \
  --tmpfs /app/public/media:uid=1000,gid=1000,mode=0755 \
  -e "DATABASE_URL=postgresql://postgres@$database:5432/publishing_acceptance" \
  -e DATABASE_SSL=disable -e PUBLISHING_ACCEPTANCE=1 -e NODE_ENV=test \
  -e AUTOMATION_ENABLED=false -e DEPLOYMENT_MODE=multi \
  -e SETTINGS_ENCRYPTION_KEY=1111111111111111111111111111111111111111111111111111111111111111 \
  "$image" node -r tsx/cjs --test --test-concurrency=1 \
  tests/rss-sources.test.js tests/rss-body-parser.test.js tests/reader-entry.test.js tests/reader-fetch.test.js \
  tests/reader-ui.test.js tests/sources-ui.test.js \
  tests/integration/reader.test.js tests/integration/rss-workspace.test.js
