import {
  type BoardState,
  MAX_COORDINATE,
  type NewShape,
  type Operation,
  PROP_NAMES,
  type PropName,
  Replica,
  type Shape,
  type ShapeId,
  type ShapeProps,
  type Stamp,
  compareStamps,
  keyAfter,
  keyBefore,
} from "@syncboard/shared";
import { clamp, round } from "./geometry";

/**
 * The board as the page edits it: a replica, plus undo and redo.
 *
 * Every change is an operation on the replica, sent to everyone on the
 * board. Undo does not rewind anything: it makes new operations that set
 * the changed properties back to the values they had, so it is an edit
 * like any other. A gesture (a drag, a resize) is grouped between begin()
 * and commit() into one undo step, however many operations it made.
 *
 * Undo and redo revert only this person's changes. For each property a
 * step changed, the editor remembers the stamp of the edit that last wrote
 * it here; for each property on the board, the newest edit by anyone else.
 * A property someone else has written since this step wrote it is left
 * as it is. Asking "is the current value still mine?" is not enough: move
 * a shape, someone else moves it, move it again, and undo twice: the
 * second undo would find a value of its own (the first undo's) and wipe
 * the other person's move.
 */

/** One property a step changed: before it, after it, and the stamp of the edit that last wrote it. */
type Change = { readonly before: unknown; after: unknown; stamp: Stamp };
type Changes = Map<ShapeId, Map<PropName, Change>>;
type Step = { readonly label: string; readonly changes: Changes };

/** What an undo or redo did: how many properties it reverted, how many it left to others. */
export type Outcome = { readonly label: string; readonly reverted: number; readonly kept: number };

export type Snapshot = {
  readonly shapes: readonly Shape[];
  /** What undo would undo ("Add rectangle"), or null if nothing. */
  readonly undoLabel: string | null;
  readonly redoLabel: string | null;
};

type Open = { label: string; changes: Changes };

const key = (shape: ShapeId, name: PropName) => `${shape}\u0000${name}`;

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
  /** For each property, the newest stamp of an edit by anyone else. */
  #foreign = new Map<string, Stamp>();
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
    this.#open = { label, changes: new Map() };
  }

  /** Ends the group; a group that changed nothing leaves no undo step. */
  commit(): void {
    const open = this.#open;
    this.#open = null;
    if (!open || open.changes.size === 0) {
      return;
    }
    this.#undo.push({ label: open.label, changes: open.changes });
    this.#redo = [];
    this.#changed();
  }

  /** Ends the group by putting back what it changed, leaving no undo step. */
  cancel(): void {
    const open = this.#open;
    this.#open = null;
    if (open) {
      this.#revert(open.changes, "before");
      this.#changed();
    }
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
      for (const name of Object.keys(op.set) as PropName[]) {
        this.#noteForeign(op.shape, name, op.stamp);
      }
      changed = this.replica.apply(op) || changed;
    }
    if (changed) {
      this.#changed();
    }
  }

  /** A whole board from the network (the server's snapshot), merged in. */
  mergeRemote(state: BoardState): void {
    for (const [shape, entries] of state) {
      for (const name of PROP_NAMES) {
        const entry = entries[name];
        if (entry) {
          this.#noteForeign(shape, name, entry.stamp);
        }
      }
    }
    if (this.replica.merge(state)) {
      this.#changed();
    }
  }

  create(shape: NewShape, label = `Add ${shape.kind}`): ShapeId {
    return this.#within(label, () => {
      const op = this.replica.create(clampCoordinates(shape) as NewShape);
      // Before it existed, a shape is as good as deleted: undo deletes it.
      this.#record(op, { deleted: true });
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

  /** Undoes this person's last step, except what others have changed since; null if nothing. */
  undo(): Outcome | null {
    return this.#travel(this.#undo, this.#redo, "before");
  }

  redo(): Outcome | null {
    return this.#travel(this.#redo, this.#undo, "after");
  }

  #travel(from: Step[], to: Step[], side: "before" | "after"): Outcome | null {
    if (this.#open) {
      return null; // not in the middle of a gesture
    }
    const step = from.pop();
    if (!step) {
      return null;
    }
    const { reverted, kept } = this.#revert(step.changes, side);
    to.push(step);
    this.#changed();
    return { label: step.label, reverted, kept };
  }

  /**
   * Sets each changed property to its value before (or after) the step,
   * as a new edit, except where someone else has written it since; the
   * step then remembers the new edit's stamp, for the next undo or redo.
   */
  #revert(changes: Changes, side: "before" | "after"): { reverted: number; kept: number } {
    let reverted = 0;
    let kept = 0;
    for (const [shape, props] of changes) {
      const set: Partial<Record<PropName, unknown>> = {};
      for (const [name, change] of props) {
        const value = change[side];
        if (value === undefined) {
          continue; // unknown before the step: nothing to put back
        }
        if (this.#othersSince(shape, name, change.stamp)) {
          kept++;
          continue;
        }
        set[name] = value;
      }
      const names = Object.keys(set) as PropName[];
      if (names.length > 0) {
        // Each value was recorded from its own property.
        const op = this.replica.set(shape, set as Partial<ShapeProps>);
        for (const name of names) {
          const change = props.get(name);
          if (change) {
            change.stamp = op.stamp;
          }
        }
        reverted += names.length;
        this.#send(op);
      }
    }
    return { reverted, kept };
  }

  #othersSince(shape: ShapeId, name: PropName, stamp: Stamp): boolean {
    const foreign = this.#foreign.get(key(shape, name));
    return foreign !== undefined && compareStamps(foreign, stamp) > 0;
  }

  #noteForeign(shape: ShapeId, name: PropName, stamp: Stamp): void {
    if (stamp.client === this.replica.client) {
      return;
    }
    const current = this.#foreign.get(key(shape, name));
    if (!current || compareStamps(stamp, current) > 0) {
      this.#foreign.set(key(shape, name), stamp);
    }
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
    const before = this.replica.values(id, Object.keys(props) as PropName[]);
    const op = this.replica.set(id, props);
    this.#record(op, before);
    this.#send(op);
  }

  /**
   * Records an edit in the open group: for each property, the value before
   * the group first changed it (the earliest wins), the value now, and
   * this edit's stamp.
   */
  #record(op: Operation, before: Partial<ShapeProps>): void {
    if (!this.#open) {
      return;
    }
    let props = this.#open.changes.get(op.shape);
    if (!props) {
      props = new Map();
      this.#open.changes.set(op.shape, props);
    }
    for (const name of Object.keys(op.set) as PropName[]) {
      const change = props.get(name);
      if (change) {
        change.after = op.set[name];
        change.stamp = op.stamp;
      } else {
        props.set(name, { before: before[name], after: op.set[name], stamp: op.stamp });
      }
    }
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
