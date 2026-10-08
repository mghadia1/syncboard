# Explain it yourself

Questions to answer out loud, without notes, before SyncBoard goes near a
resume or an interview. There are no answers here: the explanation has to
be yours. SyncBoard was built with Claude, and it is where I am learning
TypeScript, so the bar is explaining why it is built this way, what went
wrong, and what the TypeScript is doing, not only what the code does.
TypeScript goes on the resume only once the TypeScript section can be
answered unaided.

## Run it first

1. `make up`, open a board in two windows, open the browser's developer
   tools on the WebSocket (Network, WS), and drag a shape in one window.
   Which messages go each way? Why does a drag send one operation per
   pointer move, and why are they gathered into 16 ms frames?
2. Draw, stop the server (`docker compose stop`), keep drawing, then start
   it again. What did the badge say while it was down, what was sent when
   it came back, and how did the browser know which edits to send?
3. `make up-replicas`, and open one board on :8310 and on :8311. Draw in
   both. Then stop Redis (`docker compose -f compose.replicas.yaml stop
   redis`) and draw again. What still reaches the other window, how long
   does it take, and what disappears? Why the difference?
4. `make smoke-replicas`. Pick three of its checks and say what each one
   proves. Which one kills a server, and what has to be true afterwards?

## TypeScript

5. `parseClientMessage` (shared/src/protocol.ts) takes a string and returns
   `Parsed<ClientMessage>`. Why does everything start as `unknown`? Walk
   through the `ops` case: where does TypeScript narrow the type by itself,
   where does the code assert with `as`, and why is each assertion safe at
   that point?
6. `ClientMessage` and `ServerMessage` are unions with a `type` field.
   What is a discriminated union? What does the compiler know inside each
   `case` of `switch (message.type)` in the client's sync engine, and what
   happens at compile time if a new message type is added to the union?
7. With `noUncheckedIndexedAccess`, `people[0]` is `Person | undefined`.
   Find two places where that forced a check (`const [first] = people` in
   bench/load.ts is one) and say what would have gone wrong without it.
8. With `exactOptionalPropertyTypes`, what is the difference between
   `{ presence?: Presence }` and `{ presence?: Presence | undefined }`? Write
   a call to `new Sync(...)` that compiles under one and not the other.
9. `offer` in shared/src/board/replica.ts is generic:
   `offer<K extends PropName>(shape: { [P in K]?: Entry<P> }, name: K,
   entry: Entry<K>)`. Why not just `(shape: ShapeState, name: PropName,
   entry: Entry)`? Try it: what error do you get, and what does the mapped
   type fix?
10. `PERSON_COLORS` is declared `[...] as const satisfies readonly Color[]`.
    What does `as const` do to its type, what does `satisfies` check, and
    why not write `: readonly Color[]` instead?
11. `Room` has `#seq` and also `private readonly store`. What is the
    difference between `#` fields and TypeScript's `private`, at compile
    time and at runtime?
12. Why does server code write `import type { Log } from "./log.js"`: why
    `import type`, and why `.js` in an import inside a `.ts` file?
13. typescript-eslint's `no-floating-promises` is on. Find a `void` in
    server/src/main.ts or app.ts and say what it tells the linter, and what
    bug the rule is there to stop.
14. The server runs on `shared`'s compiled output, but the client and the
    tests import its source (the alias in vitest.config.ts). Why? What
    could go wrong if the tests used the compiled `dist`?

## Design choices (pick one to defend)

15. Why is each property a register of its own, rather than each shape?
    Describe the two concurrent edits that a register per shape gets wrong.
16. Explain the Lamport clock with this board: when does one edit's counter
    beat another's, and when does the client id decide instead? Why is
    that tie-break allowed to be arbitrary?
17. Why are deleted shapes kept as tombstones? What goes wrong if a delete
    removes the shape, and what does keeping them cost?
18. Acknowledgements are a single counter ("everything up to 37"). Why
    does that work for one browser's edits? Why did a server restart with
    an upload break it (failure 10)?
19. What does a board's epoch name? Why is it stored with the board, and
    what does a browser do when it sees a new one?
20. Undo leaves alone what someone else changed since. Why is "is the
    current value still mine?" the wrong test? Play move, they move, move,
    undo, undo.
21. The server stores an edit, with an fsync, before it relays or
    acknowledges it. What does that order promise a browser? What does
    the SIGKILL test prove, and why does it not prove the board survives a
    power cut?
22. Redis pub/sub can lose a message. Server a stores edit number 12 and
    dies before publishing it. Walk through how server b's people still
    get the edit, and how long it can take.
23. With two servers, the store asks `wins` inside its write transaction
    instead of overwriting the register. Give the order of events across
    the two servers that a plain overwrite gets wrong, and say what is lost.
24. Why is a server allowed to run without Redis at all? What does someone
    on the board notice while Redis is down, and why do edits behave
    differently from pointers?

## Failure modes (pick one to tell as a story)

25. One bad frame would have crashed the server (failure 1). Why does an
    `error` event with no listener stop a whole Node process, and how was
    it found?
26. An edit stayed "pending" forever after an upload (failure 10). Why was
    the board still right while the badge was wrong, and how did a
    property test find what fixed tests missed?
27. The first SIGKILL test killed the wrong process (failure 15). What
    does the `tsx` command do that made that happen, and what changed?
28. "database is locked" when two servers started together (failure 17).
    Which statement failed, why did the busy timeout not help there, and
    how was it reproduced before it was fixed?
29. Two tests that "lost" messages tested nothing (failure 19). Why? How do
    you make sure a test that injects a fault really injects it?

## Numbers you should be able to source

30. "At 320 edits a second, an edit reached the others in about 2 ms":
    measured from when to when, on what machine, with how many people and
    shapes? Why only the median?
31. The load test says a second server made edits between servers slower
    under heavy load. What were the numbers, why is the cause "not
    established", and what would you measure to find it?
32. "Every run converged": what exactly was checked at the end of each run?
    Why does a run spoiled by swapping still count for convergence but not
    for latency?
33. "10,322 acknowledged edits survived six kills": what was checked, and
    what was not?
