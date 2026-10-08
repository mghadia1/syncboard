import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import {
  CloseCode,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  type ServerMessage,
  parseClientMessage,
} from "@syncboard/shared";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import type { Config } from "./config.js";
import type { Log } from "./log.js";
import { serveClient } from "./static.js";
import { VERSION } from "./version.js";

export type App = {
  server: http.Server;
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

function send(ws: WebSocket, message: ServerMessage): void {
  ws.send(JSON.stringify(message));
}

function text(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

/** Refuses an upgrade with a plain HTTP answer, then hangs up. */
function refuse(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function createApp(config: Config, log: Log): App {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  let closing: Promise<void> | undefined;

  const server = http.createServer((req, res) => {
    const url = URL.parse(req.url ?? "", "http://localhost");
    if (url === null) {
      json(res, 400, { error: "bad request target" });
      return;
    }
    if (url.pathname === "/healthz") {
      if (req.method === "GET" || req.method === "HEAD") {
        // Liveness only: the process is up and answering.
        json(res, 200, { status: "ok", version: VERSION });
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
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        send(ws, { type: "error", code: "bad_message", message: "binary frames are not used" });
        ws.close(CloseCode.BadMessage, "binary frame");
        return;
      }
      const parsed = parseClientMessage(text(data));
      if (!parsed.ok) {
        send(ws, { type: "error", code: "bad_message", message: parsed.error });
        ws.close(CloseCode.BadMessage, "bad message");
        return;
      }
      // A hello is the only client message so far; the board's own
      // messages, and a switch over them, come with sync (Milestone 3).
      const hello = parsed.message;
      if (hello.protocol !== PROTOCOL_VERSION) {
        send(ws, {
          type: "error",
          code: "unsupported_protocol",
          message: `this server speaks protocol ${String(PROTOCOL_VERSION)}, not ${String(hello.protocol)}`,
        });
        ws.close(CloseCode.UnsupportedProtocol, "unsupported protocol");
        return;
      }
      send(ws, { type: "welcome", protocol: PROTOCOL_VERSION, version: VERSION });
    });
    ws.on("close", (code) => {
      log("client disconnected", { code, clients: sockets.clients.size });
    });
  });

  return {
    server,
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
        const grace = setTimeout(() => {
          for (const ws of sockets.clients) {
            ws.terminate();
          }
          server.closeAllConnections();
        }, config.shutdownGraceMs);
        // Called once every connection has ended, upgraded ones included;
        // idle keep-alive connections are closed at once.
        server.close(() => {
          clearTimeout(grace);
          resolve();
        });
        for (const ws of sockets.clients) {
          ws.close(CloseCode.GoingAway, "server shutting down");
        }
      });
      return closing;
    },
  };
}
