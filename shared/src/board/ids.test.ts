import { expect, test } from "vitest";
import { isBoardId, newBoardId, newClientId } from "./stamp.js";

test("new board ids are valid, 12 characters, and do not repeat", () => {
  const ids = Array.from({ length: 2000 }, newBoardId);
  expect(ids.every((id) => isBoardId(id) && id.length === 12)).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
});

test("new client ids are 16 hex digits and do not repeat", () => {
  const ids = Array.from({ length: 2000 }, newClientId);
  expect(ids.every((id) => /^[0-9a-f]{16}$/.test(id))).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
});
