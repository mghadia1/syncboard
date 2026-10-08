import {
  type BoardState,
  MAX_COORDINATE,
  type NewShape,
  type Operation,
  Replica,
  type Shape,
  type ShapeId,
  type ShapeProps,
  keyAfter,
  keyBefore,
} from "@syncboard/shared";
import { clamp, round } from "./geometry";

/**
 * The board as the page edits it: a replica, plus undo and redo.
 *
 * Every change is an operation on the replica (which will be sent to
 * other browsers in Milestone 3). Undo does not rewind anything: it makes
 * new operations that set the changed properties back to the values they
 * had, so it is an edit like any other and works the same with other
 * people's edits arriving in between. A gesture (a drag, a resize) is
 * grouped between begin() and commit() into one undo step, however many
 * operations it made on the way.
 */

type Change = { readonly shape: ShapeId; readonly set: Partial<ShapeProps> };
type Step = { readonly label: string; readonly undo: readonly Change[]; readonly redo: readonly Change[] };

export type Snapshot = {
  readonly shapes: readonly Shape[];
  /** What undo would undo ("Add rectangle"), or null if nothing. */
  readonly undoLabel: string | null;
  readonly redoLabel: string | null;
};

type Open = { label: string; before: Map<ShapeId, Partial<ShapeProps>> };

function clampCoordinates(props: Partial<ShapeProps>): Partial<ShapeProps> {
  const out: Partial<ShapeProps> = { ...props };
  for (const name of ["x", "y", "w", "h"] as const) {
    const value = out[name];
    if (value !== undefined) {
      out[name] = round(clamp(value, -MAX_COORDINATE, MAX_COORDINATE));
    }
  }
  return out;
}

export class Editor {
  readonly replica: Replica;
  #undo: Step[] = [];
  #redo: Step[] = [];
  #open: Open | null = null;
  #listeners = new Set<() => void>();
  #operationListeners = new Set<(op: Operation) => void>();
  #snapshot: Snapshot;

  constructor(replica: Replica = new Replica()) {
    this.replica = replica;
    this.#snapshot = this.#take();
  }

  // For useSyncExternalStore: arrow functions, so they can be passed as they are.
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): Snapshot => this.#snapshot;

  /** Every operation made here, as it is made: what sync will send. */
  onOperation(listener: (op: Operation) => void): () => void {
    this.#operationListeners.add(listener);
    return () => this.#operationListeners.delete(listener);
  }

  /** Starts grouping changes into one undo step. */
  begin(label: string): void {
    if (this.#open) {
      throw new Error(`"${this.#open.label}" is still open`);
    }
    this.#open = { label, before: new Map() };
  }

  /** Ends the group; a group that changed nothing leaves no undo step. */
  commit(): void {
    const open = this.#open;
    this.#open = null;
    if (!open || open.before.size === 0) {
      return;
    }
    const undo: Change[] = [];
    const redo: Change[] = [];
    for (const [shape, before] of open.before) {
      undo.push({ shape, set: before });
      redo.push({ shape, set: this.replica.values(shape, Object.keys(before) as (keyof ShapeProps)[]) });
    }
    this.#undo.push({ label: open.label, undo, redo });
    this.#redo = [];
    this.#changed();
  }

  /** Ends the group by putting back what it changed, leaving no undo step. */
  cancel(): void {
    const open = this.#open;
    this.#open = null;
    if (!open) {
      return;
    }
    for (const [shape, before] of open.before) {
      if (Object.keys(before).length > 0) {
        this.#send(this.replica.set(shape, before));
      }
    }
    this.#changed();
  }

  get inGesture(): boolean {
    return this.#open !== null;
  }

  /**
   * Other replicas' operations: applied, and drawn, but not undoable here
   * and not sent anywhere (they came from the network).
   */
  applyRemote(ops: readonly Operation[]): void {
    let changed = false;
    for (const op of ops) {
      changed = this.replica.apply(op) || changed;
    }
    if (changed) {
      this.#changed();
    }
  }

  /** A whole board from the network (the server's snapshot), merged in. */
  mergeRemote(state: BoardState): void {
    if (this.replica.merge(state)) {
      this.#changed();
    }
  }

  create(shape: NewShape, label = `Add ${shape.kind}`): ShapeId {
    return this.#within(label, () => {
      const op = this.replica.create(clampCoordinates(shape) as NewShape);
      // Before it existed, a shape is as good as deleted: undo deletes it.
      this.#remember(op.shape, { deleted: true });
      this.#send(op);
      return op.shape;
    });
  }

  update(id: ShapeId, change: Partial<Omit<ShapeProps, "kind" | "deleted">>, label = "Edit"): void {
    if (Object.keys(change).length === 0) {
      return;
    }
    this.#within(label, () => {
      this.#set(id, clampCoordinates(change));
    });
  }

  remove(ids: Iterable<ShapeId>): void {
    const list = [...ids];
    if (list.length === 0) {
      return;
    }
    this.#within(list.length === 1 ? "Delete shape" : `Delete ${String(list.length)} shapes`, () => {
      for (const id of list) {
        this.#set(id, { deleted: true });
      }
    });
  }

  /** Puts the shapes on top, keeping their order among themselves. */
  bringToFront(ids: Iterable<ShapeId>): void {
    const moving = new Set(ids);
    const shapes = this.replica.shapes();
    const ordered = shapes.filter((s) => moving.has(s.id));
    if (ordered.length === 0 || shapes.slice(-ordered.length).every((s) => moving.has(s.id))) {
      return; // already on top
    }
    this.#within("Bring to front", () => {
      let top = shapes.at(-1)?.z;
      for (const shape of ordered) {
        top = top === undefined ? shape.z : keyAfter(top);
        this.#set(shape.id, { z: top });
      }
    });
  }

  /** Puts the shapes at the bottom, keeping their order among themselves. */
  sendToBack(ids: Iterable<ShapeId>): void {
    const moving = new Set(ids);
    const shapes = this.replica.shapes();
    const ordered = shapes.filter((s) => moving.has(s.id));
    if (ordered.length === 0 || shapes.slice(0, ordered.length).every((s) => moving.has(s.id))) {
      return; // already at the bottom
    }
    this.#within("Send to back", () => {
      let bottom = shapes[0]?.z;
      for (const shape of ordered.reverse()) {
        bottom = bottom === undefined ? shape.z : keyBefore(bottom);
        this.#set(shape.id, { z: bottom });
      }
    });
  }

  undo(): void {
    this.#travel(this.#undo, this.#redo, "undo");
  }

  redo(): void {
    this.#travel(this.#redo, this.#undo, "redo");
  }

  #travel(from: Step[], to: Step[], direction: "undo" | "redo"): void {
    if (this.#open) {
      return; // not in the middle of a gesture
    }
    const step = from.pop();
    if (!step) {
      return;
    }
    for (const change of step[direction]) {
      if (Object.keys(change.set).length > 0) {
        this.#send(this.replica.set(change.shape, change.set));
      }
    }
    to.push(step);
    this.#changed();
  }

  /** Runs `body` inside the open group, or as a group of its own. */
  #within<T>(label: string, body: () => T): T {
    if (this.#open) {
      const result = body();
      this.#changed();
      return result;
    }
    this.begin(label);
    try {
      return body();
    } finally {
      this.commit();
      this.#changed();
    }
  }

  #set(id: ShapeId, props: Partial<ShapeProps>): void {
    this.#remember(id, this.replica.values(id, Object.keys(props) as (keyof ShapeProps)[]));
    this.#send(this.replica.set(id, props));
  }

  /** Records a shape's values before the group first changed them. */
  #remember(id: ShapeId, values: Partial<ShapeProps>): void {
    if (!this.#open) {
      return;
    }
    const before = this.#open.before.get(id) ?? {};
    this.#open.before.set(id, { ...values, ...before }); // the earliest value wins
  }

  #send(op: Operation): void {
    for (const listener of this.#operationListeners) {
      listener(op);
    }
  }

  #take(): Snapshot {
    const label = (steps: Step[]) => steps.at(-1)?.label ?? null;
    return { shapes: this.replica.shapes(), undoLabel: label(this.#undo), redoLabel: label(this.#redo) };
  }

  #changed(): void {
    this.#snapshot = this.#take();
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
