import { describe, expect, test } from "vitest";
import { MAX_NAME_LENGTH, MAX_SELECTION, parsePresence } from "./presence.js";

const presence = { name: "Teal Otter", color: "blue", cursor: { x: 1, y: 2 }, selection: ["c1.1"] };

describe("parsePresence", () => {
  test("accepts a presence, trimming the name and dropping unknown fields", () => {
    expect(parsePresence({ ...presence, name: "  Teal Otter ", extra: 1 })).toEqual({ ok: true, message: presence });
    expect(parsePresence({ ...presence, cursor: null, selection: [] })).toMatchObject({ ok: true });
  });

  test.each([
    ["not an object", "x", "must be an object"],
    ["no name", { ...presence, name: "" }, "a name is"],
    ["a blank name", { ...presence, name: "   " }, "a name is"],
    ["a name too long", { ...presence, name: "x".repeat(MAX_NAME_LENGTH + 1) }, "a name is"],
    ["an unknown color", { ...presence, color: "#f00" }, "an unknown color"],
    ["a cursor without y", { ...presence, cursor: { x: 1 } }, "a cursor is"],
    ["a cursor at infinity", { ...presence, cursor: { x: Infinity, y: 0 } }, "a cursor is"],
    ["a cursor that is a number", { ...presence, cursor: 5 }, "a cursor is"],
    ["a selection that is not a list", { ...presence, selection: "c1.1" }, "a selection is"],
    ["a bad shape id", { ...presence, selection: ["a b"] }, "a selection is"],
    ["too many selected", { ...presence, selection: Array<string>(MAX_SELECTION + 1).fill("c1.1") }, "a selection is"],
  ])("refuses %s", (_name, value, error) => {
    const parsed = parsePresence(value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain(error);
    }
  });
});
