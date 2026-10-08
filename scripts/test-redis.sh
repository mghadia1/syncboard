#!/bin/sh
# The bus tests against a real Redis, in a throwaway container on a free
# port (server/src/redis-bus.test.ts; without one, they are skipped).
set -eu

name="syncboard-test-redis-$$"
docker run --detach --rm --name "$name" --publish 127.0.0.1::6379 redis:8-alpine >/dev/null
trap 'docker stop "$name" >/dev/null' EXIT INT TERM

tries=0
until docker exec "$name" redis-cli ping >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -gt 50 ]; then
    echo "Redis did not start" >&2
    exit 1
  fi
  sleep 0.1
done
port=$(docker port "$name" 6379/tcp | head -n 1 | sed 's/.*://')
echo "Redis $(docker exec "$name" redis-server --version | sed 's/.*v=\([^ ]*\).*/\1/') on port $port"

SYNCBOARD_TEST_REDIS_URL="redis://127.0.0.1:$port" npx vitest run server/src/redis-bus.test.ts
