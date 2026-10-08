# SyncBoard

A collaborative whiteboard. Several people draw on one board at once, see
each other's cursors, keep drawing through a dropped connection, and always
end up looking at the same board.

It deliberately does not use Yjs, Automerge, Liveblocks, Socket.IO,
tldraw, Excalidraw, Konva or Fabric: the point is to build the sync (a CRDT
for the board, and a WebSocket protocol to carry it) and the drawing.

> **Status:** Milestone 0 of 7, the skeleton. The server answers a health
> check, serves the client, and greets it over a WebSocket with typed,
> validated messages; there is nothing to draw on yet.
>
> TypeScript is the language I am learning on this project (built with
> Claude): it is not on my resume until I can write and explain it unaided.

## Status

| # | Milestone | Status |
|---|-----------|--------|
| 0 | Skeleton: npm workspaces (shared, server, client), strict TypeScript, ESLint, Vitest; a Node server with `/healthz`, graceful shutdown and a typed WebSocket hello; React (Vite, TypeScript) shell served by the server; one-container Compose; CI | Done |
| 1 | The board as a CRDT in `shared`: last-writer-wins properties ordered by (Lamport clock, client id), tombstones, fractional indexes; property tests that any order, duplication or split of the operations converges | Not started |
| 2 | Drawing, one person: shapes, freehand, sticky notes; select, move, resize, delete; pan and zoom; undo and redo, all through the CRDT | Not started |
| 3 | Realtime sync: rooms, a snapshot on joining, operations relayed and acknowledged, reconnection that resends, offline edits merged | Not started |
| 4 | Presence (cursors, selections, who is here) and undo of only your own changes | Not started |
| 5 | Persistence: an operation log and snapshots per board; SIGKILL test | Not started |
| 6 | Two replicas sharing rooms through Redis pub/sub; load test of propagation latency and convergence | Not started |
| 7 | README: diagram, design decisions, failures found, benchmarks; explain-it-yourself prompts | Not started |

## Quickstart

Needs Docker.

```bash
make up        # build and start on :8300; waits until the health check passes
open http://localhost:8300
curl localhost:8300/healthz
make down
```

`make smoke` starts a separate stack on :8301, checks it from outside over
HTTP and WebSockets (27 checks, including a clean stop with a client
connected), and removes it. It needs Node 22 or newer on the host for the
WebSocket checks.

## The protocol so far

JSON text frames on `/ws`. The types live in `shared/src/protocol.ts`, used
by both the server and the browser, so a message one side does not handle
is a compile error.

```
browser ──► {"type": "hello", "protocol": 1}
        ◄── {"type": "welcome", "protocol": 1, "version": "0.1.0"}
```

- Everything received is `unknown` until `parseClientMessage` or
  `parseServerMessage` has checked it, field by field; there is no other
  way to get a typed message. Fields the protocol does not know are
  ignored, so a newer client's additions do not break an older server.
- A different protocol version gets `{"type": "error", "code":
  "unsupported_protocol"}` and close code **4001**. A frame that is not a
  protocol message (not JSON, an unknown type, binary) gets `bad_message`
  and **1008**. A frame over 1 MiB is closed with **1009**, invalid UTF-8
  with **1007**, and the server carries on.
- On shutdown every open client gets **1001** ("server shutting down"); a
  client that does not finish closing within 5 s is cut off.

## HTTP

| Path | Answer |
|------|--------|
| `GET /healthz` | `{"status": "ok", "version": "0.1.0"}`: liveness only |
| `GET /` | the client's `index.html`, `Cache-Control: no-cache` |
| `GET /assets/<name>` | a built file, cached for a year (`immutable`): its name has a content hash |
| `/ws` | the WebSocket; over plain HTTP, 426 |
| anything else | a JSON 404; a wrong method on a known path is a 405 with `Allow` |

## Development

Needs Node 24 (`.nvmrc`; `nvm use`).

```bash
make install     # npm ci for all three packages
make check       # ESLint (type-aware), tsc -b (tests included), Vitest, build
make dev-server  # the server on :8000, restarting on changes
make dev-client  # the client on :5173, forwarding /healthz and /ws to :8000
```

## Layout

| Path | What |
|------|------|
| `shared/src/protocol.ts` | The messages, their types and their validation |
| `server/src/app.ts` | The HTTP server, the WebSocket endpoint, shutdown |
| `server/src/static.ts` | Serving the built client, and nothing else from disk |
| `server/src/config.ts` | `SYNCBOARD_*` environment variables |
| `server/src/main.ts` | Startup, and shutting down on SIGTERM and SIGINT |
| `server/src/healthcheck.ts` | Docker's health check (the image has no curl) |
| `client/src/connection.ts` | Opening the WebSocket and saying hello |
| `client/src/App.tsx` | The page |
| `server/src/app.test.ts` | HTTP, path traversal, the protocol, shutdown |
| `client/src/App.test.tsx` | The page against a fake WebSocket |
| `scripts/smoke.sh`, `scripts/ws-check.mjs` | Checks a running container from outside |

## Decisions so far

- **The sync is built, not bought.** No Yjs, Automerge or Liveblocks: a
  CRDT and a sync protocol are what this project is for.
- **One set of types for both sides.** npm workspaces: `shared` holds the
  protocol, and the server and the client import it. The server runs on
  its compiled output; the client and the tests use its source, so they
  never run against a stale build.
- **Messages are checked by hand, from `unknown`.** No schema library yet:
  the parse functions narrow each field themselves, which is the
  TypeScript I am here to learn. An unknown field is ignored; an unknown
  type or a different protocol version is refused.
- **TypeScript at its strictest, and type-aware linting:** `strict` plus
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, and
  typescript-eslint's `strictTypeChecked` (floating promises, unnecessary
  conditions, unsafe `any`). Tests are type-checked too.
- **TypeScript 6.0, not 7.** TypeScript 7 is out, but typescript-eslint
  supports versions below 6.1.
- **Node 24, the current LTS, everywhere** (`.nvmrc`, CI, the image):
  Node 20 is past its end of life, and the 22.9 on this machine is older
  than Vite 8 needs.
- **Node runs as PID 1 and handles SIGTERM itself.** PID 1 gets no default
  signal handling, so without the handler `docker stop` would wait out the
  grace period and SIGKILL it. The smoke test stops the container with a
  client connected and requires a 1001 and exit code 0; with the handler
  removed, it fails. `stop_grace_period: 15s` is set explicitly, because on
  this machine Compose killed containers after about a second.
- **Static files served by hand, narrowly:** `/` and `/assets/<one plain
  file name>`, checked after decoding, so `..`, slashes (encoded or not),
  backslashes and dot files never reach the file system. The server's own
  files sit next to the client in the image; the tests try 14 ways to
  reach them, and the smoke test 5 more against the real image.
- **The client's packages are all devDependencies.** They are bundled into
  `client/dist`, so the image installs only `ws`. Of its 242 MB, about
  3.4 MB is SyncBoard (dependencies, server, client); the rest is the Node
  base image.
- **Not yet:** authentication, boards, and an `Origin` check on the
  WebSocket. Anyone who can reach the port can connect and say hello,
  which is all there is to do so far.

## Failures found while building it

1. **One bad frame would have crashed the server.** When a client sends a
   frame over the size limit, or text that is not UTF-8, `ws` closes that
   connection and reports it as an `error` event on the socket. With no
   listener, Node throws it, and the whole server stops. Found by the
   test for oversized frames, which passed but left an uncaught exception
   behind; the server now logs the error, and tests for both cases check
   that a new client is still answered afterwards. With the listener
   removed, both fail.
