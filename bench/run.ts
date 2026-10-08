/**
 * SyncBoard's benchmark: how fast an edit reaches everyone on a board, on
 * one server and on two sharing it, as the edit rate grows; and whether
 * everyone (and the disk) ends with the same board.
 *
 *   node --import tsx bench/run.ts [--rates 10,30,60,120] [--clients 32]
 *     [--duration 12] [--allow-swapping] [--out DIR]
 *
 * (`make bench`.) Runs on the host; everything measured runs in Docker, as
 * its own Compose project (bench/compose.bench.yaml): Redis, servers a and
 * b, and the load generator (bench/load.ts) on the same network.
 *
 * A configuration is a topology (one server: everyone on a; two: people
 * alternate between a and b) and a rate (edits per person per second, for
 * `clients` people). Every run starts a fresh stack on an empty volume.
 *
 * Method, from the SurgiServe, Gatekeeper and LogScope benchmarks: two
 * passes, the second in reverse order, so a machine that drifts as it
 * warms affects every configuration alike; refuses to start while the
 * host is swapping; records the host's swap-ins during each run's
 * measurement window (the generator prints when it starts and ends) and
 * marks a run with more than 50 MB of them invalid. Also recorded: what
 * else was busy on the host, the containers' CPU half-way through each
 * window, and the generator's own lag (it adds to every latency).
 *
 * Writes bench/results/<timestamp>/results.json and results.md.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const COMPOSE = ["compose", "-f", "bench/compose.bench.yaml"];
const SWAP_LIMIT_MB = 50;
const LAG_LIMIT_MS = 20;

type Topology = "one" | "two";
type Config = { topology: Topology; rate: number };

const TARGETS: Record<Topology, string> = {
  one: "ws://a:8000/ws",
  two: "ws://a:8000/ws,ws://b:8000/ws",
};

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function docker(...args: string[]): string {
  return run("docker", args);
}

/** The host's cumulative swap-ins and swap-outs, in MB. */
function swapMb(): { in: number; out: number } {
  const out = run("vm_stat", []);
  const page = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? "16384");
  const count = (name: string) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(out)?.[1] ?? "0");
  return { in: (count("Swapins") * page) / 2 ** 20, out: (count("Swapouts") * page) / 2 ** 20 };
}

/** Host processes using at least 20% of a core: a record, not a check. */
function busyProcesses(): { cpu: number; command: string }[] {
  return run("ps", ["-Ao", "%cpu=,comm="])
    .split("\n")
    .map((line) => {
      const match = /^\s*([\d.]+)\s+(.*)$/.exec(line);
      return match ? { cpu: Number(match[1]), command: (match[2] ?? "").trim() } : null;
    })
    .filter((p): p is { cpu: number; command: string } => p !== null && p.cpu >= 20)
    .sort((a, b) => b.cpu - a.cpu);
}

function containerCpu(): Record<string, string> {
  const out = docker("stats", "--no-stream", "--format", "{{.Name}} {{.CPUPerc}} {{.MemUsage}}");
  const cpu: Record<string, string> = {};
  for (const line of out.trim().split("\n")) {
    const [name, ...rest] = line.split(" ");
    if (name?.startsWith("syncboard-bench-")) {
      cpu[name.replace("syncboard-bench-", "")] = rest.join(" ");
    }
  }
  return cpu;
}

function freshStack(): void {
  docker(...COMPOSE, "down", "--volumes", "--remove-orphans");
  docker(...COMPOSE, "up", "--detach", "--wait", "redis", "a", "b");
}

type RunRecord = {
  pass: number;
  config: Config;
  valid: boolean;
  why: string[];
  swapInMb: number;
  containers: Record<string, string>;
  result: unknown;
};

/** One run: the generator in its container; swap read as its window opens and closes. */
async function measure(config: Config, options: { clients: number; duration: number; seed: number }) {
  let swapStart = swapMb();
  let swapEnd = swapStart;
  let containers: Record<string, string> = {};
  const child: ChildProcess = spawn(
    "docker",
    [
      ...COMPOSE,
      "run",
      "--rm",
      "--no-deps",
      "load",
      "--targets",
      TARGETS[config.topology],
      "--clients",
      String(options.clients),
      "--rate",
      String(config.rate),
      "--warmup",
      "3",
      "--duration",
      String(options.duration),
      "--seed",
      String(options.seed),
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderr += text;
    if (text.includes("MEASURE start")) {
      swapStart = swapMb();
      setTimeout(() => {
        try {
          containers = containerCpu();
        } catch {
          containers = {};
        }
      }, (options.duration * 1000) / 2).unref();
    }
    if (text.includes("MEASURE end")) {
      swapEnd = swapMb();
    }
  });
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  if (code !== 0) {
    throw new Error(`the load generator failed (${String(code)}):\n${stderr}`);
  }
  const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
    unacknowledged: number;
    end: { allAcknowledged: boolean; everyoneAgrees: boolean; diskMatches: boolean[] };
    closes: number;
    errors: string[];
    generatorLagMs: { p99: number };
  };
  return { result, swapInMb: swapEnd.in - swapStart.in, containers };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      rates: { type: "string", default: "10,30,60,120" },
      clients: { type: "string", default: "32" },
      duration: { type: "string", default: "12" },
      "allow-swapping": { type: "boolean", default: false },
      // Somewhere else than bench/results (a check of the runner itself).
      out: { type: "string" },
    },
  });
  const clients = Number(values.clients);
  const duration = Number(values.duration);
  const configs: Config[] = [];
  for (const rate of values.rates.split(",").map(Number)) {
    for (const topology of ["one", "two"] as const) {
      configs.push({ topology, rate });
    }
  }

  const before = swapMb();
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  const swappedOut = swapMb().out - before.out;
  console.log(`host swapped out ${swappedOut.toFixed(0)} MB in the last 10 s`);
  if (swappedOut > SWAP_LIMIT_MB && !values["allow-swapping"]) {
    console.error("the host is swapping; free memory and try again (or --allow-swapping to check the runner)");
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const out = path.join(values.out ?? path.join(ROOT, "bench", "results"), stamp);
  mkdirSync(out, { recursive: true });
  console.log("building");
  docker(...COMPOSE, "--profile", "load", "build");

  const environment = {
    started: new Date().toISOString(),
    commit: run("git", ["rev-parse", "--short", "HEAD"]).trim(),
    uncommitted: run("git", ["status", "--porcelain"]).trim() !== "",
    host: {
      model: run("sysctl", ["-n", "hw.model"]).trim(),
      cpu: run("sysctl", ["-n", "machdep.cpu.brand_string"]).trim(),
      memoryGb: Number(run("sysctl", ["-n", "hw.memsize"])) / 2 ** 30,
      macos: run("sw_vers", ["-productVersion"]).trim(),
    },
    docker: docker("info", "--format", "{{.ServerVersion}}, {{.NCPU}} CPUs, {{.MemTotal}} bytes, kernel {{.KernelVersion}}").trim(),
    node: docker(...COMPOSE, "run", "--rm", "--no-deps", "--entrypoint", "node", "load", "--version").trim(),
    redis: docker("run", "--rm", "redis:8-alpine", "redis-server", "--version").trim(),
    swapAtStart: run("sysctl", ["-n", "vm.swapusage"]).trim(),
    busyAtStart: busyProcesses(),
    method: { clients, durationS: duration, warmupS: 3, passes: 2, swapLimitMb: SWAP_LIMIT_MB, lagLimitMs: LAG_LIMIT_MS },
  };
  console.log(`busy host processes: ${JSON.stringify(environment.busyAtStart)}`);

  const runs: RunRecord[] = [];
  let seed = 1;
  for (const pass of [1, 2]) {
    const order = pass === 1 ? configs : [...configs].reverse();
    for (const config of order) {
      freshStack();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const { result, swapInMb, containers } = await measure(config, { clients, duration, seed: seed++ });
      const why: string[] = [];
      if (swapInMb > SWAP_LIMIT_MB) {
        why.push(`host swapped in ${swapInMb.toFixed(0)} MB`);
      }
      if (result.generatorLagMs.p99 > LAG_LIMIT_MS) {
        why.push(`generator lag p99 ${String(result.generatorLagMs.p99)} ms`);
      }
      const record: RunRecord = { pass, config, valid: why.length === 0, why, swapInMb, containers, result };
      runs.push(record);
      const converged =
        result.end.allAcknowledged &&
        result.end.everyoneAgrees &&
        result.end.diskMatches.every(Boolean) &&
        result.closes === 0 &&
        result.errors.length === 0;
      console.log(
        `pass ${String(pass)} ${config.topology} server(s), ${String(config.rate)}/s each: ${record.valid ? "valid" : `INVALID (${why.join("; ")})`}, ` +
          `${converged ? "converged" : "DID NOT CONVERGE"}, swap-in ${swapInMb.toFixed(0)} MB`,
      );
      writeFileSync(path.join(out, "results.json"), JSON.stringify({ environment, runs }, null, 2));
    }
  }
  docker(...COMPOSE, "down", "--volumes", "--remove-orphans");
  const finished = { ...environment, finished: new Date().toISOString(), swapAtEnd: run("sysctl", ["-n", "vm.swapusage"]).trim(), busyAtEnd: busyProcesses() };
  writeFileSync(path.join(out, "results.json"), JSON.stringify({ environment: finished, runs }, null, 2));
  writeFileSync(path.join(out, "results.md"), report(finished, runs));
  console.log(`wrote ${path.relative(ROOT, out)}`);
}

type Stats = { p50: number; p99: number; max: number; count: number } | null;
type Result = {
  offeredPerSecond: number;
  sent: { measured: number };
  ackMs: Stats;
  propagationMs: { sameServer: Stats; otherServer: Stats };
  generatorLagMs: { p99: number };
  unacknowledged: number;
  end: { allAcknowledged: boolean; everyoneAgrees: boolean; diskMatches: boolean[]; agreedAfterMs: number };
  closes: number;
  errors: string[];
};

function cell(s: Stats): string {
  return s ? `${s.p50.toFixed(1)} / ${s.p99.toFixed(1)} / ${s.max.toFixed(0)}` : "–";
}

function report(environment: Record<string, unknown>, runs: RunRecord[]): string {
  const lines = [
    "# SyncBoard benchmark",
    "",
    "Generated by bench/run.ts; the environment is in results.json. Latencies in ms as p50 / p99 / max,",
    "from when each edit was due at its sender. Invalid runs are listed, not dropped.",
    "",
    `- Commit ${String(environment.commit)}${environment.uncommitted ? " (with uncommitted changes)" : ""}`,
    `- Swap at start: ${String(environment.swapAtStart)}; at end: ${String(environment.swapAtEnd)}`,
    "",
    "| pass | servers | edits/s offered | acknowledged | same server | other server | gen. lag p99 | converged | swap-in MB | valid |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of runs) {
    const result = r.result as Result;
    const converged =
      result.end.allAcknowledged &&
      result.end.everyoneAgrees &&
      result.end.diskMatches.every(Boolean) &&
      result.closes === 0 &&
      result.errors.length === 0;
    lines.push(
      `| ${String(r.pass)} | ${r.config.topology} | ${String(result.offeredPerSecond)} | ${cell(result.ackMs)} | ` +
        `${cell(result.propagationMs.sameServer)} | ${cell(result.propagationMs.otherServer)} | ` +
        `${result.generatorLagMs.p99.toFixed(1)} | ${converged ? "yes" : "**no**"} | ${r.swapInMb.toFixed(0)} | ` +
        `${r.valid ? "yes" : `no: ${r.why.join("; ")}`} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
