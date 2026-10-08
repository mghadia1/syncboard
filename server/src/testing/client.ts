import { PROTOCOL_VERSION } from "@syncboard/shared";
import WebSocket from "ws";

/**
 * A protocol client for tests: raw WebSocket frames, what the server sends
 * queued so a test can wait for it. Not part of the build (see
 * tsconfig.build.json).
 */

const open: WebSocket[] = [];

/** Cuts every client connected since the last call (for afterEach). */
export function closeClients(): void {
  open.splice(0).forEach((ws) => {
    ws.terminate();
  });
}

export type Message = Record<string, unknown> & { type: string };

/** A protocol client that queues what the server sends, so tests can wait for it. */
export class Client {
  readonly inbox: Message[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  #wake: (() => void) | null = null;

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data: Buffer) => {
      this.inbox.push(JSON.parse(data.toString("utf8")) as Message);
      this.#wake?.();
    });
    this.closed = new Promise((resolve) => {
      ws.on("close", (code: number, reason: Buffer) => {
        resolve({ code, reason: reason.toString() });
        this.#wake?.();
      });
    });
  }

  static async connect(port: number): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
    open.push(ws);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return new Client(ws);
  }

  static async join(port: number, board: string, client: string): Promise<{ c: Client; welcome: Message }> {
    const c = await Client.connect(port);
    c.send({ type: "hello", protocol: PROTOCOL_VERSION, board, client });
    return { c, welcome: await c.next("welcome") };
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  /** The next message of this type (the ones before it are dropped). */
  async next(type: string, timeoutMs = 2000): Promise<Message> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.inbox.findIndex((m) => m.type === type);
      if (i >= 0) {
        const [message] = this.inbox.splice(0, i + 1).slice(-1);
        if (message) {
          return message;
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`no ${type} within ${String(timeoutMs)} ms; got ${JSON.stringify(this.inbox)}`);
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        setTimeout(resolve, 20);
      });
    }
  }

  /** Waits a moment and returns whatever of this type has arrived. */
  async drain(type: string, ms = 100): Promise<Message[]> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return this.inbox.filter((m) => m.type === type);
  }
}
