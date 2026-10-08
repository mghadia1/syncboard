import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  type BoardState,
  type Entry,
  type PropName,
  type ShapeId,
  type SnapshotEntry,
  fromSnapshot,
  parseSnapshot,
} from "@syncboard/shared";

/**
 * The boards on disk, in SQLite (Node's built-in node:sqlite: no native
 * dependency to build).
 *
 * A board is stored as its registers: one row per shape property, with the
 * value and the stamp of the edit that set it. That is the board's state
 * itself, always complete: there is no operation log to replay on start,
 * and nothing to compact. The rule for which value wins is not written in
 * SQL: the server's replica decides (replica.ts), and the store writes the
 * registers it changed. SQL would compare text by UTF-8 bytes where
 * JavaScript compares UTF-16 code units, and the two copies could disagree.
 *
 * Durability: WAL journal, synchronous=FULL, so a commit is on disk (as far
 * as the operating system's fsync goes) before it returns; the server
 * commits before it acknowledges or relays anything.
 */

export type StoredBoard = { epoch: string; state: BoardState };

export class StorageError extends Error {}

export class Store {
  readonly #db: DatabaseSync;
  readonly #select: StatementSync;
  readonly #upsert: StatementSync;
  readonly #epoch: StatementSync;
  readonly #insertBoard: StatementSync;
  readonly #count: StatementSync;

  /** Opens (or creates) the database in `dir`; ":memory:" keeps it in memory. */
  constructor(dir: string) {
    let file = ":memory:";
    if (dir !== ":memory:") {
      mkdirSync(dir, { recursive: true });
      file = path.join(dir, "boards.sqlite");
    }
    this.#db = new DatabaseSync(file);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS boards (
        id TEXT PRIMARY KEY,
        epoch TEXT NOT NULL,
        created TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS registers (
        board TEXT NOT NULL,
        shape TEXT NOT NULL,
        prop TEXT NOT NULL,
        value TEXT NOT NULL,
        counter INTEGER NOT NULL,
        client TEXT NOT NULL,
        PRIMARY KEY (board, shape, prop)
      ) STRICT, WITHOUT ROWID;
    `);
    this.#select = this.#db.prepare(
      "SELECT shape, prop, value, counter, client FROM registers WHERE board = ? ORDER BY shape",
    );
    this.#upsert = this.#db.prepare(
      `INSERT INTO registers (board, shape, prop, value, counter, client) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (board, shape, prop) DO UPDATE SET
         value = excluded.value, counter = excluded.counter, client = excluded.client`,
    );
    this.#epoch = this.#db.prepare("SELECT epoch FROM boards WHERE id = ?");
    this.#insertBoard = this.#db.prepare("INSERT INTO boards (id, epoch, created) VALUES (?, ?, ?)");
    this.#count = this.#db.prepare("SELECT count(*) AS n FROM boards");
  }

  /** A stored board, or null; a board whose rows do not check out is an error, not an empty board. */
  load(board: string): StoredBoard | null {
    const row = this.#epoch.get(board) as { epoch: string } | undefined;
    if (!row) {
      return null;
    }
    const shapes = new Map<ShapeId, SnapshotEntry[]>();
    for (const r of this.#select.all(board) as {
      shape: string;
      prop: string;
      value: string;
      counter: number;
      client: string;
    }[]) {
      let value: unknown;
      try {
        value = JSON.parse(r.value);
      } catch {
        throw new StorageError(`board ${board}: a stored value is not JSON`);
      }
      const entries = shapes.get(r.shape) ?? [];
      entries.push([r.prop as PropName, value, r.counter, r.client]);
      shapes.set(r.shape, entries);
    }
    // The same checks as anything from the network: a damaged row stops
    // the board loading, rather than being served.
    const parsed = parseSnapshot([...shapes]);
    if (!parsed.ok) {
      throw new StorageError(`board ${board}: ${parsed.error}`);
    }
    return { epoch: row.epoch, state: fromSnapshot(parsed.message) };
  }

  createBoard(board: string, epoch: string): void {
    this.#insertBoard.run(board, epoch, new Date().toISOString());
  }

  get boardCount(): number {
    return (this.#count.get() as { n: number }).n;
  }

  /** Writes registers, all in one transaction: all of them are on disk, or none. */
  save(board: string, registers: Iterable<readonly [ShapeId, PropName, Entry]>): void {
    this.#db.exec("BEGIN");
    try {
      for (const [shape, prop, entry] of registers) {
        this.#upsert.run(board, shape, prop, JSON.stringify(entry.value), entry.stamp.counter, entry.stamp.client);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      if (this.#db.isTransaction) {
        this.#db.exec("ROLLBACK");
      }
      throw new StorageError(`saving board ${board} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  close(): void {
    this.#db.close();
  }
}
