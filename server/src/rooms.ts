import {
  type BoardState,
  type Entry,
  type ErrorCode,
  type Operation,
  PROP_NAMES,
  type Peer,
  type PropName,
  type Presence,
  Replica,
  type ServerMessage,
  type ShapeId,
  newBoardId,
} from "@syncboard/shared";
import type { Store } from "./store.js";

/**
 * The boards the server is serving: one room per board, with the server's
 * own replica of it and the connections that have joined. The server never
 * edits a board; its replica gathers everyone's operations, decides what
 * wins, and the store keeps the result. A room is loaded from the store
 * when someone joins and dropped from memory when the last one leaves.
 */

export type Limits = {
  /** Boards stored; a hello for a new board beyond this is refused. */
  maxBoards: number;
  /** Shapes (live or deleted) on one board. */
  maxShapes: number;
};

// Counters are bounded too, for every replica alike: see MAX_COUNTER.
export const DEFAULT_LIMITS: Limits = { maxBoards: 1000, maxShapes: 20_000 };

/**
 * One joined connection, as a room sees it. A replica can have two at
 * once for a moment (a reconnect before the old connection is noticed
 * gone); members are kept per connection and shown to others per client.
 */
export type Member = {
  readonly client: string;
  send(message: ServerMessage): void;
  /** What it last said about itself; null until it says something. */
  presence: Presence | null;
};

export type Refusal = { code: ErrorCode; message: string };

export class Room {
  readonly replica = new Replica("server");
  readonly members = new Set<Member>();

  /**
   * `epoch` names the server's copy of the board (see the protocol). It is
   * stored with the board, so a restart keeps it: browsers then resend only
   * what was not acknowledged. A new one means the copy was lost.
   */
  constructor(
    readonly board: string,
    readonly epoch: string,
    state: BoardState,
    private readonly limits: Limits,
    private readonly store: Store,
  ) {
    this.replica.merge(state);
  }


  /**
   * Checks operations (already valid one by one) before any is applied, so
   * a batch is taken whole or not at all. `sender` is the client every
   * stamp must belong to: a replica sends only its own edits. (An uploaded
   * state carries others' stamps too; it is checked with no sender.)
   */
  check(ops: readonly Operation[], sender: string | null): Refusal | null {
    const newShapes = new Set<string>();
    for (const op of ops) {
      if (sender !== null && op.stamp.client !== sender) {
        return { code: "not_yours", message: `an operation stamped by ${op.stamp.client}, not by you` };
      }
      if (!this.replica.state.has(op.shape)) {
        newShapes.add(op.shape);
      }
    }
    if (this.replica.state.size + newShapes.size > this.limits.maxShapes) {
      return { code: "board_limit", message: `a board holds at most ${String(this.limits.maxShapes)} shapes` };
    }
    return null;
  }

  /**
   * Applies checked operations and stores what they changed, before
   * returning; returns the ones that changed something. A StorageError
   * leaves the replica ahead of the disk: the caller must drop the room.
   */
  apply(ops: readonly Operation[]): Operation[] {
    const changed = ops.filter((op) => this.replica.apply(op));
    this.#persist(changed);
    return changed;
  }

  /** Merges an uploaded (checked) state and stores what was new; returns it, as operations. */
  absorb(state: BoardState): Operation[] {
    const changed = this.replica.absorb(state);
    this.#persist(changed);
    return changed;
  }

  /**
   * Writes the current register of every property the operations touched:
   * the winner, which may be a later value than the operation's own.
   */
  #persist(ops: readonly Operation[]): void {
    if (ops.length === 0) {
      return;
    }
    const registers = new Map<string, readonly [ShapeId, PropName, Entry]>();
    for (const op of ops) {
      const shape = this.replica.state.get(op.shape);
      for (const name of Object.keys(op.set) as PropName[]) {
        const entry = shape?.[name];
        if (entry) {
          registers.set(JSON.stringify([op.shape, name]), [op.shape, name, entry]);
        }
      }
    }
    this.store.save(this.board, registers.values());
  }

  /** Sends to every member but one, and but its other connections. */
  relay(message: ServerMessage, from: Member): void {
    for (const member of this.members) {
      if (member.client !== from.client) {
        member.send(message);
      }
    }
  }

  /** Everyone on the board who has said who they are, except `to` itself. */
  peersFor(to: Member): Peer[] {
    const peers = new Map<string, Peer>();
    for (const member of this.members) {
      if (member.client !== to.client && member.presence) {
        peers.set(member.client, { client: member.client, presence: member.presence });
      }
    }
    return [...peers.values()];
  }

  /** Takes a member out; true if that was its client's last connection. */
  leave(member: Member): boolean {
    this.members.delete(member);
    return ![...this.members].some((other) => other.client === member.client);
  }

}

export class Rooms {
  readonly #rooms = new Map<string, Room>();
  /** Set when the store failed: no more writes until a restart. */
  failed: string | null = null;

  constructor(
    readonly store: Store,
    readonly limits: Limits = DEFAULT_LIMITS,
  ) {}

  /**
   * The board's room: in memory, or loaded from the store, or a new board
   * (stored at once, with its epoch); null if a new one would exceed the
   * limit. Throws StorageError if the store cannot read or write.
   */
  get(board: string): Room | null {
    let room = this.#rooms.get(board);
    if (room) {
      return room;
    }
    const stored = this.store.load(board);
    if (stored) {
      room = new Room(board, stored.epoch, stored.state, this.limits, this.store);
    } else {
      if (this.store.boardCount >= this.limits.maxBoards) {
        return null;
      }
      const epoch = newBoardId();
      this.store.createBoard(board, epoch);
      room = new Room(board, epoch, new Map(), this.limits, this.store);
    }
    this.#rooms.set(board, room);
    return room;
  }

  peek(board: string): Room | undefined {
    return this.#rooms.get(board);
  }

  /** Drops a room from memory: when its last member has left, or its replica got ahead of the disk. */
  unload(board: string): void {
    this.#rooms.delete(board);
  }

  /** Rooms in memory. */
  get size(): number {
    return this.#rooms.size;
  }
}

/** A state's entries as operations, one per register, for checking. */
export function entriesAsOperations(state: BoardState): Operation[] {
  const ops: Operation[] = [];
  for (const [shape, entries] of state) {
    for (const name of PROP_NAMES) {
      const entry = entries[name];
      if (entry) {
        ops.push({ shape, stamp: entry.stamp, set: { [name]: entry.value } });
      }
    }
  }
  return ops;
}
