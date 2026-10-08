import {
  type ClientMessage,
  CloseCode,
  type Operation,
  PROTOCOL_VERSION,
  type ServerMessage,
  fromSnapshot,
  parseClientMessage,
  toSnapshot,
} from "@syncboard/shared";
import type { RawData, WebSocket } from "ws";
import type { Log } from "./log.js";
import { type Member, type Refusal, type Room, type Rooms, entriesAsOperations } from "./rooms.js";
import { StorageError } from "./store.js";
import { VERSION } from "./version.js";

/**
 * One connection, from hello to close: join a room, take the replica's
 * operations (checked, applied, relayed to the room, acknowledged), take
 * an uploaded state the same way, pass presence on, and leave the room on
 * close (telling the others, unless the client is still there on another
 * connection).
 */

function text(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

const CLOSE_FOR: Record<Refusal["code"], number> = {
  bad_message: CloseCode.BadMessage,
  not_joined: CloseCode.BadMessage,
  unsupported_protocol: CloseCode.UnsupportedProtocol,
  bad_operation: CloseCode.BadOperation,
  not_yours: CloseCode.BadOperation,
  board_limit: CloseCode.BoardLimit,
  storage_failed: CloseCode.StorageFailed,
};

export function handleConnection(ws: WebSocket, rooms: Rooms, log: Log): void {
  let joined: { room: Room; member: Member } | null = null;

  function send(message: ServerMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  function refuse(refusal: Refusal): void {
    log("refused", { code: refusal.code, message: refusal.message, board: joined?.room.board });
    send({ type: "error", code: refusal.code, message: refusal.message });
    ws.close(CLOSE_FOR[refusal.code], refusal.code);
  }

  /**
   * The store failed: the room's replica may be ahead of the disk, so it
   * is dropped (the next join reloads what is on disk), and the server
   * takes no more edits until restarted. Nothing unstored was acknowledged.
   */
  function storageFailed(error: unknown, room: Room | null): void {
    const message = error instanceof Error ? error.message : String(error);
    log("storage failed", { error: message });
    rooms.failed = message;
    if (room && rooms.peek(room.board) === room) {
      rooms.unload(room.board);
    }
    refuse({ code: "storage_failed", message: "the server cannot store this board; your edits are kept" });
  }

  function hello(message: Extract<ClientMessage, { type: "hello" }>): void {
    if (joined) {
      refuse({ code: "bad_message", message: "already joined a board" });
      return;
    }
    if (message.protocol !== PROTOCOL_VERSION) {
      refuse({
        code: "unsupported_protocol",
        message: `this server speaks protocol ${String(PROTOCOL_VERSION)}, not ${String(message.protocol)}`,
      });
      return;
    }
    let room: Room | null;
    try {
      room = rooms.get(message.board);
    } catch (error) {
      if (error instanceof StorageError) {
        storageFailed(error, null);
        return;
      }
      throw error;
    }
    if (!room) {
      refuse({ code: "board_limit", message: `this server holds at most ${String(rooms.limits.maxBoards)} boards` });
      return;
    }
    const member: Member = { client: message.client, send, presence: null };
    room.members.add(member);
    joined = { room, member };
    log("joined", { board: room.board, client: message.client, members: room.members.size });
    // The snapshot and joining happen in one turn of the event loop: no
    // operation can fall between what the snapshot holds and what is relayed.
    send({
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      version: VERSION,
      board: room.board,
      epoch: room.epoch,
      snapshot: toSnapshot(room.replica.state),
      peers: room.peersFor(member),
    });
  }

  function acknowledge(ops: readonly Operation[], client: string): void {
    let upTo = 0;
    for (const op of ops) {
      if (op.stamp.client === client) {
        upTo = Math.max(upTo, op.stamp.counter);
      }
    }
    if (upTo > 0) {
      send({ type: "ack", upTo });
    }
  }

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      refuse({ code: "bad_message", message: "binary frames are not used" });
      return;
    }
    const parsed = parseClientMessage(text(data));
    if (!parsed.ok) {
      refuse({
        code: parsed.error.startsWith("operation") ? "bad_operation" : "bad_message",
        message: parsed.error,
      });
      return;
    }
    const message = parsed.message;
    if (message.type === "hello") {
      hello(message);
      return;
    }
    if (!joined) {
      refuse({ code: "not_joined", message: "say hello first" });
      return;
    }
    const { room, member } = joined;
    if (message.type !== "presence" && rooms.failed !== null) {
      refuse({ code: "storage_failed", message: "the server cannot store boards until it is restarted; your edits are kept" });
      return;
    }
    if (message.type === "presence") {
      member.presence = message.presence;
      room.relay({ type: "presence", client: member.client, presence: message.presence }, member);
      return;
    }
    if (message.type === "ops") {
      const refusal = room.check(message.ops, member.client);
      if (refusal) {
        refuse(refusal);
        return;
      }
      let changed: Operation[];
      try {
        changed = room.apply(message.ops);
      } catch (error) {
        if (error instanceof StorageError) {
          storageFailed(error, room);
          return;
        }
        throw error;
      }
      if (changed.length > 0) {
        room.relay({ type: "ops", ops: changed }, member);
      }
      acknowledge(message.ops, member.client);
      return;
    }
    // An uploaded state: the server's copy of the board was new to this
    // replica, which may hold edits the server lost.
    const state = fromSnapshot(message.snapshot);
    const entries = entriesAsOperations(state);
    const refusal = room.check(entries, null);
    if (refusal) {
      refuse(refusal);
      return;
    }
    let changed: Operation[];
    try {
      changed = room.absorb(state);
    } catch (error) {
      if (error instanceof StorageError) {
        storageFailed(error, room);
        return;
      }
      throw error;
    }
    for (let i = 0; i < changed.length; i += 500) {
      room.relay({ type: "ops", ops: changed.slice(i, i + 500) }, member);
    }
    acknowledge(entries, member.client);
  });

  ws.on("close", () => {
    if (joined) {
      const { room, member } = joined;
      if (room.leave(member)) {
        room.relay({ type: "left", client: member.client }, member);
      }
      // The board is on disk: an empty room need not stay in memory.
      if (room.members.size === 0 && rooms.peek(room.board) === room) {
        rooms.unload(room.board);
      }
      log("left", { board: room.board, client: member.client, members: room.members.size });
    }
  });
}
