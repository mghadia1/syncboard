import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { Replica, serializeState } from "./replica.js";
import { chunkSnapshot, fromSnapshot, highestCounter, parseSnapshot, toSnapshot } from "./snapshot.js";

/** A few replicas' worth of edits, some shared and some not. */
const boards = fc
  .array(
    fc.record({
      who: fc.integer({ min: 0, max: 2 }),
      x: fc.integer({ min: -50, max: 50 }),
      text: fc.string({ maxLength: 30 }),
      action: fc.constantFrom("create", "move", "delete", "share"),
    }),
    { maxLength: 40 },
  )
  .map((steps) => {
    const replicas = [new Replica("a"), new Replica("b"), new Replica("c")];
    for (const step of steps) {
      const replica = replicas[step.who];
      if (!replica) {
        continue;
      }
      const ids = [...replica.state.keys()];
      const id = ids[Math.abs(step.x) % Math.max(ids.length, 1)];
      if (step.action === "create" || id === undefined) {
        replica.create({ kind: "note", x: step.x, y: 0, w: 10, h: 10, text: step.text });
      } else if (step.action === "move") {
        replica.update(id, { x: step.x });
      } else if (step.action === "delete") {
        replica.delete(id);
      } else {
        const other = replicas[(step.who + 1) % 3];
        other?.merge(replica.state);
      }
    }
    return replicas;
  });

describe("snapshots", () => {
  test("a board survives the wire: snapshot, JSON, checks, and back", () => {
    fc.assert(
      fc.property(boards, (replicas) => {
        for (const replica of replicas) {
          const wire = JSON.parse(JSON.stringify(toSnapshot(replica.state))) as unknown;
          const parsed = parseSnapshot(wire);
          expect(parsed.ok).toBe(true);
          if (parsed.ok) {
            expect(serializeState(fromSnapshot(parsed.message))).toBe(serializeState(replica.state));
          }
        }
      }),
    );
  });

  test("chunks hold every shape once, and stay near the size asked for", () => {
    fc.assert(
      fc.property(boards, fc.integer({ min: 50, max: 2000 }), (replicas, maxBytes) => {
        const [replica] = replicas;
        if (!replica) {
          return;
        }
        const snapshot = toSnapshot(replica.state);
        const chunks = chunkSnapshot(snapshot, maxBytes);
        expect(chunks.flat()).toEqual(snapshot);
        for (const chunk of chunks) {
          // Over the limit only when one shape alone is bigger.
          expect(chunk.length === 1 || JSON.stringify(chunk).length <= maxBytes + 2).toBe(true);
        }
      }),
    );
  });

  test("absorb returns exactly what was new, as operations", () => {
    fc.assert(
      fc.property(boards, (replicas) => {
        const [a, b] = replicas;
        if (!a || !b) {
          return;
        }
        const before = new Replica("before");
        before.merge(a.state);
        const changes = a.absorb(b.state);
        // Applying just the changes to a copy of the old state gives the merged state...
        changes.forEach((op) => before.apply(op));
        expect(serializeState(before.state)).toBe(serializeState(a.state));
        // ...and absorbing the same state again changes nothing.
        expect(a.absorb(b.state)).toEqual([]);
      }),
    );
  });

  test("highestCounter", () => {
    const a = new Replica("a");
    expect(highestCounter(a.state)).toBe(0);
    a.create({ kind: "rectangle", x: 0, y: 0, w: 1, h: 1 });
    a.update("a.1", { x: 2 });
    expect(highestCounter(a.state)).toBe(2);
  });

  test.each([
    [{}, "must be an array"],
    [[["s"]], "each shape must be [id, entries]"],
    [[["a b", []]], "each shape must be [id, entries]"],
    [[["s", [["x", 1, 1]]]], "each entry must be"],
    [[["s", [["rotation", 1, 1, "c"]]]], "unknown property"],
    [[["s", [["x", 1, 0, "c"]]]], "bad stamp"],
  ])("refuses %j", (value, error) => {
    const parsed = parseSnapshot(value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain(error);
    }
  });
});
