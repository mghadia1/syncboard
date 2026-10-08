import type { Presence, Shape } from "@syncboard/shared";
import type { CSSProperties } from "react";
import { type Viewport, bounds, toScreen } from "../board/geometry";

const color = (presence: Presence) => ({ "--person": `var(--marker-${presence.color})` }) as CSSProperties;

/**
 * Other people on the board: their pointers, with their names, and an
 * outline around what they have selected, in their color. Positions are on
 * the board, so each lands on the same shape whatever this viewer's pan
 * and zoom. Hidden from screen readers: the masthead lists who is here.
 */
export function PeersLayer({
  peers,
  shapes,
  view,
}: {
  peers: ReadonlyMap<string, Presence>;
  shapes: readonly Shape[];
  view: Viewport;
}) {
  const byId = new Map(shapes.map((shape) => [shape.id, shape]));
  return (
    <div className="peers" aria-hidden="true">
      {[...peers].map(([client, presence]) => (
        <div key={client} style={color(presence)} data-peer={client}>
          {presence.selection.map((id) => {
            const shape = byId.get(id);
            if (!shape) {
              return null;
            }
            const box = bounds(shape);
            const a = toScreen(view, { x: box.left, y: box.top });
            const b = toScreen(view, { x: box.right, y: box.bottom });
            return (
              <div
                key={id}
                className="peer-selection"
                data-peer-selected={id}
                style={{ left: a.x - 5, top: a.y - 5, width: b.x - a.x + 10, height: b.y - a.y + 10 }}
              />
            );
          })}
          {presence.cursor && <Cursor presence={presence} at={toScreen(view, presence.cursor)} />}
        </div>
      ))}
    </div>
  );
}

function Cursor({ presence, at }: { presence: Presence; at: { x: number; y: number } }) {
  return (
    <div className="peer-cursor" style={{ transform: `translate(${String(at.x)}px, ${String(at.y)}px)` }}>
      <svg width="18" height="22" viewBox="0 0 18 22">
        <path d="M1.5 1.5 L1.5 17 L5.6 13.2 L8.4 19.6 L11 18.5 L8.3 12.3 L14 12 Z" />
      </svg>
      <span className="peer-name">{presence.name}</span>
    </div>
  );
}
