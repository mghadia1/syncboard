import fc from "fast-check";
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

describe("remote edits", () => {
  test("are drawn, but not undoable and not sent", () => {
    const { e, sent } = editor();
    const other = new Replica("other");
    const op = other.create({ kind: "rectangle", x: 0, y: 0, w: 5, h: 5 });
    let heard = 0;
    e.subscribe(() => heard++);
    e.applyRemote([op]);
    expect(ids(e)).toEqual([op.shape]);
    expect(e.getSnapshot().undoLabel).toBeNull();
    expect(sent).toEqual([]);
    expect(heard).toBe(1);
    e.applyRemote([op]); // nothing new: no change, no notification
    expect(heard).toBe(1);
  });

  test("a merged snapshot moves the clock: the next local edit is later than everything in it", () => {
    const { e, sent } = editor();
    const other = new Replica("other");
    for (let i = 0; i < 5; i++) {
      other.create({ kind: "ellipse", x: i, y: 0, w: 5, h: 5 });
    }
    e.mergeRemote(other.state);
    e.create({ kind: "rectangle", x: 0, y: 0, w: 5, h: 5 });
    expect(sent[0]?.stamp.counter).toBe(6);
  });
});

describe("undo with other people editing", () => {
  /** Another replica that has seen everything the editor has. */
  function other(e: Editor, name = "zz") {
    const r = new Replica(name);
    r.merge(e.replica.state);
    return r;
  }

  test("leaves a property someone else changed since, and reverts the rest", () => {
    const { e } = editor();
    const id = e.create(box);
    e.update(id, { x: 10, stroke: "red" });
    const zz = other(e);
    e.applyRemote([zz.update(id, { x: 50 })]);
    expect(e.undo()).toEqual({ label: "Edit", reverted: 1, kept: 1 });
    expect(e.getSnapshot().shapes[0]).toMatchObject({ x: 50, stroke: "ink" });
  });

  test("an older edit by someone else, arriving late, does not stop it", () => {
    const { e } = editor();
    const zz = new Replica("zz");
    const id = e.create(box); // counter 1
    zz.merge(e.replica.state);
    const late = zz.update(id, { x: 50 }); // counter 2, made before seeing our edit below
    e.update(id, { y: 1 }); // 2
    e.update(id, { x: 10 }); // 3: later than theirs (an equal counter would go to "zz" > "me")
    e.applyRemote([late]); // loses
    expect(e.getSnapshot().shapes[0]?.x).toBe(10);
    expect(e.undo()).toEqual({ label: "Edit", reverted: 1, kept: 0 });
    expect(e.getSnapshot().shapes[0]?.x).toBe(0);
  });

  test("move, they move, move again, undo twice: their move stays", () => {
    const { e } = editor();
    const id = e.create(box);
    e.update(id, { x: 10 }, "Move");
    const zz = other(e);
    e.applyRemote([zz.update(id, { x: 50 })]);
    e.update(id, { x: 20 }, "Move");
    e.undo(); // back to their 50
    expect(e.getSnapshot().shapes[0]?.x).toBe(50);
    // "Is the current value mine?" would say yes here (the undo wrote it)
    // and put back 0, wiping their move.
    expect(e.undo()).toEqual({ label: "Move", reverted: 0, kept: 1 });
    expect(e.getSnapshot().shapes[0]?.x).toBe(50);
  });

  test("redo leaves what others changed after the undo", () => {
    const { e } = editor();
    const id = e.create(box);
    e.update(id, { x: 10 }, "Move");
    e.undo();
    const zz = other(e);
    e.applyRemote([zz.update(id, { x: 70 })]);
    expect(e.redo()).toEqual({ label: "Move", reverted: 0, kept: 1 });
    expect(e.getSnapshot().shapes[0]?.x).toBe(70);
  });

  test("redo compares with the undo's own edit, not the original one", () => {
    const { e } = editor();
    const id = e.create(box);
    e.update(id, { x: 10 }, "Move"); // counter 2
    const zz = other(e); // has seen the move
    const between = zz.update(id, { x: 50 }); // counter 3: newer than the move...
    e.applyRemote([new Replica("aa").create({ ...box, x: 300 })]); // (pushes our clock to 1, no further)
    e.applyRemote([{ shape: "aa.99", stamp: { counter: 99, client: "aa" }, set: { x: 1 } }]); // to 99
    e.undo(); // counter 100
    e.applyRemote([between]); // ...but older than the undo: it loses
    expect(e.replica.shape(id)?.x).toBe(0);
    expect(e.redo()).toEqual({ label: "Move", reverted: 1, kept: 0 });
    expect(e.replica.shape(id)?.x).toBe(10);
  });

  test("others' edits in a merged board count; this replica's own do not", () => {
    const { e } = editor();
    const id = e.create(box);
    e.update(id, { x: 10 }, "Move");
    e.mergeRemote(e.replica.state); // its own edits, back from the server
    expect(e.undo()).toMatchObject({ reverted: 1, kept: 0 });
    e.redo();
    const zz = other(e);
    zz.update(id, { x: 80 });
    e.mergeRemote(zz.state);
    expect(e.undo()).toMatchObject({ reverted: 0, kept: 1 });
  });

  test("the server's copy of this replica's own later edit does not block undoing an earlier one", () => {
    const { e } = editor();
    const id = e.create(box);
    e.update(id, { x: 10 }, "Move");
    e.update(id, { x: 20 }, "Move");
    e.mergeRemote(e.replica.state); // a reconnect: the welcome's board holds our x = 20
    e.undo();
    expect(e.undo()).toEqual({ label: "Move", reverted: 1, kept: 0 });
    expect(e.replica.shape(id)?.x).toBe(0);
  });

  test("a cancelled gesture leaves what someone else changed during it", () => {
    const { e } = editor();
    const id = e.create(box);
    e.begin("Move");
    e.update(id, { x: 5, y: 5 });
    const zz = other(e);
    e.applyRemote([zz.update(id, { x: 99 })]);
    e.cancel();
    expect(e.getSnapshot().shapes[0]).toMatchObject({ x: 99, y: 0 });
  });

  test("undoing a creation deletes the shape even if others moved it: the rule is per property", () => {
    const { e } = editor();
    const id = e.create(box);
    const zz = other(e);
    e.applyRemote([zz.update(id, { x: 30 })]);
    expect(e.undo()).toEqual({ label: "Add rectangle", reverted: 1, kept: 0 });
    expect(e.getSnapshot().shapes).toEqual([]);
  });
});

describe("undo with other people editing: properties", () => {
  type Action =
    | { do: "mine"; shape: number; x: number; stroke: boolean }
    | { do: "theirs"; shape: number; x: number; seen: boolean }
    | { do: "undo" | "redo" };

  const action: fc.Arbitrary<Action> = fc.oneof(
    fc.record({ do: fc.constant("mine" as const), shape: fc.nat(2), x: fc.integer({ min: 1, max: 99 }), stroke: fc.boolean() }),
    fc.record({ do: fc.constant("theirs" as const), shape: fc.nat(2), x: fc.integer({ min: 100, max: 199 }), seen: fc.boolean() }),
    fc.record({ do: fc.constantFrom("undo" as const, "redo" as const) }),
  );

  test("undo and redo never overwrite a value someone else wrote that is still standing", () => {
    fc.assert(
      fc.property(fc.array(action, { maxLength: 40 }), (actions) => {
        const { e, sent } = editor();
        const ids = [0, 1, 2].map((i) => e.create({ ...box, x: i }));
        const zz = new Replica("zz");
        zz.merge(e.replica.state);
        for (const a of actions) {
          const id = "shape" in a ? ids[a.shape % ids.length] : undefined;
          if (a.do === "mine" && id) {
            e.update(id, a.stroke ? { x: a.x, stroke: "blue" } : { x: a.x });
          } else if (a.do === "theirs" && id) {
            if (a.seen) {
              zz.merge(e.replica.state); // or else a concurrent edit
            }
            e.applyRemote([zz.update(id, { x: a.x })]);
          } else if (a.do === "undo" || a.do === "redo") {
            const before = new Map(e.replica.state);
            const standing = new Map(
              [...before].map(([shape, props]) => [shape, { ...props }] as const),
            );
            const from = sent.length;
            if (a.do === "undo") {
              e.undo();
            } else {
              e.redo();
            }
            for (const op of sent.slice(from)) {
              for (const name of Object.keys(op.set) as (keyof typeof op.set)[]) {
                const entry = standing.get(op.shape)?.[name];
                expect(entry?.stamp.client).not.toBe("zz");
              }
            }
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  test("with nobody else editing, undoing everything gives back the start", () => {
    fc.assert(
      fc.property(fc.array(action.filter((a) => a.do !== "theirs"), { maxLength: 30 }), (actions) => {
        const { e } = editor();
        const ids = [0, 1, 2].map((i) => e.create({ ...box, x: i }));
        const start = e.getSnapshot().shapes;
        for (const a of actions) {
          const id = "shape" in a ? ids[a.shape % ids.length] : undefined;
          if (a.do === "mine" && id) {
            e.update(id, a.stroke ? { x: a.x, stroke: "blue" } : { x: a.x });
          } else if (a.do === "undo") {
            e.undo();
          } else if (a.do === "redo") {
            e.redo();
          }
        }
        // Undo everything, the three creations included: every shape is
        // back as it was created, and deleted.
        while (e.getSnapshot().undoLabel !== null) {
          e.undo();
        }
        expect(start).toHaveLength(3);
        for (const [i, id] of ids.entries()) {
          expect(e.replica.values(id, ["x", "stroke", "deleted"])).toEqual({ x: i, stroke: "ink", deleted: true });
        }
      }),
      { numRuns: 300 },
    );
  });
});
