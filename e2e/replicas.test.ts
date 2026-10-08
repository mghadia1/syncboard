import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { COLORS, Replica, SHAPE_KINDS, serializeState } from "@syncboard/shared";
import fc from "fast-check";
import { afterEach, describe, expect, test } from "vitest";
import { Editor } from "../client/src/board/editor";
import { Sync } from "../client/src/sync/sync";
import { type App, createApp } from "../server/src/app.js";
import { type LocalBus, LocalNetwork } from "../server/src/bus.js";
import { silentLog } from "../server/src/log.js";
import { DEFAULT_LIMITS } from "../server/src/rooms.js";
import { Link } from "./link";

/**
 * Two real servers sharing one data directory and a bus, and real sync
 * clients (the browser's code) on both, each behind a Link the tests cut
 * and block. The bus loses, delays and cuts off messages; servers restart.
 * At the end, every client, both servers and the disk must hold the same
 * board.
 */

const BOARD = "e2eboard";
const PLANTED = process.env.SYNCBOARD_PLANTED_BUG === "1";

type Client = { editor: Editor; sync: Sync; link: Link; server: number };

class Pair {
  readonly network = new LocalNetwork();
  readonly apps: App[] = [];
  readonly clients: Client[] = [];
  dir = "";
  #lost = 0;

  static async create(count: number): Promise<Pair> {
    const pair = new Pair();
    pair.dir = await mkdtemp(path.join(os.tmpdir(), "syncboard-e2e-pair-"));
    const ports = [await pair.#start(0), await pair.#start(1)];
    for (let i = 0; i < count; i++) {
      const server = i % 2;
      const link = await Link.open(ports[server] ?? 0);
      const editor = new Editor(new Replica(`client${String(i)}`));
      const sync = new Sync({
        editor,
        board: BOARD,
        url: `ws://127.0.0.1:${String(link.port)}/ws`,
        retry: { firstMs: 5, maxMs: 40 },
        flushMs: 2,
        presence: { name: `Person ${String(i)}`, color: "blue", cursor: null, selection: [] },
      });
      sync.start();
      pair.clients.push({ editor, sync, link, server });
    }
    return pair;
  }

  async #start(k: number): Promise<number> {
    const app = createApp(
      {
        host: "127.0.0.1",
        port: 0,
        clientDir: this.dir,
        dataDir: path.join(this.dir, "data"),
        shutdownGraceMs: 200,
        heartbeatMs: 30_000,
        limits: DEFAULT_LIMITS,
        redisUrl: null,
        timing: { pollMs: 40, rosterMs: 150 },
      },
      silentLog,
      { bus: (id, deliver) => this.network.bus(id, deliver) },
    );
    this.apps[k] = app;
    return app.listen();
  }

  app(k: number): App {
    const app = this.apps[k];
    if (!app) {
      throw new Error(`no server ${String(k)}`);
    }
    return app;
  }

  /** One server goes away and comes back (a new id on the bus, the same disk). */
  async restart(k: number): Promise<void> {
    await this.app(k).close();
    const port = await this.#start(k);
    for (const client of this.clients) {
      if (client.server === k) {
        client.link.retarget(port);
      }
    }
  }

  /**
   * The bus loses one message in `every` (0: none) on its way to the other
   * server. (Each server also gets its own messages back, and ignores
   * them: counting those, losing "one in two" would lose only them.)
   */
  lose(every: number): void {
    this.network.pass =
      every === 0 ? () => true : (envelope, to) => to === envelope.from || this.#lost++ % every !== 0;
  }

  /** Cuts one server off the bus, or puts it back. */
  isolate(k: number, cut: boolean): void {
    (this.app(k).bus as LocalBus).up = !cut;
  }

  /** Every copy of the board there is: each server's in memory (if loaded), and the disk's. */
  copies(): string[] {
    const copies: string[] = [];
    for (const app of this.apps) {
      const room = app.rooms.peek(BOARD);
      if (room) {
        copies.push(serializeState(room.replica.state));
      }
    }
    copies.push(serializeState(this.app(0).rooms.store.load(BOARD)?.state ?? new Map()));
    return copies;
  }

  /**
   * Heals every link and the bus, then waits until every client is online
   * with nothing pending, and every client, server and the disk hold the
   * same board.
   */
  async settle(timeoutMs = PLANTED ? 3000 : 6000): Promise<string> {
    for (const client of this.clients) {
      client.link.heal();
    }
    this.lose(0);
    this.network.delayMs = () => 0;
    this.isolate(0, false);
    this.isolate(1, false);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const quiet = this.clients.every((c) => {
        const status = c.sync.getStatus();
        return status.state === "online" && status.pending === 0;
      });
      const all = [...this.clients.map((c) => serializeState(c.editor.replica.state)), ...this.copies()];
      if (quiet && all.every((s) => s === all[0])) {
        return all[0] ?? "";
      }
      if (Date.now() > deadline) {
        throw new Error(
          `no agreement after ${String(timeoutMs)} ms: ${JSON.stringify(this.clients.map((c) => c.sync.getStatus()))}; ` +
            `${String(new Set(all).size)} different boards among ${String(all.length)} copies`,
        );
      }
      await pause(20);
    }
  }

  async close(): Promise<void> {
    for (const client of this.clients) {
      client.sync.stop();
      await client.link.close();
    }
    await Promise.all(this.apps.map((app) => app.close()));
    await rm(this.dir, { recursive: true, force: true });
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function within<T>(what: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} did not finish within ${String(ms)} ms`));
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting");
    }
    await pause(10);
  }
}

const pairs: Pair[] = [];
afterEach(async () => {
  await Promise.all(pairs.splice(0).map((p) => p.close()));
});

async function pair(count: number): Promise<Pair> {
  const p = await Pair.create(count);
  pairs.push(p);
  await p.settle();
  return p;
}

function at(p: Pair, i: number): Client {
  const client = p.clients[i];
  if (!client) {
    throw new Error(`no client ${String(i)}`);
  }
  return client;
}

describe("two servers, real clients on both", () => {
  test("what one draws, the other sees, through the other server", async () => {
    const p = await pair(2);
    expect([at(p, 0).server, at(p, 1).server]).toEqual([0, 1]);
    const id = at(p, 0).editor.create({ kind: "note", x: 5, y: 5, w: 100, h: 80, text: "hello" });
    await p.settle();
    expect(at(p, 1).editor.replica.shape(id)?.text).toBe("hello");
  });

  test("a pointer crosses servers; stopping takes it away", async () => {
    const p = await pair(2);
    const [a, b] = [at(p, 0), at(p, 1)];
    a.sync.setPresence({ cursor: { x: 120, y: 80 } });
    await until(() => b.sync.getPeers().get("client0")?.cursor?.x === 120);
    a.sync.stop();
    await until(() => !b.sync.getPeers().has("client0"));
  });

  test("a server cut off from the bus: its people's edits still reach the others, through the disk", async () => {
    const p = await pair(2);
    p.isolate(0, true);
    const id = at(p, 0).editor.create({ kind: "rectangle", x: 1, y: 2, w: 3, h: 4 });
    await until(() => at(p, 1).editor.replica.shape(id) !== undefined);
    expect(p.app(1).rooms.peek(BOARD)?.caughtUp).toBeGreaterThan(0);
    await p.settle();
  });
});

type Step =
  | { do: "draw"; who: number; x: number; kind: (typeof SHAPE_KINDS)[number] }
  | { do: "move"; who: number; pick: number; x: number }
  | { do: "recolor"; who: number; pick: number; color: (typeof COLORS)[number] }
  | { do: "delete" | "undo" | "redo"; who: number; pick: number }
  | { do: "cut" | "block" | "heal"; who: number }
  | { do: "wait"; ms: number }
  | { do: "lose"; every: number }
  | { do: "delay"; ms: number }
  | { do: "isolate"; server: number; cut: boolean }
  | { do: "restart"; server: number };

const who = fc.integer({ min: 0, max: 3 });
const server = fc.integer({ min: 0, max: 1 });
const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ do: fc.constant("draw" as const), who, x: fc.integer({ min: 0, max: 500 }), kind: fc.constantFrom(...SHAPE_KINDS) }) },
  { weight: 5, arbitrary: fc.record({ do: fc.constant("move" as const), who, pick: fc.nat(), x: fc.integer({ min: 0, max: 500 }) }) },
  { weight: 2, arbitrary: fc.record({ do: fc.constant("recolor" as const), who, pick: fc.nat(), color: fc.constantFrom(...COLORS) }) },
  { weight: 2, arbitrary: fc.record({ do: fc.constantFrom("delete" as const, "undo" as const, "redo" as const), who, pick: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ do: fc.constantFrom("cut" as const, "block" as const, "heal" as const), who }) },
  { weight: 3, arbitrary: fc.record({ do: fc.constant("wait" as const), ms: fc.integer({ min: 0, max: 25 }) }) },
  { weight: 2, arbitrary: fc.record({ do: fc.constant("lose" as const), every: fc.integer({ min: 0, max: 3 }) }) },
  { weight: 1, arbitrary: fc.record({ do: fc.constant("delay" as const), ms: fc.integer({ min: 0, max: 30 }) }) },
  { weight: 2, arbitrary: fc.record({ do: fc.constant("isolate" as const), server, cut: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ do: fc.constant("restart" as const), server }) },
);

test("four clients on two servers, random edits, a bus that loses and delays, links cut, servers restarting: everyone agrees, and the disk too", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(step, { minLength: 10, maxLength: 40 }), async (steps) => {
      const p = await within("starting", 10_000, Pair.create(4));
      try {
        for (const s of steps) {
          switch (s.do) {
            case "wait":
              await pause(s.ms);
              continue;
            case "lose":
              p.lose(s.every);
              continue;
            case "delay":
              p.network.delayMs = () => Math.floor(Math.random() * (s.ms + 1));
              continue;
            case "isolate":
              p.isolate(s.server, s.cut);
              continue;
            case "restart":
              await within("a server restart", 10_000, p.restart(s.server));
              continue;
            default:
              break;
          }
          const client = at(p, s.who);
          const ids = client.editor.getSnapshot().shapes.map((shape) => shape.id);
          const id = ids[("pick" in s ? s.pick : 0) % Math.max(ids.length, 1)];
          switch (s.do) {
            case "draw":
              client.editor.create({ kind: s.kind, x: s.x, y: s.x / 2, w: 40, h: 30 });
              break;
            case "move":
              if (id) client.editor.update(id, { x: s.x });
              break;
            case "recolor":
              if (id) client.editor.update(id, { stroke: s.color });
              break;
            case "delete":
              if (id) client.editor.remove([id]);
              break;
            case "undo":
              client.editor.undo();
              break;
            case "redo":
              client.editor.redo();
              break;
            case "cut":
              client.link.cut();
              break;
            case "block":
              client.link.block();
              break;
            case "heal":
              client.link.heal();
              break;
          }
          await pause(0);
        }
        await p.settle();
      } finally {
        await within("closing", 10_000, p.close());
      }
    }),
    { numRuns: 20, interruptAfterTimeLimit: 120_000, ...(PLANTED ? { endOnFailure: true } : {}) },
  );
});
