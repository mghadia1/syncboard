import {
  type BoardState,
  type Entry,
  type ErrorCode,
  type Operation,
  PROP_NAMES,
  type Peer,
  type Presence,
  type PropName,
  Replica,
  type ServerMessage,
  type ShapeId,
  newBoardId,
  newClientId,
} from "@syncboard/shared";
import type { Bus, BusMessage, Envelope } from "./bus.js";
import { type Log, silentLog } from "./log.js";
import { StorageError, type Store } from "./store.js";

/**
 * The boards the server is serving: one room per board, with the server's
 * own replica of it and the connections that have joined. The server never
 * edits a board; its replica gathers everyone's operations, decides what
 * wins, and the store keeps the result. A room is loaded from the store
 * when someone joins and dropped from memory when the last one leaves.
 *
 * Several servers can serve one board (replicas, sharing the store's file
 * and a bus). People on a board may be on any of them, so each server
 * passes on to the others, through the bus, what it passes on to its own
 * connections: edits (after storing them), presence, and who has left.
 * The bus may lose messages; what makes up for that:
 *
 * - Edits: each write to a board is numbered by the store (`seq`). A room
 *   knows the numbers it has (its own writes, and those the bus brought),
 *   and every tick it compares with the disk: a number the disk had at the
 *   last tick and the bus has still not brought is read from disk, with
 *   everything else written since. Any order, repeat or loss of messages
 *   ends with the same board, because merging is a CRDT.
 * - Presence: each server repeats who is on its boards (a roster) every
 *   `rosterMs`; a server not heard from for three of those has gone, and
 *   its people are taken off.
 */

export type Limits = {
  /** Boards stored; a hello for a new board beyond this is refused. */
  maxBoards: number;
  /**
   * Shapes (live or deleted) on one board, as this server has heard of
   * them: servers sharing a board could together go past it by what is
   * still on its way between them.
   */
  maxShapes: number;
};

// Counters are bounded too, for every replica alike: see MAX_COUNTER.
export const DEFAULT_LIMITS: Limits = { maxBoards: 1000, maxShapes: 20_000 };

/** How servers sharing boards keep in step. */
export type Timing = {
  /** How often each room compares what it has with the disk. */
  pollMs: number;
  /** How often each server says who is on its boards. */
  rosterMs: number;
};

export const DEFAULT_TIMING: Timing = { pollMs: 500, rosterMs: 2000 };

/** Rosters missed before a server's people are taken off its boards. */
const ROSTERS_MISSED = 3;

/** The most operations relayed to a browser in one message (the protocol's own limit is 1000). */
const RELAY_CHUNK = 500;

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

/** Another server's people on this board, and when it last spoke of them. */
type Remote = { peers: Map<string, Presence>; seen: number };

export class Room {
  readonly replica = new Replica("server");
  readonly members = new Set<Member>();
  /** Every change up to this number is in the replica. */
  #seq: number;
  /** Changes above #seq that are in the replica too (they came out of order). */
  readonly #heard = new Set<number>();
  /** The disk's change number at the last tick: by the next, the bus has had its chance. */
  #due = 0;
  #rosterAt = -Infinity;
  readonly #remote = new Map<string, Remote>();
  /** Times this room read changes from disk that the bus had not brought (for tests and logs). */
  caughtUp = 0;

  /**
   * `epoch` names the server's copy of the board (see the protocol). It is
   * stored with the board, so a restart keeps it: browsers then resend only
   * what was not acknowledged. A new one means the copy was lost.
   */
  constructor(
    readonly board: string,
    readonly epoch: string,
    seq: number,
    state: BoardState,
    private readonly limits: Limits,
    private readonly timing: Timing,
    private readonly store: Store,
    private readonly publish: (message: BusMessage) => void,
  ) {
    this.replica.merge(state);
    this.#seq = seq;
  }

  /** The change number up to which this room has everything. */
  get seq(): number {
    return this.#seq;
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
   * Applies checked operations, stores what they changed and tells the
   * other servers, before returning; returns the ones that changed
   * something. A StorageError leaves the replica ahead of the disk: the
   * caller must drop the room.
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
   * the winner, which may be a later value than the operation's own. Then
   * publishes them, under the change number the store gave the write.
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
    const seq = this.store.save(this.board, registers.values());
    // null: the disk had later values for all of it (another server's,
    // not yet heard here). They will come, by the bus or from the disk.
    if (seq !== null) {
      this.#hear(seq);
      this.publish({ type: "ops", seq, ops });
    }
  }

  #hear(seq: number): void {
    this.#heard.add(seq);
    this.#advance();
  }

  #advance(): void {
    while (this.#heard.delete(this.#seq + 1)) {
      this.#seq++;
    }
  }

  /** Sends to this server's members, but not to one client's own connections. */
  #send(message: ServerMessage, except: string | null): void {
    for (const member of this.members) {
      if (member.client !== except) {
        member.send(message);
      }
    }
  }

  /** Sends operations to every member here, in messages of a size browsers take. */
  #sendOps(ops: readonly Operation[]): void {
    for (let i = 0; i < ops.length; i += RELAY_CHUNK) {
      this.#send({ type: "ops", ops: ops.slice(i, i + RELAY_CHUNK) }, null);
    }
  }

  /** Sends to every member here but one, and but its other connections. */
  relay(message: ServerMessage, from: Member): void {
    this.#send(message, from.client);
  }

  /** A member says who it is and what it is doing: passed on here and to the other servers. */
  say(member: Member, presence: Presence): void {
    member.presence = presence;
    this.relay({ type: "presence", client: member.client, presence }, member);
    this.publish({ type: "presence", client: member.client, presence });
  }

  /**
   * Takes a member out. If that was its client's last connection here, the
   * other servers are told; and the members here too, unless the client is
   * still on the board through another server (a reconnect that landed
   * there first).
   */
  leave(member: Member): void {
    this.members.delete(member);
    if ([...this.members].some((other) => other.client === member.client)) {
      return;
    }
    this.publish({ type: "left", client: member.client });
    if (!this.#present(member.client)) {
      this.#send({ type: "left", client: member.client }, null);
    }
  }

  #present(client: string): boolean {
    for (const member of this.members) {
      if (member.client === client) {
        return true;
      }
    }
    for (const remote of this.#remote.values()) {
      if (remote.peers.has(client)) {
        return true;
      }
    }
    return false;
  }

  /** Everyone on the board, here or on another server, who has said who they are, except `to` itself. */
  peersFor(to: Member): Peer[] {
    const peers = new Map<string, Peer>();
    for (const remote of this.#remote.values()) {
      for (const [client, presence] of remote.peers) {
        peers.set(client, { client, presence });
      }
    }
    // This server's own connections are the freshest word on a client.
    for (const member of this.members) {
      if (member.presence) {
        peers.set(member.client, { client: member.client, presence: member.presence });
      }
    }
    peers.delete(to.client);
    return [...peers.values()];
  }

  /** Tells the other servers who is here; `ask` asks them to answer with theirs. */
  announce(ask: boolean): void {
    const peers = new Map<string, Peer>();
    for (const member of this.members) {
      if (member.presence) {
        peers.set(member.client, { client: member.client, presence: member.presence });
      }
    }
    if (peers.size > 0 || ask) {
      this.publish({ type: "roster", peers: [...peers.values()], ask });
    }
  }

  /** A message from another server about this board. */
  receive(from: string, message: BusMessage, now: number): void {
    switch (message.type) {
      case "ops": {
        if (message.seq <= this.#seq || this.#heard.has(message.seq)) {
          return; // already here (from the disk, or a repeat)
        }
        const changed = message.ops.filter((op) => this.replica.apply(op));
        this.#hear(message.seq);
        this.#sendOps(changed);
        return;
      }
      case "presence": {
        this.#remoteOf(from, now).peers.set(message.client, message.presence);
        this.#send({ type: "presence", client: message.client, presence: message.presence }, message.client);
        return;
      }
      case "left": {
        this.#remoteOf(from, now).peers.delete(message.client);
        if (!this.#present(message.client)) {
          this.#send({ type: "left", client: message.client }, null);
        }
        return;
      }
      case "roster": {
        const remote = this.#remoteOf(from, now);
        const before = remote.peers;
        remote.peers = new Map(message.peers.map((peer) => [peer.client, peer.presence]));
        for (const [client, presence] of remote.peers) {
          if (JSON.stringify(before.get(client)) !== JSON.stringify(presence)) {
            this.#send({ type: "presence", client, presence }, client);
          }
        }
        for (const client of before.keys()) {
          if (!this.#present(client)) {
            this.#send({ type: "left", client }, null);
          }
        }
        if (message.ask) {
          this.announce(false);
        }
        return;
      }
    }
  }

  #remoteOf(server: string, now: number): Remote {
    let remote = this.#remote.get(server);
    if (!remote) {
      remote = { peers: new Map(), seen: now };
      this.#remote.set(server, remote);
    }
    remote.seen = now;
    return remote;
  }

  /**
   * Keeps this room in step with the other servers: reads from disk any
   * change the bus has not brought within a tick, repeats who is here every
   * `rosterMs`, and takes off the people of a server that has gone quiet.
   * Throws StorageError if the disk cannot be read.
   */
  tick(now: number): void {
    const stored = this.store.seqOf(this.board);
    if (stored === null) {
      throw new StorageError(`board ${this.board} is no longer stored`);
    }
    if (this.#due > this.#seq) {
      this.#catchUp();
    }
    this.#due = stored;
    if (now - this.#rosterAt >= this.timing.rosterMs) {
      this.#rosterAt = now;
      this.announce(false);
    }
    for (const [server, remote] of this.#remote) {
      if (now - remote.seen > ROSTERS_MISSED * this.timing.rosterMs) {
        this.#remote.delete(server);
        for (const client of remote.peers.keys()) {
          if (!this.#present(client)) {
            this.#send({ type: "left", client }, null);
          }
        }
      }
    }
  }

  /** Reads what was written since the last change this room has, merges it, and passes on what was new. */
  #catchUp(): void {
    const changes = this.store.changesSince(this.board, this.#seq);
    const changed = this.replica.absorb(changes.state);
    this.caughtUp++;
    if (changes.seq > this.#seq) {
      this.#seq = changes.seq;
    }
    for (const seq of this.#heard) {
      if (seq <= this.#seq) {
        this.#heard.delete(seq);
      }
    }
    this.#advance();
    this.#sendOps(changed);
  }
}

export type RoomsOptions = {
  limits?: Limits;
  timing?: Timing;
  /** This server's id on the bus. */
  id?: string;
  log?: Log;
};

export class Rooms {
  readonly #rooms = new Map<string, Room>();
  readonly limits: Limits;
  readonly timing: Timing;
  readonly id: string;
  readonly #log: Log;
  /** Where rooms are shared with other servers; null when this server is alone. */
  bus: Bus | null = null;
  /** Set when the store failed: no more writes until a restart. */
  failed: string | null = null;

  constructor(
    readonly store: Store,
    options: RoomsOptions = {},
  ) {
    this.limits = options.limits ?? DEFAULT_LIMITS;
    this.timing = options.timing ?? DEFAULT_TIMING;
    this.id = options.id ?? newClientId();
    this.#log = options.log ?? silentLog;
  }

  /**
   * The board's room: in memory, or loaded from the store, or a new board
   * (stored at once, with its epoch, unless another server stored it
   * first); null if a new one would exceed the limit. Throws StorageError
   * if the store cannot read or write.
   */
  get(board: string): Room | null {
    let room = this.#rooms.get(board);
    if (room) {
      return room;
    }
    let stored = this.store.load(board);
    if (!stored) {
      if (this.store.create(board, newBoardId(), this.limits.maxBoards) === null) {
        return null;
      }
      stored = this.store.load(board);
      if (!stored) {
        throw new StorageError(`board ${board} was stored, then could not be read`);
      }
    }
    room = new Room(board, stored.epoch, stored.seq, stored.state, this.limits, this.timing, this.store, (message) => {
      this.bus?.publish(board, message);
    });
    this.#rooms.set(board, room);
    // Heard from now on: what was published before the bus had joined is
    // found on disk at the next ticks.
    this.bus?.join(board);
    room.announce(true);
    return room;
  }

  peek(board: string): Room | undefined {
    return this.#rooms.get(board);
  }

  /** Drops a room from memory: when its last member has left, or its replica got ahead of the disk. */
  unload(board: string): void {
    if (this.#rooms.delete(board)) {
      this.bus?.leave(board);
    }
  }

  /** Rooms in memory. */
  get size(): number {
    return this.#rooms.size;
  }

  /** A message from the bus: for a room loaded here, from another server. */
  receive(envelope: Envelope, now: number = performance.now()): void {
    if (envelope.from === this.id) {
      return;
    }
    this.#rooms.get(envelope.board)?.receive(envelope.from, envelope.message, now);
  }

  /** Runs every room's tick; a disk that cannot be read stops the server taking edits, as a failed write does. */
  tick(now: number = performance.now()): void {
    for (const room of this.#rooms.values()) {
      try {
        room.tick(now);
      } catch (error) {
        if (!(error instanceof StorageError)) {
          throw error;
        }
        this.failed = error.message;
        this.#log("storage failed", { board: room.board, error: error.message });
        this.unload(room.board);
      }
    }
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
