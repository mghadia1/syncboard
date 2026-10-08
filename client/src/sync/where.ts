import { isBoardId, newBoardId } from "@syncboard/shared";

/** The server's WebSocket endpoint, on whatever host served this page. */
export function socketUrl(location: Pick<Location, "protocol" | "host"> = window.location): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

/**
 * The board this page is for: the id in its link (/b/<id>). A page opened
 * at / starts a new board, and its address becomes the board's link, to
 * share with whoever should draw on it.
 */
export function boardFromLocation(
  location: Pick<Location, "pathname"> = window.location,
  history: Pick<History, "replaceState"> = window.history,
): string {
  const id = location.pathname.startsWith("/b/") ? location.pathname.slice(3) : "";
  if (isBoardId(id)) {
    return id;
  }
  const board = newBoardId();
  history.replaceState(null, "", `/b/${board}`);
  return board;
}
