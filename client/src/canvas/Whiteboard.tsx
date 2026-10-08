import type { Color, ShapeId } from "@syncboard/shared";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Editor } from "../board/editor";
import { type Viewport, zoomAt } from "../board/geometry";
import { Board } from "./Board";
import { NoteEditor } from "./NoteEditor";
import { Toolbar } from "./Toolbar";
import { KIND, TOOLS, type Tool } from "./tools";

const ZOOM_STEP = 1.25;

function typingIn(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]") !== null;
}

/**
 * Everything the page knows that the board does not: the tool, the
 * color, the selection, where the viewport is, which note is being typed
 * in. The board itself lives in the editor.
 */
export function Whiteboard({ editor }: { editor: Editor }) {
  const { shapes, undoLabel, redoLabel } = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState<Color>("ink");
  const [filled, setFilled] = useState(false);
  const [chosen, setSelection] = useState<readonly ShapeId[]>([]);
  const [view, setView] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [panning, setPanning] = useState(false);
  const [editing, setEditing] = useState<ShapeId | null>(null);
  const [message, setMessage] = useState("");
  const area = useRef<HTMLDivElement>(null);

  // A shape deleted (by undo, or by someone else) drops out of the selection.
  const selection = chosen.filter((id) => shapes.some((shape) => shape.id === id));
  const note = editing === null ? undefined : shapes.find((shape) => shape.id === editing);

  // If someone else deletes the note being typed in, the typing ends: its
  // undo step is closed and the shortcuts work again.
  const editingNow = useRef<ShapeId | null>(null);
  useEffect(() => {
    editingNow.current = editing;
  });
  useEffect(
    () =>
      editor.subscribe(() => {
        const id = editingNow.current;
        if (id !== null && !editor.replica.shape(id)) {
          editingNow.current = null;
          editor.commit();
          setEditing(null);
        }
      }),
    [editor],
  );

  function announce(text: string) {
    setMessage(text);
  }

  function center() {
    const rect = area.current?.getBoundingClientRect();
    return { x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2 };
  }

  function zoomBy(factor: number) {
    setView((v) => zoomAt(v, center(), factor));
  }

  function startEditing(id: ShapeId) {
    setSelection([id]);
    editor.begin("Edit note");
    setEditing(id);
  }

  function stopEditing() {
    editor.commit();
    setEditing(null);
  }

  function chooseColor(next: Color) {
    setColor(next);
    if (selection.length === 0) {
      return;
    }
    editor.begin("Change color");
    for (const shape of shapes.filter((s) => selection.includes(s.id))) {
      if (shape.kind === "note") {
        editor.update(shape.id, { fill: next });
      } else {
        editor.update(shape.id, { stroke: next, ...(shape.fill === "none" ? {} : { fill: next }) });
      }
    }
    editor.commit();
  }

  function toggleFill() {
    const next = !filled;
    setFilled(next);
    const fillable = shapes.filter((s) => selection.includes(s.id) && (s.kind === "rectangle" || s.kind === "ellipse"));
    if (fillable.length === 0) {
      return;
    }
    editor.begin(next ? "Fill" : "Remove fill");
    for (const shape of fillable) {
      editor.update(shape.id, { fill: next ? shape.stroke : "none" });
    }
    editor.commit();
  }

  function remove() {
    if (selection.length > 0) {
      editor.remove(selection);
      announce(selection.length === 1 ? "Deleted 1 shape" : `Deleted ${String(selection.length)} shapes`);
      setSelection([]);
    }
  }

  function undo() {
    if (undoLabel) {
      editor.undo();
      announce(`Undid ${undoLabel}`);
    }
  }

  function redo() {
    if (redoLabel) {
      editor.redo();
      announce(`Redid ${redoLabel}`);
    }
  }

  function nudge(dx: number, dy: number) {
    const moving = shapes.filter((s) => selection.includes(s.id));
    if (moving.length === 0) {
      return;
    }
    editor.begin("Nudge");
    for (const shape of moving) {
      editor.update(shape.id, { x: shape.x + dx, y: shape.y + dy });
    }
    editor.commit();
  }

  // Wheel and trackpad: scroll pans, pinch (or Ctrl/Cmd + wheel) zooms
  // around the pointer. Registered by hand because React's wheel
  // listeners are passive and cannot stop the page from zooming.
  useEffect(() => {
    const element = area.current;
    if (!element) {
      return;
    }
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const rect = element?.getBoundingClientRect();
      const anchor = { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
      if (event.ctrlKey || event.metaKey) {
        setView((v) => zoomAt(v, anchor, Math.exp(-event.deltaY * 0.01)));
      } else {
        setView((v) => ({ ...v, x: v.x + event.deltaX / v.zoom, y: v.y + event.deltaY / v.zoom }));
      }
    }
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", onWheel);
    };
  }, []);

  // Keyboard shortcuts, except while typing somewhere.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (editing !== null || typingIn(event.target)) {
        return;
      }
      const key = event.key.toLowerCase();
      if (event.metaKey || event.ctrlKey) {
        if (key === "z") {
          event.preventDefault();
          if (event.shiftKey) {
            redo();
          } else {
            undo();
          }
        } else if (key === "y") {
          event.preventDefault();
          redo();
        } else if (key === "a") {
          event.preventDefault();
          setSelection(shapes.map((s) => s.id));
        }
        return;
      }
      if (event.key === " " && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        setPanning(true);
        return;
      }
      const step = event.shiftKey ? 10 : 1;
      const arrows: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const arrow = arrows[event.key];
      if (arrow && selection.length > 0) {
        event.preventDefault();
        nudge(...arrow);
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        remove();
      } else if (event.key === "Escape") {
        setSelection([]);
      } else if (event.key === "Enter" && selection.length === 1) {
        const [only] = selection;
        if (only && shapes.find((s) => s.id === only)?.kind === "note") {
          event.preventDefault();
          startEditing(only);
        }
      } else if (event.key === "]") {
        editor.bringToFront(selection);
      } else if (event.key === "[") {
        editor.sendToBack(selection);
      } else if (event.key === "+" || event.key === "=") {
        zoomBy(ZOOM_STEP);
      } else if (event.key === "-") {
        zoomBy(1 / ZOOM_STEP);
      } else {
        const match = TOOLS.find((t) => t.key === key);
        if (match && !event.altKey) {
          setTool(match.tool);
        }
      }
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.key === " ") {
        setPanning(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  });

  return (
    <div className="whiteboard">
      <div
        ref={area}
        className="board-area"
        style={{
          backgroundSize: `${String(24 * view.zoom)}px ${String(24 * view.zoom)}px`,
          backgroundPosition: `${String(-view.x * view.zoom)}px ${String(-view.y * view.zoom)}px`,
        }}
        data-grid={view.zoom >= 0.4 ? "on" : "off"}
      >
        <Board
          editor={editor}
          shapes={shapes}
          tool={tool}
          color={color}
          filled={filled}
          selection={selection}
          view={view}
          panning={panning}
          editing={editing}
          onSelect={setSelection}
          onView={setView}
          onCreated={(id, used) => {
            announce(`Added ${KIND[used] ?? "shape"}`);
            setSelection([id]);
            if (used !== "pen") {
              setTool("select");
            }
            if (used === "note") {
              startEditing(id);
            }
          }}
          onEditText={startEditing}
        />
        {note && <NoteEditor key={note.id} editor={editor} note={note} view={view} onDone={stopEditing} />}
        {shapes.length === 0 && editing === null && (
          <p className="board-hint">Choose a tool below and drag on the board, or press R for a rectangle.</p>
        )}
      </div>

      <div className="zoom" role="group" aria-label="Zoom">
        <button type="button" aria-label="Zoom out" onClick={() => { zoomBy(1 / ZOOM_STEP); }}>
          −
        </button>
        <button
          type="button"
          className="zoom-level"
          title="Back to 100%"
          onClick={() => {
            setView((v) => zoomAt(v, center(), 1 / v.zoom));
          }}
        >
          {Math.round(view.zoom * 100)}%
        </button>
        <button type="button" aria-label="Zoom in" onClick={() => { zoomBy(ZOOM_STEP); }}>
          +
        </button>
      </div>

      <Toolbar
        tool={tool}
        color={color}
        filled={filled}
        undoLabel={undoLabel}
        redoLabel={redoLabel}
        hasSelection={selection.length > 0}
        onTool={setTool}
        onColor={chooseColor}
        onFill={toggleFill}
        onUndo={undo}
        onRedo={redo}
        onFront={() => {
          editor.bringToFront(selection);
        }}
        onBack={() => {
          editor.sendToBack(selection);
        }}
        onDelete={remove}
      />
      <div className="visually-hidden" role="status" aria-live="polite" data-testid="announcer">
        {message}
      </div>
    </div>
  );
}
