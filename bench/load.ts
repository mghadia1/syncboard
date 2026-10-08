/**
 * SyncBoard's load generator: simulated people editing one board, each
 * through its own WebSocket and SyncBoard's real protocol, spread over one
 * or more servers. Run by bench/run.ts, in a container on the servers'
 * network (so Docker Desktop's port forwarding is not part of what is
 * measured):
 *
 *   node --import tsx bench/load.ts --targets ws://a:8000/ws,ws://b:8000/ws \
 *     --clients 16 --rate 10 --warmup 3 --duration 12 --shapes 50 --seed 1
 *
 * Each person moves a shape (x and y, one operation per message, as a drag
 * sends) `rate` times a second, on a fixed schedule whether or not the
 * server keeps up (open loop), all on one pool of shapes, so edits collide.
 * Times are measured from when each edit was due, not from when it was
 * sent, so a generator that falls behind shows up as latency, not as less
 * load (coordinated omission). All people are in this one process, with
 * one clock: an edit's propagation latency is the time from when it was
 * due at its sender until it arrived at each other person.
 *
 * Measured: edits due in the measurement window (after the warm-up). At the
 * end: every edit acknowledged; every person holding the same board; then,
 * with everyone gone (so each server drops the board from memory), a fresh
 * join on each server reads the board back from disk, and it must be that
 * same board.
 *
 * Writes one JSON object to stdout; progress, and the lines
 * "MEASURE start" / "MEASURE end" (for the runner's swap check), to stderr.
 */
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import {
  type Operation,
  PROTOCOL_VERSION,
  Replica,
  type Snapshot,
  fromSnapshot,
  serializeState,
} from "@syncboard/shared";
import WebSocket from "ws";

type Options = {
  targets: string[];
  clients: number;
  rate: number;
  warmupS: number;
  durationS: number;
  shapes: number;
  seed: number;
  board: string;
};

function readOptions(): Options {
  const { values } = parseArgs({
    options: {
      targets: { type: "string" },
      clients: { type: "string", default: "8" },
      rate: { type: "string", default: "10" },
      warmup: { type: "string", default: "3" },
      duration: { type: "string", default: "12" },
      shapes: { type: "string", default: "50" },
      seed: { type: "string", default: "1" },
      board: { type: "string" },
    },
  });
  if (!values.targets) {
    throw new Error("--targets ws://host:port/ws[,...] is required");
  }
  const seed = Number(values.seed);
  return {
    targets: values.targets.split(","),
    clients: Number(values.clients),
    rate: Number(values.rate),
    warmupS: Number(values.warmup),
    durationS: Number(values.duration),
    shapes: Number(values.shapes),
    seed,
    board: values.board ?? `load${String(seed)}${Date.now().toString(36)}`,
  };
}

/** mulberry32: a small seeded generator, so a run's edits can be replayed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Summary = {
  count: number;
  mean: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
} | null;

function summarize(values: number[]): Summary {
  if (values.length === 0) {
    return null;
  }
  const sorted = Float64Array.from(values).sort();
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN;
  return {
    count: sorted.length,
    mean: round(sorted.reduce((sum, x) => sum + x, 0) / sorted.length),
    p50: round(at(0.5)),
    p90: round(at(0.9)),
    p99: round(at(0.99)),
    max: round(sorted[sorted.length - 1] ?? NaN),
  };
}

const LOOP_SAMPLE_MS = 10;

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function key(op: Operation): string {
  return `${op.stamp.client}:${String(op.stamp.counter)}`;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) {
      return false;
    }
    await pause(20);
  }
  return true;
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

type Message = { type: string; [field: string]: unknown };

/** Shared by everyone in the run. */
class Run {
  /** When each edit was due, by "client:counter". */
  readonly due = new Map<string, number>();
  /** Which server each client is on. */
  readonly server = new Map<string, number>();
  readonly same: number[] = [];
  readonly cross: number[] = [];
  readonly acks: number[] = [];
  readonly errors: string[] = [];
  closes = 0;
  measureStart = Infinity;
  measureEnd = Infinity;

  constructor(readonly options: Options) {}

  measured(due: number): boolean {
    return due >= this.measureStart && due < this.measureEnd;
  }
}

class Person {
  readonly replica: Replica;
  readonly ws: WebSocket;
  readonly welcomed: Promise<void>;
  /** Own edits in the order sent: counter and due time; those before `acked` are acknowledged. */
  readonly sent: [number, number][] = [];
  acked = 0;
  /** Edits received from others (each counted once). */
  readonly seen = new Set<string>();
  nextDue = 0;
  #open = true;

  constructor(
    private readonly run: Run,
    readonly client: string,
    readonly target: number,
  ) {
    this.replica = new Replica(client);
    run.server.set(client, target);
    const url = run.options.targets[target] ?? "";
    this.ws = new WebSocket(url);
    this.welcomed = new Promise((resolve, reject) => {
      this.ws.on("error", (error) => {
        run.errors.push(`${client}: ${error.message}`);
        reject(error);
      });
      this.ws.on("open", () => {
        this.ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, board: run.options.board, client }));
      });
      this.ws.on("message", (data: Buffer) => {
        const message = JSON.parse(data.toString("utf8")) as Message;
        if (message.type === "welcome") {
          this.replica.merge(fromSnapshot(message.snapshot as Snapshot));
          resolve();
        } else {
          this.#receive(message);
        }
      });
      this.ws.on("close", (code) => {
        if (this.#open) {
          run.closes++;
          run.errors.push(`${client}: closed with ${String(code)}`);
        }
      });
    });
  }

  #receive(message: Message): void {
    const now = performance.now();
    switch (message.type) {
      case "ops":
        for (const op of message.ops as Operation[]) {
          this.replica.apply(op);
          const k = key(op);
          if (this.seen.has(k)) {
            continue;
          }
          this.seen.add(k);
          const due = this.run.due.get(k);
          if (due !== undefined && this.run.measured(due)) {
            (this.run.server.get(op.stamp.client) === this.target ? this.run.same : this.run.cross).push(now - due);
          }
        }
        return;
      case "ack": {
        const upTo = message.upTo as number;
        for (;;) {
          const next = this.sent[this.acked];
          if (!next || next[0] > upTo) {
            break;
          }
          this.acked++;
          if (this.run.measured(next[1])) {
            this.run.acks.push(now - next[1]);
          }
        }
        return;
      }
      case "error":
        this.run.errors.push(`${this.client}: ${String(message.code)} ${String(message.message)}`);
        return;
      default:
        return; // presence, left
    }
  }

  send(ops: Operation[], due: number): void {
    for (const op of ops) {
      this.run.due.set(key(op), due);
      this.sent.push([op.stamp.counter, due]);
    }
    this.ws.send(JSON.stringify({ type: "ops", ops }));
  }

  get pending(): number {
    return this.sent.length - this.acked;
  }

  close(): void {
    this.#open = false;
    this.ws.close();
  }
}

/** The board as a newcomer to one server is sent it. */
async function boardAt(url: string, board: string): Promise<string> {
  const ws = new WebSocket(url);
  const snapshot = await new Promise<Snapshot>((resolve, reject) => {
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, board, client: "checker" }));
    });
    ws.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString("utf8")) as Message;
      if (message.type === "welcome") {
        resolve(message.snapshot as Snapshot);
      }
    });
    ws.on("error", reject);
  });
  ws.close();
  return serializeState(fromSnapshot(snapshot));
}

async function main(): Promise<void> {
  const options = readOptions();
  const run = new Run(options);
  const next = random(options.seed);
  const people: Person[] = [];
  for (let i = 0; i < options.clients; i++) {
    people.push(new Person(run, `p${String(options.seed)}n${String(i)}`, i % options.targets.length));
  }
  await Promise.all(people.map((p) => p.welcomed));
  log(`${String(people.length)} people joined ${options.board}`);

  // The shapes everyone will move, made by the first person.
  const [first] = people;
  if (!first) {
    throw new Error("--clients must be at least 1");
  }
  const pool: Operation[] = [];
  for (let i = 0; i < options.shapes; i++) {
    pool.push(first.replica.create({ kind: "rectangle", x: i * 20, y: 0, w: 15, h: 15 }));
  }
  first.send(pool, performance.now());
  const ids = pool.map((op) => op.shape);
  if (!(await until(() => people.every((p) => ids.every((id) => p.replica.shape(id))), 10_000))) {
    throw new Error("the shapes did not reach everyone");
  }

  const period = 1000 / options.rate;
  const start = performance.now() + 50;
  run.measureStart = start + options.warmupS * 1000;
  run.measureEnd = run.measureStart + options.durationS * 1000;
  people.forEach((p, i) => {
    p.nextDue = start + (period * i) / people.length;
  });
  const loopDelay = monitorEventLoopDelay({ resolution: LOOP_SAMPLE_MS });
  let sentInWindow = 0;
  let started = false;
  await new Promise<void>((resolve) => {
    const tick = () => {
      const now = performance.now();
      if (!started && now >= run.measureStart) {
        started = true;
        loopDelay.enable();
        log("MEASURE start");
      }
      for (const p of people) {
        while (p.nextDue <= now && p.nextDue < run.measureEnd) {
          const id = ids[Math.floor(next() * ids.length)] ?? "";
          const op = p.replica.update(id, { x: Math.round(next() * 1000), y: Math.round(next() * 1000) });
          p.send([op], p.nextDue);
          if (run.measured(p.nextDue)) {
            sentInWindow++;
          }
          p.nextDue += period;
        }
      }
      if (now >= run.measureEnd) {
        loopDelay.disable();
        log("MEASURE end");
        resolve();
        return;
      }
      setTimeout(tick, 1);
    };
    tick();
  });

  // The end: everything acknowledged, everyone agreeing.
  const endedAt = performance.now();
  const allAcked = await until(() => people.every((p) => p.pending === 0), 15_000);
  const ackedAt = performance.now();
  const states = () => new Set(people.map((p) => serializeState(p.replica.state)));
  const agreed = await until(() => states().size === 1, 15_000);
  const agreedAt = performance.now();
  const board = [...states()][0] ?? "";
  for (const p of people) {
    p.close();
  }
  // Each server drops the board from memory when its last member leaves:
  // a fresh join then reads it from disk.
  await pause(500);
  const fromDisk = await Promise.all(options.targets.map((url) => boardAt(url, options.board)));

  const measuredOps = sentInWindow;
  const receivers = people.length - 1;
  const result = {
    options,
    sent: { total: people.reduce((n, p) => n + p.sent.length, 0), measured: measuredOps },
    offeredPerSecond: options.clients * options.rate,
    unacknowledged: people.reduce((n, p) => n + p.pending, 0),
    ackMs: summarize(run.acks),
    propagationMs: { sameServer: summarize(run.same), otherServer: summarize(run.cross) },
    /** Of every measured edit reaching every other person: some never do, overtaken on the way by a later edit of the same property. */
    receipts: { expected: measuredOps * receivers, got: run.same.length + run.cross.length },
    // How late this process's own event loop ran, past the sampling
    // interval (Node's histogram includes it): a generator that is behind
    // adds its lateness to every latency above.
    generatorLagMs: {
      p50: round(loopDelay.percentile(50) / 1e6 - LOOP_SAMPLE_MS),
      p99: round(loopDelay.percentile(99) / 1e6 - LOOP_SAMPLE_MS),
      max: round(loopDelay.max / 1e6 - LOOP_SAMPLE_MS),
    },
    end: {
      allAcknowledged: allAcked,
      ackedAfterMs: Math.round(ackedAt - endedAt),
      everyoneAgrees: agreed,
      agreedAfterMs: Math.round(agreedAt - ackedAt),
      distinctBoards: states().size,
      shapes: ids.length,
      diskMatches: fromDisk.map((state) => state === board),
    },
    closes: run.closes,
    errors: run.errors.slice(0, 20),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

main().catch((error: unknown) => {
  log(`load failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
