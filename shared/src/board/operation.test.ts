import { describe, expect, test } from "vitest";
import { parseOperation } from "./operation.js";
import { MAX_COORDINATE, MAX_POINTS, MAX_TEXT_LENGTH } from "./shape.js";

const stamp = { counter: 3, client: "a1" };

describe("parseOperation", () => {
  test("accepts a well-formed operation, and copies only what it checked", () => {
    expect(
      parseOperation({ shape: "a1.3", stamp: { ...stamp, extra: 1 }, set: { x: 1, fill: "none" } }),
    ).toEqual({ ok: true, message: { shape: "a1.3", stamp, set: { x: 1, fill: "none" } } });
  });

  test.each([
    ["not an object", [1], "must be an object"],
    ["no shape id", { stamp, set: { x: 1 } }, "bad shape id"],
    ["a shape id with spaces", { shape: "a b", stamp, set: { x: 1 } }, "bad shape id"],
    ["no stamp", { shape: "s", set: { x: 1 } }, "bad stamp"],
    ["counter zero", { shape: "s", stamp: { counter: 0, client: "a" }, set: { x: 1 } }, "bad stamp"],
    ["fractional counter", { shape: "s", stamp: { counter: 1.5, client: "a" }, set: { x: 1 } }, "bad stamp"],
    [
      "counter past 2^53",
      { shape: "s", stamp: { counter: 2 ** 53, client: "a" }, set: { x: 1 } },
      "bad stamp",
    ],
    ["empty client", { shape: "s", stamp: { counter: 1, client: "" }, set: { x: 1 } }, "bad stamp"],
    ["set is not an object", { shape: "s", stamp, set: [] }, "set must be an object"],
    ["nothing set", { shape: "s", stamp, set: {} }, "must set something"],
    ["an unknown property", { shape: "s", stamp, set: { rotation: 1 } }, 'unknown property "rotation"'],
    ["an inherited name", { shape: "s", stamp, set: { toString: 1 } }, "unknown property"],
    ["an unknown kind", { shape: "s", stamp, set: { kind: "star" } }, "bad value for kind"],
    ["a number as a string", { shape: "s", stamp, set: { x: "1" } }, "bad value for x"],
    ["infinity", { shape: "s", stamp, set: { x: Infinity } }, "bad value for x"],
    ["too far away", { shape: "s", stamp, set: { y: MAX_COORDINATE + 1 } }, "bad value for y"],
    ["an unknown color", { shape: "s", stamp, set: { stroke: "#ff0000" } }, "bad value for stroke"],
    ["a bad order key", { shape: "s", stamp, set: { z: "V0" } }, "bad value for z"],
    ["text too long", { shape: "s", stamp, set: { text: "x".repeat(MAX_TEXT_LENGTH + 1) } }, "bad value for text"],
    ["an odd number of point coordinates", { shape: "s", stamp, set: { points: [1, 2, 3] } }, "bad value for points"],
    [
      "too many points",
      { shape: "s", stamp, set: { points: Array<number>(MAX_POINTS + 2).fill(0) } },
      "bad value for points",
    ],
    ["deleted as a string", { shape: "s", stamp, set: { deleted: "true" } }, "bad value for deleted"],
  ])("refuses %s", (_name, value, error) => {
    const parsed = parseOperation(value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain(error);
    }
  });
});
