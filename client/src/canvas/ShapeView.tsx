import type { Color, Shape } from "@syncboard/shared";
import { arrowHead, bounds, strokePoints } from "../board/geometry";

/** Colors are names; each has a marker color and a lighter tint, per theme (index.css). */
const marker = (color: Color) => `var(--marker-${color})`;
const tint = (color: Color) => `var(--tint-${color})`;

export const STROKE_WIDTH = 2.5;

/** A smooth path through the points: quadratic curves between midpoints. */
function strokePath(shape: Shape): string {
  const points = strokePoints(shape);
  const [first] = points;
  if (!first) {
    return "";
  }
  if (points.length === 1) {
    return `M ${String(first.x)} ${String(first.y)} l 0.01 0`; // a dot, drawn by the round cap
  }
  let d = `M ${String(first.x)} ${String(first.y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const next = points[i + 1];
    if (p && next) {
      d += ` Q ${String(p.x)} ${String(p.y)} ${String((p.x + next.x) / 2)} ${String((p.y + next.y) / 2)}`;
    }
  }
  const last = points.at(-1);
  if (last) {
    d += ` L ${String(last.x)} ${String(last.y)}`;
  }
  return d;
}

export function ShapeView({ shape }: { shape: Shape }) {
  const box = bounds(shape);
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  const common = {
    stroke: marker(shape.stroke),
    strokeWidth: STROKE_WIDTH,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (shape.kind) {
    case "rectangle":
      return (
        <rect
          {...common}
          x={box.left}
          y={box.top}
          width={width}
          height={height}
          rx={6}
          fill={shape.fill === "none" ? "none" : tint(shape.fill)}
        />
      );
    case "ellipse":
      return (
        <ellipse
          {...common}
          cx={box.left + width / 2}
          cy={box.top + height / 2}
          rx={width / 2}
          ry={height / 2}
          fill={shape.fill === "none" ? "none" : tint(shape.fill)}
        />
      );
    case "arrow": {
      const tail = { x: shape.x, y: shape.y };
      const head = { x: shape.x + shape.w, y: shape.y + shape.h };
      return (
        <g {...common} fill="none">
          <line x1={tail.x} y1={tail.y} x2={head.x} y2={head.y} />
          <path d={arrowHead(tail, head, 14)} />
        </g>
      );
    }
    case "freehand":
      return <path {...common} d={strokePath(shape)} fill="none" />;
    case "note":
      return (
        <g className="note">
          <rect
            x={box.left}
            y={box.top}
            width={width}
            height={height}
            rx={3}
            fill={tint(shape.fill === "none" ? "yellow" : shape.fill)}
          />
          <foreignObject x={box.left} y={box.top} width={width} height={height}>
            <div className="note-text">{shape.text}</div>
          </foreignObject>
        </g>
      );
  }
}
