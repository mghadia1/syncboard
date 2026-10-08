import {
  CloseCode,
  type ClientMessage,
  type Operation,
  PROTOCOL_VERSION,
  type Presence,
  chunkSnapshot,
  fromSnapshot,
  parseServerMessage,
  toSnapshot,
} from "@syncboard/shared";
import type { Editor } from "../board/editor";

/**
 * Keeps an editor's board in step with everyone else's, through the
 * server, and survives the network failing in between.
 *
 * - Every operation made here goes into `pending` and is sent; it stays
 *   there until the server acknowledges it (`ack {upTo}`: every edit of
 *   ours up to that counter). Our counters only go up, so pending stays in
 *   counter order and an ack drops a prefix.
 * - When the connection drops, editing carries on; pending grows. The
 *   engine reconnects with exponential backoff and jitter, and on the new
 *   connection sends everything still pending. An edit the server had
 *   applied, but whose ack was lost, arrives twice: harmless, since
 *   applying an operation twice changes nothing (Milestone 1).
 * - Each welcome carries the server's whole board, merged in here, and an
 *   epoch. A different epoch from the last one means the server's copy is
 *   not the one we were talking to (it restarted, and lost it): then we
 *   upload everything we know, in chunks, and the server merges it; the
 *   pending edits follow, as on any reconnect.
 * - Some refusals are final (another protocol version, an operation the
 *   server will never take): retrying would loop, so the engine stops and
 *   says why.
 * - Presence (who this is, where its pointer is, what it has selected) is
 *   sent at most every PRESENCE_MS, the latest winning, and again after
 *   every welcome; others' presence is kept by client id until they leave.
 *   Offline, the engine cannot know who is there, so it forgets them.
 */

export type CreateSocket = (url: string) => WebSocket;

export type SyncStatus =
  | { readonly state: "connecting"; readonly pending: number }
  | { readonly state: "online"; readonly version: string; readonly pending: number }
  | { readonly state: "offline"; readonly pending: number; readonly retryInMs: number }
  | { readonly state: "refused"; readonly reason: string; readonly pending: number };

export type SyncOptions = {
  editor: Editor;
  board: string;
  url: string;
  createSocket?: CreateSocket;
  /** Reconnect delays: the first, and the most; doubling in between. */
  retry?: { firstMs: number; maxMs: number };
  /** How long to gather operations into one frame (a drag makes one per pointer move). */
  flushMs?: number;
  random?: () => number;
  /** Who this is; cursor and selection follow with setPresence. */
  presence?: Presence;
};

/** At most one presence message this often: a pointer moves 60 to 120 times a second. */
export const PRESENCE_MS = 40;

/** About this much JSON per frame: well under the server's 1 MiB limit. */
const FRAME_BYTES = 256 * 1024;
const OPS_PER_FRAME = 500;

/** Close codes after which reconnecting cannot help. */
const FINAL: ReadonlySet<number> = new Set([
  CloseCode.BadMessage,
  CloseCode.UnsupportedProtocol,
  CloseCode.BadOperation,
  CloseCode.BoardLimit,
]);

export class Sync {
  readonly #editor: Editor;
  readonly #board: string;
  readonly #url: string;
  readonly #create: CreateSocket;
  readonly #retry: { firstMs: number; maxMs: number };
  readonly #flushMs: number;
  readonly #random: () => number;

  #socket: WebSocket | null = null;
  #welcomed = false;
  #version = "";
  #pending: Operation[] = [];
  /** How many of `pending` have gone out on this connection. */
  #sent = 0;
  #epoch: string | null = null;
  #attempt = 0;
  #lastError: string | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #stopListening: (() => void) | null = null;
  #status: SyncStatus = { state: "connecting", pending: 0 };
  #presence: Presence | null;
  #presenceTimer: ReturnType<typeof setTimeout> | null = null;
  #presenceSentAt = -Infinity;
  #presenceDirty = false;
  #peers: ReadonlyMap<string, Presence> = new Map();
  readonly #listeners = new Set<() => void>();

  constructor(options: SyncOptions) {
    this.#editor = options.editor;
    this.#board = options.board;
    this.#url = options.url;
    this.#create = options.createSocket ?? ((url) => new WebSocket(url));
    this.#retry = options.retry ?? { firstMs: 500, maxMs: 10_000 };
    this.#flushMs = options.flushMs ?? 16;
    this.#random = options.random ?? Math.random;
    this.#presence = options.presence ?? null;
  }

  // For useSyncExternalStore.
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getStatus = (): SyncStatus => this.#status;

  /** Everyone else on the board, by client id. */
  getPeers = (): ReadonlyMap<string, Presence> => this.#peers;

  /** Changes this browser's presence; sent soon, at most every PRESENCE_MS. */
  setPresence(change: Partial<Presence>): void {
    if (!this.#presence) {
      return;
    }
    this.#presence = { ...this.#presence, ...change };
    this.#presenceDirty = true;
    this.#sendPresenceSoon();
  }

  /** Operations not yet acknowledged by the server. */
  get pending(): readonly Operation[] {
    return this.#pending;
  }

  start(): void {
    if (this.#stopListening) {
      return;
    }
    this.#stopListening = this.#editor.onOperation((op) => {
      this.#pending.push(op);
      this.#scheduleFlush();
      this.#refresh();
    });
    this.#connect();
  }

  /** Disconnects for good (the page is going away). Pending operations are kept. */
  stop(): void {
    this.#stopListening?.();
    this.#stopListening = null;
    for (const timer of [this.#retryTimer, this.#flushTimer, this.#presenceTimer]) {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
    this.#retryTimer = null;
    this.#flushTimer = null;
    this.#presenceTimer = null;
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      socket.onclose = null;
      socket.close(1000);
    }
  }

  #connect(): void {
    this.#retryTimer = null;
    this.#welcomed = false;
    this.#sent = 0;
    this.#lastError = null;
    this.#setStatus({ state: "connecting", pending: this.#pending.length });
    const socket = this.#create(this.#url);
    this.#socket = socket;
    socket.onopen = () => {
      this.#send(socket, { type: "hello", protocol: PROTOCOL_VERSION, board: this.#board, client: this.#editor.replica.client });
    };
    socket.onmessage = (event: MessageEvent) => {
      if (socket === this.#socket) {
        this.#receive(socket, event.data);
      }
    };
    socket.onclose = (event: CloseEvent) => {
      if (socket === this.#socket) {
        this.#closed(event.code);
      }
    };
  }

  #receive(socket: WebSocket, data: unknown): void {
    const parsed = typeof data === "string" ? parseServerMessage(data) : null;
    if (parsed === null || !parsed.ok) {
      // A server that sends nonsense will not stop by being asked again.
      this.#lastError = "the server sent something unreadable";
      this.#closed(CloseCode.BadMessage);
      socket.onclose = null;
      socket.close();
      return;
    }
    const message = parsed.message;
    switch (message.type) {
      case "welcome": {
        if (message.board !== this.#board) {
          this.#lastError = `joined ${message.board}, not ${this.#board}`;
          this.#closed(CloseCode.BadMessage);
          socket.close();
          return;
        }
        this.#editor.mergeRemote(fromSnapshot(message.snapshot));
        this.#welcomed = true;
        this.#version = message.version;
        this.#attempt = 0;
        if (message.epoch !== this.#epoch && this.#editor.replica.state.size > 0) {
          // The server's board is new to us: give it everything we have.
          // Pending edits are sent after it as usual, although the upload
          // holds their effects: an upload carries only each property's
          // winning value, so an edit of ours already overwritten by
          // someone else's is not in it, and would never be acknowledged
          // (found by the end-to-end test).
          for (const chunk of chunkSnapshot(toSnapshot(this.#editor.replica.state), FRAME_BYTES)) {
            this.#send(socket, { type: "state", snapshot: chunk });
          }
        }
        this.#epoch = message.epoch;
        this.#flush();
        this.#setPeers(new Map(message.peers.map((peer) => [peer.client, peer.presence])));
        this.#presenceDirty = true;
        this.#sendPresenceSoon();
        this.#refresh();
        return;
      }
      case "presence": {
        const peers = new Map(this.#peers);
        peers.set(message.client, message.presence);
        this.#setPeers(peers);
        return;
      }
      case "left": {
        const peers = new Map(this.#peers);
        peers.delete(message.client);
        this.#setPeers(peers);
        return;
      }
      case "ops":
        this.#editor.applyRemote(message.ops);
        return;
      case "ack": {
        let done = 0;
        while (done < this.#pending.length && (this.#pending[done]?.stamp.counter ?? Infinity) <= message.upTo) {
          done++;
        }
        this.#pending.splice(0, done);
        this.#sent = Math.max(0, this.#sent - done);
        this.#refresh();
        return;
      }
      case "error":
        this.#lastError = message.message;
        return;
    }
  }

  #closed(code: number): void {
    this.#socket = null;
    this.#welcomed = false;
    if (this.#peers.size > 0) {
      this.#setPeers(new Map());
    }
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (FINAL.has(code)) {
      this.#setStatus({
        state: "refused",
        reason: this.#lastError ?? `the server closed the connection (${String(code)})`,
        pending: this.#pending.length,
      });
      return;
    }
    const delay =
      Math.min(this.#retry.maxMs, this.#retry.firstMs * 2 ** this.#attempt) * (0.5 + this.#random() / 2);
    this.#attempt++;
    this.#setStatus({ state: "offline", pending: this.#pending.length, retryInMs: Math.round(delay) });
    this.#retryTimer = setTimeout(() => {
      this.#connect();
    }, delay);
  }

  #scheduleFlush(): void {
    if (this.#flushTimer === null && this.#welcomed) {
      this.#flushTimer = setTimeout(() => {
        this.#flushTimer = null;
        this.#flush();
      }, this.#flushMs);
    }
  }

  /** Sends whatever is pending and not yet sent on this connection, in frames. */
  #flush(): void {
    const socket = this.#socket;
    if (!socket || !this.#welcomed || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    while (this.#sent < this.#pending.length) {
      const batch: Operation[] = [];
      let bytes = 0;
      for (let i = this.#sent; i < this.#pending.length && batch.length < OPS_PER_FRAME; i++) {
        const op = this.#pending[i];
        if (!op) {
          break;
        }
        const size = JSON.stringify(op).length;
        if (batch.length > 0 && bytes + size > FRAME_BYTES) {
          break;
        }
        batch.push(op);
        bytes += size;
      }
      this.#send(socket, { type: "ops", ops: batch });
      this.#sent += batch.length;
    }
  }

  #sendPresenceSoon(): void {
    if (this.#presenceTimer !== null || !this.#welcomed) {
      return; // already due; or sent after the next welcome
    }
    const wait = Math.max(0, this.#presenceSentAt + PRESENCE_MS - Date.now());
    this.#presenceTimer = setTimeout(() => {
      this.#presenceTimer = null;
      const socket = this.#socket;
      if (!this.#presenceDirty || !this.#presence || !socket || !this.#welcomed) {
        return;
      }
      this.#send(socket, { type: "presence", presence: this.#presence });
      this.#presenceDirty = false;
      this.#presenceSentAt = Date.now();
    }, wait);
  }

  #setPeers(peers: ReadonlyMap<string, Presence>): void {
    this.#peers = peers;
    for (const listener of this.#listeners) {
      listener();
    }
  }

  #send(socket: WebSocket, message: ClientMessage): void {
    socket.send(JSON.stringify(message));
  }

  /** Recomputes the status after pending changed. */
  #refresh(): void {
    const pending = this.#pending.length;
    const status = this.#status;
    if (this.#welcomed) {
      this.#setStatus({ state: "online", version: this.#version, pending });
    } else if (status.pending !== pending) {
      this.#setStatus({ ...status, pending });
    }
  }

  #setStatus(status: SyncStatus): void {
    this.#status = status;
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
