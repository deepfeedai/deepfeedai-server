#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
name="dfa-editions-test-$(date +%s)-$$"
network="$name-network"
database="$name-db"
image="$name-app"
cleanup() {
  docker rm -f "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT
# The acceptance Dockerfile-specific ignore file includes tests and excludes live data/config.
# Downloads are dependency setup only. Test containers receive no provider credentials.
docker build -t "$image" -f tests/acceptance/Dockerfile .
docker image inspect pgvector/pgvector:pg16-bookworm >/dev/null 2>&1 || docker pull pgvector/pgvector:pg16-bookworm
docker network create --internal "$network" >/dev/null
docker run -d --name "$database" --network "$network" --tmpfs /var/lib/postgresql/data -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=publishing_acceptance pgvector/pgvector:pg16-bookworm >/dev/null
for i in $(seq 1 30); do docker exec "$database" pg_isready -U postgres -d publishing_acceptance >/dev/null 2>&1 && break; sleep 1; done
docker run --rm --network "$network" --tmpfs /app/public/media:uid=1000,gid=1000,mode=0755 \
  -e "DATABASE_URL=postgresql://postgres@$database:5432/publishing_acceptance" \
  -e DATABASE_SSL=disable -e PUBLISHING_ACCEPTANCE=1 -e NODE_ENV=test \
  -e AUTOMATION_ENABLED=false -e DEPLOYMENT_MODE=multi \
  -e SETTINGS_ENCRYPTION_KEY=1111111111111111111111111111111111111111111111111111111111111111 \
  "$image" node -r tsx/cjs --test --test-concurrency=1 tests/edition-print.test.js tests/edition-markdown.test.js tests/edition-references.test.js tests/edition-contributors.test.js tests/editions*.test.js tests/integration/editions.test.js tests/integration/edition-reference-backfill.test.js tests/integration/edition-contributors.test.js tests/integration/edition-lifecycle.test.js tests/integration/edition-identifiers.test.js
