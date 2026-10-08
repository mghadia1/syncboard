import {
  type Operation,
  type Parsed,
  type Peer,
  type Presence,
  isBoardId,
  isClientId,
  parseOperation,
  parsePresence,
} from "@syncboard/shared";

/**
 * What the servers sharing boards tell each other (rooms.ts), and the
 * channel it goes through: Redis pub/sub in production (redis-bus.ts), a
 * LocalNetwork in tests.
 *
 * A bus is only for speed. Pub/sub delivers each message at most once, to
 * whoever is listening at that moment, and a server may die between
 * storing an edit and publishing it; so nothing a server needs for a
 * correct board travels only here. Edits are on disk first, numbered; a
 * server that finds a number missing reads the board's changes from disk
 * (Room.tick). Presence is repeated (rosters), and expires.
 */

export type BusMessage =
  /** Edits stored as change number `seq` of the board (see Store.save). */
  | { type: "ops"; seq: number; ops: readonly Operation[] }
  /** Someone on the sending server: who they are, what they are doing. */
  | { type: "presence"; client: string; presence: Presence }
  /** Someone has left the sending server. */
  | { type: "left"; client: string }
  /**
   * Everyone on the board at the sending server, repeated every few
   * seconds: what makes up for a lost presence or left, and the sign that
   * the server is alive. `ask` asks the others for theirs at once (a
   * server that has just loaded the board).
   */
  | { type: "roster"; peers: readonly Peer[]; ask: boolean };

/** A message as it travels: which server sent it, about which board. */
export type Envelope = { from: string; board: string; message: BusMessage };

export type BusStatus = "connected" | "disconnected";

export interface Bus {
  /** Starts hearing a board's messages. */
  join(board: string): void;
  /** Stops hearing them. */
  leave(board: string): void;
  /** Sends to every server that has joined the board, the sender possibly included; never waits. */
  publish(board: string, message: BusMessage): void;
  readonly status: BusStatus;
  close(): Promise<void>;
}

/** The handler a bus delivers to. */
export type Deliver = (envelope: Envelope) => void;

export function encodeEnvelope(envelope: Envelope): string {
  return JSON.stringify(envelope);
}

function parsePeers(value: unknown): Peer[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const peers: Peer[] = [];
  for (const item of value as unknown[]) {
    const { client, presence } = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const parsed = parsePresence(presence);
    if (!isClientId(client) || !parsed.ok) {
      return null;
    }
    peers.push({ client, presence: parsed.message });
  }
  return peers;
}

/**
 * Checks a message from the bus. Only servers publish there, but a bad one
 * must not take this one down with it: it is checked like anything else
 * that arrives over a network.
 */
export function parseEnvelope(text: string): Parsed<Envelope> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
  const { from, board, message } = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  if (!isClientId(from) || !isBoardId(board) || typeof message !== "object" || message === null) {
    return { ok: false, error: "an envelope needs a sender, a board and a message" };
  }
  const fields = message as Record<string, unknown>;
  const wrap = (m: BusMessage): Parsed<Envelope> => ({ ok: true, message: { from, board, message: m } });
  switch (fields.type) {
    case "ops": {
      if (typeof fields.seq !== "number" || !Number.isSafeInteger(fields.seq) || fields.seq < 1) {
        return { ok: false, error: "ops need a change number" };
      }
      if (!Array.isArray(fields.ops)) {
        return { ok: false, error: "ops must be a list" };
      }
      const ops: Operation[] = [];
      for (const item of fields.ops as unknown[]) {
        const parsed = parseOperation(item);
        if (!parsed.ok) {
          return { ok: false, error: `an operation: ${parsed.error}` };
        }
        ops.push(parsed.message);
      }
      return wrap({ type: "ops", seq: fields.seq, ops });
    }
    case "presence": {
      const presence = parsePresence(fields.presence);
      if (!isClientId(fields.client) || !presence.ok) {
        return { ok: false, error: "presence needs a client id and a presence" };
      }
      return wrap({ type: "presence", client: fields.client, presence: presence.message });
    }
    case "left":
      if (!isClientId(fields.client)) {
        return { ok: false, error: "left needs a client id" };
      }
      return wrap({ type: "left", client: fields.client });
    case "roster": {
      const peers = parsePeers(fields.peers);
      if (!peers || typeof fields.ask !== "boolean") {
        return { ok: false, error: "a roster needs peers and ask" };
      }
      return wrap({ type: "roster", peers, ask: fields.ask });
    }
    default:
      return { ok: false, error: `unknown message type ${JSON.stringify(fields.type)}` };
  }
}

/**
 * Buses in one process, for tests: delivered later (never during the
 * publish call, as with a real network), encoded and parsed on the way, and
 * with a hook that can lose or hold back any message, to stand in for what
 * pub/sub does when a connection drops.
 */
export class LocalNetwork {
  readonly #buses = new Set<LocalBus>();
  /** Return false to lose a message on its way to one server. */
  pass: (envelope: Envelope, to: string) => boolean = () => true;
  /** Extra delay per delivery, in milliseconds (0: the next turn of the event loop). */
  delayMs: (envelope: Envelope, to: string) => number = () => 0;
  /** Messages published so far (all of them, lost or not). */
  published = 0;

  bus(id: string, deliver: Deliver): LocalBus {
    const bus = new LocalBus(this, id, deliver);
    this.#buses.add(bus);
    return bus;
  }

  /** @internal */
  send(text: string, envelope: Envelope): void {
    this.published++;
    for (const bus of this.#buses) {
      if (!bus.hears(envelope.board) || !this.pass(envelope, bus.id)) {
        continue;
      }
      const delay = this.delayMs(envelope, bus.id);
      setTimeout(() => {
        const parsed = parseEnvelope(text);
        if (parsed.ok && bus.hears(parsed.message.board)) {
          bus.deliver(parsed.message);
        }
      }, delay);
    }
  }

  /** @internal */
  remove(bus: LocalBus): void {
    this.#buses.delete(bus);
  }
}

export class LocalBus implements Bus {
  readonly #boards = new Set<string>();
  /** Set to false to cut this server off the network (it publishes and hears nothing). */
  up = true;

  constructor(
    private readonly network: LocalNetwork,
    readonly id: string,
    readonly deliver: Deliver,
  ) {}

  hears(board: string): boolean {
    return this.up && this.#boards.has(board);
  }

  join(board: string): void {
    this.#boards.add(board);
  }

  leave(board: string): void {
    this.#boards.delete(board);
  }

  publish(board: string, message: BusMessage): void {
    if (this.up) {
      const envelope = { from: this.id, board, message };
      this.network.send(encodeEnvelope(envelope), envelope);
    }
  }

  get status(): BusStatus {
    return this.up ? "connected" : "disconnected";
  }

  close(): Promise<void> {
    this.network.remove(this);
    return Promise.resolve();
  }
}
