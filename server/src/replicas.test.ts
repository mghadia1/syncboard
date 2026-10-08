import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type Operation, Replica, serializeState } from "@syncboard/shared";
import { afterEach, describe, expect, test } from "vitest";
import { type App, createApp } from "./app.js";
import { type LocalBus, LocalNetwork } from "./bus.js";
import { silentLog } from "./log.js";
import { DEFAULT_LIMITS, type Timing } from "./rooms.js";
import { Client, type Message, closeClients } from "./testing/client.js";

/**
 * Two servers sharing one data directory and a bus (a LocalNetwork that
 * can lose, delay and cut off messages), with people on both.
 */

const running: App[] = [];
let dir = "";

afterEach(async () => {
  closeClients();
  await Promise.all(running.splice(0).map((app) => app.close()));
  if (dir) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Ticks this often in these tests, so a lost message is found within a fraction of a second. */
const FAST: Timing = { pollMs: 40, rosterMs: 150 };

type Server = { app: App; port: number };

async function pair(options: { bus?: boolean; timing?: Timing } = {}) {
  dir = await mkdtemp(path.join(os.tmpdir(), "syncboard-replicas-"));
  const network = new LocalNetwork();
  const servers: Server[] = [];
  for (let i = 0; i < 2; i++) {
    const app = createApp(
      {
        host: "127.0.0.1",
        port: 0,
        clientDir: dir,
        dataDir: path.join(dir, "data"),
        shutdownGraceMs: 500,
        heartbeatMs: 30_000,
        limits: DEFAULT_LIMITS,
        redisUrl: null,
        timing: options.timing ?? FAST,
      },
      silentLog,
      options.bus === false ? {} : { bus: (id, deliver) => network.bus(id, deliver) },
    );
    running.push(app);
    servers.push({ app, port: await app.listen() });
  }
  const [one, two] = servers as [Server, Server];
  return { network, one, two };
}

function edits(client: string) {
  const replica = new Replica(client);
  const create = replica.create({ kind: "rectangle", x: 0, y: 0, w: 10, h: 10 });
  const move = replica.update(create.shape, { x: 40 });
  return { replica, create, move };
}

function stateOf(server: Server): string {
  return serializeState(server.app.rooms.peek("board01")?.replica.state ?? new Map());
}

function stored(server: Server): string {
  return serializeState(server.app.rooms.store.load("board01")?.state ?? new Map());
}

/** Applies ops messages to a fresh replica: what a browser would hold. */
function applied(messages: readonly Message[]): Replica {
  const replica = new Replica("viewer");
  for (const message of messages) {
    if (message.type === "ops") {
      for (const op of message.ops as Operation[]) {
        replica.apply(op);
      }
    }
  }
  return replica;
}

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("two servers, one board", () => {
  test("an edit on one server reaches people on the other, by the bus; stored once, one epoch", async () => {
    const { one, two } = await pair();
    const { c: a, welcome: first } = await Client.join(one.port, "board01", "a");
    const { c: b, welcome: second } = await Client.join(two.port, "board01", "b");
    expect(second.epoch).toBe(first.epoch);
    const { create, move } = edits("a");
    a.send({ type: "ops", ops: [create, move] });
    expect(await a.next("ack")).toEqual({ type: "ack", upTo: 2 });
    expect(await b.next("ops")).toEqual({ type: "ops", ops: [create, move] });
    const rooms = [one, two].map((s) => s.app.rooms.peek("board01"));
    expect(rooms.map((room) => room?.seq)).toEqual([1, 1]);
    expect(rooms[1]?.caughtUp).toBe(0); // the bus brought it
    expect(stateOf(two)).toBe(stateOf(one));
    expect(stored(two)).toBe(stateOf(one));
  });

  test("a message the bus loses: the edit is read from disk at the next ticks", async () => {
    const { network, one, two } = await pair();
    const { c: a } = await Client.join(one.port, "board01", "a");
    const { c: b } = await Client.join(two.port, "board01", "b");
    network.pass = (envelope) => envelope.message.type !== "ops";
    const { create, move } = edits("a");
    a.send({ type: "ops", ops: [create, move] });
    await a.next("ack");
    expect(applied([await b.next("ops", 2000)]).shape(create.shape)?.x).toBe(40);
    expect(two.app.rooms.peek("board01")?.caughtUp).toBeGreaterThan(0);
    expect(stateOf(two)).toBe(stateOf(one));
  });

  test("a lost message, then later ones that arrive: the missing change is still read from disk", async () => {
    const { network, one, two } = await pair();
    const { c: a } = await Client.join(one.port, "board01", "a");
    await Client.join(two.port, "board01", "b");
    // Lose server two's copy of the first edit only. (Every server that
    // joined the board gets a copy, the sender too: a first version of
    // this test lost the sender's own copy, and tested nothing.)
    let lost = 0;
    network.pass = (envelope, to) => {
      if (envelope.message.type === "ops" && to === two.app.rooms.id && lost === 0) {
        lost++;
        return false;
      }
      return true;
    };
    const { create, move } = edits("a");
    a.send({ type: "ops", ops: [create] });
    await a.next("ack");
    a.send({ type: "ops", ops: [move] });
    await a.next("ack");
    const room = two.app.rooms.peek("board01");
    await until(() => room?.seq === 2);
    expect(lost).toBe(1);
    expect(room?.caughtUp).toBeGreaterThan(0);
    expect(room?.replica.shape(create.shape)).toMatchObject({ kind: "rectangle", x: 40 });
    expect(stateOf(two)).toBe(stateOf(one));
  });

  test("no bus at all: the servers still agree, through the disk", async () => {
    const { one, two } = await pair({ bus: false });
    const { c: a } = await Client.join(one.port, "board01", "a");
    const { c: b } = await Client.join(two.port, "board01", "b");
    const { create, move } = edits("a");
    a.send({ type: "ops", ops: [create, move] });
    expect(applied([await b.next("ops", 2000)]).shape(create.shape)?.x).toBe(40);
    expect(stateOf(two)).toBe(stateOf(one));
  });

  test("messages out of order: everything arrives, and nothing is read from disk", async () => {
    // Ticks too slow to step in: the bus alone must get it right.
    const { network, one, two } = await pair({ timing: { pollMs: 5000, rosterMs: 5000 } });
    const { c: a } = await Client.join(one.port, "board01", "a");
    const { c: b } = await Client.join(two.port, "board01", "b");
    network.delayMs = () => Math.floor(Math.random() * 15);
    const replica = new Replica("a");
    const id = replica.create({ kind: "rectangle", x: 0, y: 0, w: 10, h: 10 });
    a.send({ type: "ops", ops: [id] });
    for (let x = 1; x <= 20; x++) {
      a.send({ type: "ops", ops: [replica.update(id.shape, { x })] });
    }
    await until(() => two.app.rooms.peek("board01")?.seq === 21);
    expect(two.app.rooms.peek("board01")?.caughtUp).toBe(0);
    await until(() => applied(b.inbox).shape(id.shape)?.x === 20);
    expect(stateOf(two)).toBe(stateOf(one));
  });

  test("both servers edit one property at once: both, their people and the disk keep the same winner", async () => {
    const { network, one, two } = await pair();
    const { c: a } = await Client.join(one.port, "board01", "a");
    const { c: b } = await Client.join(two.port, "board01", "b");
    const ra = new Replica("a");
    const create = ra.create({ kind: "rectangle", x: 0, y: 0, w: 10, h: 10 });
    a.send({ type: "ops", ops: [create] });
    await b.next("ops");
    const rb = new Replica("b");
    rb.apply(create);
    // Each stored before either hears of the other's.
    network.delayMs = () => 50;
    const fromA = ra.update(create.shape, { x: 100 });
    const fromB = rb.update(create.shape, { x: 200 });
    expect(fromA.stamp.counter).toBe(fromB.stamp.counter); // concurrent: "b" > "a" decides
    a.send({ type: "ops", ops: [fromA] });
    b.send({ type: "ops", ops: [fromB] });
    await a.next("ack");
    await b.next("ack");
    await until(() => [one, two].every((s) => s.app.rooms.peek("board01")?.seq === 3));
    for (const server of [one, two]) {
      expect(server.app.rooms.peek("board01")?.replica.shape(create.shape)?.x).toBe(200);
    }
    expect(stored(one)).toBe(stateOf(one));
    expect(stateOf(two)).toBe(stateOf(one));
    // a hears b's winning value; b is not sent a's losing one.
    expect((await a.next("ops")).ops).toEqual([fromB]);
    expect(await b.drain("ops")).toEqual([]);
  });

  test("a board made on both servers at once is one board, with one epoch", async () => {
    const { one, two } = await pair();
    const [x, y] = await Promise.all([
      Client.join(one.port, "board01", "a"),
      Client.join(two.port, "board01", "b"),
    ]);
    expect(x.welcome.epoch).toBe(y.welcome.epoch);
    expect(one.app.rooms.store.boardCount).toBe(1);
  });
});

describe("presence across servers", () => {
  const presence = (name: string, x = 1) => ({ name, color: "blue", cursor: { x, y: 2 }, selection: [] });

  test("a pointer on one server reaches people on the other; leaving takes it away", async () => {
    const { one, two } = await pair();
    const { c: a } = await Client.join(one.port, "board01", "a");
    const { c: b } = await Client.join(two.port, "board01", "b");
    a.send({ type: "presence", presence: presence("Ann", 7) });
    expect(await b.next("presence")).toEqual({ type: "presence", client: "a", presence: presence("Ann", 7) });
    a.ws.close();
    expect(await b.next("left")).toEqual({ type: "left", client: "a" });
  });

  test("someone joining the other server is told who is on the first", async () => {
    const { one, two } = await pair();
    const { c: a } = await Client.join(one.port, "board01", "a");
    a.send({ type: "presence", presence: presence("Ann") });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The board is new to server two: it asks, and passes the answer on.
    const { c: b } = await Client.join(two.port, "board01", "b");
    expect(await b.next("presence")).toMatchObject({ client: "a", presence: { name: "Ann" } });
    // A later joiner there finds Ann in its welcome.
    const { welcome } = await Client.join(two.port, "board01", "c");
    expect(welcome.peers).toEqual([{ client: "a", presence: presence("Ann") }]);
  });

  test("on the board through both servers at once: one connection closing is not leaving", async () => {
    const { one, two } = await pair();
    const { c: b } = await Client.join(two.port, "board01", "b");
    const { c: here } = await Client.join(one.port, "board01", "x");
    here.send({ type: "presence", presence: presence("Xi") });
    await b.next("presence");
    // A reconnect that landed on the other server before the old
    // connection was noticed gone.
    const { c: there } = await Client.join(two.port, "board01", "x");
    there.send({ type: "presence", presence: presence("Xi") });
    here.ws.close();
    await here.closed;
    expect(await b.drain("left", 200)).toEqual([]);
    there.ws.close();
    expect(await b.next("left")).toEqual({ type: "left", client: "x" });
  });

  test("a server that goes quiet: its people are taken off after three missed rosters, and come back with it", async () => {
    const { one, two } = await pair();
    const { c: a } = await Client.join(one.port, "board01", "a");
    const { c: b } = await Client.join(two.port, "board01", "b");
    a.send({ type: "presence", presence: presence("Ann") });
    await b.next("presence");
    const bus = one.app.bus as LocalBus;
    bus.up = false;
    const cut = Date.now();
    expect(await b.next("left", 2000)).toEqual({ type: "left", client: "a" });
    expect(Date.now() - cut).toBeGreaterThanOrEqual(3 * FAST.rosterMs - FAST.pollMs);
    bus.up = true;
    expect(await b.next("presence", 2000)).toMatchObject({ client: "a" });
  });
});
