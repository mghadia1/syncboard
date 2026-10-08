import type { Parsed } from "../protocol.js";
import { type Operation, type ShapeId, isShapeId } from "./operation.js";
import type { BoardState, Entry, ShapeState } from "./replica.js";
import { PROP_NAMES, type PropName, type ShapeProps, isPropName, isPropValue } from "./shape.js";
import { type Stamp, isStamp } from "./stamp.js";

/**
 * A whole board on the wire: for each shape, every register it has, as
 * [property, value, counter, client]. JSON has no Map, and tuples keep a
 * board of thousands of shapes compact.
 */
export type SnapshotEntry = readonly [PropName, unknown, number, string];
export type Snapshot = readonly (readonly [ShapeId, readonly SnapshotEntry[]])[];

export function toSnapshot(state: BoardState): Snapshot {
  return [...state].map(([id, shape]) => [
    id,
    PROP_NAMES.flatMap((name): SnapshotEntry[] => {
      const entry = shape[name];
      return entry ? [[name, entry.value, entry.stamp.counter, entry.stamp.client]] : [];
    }),
  ]);
}

/** Checks a snapshot from the network: every shape id, property, value and stamp. */
export function parseSnapshot(value: unknown): Parsed<Snapshot> {
  if (!Array.isArray(value)) {
    return { ok: false, error: "a snapshot must be an array" };
  }
  for (const shape of value as unknown[]) {
    if (!Array.isArray(shape) || shape.length !== 2 || !isShapeId(shape[0]) || !Array.isArray(shape[1])) {
      return { ok: false, error: "each shape must be [id, entries]" };
    }
    for (const entry of shape[1] as unknown[]) {
      if (!Array.isArray(entry) || entry.length !== 4) {
        return { ok: false, error: "each entry must be [property, value, counter, client]" };
      }
      const [name, propValue, counter, client] = entry as unknown[];
      if (typeof name !== "string" || !isPropName(name)) {
        return { ok: false, error: `unknown property ${JSON.stringify(name)}` };
      }
      if (!isPropValue(name, propValue)) {
        return { ok: false, error: `bad value for ${name}` };
      }
      if (!isStamp({ counter, client })) {
        return { ok: false, error: "bad stamp" };
      }
    }
  }
  return { ok: true, message: value as Snapshot };
}

// Generic in K, as in replica.ts, so each entry is stored as its own property's.
function put<K extends PropName>(shape: { [P in K]?: Entry<P> }, name: K, entry: Entry<K>): void {
  shape[name] = entry;
}

/** A checked snapshot as a board state. */
export function fromSnapshot(snapshot: Snapshot): Map<ShapeId, ShapeState> {
  const state = new Map<ShapeId, ShapeState>();
  for (const [id, entries] of snapshot) {
    const shape: ShapeState = {};
    for (const [name, value, counter, client] of entries) {
      // parseSnapshot checked each value against its property.
      put(shape, name, { value: value as ShapeProps[typeof name], stamp: { counter, client } });
    }
    state.set(id, shape);
  }
  return state;
}

/**
 * Splits a snapshot into pieces of about `maxBytes` of JSON each (a shape
 * is never split), so a big board can be sent in frames the other side
 * accepts.
 */
export function chunkSnapshot(snapshot: Snapshot, maxBytes: number): Snapshot[] {
  const chunks: (readonly [ShapeId, readonly SnapshotEntry[]])[][] = [];
  let current: (readonly [ShapeId, readonly SnapshotEntry[]])[] = [];
  let size = 0;
  for (const shape of snapshot) {
    const bytes = JSON.stringify(shape).length + 1;
    if (current.length > 0 && size + bytes > maxBytes) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(shape);
    size += bytes;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/**
 * Registers as operations: one per shape and stamp, with every property
 * that stamp set. How a server relays the part of an uploaded board that
 * was new to it.
 */
export function toOperations(entries: Iterable<readonly [ShapeId, PropName, Entry]>): Operation[] {
  const ops = new Map<string, { shape: ShapeId; stamp: Stamp; set: Partial<Record<PropName, unknown>> }>();
  for (const [shape, name, entry] of entries) {
    const key = JSON.stringify([shape, entry.stamp.counter, entry.stamp.client]);
    let op = ops.get(key);
    if (!op) {
      op = { shape, stamp: entry.stamp, set: {} };
      ops.set(key, op);
    }
    op.set[name] = entry.value;
  }
  // Each value came from its own property's register.
  return [...ops.values()] as Operation[];
}

/** The highest counter in a board, or 0. */
export function highestCounter(state: BoardState): number {
  let highest = 0;
  for (const shape of state.values()) {
    for (const name of PROP_NAMES) {
      highest = Math.max(highest, shape[name]?.stamp.counter ?? 0);
    }
  }
  return highest;
}
