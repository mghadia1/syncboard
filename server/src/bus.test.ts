import { Replica } from "@syncboard/shared";
import { describe, expect, test } from "vitest";
import { type BusMessage, type Envelope, LocalNetwork, encodeEnvelope, parseEnvelope } from "./bus.js";

const presence = { name: "Ann", color: "blue", cursor: { x: 1, y: 2 }, selection: [] } as const;

describe("bus messages", () => {
  const replica = new Replica("a");
  const op = replica.create({ kind: "rectangle", x: 0, y: 0, w: 1, h: 1 });

  test.each<BusMessage>([
    { type: "ops", seq: 7, ops: [op] },
    { type: "presence", client: "a", presence },
    { type: "left", client: "a" },
    { type: "roster", peers: [{ client: "a", presence }], ask: true },
    { type: "roster", peers: [], ask: false },
  ])("$type goes through as it was sent", (message) => {
    const envelope: Envelope = { from: "server1", board: "board01", message };
    expect(parseEnvelope(encodeEnvelope(envelope))).toEqual({ ok: true, message: envelope });
  });

  test.each([
    ["not JSON", "{"],
    ["no sender", JSON.stringify({ board: "board01", message: { type: "left", client: "a" } })],
    ["a bad board id", JSON.stringify({ from: "s", board: "b/../x", message: { type: "left", client: "a" } })],
    ["an unknown type", JSON.stringify({ from: "s", board: "board01", message: { type: "shout" } })],
    ["change number 0", JSON.stringify({ from: "s", board: "board01", message: { type: "ops", seq: 0, ops: [] } })],
    [
      "a bad operation",
      JSON.stringify({ from: "s", board: "board01", message: { type: "ops", seq: 1, ops: [{ shape: "x" }] } }),
    ],
    ["a roster without ask", JSON.stringify({ from: "s", board: "board01", message: { type: "roster", peers: [] } })],
    [
      "a bad presence",
      JSON.stringify({ from: "s", board: "board01", message: { type: "presence", client: "a", presence: {} } }),
    ],
  ])("refuses %s", (_, text) => {
    expect(parseEnvelope(text).ok).toBe(false);
  });
});

describe("LocalNetwork", () => {
  test("delivers later, to every bus that joined the board (the sender's too, as Redis does)", async () => {
    const network = new LocalNetwork();
    const heard: [string, Envelope][] = [];
    const buses = ["s1", "s2", "s3"].map((id) =>
      network.bus(id, (envelope) => {
        heard.push([id, envelope]);
      }),
    );
    buses[0]?.join("board01");
    buses[1]?.join("board01");
    buses[2]?.join("board02");
    buses[0]?.publish("board01", { type: "left", client: "a" });
    expect(heard).toEqual([]); // never during the publish
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(heard.map(([id]) => id).sort()).toEqual(["s1", "s2"]);
    expect(heard[0]?.[1]).toEqual({ from: "s1", board: "board01", message: { type: "left", client: "a" } });
  });

  test("a bus that is down neither sends nor hears", async () => {
    const network = new LocalNetwork();
    const heard: string[] = [];
    const one = network.bus("s1", () => heard.push("s1"));
    const two = network.bus("s2", () => heard.push("s2"));
    one.join("board01");
    two.join("board01");
    one.up = false;
    one.publish("board01", { type: "left", client: "a" });
    two.publish("board01", { type: "left", client: "a" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(heard).toEqual(["s2"]);
    expect(one.status).toBe("disconnected");
  });
});
