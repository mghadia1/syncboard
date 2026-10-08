import { type ShapeId, isShapeId } from "./board/operation.js";
import { COLORS, type Color, MAX_COORDINATE } from "./board/shape.js";
import type { Parsed } from "./protocol.js";

/**
 * Who is on a board, and what they are doing: a name and a color, where
 * their pointer is (in board coordinates, so it lands on the same spot of
 * the board whatever each viewer's pan and zoom), and what they have
 * selected. Presence is not part of the board: it is not a CRDT, not
 * stored, and not acknowledged; the server only passes it on, and forgets
 * it when the connection closes.
 */
export type Presence = {
  readonly name: string;
  readonly color: Color;
  readonly cursor: { readonly x: number; readonly y: number } | null;
  readonly selection: readonly ShapeId[];
};

export const MAX_NAME_LENGTH = 40;
export const MAX_SELECTION = 200;

/**
 * Colors for people: the markers whose name tags keep text readable (4.5:1
 * or better) in both themes. Orange (3.7:1) and yellow (3.1:1) do not, under
 * white text in the light theme.
 */
export const PERSON_COLORS = ["red", "green", "blue", "violet"] as const satisfies readonly Color[];

function isCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;
}

export function parsePresence(value: unknown): Parsed<Presence> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "presence must be an object" };
  }
  const { name, color, cursor, selection } = value as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "" || name.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `a name is 1 to ${String(MAX_NAME_LENGTH)} characters` };
  }
  if (typeof color !== "string" || !(COLORS as readonly string[]).includes(color)) {
    return { ok: false, error: "an unknown color" };
  }
  let point: Presence["cursor"] = null;
  if (cursor !== null) {
    const { x, y } = (typeof cursor === "object" ? cursor : {}) as Record<string, unknown>;
    if (!isCoordinate(x) || !isCoordinate(y)) {
      return { ok: false, error: "a cursor is null or {x, y} on the board" };
    }
    point = { x, y };
  }
  if (!Array.isArray(selection) || selection.length > MAX_SELECTION || !selection.every(isShapeId)) {
    return { ok: false, error: `a selection is at most ${String(MAX_SELECTION)} shape ids` };
  }
  return {
    ok: true,
    message: { name: name.trim(), color: color as Color, cursor: point, selection },
  };
}
