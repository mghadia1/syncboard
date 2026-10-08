import { type Operation, PROTOCOL_VERSION, Replica, fromSnapshot, serializeState, toSnapshot } from "@syncboard/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Editor } from "../board/editor";
import { FakeNetwork, type FakeSocket } from "./fakeSocket";
import { Sync } from "./sync";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const box = { kind: "rectangle", x: 0, y: 0, w: 10, h: 10 } as const;

function setup(options: { random?: () => number } = {}) {
  const network = new FakeNetwork();
  const editor = new Editor(new Replica("me"));
  const sync = new Sync({
    editor,
    board: "board01",
    url: "ws://test/ws",
    createSocket: network.create,
    retry: { firstMs: 100, maxMs: 1000 },
    flushMs: 10,
    random: options.random ?? (() => 1),
  });
  sync.start();
  return { network, editor, sync };
}

function welcome(socket: FakeSocket, epoch = "e1", snapshot: unknown = []) {
  socket.receive({ type: "welcome", protocol: PROTOCOL_VERSION, version: "9.9.9", board: "board01", epoch, snapshot, peers: [] });
}

function connect(network: FakeNetwork, epoch = "e1", snapshot: unknown = []) {
  const socket = network.last();
  socket.open();
  welcome(socket, epoch, snapshot);
  return socket;
}

const sentOps = (socket: FakeSocket) => socket.sentOfType("ops").flatMap((m) => m.ops as Operation[]);

describe("connecting", () => {
  test("says hello with the board and this replica's id, then is online", () => {
    const { network, sync } = setup();
    expect(sync.getStatus()).toEqual({ state: "connecting", pending: 0 });
    const socket = network.last();
    socket.open();
    expect(socket.sent).toEqual([{ type: "hello", protocol: PROTOCOL_VERSION, board: "board01", client: "me" }]);
    welcome(socket);
    expect(sync.getStatus()).toEqual({ state: "online", version: "9.9.9", pending: 0 });
  });

  test("the server's board is merged in", () => {
    const { network, editor } = setup();
    const other = new Replica("other");
    other.create(box);
    connect(network, "e1", toSnapshot(other.state));
    expect(serializeState(editor.replica.state)).toBe(serializeState(other.state));
  });
});

describe("sending and acknowledging", () => {
  test("a burst of edits goes out as one frame; acks drop what they cover", () => {
    const { network, editor, sync } = setup();
    const socket = connect(network);
    const id = editor.create(box);
    editor.begin("Move");
    for (const x of [1, 2, 3]) {
      editor.update(id, { x });
    }
    editor.commit();
    expect(sync.getStatus()).toMatchObject({ state: "online", pending: 4 });
    expect(socket.sentOfType("ops")).toEqual([]); // gathered for flushMs
    vi.advanceTimersByTime(10);
    expect(socket.sentOfType("ops")).toHaveLength(1);
    expect(sentOps(socket).map((op) => op.stamp.counter)).toEqual([1, 2, 3, 4]);
    socket.receive({ type: "ack", upTo: 2 });
    expect(sync.pending.map((op) => op.stamp.counter)).toEqual([3, 4]);
    socket.receive({ type: "ack", upTo: 4 });
    expect(sync.getStatus()).toMatchObject({ state: "online", pending: 0 });
  });

  test("others' edits are applied, and not sent back", () => {
    const { network, editor, sync } = setup();
    const socket = connect(network);
    const other = new Replica("other");
    socket.receive({ type: "ops", ops: [other.create(box)] });
    expect(editor.getSnapshot().shapes).toHaveLength(1);
    vi.advanceTimersByTime(50);
    expect(socket.sentOfType("ops")).toEqual([]);
    expect(sync.pending).toEqual([]);
  });

  test("many edits are split into frames of at most 500", () => {
    const { network, editor } = setup();
    const socket = connect(network);
    const id = editor.create(box);
    for (let i = 0; i < 1199; i++) {
      editor.update(id, { x: i });
    }
    vi.advanceTimersByTime(10);
    expect(socket.sentOfType("ops").map((m) => (m.ops as unknown[]).length)).toEqual([500, 500, 200]);
  });
});

describe("a dropped connection", () => {
  test("editing goes on offline; the reconnect resends exactly what was not acknowledged", () => {
    const { network, editor, sync } = setup();
    const first = connect(network);
    const id = editor.create(box);
    vi.advanceTimersByTime(10);
    first.receive({ type: "ack", upTo: 1 });
    editor.update(id, { x: 5 }); // sent, never acknowledged
    vi.advanceTimersByTime(10);
    first.drop();
    expect(sync.getStatus()).toEqual({ state: "offline", pending: 1, retryInMs: 100 });
    editor.update(id, { x: 6 }); // made offline
    expect(sync.getStatus()).toMatchObject({ state: "offline", pending: 2 });
    vi.advanceTimersByTime(99);
    expect(network.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    const second = connect(network, "e1"); // the same server copy: no upload
    expect(second.sentOfType("state")).toEqual([]);
    expect(sentOps(second).map((op) => op.set)).toEqual([{ x: 5 }, { x: 6 }]);
  });

  test("backoff doubles up to the most, with jitter between half and all of it", () => {
    const delays: number[] = [];
    const { network, sync } = setup({ random: () => 0 });
    for (let i = 0; i < 6; i++) {
      network.last().drop();
      const status = sync.getStatus();
      delays.push(status.state === "offline" ? status.retryInMs : -1);
      vi.advanceTimersByTime(10_000);
    }
    expect(delays).toEqual([50, 100, 200, 400, 500, 500]);
  });

  test("a welcome resets the backoff", () => {
    const { network, sync } = setup();
    network.last().drop();
    vi.advanceTimersByTime(100);
    network.last().drop();
    vi.advanceTimersByTime(200);
    connect(network);
    network.last().drop();
    expect(sync.getStatus()).toMatchObject({ retryInMs: 100 });
  });
});

describe("a server that lost the board", () => {
  test("a new epoch: everything is uploaded, in chunks, and the acks clear pending", () => {
    const { network, editor, sync } = setup();
    const first = connect(network, "e1");
    for (let i = 0; i < 300; i++) {
      editor.create({ ...box, x: i, text: "x".repeat(2000) });
    }
    first.drop();
    vi.advanceTimersByTime(100);
    const second = connect(network, "e2", []); // restarted: it knows nothing
    const chunks = second.sentOfType("state");
    expect(chunks.length).toBeGreaterThan(1);
    const uploaded = new Replica("check");
    for (const chunk of chunks) {
      uploaded.merge(fromSnapshot(chunk.snapshot as Parameters<typeof fromSnapshot>[0]));
    }
    expect(serializeState(uploaded.state)).toBe(serializeState(editor.replica.state));
    second.receive({ type: "ack", upTo: 300 });
    expect(sync.pending).toEqual([]);
  });

  test("a pending edit someone else has since overwritten is still sent after the upload", () => {
    // Found by the end-to-end test: the upload holds only each property's
    // winning value, so it does not carry this edit, and nothing acknowledged it.
    const { network, editor, sync } = setup();
    const first = connect(network, "e1");
    const id = editor.create(box);
    vi.advanceTimersByTime(10);
    first.receive({ type: "ack", upTo: 1 });
    first.drop();
    editor.update(id, { x: 5 }); // ours, offline: counter 2
    const other = new Replica("zz");
    other.apply({ shape: id, stamp: { counter: 50, client: "zz" }, set: { x: 99 } });
    vi.advanceTimersByTime(100);
    const second = connect(network, "e2", toSnapshot(other.state)); // a restarted server that has zz's edit
    expect(editor.replica.shape(id)?.x).toBe(99);
    expect(second.sentOfType("state")).toHaveLength(1);
    expect(sentOps(second).map((op) => op.stamp.counter)).toEqual([2]);
    second.receive({ type: "ack", upTo: 2 });
    expect(sync.pending).toEqual([]);
  });

  test("edits made before ever connecting are uploaded on the first welcome", () => {
    const { network, editor } = setup();
    editor.create(box);
    const socket = connect(network, "e1");
    expect(socket.sentOfType("state")).toHaveLength(1);
  });

  test("an empty replica has nothing to upload", () => {
    const { network } = setup();
    const socket = connect(network, "e1");
    expect(socket.sentOfType("state")).toEqual([]);
  });
});

describe("refusals are final", () => {
  test("another protocol: the server's reason is shown, and there is no retry", () => {
    const { network, sync } = setup();
    const socket = network.last();
    socket.open();
    socket.receive({ type: "error", code: "unsupported_protocol", message: "this server speaks protocol 9" });
    socket.drop(4001);
    expect(sync.getStatus()).toEqual({ state: "refused", reason: "this server speaks protocol 9", pending: 0 });
    vi.advanceTimersByTime(60_000);
    expect(network.sockets).toHaveLength(1);
  });

  test("a server that sends nonsense", () => {
    const { network, sync } = setup();
    const socket = network.last();
    socket.open();
    socket.receive("{not json");
    expect(sync.getStatus()).toMatchObject({ state: "refused", reason: "the server sent something unreadable" });
    expect(socket.closedWith).toBe(1000);
    vi.advanceTimersByTime(60_000);
    expect(network.sockets).toHaveLength(1);
  });

  test("a welcome to another board", () => {
    const { network, sync } = setup();
    const socket = network.last();
    socket.open();
    socket.receive({ type: "welcome", protocol: PROTOCOL_VERSION, version: "1", board: "board99", epoch: "e", snapshot: [], peers: [] });
    expect(sync.getStatus()).toMatchObject({ state: "refused", reason: "joined board99, not board01" });
  });
});

test("stop closes the socket and stops listening; start again picks up", () => {
  const { network, editor, sync } = setup();
  const socket = connect(network);
  sync.stop();
  expect(socket.closedWith).toBe(1000);
  editor.create(box);
  expect(sync.pending).toEqual([]);
  vi.advanceTimersByTime(60_000);
  expect(network.sockets).toHaveLength(1);
  sync.start();
  expect(network.sockets).toHaveLength(2);
});

describe("presence", () => {
  const me = { name: "Teal Otter", color: "blue", cursor: null, selection: [] } as const;

  function withPresence() {
    const network = new FakeNetwork();
    const editor = new Editor(new Replica("me"));
    const sync = new Sync({
      editor,
      board: "board01",
      url: "ws://test/ws",
      createSocket: network.create,
      retry: { firstMs: 100, maxMs: 1000 },
      random: () => 1,
      presence: me,
    });
    sync.start();
    return { network, sync };
  }

  test("is sent after the welcome, then at most every 40 ms, the latest winning", () => {
    const { network, sync } = withPresence();
    sync.setPresence({ cursor: { x: 1, y: 1 } }); // before the welcome: waits for it
    const socket = connect(network);
    vi.advanceTimersByTime(0);
    expect(socket.sentOfType("presence").map((m) => m.presence)).toEqual([{ ...me, cursor: { x: 1, y: 1 } }]);
    for (let x = 2; x <= 5; x++) {
      sync.setPresence({ cursor: { x, y: 1 } });
    }
    vi.advanceTimersByTime(39);
    expect(socket.sentOfType("presence")).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(socket.sentOfType("presence").map((m) => m.presence)).toEqual([
      { ...me, cursor: { x: 1, y: 1 } },
      { ...me, cursor: { x: 5, y: 1 } },
    ]);
  });

  test("others come from the welcome, presence and left; offline, they are forgotten", () => {
    const { network, sync } = withPresence();
    const socket = network.last();
    socket.open();
    const ann = { name: "Ann", color: "red", cursor: null, selection: [] };
    socket.receive({
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      version: "1",
      board: "board01",
      epoch: "e",
      snapshot: [],
      peers: [{ client: "ann", presence: ann }],
    });
    expect([...sync.getPeers()]).toEqual([["ann", ann]]);
    socket.receive({ type: "presence", client: "bo", presence: { ...ann, name: "Bo" } });
    expect([...sync.getPeers().keys()]).toEqual(["ann", "bo"]);
    socket.receive({ type: "left", client: "ann" });
    expect([...sync.getPeers().keys()]).toEqual(["bo"]);
    socket.drop();
    expect(sync.getPeers().size).toBe(0);
  });

  test("a reconnect sends presence again, even unchanged", () => {
    const { network } = withPresence();
    connect(network);
    vi.advanceTimersByTime(0);
    network.last().drop();
    vi.advanceTimersByTime(100);
    const second = connect(network);
    vi.advanceTimersByTime(40);
    expect(second.sentOfType("presence")).toHaveLength(1);
  });
});
