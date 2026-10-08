import { isOrderKey } from "./order.js";

/**
 * What a shape is made of. Every property is replicated on its own (see
 * replica.ts), so two people can change different properties of one shape
 * at once and both changes stay.
 */

export const SHAPE_KINDS = ["rectangle", "ellipse", "arrow", "freehand", "note"] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];

/** Named, not hex: each name gets its own light and dark rendering. */
export const COLORS = ["ink", "gray", "red", "orange", "yellow", "green", "blue", "violet"] as const;
export type Color = (typeof COLORS)[number];

export type ShapeProps = {
  kind: ShapeKind;
  /**
   * The bounding box. For an arrow, (x, y) is the tail and (x + w, y + h)
   * the head, so w and h can be negative; for freehand, `points` are
   * relative to (x, y).
   */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Stacking order: a fractional index (order.ts). */
  z: string;
  stroke: Color;
  fill: Color | "none";
  text: string;
  /** Freehand strokes: x0, y0, x1, y1, ... */
  points: readonly number[];
  /** A tombstone: a deleted shape is kept, so a late edit cannot revive it by accident. */
  deleted: boolean;
};

export type PropName = keyof ShapeProps;

export const MAX_COORDINATE = 10_000_000;
export const MAX_TEXT_LENGTH = 10_000;
export const MAX_POINTS = 20_000; // numbers, so 10,000 points

function isCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;
}

function oneOf<T extends string>(options: readonly T[]) {
  return (value: unknown): value is T =>
    typeof value === "string" && (options as readonly string[]).includes(value);
}

const isColor = oneOf(COLORS);

/**
 * One check per property. The mapped type makes leaving a property out, or
 * checking it for the wrong type, a compile error.
 */
const VALID: { readonly [K in PropName]: (value: unknown) => value is ShapeProps[K] } = {
  kind: oneOf(SHAPE_KINDS),
  x: isCoordinate,
  y: isCoordinate,
  w: isCoordinate,
  h: isCoordinate,
  z: isOrderKey,
  stroke: isColor,
  fill: (value): value is Color | "none" => value === "none" || isColor(value),
  text: (value): value is string => typeof value === "string" && value.length <= MAX_TEXT_LENGTH,
  points: (value): value is readonly number[] =>
    Array.isArray(value) &&
    value.length <= MAX_POINTS &&
    value.length % 2 === 0 &&
    value.every(isCoordinate),
  deleted: (value): value is boolean => typeof value === "boolean",
};

export const PROP_NAMES = Object.keys(VALID) as readonly PropName[];

export function isPropName(name: string): name is PropName {
  return Object.hasOwn(VALID, name);
}

export function isPropValue<K extends PropName>(name: K, value: unknown): value is ShapeProps[K] {
  return VALID[name](value);
}

/** Without these, a shape is not drawn (its creation has not arrived yet). */
export const REQUIRED_PROPS = ["kind", "x", "y", "w", "h", "z"] as const satisfies readonly PropName[];

export const DEFAULTS = {
  stroke: "ink",
  fill: "none",
  text: "",
  points: [],
  deleted: false,
} as const satisfies Partial<ShapeProps>;
