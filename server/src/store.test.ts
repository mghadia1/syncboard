import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { type Entry, PROP_NAMES, type PropName, Replica, type ShapeId, serializeState } from "@syncboard/shared";
import { afterEach, describe, expect, test } from "vitest";
import { StorageError, Store } from "./store.js";

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  stores.splice(0).forEach((s) => {
    s.close();
  });
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function open(dir?: string) {
  const d = dir ?? (await mkdtemp(path.join(os.tmpdir(), "syncboard-store-")));
  if (!dir) {
    dirs.push(d);
  }
  const store = new Store(d);
  stores.push(store);
  return { store, dir: d };
}

function registers(replica: Replica): [ShapeId, PropName, Entry][] {
  const out: [ShapeId, PropName, Entry][] = [];
  for (const [shape, props] of replica.state) {
    for (const name of PROP_NAMES) {
      const entry = props[name];
      if (entry) {
        out.push([shape, name, entry]);
      }
    }
  }
  return out;
}

function aBoard() {
  const r = new Replica("a");
  const id = r.create({ kind: "note", x: 1.5, y: -2, w: 10, h: 10, text: "héllo 👋 \"quoted\"" }).shape;
  r.create({ kind: "freehand", x: 0, y: 0, w: 4, h: 4, points: [0, 0, 4, 4] });
  r.update(id, { stroke: "red" });
  r.delete(id);
  return r;
}

describe("a board on disk", () => {
  test("comes back as it was saved, epoch and all, after closing and opening again", async () => {
    const { store, dir } = await open();
    const board = aBoard();
    store.create("board01", "epoch1", 1000);
    store.save("board01", registers(board));
    store.close();
    stores.pop();
    const { store: again } = await open(dir);
    const loaded = again.load("board01");
    expect(loaded?.epoch).toBe("epoch1");
    expect(serializeState(loaded?.state ?? new Map())).toBe(serializeState(board.state));
  });

  test("a later save of a register replaces it", async () => {
    const { store } = await open();
    const r = new Replica("a");
    const id = r.create({ kind: "rectangle", x: 0, y: 0, w: 1, h: 1 }).shape;
    store.create("board01", "e", 1000);
    store.save("board01", registers(r));
    r.update(id, { x: 9 });
    store.save("board01", registers(r));
    expect(store.load("board01")?.state.get(id)?.x?.value).toBe(9);
  });

  test("an unknown board is null; boards are counted", async () => {
    const { store } = await open();
    expect(store.load("nothere1")).toBeNull();
    store.create("board01", "e", 1000);
    store.create("board02", "e", 1000);
    expect(store.boardCount).toBe(2);
  });

  test("a save is all or nothing", async () => {
    const { store } = await open();
    store.create("board01", "e", 1000);
    const [first] = registers(aBoard());
    function* failing(): Generator<[ShapeId, PropName, Entry]> {
      if (first) {
        yield first;
      }
      throw new Error("the disk is full");
    }
    expect(() => {
      store.save("board01", failing());
    }).toThrow(StorageError);
    expect(store.load("board01")?.state.size).toBe(0);
  });

  test("a damaged row stops the board loading, rather than being served", async () => {
    const { store, dir } = await open();
    store.create("board01", "e", 1000);
    store.save("board01", registers(aBoard()));
    const db = new DatabaseSync(path.join(dir, "boards.sqlite"));
    db.exec(`UPDATE registers SET value = '"not a number"' WHERE prop = 'x'`);
    db.close();
    expect(() => store.load("board01")).toThrow("bad value for x");
  });

  test("the database is in WAL mode, so a commit is one append and one fsync", async () => {
    const { store, dir } = await open();
    store.create("board01", "e", 1000);
    const db = new DatabaseSync(path.join(dir, "boards.sqlite"));
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    db.close();
  });
});

describe("servers sharing the file", () => {
  test("the disk keeps the later value, whichever server stores first", async () => {
    const { store: one, dir } = await open();
    const { store: two } = await open(dir);
    one.create("board01", "e", 1000);
    const a = new Replica("a");
    const id = a.create({ kind: "rectangle", x: 0, y: 0, w: 1, h: 1 }).shape;
    const b = new Replica("b");
    b.apply({ shape: id, stamp: { counter: 1, client: "a" }, set: {} });
    const early = a.update(id, { x: 10 }); // counter 2
    b.update(id, { x: 20 }); // counter 2, client "b": later than a's
    const late = b.update(id, { x: 30 }); // counter 3
    expect(early.stamp.counter).toBe(2);
    // Server two stores b's later value; then server one, which has not
    // heard of it, stores a's earlier one: it must not replace it.
    expect(two.save("board01", registers(b))).toBe(1);
    expect(one.save("board01", registers(a))).toBe(2); // its other registers are new
    const stored = one.load("board01")?.state.get(id);
    expect(stored?.x?.value).toBe(30);
    expect(stored?.x?.stamp).toEqual(late.stamp);
    expect(stored?.kind?.value).toBe("rectangle");
  });

  test("a save with nothing later than the disk commits nothing and uses no number", async () => {
    const { store } = await open();
    store.create("board01", "e", 1000);
    const r = aBoard();
    expect(store.save("board01", registers(r))).toBe(1);
    expect(store.save("board01", registers(r))).toBeNull();
    expect(store.seqOf("board01")).toBe(1);
  });

  test("each write is numbered; changes since a number are the registers written after it, as they are now", async () => {
    const { store } = await open();
    store.create("board01", "e", 1000);
    const r = new Replica("a");
    const first = r.create({ kind: "rectangle", x: 0, y: 0, w: 1, h: 1 }).shape;
    expect(store.save("board01", registers(r))).toBe(1);
    const second = r.create({ kind: "ellipse", x: 5, y: 5, w: 1, h: 1 }).shape;
    expect(store.save("board01", registers(r))).toBe(2);
    r.update(second, { x: 7 });
    expect(store.save("board01", registers(r))).toBe(3);
    const changes = store.changesSince("board01", 1);
    expect(changes.seq).toBe(3);
    expect([...changes.state.keys()]).toEqual([second]);
    expect(changes.state.get(second)?.x?.value).toBe(7);
    expect(store.changesSince("board01", 3).state.size).toBe(0);
    // An update carries the number of the write that changed it: since 2,
    // only the moved x.
    const update = store.changesSince("board01", 2).state.get(second);
    expect(Object.keys(update ?? {})).toEqual(["x"]);
    expect(store.changesSince("board01", 0).state.has(first)).toBe(true);
    expect(store.load("board01")?.seq).toBe(3);
  });

  test("a board made by another server first keeps its epoch; the limit counts every server's boards", async () => {
    const { store: one, dir } = await open();
    const { store: two } = await open(dir);
    expect(one.create("board01", "epoch-one", 2)).toBe("epoch-one");
    expect(two.create("board01", "epoch-two", 2)).toBe("epoch-one");
    expect(two.create("board02", "e", 2)).toBe("e");
    expect(one.create("board03", "e", 2)).toBeNull();
    expect(one.create("board01", "again", 2)).toBe("epoch-one"); // a stored board is never over the limit
  });
});

describe("servers starting at once", () => {
  /** Exit code and error output of a separate process opening the store. */
  function opener(dir: string): Promise<{ code: number | null; error: string }> {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./testing/open-store.ts", import.meta.url)), dir], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let error = "";
    child.stderr.on("data", (chunk: Buffer) => (error += chunk.toString()));
    return new Promise((resolve) => {
      child.on("exit", (code) => {
        resolve({ code, error });
      });
    });
  }

  test("several processes creating one new database at the same moment all open it", async () => {
    // Found by the benchmark's first two-server start: one server died
    // with "database is locked" while the other set the file up.
    for (let round = 0; round < 4; round++) {
      const dir = await mkdtemp(path.join(os.tmpdir(), "syncboard-race-"));
      dirs.push(dir);
      const results = await Promise.all([1, 2, 3, 4].map(() => opener(dir)));
      expect(results, `round ${String(round)}`).toEqual(results.map(() => ({ code: 0, error: "" })));
    }
  }, 60_000);
});

describe("the schema", () => {
  test("a Milestone 5 database is upgraded: its boards load as they were, from change number 0", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "syncboard-store-"));
    dirs.push(dir);
    const db = new DatabaseSync(path.join(dir, "boards.sqlite"));
    // The schema as Milestone 5 (commit 4994497) created it.
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE boards (id TEXT PRIMARY KEY, epoch TEXT NOT NULL, created TEXT NOT NULL) STRICT;
      CREATE TABLE registers (
        board TEXT NOT NULL, shape TEXT NOT NULL, prop TEXT NOT NULL, value TEXT NOT NULL,
        counter INTEGER NOT NULL, client TEXT NOT NULL, PRIMARY KEY (board, shape, prop)
      ) STRICT, WITHOUT ROWID;
    `);
    const board = aBoard();
    db.prepare("INSERT INTO boards VALUES ('board01', 'old-epoch', '2026-10-08')").run();
    const insert = db.prepare("INSERT INTO registers VALUES ('board01', ?, ?, ?, ?, ?)");
    for (const [shape, prop, entry] of registers(board)) {
      insert.run(shape, prop, JSON.stringify(entry.value), entry.stamp.counter, entry.stamp.client);
    }
    db.close();
    const { store } = await open(dir);
    const loaded = store.load("board01");
    expect(loaded?.epoch).toBe("old-epoch");
    expect(loaded?.seq).toBe(0);
    expect(serializeState(loaded?.state ?? new Map())).toBe(serializeState(board.state));
    expect(store.changesSince("board01", 0).state.size).toBe(0);
    // And it takes writes, numbered from 1.
    const r = new Replica("z");
    r.create({ kind: "rectangle", x: 0, y: 0, w: 1, h: 1 });
    expect(store.save("board01", registers(r))).toBe(1);
  });

  test("a database from a later version is refused, not changed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "syncboard-store-"));
    dirs.push(dir);
    const db = new DatabaseSync(path.join(dir, "boards.sqlite"));
    db.exec("PRAGMA user_version = 7");
    db.close();
    expect(() => new Store(dir)).toThrow("schema 7");
  });
});
