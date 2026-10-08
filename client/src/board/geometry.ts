import type { Shape } from "@syncboard/shared";

/**
 * Plain geometry, in board units unless a name says screen: where the
 * viewport is, what a point hits, how a box is resized. No React, no DOM,
 * so all of it is tested directly.
 */

export type Point = { readonly x: number; readonly y: number };
export type Box = { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };

/** The board point at the screen's top-left corner, and screen pixels per board unit. */
export type Viewport = { readonly x: number; readonly y: number; readonly zoom: number };

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Two decimals: enough on any screen, and operations stay short. */
export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function toBoard(view: Viewport, screen: Point): Point {
  return { x: view.x + screen.x / view.zoom, y: view.y + screen.y / view.zoom };
}

export function toScreen(view: Viewport, board: Point): Point {
  return { x: (board.x - view.x) * view.zoom, y: (board.y - view.y) * view.zoom };
}

/** Zooms by `factor`, keeping the board point under `anchor` (a screen point) where it is. */
export function zoomAt(view: Viewport, anchor: Point, factor: number): Viewport {
  const zoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  const fixed = toBoard(view, anchor);
  return { zoom, x: fixed.x - anchor.x / zoom, y: fixed.y - anchor.y / zoom };
}

export function boxFrom(a: Point, b: Point): Box {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  };
}

/** A shape's box; an arrow's w and h can be negative, so this normalizes. */
export function bounds(shape: Pick<Shape, "x" | "y" | "w" | "h">): Box {
  return boxFrom({ x: shape.x, y: shape.y }, { x: shape.x + shape.w, y: shape.y + shape.h });
}

export function inside(box: Box, p: Point, pad = 0): boolean {
  return p.x >= box.left - pad && p.x <= box.right + pad && p.y >= box.top - pad && p.y <= box.bottom + pad;
}

export function contains(outer: Box, inner: Box): boolean {
  return (
    inner.left >= outer.left &&
    inner.right <= outer.right &&
    inner.top >= outer.top &&
    inner.bottom <= outer.bottom
  );
}

export function union(boxes: readonly Box[]): Box | undefined {
  if (boxes.length === 0) {
    return undefined;
  }
  return {
    left: Math.min(...boxes.map((b) => b.left)),
    top: Math.min(...boxes.map((b) => b.top)),
    right: Math.max(...boxes.map((b) => b.right)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  };
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / length2, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** A freehand shape's points on the board. */
export function strokePoints(shape: Pick<Shape, "x" | "y" | "points">): Point[] {
  const points: Point[] = [];
  for (let i = 0; i + 1 < shape.points.length; i += 2) {
    points.push({ x: shape.x + (shape.points[i] ?? 0), y: shape.y + (shape.points[i + 1] ?? 0) });
  }
  return points;
}

/** Whether `p` is on the shape, within `tolerance` board units. */
export function hits(shape: Shape, p: Point, tolerance: number): boolean {
  switch (shape.kind) {
    case "rectangle":
    case "note":
      return inside(bounds(shape), p, tolerance);
    case "ellipse": {
      const box = bounds(shape);
      const rx = (box.right - box.left) / 2 + tolerance;
      const ry = (box.bottom - box.top) / 2 + tolerance;
      const cx = (box.left + box.right) / 2;
      const cy = (box.top + box.bottom) / 2;
      return ((p.x - cx) / rx) ** 2 + ((p.y - cy) / ry) ** 2 <= 1;
    }
    case "arrow":
      return (
        distanceToSegment(p, { x: shape.x, y: shape.y }, { x: shape.x + shape.w, y: shape.y + shape.h }) <=
        tolerance
      );
    case "freehand": {
      const points = strokePoints(shape);
      if (points.length === 1 && points[0]) {
        return Math.hypot(p.x - points[0].x, p.y - points[0].y) <= tolerance;
      }
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        if (a && b && distanceToSegment(p, a, b) <= tolerance) {
          return true;
        }
      }
      return false;
    }
  }
}

/** The topmost shape under `p`; `shapes` are bottom first, as drawn. */
export function shapeAt(shapes: readonly Shape[], p: Point, tolerance: number): Shape | undefined {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const shape = shapes[i];
    if (shape && hits(shape, p, tolerance)) {
      return shape;
    }
  }
  return undefined;
}

export type Corner = "nw" | "ne" | "sw" | "se";
export const CORNERS: readonly Corner[] = ["nw", "ne", "sw", "se"];

export function cornerPoint(box: Box, corner: Corner): Point {
  return {
    x: corner.endsWith("w") ? box.left : box.right,
    y: corner.startsWith("n") ? box.top : box.bottom,
  };
}

/**
 * The box with one corner dragged to `to` and the opposite corner fixed.
 * Dragging past the opposite corner flips the box rather than inverting
 * it, and it never gets smaller than `min` on either side.
 */
export function resizeBox(box: Box, corner: Corner, to: Point, min = 1): Box {
  const fixed = cornerPoint(box, opposite(corner));
  const moved = {
    x: Math.abs(to.x - fixed.x) < min ? fixed.x + (to.x < fixed.x ? -min : min) : to.x,
    y: Math.abs(to.y - fixed.y) < min ? fixed.y + (to.y < fixed.y ? -min : min) : to.y,
  };
  return boxFrom(fixed, moved);
}

function opposite(corner: Corner): Corner {
  const flip = { nw: "se", ne: "sw", sw: "ne", se: "nw" } as const;
  return flip[corner];
}

/**
 * A freehand stroke's points scaled from one box to another, relative to
 * the new box's corner. A stroke with no width (or height) keeps its
 * offsets on that axis.
 */
export function scalePoints(points: readonly number[], from: Box, to: Box): number[] {
  const sx = from.right - from.left === 0 ? 1 : (to.right - to.left) / (from.right - from.left);
  const sy = from.bottom - from.top === 0 ? 1 : (to.bottom - to.top) / (from.bottom - from.top);
  return points.map((value, i) => round(value * (i % 2 === 0 ? sx : sy)));
}

/** The two short lines of an arrow's head, as an SVG path, for a line from tail to head. */
export function arrowHead(tail: Point, head: Point, size: number): string {
  const angle = Math.atan2(head.y - tail.y, head.x - tail.x);
  const wing = (offset: number) => ({
    x: head.x - size * Math.cos(angle + offset),
    y: head.y - size * Math.sin(angle + offset),
  });
  const a = wing(Math.PI / 7);
  const b = wing(-Math.PI / 7);
  return `M ${String(a.x)} ${String(a.y)} L ${String(head.x)} ${String(head.y)} L ${String(b.x)} ${String(b.y)}`;
}
