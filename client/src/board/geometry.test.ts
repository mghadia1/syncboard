import type { Shape } from "@syncboard/shared";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  boxFrom,
  contains,
  distanceToSegment,
  hits,
  resizeBox,
  scalePoints,
  shapeAt,
  toBoard,
  toScreen,
  zoomAt,
} from "./geometry";

function shape(props: Partial<Shape>): Shape {
  return {
    id: "s",
    kind: "rectangle",
    x: 0,
    y: 0,
    w: 100,
    h: 50,
    z: "V",
    stroke: "ink",
    fill: "none",
    text: "",
    points: [],
    deleted: false,
    ...props,
  };
}

describe("the viewport", () => {
  const coordinate = fc.double({ min: -1e5, max: 1e5, noNaN: true });
  const view = fc.record({ x: coordinate, y: coordinate, zoom: fc.double({ min: MIN_ZOOM, max: MAX_ZOOM, noNaN: true }) });
  const point = fc.record({ x: coordinate, y: coordinate });

  test("screen and board coordinates convert back and forth", () => {
    fc.assert(
      fc.property(view, point, (v, p) => {
        const back = toScreen(v, toBoard(v, p));
        expect(back.x).toBeCloseTo(p.x, 5);
        expect(back.y).toBeCloseTo(p.y, 5);
      }),
    );
  });

  test("zooming keeps the point under the pointer where it is, within the limits", () => {
    fc.assert(
      fc.property(view, point, fc.double({ min: 0.01, max: 100, noNaN: true }), (v, anchor, factor) => {
        const zoomed = zoomAt(v, anchor, factor);
        expect(zoomed.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
        expect(zoomed.zoom).toBeLessThanOrEqual(MAX_ZOOM);
        const before = toBoard(v, anchor);
        const after = toBoard(zoomed, anchor);
        expect(after.x).toBeCloseTo(before.x, 4);
        expect(after.y).toBeCloseTo(before.y, 4);
      }),
    );
  });
});

describe("hit testing", () => {
  test("a rectangle or note is hit anywhere inside, plus the tolerance", () => {
    const box = shape({ kind: "note" });
    expect(hits(box, { x: 50, y: 25 }, 0)).toBe(true);
    expect(hits(box, { x: 104, y: 25 }, 5)).toBe(true);
    expect(hits(box, { x: 106, y: 25 }, 5)).toBe(false);
  });

  test("an ellipse is not hit in its box's corners", () => {
    const ellipse = shape({ kind: "ellipse" });
    expect(hits(ellipse, { x: 50, y: 25 }, 0)).toBe(true);
    expect(hits(ellipse, { x: 2, y: 2 }, 0)).toBe(false);
  });

  test("an arrow is hit near its line, whichever way it points", () => {
    const arrow = shape({ kind: "arrow", x: 100, y: 100, w: -100, h: -100 });
    expect(hits(arrow, { x: 50, y: 52 }, 4)).toBe(true);
    expect(hits(arrow, { x: 80, y: 20 }, 4)).toBe(false);
  });

  test("a freehand stroke is hit near its points, not across its box", () => {
    const stroke = shape({ kind: "freehand", x: 10, y: 10, w: 100, h: 100, points: [0, 0, 100, 0, 100, 100] });
    expect(hits(stroke, { x: 60, y: 12 }, 4)).toBe(true);
    expect(hits(stroke, { x: 30, y: 80 }, 4)).toBe(false);
    expect(hits(shape({ kind: "freehand", x: 5, y: 5, w: 0, h: 0, points: [0, 0] }), { x: 6, y: 6 }, 2)).toBe(true);
  });

  test("the topmost shape wins", () => {
    const bottom = shape({ id: "bottom" });
    const top = shape({ id: "top", x: 50 });
    expect(shapeAt([bottom, top], { x: 60, y: 10 }, 0)?.id).toBe("top");
    expect(shapeAt([bottom, top], { x: 10, y: 10 }, 0)?.id).toBe("bottom");
    expect(shapeAt([bottom, top], { x: 500, y: 10 }, 0)).toBeUndefined();
  });

  test("distance to a segment, including a segment of zero length", () => {
    expect(distanceToSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distanceToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });
});

describe("resizing", () => {
  const box = boxFrom({ x: 0, y: 0 }, { x: 100, y: 50 });

  test("a corner moves and the opposite corner stays", () => {
    expect(resizeBox(box, "se", { x: 120, y: 80 })).toEqual({ left: 0, top: 0, right: 120, bottom: 80 });
    expect(resizeBox(box, "nw", { x: 10, y: 5 })).toEqual({ left: 10, top: 5, right: 100, bottom: 50 });
  });

  test("dragging past the opposite corner flips the box; it never collapses", () => {
    expect(resizeBox(box, "se", { x: -20, y: -10 })).toEqual({ left: -20, top: -10, right: 0, bottom: 0 });
    expect(resizeBox(box, "ne", { x: 0, y: 50 }, 4)).toEqual({ left: 0, top: 50, right: 4, bottom: 54 });
  });

  test("freehand points scale with the box", () => {
    expect(scalePoints([0, 0, 100, 50], box, boxFrom({ x: 0, y: 0 }, { x: 50, y: 100 }))).toEqual([0, 0, 50, 100]);
    const flat = boxFrom({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(scalePoints([0, 0, 100, 0], flat, boxFrom({ x: 0, y: 0 }, { x: 200, y: 30 }))).toEqual([0, 0, 200, 0]);
  });

  test("contains", () => {
    expect(contains(box, boxFrom({ x: 10, y: 10 }, { x: 20, y: 20 }))).toBe(true);
    expect(contains(box, boxFrom({ x: 90, y: 10 }, { x: 120, y: 20 }))).toBe(false);
  });
});
