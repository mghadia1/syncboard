import type { Color, ShapeKind } from "@syncboard/shared";

export type Tool = "select" | "hand" | "rectangle" | "ellipse" | "arrow" | "pen" | "note";

export const TOOLS: readonly { tool: Tool; label: string; key: string }[] = [
  { tool: "select", label: "Select", key: "v" },
  { tool: "hand", label: "Pan", key: "h" },
  { tool: "rectangle", label: "Rectangle", key: "r" },
  { tool: "ellipse", label: "Ellipse", key: "o" },
  { tool: "arrow", label: "Arrow", key: "a" },
  { tool: "pen", label: "Pen", key: "p" },
  { tool: "note", label: "Note", key: "n" },
];

/** The shape each drawing tool makes. */
export const KIND: Partial<Record<Tool, ShapeKind>> = {
  rectangle: "rectangle",
  ellipse: "ellipse",
  arrow: "arrow",
  pen: "freehand",
  note: "note",
};

/** What a click without a drag makes, in board units. */
export const DEFAULT_SIZE: Readonly<Record<"rectangle" | "ellipse" | "arrow" | "note", { w: number; h: number }>> = {
  rectangle: { w: 160, h: 100 },
  ellipse: { w: 140, h: 100 },
  arrow: { w: 160, h: 0 },
  note: { w: 200, h: 160 },
};

export const COLOR_NAMES: Readonly<Record<Color, string>> = {
  ink: "Ink",
  gray: "Gray",
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  violet: "Violet",
};

/** A note's paper: the chosen color, except that plain ink makes yellow notes. */
export function notePaper(color: Color, filled: boolean): Color {
  return filled || color !== "ink" ? color : "yellow";
}
