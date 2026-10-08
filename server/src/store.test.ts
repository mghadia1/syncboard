import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    store.createBoard("board01", "epoch1");
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
    store.createBoard("board01", "e");
    store.save("board01", registers(r));
    r.update(id, { x: 9 });
    store.save("board01", registers(r));
    expect(store.load("board01")?.state.get(id)?.x?.value).toBe(9);
  });

  test("an unknown board is null; boards are counted", async () => {
    const { store } = await open();
    expect(store.load("nothere1")).toBeNull();
    store.createBoard("board01", "e");
    store.createBoard("board02", "e");
    expect(store.boardCount).toBe(2);
  });

  test("a save is all or nothing", async () => {
    const { store } = await open();
    store.createBoard("board01", "e");
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
    store.createBoard("board01", "e");
    store.save("board01", registers(aBoard()));
    const db = new DatabaseSync(path.join(dir, "boards.sqlite"));
    db.exec(`UPDATE registers SET value = '"not a number"' WHERE prop = 'x'`);
    db.close();
    expect(() => store.load("board01")).toThrow("bad value for x");
  });

  test("the database is in WAL mode, so a commit is one append and one fsync", async () => {
    const { store, dir } = await open();
    store.createBoard("board01", "e");
    const db = new DatabaseSync(path.join(dir, "boards.sqlite"));
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    db.close();
  });
});
