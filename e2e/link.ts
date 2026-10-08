import net from "node:net";

/**
 * One client's network: a TCP proxy in front of the server. It can cut the
 * connections it carries, as a dropped Wi-Fi does, mid-message and without
 * a WebSocket close; and it can refuse new ones until healed, as a
 * partition does.
 */
export class Link {
  readonly #proxy: net.Server;
  readonly #sockets = new Set<net.Socket>();
  #blocked = false;
  #target: number;
  port = 0;

  private constructor(target: number) {
    this.#target = target;
    this.#proxy = net.createServer((client) => {
      if (this.#blocked) {
        client.destroy();
        return;
      }
      const upstream = net.connect(this.#target, "127.0.0.1");
      for (const [a, b] of [
        [client, upstream],
        [upstream, client],
      ] as const) {
        this.#sockets.add(a);
        a.on("data", (chunk: Buffer) => b.write(chunk));
        a.on("error", () => {
          b.destroy();
        });
        a.on("close", () => {
          this.#sockets.delete(a);
          b.destroy();
        });
      }
    });
  }

  static async open(target: number): Promise<Link> {
    const link = new Link(target);
    await new Promise<void>((resolve) => link.#proxy.listen(0, "127.0.0.1", resolve));
    link.port = (link.#proxy.address() as net.AddressInfo).port;
    return link;
  }

  /** Points the link at a server on another port (after a restart). */
  retarget(port: number): void {
    this.#target = port;
  }

  /** Drops every connection through the link, abruptly. */
  cut(): void {
    for (const socket of this.#sockets) {
      socket.destroy();
    }
  }

  /** Cuts, and refuses new connections until healed. */
  block(): void {
    this.#blocked = true;
    this.cut();
  }

  heal(): void {
    this.#blocked = false;
  }

  async close(): Promise<void> {
    this.cut();
    await new Promise<void>((resolve) => this.#proxy.close(() => { resolve(); }));
  }
}
