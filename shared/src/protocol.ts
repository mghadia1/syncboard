/**
 * The messages the server and the browser exchange over the WebSocket, as
 * JSON text frames. Both sides import these types, so a change to the
 * protocol that one side does not handle is a compile error, not a bug
 * found in production.
 *
 * Everything that arrives over the wire is `unknown` until it has been
 * checked: the parse functions below are the only way to get a typed
 * message, and they never trust the sender.
 *
 *   browser                                   server
 *   hello {board, client}           ───►
 *                                   ◄───      welcome {epoch, snapshot, peers}
 *   state {snapshot}  (if the epoch is new)   ───►
 *   ops [...]  (its own edits)      ───►      relayed as ops to the others
 *                                   ◄───      ack {upTo}
 *                                   ◄───      ops [...] (the others' edits)
 *   presence {...}                  ───►      relayed as presence {client, ...}
 *                                   ◄───      left {client}
 */
import { type Operation, parseOperation } from "./board/operation.js";
import { type Snapshot, parseSnapshot } from "./board/snapshot.js";
import { isBoardId, isClientId } from "./board/stamp.js";
import { type Presence, parsePresence } from "./presence.js";

/** Raised whenever a message's meaning changes; a mismatch is refused. */
export const PROTOCOL_VERSION = 3;

/** The largest frame the server accepts, in bytes. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

/** The most operations in one `ops` message. */
export const MAX_OPS_PER_MESSAGE = 1000;

export type ClientMessage =
  /** Join a board, as a replica. Must come first, once. */
  | { type: "hello"; protocol: number; board: string; client: string }
  /** Edits made by this replica, in the order it made them. */
  | { type: "ops"; ops: readonly Operation[] }
  /** (Part of) everything this replica knows: sent when the server's board is new to it. */
  | { type: "state"; snapshot: Snapshot }
  /** Who this is and what they are doing; replaces the last one. */
  | { type: "presence"; presence: Presence };

export type ErrorCode =
  | "bad_message"
  | "unsupported_protocol"
  | "not_joined"
  | "bad_operation"
  | "not_yours"
  | "board_limit";

/** Someone on the board, as presence tells it. */
export type Peer = { readonly client: string; readonly presence: Presence };

export type ServerMessage =
  /**
   * Joined. `epoch` names this copy of the board on the server: if a
   * replica saw a different one before, the server has lost what it knew
   * (a restart), and the replica uploads its state.
   */
  | {
      type: "welcome";
      protocol: number;
      version: string;
      board: string;
      epoch: string;
      snapshot: Snapshot;
      /** Everyone else on the board who has said who they are. */
      peers: readonly Peer[];
    }
  /** Other replicas' edits. */
  | { type: "ops"; ops: readonly Operation[] }
  /** Every edit of yours with a counter up to this one has been applied. */
  | { type: "ack"; upTo: number }
  /** Someone's presence, new or changed. */
  | { type: "presence"; client: string; presence: Presence }
  /** Someone has left the board. */
  | { type: "left"; client: string }
  | { type: "error"; code: ErrorCode; message: string };

/** WebSocket close codes this protocol uses (4000-4999 are for applications). */
export const CloseCode = {
  /** The standard "going away": the server is shutting down. */
  GoingAway: 1001,
  /** The standard "policy violation": a message that is not this protocol. */
  BadMessage: 1008,
  /** The client speaks a different protocol version. */
  UnsupportedProtocol: 4001,
  /** An operation was refused (malformed, or not the sender's). */
  BadOperation: 4002,
  /** The server has as many boards, or the board as many shapes, as it allows. */
  BoardLimit: 4003,
} as const;

export type Parsed<T> = { ok: true; message: T } | { ok: false; error: string };

type Fields = Record<string, unknown>;

function decode(text: string): Fields | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "not valid JSON";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "not a JSON object";
  }
  return value as Fields;
}

function isProtocol(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "bad_message",
  "unsupported_protocol",
  "not_joined",
  "bad_operation",
  "not_yours",
  "board_limit",
]);

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && ERROR_CODES.has(value);
}

function parseOps(value: unknown): Parsed<Operation[]> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_OPS_PER_MESSAGE) {
    return { ok: false, error: `ops must be 1 to ${String(MAX_OPS_PER_MESSAGE)} operations` };
  }
  const ops: Operation[] = [];
  for (const [i, item] of (value as unknown[]).entries()) {
    const parsed = parseOperation(item);
    if (!parsed.ok) {
      return { ok: false, error: `operation ${String(i)}: ${parsed.error}` };
    }
    ops.push(parsed.message);
  }
  return { ok: true, message: ops };
}

/**
 * Checks a frame from a browser. Fields the protocol does not know are
 * ignored, so a newer client's additions do not break an older server.
 */
export function parseClientMessage(text: string): Parsed<ClientMessage> {
  const fields = decode(text);
  if (typeof fields === "string") {
    return { ok: false, error: fields };
  }
  switch (fields.type) {
    case "hello":
      if (!isProtocol(fields.protocol)) {
        return { ok: false, error: "hello needs a positive integer protocol" };
      }
      // An old client's hello has no board: let it through, so the server
      // can say which protocol it speaks rather than "bad message".
      if (fields.protocol === PROTOCOL_VERSION && (!isBoardId(fields.board) || !isClientId(fields.client))) {
        return { ok: false, error: "hello needs a board id and a client id" };
      }
      return {
        ok: true,
        message: {
          type: "hello",
          protocol: fields.protocol,
          board: typeof fields.board === "string" ? fields.board : "",
          client: typeof fields.client === "string" ? fields.client : "",
        },
      };
    case "ops": {
      const ops = parseOps(fields.ops);
      return ops.ok ? { ok: true, message: { type: "ops", ops: ops.message } } : ops;
    }
    case "state": {
      const snapshot = parseSnapshot(fields.snapshot);
      return snapshot.ok ? { ok: true, message: { type: "state", snapshot: snapshot.message } } : snapshot;
    }
    case "presence": {
      const presence = parsePresence(fields.presence);
      return presence.ok ? { ok: true, message: { type: "presence", presence: presence.message } } : presence;
    }
    default:
      return { ok: false, error: `unknown message type ${JSON.stringify(fields.type)}` };
  }
}

function parsePeers(value: unknown): Parsed<Peer[]> {
  if (!Array.isArray(value)) {
    return { ok: false, error: "peers must be a list" };
  }
  const peers: Peer[] = [];
  for (const item of value as unknown[]) {
    const { client, presence } = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const parsed = parsePresence(presence);
    if (!isClientId(client) || !parsed.ok) {
      return { ok: false, error: "each peer needs a client id and a presence" };
    }
    peers.push({ client, presence: parsed.message });
  }
  return { ok: true, message: peers };
}

/** Checks a frame from the server. */
export function parseServerMessage(text: string): Parsed<ServerMessage> {
  const fields = decode(text);
  if (typeof fields === "string") {
    return { ok: false, error: fields };
  }
  switch (fields.type) {
    case "welcome": {
      if (
        !isProtocol(fields.protocol) ||
        typeof fields.version !== "string" ||
        !isBoardId(fields.board) ||
        typeof fields.epoch !== "string" ||
        fields.epoch === ""
      ) {
        return { ok: false, error: "welcome needs a protocol, version, board and epoch" };
      }
      const snapshot = parseSnapshot(fields.snapshot);
      if (!snapshot.ok) {
        return snapshot;
      }
      const peers = parsePeers(fields.peers);
      if (!peers.ok) {
        return peers;
      }
      return {
        ok: true,
        message: {
          type: "welcome",
          protocol: fields.protocol,
          version: fields.version,
          board: fields.board,
          epoch: fields.epoch,
          snapshot: snapshot.message,
          peers: peers.message,
        },
      };
    }
    case "ops": {
      const ops = parseOps(fields.ops);
      return ops.ok ? { ok: true, message: { type: "ops", ops: ops.message } } : ops;
    }
    case "ack":
      if (typeof fields.upTo !== "number" || !Number.isSafeInteger(fields.upTo) || fields.upTo < 1) {
        return { ok: false, error: "ack needs a counter" };
      }
      return { ok: true, message: { type: "ack", upTo: fields.upTo } };
    case "presence": {
      const presence = parsePresence(fields.presence);
      if (!isClientId(fields.client)) {
        return { ok: false, error: "presence needs a client id" };
      }
      return presence.ok
        ? { ok: true, message: { type: "presence", client: fields.client, presence: presence.message } }
        : presence;
    }
    case "left":
      if (!isClientId(fields.client)) {
        return { ok: false, error: "left needs a client id" };
      }
      return { ok: true, message: { type: "left", client: fields.client } };
    case "error":
      if (!isErrorCode(fields.code) || typeof fields.message !== "string") {
        return { ok: false, error: "error needs a known code and a message" };
      }
      return { ok: true, message: { type: "error", code: fields.code, message: fields.message } };
    default:
      return { ok: false, error: `unknown message type ${JSON.stringify(fields.type)}` };
  }
}
