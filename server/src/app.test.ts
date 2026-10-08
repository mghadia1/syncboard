import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { CloseCode, MAX_MESSAGE_BYTES, PROTOCOL_VERSION } from "@syncboard/shared";
import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { type App, createApp } from "./app.js";
import type { Config } from "./config.js";
import { silentLog } from "./log.js";
import { DEFAULT_LIMITS } from "./rooms.js";
import { VERSION } from "./version.js";

const SECRET = "the server's own files must never be served";
const running: App[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((app) => app.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function clientDir(built = true): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "syncboard-client-"));
  dirs.push(dir);
  await writeFile(path.join(dir, "secret.txt"), SECRET);
  if (built) {
    await mkdir(path.join(dir, "assets"));
    await writeFile(path.join(dir, "index.html"), '<div id="root"></div>');
    await writeFile(path.join(dir, "assets", "app-1a2b3c.js"), "console.log(1);");
    await writeFile(path.join(dir, "assets", ".hidden"), SECRET);
  }
  return dir;
}

async function start(config: Partial<Config> = {}): Promise<{ app: App; port: number }> {
  const app = createApp(
    {
      host: "127.0.0.1",
      port: 0,
      clientDir: config.clientDir ?? (await clientDir()),
      shutdownGraceMs: 2000,
      heartbeatMs: 30_000,
      limits: DEFAULT_LIMITS,
      ...config,
    },
    silentLog,
  );
  running.push(app);
  return { app, port: await app.listen() };
}

type Answer = { status: number; headers: http.IncomingHttpHeaders; body: string };

/** A request with the target sent exactly as written (fetch would clean up `..`). */
function raw(port: number, target: string, method = "GET"): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: target, method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function connect(port: number, target = "/ws"): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}${target}`);
    ws.once("open", () => {
      resolve(ws);
    });
    ws.once("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.once("message", (data: WebSocket.RawData) => {
      // The client's frames arrive as one Buffer (ws's default binaryType).
      if (!Buffer.isBuffer(data)) {
        throw new Error("expected a Buffer");
      }
      resolve(JSON.parse(data.toString("utf8")));
    });
  });
}

function closed(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code: number, reason: Buffer) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

describe("HTTP", () => {
  test("/healthz answers GET and HEAD, and refuses other methods", async () => {
    const { port } = await start();
    const get = await raw(port, "/healthz");
    expect(get.status).toBe(200);
    expect(JSON.parse(get.body)).toEqual({ status: "ok", version: VERSION });
    const head = await raw(port, "/healthz", "HEAD");
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    const post = await raw(port, "/healthz", "POST");
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe("GET, HEAD");
  });

  test("a board's link serves the page too; a malformed one does not", async () => {
    const { port } = await start();
    expect((await raw(port, "/b/AbC123xyz")).status).toBe(200);
    expect((await raw(port, "/b/AbC123xyz")).body).toContain('<div id="root">');
    expect((await raw(port, "/b/abc")).status).toBe(404);
    expect((await raw(port, "/b/AbC123xyz/more")).status).toBe(404);
  });

  test("serves index.html at / without long-term caching", async () => {
    const { port } = await start();
    const page = await raw(port, "/");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["cache-control"]).toBe("no-cache");
    expect(page.body).toContain('<div id="root">');
    expect((await raw(port, "/", "DELETE")).status).toBe(405);
  });

  test("serves a hashed asset with its type, cached for good", async () => {
    const { port } = await start();
    const asset = await raw(port, "/assets/app-1a2b3c.js");
    expect(asset.status).toBe(200);
    expect(asset.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(asset.headers["x-content-type-options"]).toBe("nosniff");
    expect(asset.body).toBe("console.log(1);");
  });

  test.each([
    "/assets/../secret.txt",
    "/assets/..%2fsecret.txt",
    "/assets/..%2Fsecret.txt",
    "/assets/%2e%2e%2fsecret.txt",
    "/assets/%2E%2E/secret.txt",
    "/assets/..%5csecret.txt",
    "/assets/..\\secret.txt",
    "/assets/.hidden",
    "/assets/%2ehidden",
    "/assets/app-1a2b3c.js%00.png",
    "/assets/",
    "/assets/nested%2fapp-1a2b3c.js",
    "/secret.txt",
    "/index.html/../secret.txt",
  ])("never serves a file outside assets/: %s", async (target) => {
    const { port } = await start();
    const answer = await raw(port, target);
    expect(answer.status).toBe(404);
    expect(answer.body).not.toContain(SECRET);
  });

  test("bad percent-encoding is a 400", async () => {
    const { port } = await start();
    expect((await raw(port, "/assets/%E0%A4%A")).status).toBe(400);
  });

  test("anything else is a JSON 404; /ws over plain HTTP is a 426", async () => {
    const { port } = await start();
    const missing = await raw(port, "/nope");
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body)).toEqual({ error: "not found" });
    const ws = await raw(port, "/ws");
    expect(ws.status).toBe(426);
    expect(ws.headers.upgrade).toBe("websocket");
  });

  test("says so when the client has not been built", async () => {
    const { port } = await start({ clientDir: await clientDir(false) });
    const page = await raw(port, "/");
    expect(page.status).toBe(503);
    expect(page.body).toContain("not built");
  });
});

describe("WebSocket", () => {
  test("a hello is answered with a welcome", async () => {
    const { port } = await start();
    const ws = await connect(port);
    const reply = nextMessage(ws);
    ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, board: "board01", client: "c1" }));
    expect(await reply).toMatchObject({
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      version: VERSION,
      board: "board01",
      snapshot: [],
    });
    ws.close();
  });

  test("another protocol version is refused, and the connection closed with 4001", async () => {
    const { port } = await start();
    const ws = await connect(port);
    const reply = nextMessage(ws);
    const end = closed(ws);
    ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION + 1 }));
    expect(await reply).toMatchObject({ type: "error", code: "unsupported_protocol" });
    expect((await end).code).toBe(CloseCode.UnsupportedProtocol);
  });

  test.each([
    ["not JSON", "{"],
    ["an unknown type", JSON.stringify({ type: "draw" })],
  ])("%s gets an error and a 1008 close", async (_name, frame) => {
    const { port } = await start();
    const ws = await connect(port);
    const reply = nextMessage(ws);
    const end = closed(ws);
    ws.send(frame);
    expect(await reply).toMatchObject({ type: "error", code: "bad_message" });
    expect((await end).code).toBe(CloseCode.BadMessage);
  });

  test("a binary frame is refused", async () => {
    const { port } = await start();
    const ws = await connect(port);
    const end = closed(ws);
    ws.send(Buffer.from([1, 2, 3]));
    expect((await end).code).toBe(CloseCode.BadMessage);
  });

  test.each([
    ["a frame over the size limit", "x".repeat(MAX_MESSAGE_BYTES + 1), 1009],
    ["a text frame that is not UTF-8", Buffer.from([0x7b, 0xff, 0x7d]), 1007],
  ])("%s closes that connection, and the server carries on", async (_name, frame, code) => {
    const { port } = await start();
    const ws = await connect(port);
    const end = closed(ws);
    ws.send(frame, { binary: false });
    expect((await end).code).toBe(code);
    // Found by this test: unhandled, ws's "error" event crashed the server.
    const next = await connect(port);
    const reply = nextMessage(next);
    next.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, board: "board01", client: "c2" }));
    expect(await reply).toMatchObject({ type: "welcome" });
    next.close();
  });

  test("an upgrade anywhere but /ws is refused", async () => {
    const { port } = await start();
    await expect(connect(port, "/other")).rejects.toThrow("404");
  });
});

describe("shutdown", () => {
  test("open clients are told the server is going away (1001), then it stops", async () => {
    const { app, port } = await start();
    const ws = await connect(port);
    const end = closed(ws);
    await app.close();
    expect(await end).toEqual({ code: CloseCode.GoingAway, reason: "server shutting down" });
    await expect(raw(port, "/healthz")).rejects.toThrow();
  });

  test("a client that never answers the close is cut off after the grace period", async () => {
    const { app, port } = await start({ shutdownGraceMs: 300 });
    // A raw socket that completes the upgrade and then ignores everything,
    // including the server's close frame.
    const socket = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => {
      socket.once("connect", () => {
        resolve();
      });
    });
    socket.write(
      "GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    );
    await new Promise((resolve) => socket.once("data", resolve)); // 101 Switching Protocols
    const started = performance.now();
    await app.close();
    const took = performance.now() - started;
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(2000);
    socket.destroy();
  });

  test("close is idempotent", async () => {
    const { app } = await start();
    await Promise.all([app.close(), app.close()]);
  });
});
