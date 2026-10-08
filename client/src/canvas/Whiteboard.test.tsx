import { Replica } from "@syncboard/shared";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Editor } from "../board/editor";
import { Whiteboard } from "./Whiteboard";

// jsdom does no layout: the board sits at (0, 0), so client coordinates are
// screen coordinates, and at zoom 1 with the view at the origin, board ones.

function setup() {
  const editor = new Editor(new Replica("me"));
  const view = render(<Whiteboard editor={editor} />);
  const canvas = screen.getByRole("img", { name: /^Board with/ });
  const shapes = () => editor.getSnapshot().shapes;
  return { editor, canvas, shapes, view };
}

type Point = { x: number; y: number };

function press(target: Element, at: Point, init: Partial<PointerEventInit> = {}) {
  fireEvent.pointerDown(target, { pointerId: 1, button: 0, clientX: at.x, clientY: at.y, ...init });
}

function drag(target: Element, from: Point, to: Point, init: Partial<PointerEventInit> = {}) {
  press(target, from, init);
  fireEvent.pointerMove(target, { pointerId: 1, clientX: (from.x + to.x) / 2, clientY: (from.y + to.y) / 2 });
  fireEvent.pointerMove(target, { pointerId: 1, clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: to.x, clientY: to.y });
}

function click(target: Element, at: Point, init: Partial<PointerEventInit> = {}) {
  drag(target, at, at, init);
}

function key(k: string, init: Partial<KeyboardEventInit> = {}) {
  fireEvent.keyDown(window, { key: k, ...init });
}

const announced = () => screen.getByTestId("announcer").textContent;
const pressed = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-pressed");

describe("drawing", () => {
  test("R and a drag make a rectangle, selected, and the tool goes back to Select", () => {
    const { canvas, shapes } = setup();
    key("r");
    expect(pressed("Rectangle")).toBe("true");
    drag(canvas, { x: 100, y: 100 }, { x: 300, y: 220 });
    expect(shapes()).toMatchObject([{ kind: "rectangle", x: 100, y: 100, w: 200, h: 120, stroke: "ink", fill: "none" }]);
    expect(canvas.querySelectorAll("[data-selected]")).toHaveLength(1);
    expect(pressed("Select")).toBe("true");
    expect(announced()).toBe("Added rectangle");
  });

  test("dragging up and to the left draws the same box", () => {
    const { canvas, shapes } = setup();
    key("o");
    drag(canvas, { x: 300, y: 220 }, { x: 100, y: 100 });
    expect(shapes()).toMatchObject([{ kind: "ellipse", x: 100, y: 100, w: 200, h: 120 }]);
  });

  test("a click without a drag makes a default size shape centred on it", () => {
    const { canvas, shapes } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Ellipse" }));
    click(canvas, { x: 400, y: 300 });
    expect(shapes()).toMatchObject([{ kind: "ellipse", x: 330, y: 250, w: 140, h: 100 }]);
  });

  test("an arrow runs from where the drag starts to where it ends", () => {
    const { canvas, shapes } = setup();
    key("a");
    drag(canvas, { x: 300, y: 300 }, { x: 100, y: 200 });
    expect(shapes()).toMatchObject([{ kind: "arrow", x: 300, y: 300, w: -200, h: -100 }]);
  });

  test("the pen keeps its points relative to the stroke's box, and stays the tool", () => {
    const { canvas, shapes } = setup();
    key("p");
    press(canvas, { x: 50, y: 80 });
    for (const [x, y] of [[60, 70], [80, 90], [90, 60]]) {
      fireEvent.pointerMove(canvas, { pointerId: 1, clientX: x, clientY: y });
    }
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 90, clientY: 60 });
    expect(shapes()).toMatchObject([
      { kind: "freehand", x: 50, y: 60, w: 40, h: 30, points: [0, 20, 10, 10, 30, 30, 40, 0] },
    ]);
    expect(pressed("Pen")).toBe("true");
  });

  test("the chosen color and fill apply to new shapes", () => {
    const { canvas, shapes } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Blue" }));
    fireEvent.click(screen.getByRole("button", { name: "Fill" }));
    key("r");
    drag(canvas, { x: 0, y: 0 }, { x: 50, y: 50 });
    expect(shapes()[0]).toMatchObject({ stroke: "blue", fill: "blue" });
  });
});

describe("notes", () => {
  test("a new note opens for typing; the typing is one undo step", () => {
    const { canvas, shapes, editor } = setup();
    key("n");
    drag(canvas, { x: 20, y: 20 }, { x: 220, y: 180 });
    const box = screen.getByRole("textbox", { name: "Note text" });
    expect(box).toHaveFocus();
    fireEvent.change(box, { target: { value: "Ship it" } });
    expect(shapes()[0]).toMatchObject({ kind: "note", text: "Ship it", fill: "yellow" });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(editor.getSnapshot().undoLabel).toBe("Edit note");
    act(() => {
      editor.undo();
    });
    expect(shapes()[0]?.text).toBe("");
  });

  test("double-clicking a note edits it; keys typed there are not shortcuts", () => {
    const { canvas, shapes, editor } = setup();
    act(() => {
      editor.create({ kind: "note", x: 0, y: 0, w: 200, h: 160, fill: "yellow", text: "draft" });
    });
    fireEvent.doubleClick(canvas, { clientX: 50, clientY: 50 });
    const box = screen.getByRole("textbox", { name: "Note text" });
    fireEvent.keyDown(box, { key: "r" });
    expect(pressed("Select")).toBe("true");
    fireEvent.change(box, { target: { value: "final" } });
    fireEvent.blur(box);
    expect(shapes()[0]?.text).toBe("final");
  });
});

describe("selecting and changing", () => {
  function withShapes(...boxes: Point[]) {
    const s = setup();
    act(() => {
      for (const at of boxes) {
        s.editor.create({ kind: "rectangle", x: at.x, y: at.y, w: 40, h: 40 });
      }
    });
    return s;
  }

  test("drag a shape to move it; one undo puts it back", () => {
    const { canvas, shapes } = withShapes({ x: 0, y: 0 });
    drag(canvas, { x: 10, y: 10 }, { x: 60, y: 40 });
    expect(shapes()[0]).toMatchObject({ x: 50, y: 30 });
    key("z", { ctrlKey: true });
    expect(shapes()[0]).toMatchObject({ x: 0, y: 0 });
    expect(announced()).toBe("Undid Move shape");
    key("z", { ctrlKey: true, shiftKey: true });
    expect(shapes()[0]).toMatchObject({ x: 50, y: 30 });
  });

  test("Escape during a drag puts the shape back and leaves nothing to undo", () => {
    const { canvas, shapes, editor } = withShapes({ x: 0, y: 0 });
    press(canvas, { x: 10, y: 10 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 80, clientY: 60 });
    expect(shapes()[0]).toMatchObject({ x: 70, y: 50 });
    key("Escape");
    expect(shapes()[0]).toMatchObject({ x: 0, y: 0 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 80, clientY: 60 });
    expect(shapes()[0]).toMatchObject({ x: 0, y: 0 });
    expect(editor.getSnapshot().undoLabel).toBe("Add rectangle");
    expect(canvas.querySelectorAll("[data-selected]")).toHaveLength(1); // still selected
  });

  test("click selects; Delete removes; undo brings it back", () => {
    const { canvas, shapes } = withShapes({ x: 0, y: 0 }, { x: 100, y: 0 });
    click(canvas, { x: 110, y: 10 });
    key("Delete");
    expect(shapes().map((s) => s.x)).toEqual([0]);
    expect(announced()).toBe("Deleted 1 shape");
    key("z", { metaKey: true });
    expect(shapes()).toHaveLength(2);
  });

  test("shift-click adds to the selection; a drag on empty board selects what it encloses", () => {
    const { canvas } = withShapes({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 300, y: 300 });
    click(canvas, { x: 10, y: 10 });
    click(canvas, { x: 110, y: 10 }, { shiftKey: true });
    expect(canvas.querySelectorAll("[data-selected]")).toHaveLength(2);
    click(canvas, { x: 600, y: 600 }); // empty board: clears
    expect(canvas.querySelectorAll("[data-selected]")).toHaveLength(0);
    // Started clear of the shapes: within 6 px of one, a press grabs it.
    drag(canvas, { x: -20, y: -20 }, { x: 150, y: 50 });
    expect(canvas.querySelectorAll("[data-selected]")).toHaveLength(2);
  });

  test("a click on a shape selects it without making an edit", () => {
    const { canvas, editor } = withShapes({ x: 0, y: 0 });
    const sent: unknown[] = [];
    editor.onOperation((op) => sent.push(op));
    click(canvas, { x: 10, y: 10 });
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 12, clientY: 11 }); // a jitter, not a drag
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 12, clientY: 11 });
    expect(sent).toEqual([]);
    expect(editor.getSnapshot().undoLabel).toBe("Add rectangle");
  });

  test("a handle grabbed off-centre keeps its offset: pressing and releasing changes nothing", () => {
    const { canvas, shapes } = withShapes({ x: 10, y: 10 });
    click(canvas, { x: 20, y: 20 });
    drag(canvas, { x: 47, y: 46 }, { x: 77, y: 76 }); // 3 px off the corner at (50, 50)
    expect(shapes()[0]).toMatchObject({ x: 10, y: 10, w: 70, h: 70 });
  });

  test("the corner handle resizes; the opposite corner stays", () => {
    const { canvas, shapes } = withShapes({ x: 10, y: 10 });
    click(canvas, { x: 20, y: 20 });
    expect(canvas.querySelectorAll("[data-handle]")).toHaveLength(4);
    drag(canvas, { x: 50, y: 50 }, { x: 110, y: 90 }); // the south-east corner, at (50, 50)
    expect(shapes()[0]).toMatchObject({ x: 10, y: 10, w: 100, h: 80 });
    expect(announced()).not.toContain("Undid");
  });

  test("an arrow's head handle moves only its head", () => {
    const { canvas, shapes, editor } = setup();
    act(() => {
      editor.create({ kind: "arrow", x: 0, y: 0, w: 100, h: 0 });
    });
    click(canvas, { x: 50, y: 0 });
    drag(canvas, { x: 100, y: 0 }, { x: 100, y: 100 });
    expect(shapes()[0]).toMatchObject({ x: 0, y: 0, w: 100, h: 100 });
  });

  test("a color recolors the selection; on a note it changes the paper", () => {
    const { canvas, shapes, editor } = withShapes({ x: 0, y: 0 });
    act(() => {
      editor.create({ kind: "note", x: 100, y: 0, w: 100, h: 100, fill: "yellow" });
    });
    click(canvas, { x: 10, y: 10 });
    click(canvas, { x: 150, y: 50 }, { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Red" }));
    expect(shapes().map((s) => [s.kind, s.stroke, s.fill])).toEqual([
      ["rectangle", "red", "none"],
      ["note", "ink", "red"],
    ]);
    expect(editor.getSnapshot().undoLabel).toBe("Change color");
  });

  test("arrow keys nudge; ] and [ change the stacking order; Escape clears the selection", () => {
    const { canvas, shapes } = withShapes({ x: 0, y: 0 }, { x: 20, y: 20 });
    click(canvas, { x: 5, y: 5 });
    key("ArrowRight", { shiftKey: true });
    key("ArrowDown");
    expect(shapes()[0]).toMatchObject({ x: 10, y: 1 });
    key("]");
    expect(shapes().at(-1)).toMatchObject({ x: 10, y: 1 });
    key("[");
    expect(shapes()[0]).toMatchObject({ x: 10, y: 1 });
    key("Escape");
    expect(canvas.querySelectorAll("[data-selected]")).toHaveLength(0);
  });

  test("Ctrl+A selects everything; the tray's Delete removes it all", () => {
    const { shapes } = withShapes({ x: 0, y: 0 }, { x: 100, y: 0 });
    key("a", { ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(shapes()).toEqual([]);
    expect(announced()).toBe("Deleted 2 shapes");
  });
});

describe("the viewport", () => {
  test("the zoom buttons zoom; the percentage resets to 100%", () => {
    setup();
    const zoom = screen.getByRole("group", { name: "Zoom" });
    fireEvent.click(within(zoom).getByRole("button", { name: "Zoom in" }));
    expect(within(zoom).getByText("125%")).toBeInTheDocument();
    fireEvent.click(within(zoom).getByText("125%"));
    expect(within(zoom).getByText("100%")).toBeInTheDocument();
  });

  test("Ctrl + wheel zooms around the pointer; the wheel alone pans", () => {
    const { canvas } = setup();
    const area = canvas.parentElement as HTMLElement;
    fireEvent.wheel(area, { deltaY: -100, ctrlKey: true, clientX: 200, clientY: 100 });
    const layer = canvas.querySelector("g");
    expect(layer?.getAttribute("transform")).toMatch(/^scale\(2\.71/);
    fireEvent.wheel(area, { deltaX: 0, deltaY: 50 });
    expect(screen.getByRole("group", { name: "Zoom" })).toHaveTextContent("272%");
  });

  test("after panning, a drawn shape lands where the pointer was on the board", () => {
    const { canvas, shapes } = setup();
    key("h");
    drag(canvas, { x: 200, y: 200 }, { x: 100, y: 150 }); // the view moves right 100, down 50
    key("r");
    drag(canvas, { x: 0, y: 0 }, { x: 40, y: 40 });
    expect(shapes()[0]).toMatchObject({ x: 100, y: 50 });
  });

  test("holding space pans, whatever the tool", () => {
    const { canvas, shapes } = setup();
    key("r");
    key(" ");
    drag(canvas, { x: 100, y: 100 }, { x: 50, y: 100 });
    fireEvent.keyUp(window, { key: " " });
    expect(shapes()).toEqual([]);
    drag(canvas, { x: 0, y: 0 }, { x: 40, y: 40 });
    expect(shapes()[0]).toMatchObject({ x: 50, y: 0 });
  });
});

test("the board says how to start when it is empty", () => {
  setup();
  expect(screen.getByText(/Choose a tool below/)).toBeInTheDocument();
});
