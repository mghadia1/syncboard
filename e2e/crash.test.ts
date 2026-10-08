import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Operation,
  PROTOCOL_VERSION,
  type PropName,
  Replica,
  type Snapshot,
  compareStamps,
  fromSnapshot,
} from "@syncboard/shared";
import { afterEach, expect, test } from "vitest";
import WebSocket from "ws";

/**
 * SIGKILL, the server as its own process: writers send edits as fast as
 * they are acknowledged, the server is killed at a random moment, again
 * and again; then every edit that was ever acknowledged must be on disk.
 * A SIGKILL leaves the operating system's page cache intact, so this
 * tests the server's order of work (store, then acknowledge), not what a
 * power cut does to the disk: that is not tested.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BOARD = "crashboard";
const ROUNDS = 6;
const WRITERS = 3;

const children: ChildProcess[] = [];
let dir = "";
afterEach(async () => {
  children.splice(0).forEach((child) => child.kill("SIGKILL"));
  if (dir) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A small seeded random number generator (mulberry32), so a failure can be replayed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Starts the server on a free port; resolves once it is listening. Node
 * itself, with tsx as a loader, so the process killed is the server: the
 * tsx command runs the script in a child process of its own, and a
 * SIGKILL to it would orphan the server (found: the first version of this
 * test left seven running).
 */
function startServer(dataDir: string): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(process.execPath, ["--import", "tsx", "server/src/main.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      SYNCBOARD_HOST: "127.0.0.1",
      SYNCBOARD_PORT: "0",
      SYNCBOARD_DATA_DIR: dataDir,
      SYNCBOARD_CLIENT_DIR: dataDir,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let buffered = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      for (const line of buffered.split("\n")) {
        try {
          const event = JSON.parse(line) as { event?: string; port?: number };
          if (event.event === "listening" && typeof event.port === "number") {
            resolve({ child, port: event.port });
          }
        } catch {
          // a partial line
        }
      }
    });
    child.once("exit", (code) => {
      reject(new Error(`the server exited (${String(code)}) before listening`));
    });
  });
}

/** Sends its own edits in small batches, as fast as the server takes them; remembers what was acknowledged. */
class Writer {
  readonly replica: Replica;
  readonly sent: Operation[] = [];
  acked = 0;
  #ws: WebSocket | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    client: string,
    private readonly next: () => number,
  ) {
    this.replica = new Replica(client);
  }

  start(port: number): void {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
    this.#ws = ws;
    ws.on("error", () => undefined); // the server is about to be killed
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, board: BOARD, client: this.replica.client }));
    });
    ws.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString("utf8")) as { type: string; upTo?: number };
      if (message.type === "welcome") {
        this.#timer = setInterval(() => {
          this.#batch(ws);
        }, 3);
      } else if (message.type === "ack" && message.upTo !== undefined) {
        this.acked = Math.max(this.acked, message.upTo);
      }
    });
    ws.on("close", () => {
      this.stop();
    });
  }

  #batch(ws: WebSocket): void {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const ops: Operation[] = [];
    const count = 1 + Math.floor(this.next() * 10);
    for (let i = 0; i < count; i++) {
      const shapes = [...this.replica.state.keys()];
      const id = shapes[Math.floor(this.next() * shapes.length)];
      ops.push(
        shapes.length < 5 || id === undefined
          ? this.replica.create({ kind: "rectangle", x: this.next() * 500, y: 0, w: 10, h: 10 })
          : this.replica.update(id, { x: Math.round(this.next() * 500), stroke: this.next() < 0.5 ? "red" : "blue" }),
      );
    }
    this.sent.push(...ops);
    ws.send(JSON.stringify({ type: "ops", ops }));
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#ws?.terminate();
  }

  acknowledged(): Operation[] {
    return this.sent.filter((op) => op.stamp.counter <= this.acked);
  }
}

/** The board as a newly joined client is sent it. */
async function boardOn(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
  const welcome = await new Promise<{ snapshot: Snapshot }>((resolve, reject) => {
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, board: BOARD, client: "checker" }));
    });
    ws.on("message", (data: Buffer) => {
      resolve(JSON.parse(data.toString("utf8")) as { snapshot: Snapshot });
    });
    ws.on("error", reject);
  });
  ws.close();
  return fromSnapshot(welcome.snapshot);
}

test("SIGKILL, again and again: every acknowledged edit is on disk", async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "syncboard-crash-"));
  const seed = Number(process.env.SYNCBOARD_SEED ?? Date.now() % 1_000_000);
  const next = random(seed);
  const writers: Writer[] = [];
  let inFlight = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const { child, port } = await startServer(dir);
    const these = Array.from({ length: WRITERS }, (_, i) => new Writer(`r${String(round)}w${String(i)}`, next));
    these.forEach((w) => {
      w.start(port);
    });
    writers.push(...these);
    await new Promise((resolve) => setTimeout(resolve, 150 + next() * 450));
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    these.forEach((w) => {
      w.stop();
      inFlight += w.sent.length - w.acknowledged().length;
    });
  }

  const { port } = await startServer(dir);
  const board = await boardOn(port);
  const acknowledged = writers.flatMap((w) => w.acknowledged());
  let checked = 0;
  for (const op of acknowledged) {
    for (const name of Object.keys(op.set) as PropName[]) {
      const entry = board.get(op.shape)?.[name];
      // Each writer is the only one to edit its shapes, and its counters
      // go up: the stored register holds this edit, or a later one of its.
      expect(entry, `seed ${String(seed)}: ${op.shape}.${name} missing`).toBeDefined();
      expect(compareStamps(entry?.stamp ?? { counter: 0, client: "" }, op.stamp), `seed ${String(seed)}`).toBeGreaterThanOrEqual(0);
      checked++;
    }
  }
  // The test means something only if edits were acknowledged, and some were
  // still in flight when the server died.
  expect(acknowledged.length).toBeGreaterThan(100);
  expect(inFlight).toBeGreaterThan(0);
  console.log(`seed ${String(seed)}: ${String(acknowledged.length)} acknowledged edits (${String(checked)} registers) survived ${String(ROUNDS)} kills; ${String(inFlight)} were in flight`);
});
