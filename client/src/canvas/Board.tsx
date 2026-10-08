import type { Color, Shape, ShapeId } from "@syncboard/shared";
import { MAX_POINTS } from "@syncboard/shared";
import { type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import type { Editor } from "../board/editor";
import {
  type Box,
  CORNERS,
  type Corner,
  type Point,
  type Viewport,
  bounds,
  boxFrom,
  contains,
  cornerPoint,
  resizeBox,
  round,
  scalePoints,
  shapeAt,
  toBoard,
  toScreen,
} from "../board/geometry";
import { ShapeView } from "./ShapeView";
import { DEFAULT_SIZE, type Tool, notePaper } from "./tools";

/** Screen pixels: how near the pointer must be to a shape or a handle. */
const HIT_TOLERANCE = 6;
const HANDLE_SIZE = 9;
/** A press that moves less than this (screen pixels) is a click. */
const CLICK_SLOP = 4;

type DrawTool = "rectangle" | "ellipse" | "arrow" | "note";

/**
 * Gestures that change shapes wait until the pointer has moved past
 * CLICK_SLOP: a click must not make an edit (or an undo step). `grab` is
 * how far the grabbed point (a corner, an arrow's end) was from the
 * pointer, so it keeps that offset instead of jumping to the pointer.
 */
type Edit = { startScreen: Point; moved: boolean };

type Gesture =
  | (Edit & { kind: "move"; start: Point; origin: ReadonlyMap<ShapeId, Point> })
  | (Edit & { kind: "resize"; id: ShapeId; corner: Corner; box: Box; points: readonly number[]; grab: Point })
  | (Edit & { kind: "endpoint"; id: ShapeId; end: "tail" | "head"; grab: Point })
  | { kind: "draw"; tool: DrawTool; start: Point; current: Point; startScreen: Point; currentScreen: Point }
  | { kind: "pen"; points: Point[] }
  | { kind: "marquee"; start: Point; current: Point; base: readonly ShapeId[] }
  | { kind: "pan"; startScreen: Point; view: Viewport };

export type BoardProps = {
  editor: Editor;
  shapes: readonly Shape[];
  tool: Tool;
  color: Color;
  filled: boolean;
  selection: readonly ShapeId[];
  view: Viewport;
  panning: boolean; // the space bar is held
  editing: ShapeId | null;
  onSelect: (ids: readonly ShapeId[]) => void;
  onView: (view: Viewport) => void;
  onCreated: (id: ShapeId, tool: Tool) => void;
  onEditText: (id: ShapeId) => void;
  /** Where the pointer is on the board, or null when it leaves: for presence. */
  onCursor: (at: Point | null) => void;
};

/** What a gesture shows while it lasts: render reads this, never the ref. */
type Preview =
  | { kind: "draw"; tool: DrawTool; start: Point; current: Point }
  | { kind: "pen"; points: readonly Point[] }
  | { kind: "marquee"; start: Point; current: Point };

function local(event: ReactPointerEvent<SVGSVGElement>): Point {
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

/** The handles of a single selected shape, on screen: corners, or an arrow's two ends. */
function handles(shape: Shape, view: Viewport): { id: string; at: Point }[] {
  if (shape.kind === "arrow") {
    return [
      { id: "tail", at: toScreen(view, { x: shape.x, y: shape.y }) },
      { id: "head", at: toScreen(view, { x: shape.x + shape.w, y: shape.y + shape.h }) },
    ];
  }
  const box = bounds(shape);
  return CORNERS.map((corner) => ({ id: corner, at: toScreen(view, cornerPoint(box, corner)) }));
}

export function Board(props: BoardProps) {
  const { editor, shapes, tool, view, selection } = props;
  // The gesture lives in a ref, read by the pointer handlers as events
  // arrive; what it shows is copied into state for rendering.
  const gesture = useRef<Gesture | null>(null);
  const [active, setActive] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const selected = shapes.filter((shape) => selection.includes(shape.id));
  const tolerance = HIT_TOLERANCE / view.zoom;

  // Escape in the middle of a gesture cancels it: whatever it changed goes
  // back, and the pointer's release then does nothing.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && gesture.current) {
        event.stopImmediatePropagation();
        cancel();
      }
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  });

  function start(event: ReactPointerEvent<SVGSVGElement>) {
    if (gesture.current || props.editing) {
      return;
    }
    const screen = local(event);
    const p = toBoard(view, screen);
    let next: Gesture | null;
    if (event.button === 1 || (event.button === 0 && props.panning)) {
      next = { kind: "pan", startScreen: screen, view };
    } else if (event.button !== 0) {
      return;
    } else if (tool === "hand") {
      next = { kind: "pan", startScreen: screen, view };
    } else if (tool === "select") {
      next = selectStart(screen, p, event.shiftKey);
    } else if (tool === "pen") {
      next = { kind: "pen", points: [p] };
    } else {
      next = { kind: "draw", tool, start: p, current: p, startScreen: screen, currentScreen: screen };
    }
    if (next) {
      event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = next;
      setActive(true);
      if (next.kind === "pen") {
        setPreview({ kind: "pen", points: [...next.points] });
      }
    }
  }

  function selectStart(screen: Point, p: Point, shift: boolean): Gesture | null {
    const edit = { startScreen: screen, moved: false };
    // A handle of the one selected shape comes first: it may sit over another shape.
    const [only] = selected;
    if (selected.length === 1 && only) {
      for (const handle of handles(only, view)) {
        if (Math.hypot(handle.at.x - screen.x, handle.at.y - screen.y) <= HANDLE_SIZE) {
          editor.begin(only.kind === "arrow" ? "Move arrow end" : "Resize");
          const target = toBoard(view, handle.at);
          const grab = { x: target.x - p.x, y: target.y - p.y };
          return only.kind === "arrow"
            ? { ...edit, kind: "endpoint", id: only.id, end: handle.id as "tail" | "head", grab }
            : {
                ...edit,
                kind: "resize",
                id: only.id,
                corner: handle.id as Corner,
                box: bounds(only),
                points: only.points,
                grab,
              };
        }
      }
    }
    const hit = shapeAt(shapes, p, tolerance);
    if (!hit) {
      if (!shift) {
        props.onSelect([]);
      }
      return { kind: "marquee", start: p, current: p, base: shift ? selection : [] };
    }
    if (shift) {
      props.onSelect(selection.includes(hit.id) ? selection.filter((id) => id !== hit.id) : [...selection, hit.id]);
      return null;
    }
    const moving = selection.includes(hit.id) ? selected : [hit];
    if (!selection.includes(hit.id)) {
      props.onSelect([hit.id]);
    }
    editor.begin(moving.length === 1 ? "Move shape" : `Move ${String(moving.length)} shapes`);
    return { ...edit, kind: "move", start: p, origin: new Map(moving.map((s) => [s.id, { x: s.x, y: s.y }])) };
  }

  function move(event: ReactPointerEvent<SVGSVGElement>) {
    const screen = local(event);
    const p = toBoard(view, screen);
    props.onCursor(p);
    const g = gesture.current;
    if (!g) {
      return;
    }
    if (g.kind === "move" || g.kind === "resize" || g.kind === "endpoint") {
      if (!g.moved && Math.hypot(screen.x - g.startScreen.x, screen.y - g.startScreen.y) <= CLICK_SLOP) {
        return;
      }
      g.moved = true;
    }
    switch (g.kind) {
      case "pan":
        props.onView({
          ...g.view,
          x: g.view.x - (screen.x - g.startScreen.x) / g.view.zoom,
          y: g.view.y - (screen.y - g.startScreen.y) / g.view.zoom,
        });
        return;
      case "move":
        for (const [id, origin] of g.origin) {
          editor.update(id, { x: origin.x + p.x - g.start.x, y: origin.y + p.y - g.start.y });
        }
        return;
      case "resize": {
        const box = resizeBox(g.box, g.corner, { x: p.x + g.grab.x, y: p.y + g.grab.y }, 1);
        const shape = shapes.find((s) => s.id === g.id);
        editor.update(g.id, {
          x: box.left,
          y: box.top,
          w: box.right - box.left,
          h: box.bottom - box.top,
          ...(shape?.kind === "freehand" ? { points: scalePoints(g.points, g.box, box) } : {}),
        });
        return;
      }
      case "endpoint": {
        const shape = shapes.find((s) => s.id === g.id);
        if (!shape) {
          return;
        }
        const to = { x: p.x + g.grab.x, y: p.y + g.grab.y };
        if (g.end === "head") {
          editor.update(g.id, { w: to.x - shape.x, h: to.y - shape.y });
        } else {
          const head = { x: shape.x + shape.w, y: shape.y + shape.h };
          editor.update(g.id, { x: to.x, y: to.y, w: head.x - to.x, h: head.y - to.y });
        }
        return;
      }
      case "draw":
        gesture.current = { ...g, current: p, currentScreen: screen };
        setPreview({ kind: "draw", tool: g.tool, start: g.start, current: p });
        return;
      case "pen": {
        const last = g.points.at(-1);
        if (last && Math.hypot(p.x - last.x, p.y - last.y) * view.zoom >= 2 && g.points.length < MAX_POINTS / 2) {
          g.points.push(p);
          setPreview({ kind: "pen", points: [...g.points] });
        }
        return;
      }
      case "marquee":
        gesture.current = { ...g, current: p };
        setPreview({ kind: "marquee", start: g.start, current: p });
        return;
    }
  }

  function end(event: ReactPointerEvent<SVGSVGElement>) {
    const g = gesture.current;
    gesture.current = null;
    if (!g) {
      return;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    switch (g.kind) {
      case "move":
      case "resize":
      case "endpoint":
        editor.commit();
        break;
      case "draw":
        finishDrawing(g);
        break;
      case "pen":
        finishStroke(g.points);
        break;
      case "marquee": {
        const area = boxFrom(g.start, g.current);
        const inside = shapes.filter((s) => contains(area, bounds(s))).map((s) => s.id);
        props.onSelect([...new Set([...g.base, ...inside])]);
        break;
      }
      case "pan":
        break;
    }
    setActive(false);
    setPreview(null);
  }

  function cancel() {
    const g = gesture.current;
    gesture.current = null;
    if (g && (g.kind === "move" || g.kind === "resize" || g.kind === "endpoint")) {
      editor.cancel();
    }
    setActive(false);
    setPreview(null);
  }

  function finishDrawing(g: Extract<Gesture, { kind: "draw" }>) {
    const dragged =
      Math.abs(g.currentScreen.x - g.startScreen.x) > CLICK_SLOP ||
      Math.abs(g.currentScreen.y - g.startScreen.y) > CLICK_SLOP;
    const style = { stroke: props.color, fill: props.filled ? props.color : ("none" as const) };
    let id: ShapeId;
    if (g.tool === "arrow") {
      const end = dragged ? g.current : { x: g.start.x + DEFAULT_SIZE.arrow.w, y: g.start.y };
      id = editor.create({ kind: "arrow", x: g.start.x, y: g.start.y, w: end.x - g.start.x, h: end.y - g.start.y, ...style });
    } else {
      const size = DEFAULT_SIZE[g.tool];
      const box = dragged
        ? boxFrom(g.start, g.current)
        : boxFrom(
            { x: g.start.x - size.w / 2, y: g.start.y - size.h / 2 },
            { x: g.start.x + size.w / 2, y: g.start.y + size.h / 2 },
          );
      const note = g.tool === "note" ? { fill: notePaper(props.color, props.filled) } : {};
      id = editor.create({
        kind: g.tool,
        x: box.left,
        y: box.top,
        w: box.right - box.left,
        h: box.bottom - box.top,
        ...style,
        ...note,
      });
    }
    props.onCreated(id, g.tool);
  }

  function finishStroke(points: readonly Point[]) {
    const box = points.reduce<Box | null>(
      (b, p) => (b ? { left: Math.min(b.left, p.x), top: Math.min(b.top, p.y), right: Math.max(b.right, p.x), bottom: Math.max(b.bottom, p.y) } : boxFrom(p, p)),
      null,
    );
    if (!box) {
      return;
    }
    const id = editor.create({
      kind: "freehand",
      x: box.left,
      y: box.top,
      w: box.right - box.left,
      h: box.bottom - box.top,
      points: points.flatMap((p) => [round(p.x - box.left), round(p.y - box.top)]),
      stroke: props.color,
    });
    props.onCreated(id, "pen");
  }

  function doubleClick(event: ReactMouseEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const p = toBoard(view, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    const hit = shapeAt(shapes, p, tolerance);
    if (hit?.kind === "note") {
      props.onEditText(hit.id);
    }
  }

  const drawing = previewShape(preview, props);
  const transform = `scale(${String(view.zoom)}) translate(${String(-view.x)} ${String(-view.y)})`;
  const marquee =
    preview?.kind === "marquee" ? boxFrom(toScreen(view, preview.start), toScreen(view, preview.current)) : null;

  return (
    <svg
      className={`board-canvas tool-${tool}${props.panning ? " is-panning" : ""}`}
      role="img"
      aria-label={`Board with ${String(shapes.length)} ${shapes.length === 1 ? "shape" : "shapes"}`}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={cancel}
      onPointerLeave={() => {
        props.onCursor(null);
      }}
      onLostPointerCapture={() => {
        if (gesture.current) {
          cancel();
        }
      }}
      onDoubleClick={doubleClick}
    >
      <g transform={transform}>
        {shapes.map((shape) => (
          <g key={shape.id} data-shape={shape.id} data-kind={shape.kind}>
            <ShapeView shape={shape} />
          </g>
        ))}
        {drawing && (
          <g className="preview" data-preview="">
            <ShapeView shape={drawing} />
          </g>
        )}
      </g>
      {selected.map((shape) => {
        const box = bounds(shape);
        const a = toScreen(view, { x: box.left, y: box.top });
        const b = toScreen(view, { x: box.right, y: box.bottom });
        return (
          <rect
            key={shape.id}
            className="selection-box"
            data-selected={shape.id}
            x={a.x - 4}
            y={a.y - 4}
            width={b.x - a.x + 8}
            height={b.y - a.y + 8}
          />
        );
      })}
      {selected.length === 1 &&
        selected[0] &&
        !active &&
        handles(selected[0], view).map((handle) => (
          <rect
            key={handle.id}
            className="handle"
            data-handle={handle.id}
            x={handle.at.x - HANDLE_SIZE / 2}
            y={handle.at.y - HANDLE_SIZE / 2}
            width={HANDLE_SIZE}
            height={HANDLE_SIZE}
            rx={2}
          />
        ))}
      {marquee && (
        <rect
          className="marquee"
          x={marquee.left}
          y={marquee.top}
          width={marquee.right - marquee.left}
          height={marquee.bottom - marquee.top}
        />
      )}
    </svg>
  );
}

/** The shape being drawn, shown before it exists. */
function previewShape(g: Preview | null, props: BoardProps): Shape | null {
  const base = {
    id: "preview",
    z: "V",
    stroke: props.color,
    fill: props.filled ? props.color : ("none" as const),
    text: "",
    points: [] as number[],
    deleted: false,
  };
  if (g?.kind === "draw") {
    if (g.tool === "arrow") {
      return { ...base, kind: "arrow", x: g.start.x, y: g.start.y, w: g.current.x - g.start.x, h: g.current.y - g.start.y };
    }
    const box = boxFrom(g.start, g.current);
    return {
      ...base,
      kind: g.tool,
      x: box.left,
      y: box.top,
      w: box.right - box.left,
      h: box.bottom - box.top,
      ...(g.tool === "note" ? { fill: notePaper(props.color, props.filled) } : {}),
    };
  }
  if (g?.kind === "pen") {
    const [first] = g.points;
    if (!first) {
      return null;
    }
    return { ...base, kind: "freehand", x: 0, y: 0, w: 0, h: 0, points: g.points.flatMap((p) => [p.x, p.y]) };
  }
  return null;
}
