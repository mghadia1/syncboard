import {
  type BoardState,
  type ErrorCode,
  type Operation,
  PROP_NAMES,
  type Peer,
  type Presence,
  Replica,
  type ServerMessage,
  newBoardId,
} from "@syncboard/shared";

/**
 * The boards the server holds, in memory (until persistence, Milestone 5):
 * one room per board, with the server's own replica of it and the
 * connections that have joined. The server never edits a board; its
 * replica only gathers everyone's operations, so that whoever joins next
 * can be sent the whole board.
 */

export type Limits = {
  /** Boards held at once; a hello for a new board beyond this is refused. */
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
  /** Names this copy of the board: a new one after every restart (see the protocol). */
  readonly epoch = newBoardId();
  readonly replica = new Replica("server");
  readonly members = new Set<Member>();

  constructor(
    readonly board: string,
    private readonly limits: Limits,
  ) {}


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

  /** Applies checked operations; returns the ones that changed something. */
  apply(ops: readonly Operation[]): Operation[] {
    return ops.filter((op) => this.replica.apply(op));
  }

  /** Merges an uploaded (checked) state; returns what was new, as operations. */
  absorb(state: BoardState): Operation[] {
    return this.replica.absorb(state);
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

  constructor(readonly limits: Limits = DEFAULT_LIMITS) {}

  /** The board's room, made if need be; null if that would exceed the limit. */
  get(board: string): Room | null {
    let room = this.#rooms.get(board);
    if (!room) {
      if (this.#rooms.size >= this.limits.maxBoards) {
        return null;
      }
      room = new Room(board, this.limits);
      this.#rooms.set(board, room);
    }
    return room;
  }

  peek(board: string): Room | undefined {
    return this.#rooms.get(board);
  }

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
