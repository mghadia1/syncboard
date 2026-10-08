import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { type Operation, parseOperation } from "./operation.js";
import { DIGITS, isOrderKey } from "./order.js";
import {
  type BoardState,
  type NewShape,
  Replica,
  type ShapeChange,
  compareShapes,
  serializeState,
} from "./replica.js";
import { COLORS, PROP_NAMES, type PropName, SHAPE_KINDS } from "./shape.js";

const box = { kind: "rectangle", x: 0, y: 0, w: 10, h: 10 } as const;

describe("examples", () => {
  test("create, move, delete and restore, on one replica", () => {
    const a = new Replica("a");
    const id = a.create(box).shape;
    expect(a.shapes()).toMatchObject([{ id, kind: "rectangle", stroke: "ink", fill: "none" }]);
    a.update(id, { x: 5 });
    expect(a.shape(id)?.x).toBe(5);
    a.delete(id);
    expect(a.shapes()).toEqual([]);
    a.restore(id);
    expect(a.shape(id)?.x).toBe(5);
  });

  test("new shapes go on top, each with its own order key", () => {
    const a = new Replica("a");
    const ids = Array.from({ length: 12 }, () => a.create(box).shape);
    expect(a.shapes().map((s) => s.id)).toEqual(ids);
    const keys = a.shapes().map((s) => s.z);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("an edit made after seeing another wins, in whatever order they arrive", () => {
    const a = new Replica("a");
    const b = new Replica("b");
    const create = a.create(box);
    a.update(create.shape, { x: 1 }); // a's own later edits push its clock ahead...
    a.update(create.shape, { x: 2 });
    const moveByA = a.update(create.shape, { x: 3 });
    b.apply(create);
    b.apply(moveByA);
    const moveByB = b.update(create.shape, { x: 99 }); // ...but b has seen a's move
    for (const order of [
      [create, moveByA, moveByB],
      [moveByB, moveByA, create],
      [moveByA, moveByB, create],
    ]) {
      const c = new Replica("c");
      order.forEach((op) => c.apply(op));
      expect(c.shape(create.shape)?.x).toBe(99);
    }
  });

  test("an edit that arrives before the shape's creation is kept", () => {
    const a = new Replica("a");
    const create = a.create(box);
    const recolor = a.update(create.shape, { stroke: "red" });
    const c = new Replica("c");
    c.apply(recolor);
    expect(c.shapes()).toEqual([]); // not drawable yet: no kind, no position
    c.apply(create);
    expect(c.shape(create.shape)?.stroke).toBe("red");
  });

  test("a delete beats a concurrent move: the shape stays deleted", () => {
    const a = new Replica("a");
    const b = new Replica("b");
    const create = a.create(box);
    b.apply(create);
    const del = a.delete(create.shape);
    const move = b.update(create.shape, { x: 50 });
    a.apply(move);
    b.apply(del);
    expect(a.shapes()).toEqual([]);
    expect(b.shapes()).toEqual([]);
    expect(serializeState(a.state)).toBe(serializeState(b.state));
  });

  test("concurrent edits of different properties both stay", () => {
    const a = new Replica("a");
    const b = new Replica("b");
    const create = a.create(box);
    b.apply(create);
    const move = a.update(create.shape, { x: 7 });
    const recolor = b.update(create.shape, { stroke: "blue" });
    a.apply(recolor);
    b.apply(move);
    expect(a.shape(create.shape)).toMatchObject({ x: 7, stroke: "blue" });
    expect(serializeState(a.state)).toBe(serializeState(b.state));
  });

  test("two replicas putting shapes on top at once: same key, ordered by id", () => {
    const a = new Replica("a");
    const b = new Replica("b");
    const fromA = a.create(box);
    const fromB = b.create(box);
    expect(fromA.set.z).toBe(fromB.set.z);
    a.apply(fromB);
    b.apply(fromA);
    expect(a.shapes().map((s) => s.id)).toEqual(b.shapes().map((s) => s.id));
    expect(a.shapes().map((s) => s.id)).toEqual(["a.1", "b.1"]);
  });

  test("forged ops with the same stamp still converge (the larger value wins)", () => {
    const stamp = { counter: 5, client: "x" };
    const one: Operation = { shape: "s", stamp, set: { x: 1 } };
    const two: Operation = { shape: "s", stamp, set: { x: 2 } };
    const a = new Replica("a");
    const b = new Replica("b");
    a.apply(one);
    a.apply(two);
    b.apply(two);
    b.apply(one);
    expect(serializeState(a.state)).toBe(serializeState(b.state));
  });

  test("a replica id must be safe to put in shape ids", () => {
    expect(() => new Replica("a b")).toThrow(RangeError);
    expect(new Replica().client).toMatch(/^[0-9a-f]{16}$/);
  });

  test("an update must change something", () => {
    expect(() => new Replica("a").update("a.1", {})).toThrow(RangeError);
  });
});

// --- The simulation behind the properties -------------------------------

const coordinate = fc.oneof(
  fc.integer({ min: -20, max: 20 }), // small, so equal values are common
  fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }),
);
const color = fc.constantFrom(...COLORS);
const orderKey = fc
  .string({ unit: fc.constantFrom(...Array.from(DIGITS)), minLength: 1, maxLength: 4 })
  .filter(isOrderKey);
const points = fc
  .array(coordinate, { maxLength: 8 })
  .map((xs) => (xs.length % 2 === 0 ? xs : xs.slice(1)));

const newShape: fc.Arbitrary<NewShape> = fc.record(
  {
    kind: fc.constantFrom(...SHAPE_KINDS),
    x: coordinate,
    y: coordinate,
    w: coordinate,
    h: coordinate,
    stroke: color,
    fill: fc.constantFrom("none" as const, ...COLORS),
    text: fc.string({ maxLength: 12 }),
    points,
  },
  { requiredKeys: ["kind", "x", "y", "w", "h"] },
);

const change: fc.Arbitrary<ShapeChange> = fc
  .record(
    {
      x: coordinate,
      y: coordinate,
      w: coordinate,
      h: coordinate,
      z: orderKey,
      stroke: color,
      fill: fc.constantFrom("none" as const, ...COLORS),
      text: fc.string({ maxLength: 12 }),
      points,
    },
    { requiredKeys: [] },
  )
  .filter((c) => Object.keys(c).length > 0);

type Step =
  | { do: "create"; at: number; shape: NewShape }
  | { do: "update"; at: number; pick: number; change: ShapeChange }
  | { do: "delete" | "restore"; at: number; pick: number }
  | { do: "deliver"; at: number; pick: number };

const step: fc.Arbitrary<Step> = fc.oneof(
  { arbitrary: fc.record({ do: fc.constant("create" as const), at: fc.nat(), shape: newShape }), weight: 2 },
  {
    arbitrary: fc.record({ do: fc.constant("update" as const), at: fc.nat(), pick: fc.nat(), change }),
    weight: 3,
  },
  {
    arbitrary: fc.record({
      do: fc.constantFrom("delete" as const, "restore" as const),
      at: fc.nat(),
      pick: fc.nat(),
    }),
    weight: 1,
  },
  { arbitrary: fc.record({ do: fc.constant("deliver" as const), at: fc.nat(), pick: fc.nat() }), weight: 4 },
);

const history = fc.record({
  replicas: fc.integer({ min: 2, max: 4 }),
  steps: fc.array(step, { maxLength: 60 }),
});

/**
 * Plays a history: replicas make edits (only to shapes they know about,
 * as a person could) and receive some of each other's operations. Checks,
 * as it goes, that every local edit is stamped later than everything its
 * replica has seen: the causality the Lamport clock promises.
 */
function play(h: { replicas: number; steps: Step[] }) {
  const replicas = Array.from({ length: h.replicas }, (_, i) => new Replica(`r${String(i)}`));
  const log: Operation[] = [];
  const seen = replicas.map(() => 0); // highest counter each replica has applied
  for (const s of h.steps) {
    const index = s.at % replicas.length;
    const replica = replicas[index];
    if (replica === undefined) {
      continue;
    }
    let op: Operation | undefined;
    if (s.do === "create") {
      op = replica.create(s.shape);
      // On top of everything this replica draws, strictly above the rest.
      const drawn = replica.shapes();
      expect(drawn.at(-1)?.id).toBe(op.shape);
      expect(drawn.filter((shape) => shape.z === op?.set.z)).toHaveLength(1);
    } else if (s.do === "deliver") {
      const delivered = log[s.pick % Math.max(log.length, 1)];
      if (delivered) {
        replica.apply(delivered);
        seen[index] = Math.max(seen[index] ?? 0, delivered.stamp.counter);
      }
      continue;
    } else {
      const known = [...replica.state.keys()];
      const id = known[s.pick % Math.max(known.length, 1)];
      if (id === undefined) {
        continue;
      }
      op =
        s.do === "update"
          ? replica.update(id, s.change)
          : s.do === "delete"
            ? replica.delete(id)
            : replica.restore(id);
    }
    expect(op.stamp.counter).toBeGreaterThan(seen[index] ?? 0);
    seen[index] = op.stamp.counter;
    log.push(op);
  }
  return { replicas, log };
}

/** A deterministic shuffle of `items`, with some repeated, driven by `noise`. */
function scramble<T>(items: readonly T[], noise: readonly number[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = (noise[i % Math.max(noise.length, 1)] ?? 0) % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  for (const n of noise.slice(0, 10)) {
    const repeat = items[n % Math.max(items.length, 1)];
    if (repeat !== undefined) {
      out.splice(n % (out.length + 1), 0, repeat);
    }
  }
  return out;
}

function fresh(ops: readonly Operation[]): Replica {
  const replica = new Replica("observer");
  ops.forEach((op) => replica.apply(op));
  return replica;
}

/**
 * The model: for every shape and property, the value set by the latest of
 * the operations that set it. Written separately from replica.ts (its own
 * ordering, no `wins`), so a bug there cannot hide here.
 */
function model(log: readonly Operation[]): string {
  const latest = new Map<string, { value: unknown; counter: number; client: string }>();
  const later = (a: { counter: number; client: string; value: unknown }, b: typeof a) =>
    a.counter !== b.counter
      ? a.counter > b.counter
      : a.client !== b.client
        ? a.client > b.client
        : JSON.stringify(a.value) > JSON.stringify(b.value);
  for (const op of log) {
    for (const [name, value] of Object.entries(op.set)) {
      const key = JSON.stringify([op.shape, name]);
      const candidate = { value, counter: op.stamp.counter, client: op.stamp.client };
      const current = latest.get(key);
      if (!current || later(candidate, current)) {
        latest.set(key, candidate);
      }
    }
  }
  const ids = [...new Set(log.map((op) => op.shape))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(
    ids.map((id) => [
      id,
      PROP_NAMES.flatMap((name: PropName) => {
        const entry = latest.get(JSON.stringify([id, name]));
        return entry ? [[name, entry.value, entry.counter, entry.client]] : [];
      }),
    ]),
  );
}

const noise = fc.array(fc.nat(), { maxLength: 80 });

describe("properties", () => {
  test("the board is what the model says: each property's latest value", () => {
    fc.assert(
      fc.property(history, (h) => {
        const { log } = play(h);
        expect(serializeState(fresh(log).state)).toBe(model(log));
      }),
      { numRuns: 500 },
    );
  });

  test("any order of the operations, with repeats, gives the same board", () => {
    fc.assert(
      fc.property(history, noise, (h, n) => {
        const { log } = play(h);
        const reference = fresh(log);
        const scrambled = fresh(scramble(log, n));
        expect(serializeState(scrambled.state)).toBe(serializeState(reference.state));
        expect(scrambled.shapes()).toEqual(reference.shapes());
      }),
      { numRuns: 500 },
    );
  });

  test("every replica catches up to the same board, whatever it had already seen", () => {
    fc.assert(
      fc.property(history, noise, (h, n) => {
        const { replicas, log } = play(h);
        const reference = serializeState(fresh(log).state);
        for (const replica of replicas) {
          scramble(log, n).forEach((op) => replica.apply(op));
          expect(serializeState(replica.state)).toBe(reference);
        }
      }),
      { numRuns: 300 },
    );
  });

  test("operations split among replicas, then their states merged in any order: the same board", () => {
    fc.assert(
      fc.property(history, noise, fc.integer({ min: 1, max: 4 }), (h, n, parts) => {
        const { log } = play(h);
        const groups: Operation[][] = Array.from({ length: parts }, () => []);
        log.forEach((op, i) => groups[(n[i % Math.max(n.length, 1)] ?? i) % parts]?.push(op));
        const states: BoardState[] = groups.map((group) => fresh(group).state);
        const merged = new Replica("merged");
        for (const state of scramble(states, n)) {
          merged.merge(state);
        }
        expect(serializeState(merged.state)).toBe(serializeState(fresh(log).state));
        // Merging moved the clock past everything merged.
        const highest = Math.max(0, ...log.map((op) => op.stamp.counter));
        expect(merged.clock).toBeGreaterThanOrEqual(highest);
      }),
      { numRuns: 300 },
    );
  });

  test("shapes are drawn in order, without the deleted or the not yet created", () => {
    fc.assert(
      fc.property(history, (h) => {
        const { log } = play(h);
        const board = fresh(log);
        const shapes = board.shapes();
        expect([...shapes].sort(compareShapes)).toEqual(shapes);
        for (const [id, state] of board.state) {
          const drawn = shapes.some((shape) => shape.id === id);
          const complete = ["kind", "x", "y", "w", "h", "z"].every((name) => name in state);
          expect(drawn).toBe(complete && state.deleted?.value !== true);
        }
      }),
      { numRuns: 300 },
    );
  });

  test("every operation a replica makes survives JSON and the network's checks", () => {
    fc.assert(
      fc.property(history, (h) => {
        for (const op of play(h).log) {
          const parsed = parseOperation(JSON.parse(JSON.stringify(op)));
          expect(parsed.ok).toBe(true);
          if (parsed.ok) {
            expect(JSON.stringify(parsed.message)).toBe(JSON.stringify(op));
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
