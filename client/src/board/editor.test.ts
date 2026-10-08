import { type Operation, Replica, parseOperation } from "@syncboard/shared";
import { describe, expect, test } from "vitest";
import { Editor } from "./editor";

const box = { kind: "rectangle", x: 0, y: 0, w: 10, h: 10 } as const;

function editor() {
  const e = new Editor(new Replica("me"));
  const sent: Operation[] = [];
  e.onOperation((op) => sent.push(op));
  return { e, sent };
}

const ids = (e: Editor) => e.getSnapshot().shapes.map((s) => s.id);

describe("undo and redo", () => {
  test("undo removes a new shape, redo brings it back", () => {
    const { e } = editor();
    const id = e.create(box);
    expect(e.getSnapshot().undoLabel).toBe("Add rectangle");
    e.undo();
    expect(ids(e)).toEqual([]);
    expect(e.getSnapshot().redoLabel).toBe("Add rectangle");
    e.redo();
    expect(ids(e)).toEqual([id]);
  });

  test("a whole drag is one step: undo goes back to before it started", () => {
    const { e, sent } = editor();
    const id = e.create(box);
    e.begin("Move");
    for (const x of [1, 2, 3, 40]) {
      e.update(id, { x });
    }
    e.commit();
    expect(sent).toHaveLength(5); // the creation and four moves, all sent as they happened
    e.undo();
    expect(e.getSnapshot().shapes[0]?.x).toBe(0);
    e.redo();
    expect(e.getSnapshot().shapes[0]?.x).toBe(40);
    e.undo();
    e.undo();
    expect(ids(e)).toEqual([]);
  });

  test("a cancelled gesture puts things back and leaves nothing to undo", () => {
    const { e } = editor();
    const id = e.create(box);
    e.begin("Resize");
    e.update(id, { w: 99 });
    e.cancel();
    expect(e.getSnapshot().shapes[0]?.w).toBe(10);
    expect(e.getSnapshot().undoLabel).toBe("Add rectangle");
  });

  test("a new change after an undo clears redo", () => {
    const { e } = editor();
    const id = e.create(box);
    e.update(id, { x: 5 }, "Move");
    e.undo();
    e.update(id, { y: 5 }, "Move");
    expect(e.getSnapshot().redoLabel).toBeNull();
  });

  test("undoing a delete restores the shapes", () => {
    const { e } = editor();
    const a = e.create(box);
    const b = e.create(box);
    e.remove([a, b]);
    expect(ids(e)).toEqual([]);
    expect(e.getSnapshot().undoLabel).toBe("Delete 2 shapes");
    e.undo();
    expect(ids(e)).toEqual([a, b]);
  });

  test("undo is a new edit: its operations are stamped later than the ones it reverses", () => {
    const { e, sent } = editor();
    const id = e.create(box);
    e.update(id, { x: 9 });
    e.undo();
    const counters = sent.map((op) => op.stamp.counter);
    expect(counters).toEqual([...counters].sort((a, b) => a - b));
    expect(sent.at(-1)?.set).toEqual({ x: 0 });
  });

  test("nothing to undo in the middle of a gesture", () => {
    const { e } = editor();
    const id = e.create(box);
    e.begin("Move");
    e.update(id, { x: 3 });
    e.undo();
    e.commit();
    expect(e.getSnapshot().shapes[0]?.x).toBe(3);
  });

  test("a group that changed nothing leaves no step", () => {
    const { e } = editor();
    e.begin("Nothing");
    e.commit();
    expect(e.getSnapshot().undoLabel).toBeNull();
  });
});

describe("stacking", () => {
  test("bring to front and send to back keep the moved shapes' own order", () => {
    const { e } = editor();
    const [a, b, c, d] = [e.create(box), e.create(box), e.create(box), e.create(box)];
    e.bringToFront([a, b]);
    expect(ids(e)).toEqual([c, d, a, b]);
    e.sendToBack([d, b]);
    expect(ids(e)).toEqual([d, b, c, a]);
    e.undo();
    expect(ids(e)).toEqual([c, d, a, b]);
  });

  test("shapes already on top, or at the bottom, are left alone", () => {
    const { e } = editor();
    const [a, b] = [e.create(box), e.create(box)];
    e.bringToFront([b]);
    e.sendToBack([a]);
    expect(e.getSnapshot().undoLabel).toBe("Add rectangle");
  });
});

test("coordinates are rounded to hundredths and kept inside the board's limits", () => {
  const { e } = editor();
  const id = e.create({ ...box, x: 1.23456, y: -1e12 });
  expect(e.getSnapshot().shapes[0]).toMatchObject({ x: 1.23, y: -10_000_000 });
  e.update(id, { x: Number.MAX_VALUE });
  expect(e.getSnapshot().shapes[0]?.x).toBe(10_000_000);
});

test("every operation the editor sends passes the network's checks", () => {
  const { e, sent } = editor();
  const id = e.create({ kind: "note", x: 1, y: 2, w: 30, h: 30, text: "hi", fill: "yellow" });
  e.update(id, { text: "hello", stroke: "blue" });
  e.bringToFront([id]);
  e.remove([id]);
  e.undo();
  e.redo();
  for (const op of sent) {
    expect(parseOperation(JSON.parse(JSON.stringify(op))).ok).toBe(true);
  }
});

test("subscribers hear about every change", () => {
  const { e } = editor();
  let heard = 0;
  const stop = e.subscribe(() => heard++);
  e.create(box);
  expect(heard).toBeGreaterThan(0);
  stop();
  const before = heard;
  e.create(box);
  expect(heard).toBe(before);
});
