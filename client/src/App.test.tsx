import { type Operation, PROTOCOL_VERSION, Replica } from "@syncboard/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { App } from "./App";
import { Editor } from "./board/editor";
import { FakeNetwork } from "./sync/fakeSocket";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const network = new FakeNetwork((fn) => {
    act(fn);
  });
  const editor = new Editor(new Replica("me"));
  const view = render(
    <App url="ws://board.test/ws" board="board01" create={network.create} editor={editor} retry={{ firstMs: 100, maxMs: 100 }} />,
  );
  const status = () => screen.getByRole("status", { name: "Connection" });
  return { network, editor, view, status };
}

function welcome(network: FakeNetwork, epoch = "e1") {
  const socket = network.last();
  socket.open();
  socket.receive({ type: "welcome", protocol: PROTOCOL_VERSION, version: "0.1.0", board: "board01", epoch, snapshot: [] });
  return socket;
}

describe("the connection badge", () => {
  test("connecting, then connected", () => {
    const { network, status } = setup();
    expect(status()).toHaveTextContent("Connecting…");
    welcome(network);
    expect(status()).toHaveTextContent("Connected server 0.1.0");
  });

  test("changes waiting to be sent, offline, and back", () => {
    const { network, editor, status } = setup();
    const socket = welcome(network);
    act(() => {
      editor.create({ kind: "rectangle", x: 0, y: 0, w: 10, h: 10 });
    });
    expect(status()).toHaveTextContent("Connected sending 1 change");
    socket.drop();
    expect(status()).toHaveTextContent("Offline 1 change waiting, reconnecting");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    welcome(network);
    act(() => {
      vi.advanceTimersByTime(20);
    });
    network.last().receive({ type: "ack", upTo: 1 });
    expect(status()).toHaveTextContent("Connected server 0.1.0");
  });

  test("a refusal says why", () => {
    const { network, status } = setup();
    const socket = network.last();
    socket.open();
    socket.receive({ type: "error", code: "unsupported_protocol", message: "this server speaks protocol 3" });
    socket.drop(4001);
    expect(status()).toHaveTextContent("Refused this server speaks protocol 3");
  });
});

test("what is drawn here is sent; what others draw appears", () => {
  const { network, view } = setup();
  const socket = welcome(network);
  const canvas = view.getByRole("img", { name: /^Board with/ });
  fireEvent.keyDown(window, { key: "r" });
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 60, clientY: 60 });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 60, clientY: 60 });
  act(() => {
    vi.advanceTimersByTime(20);
  });
  const sent = socket.sentOfType("ops").flatMap((m) => m.ops as Operation[]);
  expect(sent).toMatchObject([{ stamp: { client: "me" }, set: { kind: "rectangle", x: 10, y: 10, w: 50, h: 50 } }]);
  const other = new Replica("other");
  socket.receive({ type: "ops", ops: [other.create({ kind: "ellipse", x: 100, y: 100, w: 20, h: 20 })] });
  expect(view.getByRole("img", { name: "Board with 2 shapes" })).toBeInTheDocument();
});

describe("copy link", () => {
  test("copies the page's address", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(screen.getByRole("button", { name: "Link copied" })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
  });

  test("without a clipboard (plain HTTP), says what to do instead", () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(screen.getByRole("button", { name: "Copy the address bar" })).toBeInTheDocument();
  });
});

test("closing the page closes the socket", () => {
  const { network, view } = setup();
  const socket = welcome(network);
  view.unmount();
  expect(socket.closedWith).toBe(1000);
});
