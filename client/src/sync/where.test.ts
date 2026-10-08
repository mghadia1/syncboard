import { isBoardId } from "@syncboard/shared";
import { expect, test, vi } from "vitest";
import { boardFromLocation, socketUrl } from "./where";

test("the socket URL follows the page: ws on http, wss on https", () => {
  expect(socketUrl({ protocol: "http:", host: "localhost:8300" })).toBe("ws://localhost:8300/ws");
  expect(socketUrl({ protocol: "https:", host: "board.example" })).toBe("wss://board.example/ws");
});

test("a board link's id is used as it is", () => {
  const history = { replaceState: vi.fn() };
  expect(boardFromLocation({ pathname: "/b/AbC123xyz" }, history)).toBe("AbC123xyz");
  expect(history.replaceState).not.toHaveBeenCalled();
});

test.each(["/", "/b/", "/b/abc", "/b/AbC123xyz/x", "/other"])(
  "%s starts a new board, and the address becomes its link",
  (pathname) => {
    const history = { replaceState: vi.fn() };
    const board = boardFromLocation({ pathname }, history);
    expect(isBoardId(board)).toBe(true);
    expect(history.replaceState).toHaveBeenCalledWith(null, "", `/b/${board}`);
  },
);
