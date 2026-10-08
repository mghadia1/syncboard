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
import { type Peer, type Refusal, type Room, type Rooms, entriesAsOperations } from "./rooms.js";
import { VERSION } from "./version.js";

/**
 * One connection, from hello to close: join a room, take the replica's
 * operations (checked, applied, relayed to the room, acknowledged), take
 * an uploaded state the same way, and leave the room on close.
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
};

export function handleConnection(ws: WebSocket, rooms: Rooms, log: Log): void {
  let joined: { room: Room; peer: Peer } | null = null;

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
    const room = rooms.get(message.board);
    if (!room) {
      refuse({ code: "board_limit", message: `this server holds at most ${String(rooms.limits.maxBoards)} boards` });
      return;
    }
    const peer: Peer = { client: message.client, send };
    room.peers.add(peer);
    joined = { room, peer };
    log("joined", { board: room.board, client: message.client, peers: room.peers.size });
    // The snapshot and joining happen in one turn of the event loop: no
    // operation can fall between what the snapshot holds and what is relayed.
    send({
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      version: VERSION,
      board: room.board,
      epoch: room.epoch,
      snapshot: toSnapshot(room.replica.state),
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
    const { room, peer } = joined;
    if (message.type === "ops") {
      const refusal = room.check(message.ops, peer.client);
      if (refusal) {
        refuse(refusal);
        return;
      }
      const changed = room.apply(message.ops);
      if (changed.length > 0) {
        room.relay({ type: "ops", ops: changed }, peer);
      }
      acknowledge(message.ops, peer.client);
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
    const changed = room.absorb(state);
    for (let i = 0; i < changed.length; i += 500) {
      room.relay({ type: "ops", ops: changed.slice(i, i + 500) }, peer);
    }
    acknowledge(entries, peer.client);
  });

  ws.on("close", () => {
    if (joined) {
      joined.room.peers.delete(joined.peer);
      log("left", { board: joined.room.board, client: joined.peer.client, peers: joined.room.peers.size });
    }
  });
}
