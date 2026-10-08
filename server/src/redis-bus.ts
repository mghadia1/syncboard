import { createClient } from "@redis/client";
import { type Bus, type BusMessage, type BusStatus, type Deliver, encodeEnvelope, parseEnvelope } from "./bus.js";
import type { Log } from "./log.js";

/**
 * The bus over Redis pub/sub: one channel per board, a connection to
 * publish on and one to listen on (a subscribed connection can do nothing
 * else). Redis stores nothing here: a message reaches whoever is listening
 * at that moment, or no one.
 *
 * The server never waits for Redis. It starts without it, keeps serving
 * while it is gone (the servers then find each other's edits on disk, at
 * the pace of Room.tick), and does not queue messages for later: a publish
 * while disconnected is dropped and counted.
 */

type Client = ReturnType<typeof createClient>;

export class RedisBus implements Bus {
  readonly #pub: Client;
  readonly #sub: Client;
  readonly #listener: (text: string) => void;
  #status: BusStatus = "disconnected";
  /** Publishes dropped because Redis was not there (for the logs). */
  dropped = 0;

  constructor(
    url: string,
    readonly id: string,
    deliver: Deliver,
    private readonly log: Log,
  ) {
    const socket = {
      connectTimeout: 2000,
      // Every 50 ms at first, doubling to every 2 s, jittered: servers that
      // lost Redis together do not all come back at once.
      reconnectStrategy: (retries: number) => Math.min(50 * 2 ** retries, 2000) * (0.5 + Math.random() / 2),
    };
    // Publishing fails at once while disconnected, rather than queueing
    // edits in memory for as long as Redis is gone.
    this.#pub = createClient({ url, socket, disableOfflineQueue: true });
    // Subscribing may wait for the connection; on reconnecting, the client
    // subscribes again to every channel it had.
    this.#sub = createClient({ url, socket });
    for (const client of [this.#pub, this.#sub]) {
      // Emitted on every failed attempt: without a listener, Node would throw.
      client.on("error", () => {
        this.#update();
      });
      client.on("ready", () => {
        this.#update();
      });
      client.on("end", () => {
        this.#update();
      });
    }
    this.#listener = (text) => {
      const parsed = parseEnvelope(text);
      if (parsed.ok) {
        deliver(parsed.message);
      } else {
        this.log("bad bus message", { error: parsed.error });
      }
    };
  }

  /** Connects in the background; resolves at once. */
  start(): void {
    for (const client of [this.#pub, this.#sub]) {
      client.connect().catch((error: unknown) => {
        this.log("bus failed", { error: error instanceof Error ? error.message : String(error) });
      });
    }
  }

  #update(): void {
    const status = this.#pub.isReady && this.#sub.isReady ? "connected" : "disconnected";
    if (status !== this.#status) {
      this.#status = status;
      this.log(status === "connected" ? "bus connected" : "bus disconnected", { dropped: this.dropped });
    }
  }

  get status(): BusStatus {
    return this.#status;
  }

  join(board: string): void {
    this.#sub.subscribe(channel(board), this.#listener).catch((error: unknown) => {
      this.log("bus subscribe failed", { board, error: String(error) });
    });
  }

  leave(board: string): void {
    this.#sub.unsubscribe(channel(board), this.#listener).catch((error: unknown) => {
      this.log("bus unsubscribe failed", { board, error: String(error) });
    });
  }

  publish(board: string, message: BusMessage): void {
    if (!this.#pub.isReady) {
      this.dropped++;
      return;
    }
    this.#pub.publish(channel(board), encodeEnvelope({ from: this.id, board, message })).catch(() => {
      this.dropped++;
    });
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      [this.#pub, this.#sub].map((client) => {
        if (client.isReady) {
          return client.close();
        }
        client.destroy();
        return Promise.resolve();
      }),
    );
  }
}

function channel(board: string): string {
  return `syncboard:board:${board}`;
}
