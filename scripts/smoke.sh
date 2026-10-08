#!/usr/bin/env bash
# Checks a running Compose stack from outside, over real HTTP and
# WebSockets: the health endpoint, the built client and its bundle, that no
# path reaches files outside the client's assets, JSON 404s and 405s with
# Allow, the WebSocket hello and its refusals (a server that survives an
# oversized frame), that the container runs unprivileged and healthy, and
# that `docker compose stop` shuts it down cleanly: open clients told 1001,
# exit code 0, well inside the grace period.
#
# Needs curl, and Node 22 or newer for the WebSocket checks.
set -euo pipefail
port="${SYNCBOARD_PORT:-8300}"
base_url="http://localhost:$port"
ws_url="ws://localhost:$port/ws"
here="$(cd "$(dirname "$0")" && pwd)"

status() { curl --silent --output /dev/null --write-out '%{http_code}' "$@"; }
header() { # header NAME CURL-ARGS...: one response header's value
  local name="$1"; shift
  curl --silent --output /dev/null --dump-header - "$@" | tr -d '\r' \
    | awk -v n="$(echo "$name" | tr 'A-Z' 'a-z')" -F': ' 'tolower($1) == n { print $2 }'
}
expect() { # expect NAME GOT WANT
  if [ "$2" != "$3" ]; then echo "FAIL $1: got $2, want $3" >&2; exit 1; fi
  echo "ok   $1: $2"
}
ws() { node "$here/ws-check.mjs" "$ws_url" "$1"; }

expect "health" "$(curl --fail --silent --show-error "$base_url/healthz")" '{"status":"ok","version":"0.1.0"}'
expect "health HEAD" "$(status --head "$base_url/healthz")" "200"
expect "health wrong method" "$(status -X POST "$base_url/healthz")" "405"
expect "health wrong method Allow" "$(header allow -X POST "$base_url/healthz")" "GET, HEAD"

index="$(curl --fail --silent --show-error "$base_url/")"
expect "client index served" "$(echo "$index" | grep -c '<div id="root">')" "1"
expect "index not cached" "$(header cache-control "$base_url/")" "no-cache"
bundle="$(echo "$index" | grep -o '/assets/index-[A-Za-z0-9_-]*\.js' | head -1)"
expect "index names a hashed bundle" "$([ -n "$bundle" ] && echo yes || echo no)" "yes"
expect "bundle served" "$(status "$base_url$bundle")" "200"
expect "bundle type" "$(header content-type "$base_url$bundle")" "text/javascript; charset=utf-8"
expect "bundle cached for good" "$(header cache-control "$base_url$bundle")" "public, max-age=31536000, immutable"

# The server's own files sit beside the client in the image; none may leak.
for target in \
  "/assets/..%2f..%2fserver%2fdist%2fconfig.js" \
  "/assets/%2e%2e/%2e%2e/package.json" \
  "/assets/..%5c..%5cpackage.json" \
  "/package.json" \
  "/server/dist/main.js"; do
  expect "no file outside assets: $target" "$(status --path-as-is "$base_url$target")" "404"
done
expect "unknown path" "$(status "$base_url/nope")" "404"
expect "unknown path is JSON" "$(curl --silent "$base_url/nope")" '{"error":"not found"}'
expect "/ws over plain HTTP" "$(status "$base_url/ws")" "426"

expect "ws hello" "$(ws hello)" "welcome"
expect "ws other protocol closes with" "$(ws protocol)" "4001"
expect "ws oversized frame closes with" "$(ws oversized)" "1009"
expect "ws still answering after that" "$(ws hello)" "welcome"

expect "runs as uid" "$(docker compose exec -T syncboard id -u)" "1000"
expect "container health" "$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q syncboard)")" "healthy"

# A clean stop, with a client connected: it must be told 1001, and the
# process must exit by itself (0), not be killed at the end of the grace
# period (137). Node as PID 1 has no default SIGTERM handling, so this
# checks the server's own.
container="$(docker compose ps -q syncboard)"
waiter="$(mktemp)"
ws wait-close > "$waiter" &
waiter_pid=$!
for _ in $(seq 50); do grep -q ready "$waiter" && break; sleep 0.1; done
started=$(date +%s)
docker compose stop syncboard > /dev/null 2>&1
took=$(( $(date +%s) - started ))
wait "$waiter_pid"
expect "open client told on stop" "$(tail -1 "$waiter")" "1001"
expect "exit code after stop" "$(docker inspect --format '{{.State.ExitCode}}' "$container")" "0"
expect "stopped within 5 s" "$([ "$took" -le 5 ] && echo yes || echo "no, ${took} s")" "yes"
rm -f "$waiter"
docker compose start syncboard > /dev/null 2>&1

echo "smoke test passed"
