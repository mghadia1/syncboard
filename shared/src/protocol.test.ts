import { describe, expect, test } from "vitest";
import { MAX_OPS_PER_MESSAGE, PROTOCOL_VERSION, parseClientMessage, parseServerMessage } from "./protocol.js";

const op = { shape: "c1.1", stamp: { counter: 1, client: "c1" }, set: { x: 1 } };
const hello = { type: "hello", protocol: PROTOCOL_VERSION, board: "board123", client: "c1" };
const presence = { name: "Teal Otter", color: "blue", cursor: { x: 1, y: 2 }, selection: ["c1.1"] };

function refused(parsed: { ok: boolean; error?: string }, error: string) {
  expect(parsed.ok).toBe(false);
  expect(parsed.error).toContain(error);
}

describe("parseClientMessage", () => {
  test("accepts a hello, ignoring fields it does not know", () => {
    expect(parseClientMessage(JSON.stringify({ ...hello, extra: true }))).toEqual({ ok: true, message: hello });
  });

  test("lets an old client's hello through, so the server can name its protocol", () => {
    expect(parseClientMessage(JSON.stringify({ type: "hello", protocol: 1 }))).toEqual({
      ok: true,
      message: { type: "hello", protocol: 1, board: "", client: "" },
    });
  });

  test("accepts a presence", () => {
    expect(parseClientMessage(JSON.stringify({ type: "presence", presence }))).toEqual({
      ok: true,
      message: { type: "presence", presence },
    });
  });

  test("accepts ops and a state", () => {
    expect(parseClientMessage(JSON.stringify({ type: "ops", ops: [op] }))).toEqual({
      ok: true,
      message: { type: "ops", ops: [op] },
    });
    const snapshot = [["c1.1", [["x", 1, 1, "c1"]]]];
    expect(parseClientMessage(JSON.stringify({ type: "state", snapshot }))).toEqual({
      ok: true,
      message: { type: "state", snapshot },
    });
  });

  test.each([
    ["not JSON", "{", "not valid JSON"],
    ["an array", "[1]", "not a JSON object"],
    ["an unknown type", '{"type":"draw"}', 'unknown message type "draw"'],
    ["a type inherited from Object.prototype", '{"type":"toString"}', "unknown message type"],
    ["a hello without a protocol", '{"type":"hello"}', "positive integer protocol"],
    ["a fractional protocol", '{"type":"hello","protocol":1.5}', "positive integer protocol"],
    ["a hello without a board", JSON.stringify({ ...hello, board: undefined }), "board id and a client id"],
    ["a board id too short", JSON.stringify({ ...hello, board: "abc" }), "board id"],
    ["a board id with a slash", JSON.stringify({ ...hello, board: "abc/defg" }), "board id"],
    ["a client id with spaces", JSON.stringify({ ...hello, client: "a b" }), "client id"],
    ["no ops", '{"type":"ops","ops":[]}', "ops must be 1 to"],
    ["ops that are not a list", '{"type":"ops","ops":{}}', "ops must be"],
    [
      "too many ops",
      JSON.stringify({ type: "ops", ops: Array<unknown>(MAX_OPS_PER_MESSAGE + 1).fill(op) }),
      "ops must be 1 to",
    ],
    ["a bad op among good ones", JSON.stringify({ type: "ops", ops: [op, { ...op, set: {} }] }), "operation 1:"],
    ["a state that is not a list", '{"type":"state","snapshot":{}}', "must be an array"],
    ["a state with a bad value", '{"type":"state","snapshot":[["s",[["x","1",1,"c"]]]]}', "bad value for x"],
  ])("refuses %s", (_name, text, error) => {
    refused(parseClientMessage(text), error);
  });
});

describe("parseServerMessage", () => {
  const welcome = {
    type: "welcome",
    protocol: PROTOCOL_VERSION,
    version: "0.1.0",
    board: "board123",
    epoch: "e1",
    snapshot: [],
    peers: [{ client: "c2", presence }],
  };

  test("accepts each message", () => {
    for (const message of [
      welcome,
      { type: "ops", ops: [op] },
      { type: "ack", upTo: 7 },
      { type: "error", code: "not_yours", message: "no" },
      { type: "presence", client: "c2", presence },
      { type: "left", client: "c2" },
    ]) {
      expect(parseServerMessage(JSON.stringify(message))).toEqual({ ok: true, message });
    }
  });

  test.each([
    [JSON.stringify({ ...welcome, epoch: "" }), "welcome needs"],
    [JSON.stringify({ ...welcome, board: "x" }), "welcome needs"],
    [JSON.stringify({ ...welcome, snapshot: [["s", [["kind", "star", 1, "c"]]]] }), "bad value for kind"],
    [JSON.stringify({ ...welcome, peers: undefined }), "peers must be a list"],
    [JSON.stringify({ ...welcome, peers: [{ client: "c2" }] }), "each peer needs"],
    [JSON.stringify({ type: "presence", client: "a b", presence }), "presence needs a client id"],
    ['{"type":"left"}', "left needs a client id"],
    ['{"type":"ack","upTo":0}', "ack needs a counter"],
    ['{"type":"ack","upTo":1.5}', "ack needs a counter"],
    ['{"type":"error","code":"teapot","message":"x"}', "error needs a known code"],
    ['{"type":"hello","protocol":2}', 'unknown message type "hello"'],
  ])("refuses %s", (text, error) => {
    refused(parseServerMessage(text), error);
  });
});
