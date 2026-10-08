import { PROTOCOL_VERSION, parseServerMessage } from "@syncboard/shared";
import { useEffect, useState } from "react";

export type Connection =
  | { state: "connecting" }
  | { state: "connected"; version: string }
  | { state: "refused"; reason: string }
  | { state: "disconnected"; code: number };

export type CreateSocket = (url: string) => WebSocket;

const createSocket: CreateSocket = (url) => new WebSocket(url);

/** The server's WebSocket endpoint, on whatever host served this page. */
export function socketUrl(location: Location = window.location): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

/**
 * Opens the WebSocket, says hello, and reports what came of it. No
 * reconnecting yet: that, with resending what was not acknowledged, is
 * Milestone 3.
 */
export function useConnection(url: string, create: CreateSocket = createSocket): Connection {
  const [connection, setConnection] = useState<Connection>({ state: "connecting" });

  useEffect(() => {
    const socket = create(url);
    let refused = false;
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION }));
    };
    socket.onmessage = (event: MessageEvent) => {
      const parsed = typeof event.data === "string" ? parseServerMessage(event.data) : null;
      if (parsed === null || !parsed.ok) {
        refused = true;
        setConnection({ state: "refused", reason: "the server sent something unreadable" });
        socket.close();
        return;
      }
      const message = parsed.message;
      switch (message.type) {
        case "welcome":
          setConnection({ state: "connected", version: message.version });
          return;
        case "error":
          refused = true;
          setConnection({ state: "refused", reason: message.message });
          return;
      }
    };
    socket.onclose = (event: CloseEvent) => {
      if (!refused) {
        setConnection({ state: "disconnected", code: event.code });
      }
    };
    return () => {
      socket.onclose = null;
      socket.close();
    };
  }, [url, create]);

  return connection;
}
