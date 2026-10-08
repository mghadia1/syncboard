# SyncBoard

A collaborative whiteboard. Several people draw on one board at once, see
each other's cursors, keep drawing through a dropped connection, and always
end up looking at the same board.

It deliberately does not use Yjs, Automerge, Liveblocks, Socket.IO,
tldraw, Excalidraw, Konva or Fabric: the point is to build the sync (a CRDT
for the board, and a WebSocket protocol to carry it) and the drawing.

> **Status:** Milestones 0-6 of 7. Boards are shared: everyone with a
> board's link draws on it at once (shapes, arrows, freehand, notes;
> select, move, resize, recolor, restack, delete; pan and zoom), sees who
> else is there with their pointers and selections, keeps drawing through
> a dropped connection, and ends up with the same board. Undo reverts only
> your own changes. Boards are stored on disk (SQLite) before anything is
> acknowledged, and survive restarts and SIGKILL (tested); power loss is
> not tested. Two servers can share boards (one data file, Redis pub/sub
> between them), and stay right when Redis loses messages or goes away;
> a load test measures how fast edits reach everyone, and checks that
> everyone ends with the same board.
>
> TypeScript is the language I am learning on this project (built with
> Claude): it is not on my resume until I can write and explain it unaided.

## Status

| # | Milestone | Status |
|---|-----------|--------|
| 0 | Skeleton: npm workspaces (shared, server, client), strict TypeScript, ESLint, Vitest; a Node server with `/healthz`, graceful shutdown and a typed WebSocket hello; React (Vite, TypeScript) shell served by the server; one-container Compose; CI | Done |
| 1 | The board as a CRDT in `shared`: last-writer-wins properties ordered by (Lamport clock, client id), tombstones, fractional indexes; property tests that any order, duplication or split of the operations converges | Done |
| 2 | Drawing, one person: shapes, freehand, sticky notes; select, move, resize, delete; pan and zoom; undo and redo, all through the CRDT | Done |
| 3 | Realtime sync: rooms, a snapshot on joining, operations relayed and acknowledged, reconnection that resends, offline edits merged | Done |
| 4 | Presence (cursors, selections, who is here) and undo of only your own changes | Done |
| 5 | Persistence: boards on disk, stored before anything is acknowledged; restarts keep them; SIGKILL test | Done |
| 6 | Two replicas sharing rooms through Redis pub/sub; load test of propagation latency and convergence | Done |
| 7 | README: diagram, design decisions, failures found, benchmarks; explain-it-yourself prompts | Not started |

## Quickstart

Needs Docker.

```bash
make up        # build and start on :8300; waits until the health check passes
open http://localhost:8300   # a new board: its address (/b/<id>) is its link
# open the same link in a second window, and draw in both
curl localhost:8300/healthz
make down      # the boards stay in a Docker volume; `make reset` deletes them
```

`make smoke` starts a separate stack on :8301, checks it from outside over
HTTP and WebSockets (36 checks, including a restart and a SIGKILL that
lose nothing acknowledged, and a clean stop with a client connected), and
removes it. It needs Node 22 or newer on the host for the
WebSocket checks.

## Sync

A board's link is `/b/<id>`; opening `/` starts a new board. Every browser
on a board holds a replica (see below), edits it at once, and exchanges
edits through the server: JSON text frames on `/ws`, protocol version 3,
typed in `shared/src/protocol.ts` and used by both sides.

```
browser                                        server
hello {board, client}               ───►
                                    ◄───       welcome {epoch, snapshot: the whole board, peers}
state {snapshot}  (a new epoch: see below) ─►  merged; what was new relayed
ops [its own edits]                 ───►       checked, applied, relayed to the others
                                    ◄───       ack {upTo: counter}
                                    ◄───       ops [the others' edits]
presence {name, color, cursor, selection} ─►   relayed as presence {client, ...}
                                    ◄───       left {client}
```

- **Joining** gets the whole board, built by the server's own replica from
  everyone's operations. The snapshot is taken and the browser added to the
  room in one turn of the event loop, so no edit falls between them.
- **Every edit made here stays pending until acknowledged.** The server
  acknowledges by counter ("all your edits up to 37"); a replica's counters
  only go up, so an ack clears a prefix of what is pending. Edits are sent
  in frames gathered over 16 ms (a drag makes one per pointer move), at
  most 500 operations and about 256 KB each.
- **A dropped connection changes nothing about editing.** The badge says
  Offline with how many changes are waiting; the browser reconnects with
  exponential backoff and jitter (0.5 s doubling to 10 s, times 0.5 to 1)
  and resends everything still pending. An edit the server applied whose
  ack was lost arrives twice, which changes nothing (Milestone 1).
- **A server that lost the board** is recognised by its `epoch`, a random
  name for the server's copy of each board, stored with it. After a
  restart the epoch is the same, and browsers resend only what was not
  acknowledged. If the data was lost (a volume deleted), the board gets a
  new epoch, and a browser that sees it uploads everything it knows, in
  frames of about 256 KB; the server merges it and relays what was new to
  the others. So even then, a board comes back as soon as anyone who has
  it open reconnects.
- **What the server refuses,** and the connection it closes: an edit not
  stamped by the sender (each replica sends only its own edits; **4002**),
  a malformed operation (**4002**), a counter above 2^52 (see Decisions;
  **4002**), more boards than it holds or more shapes than a board holds
  (**4003**), a message before hello or a second hello (**1008**), another
  protocol version (**4001**). A batch is checked whole before any of it is
  applied. These are final: the browser shows the reason and does not
  retry, since asking again would get the same answer.
- **Silent connections are cut:** the server pings every 30 s and drops a
  connection that has not answered by the next ping, so 30 to 60 s after
  it went silent (a laptop that slept, a cable pulled).
- Everything received is `unknown` until `parseClientMessage` or
  `parseServerMessage` has checked it, field by field, operations and
  snapshots included. A frame over 1 MiB is closed with **1009**, invalid
  UTF-8 with **1007**, binary with **1008**, and the server carries on. On
  shutdown every client gets **1001** and reconnects.

### How it is tested

- **The protocol, against a real server** with real WebSocket clients:
  relaying and acknowledging, a later joiner's snapshot, separate boards,
  an edit that changes nothing (acknowledged, not relayed again), an
  upload (what was new relayed, the uploader's edits acknowledged), each
  refusal, both limits, and a silent connection cut by the heartbeat.
- **The sync engine** in the browser's code, against a scripted socket:
  batching into frames, acks, offline edits, the exact set resent after a
  reconnect, backoff and its cap, the upload on a new epoch (in chunks),
  and each final refusal.
- **End to end:** the real server, and three real sync clients (the
  browser's code on Node's WebSocket), each behind a TCP proxy that the
  test can **cut** (connections dropped mid-message, as a lost network
  does) and **block** (no connection until healed, a partition). Fixed
  cases: two clients both offline editing one shape; a server restart
  that comes back empty. And a property test: 25 random runs of up to 40
  steps of drawing, moving, recoloring, deleting, undo and redo on three
  clients, mixed with cuts, blocks, heals, pauses and server restarts.
  After every run, the network heals, and every client's board and the
  server's must be identical. It found failure 10.
- **Presence,** against the real server: passed on and never echoed, the
  welcome's list of who is here, `left` announced (and not when a client's
  second connection closes), a malformed presence refused; in the browser
  code, sending at most every 40 ms and again after each welcome, and the
  list of others kept and forgotten offline. End to end, one person's
  pointer and name reach the other, and leaving takes them away.
- **Undo with others editing:** the cases above (theirs kept, an older
  edit of theirs not in the way, the move-move-move case, redo, a merged
  board's edits counted as others' but this replica's own not, a
  cancelled gesture), and two properties over random interleavings of
  my edits, their edits (seen or concurrent), undos and redos: an undo or
  redo never overwrites a value someone else wrote that still stands;
  and with nobody else editing, undoing everything gives back the start.
  End to end, an undo keeps the other person's later move. Five planted
  bugs each fail these tests (failure 12).
- **Eight planted bugs in the sync,** one at a time, each make the tests
  fail, the property test above among them for seven: an ack that drops
  everything pending, a reconnect that does not resend, a new epoch not
  noticed, a welcome's board not merged, no reconnecting, the server not
  relaying edits, or not relaying an upload, or acknowledging a batch
  before checking it. The last passed at first (failure 11).
- **Checked in a real browser:** two tabs on one board, each seeing the
  other's shapes, typing and moves; then the server stopped, an arrow
  drawn offline ("Offline"), the server started again empty, and both
  tabs back with all three shapes; a reload, which starts from nothing,
  got them all from the server's rebuilt copy.

What it does **not** do yet: limit how fast a client may send (presence included: every message is passed to
everyone else on the board), or drop a client too slow to read what it is sent (its frames
queue in the server's memory); shrink what is pending (a drag made offline
resends every intermediate position); send anything but the whole board
on joining.

## Boards on disk

Boards are stored in SQLite (`/data/boards.sqlite` in the container, a
Docker volume), through Node's built-in `node:sqlite`: no native module to
build.

- **A board is stored as its registers:** one row per shape property,
  with its value and the stamp of the edit that set it. That is the
  board's state itself, always complete, so there is no operation log to
  replay on start and nothing to compact. (The roadmap said "an operation
  log and periodic snapshots"; the registers make both unnecessary.)
- **The merge rule is not written in SQL.** The server's replica decides
  which value wins, as every browser's does, and the store writes the
  registers it changed. A second copy in SQL would compare text by UTF-8
  bytes where JavaScript compares UTF-16 code units, and the two could
  disagree.
- **Stored, then acknowledged.** For each batch of edits the server
  applies, commits (WAL journal, `synchronous = FULL`: the commit returns
  after an fsync), and only then passes it on (to the other servers, then
  to its own connections) and acknowledges. An edit the
  server dies before storing was never acknowledged, so its browser still
  has it pending and sends it again.
- **A board is in memory only while someone is on it:** loaded from disk
  on the first join, dropped when the last person leaves. The board
  limit counts boards stored.
- **If storing fails** (a full disk), the server takes no more edits until
  it is restarted: the board's in-memory copy, now ahead of the disk, is
  dropped, edits are refused with close code **1011** (which browsers
  retry: they keep their edits pending), and `/healthz` answers 503 with
  the error. Nothing that was not stored is acknowledged or relayed.
- **A damaged row** stops its board loading with an error, rather than
  being served: rows go through the same checks as edits from the network.

### How it is tested

- **SIGKILL, the server as its own process:** three writers send edits to
  their own shapes as fast as they are acknowledged; the server is killed
  at a random moment, six times over; then every edit ever acknowledged
  must be on disk (its register holds that edit or a later one of the same
  writer). One run: 10,322 acknowledged edits (21,454 registers) survived
  six kills, with 196 edits in flight when the server died. The seed is
  printed, to replay a failure.
- Through the server: a restart keeps the board under the same epoch; a
  board leaves memory when its last member does and comes back from disk;
  the limit counts stored boards; a failing store refuses the edit, never
  acknowledges or relays it, and health says so. The store itself: a
  round trip (emoji, quotes, numbers, a deleted shape), a later save
  replacing a register, a save that fails part-way leaving nothing, a
  damaged row refused, WAL mode on.
- End to end: a restart with the board on disk before anyone is back,
  and a restart with the data deleted, where the browsers' uploads bring
  it back; the random property test now restarts the server both ways.
- The smoke test, on the real image: an acknowledged edit survives a
  `docker compose restart` (same epoch) and a `docker compose kill -s
  SIGKILL`.
- **Three planted bugs** each fail the tests: acknowledging before
  storing (the SIGKILL test catches it, and a deterministic one),
  storing nothing, and a new epoch after every restart.
- In a real browser: a note drawn, the container restarted while no page
  had the board open, and the board, opened fresh, came back from disk.

What it does **not** do: survive a power cut (a SIGKILL leaves the
operating system's page cache intact; nothing here tests losing it, and
Docker Desktop's virtual disk sits between the database and the real
one); back boards up; delete boards; remove deleted shapes (tombstones)
from disk; group the commits of several connections into one fsync (each
batch is its own; the load test suggests this is what slowed one server
down between 1,920 and 3,840 edits a second, but did not measure it).

## Two servers, one board

Several servers can serve the same boards (`compose.replicas.yaml`: servers
`a` on :8310 and `b` on :8311, Redis between them). People on one board may
be on either; each server passes on to the others what it passes on to its
own connections: edits, after storing them; presence; and who has left.

```bash
make up-replicas    # Redis and two servers; open a board's link on either port
make smoke-replicas # 21 checks against a separate stack on :8312/:8313
```

- **One data file, shared.** Both servers use the same SQLite file on one
  Docker volume, so they must run on one machine (SQLite's locking and WAL
  index work between processes on one kernel, not across a network
  filesystem). Spreading servers over machines would need a networked
  database: not built.
- **The disk keeps the winner whoever stores first.** A register is
  replaced only by a later value, compared with the replica's own `wins`
  inside the write transaction (which holds SQLite's write lock, so no
  other server writes in between). A save that would change nothing
  commits nothing.
- **Redis pub/sub is only for speed.** One channel per board. Pub/sub
  delivers a message at most once, to whoever is listening at that moment,
  and a server can die between storing an edit and publishing it, so
  nothing correct depends on it:
  - every write to a board is numbered by the store (`seq`, stored on the
    registers it wrote). A server knows the numbers it has (its own writes,
    and those the bus brought, in any order); every tick (500 ms) it
    compares with the disk, and anything the disk had at the previous tick
    that the bus has still not brought is read from disk: every register
    written since the last number it had. A lost message costs up to two
    ticks, not a wrong board.
  - presence is repeated: each server sends the others who is on its
    boards every 2 s (a roster), and a server not heard from for three
    rosters has its people taken off the board.
- **Without Redis, the servers keep working.** They start without it,
  report it in `/healthz` (`"bus": "disconnected"`), publish nothing (no
  queue builds up), and find each other's edits on disk at the next ticks.
  People on the other server drop out of view until Redis is back: presence
  is not stored, so it travels only on the bus.
- **One epoch per board.** A board is created once, in a transaction that
  also counts boards against the limit, so two servers creating it at the
  same moment agree on its epoch, and the board limit holds across servers.
  (The shape limit is checked by each server against what it has heard, so
  two could together pass it by what is still on its way between them.)
- **The schema is versioned.** Milestone 5's database is upgraded in place
  as a server starts (it gains the change numbers); one from a later
  version is refused, not changed.

### How it is tested

- **Two servers in one process,** sharing a data directory, connected by a
  `LocalNetwork` that can lose, delay and hold back messages and cut a
  server off: an edit reaches the other server's people by the bus (stored
  once, one epoch); a lost message is read from disk at the next ticks,
  also when later messages did arrive; with no bus at all the servers still
  agree; messages out of order need no reading from disk; both servers
  editing one property at once end with the same winner on both, for
  their people and on disk; presence and leaving cross servers; a client on
  the board through both servers at once is not reported gone when one
  connection closes; a server cut off from the bus has its people taken off
  after three missed rosters, and they come back with it.
- **End to end:** four browser sync clients on two servers, behind links
  that cut and block, and a bus that loses one message in N, delays, and
  cuts a server off, while servers restart: a property test (fast-check, 20
  random runs) requires every client, both servers and the disk to end
  with the same board.
- **Against a real Redis** (`make test-redis`: Redis 8 in a throwaway
  container): a message reaches the servers that joined the board and only
  those; after Redis kills the subscription, the bus reconnects and
  subscribes again by itself; two servers' edit crosses by Redis, not the
  disk; and a server whose Redis is not there starts, serves, and drops
  what it would publish.
- **The store:** the later value kept whichever server stores first; a
  save with nothing new uses no number; numbering and "changes since";
  creating a board two servers make at once; a Milestone 5 database
  upgraded; and four processes opening one new database at the same
  moment.
- **Nine planted bugs** each fail the tests: bus edits marked as had but
  not applied; never reading from disk; storing over a later value;
  dropping messages that come out of order; a later number skipping a
  missing one; "left" passed on while the person is still on another
  server; quiet servers never expiring; reading from disk one change late;
  and an updated register keeping its old number.
- **The smoke test** on the real images: both servers on the bus and on
  one file; edits crossing within 250 ms both ways; presence and leaving
  across; Redis stopped (both still healthy, edits crossing from disk
  within 2 s) and started again; a server restarted, and one SIGKILLed,
  losing nothing acknowledged; both stopping cleanly.
- **In a real browser:** a tab on each server, one board. A rectangle drawn
  on a reached b, a note drawn on b reached a, with each person's pointer
  and selection; with Redis stopped, an ellipse drawn on a still reached b
  (from disk) while the other person dropped out of view, and came back
  when Redis did.

### Load test

`make bench` (`bench/run.ts`, with the generator `bench/load.ts`): 32
simulated people on one board of 50 shapes, each moving a random shape on a
fixed schedule (open loop, latency measured from when each edit was due),
on one server or split over two; at the end, every edit must be
acknowledged, everyone must hold the same board, and the board each server
reads back from disk must be that board. Two passes, the second in reverse
order; a run is invalid if the host swapped in more than 50 MB during its
8-second window. Full results, method and caveats:
[`bench/RESULTS.md`](bench/RESULTS.md).

Measured on one 8 GB MacBook Air M2 under Docker Desktop, the load
generator in a container on the same machine; a laptop measurement, not a
server benchmark. 13 of 16 runs valid.

- **Every run converged** (all 16, from 320 to 3,840 edits a second):
  every edit acknowledged, all 32 people on the same board, and the board
  on disk the same on both servers.
- **At 320 edits a second** (32 people moving something 10 times a second
  each), an edit reached the others in about 2 ms, median (2.1-2.2 ms on
  one server; 2.3-2.5 ms crossing to the other server through Redis).
- **A second server made edits between servers slower under load:** a
  median of 24-27 ms at 1,920 edits a second and 69-112 ms at 3,840,
  against 3.2 and 22 ms with everyone on one server. Why is not
  established (see `bench/RESULTS.md`): both servers write one SQLite file,
  one at a time, and each waits for its writes synchronously.

## Who else is here

- **People:** the masthead shows you (click to rename) and up to five
  others, by initials in their colors; a screen reader hears how many
  others are here. Your name is generated the first time ("Teal Otter")
  and kept in this browser; its color follows from the name, so a name
  looks the same to everyone. There are no accounts.
- **Pointers and selections:** everyone else's pointer, with their name,
  and an outline around what they have selected, in their color. Both are
  in board coordinates, so they land on the same shape whatever each
  viewer's pan and zoom.
- **Presence is not the board.** It is not a CRDT, not stored and not
  acknowledged: the server passes it on and forgets it when a connection
  closes, announcing `left`. A browser sends its own at most every 40 ms
  (a pointer moves 60 to 120 times a second; the latest wins) and again
  after every welcome; offline, it forgets the others, since it cannot
  know who is there.
- A browser can briefly have two connections (a reconnect before the old
  one is noticed gone); others see it once, and its old connection closing
  is not announced as leaving.
- **Colors for people** are the four markers that keep a name tag's text
  at 4.5:1 or better in both themes (red, green, blue, violet); orange
  (3.7:1) and yellow (3.1:1) do not, under white text in the light theme.

## Drawing

The board fills the window; the marker tray along the bottom holds the
tools, the colors (each drawn as a marker cap; the chosen one is lifted),
Fill, Undo and Redo, and, with something selected, Bring to front, Send
to back and Delete.

| Key | Does |
|-----|------|
| V, H | Select; pan |
| R, O, A, P, N | Rectangle, ellipse, arrow, pen, note: drag to draw, or click for a default size |
| Space (held), middle button | Pan, with any tool |
| Wheel, trackpad scroll | Pan |
| Ctrl/Cmd + wheel | Zoom around the pointer (10% to 800%); + and - zoom around the centre |
| Click, Shift+click, drag on empty board | Select one; add or remove one; select what the drag encloses |
| Drag a shape, a corner, an arrow's end | Move; resize; move that end |
| Arrows (Shift: by 10) | Nudge the selection |
| ] and [ | Bring to front; send to back |
| Delete or Backspace, Escape, Ctrl/Cmd+A | Delete; clear the selection; select all |
| Enter or double-click on a note | Edit its text (Escape or Ctrl/Cmd+Enter to finish); the note grows to fit |
| Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z or Ctrl+Y | Undo; redo |

- **Every change is an operation on the replica,** sent to everyone else
  on the board (see Sync): a drag sends one per pointer move, a note one
  per keystroke, so others see shapes move and text typed as it happens.
- **Undo makes new edits.** It sets the changed properties back to the
  values they had, with new stamps; it rewinds nothing. A gesture (a
  drag, a resize, a typing session) is one undo step however many
  operations it made, and cancelling one (Escape, a lost pointer) puts
  things back without leaving a step.
- **Undo reverts only your own changes.** For each property a step
  changed, the editor keeps the stamp of the edit that last wrote it; for
  each property on the board, the newest edit by anyone else. Undo (and
  redo, and cancelling a gesture) leaves a property someone else has
  written since, and says so: "Could not undo Move shape: someone else
  has changed it since", or "Undid Edit, except what someone else has
  changed since", out loud and in a notice on screen. The rule is per
  property: undoing a shape's creation deletes it even if someone else
  has moved it.
- **"Is the current value still mine?" is not the test,** and the
  difference is real: move a shape, someone else moves it, move it
  again, and undo twice. The second undo finds a value of its own (the
  first undo's) and would wipe the other person's move. Comparing stamps
  with the newest edit by anyone else does not; a test plays exactly this.
- **A click is not an edit.** Gestures that change shapes start only after
  the pointer moves 4 pixels, so selecting a shape sends nothing and
  leaves nothing to undo.
- A shape being drawn, or a pen stroke, is a preview until the pointer
  is released, and then one operation: others will see strokes appear
  whole, not as they are drawn.

What it does **not** do yet: rotate, copy and paste, text in shapes other
than notes, resize several shapes at once, pinch-zoom on a touch screen,
or let a screen reader explore the shapes (it hears how many there are,
and what each action did). It uses pointer events, which cover touch and
pens as well as mice, but only a mouse and a trackpad have been tried; a
trackpad pinch was not tested.

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
- **Order keys are never rebalanced.** A key grows by a character every 61
  shapes put on top or sent to the back, and every 5 or 6 placed between
  the same two neighbours (measured); at 1,024 characters a new key is
  refused rather than sent.

## HTTP

| Path | Answer |
|------|--------|
| `GET /healthz` | `{"status": "ok", "version": "0.1.0", "bus": "off"}`; `bus` is `connected` or `disconnected` for a server sharing boards through Redis (reported, not required); 503 with the error if boards cannot be stored |
| `GET /`, `GET /b/<id>` | the client's `index.html`, `Cache-Control: no-cache`; a malformed board id is a 404 |
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
make test-redis  # the bus tests against a real Redis, in a throwaway container
make bench       # the load test (bench/run.ts): about 10 minutes, in Docker
```

Settings, all optional: `SYNCBOARD_PORT`, `SYNCBOARD_DATA_DIR`,
`SYNCBOARD_MAX_BOARDS`, `SYNCBOARD_MAX_SHAPES`, `SYNCBOARD_REDIS_URL`
(`redis://host:port`, for servers sharing boards), `SYNCBOARD_POLL_MS`
(500, how often a room checks the disk) and `SYNCBOARD_ROSTER_MS` (2000).

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
| `client/src/App.tsx` | The page: the masthead, the sync status, the whiteboard |
| `client/src/sync/sync.ts` | The sync engine: pending edits, acks, reconnecting, uploading a lost board |
| `client/src/sync/where.ts` | The board from the page's address; the WebSocket's URL |
| `client/src/sync/identity.ts` | Your name (kept in this browser) and its color |
| `client/src/People.tsx`, `client/src/canvas/Peers.tsx` | Who is here; others' pointers and selections |
| `shared/src/presence.ts` | Presence: its type and its check |
| `server/src/sync.ts` | One connection's protocol: hello, checks, apply, relay, ack |
| `server/src/rooms.ts` | The boards being served: one room and one replica each, loaded from and written to the store, kept in step with other servers; limits |
| `server/src/store.ts` | Boards on disk (SQLite): their registers, epochs and change numbers; the schema's upgrade |
| `server/src/bus.ts` | What servers tell each other, checked on arrival; the in-process LocalNetwork tests use |
| `server/src/redis-bus.ts` | The bus over Redis pub/sub |
| `server/src/replicas.test.ts` | Two servers, one board: lost, reordered and missing messages; presence across them |
| `server/src/redis-bus.test.ts` | The bus against a real Redis (`make test-redis`) |
| `e2e/replicas.test.ts` | Four sync clients on two servers, a failing bus, restarts: the property test |
| `compose.replicas.yaml`, `scripts/smoke-replicas.sh` | Two servers and Redis, and their smoke test |
| `bench/load.ts`, `bench/run.ts` | The load generator, and the benchmark around it |
| `server/src/store.test.ts` | The store: round trip, replacing, all-or-nothing saves, damaged rows |
| `e2e/crash.test.ts` | The server as its own process, SIGKILLed six times while edits pour in |
| `shared/src/board/snapshot.ts` | A whole board on the wire; chunking it; merging one |
| `e2e/sync.test.ts`, `e2e/link.ts` | The server and three sync clients behind proxies that cut and block |
| `client/src/board/editor.ts` | The board as the page edits it: the replica, undo and redo, gestures grouped into steps |
| `client/src/board/geometry.ts` | Viewport, hit testing, resizing: plain functions |
| `client/src/canvas/Whiteboard.tsx` | Tool, color, selection, viewport, keyboard shortcuts |
| `client/src/canvas/Board.tsx` | The SVG board and every pointer gesture |
| `client/src/canvas/ShapeView.tsx`, `NoteEditor.tsx`, `Toolbar.tsx` | Drawing a shape; typing in a note; the marker tray |
| `server/src/app.test.ts` | HTTP, path traversal, frames, shutdown |
| `server/src/sync.test.ts` | The protocol with several real clients: relay, acks, uploads, refusals, limits, heartbeat |
| `client/src/sync/sync.test.ts` | The sync engine against a scripted socket |
| `client/src/App.test.tsx` | The page against a scripted socket: status, edits sent and received, Copy link |
| `client/src/canvas/Whiteboard.test.tsx` | Drawing, selecting, editing, undo, pan and zoom, through pointer and key events |
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
- **SVG, not a canvas element.** React draws each shape as an element,
  which is simple and fast enough for hundreds of shapes; a canvas would
  win for many thousands. Hit testing is done by plain functions
  (`geometry.ts`) rather than the browser, so it is tested without one.
- **The editor is not React.** `Editor` (replica, undo, redo) is a plain
  class the page subscribes to with `useSyncExternalStore`; it is tested
  directly, and Milestone 3 can feed it remote operations the same way.
- **Two typefaces, bundled:** Atkinson Hyperlegible Next for the interface
  and Shantell Sans for notes and the name, so a self-hosted board makes
  no requests to a font service.
- **Acks by counter, not by message.** A replica's own counters only go
  up, so "everything up to 37" acknowledges any number of edits in one
  number, and clears a prefix of what is pending.
- **The server relays only what changed it.** An edit that loses to one
  already applied is acknowledged and dropped: everyone in the room was
  sent the newer one first.
- **A lost board is re-uploaded, recognised by its epoch.** Without that,
  after a restart, people already on a board would keep seeing it while
  anyone joining saw an empty one. The upload carries other people's
  stamps too, so the server checks it but cannot hold it to "your edits
  only": a client could forge another's edits this way. Without
  accounts, nothing stops it from editing anything under its own name
  anyway.
- **Counters are capped at 2^52, for everyone.** A client sending 2^53 - 1
  would push every clock to the end of the integers a double holds
  exactly. With the cap, a clock pushed all the way up still has 2^52
  edits to go. (See failure 9 for why not "so far ahead of the board".)
- **Refusals are final in the browser;** dropped connections are not. A
  refused edit would be refused again, and retrying forever would hammer
  the server.
- **Board ids are 12 random base-62 characters** (71 bits): the link is
  the only key to a board, so it must not be guessable.
- **Servers share boards through the disk first, Redis second.** The bus
  makes an edit reach the other server's people in milliseconds; the
  numbered writes make it reach them at all. The alternative, a log on
  Redis Streams that servers read from where they left off, would have
  made Redis part of keeping the board correct; here it can go away and
  the boards stay right.
- **Every server hears every board it has loaded, not every board.** One
  pub/sub channel per board, joined when the board is loaded and left
  when it is dropped. Joining is not instant: what is published before the
  subscription takes is found on disk at the next ticks.
- **One Redis connection to publish on, one to listen on:** a subscribed
  Redis connection can do nothing else. The publisher does not queue while
  disconnected (`disableOfflineQueue`): a publish then is dropped and
  counted, rather than kept in memory for as long as Redis is gone.
- **A room checks the disk every 500 ms,** one indexed read of one row
  per loaded board; a missing change is read from disk only if it is
  still missing at the next tick, so messages that are merely late (or
  out of order: two servers publish independently) cost nothing.
- **The merge rule stays in TypeScript, on the disk too.** Two servers'
  writes to one register must keep the later one; the store reads the
  register inside its write transaction and asks the replica's `wins`,
  rather than putting a second copy of the rule in SQL.
- **Not yet:** accounts, permissions, and an `Origin` check on the
  WebSocket. Anyone with a board's link can draw on it; anyone who can
  reach the port can make boards, up to the limit (1,000 boards of 20,000
  shapes, set by `SYNCBOARD_MAX_BOARDS` and `SYNCBOARD_MAX_SHAPES`).

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
5. **A click was an edit.** Pressing on a shape started a move that sent
   an update even if the pointer never moved, so every click to select
   something left a "Move shape" in the undo history (and, with sync,
   would have been sent to everyone). Found while working out why a test
   failed; gestures now wait for 4 pixels of movement.
6. **Grabbing a handle off-centre resized the shape.** A corner handle
   answers within 9 pixels, and the corner jumped to the pointer, so a
   press and release a few pixels off changed the size. The grabbed point
   now keeps its offset from the pointer. Each of these two has a test
   that fails without its fix.
7. **Notes cut their text off.** In the browser, text longer than a small
   note was hidden mid-word, with nothing to say so (jsdom does no layout,
   so the tests could not see it). The note now grows to fit as it is
   typed in, and the text box is laid out exactly like the note (an
   outline instead of a border), so the text wraps the same while editing
   and after.
8. **The README promised what the code did not do.** Checking it line by
   line against the code before committing: "Escape cancels a gesture"
   was untrue (Escape only cleared the selection), and "pinch zooms" and
   "touch can draw" had never been tried. Escape now cancels a drag, with
   a test that fails without it; the other two claims were taken out.
9. **The first counter limit would have locked busy boards out.** It was
   written as "no more than a million ahead of the board's highest
   counter". But after a restart the server's copy starts from nothing, and
   a busy board passes a million edits (every pointer move of a drag is
   one), so its users' uploads would have been refused: the board could
   never come back. Caught while writing the upload, before it ran; the
   limit is now an absolute 2^52, the same for every replica.
10. **An upload left an edit pending forever.** The end-to-end property
    test timed out in 3 of 5 sessions; run without shrinking, it showed a
    client online with one change pending that was never acknowledged.
    After a server restart, a browser uploads its board, and the server
    acknowledges up to the highest counter of that browser's in the upload;
    but an upload holds only each property's winning value, so an edit of
    this browser's that someone else had since overwritten was not in it,
    and the engine had counted it as sent. The board was still right (that
    edit had lost), but the badge would have said "sending 1 change" for
    good. Pending edits are now sent after an upload as usual; a unit test
    replays the case and fails without the fix, and 20 sessions (500
    random runs) passed after it.
11. **A refused batch could have looked delivered.** Planting "acknowledge
    a batch before checking it" passed every test: nothing checked that
    a refusal comes alone. The browser would have dropped refused edits as
    if the server had them. Every refusal test now requires the error to
    be the only answer.
12. **One of five planted undo bugs passed.** Counting this replica's own
    edits as someone else's was not caught: the test merged back a board
    holding only edits with the same stamps as the steps, and an equal
    stamp never blocks an undo. It matters after a reconnect, when the
    server's board holds a later edit of yours than the step being undone.
    A test now plays that; all five fail it. (Two other new tests were
    wrong at first, and taught something: an edit "older" than mine had
    the same counter, and an equal counter goes to the higher client id,
    so it was the newer one.)
13. **Two people colors were unreadable.** Name tags put white text on a
    person's marker color in the light theme; computed, orange came to
    3.7:1 and yellow to 3.1:1, under the 4.5:1 that small text needs.
    People now get only red, green, blue and violet (4.9:1 and better in
    both themes).
14. **Renaming yourself added to the old name.** Tried in the browser:
    the name field opened with the cursor after the old name, so typing
    made "Amber KoalaSecond Tab". It now opens with the name selected;
    a test checks the selection.
15. **The first SIGKILL test killed the wrong process.** It started the
    server with the `tsx` command, which runs the script in a child process
    of its own: the SIGKILL hit the wrapper, the server lived on, and the
    test hung with seven servers left running (stopped by hand). The test
    now starts Node itself with tsx as a loader, so the process killed is
    the server, and nothing is left behind.
16. **A store test failed for a reason the type checker knew.** It passed
    a whole operation where a shape id belonged (`Replica.create` returns
    the operation); SQLite refused to store an object, which is how it
    showed. I had run the tests on their own; `npm run check` runs the
    type checker first, which names the real error.
17. **Two servers starting together: one died, "database is locked".**
    The benchmark's first two-server stack, on a new volume, lost server
    `a` at once. Switching a new file to WAL takes a lock, and SQLite
    answers "locked" there at once, whatever the busy timeout. A test now
    starts four processes opening one new database at the same moment
    (before the fix: failed 3 runs of 3; 3 of 32 processes in a count by
    hand); the switch is retried for up to 5 s, and 40 openings since have
    all succeeded.
18. **Two Compose services built one image name at once,** and one build
    failed ("image already exists") in 2 of the first 4 smoke runs that
    had to build it. The first failure was hidden by my own output filter
    and only showed up again on a deliberate rerun from no image. Each
    server now builds its own image name (the second from the build
    cache); 3 runs from no image passed since.
19. **Two tests lost the wrong copy of a message.** A server that publishes
    a message also gets its own copy back (and ignores it). "Lose the
    first message" lost that copy, so the other server got everything and
    the test checked nothing; it passed only while timing hid it, then
    failed 7 times in 10. The end-to-end test's "lose one message in two"
    had the same flaw: with two copies per message, it lost only the
    sender's own. Both now lose only copies on their way to the other
    server; the planted bug "a later number skips a missing one" is now
    caught by three tests instead of two.
20. **The load generator looked 10 ms behind while idle.** Node's
    event-loop delay histogram includes its own sampling interval (10 ms),
    which the first exploratory run reported as lag: a 20 ms validity
    limit would have meant little. Checked against an idle process (median
    11 ms); the generator now reports the delay past the interval.
