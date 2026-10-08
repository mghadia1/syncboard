import { PERSON_COLORS } from "@syncboard/shared";
import { describe, expect, test } from "vitest";
import { cleanName, colorFor, loadName, randomName } from "./identity";

test("a random name is an adjective and an animal", () => {
  expect(randomName(() => 0)).toBe("Amber Badger");
  expect(randomName(() => 0.999)).toBe("Teal Wren");
});

test("a name's color is one of the people colors, and always the same", () => {
  for (const name of ["Ann", "Bo", "Teal Otter", "日本"]) {
    expect(PERSON_COLORS).toContain(colorFor(name));
    expect(colorFor(name)).toBe(colorFor(name));
  }
});

test.each([
  ["  Ann   Lee ", "Ann Lee"],
  ["", null],
  ["   ", null],
  ["x".repeat(60), "x".repeat(40)],
])("cleanName(%j) is %j", (typed, name) => {
  expect(cleanName(typed)).toBe(name);
});

describe("loadName", () => {
  function store(initial: string | null = null) {
    let value = initial;
    return {
      getItem: () => value,
      setItem: (_key: string, next: string) => {
        value = next;
      },
      value: () => value,
    };
  }

  test("keeps the name this browser has", () => {
    expect(loadName(store("Ann"))).toBe("Ann");
  });

  test("makes and keeps a name when there is none, or a blank one", () => {
    for (const s of [store(null), store("   ")]) {
      const name = loadName(s);
      expect(name).toMatch(/^\w+ \w+$/);
      expect(s.value()).toBe(name);
    }
  });

  test("works when storage refuses (a private window)", () => {
    const refusing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadName(refusing)).toMatch(/^\w+ \w+$/);
    expect(loadName(null)).toMatch(/^\w+ \w+$/);
  });
});
