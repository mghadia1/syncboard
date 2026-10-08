import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { COLORS, Replica, SHAPE_KINDS, serializeState } from "@syncboard/shared";
import fc from "fast-check";
import { afterEach, describe, expect, test } from "vitest";
import { Editor } from "../client/src/board/editor";
import { Sync } from "../client/src/sync/sync";
import { type App, createApp } from "../server/src/app.js";
import { silentLog } from "../server/src/log.js";
import { DEFAULT_LIMITS } from "../server/src/rooms.js";
import { Link } from "./link";

/**
 * The real server, and real sync clients (the browser's code, on Node's
 * built-in WebSocket), each behind its own Link: a network that the tests
 * cut, block and heal. At the end, every replica, the server's included,
 * must hold the same board.
 */

const BOARD = "e2eboard";

/**
 * Set when bugs are planted on purpose to check these tests catch them:
 * a failing run then waits less for agreement, and fast-check reports the
 * first failure instead of shrinking it (each try would wait out the
 * timeout).
 */
const PLANTED = process.env.SYNCBOARD_PLANTED_BUG === "1";

type Client = { editor: Editor; sync: Sync; link: Link };

class World {
  app!: App;
  clientDir = "";
  readonly clients: Client[] = [];

  static async create(count: number): Promise<World> {
    const world = new World();
    world.clientDir = await mkdtemp(path.join(os.tmpdir(), "syncboard-e2e-"));
    const port = await world.#start();
    for (let i = 0; i < count; i++) {
      const link = await Link.open(port);
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
      world.clients.push({ editor, sync, link });
    }
    return world;
  }

  async #start(): Promise<number> {
    this.app = createApp(
      {
        host: "127.0.0.1",
        port: 0,
        clientDir: this.clientDir,
        dataDir: path.join(this.clientDir, "data"),
        shutdownGraceMs: 200,
        heartbeatMs: 30_000,
        limits: DEFAULT_LIMITS,
      },
      silentLog,
    );
    return this.app.listen();
  }

  /**
   * The server goes away and comes back with its boards on disk; or, with
   * `wipe`, with its data lost (a volume deleted), so the browsers'
   * uploads must bring the board back.
   */
  async restart(wipe = false): Promise<void> {
    await this.app.close();
    if (wipe) {
      await rm(path.join(this.clientDir, "data"), { recursive: true, force: true });
    }
    const port = await this.#start();
    for (const client of this.clients) {
      client.link.retarget(port);
    }
  }

  serverState(): string {
    return serializeState(this.app.rooms.peek(BOARD)?.replica.state ?? new Map());
  }

  /**
   * Heals every link, then waits until every client is online with nothing
   * pending and every replica, the server's too, holds the same board.
   */
  async settle(timeoutMs = PLANTED ? 3000 : 5000): Promise<string> {
    for (const client of this.clients) {
      client.link.heal();
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const states = this.clients.map((c) => serializeState(c.editor.replica.state));
      const quiet = this.clients.every((c) => {
        const status = c.sync.getStatus();
        return status.state === "online" && status.pending === 0;
      });
      if (quiet && states.every((s) => s === this.serverState())) {
        return this.serverState();
      }
      if (Date.now() > deadline) {
        throw new Error(
          `no agreement after ${String(timeoutMs)} ms: ${JSON.stringify(this.clients.map((c) => c.sync.getStatus()))}`,
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
    await this.app.close();
    await rm(this.clientDir, { recursive: true, force: true });
  }
}

/** A step that must finish in time; a hang is reported as which step hung. */
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

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const worlds: World[] = [];
afterEach(async () => {
  await Promise.all(worlds.splice(0).map((w) => w.close()));
});

async function world(count: number): Promise<World> {
  const w = await World.create(count);
  worlds.push(w);
  await w.settle();
  return w;
}

function at(w: World, i: number): Client {
  const client = w.clients[i];
  if (!client) {
    throw new Error(`no client ${String(i)}`);
  }
  return client;
}

describe("two clients, a real server", () => {
  test("what one draws, the other sees", async () => {
    const w = await world(2);
    const id = at(w, 0).editor.create({ kind: "note", x: 5, y: 5, w: 100, h: 80, text: "hello" });
    await w.settle();
    expect(at(w, 1).editor.replica.shape(id)?.text).toBe("hello");
  });

  test("both cut off, both editing the same shape: when the network heals, they agree", async () => {
    const w = await world(2);
    const [a, b] = [at(w, 0), at(w, 1)];
    const id = a.editor.create({ kind: "rectangle", x: 0, y: 0, w: 10, h: 10 });
    await w.settle();
    a.link.block();
    b.link.block();
    await pause(30);
    a.editor.update(id, { x: 100 }); // the same property, concurrently...
    b.editor.update(id, { x: 200 });
    b.editor.update(id, { stroke: "red" }); // ...and a different one
    expect(a.sync.getStatus().state).not.toBe("online");
    await w.settle();
    const shape = a.editor.replica.shape(id);
    // Equal counters (both had seen the creation, then made one edit... b made
    // two), so b's x has the higher counter and wins; the recolor stays.
    expect(shape).toMatchObject({ x: 200, stroke: "red" });
  });

  test("the server restarts with the board on disk, before anyone is back", async () => {
    const w = await world(2);
    for (let i = 0; i < 20; i++) {
      at(w, i % 2).editor.create({ kind: "ellipse", x: i * 10, y: 0, w: 5, h: 5 });
    }
    const before = await w.settle();
    await w.restart();
    const stored = w.app.rooms.store.load(BOARD);
    expect(serializeState(stored?.state ?? new Map())).toBe(before);
    expect(await w.settle()).toBe(before);
  });

  test("the server's data is lost; the clients' uploads bring the board back", async () => {
    const w = await world(2);
    for (let i = 0; i < 20; i++) {
      at(w, i % 2).editor.create({ kind: "ellipse", x: i * 10, y: 0, w: 5, h: 5 });
    }
    const before = await w.settle();
    await w.restart(true);
    expect(w.app.rooms.store.load(BOARD)).toBeNull();
    expect(await w.settle()).toBe(before);
  });
});

describe("presence and undo, with a real server", () => {
  test("a pointer and a name reach the other person; leaving takes them away", async () => {
    const w = await world(2);
    const [a, b] = [at(w, 0), at(w, 1)];
    a.sync.setPresence({ cursor: { x: 120, y: 80 } });
    await until(() => b.sync.getPeers().get("client0")?.cursor?.x === 120);
    expect(b.sync.getPeers().get("client0")).toMatchObject({ name: "Person 0", cursor: { x: 120, y: 80 } });
    a.sync.stop();
    await until(() => !b.sync.getPeers().has("client0"));
  });

  test("an undo keeps the other person's later move", async () => {
    const w = await world(2);
    const [a, b] = [at(w, 0), at(w, 1)];
    const id = a.editor.create({ kind: "rectangle", x: 0, y: 0, w: 10, h: 10 });
    a.editor.update(id, { x: 10 }, "Move");
    await w.settle();
    b.editor.update(id, { x: 50 }, "Move");
    await w.settle();
    expect(a.editor.undo()).toEqual({ label: "Move", reverted: 0, kept: 1 });
    await w.settle();
    expect(b.editor.replica.shape(id)?.x).toBe(50);
  });
});

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting");
    }
    await pause(10);
  }
}

type Step =
  | { do: "draw"; who: number; x: number; kind: (typeof SHAPE_KINDS)[number] }
  | { do: "move"; who: number; pick: number; x: number }
  | { do: "recolor"; who: number; pick: number; color: (typeof COLORS)[number] }
  | { do: "delete" | "undo" | "redo"; who: number; pick: number }
  | { do: "cut" | "block" | "heal"; who: number }
  | { do: "wait"; ms: number }
  | { do: "restart" }
  | { do: "wipe" };

const who = fc.integer({ min: 0, max: 2 });
const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ do: fc.constant("draw" as const), who, x: fc.integer({ min: 0, max: 500 }), kind: fc.constantFrom(...SHAPE_KINDS) }) },
  { weight: 5, arbitrary: fc.record({ do: fc.constant("move" as const), who, pick: fc.nat(), x: fc.integer({ min: 0, max: 500 }) }) },
  { weight: 2, arbitrary: fc.record({ do: fc.constant("recolor" as const), who, pick: fc.nat(), color: fc.constantFrom(...COLORS) }) },
  { weight: 2, arbitrary: fc.record({ do: fc.constantFrom("delete" as const, "undo" as const, "redo" as const), who, pick: fc.nat() }) },
  { weight: 3, arbitrary: fc.record({ do: fc.constantFrom("cut" as const, "block" as const, "heal" as const), who }) },
  { weight: 3, arbitrary: fc.record({ do: fc.constant("wait" as const), ms: fc.integer({ min: 0, max: 25 }) }) },
  { weight: 1, arbitrary: fc.constantFrom({ do: "restart" as const }, { do: "wipe" as const }) },
);

test("random edits on three clients, a network that keeps failing, server restarts (some losing their data): everyone agrees in the end", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(step, { minLength: 10, maxLength: 40 }), async (steps) => {
      const w = await within("starting", 10_000, World.create(3));
      try {
        for (const s of steps) {
          if (s.do === "wait") {
            await pause(s.ms);
            continue;
          }
          if (s.do === "restart" || s.do === "wipe") {
            await within("a server restart", 10_000, w.restart(s.do === "wipe"));
            continue;
          }
          const client = at(w, s.who);
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
          await pause(0); // let the network move between steps
        }
        await w.settle();
      } finally {
        await within("closing", 10_000, w.close());
      }
    }),
    // A failing run shrinks (each try waiting out settle); the time limit
    // makes it report the smallest case found so far, not the test timeout.
    { numRuns: 25, interruptAfterTimeLimit: 120_000, ...(PLANTED ? { endOnFailure: true } : {}) },
  );
});
