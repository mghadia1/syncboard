import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { DIGITS, MAX_KEY_LENGTH, isOrderKey, keyAfter, keyBefore, keyBetween } from "./order.js";

describe("examples", () => {
  test("the first key, and keys around it", () => {
    expect(keyBetween(null, null)).toBe("V");
    expect(keyAfter("V")).toBe("W");
    expect(keyBefore("V")).toBe("U");
    expect(keyBetween("V", "W")).toBe("VV");
    expect(keyAfter("z")).toBe("z1");
    expect(keyBefore("1")).toBe("0z");
    expect(keyBefore("V1")).toBe("V0z");
  });

  test.each([
    ["", "a key cannot be empty"],
    ["V0", "a key cannot end in 0"],
    ["V!", "only base-62 digits"],
    ["x".repeat(MAX_KEY_LENGTH + 1), "nor be too long"],
  ])("%j is not a key: %s", (key) => {
    expect(isOrderKey(key)).toBe(false);
    expect(() => keyAfter(key)).toThrow(RangeError);
    expect(() => keyBefore(key)).toThrow(RangeError);
    expect(() => keyBetween(key, null)).toThrow(RangeError);
  });

  test("keyBetween needs its first key before its second", () => {
    expect(() => keyBetween("W", "V")).toThrow("is not before");
    expect(() => keyBetween("V", "V")).toThrow("is not before");
  });

  test("keys stay short when shapes keep going on top, or to the back", () => {
    let top = keyBetween(null, null);
    let bottom = top;
    for (let i = 0; i < 1000; i++) {
      top = keyAfter(top);
      bottom = keyBefore(bottom);
    }
    expect(top.length).toBeLessThanOrEqual(17);
    expect(bottom.length).toBeLessThanOrEqual(18);
  });

  test("refuses to make a key longer than the limit, rather than an invalid one", () => {
    const longest = "V".repeat(MAX_KEY_LENGTH - 1) + "z";
    expect(isOrderKey(longest)).toBe(true);
    expect(() => keyAfter(longest)).toThrow("would exceed");
  });
});

/**
 * Where a new key goes: on top or at the bottom (keyAfter, keyBefore), at
 * the start or the end by keyBetween with null, or after list[i].
 */
const placement = fc.oneof(
  fc.constant({ at: "top" as const }),
  fc.constant({ at: "bottom" as const }),
  fc.constant({ at: "start" as const }),
  fc.constant({ at: "end" as const }),
  fc.nat().map((i) => ({ at: "after" as const, i })),
);

describe("properties", () => {
  test("any sequence of insertions keeps the keys valid, distinct and in order", () => {
    fc.assert(
      fc.property(fc.array(placement, { maxLength: 200 }), (placements) => {
        const keys: string[] = [];
        for (const place of placements) {
          if (keys.length === 0) {
            keys.push(keyBetween(null, null));
          } else if (place.at === "top") {
            keys.push(keyAfter(keys.at(-1) ?? ""));
          } else if (place.at === "bottom") {
            keys.unshift(keyBefore(keys[0] ?? ""));
          } else if (place.at === "start") {
            keys.unshift(keyBetween(null, keys[0] ?? null));
          } else if (place.at === "end") {
            keys.push(keyBetween(keys.at(-1) ?? null, null));
          } else {
            const i = place.i % keys.length;
            keys.splice(i + 1, 0, keyBetween(keys[i] ?? null, keys[i + 1] ?? null));
          }
        }
        for (const [i, key] of keys.entries()) {
          expect(isOrderKey(key)).toBe(true);
          if (i > 0) {
            expect((keys[i - 1] ?? "") < key).toBe(true);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  const key = fc
    .string({ unit: fc.constantFrom(...Array.from(DIGITS)), minLength: 1, maxLength: 8 })
    .filter(isOrderKey);

  test("keyBetween lands strictly between any two keys", () => {
    fc.assert(
      fc.property(key, key, (a, b) => {
        fc.pre(a !== b);
        const [low, high] = a < b ? [a, b] : [b, a];
        const mid = keyBetween(low, high);
        expect(isOrderKey(mid)).toBe(true);
        expect(low < mid && mid < high).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  test("keyBetween works against the start and the end too", () => {
    fc.assert(
      fc.property(key, (k) => {
        const low = keyBetween(null, k);
        const high = keyBetween(k, null);
        expect(isOrderKey(low) && low < k).toBe(true);
        expect(isOrderKey(high) && high > k).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  test("keyBetween a key and the same key followed by zeros and more", () => {
    // The case where a missing digit has to be read as zero: "V" and "V0z".
    const zeros = fc.integer({ min: 1, max: 3 }).map((n) => "0".repeat(n));
    fc.assert(
      fc.property(key, zeros, key, (prefix, z, rest) => {
        const after = prefix + z + rest;
        const mid = keyBetween(prefix, after);
        expect(isOrderKey(mid)).toBe(true);
        expect(prefix < mid && mid < after).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  test("keyAfter and keyBefore go above and below any key", () => {
    fc.assert(
      fc.property(key, (k) => {
        expect(keyAfter(k) > k && isOrderKey(keyAfter(k))).toBe(true);
        expect(keyBefore(k) < k && isOrderKey(keyBefore(k))).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });
});
