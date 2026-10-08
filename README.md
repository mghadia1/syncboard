# SyncBoard

A collaborative whiteboard. Several people draw on one board at once, see
each other's cursors, keep drawing through a dropped connection, and always
end up looking at the same board.

It deliberately does not use Yjs, Automerge, Liveblocks, Socket.IO,
tldraw, Excalidraw, Konva or Fabric: the point is to build the sync (a CRDT
for the board, and a WebSocket protocol to carry it) and the drawing.

> **Status:** Milestones 0-1 of 7. The board exists as a CRDT in the shared
> package, tested to converge however its operations are ordered,
> repeated or split; the server answers a health check, serves the client
> and greets it over a WebSocket. Nothing uses the board yet: there is no
> drawing (Milestone 2) and no sync over the network (Milestone 3).
>
> TypeScript is the language I am learning on this project (built with
> Claude): it is not on my resume until I can write and explain it unaided.

## Status

| # | Milestone | Status |
|---|-----------|--------|
| 0 | Skeleton: npm workspaces (shared, server, client), strict TypeScript, ESLint, Vitest; a Node server with `/healthz`, graceful shutdown and a typed WebSocket hello; React (Vite, TypeScript) shell served by the server; one-container Compose; CI | Done |
| 1 | The board as a CRDT in `shared`: last-writer-wins properties ordered by (Lamport clock, client id), tombstones, fractional indexes; property tests that any order, duplication or split of the operations converges | Done |
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

## How the board stays the same everywhere

Every browser holds its own copy of the board (a *replica*) and edits it
at once, without asking the server. Copies then exchange their edits, and
must end up identical however the edits travel: late, out of order,
twice, or through someone else. The board is a CRDT (conflict-free
replicated data type) built for that, in `shared/src/board/`:

- **One kind of edit:** an *operation* sets some properties of one shape,
  all with one *stamp*. Creating a shape sets every property; moving it
  sets `x` and `y`; deleting it sets `deleted`.

  ```json
  {"shape": "3f9c2a1b7d4e6f80.12", "stamp": {"counter": 14, "client": "3f9c2a1b7d4e6f80"}, "set": {"x": 120, "y": 40}}
  ```

- **Each property is a last-writer-wins register.** A shape is a map from
  property to (value, stamp), and an arriving value replaces the stored
  one only if its stamp is later. Taking the later of two values does not
  depend on which arrives first, or how often, so copies that have seen
  the same edits hold the same board. Two people can change different
  properties of one shape at once (one moves it, one recolors it) and
  both changes stay.
- **"Later" is a Lamport clock.** Each copy counts its own edits and jumps
  past the counter of every edit it receives, so an edit made after
  seeing another always has a higher counter and wins. Edits made at the
  same time without seeing each other are ordered by client id:
  arbitrarily, but the same everywhere.
- **Deleting keeps a tombstone.** A deleted shape stays, with `deleted`
  set, so a move that arrives after the delete changes a deleted shape
  instead of bringing it back. Undoing a delete is a later `deleted:
  false`.
- **An edit can arrive before its shape:** it is kept and merged when the
  creation comes; a shape is drawn once it has a kind and a box.
- **Stacking order is a fractional index:** each shape holds a key, and
  shapes are drawn in key order (then by id, for two keys chosen at once).
  There is always room for a key between two others, so moving a shape in
  the stack changes only that shape. Keys are base-62 strings that never
  end in "0"; a shape put on top gets the top key with its last digit
  raised, which grows keys by one character every 61 shapes.
- **Whole states merge the same way** (`Replica.merge`), register by
  register: a snapshot of a board can be combined with anything else.

### How it is tested

- **Against a model.** fast-check plays random histories: two to four
  replicas create, edit, delete and restore shapes they know about, and
  receive a random part of each other's operations as they go. The board
  built from all the operations must equal a separately written model
  (for each property, the value of the latest operation that set it), with
  its own ordering code, so a bug in the comparison cannot hide on both
  sides.
- **Order, repeats and splits.** The same operations in a shuffled order
  with some repeated; every replica catching up from wherever it stood;
  and the operations split among up to four replicas whose whole states
  are then merged in any order: all must give the same board.
- **Causality.** In every history, each edit a replica makes is checked to
  be stamped later than everything that replica has seen, and a new shape
  to land on top of everything it draws.
- **The wire.** Every operation a replica makes survives JSON and the
  network checks (`parseOperation`) unchanged; 22 malformed operations are
  refused, each with its reason.
- **Order keys:** any sequence of insertions (on top, at the bottom, at
  either end, between two keys) keeps keys valid, distinct and in order;
  `keyBetween` lands between any two keys, including a key and itself
  followed by zeros.
- **Eleven planted bugs,** one at a time, each make the tests fail: the
  client tie-break dropped, the clock not moved on receiving or on
  merging, equal stamps settled by arrival, the comparison flipped,
  deleted shapes drawn, an edit wiping what was known about its shape, a
  key that does not go up, a missing digit not read as zero, unknown
  properties skipped, new shapes put at the bottom. Two of them passed at
  first (failure 2).

What it does **not** do yet:

- **Concurrent edits of the same property keep one of them.** Two people
  dragging the same shape at once: one position wins. That is the point
  of a register, but for a note's text it means two people typing in the
  same note at once keep only one person's text; merging text character
  by character needs a sequence CRDT, which is not built.
- **Tombstones are never removed.** Doing so safely needs to know every
  replica has seen the delete.
- **A client could send a huge counter** (anything below 2^53 is valid),
  and every clock would jump to it. The server should refuse counters far
  ahead of what it has seen; that belongs with sync (Milestone 3).
- **Order keys are never rebalanced.** A key grows by a character every 61
  shapes put on top or sent to the back, and every 5 or 6 placed between
  the same two neighbours (measured); at 1,024 characters a new key is
  refused rather than sent.

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
| `shared/src/board/replica.ts` | The board as a CRDT: applying operations, merging states, the shapes to draw |
| `shared/src/board/shape.ts` | A shape's properties, and the check for each |
| `shared/src/board/operation.ts` | The operation, and checking one from the network |
| `shared/src/board/stamp.ts` | Stamps, their order, and client ids |
| `shared/src/board/order.ts` | Fractional order keys |
| `shared/src/board/replica.test.ts` | The simulation, the model, and the convergence properties |
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
- **A register per property, not per shape.** Concurrent edits of
  different properties both survive; with a register per shape, a recolor
  would undo a concurrent move.
- **Strings compare with `<`, never `localeCompare`,** whose answer
  depends on the machine's locale: two replicas must never disagree about
  which client id or key comes first.
- **Equal stamps are settled by the value.** Honest replicas never make
  two edits with one stamp, but if one did (a bug, or a forged
  operation), every replica still picks the same value.
- **A new client id every time a page loads,** 64 random bits from
  `crypto.getRandomValues`: a reloaded page has lost its clock, and must
  not repeat stamps it used before. Not `randomUUID`, which browsers offer
  only on HTTPS and localhost.
- **Operations with unknown properties are refused,** not stripped: the
  board could not store them, and a new property is a protocol change.
- **Colors are names** ("ink", "blue"), not hex, so each can have its own
  light and dark rendering.
- **Order keys go on top by raising the last digit,** not by midpoint:
  after 1,000 shapes added on top, keys are 17 characters long instead of
  201 (measured).
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
2. **The convergence tests missed two of eleven planted bugs.** Dropping
   "a missing digit counts as zero" from the key midpoint makes invalid
   keys, but only between the start of the board and a key, or between a
   key and itself followed by zeros ("V" and "V0z"), and no test produced
   those pairs. Putting new shapes just above the bottom shape instead of
   on top looked right: with two shapes the bottom one is also the top,
   and with more, the identical keys this made were broken by shape id in
   creation order. New properties generate those key pairs, and every
   simulated creation must land strictly on top; all eleven now fail.
3. **Sending shapes to the back would have broken sync,** once drawing
   used it (nothing did yet). Measuring key
   growth (to check a comment, which said ten times; it is twelve) showed
   that repeated midpoints toward the start grow a key by a character
   every 6 uses, so about 6,000 "send to back"s would make keys longer
   than the 1,024 every replica accepts: the sender would apply its own
   edit, and everyone else would refuse it. `keyBefore` now mirrors
   `keyAfter`, and no function returns a key over the limit.
4. **A test that could not fail.** An ordering check was written as
   `keys[i - 1] ?? "" < key`, which JavaScript reads as
   `keys[i - 1] ?? ("" < key)`: always truthy. Caught on reading it before
   the first run; it now has parentheses.
