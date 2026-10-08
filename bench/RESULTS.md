# SyncBoard load test: results

One run of `bench/run.ts` on 2026-10-08, results in
[`results/20261008T230836Z/`](results/20261008T230836Z/) (every run, the
environment, and `results.md`, the full table with p99s). Commit f4c46ff,
no uncommitted changes.

**Where:** one MacBook Air M2 with 8 GB, macOS 26.5.2, Docker Desktop 29.2.1
(a Linux VM with 8 CPUs and 3.8 GiB), Node 24.21.0, Redis 8.10.2. The load
generator ran in a container on the servers' Compose network, on the same
machine as the servers. The host had 9,389 of 10,240 MB of swap in use at
the start and at the end. This is a laptop measurement of this design, not a server
benchmark.

**What:** 32 simulated people on one board of 50 shapes, each moving a
random shape (one operation per message) on a fixed schedule: 10, 30, 60 or
120 times a second each, so 320 to 3,840 edits a second offered. One server
(everyone on `a`), or two (people alternating between `a` and `b`, Redis
between them, one data file). Each run: a fresh stack and empty volume,
3 s of warm-up, an 8 s measurement window; latency from when each edit was
due at its sender, to its acknowledgement and to its arrival at each other
person. Two passes, the second in reverse order.

**Validity:** a run with more than 50 MB swapped in by the host during its
window is invalid. 13 of 16 runs are valid; the three invalid ones (82, 161
and 117 MB) were all in pass 1: one and two servers at 960 edits/s, and one
server at 1,920. So those three configurations have one valid run each.
The generator's own lag stayed under 5 ms (p99) in every run.

## Every run converged

In all 16 runs, valid or not (swapping slows a run; it does not make it
agree), every edit was acknowledged, all 32 people ended holding the same
board (within 10 ms of the last acknowledgement), and once everyone had
left, the board each server read back from disk was that same board. That
includes the two-server runs at 3,840 edits a second, where edits crossing
servers took 69 and 112 ms (medians).

## How fast an edit reaches the others (medians)

Medians in ms, one value per valid run (pass 1, pass 2).

| edits/s offered | one server: to others | two servers: same server | two servers: other server |
|---|---|---|---|
| 320 | 2.2, 2.1 | 1.9, 2.1 | 2.3, 2.5 |
| 960 | 2.2 (pass 2 only) | 3.6 (pass 2 only) | 8.4 (pass 2 only) |
| 1,920 | 3.2 (pass 2 only) | 6.1, 6.2 | 27.1, 24.4 |
| 3,840 | 22.0, 22.5 | 3.7, 4.7 | 69.2, 111.5 |

Acknowledgement medians (the sender's edit stored and confirmed): 2.4 and
2.3 ms at 320 on one server, 2.0 and 2.2 on two; at 3,840, 36.1 and
39.3 ms on one server, 14.8 and 22.8 on two.

What this says, for this setup:

- **At 320 edits a second** (32 people each moving something 10 times a
  second) an edit reached the others in about 2 ms (median), and crossing
  to the other server through Redis added a few tenths of a millisecond.
- **A second server made edits between servers slower as the load grew:**
  a median of 24-27 ms at 1,920 edits a second and 69-112 ms at 3,840,
  where on one server the medians were 3.2 and 22 ms.
- **It did split the work of relaying:** at 3,840, people on the same
  server as the sender got edits in 3.7-4.7 ms (median), against 22 ms
  with everyone on one server, and acknowledgements were faster at the
  median. The tails were worse (the acknowledgement p99 reached 1.4 s on
  two servers; see `results.md`).

## Not established

- **Why one server slows down at 3,840 edits a second.** Its CPU, in one
  `docker stats` sample half-way through each window, was 52-59% of a core:
  not simply out of CPU. Each message is its own SQLite transaction with an
  fsync, and `node:sqlite` waits for it synchronously, so time spent in
  fsync is the likely cause; it was not measured. Grouping several
  messages' writes into one commit is the obvious thing to try; not built.
- **Why edits between servers slow down under load.** Both servers write
  one SQLite file, one writer at a time; a server waiting for the other's
  lock is blocked (the wait is synchronous too), and cannot relay what
  Redis brought meanwhile. That is a hypothesis; nothing here tests it.
- **p99s.** They are in `results.md`, and they moved a lot between the two
  passes of one configuration (two servers, 320 edits/s: 7.2 and 38.4 ms
  across servers). Not quoted.
- Whether Docker Desktop's fsync reaches the Mac's disk; anything with more
  than 32 people, presence traffic, or browsers (the people are the sync
  protocol, not the browser app); the same on a real server or a network.

Deliveries: at higher rates, fewer edits reached everyone than were sent
(at 3,840 on one server, 51% and 55% of the "every edit to every other
person" count). That is by design, not loss: a server relays only edits that change
its board, and with 50 shapes moved thousands of times a second, many
edits arrive after a later edit of the same property and are dropped. The
convergence checks above are what show nothing was lost.
