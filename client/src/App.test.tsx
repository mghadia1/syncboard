import { PROTOCOL_VERSION } from "@syncboard/shared";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { App } from "./App";
import type { CreateSocket } from "./connection";
import { socketUrl } from "./connection";

/** Just enough of a WebSocket for the hook, driven by the test. */
class FakeSocket {
  sent: string[] = [];
  closedWith: number | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    this.closedWith = code;
  }

  // What the server does:
  open(): void {
    act(() => this.onopen?.());
  }

  receive(data: unknown): void {
    act(() => this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) }));
  }

  serverClose(code: number): void {
    act(() => this.onclose?.({ code }));
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const create: CreateSocket = (url) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket as unknown as WebSocket;
  };
  const view = render(<App url="ws://board.test/ws" create={create} />);
  const socket = sockets.at(-1);
  if (socket === undefined) {
    throw new Error("no socket was opened");
  }
  return { socket, view };
}

describe("the connection badge", () => {
  test("says hello once the socket opens, and shows the server's welcome", () => {
    const { socket } = setup();
    expect(socket.url).toBe("ws://board.test/ws");
    expect(screen.getByRole("status")).toHaveTextContent("Connecting…");

    socket.open();
    expect(socket.sent.map((frame) => JSON.parse(frame) as unknown)).toEqual([
      { type: "hello", protocol: PROTOCOL_VERSION },
    ]);

    socket.receive({ type: "welcome", protocol: PROTOCOL_VERSION, version: "0.1.0" });
    expect(screen.getByRole("status")).toHaveTextContent("Connected server 0.1.0");
  });

  test("shows why the server refused, even after it closes the socket", () => {
    const { socket } = setup();
    socket.open();
    socket.receive({ type: "error", code: "unsupported_protocol", message: "speak protocol 2" });
    socket.serverClose(4001);
    expect(screen.getByRole("status")).toHaveTextContent("Refused speak protocol 2");
  });

  test("does not trust what the server sends", () => {
    const { socket } = setup();
    socket.open();
    socket.receive("not json");
    expect(screen.getByRole("status")).toHaveTextContent("the server sent something unreadable");
    expect(socket.closedWith).toBe(1000);
  });

  test("shows a dropped connection", () => {
    const { socket } = setup();
    socket.open();
    socket.receive({ type: "welcome", protocol: PROTOCOL_VERSION, version: "0.1.0" });
    socket.serverClose(1001);
    expect(screen.getByRole("status")).toHaveTextContent("Disconnected");
  });

  test("closes the socket when the page goes away", () => {
    const { socket, view } = setup();
    view.unmount();
    expect(socket.closedWith).toBe(1000);
  });
});

test("the socket URL follows the page: ws on http, wss on https", () => {
  expect(socketUrl({ protocol: "http:", host: "localhost:8300" } as Location)).toBe(
    "ws://localhost:8300/ws",
  );
  expect(socketUrl({ protocol: "https:", host: "board.example" } as Location)).toBe(
    "wss://board.example/ws",
  );
});
