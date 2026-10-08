import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { CloseCode, MAX_MESSAGE_BYTES } from "@syncboard/shared";
import { type WebSocket, WebSocketServer } from "ws";
import type { Config } from "./config.js";
import type { Log } from "./log.js";
import type { Bus, Deliver } from "./bus.js";
import { RedisBus } from "./redis-bus.js";
import { Rooms } from "./rooms.js";
import { Store } from "./store.js";
import { serveClient } from "./static.js";
import { handleConnection } from "./sync.js";
import { VERSION } from "./version.js";

export type App = {
  server: http.Server;
  /** The boards held in memory (tests look inside). */
  rooms: Rooms;
  /** How this server shares boards with others; null when it is alone. */
  bus: Bus | null;
  /** Starts listening; resolves to the port (useful with port 0). */
  listen(): Promise<number>;
  /**
   * Stops accepting connections, asks every WebSocket client to go away
   * (1001), and resolves once they have, or once the grace period is over
   * and the stragglers have been cut off.
   */
  close(): Promise<void>;
};

function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

/** Refuses an upgrade with a plain HTTP answer, then hangs up. */
function refuse(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export type AppOptions = {
  /** A bus other than Redis (tests use a LocalNetwork); the default is Redis if config.redisUrl is set. */
  bus?: (id: string, deliver: Deliver) => Bus;
};

export function createApp(config: Config, log: Log, options: AppOptions = {}): App {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const store = new Store(config.dataDir);
  const rooms = new Rooms(store, { limits: config.limits, timing: config.timing, log });
  const deliver: Deliver = (envelope) => {
    rooms.receive(envelope);
  };
  if (options.bus) {
    rooms.bus = options.bus(rooms.id, deliver);
  } else if (config.redisUrl !== null) {
    const redis = new RedisBus(config.redisUrl, rooms.id, deliver, log);
    redis.start();
    rooms.bus = redis;
  }
  const bus = rooms.bus;
  let closing: Promise<void> | undefined;

  // Keeps rooms in step with other servers' (see Rooms): changes the bus
  // did not bring are read from disk; presence is repeated and expires.
  const ticker = setInterval(() => {
    rooms.tick();
  }, config.timing.pollMs);
  ticker.unref();

  // A connection that stops answering pings (a laptop that slept, a cable
  // pulled) is cut off at the next ping, rather than kept forever.
  const alive = new WeakMap<WebSocket, boolean>();
  const heartbeat = setInterval(() => {
    for (const ws of sockets.clients) {
      if (alive.get(ws) === false) {
        log("client unresponsive", {});
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, config.heartbeatMs);
  heartbeat.unref();

  const server = http.createServer((req, res) => {
    const url = URL.parse(req.url ?? "", "http://localhost");
    if (url === null) {
      json(res, 400, { error: "bad request target" });
      return;
    }
    if (url.pathname === "/healthz") {
      if (req.method === "GET" || req.method === "HEAD") {
        // The process is up and answering; and it can store boards, or
        // says so (it takes no edits after a storage failure).
        // The bus is reported, not required: without it, servers still
        // find each other's edits on disk, only later.
        const shared = bus ? bus.status : "off";
        if (rooms.failed !== null) {
          json(res, 503, { status: "storage failed", version: VERSION, bus: shared, error: rooms.failed });
        } else {
          json(res, 200, { status: "ok", version: VERSION, bus: shared });
        }
      } else {
        json(res, 405, { error: "method not allowed" }, { Allow: "GET, HEAD" });
      }
      return;
    }
    if (url.pathname === "/ws") {
      json(res, 426, { error: "this is a WebSocket endpoint" }, { Upgrade: "websocket" });
      return;
    }
    serveClient(req, res, url.pathname, config.clientDir)
      .then((handled) => {
        if (!handled) {
          json(res, 404, { error: "not found" });
        }
      })
      .catch((error: unknown) => {
        log("request failed", { path: url.pathname, error: String(error) });
        if (!res.headersSent) {
          json(res, 500, { error: "internal error" });
        } else {
          res.destroy();
        }
      });
  });

  server.on("upgrade", (req, socket, head) => {
    const url = URL.parse(req.url ?? "", "http://localhost");
    if (url?.pathname !== "/ws") {
      refuse(socket, 404, "Not Found");
      return;
    }
    if (closing) {
      refuse(socket, 503, "Service Unavailable");
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      sockets.emit("connection", ws, req);
    });
  });

  sockets.on("connection", (ws) => {
    log("client connected", { clients: sockets.clients.size });
    // ws reports a frame it refuses (over maxPayload, invalid UTF-8) as an
    // "error" event and then closes the connection itself. Without a
    // listener, Node throws it, and one bad client would crash the server.
    ws.on("error", (error) => {
      log("client error", { error: error.message });
    });
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
    handleConnection(ws, rooms, log);
    ws.on("close", (code) => {
      log("client disconnected", { code, clients: sockets.clients.size });
    });
  });

  return {
    server,
    rooms,
    bus,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          resolve((server.address() as AddressInfo).port);
        });
      });
    },
    close() {
      closing ??= new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        clearInterval(ticker);
        const grace = setTimeout(() => {
          for (const ws of sockets.clients) {
            ws.terminate();
          }
          server.closeAllConnections();
        }, config.shutdownGraceMs);
        // Called once every connection has ended, upgraded ones included;
        // idle keep-alive connections are closed at once.
        // (Those connections' "left" goes out on the bus as they close: it
        // is closed last.)
        server.close(() => {
          clearTimeout(grace);
          store.close();
          void (bus ? bus.close() : Promise.resolve()).then(resolve);
        });
        for (const ws of sockets.clients) {
          ws.close(CloseCode.GoingAway, "server shutting down");
        }
      });
      return closing;
    },
  };
}
