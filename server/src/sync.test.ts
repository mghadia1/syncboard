import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  CloseCode,
  type Operation,
  PROTOCOL_VERSION,
  Replica,
  type Snapshot,
  fromSnapshot,
  serializeState,
  toSnapshot,
} from "@syncboard/shared";
import { afterEach, describe, expect, test } from "vitest";
import { type App, createApp } from "./app.js";
import { silentLog } from "./log.js";
import { DEFAULT_LIMITS, DEFAULT_TIMING, type Limits } from "./rooms.js";
import { StorageError } from "./store.js";
import { Client, closeClients } from "./testing/client.js";

const running: App[] = [];
let dir = "";

afterEach(async () => {
  closeClients();
  await Promise.all(running.splice(0).map((app) => app.close()));
  if (dir) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function start(options: { limits?: Partial<Limits>; heartbeatMs?: number; keepData?: boolean } = {}) {
  if (!options.keepData || !dir) {
    dir = await mkdtemp(path.join(os.tmpdir(), "syncboard-"));
  }
  const app = createApp(
    {
      host: "127.0.0.1",
      port: 0,
      clientDir: dir,
      dataDir: path.join(dir, "data"),
      shutdownGraceMs: 500,
      heartbeatMs: options.heartbeatMs ?? 30_000,
      limits: { ...DEFAULT_LIMITS, ...options.limits },
      redisUrl: null,
      timing: DEFAULT_TIMING,
    },
    silentLog,
  );
  running.push(app);
  return { app, port: await app.listen() };
}

/** Operations made by a real replica, so stamps and ids are as a browser makes them. */
function edits(client: string) {
  const replica = new Replica(client);
  const create = replica.create({ kind: "rectangle", x: 0, y: 0, w: 10, h: 10 });
  const move = replica.update(create.shape, { x: 40 });
  return { replica, create, move };
}

describe("joining and relaying", () => {
  test("edits are relayed to the others and acknowledged; a later joiner gets the board", async () => {
    const { app, port } = await start();
    const { c: a, welcome } = await Client.join(port, "board01", "a");
    expect(welcome).toMatchObject({ board: "board01", snapshot: [] });
    const { c: b } = await Client.join(port, "board01", "b");
    const { create, move } = edits("a");
    a.send({ type: "ops", ops: [create, move] });
    expect(await a.next("ack")).toEqual({ type: "ack", upTo: 2 });
    expect(await b.next("ops")).toEqual({ type: "ops", ops: [create, move] });
    expect(await a.drain("ops")).toEqual([]); // not echoed to the sender
    const { welcome: late } = await Client.join(port, "board01", "c");
    const room = app.rooms.peek("board01");
    expect(late.snapshot).toEqual(toSnapshot(room?.replica.state ?? new Map()));
    expect(late.epoch).toBe(welcome.epoch);
    expect(room?.replica.shape(create.shape)?.x).toBe(40);
  });

  test("boards are separate rooms", async () => {
    const { port } = await start();
    const { c: a } = await Client.join(port, "board01", "a");
    const { c: b } = await Client.join(port, "board02", "b");
    a.send({ type: "ops", ops: [edits("a").create] });
    await a.next("ack");
    expect(await b.drain("ops")).toEqual([]);
  });

  test("an edit that changes nothing is acknowledged but not relayed again", async () => {
    const { port } = await start();
    const { c: a } = await Client.join(port, "board01", "a");
    const { c: b } = await Client.join(port, "board01", "b");
    const { create } = edits("a");
    a.send({ type: "ops", ops: [create] });
    a.send({ type: "ops", ops: [create] }); // resent after a lost ack, say
    await a.next("ack");
    await a.next("ack");
    expect(await b.drain("ops")).toHaveLength(1);
  });

  test("leaving takes the peer out of its room", async () => {
    const { app, port } = await start();
    const { c: a } = await Client.join(port, "board01", "a");
    await Client.join(port, "board01", "b");
    expect(app.rooms.peek("board01")?.members.size).toBe(2);
    a.ws.close();
    await a.closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.rooms.peek("board01")?.members.size).toBe(1);
  });
});

describe("presence", () => {
  const presence = (name: string, x = 1) => ({ name, color: "blue", cursor: { x, y: 2 }, selection: [] });

  test("is passed on to the others, never back; a later joiner is told who is here", async () => {
    const { port } = await start();
    const { c: a } = await Client.join(port, "board01", "a");
    const { c: b } = await Client.join(port, "board01", "b");
    a.send({ type: "presence", presence: presence("Ann") });
    expect(await b.next("presence")).toEqual({ type: "presence", client: "a", presence: presence("Ann") });
    a.send({ type: "presence", presence: presence("Ann", 9) });
    expect(await b.next("presence")).toMatchObject({ presence: { cursor: { x: 9, y: 2 } } });
    expect(await a.drain("presence")).toEqual([]);
    b.send({ type: "presence", presence: presence("Bo") });
    await a.next("presence");
    const { welcome } = await Client.join(port, "board01", "c");
    expect(welcome.peers).toEqual([
      { client: "a", presence: presence("Ann", 9) },
      { client: "b", presence: presence("Bo") },
    ]);
  });

  test("someone who has not said who they are is not listed", async () => {
    const { port } = await start();
    await Client.join(port, "board01", "a");
    const { welcome } = await Client.join(port, "board01", "b");
    expect(welcome.peers).toEqual([]);
  });

  test("leaving is announced; a client's second connection closing is not a leave", async () => {
    const { port } = await start();
    const { c: a1 } = await Client.join(port, "board01", "a");
    const { c: a2 } = await Client.join(port, "board01", "a"); // a reconnect, before the old one is gone
    const { c: b } = await Client.join(port, "board01", "b");
    a1.ws.close();
    await a1.closed;
    expect(await b.drain("left")).toEqual([]);
    a2.ws.close();
    expect(await b.next("left")).toEqual({ type: "left", client: "a" });
  });

  test("a malformed presence is refused", async () => {
    const { port } = await start();
    const { c } = await Client.join(port, "board01", "a");
    c.send({ type: "presence", presence: { name: "", color: "blue", cursor: null, selection: [] } });
    expect((await c.closed).code).toBe(CloseCode.BadMessage);
    expect(c.inbox).toMatchObject([{ type: "error", code: "bad_message" }]);
  });
});

describe("boards on disk", () => {
  test("a restarted server has the board, under the same epoch", async () => {
    const first = await start();
    const { c: a, welcome } = await Client.join(first.port, "board01", "a");
    const { create, move } = edits("a");
    a.send({ type: "ops", ops: [create, move] });
    await a.next("ack");
    await first.app.close();
    const second = await start({ keepData: true });
    const { welcome: again } = await Client.join(second.port, "board01", "b");
    expect(again.epoch).toBe(welcome.epoch); // so nobody re-uploads
    const copy = new Replica("copy");
    copy.merge(fromSnapshot(again.snapshot as Snapshot));
    expect(copy.shape(create.shape)?.x).toBe(40);
  });

  test("a board leaves memory when its last member does, and comes back from disk", async () => {
    const { app, port } = await start();
    const { c: a } = await Client.join(port, "board01", "a");
    a.send({ type: "ops", ops: [edits("a").create] });
    await a.next("ack");
    a.ws.close();
    await a.closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.rooms.size).toBe(0);
    const { welcome } = await Client.join(port, "board01", "b");
    expect(welcome.snapshot).toHaveLength(1);
  });

  test("the board limit counts the boards stored, not only those in memory", async () => {
    const { port } = await start({ limits: { maxBoards: 1 } });
    const { c: a } = await Client.join(port, "board01", "a");
    a.ws.close();
    await a.closed;
    const c = await Client.connect(port);
    c.send({ type: "hello", protocol: PROTOCOL_VERSION, board: "board02", client: "b" });
    expect(await c.next("error")).toMatchObject({ code: "board_limit" });
  });

  test("a failing store: the edit is refused, never acknowledged, and health says so", async () => {
    const { app, port } = await start();
    const { c: a } = await Client.join(port, "board01", "a");
    const { c: b } = await Client.join(port, "board01", "b");
    app.rooms.store.save = () => {
      throw new StorageError("disk full");
    };
    a.send({ type: "ops", ops: [edits("a").create] });
    expect((await a.closed).code).toBe(CloseCode.StorageFailed);
    expect(a.inbox).toMatchObject([{ type: "error", code: "storage_failed" }]);
    expect(await b.drain("ops")).toEqual([]); // nothing unstored relayed
    const health = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ status: "storage failed", error: expect.stringContaining("disk full") as unknown });
    b.send({ type: "ops", ops: [edits("b").create] }); // and nobody else's edits either
    expect((await b.closed).code).toBe(CloseCode.StorageFailed);
  });
});

describe("uploading a board", () => {
  test("what was new is relayed, the uploader's own edits acknowledged; again, nothing", async () => {
    const { app, port } = await start();
    const { c: a } = await Client.join(port, "board01", "a");
    const { c: b } = await Client.join(port, "board01", "b");
    // a's replica holds its own edits and someone else's.
    const { replica } = edits("a");
    replica.apply(edits("x").create);
    a.send({ type: "state", snapshot: toSnapshot(replica.state) });
    expect(await a.next("ack")).toEqual({ type: "ack", upTo: 2 });
    const relayed = (await b.next("ops")).ops as Operation[];
    const copy = new Replica("copy");
    relayed.forEach((op) => copy.apply(op));
    expect(serializeState(copy.state)).toBe(serializeState(replica.state));
    expect(serializeState(app.rooms.peek("board01")?.replica.state ?? new Map())).toBe(
      serializeState(replica.state),
    );
    a.send({ type: "state", snapshot: toSnapshot(replica.state) });
    await a.next("ack");
    expect(await b.drain("ops")).toEqual([]);
  });
});

describe("refusals", () => {
  /** The refusal is the only answer: nothing in a refused batch is acknowledged. */
  async function refusedWith(send: (c: Client) => void, code: string, close: number) {
    const { app, port } = await start();
    const { c } = await Client.join(port, "board01", "a");
    send(c);
    expect((await c.closed).code).toBe(close);
    expect(c.inbox).toMatchObject([{ type: "error", code }]);
    return app;
  }

  test("an operation stamped by someone else; the whole batch is refused", async () => {
    const app = await refusedWith((c) => {
      c.send({ type: "ops", ops: [edits("a").create, edits("b").create] });
    }, "not_yours", CloseCode.BadOperation);
    expect(app.rooms.store.load("board01")?.state.size).toBe(0); // nothing stored
  });

  test("a counter above 2^52", async () => {
    const op = { shape: "a.1", stamp: { counter: 2 ** 52 + 1, client: "a" }, set: { x: 1 } };
    await refusedWith((c) => {
      c.send({ type: "ops", ops: [op] });
    }, "bad_operation", CloseCode.BadOperation);
  });

  test("a second hello", async () => {
    await refusedWith((c) => {
      c.send({ type: "hello", protocol: PROTOCOL_VERSION, board: "board02", client: "a" });
    }, "bad_message", CloseCode.BadMessage);
  });

  test("ops before hello", async () => {
    const { port } = await start();
    const c = await Client.connect(port);
    c.send({ type: "ops", ops: [edits("a").create] });
    expect(await c.next("error")).toMatchObject({ code: "not_joined" });
    expect((await c.closed).code).toBe(CloseCode.BadMessage);
  });

  test("one board more than the server holds", async () => {
    const { port } = await start({ limits: { maxBoards: 1 } });
    await Client.join(port, "board01", "a");
    const c = await Client.connect(port);
    c.send({ type: "hello", protocol: PROTOCOL_VERSION, board: "board02", client: "b" });
    expect(await c.next("error")).toMatchObject({ code: "board_limit" });
    expect((await c.closed).code).toBe(CloseCode.BoardLimit);
  });

  test("one shape more than a board holds, by operations or by upload", async () => {
    const { port } = await start({ limits: { maxShapes: 2 } });
    const replica = new Replica("a");
    const ops = [0, 1, 2].map(() => replica.create({ kind: "ellipse", x: 0, y: 0, w: 1, h: 1 }));
    const { c } = await Client.join(port, "board01", "a");
    c.send({ type: "ops", ops: ops.slice(0, 2) });
    await c.next("ack");
    c.send({ type: "ops", ops: ops.slice(2) });
    expect(await c.next("error")).toMatchObject({ code: "board_limit" });
    const { c: d } = await Client.join(port, "board01", "a");
    d.send({ type: "state", snapshot: toSnapshot(replica.state) });
    expect(await d.next("error")).toMatchObject({ code: "board_limit" });
  });
});

test("a connection that stops answering pings is cut off", async () => {
  const { port } = await start({ heartbeatMs: 60 });
  // A raw socket completes the upgrade, then never answers anything. It
  // reads (and ignores) what arrives: a paused socket would never notice
  // the server hanging up.
  const socket = net.connect(port, "127.0.0.1");
  socket.resume();
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(
    "GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
  );
  const started = Date.now();
  await new Promise((resolve) => socket.once("close", resolve));
  const took = Date.now() - started;
  expect(took).toBeGreaterThanOrEqual(60);
  expect(took).toBeLessThan(1000);
  // A client that answers pings (ws does, as browsers do) stays.
  const { c } = await Client.join(port, "board01", "a");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(c.ws.readyState).toBe(WebSocket.OPEN);
});
