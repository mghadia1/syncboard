import type { Parsed } from "../protocol.js";
import { type PropName, type ShapeProps, isPropName, isPropValue } from "./shape.js";
import { type Stamp, isStamp } from "./stamp.js";

export type ShapeId = string;

/**
 * The only kind of edit: set some properties of one shape, all with one
 * stamp. Creating a shape sets all of them; moving it sets x and y;
 * deleting it sets `deleted`. Applying an operation twice, or operations
 * in any order, gives the same board (replica.ts).
 */
export type Operation = {
  readonly shape: ShapeId;
  readonly stamp: Stamp;
  readonly set: Readonly<Partial<ShapeProps>>;
};

const SHAPE_ID = /^[0-9A-Za-z_.:-]{1,80}$/;

export function isShapeId(value: unknown): value is ShapeId {
  return typeof value === "string" && SHAPE_ID.test(value);
}

/**
 * Checks an operation from the network, which has been parsed from JSON
 * but not trusted. Unlike protocol messages, an unknown property name is
 * refused, not ignored: the board could not store it, and a new property
 * is a protocol change anyway.
 */
export function parseOperation(value: unknown): Parsed<Operation> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "an operation must be an object" };
  }
  const { shape, stamp, set } = value as Record<string, unknown>;
  if (!isShapeId(shape)) {
    return { ok: false, error: "bad shape id" };
  }
  if (!isStamp(stamp)) {
    return { ok: false, error: "bad stamp" };
  }
  if (typeof set !== "object" || set === null || Array.isArray(set)) {
    return { ok: false, error: "set must be an object" };
  }
  const props: Partial<Record<PropName, unknown>> = {};
  for (const [name, propValue] of Object.entries(set)) {
    if (!isPropName(name)) {
      return { ok: false, error: `unknown property ${JSON.stringify(name)}` };
    }
    if (!isPropValue(name, propValue)) {
      return { ok: false, error: `bad value for ${name}` };
    }
    props[name] = propValue;
  }
  if (Object.keys(props).length === 0) {
    return { ok: false, error: "an operation must set something" };
  }
  return {
    ok: true,
    message: {
      shape,
      stamp: { counter: stamp.counter, client: stamp.client },
      // Each value was checked against its own property above.
      set: props as Partial<ShapeProps>,
    },
  };
}
