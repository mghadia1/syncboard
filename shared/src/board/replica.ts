import type { Operation, ShapeId } from "./operation.js";
import { keyAfter, keyBetween } from "./order.js";
import { DEFAULTS, PROP_NAMES, type PropName, type ShapeProps } from "./shape.js";
import { toOperations } from "./snapshot.js";
import { type Stamp, compareStamps, isClientId, newClientId } from "./stamp.js";

/**
 * The board as a CRDT: a map from shape id to a map of last-writer-wins
 * registers, one per property. Each register keeps its value and the stamp
 * of the edit that set it, and an incoming value replaces it only if its
 * stamp is later. That rule is commutative, associative and idempotent, so
 * replicas that have applied the same set of operations, in any order and
 * any number of times, hold the same state.
 */

/** One property's value and the stamp of the edit that set it. */
export type Entry<K extends PropName = PropName> = {
  readonly value: ShapeProps[K];
  readonly stamp: Stamp;
};

/** Everything a replica has heard about one shape, property by property. */
export type ShapeState = { [K in PropName]?: Entry<K> };

export type BoardState = ReadonlyMap<ShapeId, Readonly<ShapeState>>;

/** A shape as it is drawn: every property present, and not deleted. */
export type Shape = Readonly<ShapeProps> & { readonly id: ShapeId };

export type NewShape = Pick<ShapeProps, "kind" | "x" | "y" | "w" | "h"> &
  Partial<Pick<ShapeProps, "stroke" | "fill" | "text" | "points">>;

export type ShapeChange = Partial<Omit<ShapeProps, "kind" | "deleted">>;

/**
 * Whether an incoming value replaces the current one: the later stamp
 * wins. Honest replicas never produce two edits with the same stamp; if
 * one ever did, the larger value (as JSON) wins, so even then every
 * replica picks the same one.
 */
export function wins(
  incoming: { readonly value: unknown; readonly stamp: Stamp },
  current: { readonly value: unknown; readonly stamp: Stamp } | undefined,
): boolean {
  if (current === undefined) {
    return true;
  }
  const order = compareStamps(incoming.stamp, current.stamp);
  if (order !== 0) {
    return order > 0;
  }
  return JSON.stringify(incoming.value) > JSON.stringify(current.value);
}

// Generic in K, so the entry stored is checked against its own property.
// `shape` is typed as a mapped type over K itself: through a plain
// ShapeState, TypeScript requires a write to fit every property at once.
function offer<K extends PropName>(
  shape: { [P in K]?: Entry<P> },
  name: K,
  entry: Entry<K>,
): boolean {
  if (!wins(entry, shape[name])) {
    return false;
  }
  shape[name] = entry;
  return true;
}

function materialize(id: ShapeId, state: Readonly<ShapeState>): Shape | undefined {
  const { kind, x, y, w, h, z } = state;
  if (!kind || !x || !y || !w || !h || !z || state.deleted?.value === true) {
    return undefined;
  }
  return {
    id,
    kind: kind.value,
    x: x.value,
    y: y.value,
    w: w.value,
    h: h.value,
    z: z.value,
    stroke: state.stroke?.value ?? DEFAULTS.stroke,
    fill: state.fill?.value ?? DEFAULTS.fill,
    text: state.text?.value ?? DEFAULTS.text,
    points: state.points?.value ?? DEFAULTS.points,
    deleted: false,
  };
}

/** Drawing order: by order key, then by id when two replicas chose the same key. */
export function compareShapes(a: Shape, b: Shape): number {
  if (a.z !== b.z) {
    return a.z < b.z ? -1 : 1;
  }
  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }
  return 0;
}

/**
 * Every register, in a fixed order, as JSON: two states are equal exactly
 * when their serializations are.
 */
export function serializeState(state: BoardState): string {
  const ids = [...state.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(
    ids.map((id) => {
      const shape = state.get(id) ?? {};
      return [
        id,
        PROP_NAMES.flatMap((name) => {
          const entry = shape[name];
          return entry ? [[name, entry.value, entry.stamp.counter, entry.stamp.client]] : [];
        }),
      ];
    }),
  );
}

/** One copy of the board: what one browser (or the server) holds. */
export class Replica {
  readonly client: string;
  #clock = 0;
  readonly #shapes = new Map<ShapeId, ShapeState>();

  constructor(client: string = newClientId()) {
    if (!isClientId(client)) {
      throw new RangeError(`not a client id: ${JSON.stringify(client)}`);
    }
    this.client = client;
  }

  /** The Lamport clock: the highest counter made here or received. */
  get clock(): number {
    return this.#clock;
  }

  get state(): BoardState {
    return this.#shapes;
  }

  /** The shapes to draw, bottom first. */
  shapes(): Shape[] {
    const shapes: Shape[] = [];
    for (const [id, state] of this.#shapes) {
      const shape = materialize(id, state);
      if (shape) {
        shapes.push(shape);
      }
    }
    return shapes.sort(compareShapes);
  }

  shape(id: ShapeId): Shape | undefined {
    const state = this.#shapes.get(id);
    return state && materialize(id, state);
  }

  /**
   * The current value of each named property of a shape, leaving out the
   * ones this replica has never heard of: what an undo needs to put back.
   */
  values(id: ShapeId, names: Iterable<PropName>): Partial<ShapeProps> {
    const state = this.#shapes.get(id);
    const values: Partial<Record<PropName, unknown>> = {};
    for (const name of names) {
      const entry = state?.[name];
      if (entry) {
        values[name] = entry.value;
      }
    }
    // Each value came from its own property's register.
    return values as Partial<ShapeProps>;
  }

  /**
   * Applies an operation from anywhere, and moves the clock past it, so
   * the next edit made here is later than everything seen so far. Returns
   * whether anything changed.
   */
  apply(op: Operation): boolean {
    this.#clock = Math.max(this.#clock, op.stamp.counter);
    let shape = this.#shapes.get(op.shape);
    if (!shape) {
      // Possibly an edit that arrived before the shape's creation: kept,
      // and merged with the creation when it comes.
      shape = {};
      this.#shapes.set(op.shape, shape);
    }
    let changed = false;
    for (const name of Object.keys(op.set) as PropName[]) {
      const value = op.set[name];
      if (value !== undefined) {
        changed = offer(shape, name, { value, stamp: op.stamp }) || changed;
      }
    }
    return changed;
  }

  /** Merges another replica's whole state into this one (a snapshot). */
  merge(state: BoardState): boolean {
    return this.absorb(state).length > 0;
  }

  /**
   * Merges a whole state, and returns the part that was new here, as
   * operations: what a server relays when someone uploads a board.
   */
  absorb(state: BoardState): Operation[] {
    const changed: [ShapeId, PropName, Entry][] = [];
    for (const [id, other] of state) {
      let shape = this.#shapes.get(id);
      if (!shape) {
        shape = {};
        this.#shapes.set(id, shape);
      }
      for (const name of PROP_NAMES) {
        const entry = other[name];
        if (entry) {
          this.#clock = Math.max(this.#clock, entry.stamp.counter);
          if (offer(shape, name, entry)) {
            changed.push([id, name, entry]);
          }
        }
      }
    }
    return toOperations(changed);
  }

  /** A new shape, on top of every shape drawn here. */
  create(shape: NewShape): Operation {
    const stamp = this.#tick();
    const top = this.shapes().at(-1);
    return this.#local(`${this.client}.${String(stamp.counter)}`, stamp, {
      ...DEFAULTS,
      ...shape,
      z: top ? keyAfter(top.z) : keyBetween(null, null),
      deleted: false,
    });
  }

  update(id: ShapeId, change: ShapeChange): Operation {
    return this.set(id, change);
  }

  delete(id: ShapeId): Operation {
    return this.set(id, { deleted: true });
  }

  restore(id: ShapeId): Operation {
    return this.set(id, { deleted: false });
  }

  /** Any properties at all, with a new stamp: what undo and redo use. */
  set(id: ShapeId, props: Partial<ShapeProps>): Operation {
    if (Object.keys(props).length === 0) {
      throw new RangeError("an update must change something");
    }
    return this.#local(id, this.#tick(), props);
  }

  #tick(): Stamp {
    this.#clock += 1;
    return { counter: this.#clock, client: this.client };
  }

  #local(shape: ShapeId, stamp: Stamp, set: Partial<ShapeProps>): Operation {
    const op: Operation = { shape, stamp, set };
    this.apply(op);
    return op;
  }
}
