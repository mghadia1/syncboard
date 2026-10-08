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
  wins,
} from "@syncboard/shared";

/**
 * The boards on disk, in SQLite (Node's built-in node:sqlite: no native
 * dependency to build).
 *
 * A board is stored as its registers: one row per shape property, with the
 * value and the stamp of the edit that set it. That is the board's state
 * itself, always complete: there is no operation log to replay on start,
 * and nothing to compact. The rule for which value wins is not written in
 * SQL: it is the replica's own `wins` (replica.ts), called here on the
 * stored register before it is replaced. SQL would compare text by UTF-8
 * bytes where JavaScript compares UTF-16 code units, and two copies of the
 * rule could disagree.
 *
 * More than one server can share the file (replicas on one machine, see
 * rooms.ts): each write is a transaction that holds SQLite's write lock,
 * and replaces a register only with a later value, so the disk keeps the
 * winner whichever server stores first. Each board has a change counter,
 * `seq`, raised by every write and stored on the registers it wrote: a
 * server that missed a change from another can read everything written
 * since the last number it had.
 *
 * Durability: WAL journal, synchronous=FULL, so a commit is on disk (as far
 * as the operating system's fsync goes) before it returns; the server
 * commits before it acknowledges or relays anything.
 */

export type StoredBoard = { epoch: string; seq: number; state: BoardState };

/** Registers written after some change number, as they are now, and the board's number now. */
export type Changes = { seq: number; state: BoardState };

export class StorageError extends Error {}

/** The schema this code writes; a database from a later one is refused. */
const SCHEMA = 1;

/** How long to wait for another server's lock on the file. */
const LOCK_TIMEOUT_MS = 5000;
const SQLITE_BUSY = 5;
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

type Row = { shape: string; prop: string; value: string; counter: number; client: string };

export class Store {
  readonly #db: DatabaseSync;
  readonly #select: StatementSync;
  readonly #since: StatementSync;
  readonly #register: StatementSync;
  readonly #upsert: StatementSync;
  readonly #board: StatementSync;
  readonly #seq: StatementSync;
  readonly #bump: StatementSync;
  readonly #insertBoard: StatementSync;
  readonly #count: StatementSync;

  /** Opens (or creates, or upgrades) the database in `dir`; ":memory:" keeps it in memory. */
  constructor(dir: string) {
    let file = ":memory:";
    if (dir !== ":memory:") {
      mkdirSync(dir, { recursive: true });
      file = path.join(dir, "boards.sqlite");
    }
    // timeout (SQLite's busy_timeout): how long a write waits for another
    // server's to finish, rather than failing at once.
    this.#db = new DatabaseSync(file, { timeout: LOCK_TIMEOUT_MS });
    this.#useWal();
    this.#db.exec("PRAGMA synchronous = FULL");
    this.#migrate();
    this.#select = this.#db.prepare(
      "SELECT shape, prop, value, counter, client FROM registers WHERE board = ? ORDER BY shape",
    );
    this.#since = this.#db.prepare(
      "SELECT shape, prop, value, counter, client FROM registers WHERE board = ? AND seq > ? ORDER BY shape",
    );
    this.#register = this.#db.prepare(
      "SELECT value, counter, client FROM registers WHERE board = ? AND shape = ? AND prop = ?",
    );
    this.#upsert = this.#db.prepare(
      `INSERT INTO registers (board, shape, prop, value, counter, client, seq) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (board, shape, prop) DO UPDATE SET
         value = excluded.value, counter = excluded.counter, client = excluded.client, seq = excluded.seq`,
    );
    this.#board = this.#db.prepare("SELECT epoch, seq FROM boards WHERE id = ?");
    this.#seq = this.#db.prepare("SELECT seq FROM boards WHERE id = ?");
    this.#bump = this.#db.prepare("UPDATE boards SET seq = seq + 1 WHERE id = ? RETURNING seq");
    this.#insertBoard = this.#db.prepare("INSERT INTO boards (id, epoch, created) VALUES (?, ?, ?)");
    this.#count = this.#db.prepare("SELECT count(*) AS n FROM boards");
  }

  /**
   * Switches the file to WAL (once set, it stays). SQLite answers "database
   * is locked" at once here when another connection holds the file, busy
   * timeout or not: two servers starting together on a new file hit it (3
   * of 32 processes started four at a time). So it is retried, for as long
   * as a write would wait.
   */
  #useWal(): void {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const { journal_mode: mode } = this.#db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode: string };
        if (mode === "wal" || mode === "memory") {
          return; // (an in-memory database has no WAL)
        }
        throw new StorageError(`the database would not switch to WAL (it is in ${mode} mode)`);
      } catch (error) {
        if ((error as { errcode?: unknown }).errcode !== SQLITE_BUSY || Date.now() > deadline) {
          throw error;
        }
        // A synchronous pause: this runs once, as the server starts.
        Atomics.wait(PAUSE, 0, 0, 5 + Math.random() * 20);
      }
    }
  }

  /**
   * Brings the schema up to date, in one transaction that holds the write
   * lock: two servers starting at once upgrade it once. Version 0 is
   * Milestone 5's (or an empty file); 1 adds the change counters.
   */
  #migrate(): void {
    this.#transaction("IMMEDIATE", () => {
      const { user_version: version } = this.#db.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version > SCHEMA) {
        throw new StorageError(`the database has schema ${String(version)}; this server knows up to ${String(SCHEMA)}`);
      }
      if (version < 1) {
        this.#db.exec(`
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
          ALTER TABLE boards ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE registers ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
          CREATE INDEX registers_since ON registers (board, seq);
          PRAGMA user_version = 1;
        `);
      }
    });
  }

  /**
   * Runs `work` in a transaction: IMMEDIATE takes the write lock at once
   * (waiting up to busy_timeout for another server's); DEFERRED is for
   * reads, which then see one consistent moment of the file.
   */
  #transaction<T>(mode: "IMMEDIATE" | "DEFERRED", work: () => T): T {
    this.#db.exec(`BEGIN ${mode}`);
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.#db.isTransaction) {
        this.#db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  /** A stored board, or null; a board whose rows do not check out is an error, not an empty board. */
  load(board: string): StoredBoard | null {
    return this.#reading(board, () => {
      const row = this.#board.get(board) as { epoch: string; seq: number } | undefined;
      if (!row) {
        return null;
      }
      return { epoch: row.epoch, seq: row.seq, state: this.#state(board, this.#select.all(board) as Row[]) };
    });
  }

  /**
   * Stores a new board with this epoch, unless it is there already (another
   * server made it first): returns the stored epoch either way, or null if
   * a new board would make more than `maxBoards`. Counted and inserted in
   * one transaction, so servers sharing the file share the limit exactly.
   */
  create(board: string, epoch: string, maxBoards: number): string | null {
    try {
      return this.#transaction("IMMEDIATE", () => {
        const existing = this.#board.get(board) as { epoch: string } | undefined;
        if (existing) {
          return existing.epoch;
        }
        if ((this.#count.get() as { n: number }).n >= maxBoards) {
          return null;
        }
        this.#insertBoard.run(board, epoch, new Date().toISOString());
        return epoch;
      });
    } catch (error) {
      throw this.#failure(`creating board ${board}`, error);
    }
  }

  get boardCount(): number {
    return (this.#count.get() as { n: number }).n;
  }

  /** The board's change number now (0 if it has never changed); null if it is not stored. */
  seqOf(board: string): number | null {
    const row = this.#seq.get(board) as { seq: number } | undefined;
    return row ? row.seq : null;
  }

  /** Every register written after change `since`, with its value now, and the board's number now. */
  changesSince(board: string, since: number): Changes {
    return this.#reading(board, () => {
      const row = this.#seq.get(board) as { seq: number } | undefined;
      if (!row) {
        throw new StorageError(`board ${board} is not stored`);
      }
      return { seq: row.seq, state: this.#state(board, this.#since.all(board, since) as Row[]) };
    });
  }

  /**
   * Writes registers, all in one transaction: all of them are on disk, or
   * none. A register already holding a later value (another server stored
   * it) is left as it is. Returns the board's new change number; or null
   * if nothing was written, in which case nothing was committed either: no
   * number used, and no fsync.
   */
  save(board: string, registers: Iterable<readonly [ShapeId, PropName, Entry]>): number | null {
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      const bumped = this.#bump.get(board) as { seq: number } | undefined;
      if (!bumped) {
        throw new Error("the board is not stored");
      }
      let written = 0;
      for (const [shape, prop, entry] of registers) {
        const stored = this.#register.get(board, shape, prop) as Omit<Row, "shape" | "prop"> | undefined;
        if (
          stored &&
          !wins(entry, { value: JSON.parse(stored.value), stamp: { counter: stored.counter, client: stored.client } })
        ) {
          continue;
        }
        this.#upsert.run(
          board,
          shape,
          prop,
          JSON.stringify(entry.value),
          entry.stamp.counter,
          entry.stamp.client,
          bumped.seq,
        );
        written++;
      }
      if (written === 0) {
        this.#db.exec("ROLLBACK");
        return null;
      }
      this.#db.exec("COMMIT");
      return bumped.seq;
    } catch (error) {
      if (this.#db.isTransaction) {
        this.#db.exec("ROLLBACK");
      }
      throw this.#failure(`saving board ${board}`, error);
    }
  }

  close(): void {
    this.#db.close();
  }

  /** A read transaction, so the change number and the registers come from one moment. */
  #reading<T>(board: string, read: () => T): T {
    try {
      return this.#transaction("DEFERRED", read);
    } catch (error) {
      throw this.#failure(`reading board ${board}`, error);
    }
  }

  #failure(doing: string, error: unknown): StorageError {
    if (error instanceof StorageError) {
      return error;
    }
    return new StorageError(`${doing} failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  /** Rows as a board state, with the same checks as anything from the network: a damaged row is an error. */
  #state(board: string, rows: readonly Row[]): BoardState {
    const shapes = new Map<ShapeId, SnapshotEntry[]>();
    for (const r of rows) {
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
    const parsed = parseSnapshot([...shapes]);
    if (!parsed.ok) {
      throw new StorageError(`board ${board}: ${parsed.error}`);
    }
    return fromSnapshot(parsed.message);
  }
}
