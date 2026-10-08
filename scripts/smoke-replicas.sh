#!/usr/bin/env bash
# Checks a running two-server stack (compose.replicas.yaml) from outside:
# both servers healthy and on the bus; one data file between them; an edit
# on one reaching a client on the other quickly, both ways; presence and
# leaving across them; with Redis stopped, edits still crossing (through
# the disk) and both servers still healthy; Redis back, the bus back; a
# server restarted or SIGKILLed losing nothing acknowledged; a clean stop.
#
# Needs curl, and Node 22 or newer for the WebSocket checks.
set -euo pipefail
port_a="${SYNCBOARD_PORT_A:-8310}"
port_b="${SYNCBOARD_PORT_B:-8311}"
here="$(cd "$(dirname "$0")" && pwd)"
compose=(docker compose -f "$here/../compose.replicas.yaml")

expect() { # expect NAME GOT WANT
  if [ "$2" != "$3" ]; then echo "FAIL $1: got $2, want $3" >&2; exit 1; fi
  echo "ok   $1: $2"
}
health() { curl --silent --max-time 2 "http://localhost:$1/healthz" || echo "no answer"; }
ws() { # ws PORT CHECK [ARG]
  local port="$1"; shift
  node "$here/ws-check.mjs" "ws://localhost:$port/ws" "$@"
}
ms() { sed -E 's/crossed in ([0-9]+)\..*/\1/'; }
fast() { # fast MS LIMIT: "fast" if MS <= LIMIT
  if [ "$1" -le "$2" ]; then echo fast; else echo "slow, $1 ms"; fi
}
wait_for() { # wait_for PORT JSON: until /healthz says exactly that (20 s)
  for _ in $(seq 200); do [ "$(health "$1")" = "$2" ] && return 0; sleep 0.1; done
  return 1
}

connected='{"status":"ok","version":"0.1.0","bus":"connected"}'
disconnected='{"status":"ok","version":"0.1.0","bus":"disconnected"}'
wait_for "$port_a" "$connected" || true
wait_for "$port_b" "$connected" || true
expect "server a healthy, on the bus" "$(health "$port_a")" "$connected"
expect "server b healthy, on the bus" "$(health "$port_b")" "$connected"
expect "one data file for both" \
  "$("${compose[@]}" exec -T a sh -c 'stat -c %i /data/boards.sqlite')" \
  "$("${compose[@]}" exec -T b sh -c 'stat -c %i /data/boards.sqlite')"

# Within 250 ms: through Redis. (Through the disk would take a tick or
# two of 500 ms.)
crossed="$(ws "$port_a" cross "ws://localhost:$port_b/ws")"
expect "an edit on a reaches b's client, by the bus" "$(fast "$(echo "$crossed" | ms)" 250)" "fast"
crossed="$(ws "$port_b" cross "ws://localhost:$port_a/ws")"
expect "an edit on b reaches a's client, by the bus" "$(fast "$(echo "$crossed" | ms)" 250)" "fast"
expect "presence and leaving across servers" "$(ws "$port_a" presence-cross "ws://localhost:$port_b/ws")" "seen and left"

# Redis gone: both still serve and take edits; edits still cross, by disk.
"${compose[@]}" stop redis > /dev/null 2>&1
wait_for "$port_a" "$disconnected" || true
expect "without Redis, a still healthy" "$(health "$port_a")" "$disconnected"
expect "without Redis, b still healthy" "$(health "$port_b")" "$disconnected"
crossed="$(ws "$port_a" cross "ws://localhost:$port_b/ws")"
expect "without Redis, an edit still crosses (from disk, within 2 s)" "$(fast "$(echo "$crossed" | ms)" 2000)" "fast"
"${compose[@]}" start redis > /dev/null 2>&1
wait_for "$port_a" "$connected" || true
wait_for "$port_b" "$connected" || true
expect "Redis back: a on the bus again" "$(health "$port_a")" "$connected"
expect "Redis back: b on the bus again" "$(health "$port_b")" "$connected"
crossed="$(ws "$port_a" cross "ws://localhost:$port_b/ws")"
expect "Redis back: edits cross by the bus again" "$(fast "$(echo "$crossed" | ms)" 250)" "fast"

# Acknowledged edits are on the shared disk: written on a, read on b,
# after b restarts, and after a SIGKILL of a.
board="smokepair$(date +%s)"
expect "an edit acknowledged by a" "$(ws "$port_a" write "$board")" "acked"
before="$(ws "$port_b" read "$board")"
expect "b serves it, with the same epoch" "$(echo "$before" | cut -d, -f1)" "1 notes"
expect "a's epoch for it" "$(ws "$port_a" read "$board")" "$before"
"${compose[@]}" restart b > /dev/null 2>&1
"${compose[@]}" up --detach --wait > /dev/null 2>&1
expect "after b restarts, the board and its epoch" "$(ws "$port_b" read "$board")" "$before"
expect "another edit acknowledged by a" "$(ws "$port_a" write "$board")" "acked"
"${compose[@]}" kill -s SIGKILL a > /dev/null 2>&1
expect "a SIGKILLed: b still serves both edits" "$(ws "$port_b" read "$board" | cut -d, -f1)" "2 notes"
"${compose[@]}" up --detach --wait > /dev/null 2>&1
expect "a back: both edits" "$(ws "$port_a" read "$board" | cut -d, -f1)" "2 notes"

# A clean stop of both: exit code 0 each, not killed at the grace period.
a_id="$("${compose[@]}" ps -q a)"
b_id="$("${compose[@]}" ps -q b)"
"${compose[@]}" stop a b > /dev/null 2>&1
expect "a stopped cleanly" "$(docker inspect --format '{{.State.ExitCode}}' "$a_id")" "0"
expect "b stopped cleanly" "$(docker inspect --format '{{.State.ExitCode}}' "$b_id")" "0"
"${compose[@]}" start a b > /dev/null 2>&1

echo "replicas smoke test passed"
