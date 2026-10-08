import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createClient } from "@redis/client";
import { Replica } from "@syncboard/shared";
import { afterEach, describe, expect, test } from "vitest";
import { type App, createApp } from "./app.js";
import type { Envelope } from "./bus.js";
import { silentLog } from "./log.js";
import { RedisBus } from "./redis-bus.js";
import { DEFAULT_LIMITS } from "./rooms.js";
import { Client, closeClients } from "./testing/client.js";

/**
 * The bus against a real Redis: `make test-redis` starts one in a
 * container and sets SYNCBOARD_TEST_REDIS_URL. Without it these tests are
 * skipped (and say so); everything else about the bus is tested with a
 * LocalNetwork.
 */

const URL = process.env.SYNCBOARD_TEST_REDIS_URL;

const buses: RedisBus[] = [];
const apps: App[] = [];
let dir = "";

afterEach(async () => {
  closeClients();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(buses.splice(0).map((bus) => bus.close()));
  if (dir) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function bus(url: string, id: string, heard: Envelope[]): RedisBus {
  const b = new RedisBus(url, id, (envelope) => heard.push(envelope), silentLog);
  buses.push(b);
  b.start();
  return b;
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe("the bus without Redis", () => {
  test("a server starts, serves and reports the bus down; publishing drops, never queues or throws", async () => {
    const port = await closedPort();
    dir = await mkdtemp(path.join(os.tmpdir(), "syncboard-redis-"));
    const app = createApp(
      {
        host: "127.0.0.1",
        port: 0,
        clientDir: dir,
        dataDir: path.join(dir, "data"),
        shutdownGraceMs: 200,
        heartbeatMs: 30_000,
        limits: DEFAULT_LIMITS,
        redisUrl: `redis://127.0.0.1:${String(port)}`,
        timing: { pollMs: 50, rosterMs: 200 },
      },
      silentLog,
    );
    apps.push(app);
    const http = await app.listen();
    const health = await fetch(`http://127.0.0.1:${String(http)}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok", bus: "disconnected" });
    const { c } = await Client.join(http, "board01", "a");
    c.send({ type: "ops", ops: [new Replica("a").create({ kind: "rectangle", x: 0, y: 0, w: 1, h: 1 })] });
    expect(await c.next("ack")).toEqual({ type: "ack", upTo: 1 });
    expect((app.bus as RedisBus).dropped).toBeGreaterThan(0);
  });
});

describe.skipIf(URL === undefined)("the bus over Redis (SYNCBOARD_TEST_REDIS_URL)", () => {
  const url = URL ?? "";

  test("a message reaches every server that joined the board, and only those", async () => {
    const one: Envelope[] = [];
    const two: Envelope[] = [];
    const three: Envelope[] = [];
    const a = bus(url, "server1", one);
    const b = bus(url, "server2", two);
    const c = bus(url, "server3", three);
    await until(() => [a, b, c].every((x) => x.status === "connected"));
    a.join("board01");
    b.join("board01");
    c.join("board02");
    await new Promise((resolve) => setTimeout(resolve, 100)); // subscribed
    a.publish("board01", { type: "left", client: "x" });
    await until(() => two.length === 1 && one.length === 1);
    expect(two[0]).toEqual({ from: "server1", board: "board01", message: { type: "left", client: "x" } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(three).toEqual([]);
    b.leave("board01");
    await new Promise((resolve) => setTimeout(resolve, 100));
    a.publish("board01", { type: "left", client: "y" });
    await until(() => one.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(two).toHaveLength(1);
  });

  test("a dropped connection: the bus reconnects and subscribes again by itself", async () => {
    const heard: Envelope[] = [];
    const a = bus(url, "server1", []);
    const b = bus(url, "server2", heard);
    await until(() => a.status === "connected" && b.status === "connected");
    b.join("board01");
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Kill every subscribed connection, as a Redis restart or a network
    // blip would.
    const admin = createClient({ url });
    await admin.connect();
    try {
      expect(await admin.sendCommand(["CLIENT", "KILL", "TYPE", "pubsub"])).toBeGreaterThanOrEqual(1);
    } finally {
      await admin.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await until(() => b.status === "connected");
    await new Promise((resolve) => setTimeout(resolve, 100)); // subscribed again
    a.publish("board01", { type: "left", client: "x" });
    await until(() => heard.length === 1);
  });

  test("two servers sharing a data directory: an edit crosses by Redis, not by the disk", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "syncboard-redis-"));
    const ports: number[] = [];
    for (let i = 0; i < 2; i++) {
      const app = createApp(
        {
          host: "127.0.0.1",
          port: 0,
          clientDir: dir,
          dataDir: path.join(dir, "data"),
          shutdownGraceMs: 200,
          heartbeatMs: 30_000,
          limits: DEFAULT_LIMITS,
          redisUrl: url,
          // Ticks too slow to be the way it crosses.
          timing: { pollMs: 10_000, rosterMs: 10_000 },
        },
        silentLog,
      );
      apps.push(app);
      ports.push(await app.listen());
    }
    await until(() => apps.every((app) => app.bus?.status === "connected"));
    const [p1, p2] = ports as [number, number];
    const { c: a } = await Client.join(p1, "board01", "a");
    const { c: b } = await Client.join(p2, "board01", "b");
    await new Promise((resolve) => setTimeout(resolve, 100)); // both subscribed
    const op = new Replica("a").create({ kind: "rectangle", x: 0, y: 0, w: 1, h: 1 });
    const sent = performance.now();
    a.send({ type: "ops", ops: [op] });
    expect(await b.next("ops", 2000)).toEqual({ type: "ops", ops: [op] });
    expect(performance.now() - sent).toBeLessThan(1000);
    expect(apps[1]?.rooms.peek("board01")?.caughtUp).toBe(0);
  });
});
