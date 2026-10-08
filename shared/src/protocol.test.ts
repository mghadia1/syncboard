import { describe, expect, test } from "vitest";
import { PROTOCOL_VERSION, parseClientMessage, parseServerMessage } from "./protocol.js";

describe("parseClientMessage", () => {
  test("accepts a hello", () => {
    expect(parseClientMessage(JSON.stringify({ type: "hello", protocol: 1 }))).toEqual({
      ok: true,
      message: { type: "hello", protocol: 1 },
    });
  });

  test("ignores fields it does not know", () => {
    const parsed = parseClientMessage(
      JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, client: "a newer one" }),
    );
    expect(parsed).toEqual({
      ok: true,
      message: { type: "hello", protocol: PROTOCOL_VERSION },
    });
  });

  test.each([
    ["not JSON", "{", "not valid JSON"],
    ["a JSON string", '"hello"', "not a JSON object"],
    ["null", "null", "not a JSON object"],
    ["an array", "[1]", "not a JSON object"],
    ["no type", "{}", "unknown message type undefined"],
    ["an unknown type", '{"type":"draw"}', 'unknown message type "draw"'],
    ["a hello without a protocol", '{"type":"hello"}', "hello needs a positive integer protocol"],
    ["a protocol as a string", '{"type":"hello","protocol":"1"}', "hello needs"],
    ["a fractional protocol", '{"type":"hello","protocol":1.5}', "hello needs"],
    ["protocol zero", '{"type":"hello","protocol":0}', "hello needs"],
  ])("refuses %s", (_name, text, error) => {
    const parsed = parseClientMessage(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain(error);
    }
  });

  test("a type inherited from Object.prototype is not a message type", () => {
    expect(parseClientMessage('{"type":"toString","protocol":1}').ok).toBe(false);
  });
});

describe("parseServerMessage", () => {
  test("accepts a welcome and an error", () => {
    expect(
      parseServerMessage(JSON.stringify({ type: "welcome", protocol: 1, version: "0.1.0" })),
    ).toEqual({ ok: true, message: { type: "welcome", protocol: 1, version: "0.1.0" } });
    expect(
      parseServerMessage(
        JSON.stringify({ type: "error", code: "unsupported_protocol", message: "no" }),
      ),
    ).toEqual({
      ok: true,
      message: { type: "error", code: "unsupported_protocol", message: "no" },
    });
  });

  test.each([
    ['{"type":"welcome","protocol":1}', "welcome needs"],
    ['{"type":"error","code":"teapot","message":"x"}', "error needs a known code"],
    ['{"type":"error","code":"bad_message"}', "error needs"],
    ['{"type":"hello","protocol":1}', 'unknown message type "hello"'],
  ])("refuses %s", (text, error) => {
    const parsed = parseServerMessage(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain(error);
    }
  });
});
