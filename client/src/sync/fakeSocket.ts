import type { CreateSocket } from "./sync";

/**
 * A WebSocket the test plays the server for: it records what the client
 * sends, and the test decides when it opens, what arrives, and when it
 * drops. For tests only.
 */
export class FakeSocket {
  readyState = 0; // CONNECTING
  readonly sent: { type: string; [key: string]: unknown }[] = [];
  closedWith: number | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(
    readonly url: string,
    private readonly wrap: (fn: () => void) => void,
  ) {}

  send(data: string): void {
    if (this.readyState !== 1) {
      throw new Error("send on a socket that is not open");
    }
    this.sent.push(JSON.parse(data) as { type: string });
  }

  close(code = 1000): void {
    this.closedWith = code;
    this.readyState = 3;
  }

  sentOfType(type: string) {
    return this.sent.filter((message) => message.type === type);
  }

  // The server's side:
  open(): void {
    this.readyState = 1;
    this.wrap(() => this.onopen?.());
  }

  receive(message: unknown): void {
    this.wrap(() => this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) }));
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.wrap(() => this.onclose?.({ code }));
  }
}

export class FakeNetwork {
  readonly sockets: FakeSocket[] = [];

  constructor(private readonly wrap: (fn: () => void) => void = (fn) => { fn(); }) {}

  create: CreateSocket = (url) => {
    const socket = new FakeSocket(url, this.wrap);
    this.sockets.push(socket);
    return socket as unknown as WebSocket;
  };

  last(): FakeSocket {
    const socket = this.sockets.at(-1);
    if (!socket) {
      throw new Error("no socket was opened");
    }
    return socket;
  }
}
