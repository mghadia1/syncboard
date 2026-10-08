import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LIMITS, type Limits } from "./rooms.js";

export type Config = {
  host: string;
  port: number;
  /** The built client (client/dist): index.html and assets/. */
  clientDir: string;
  /** Where boards are stored (boards.sqlite); ":memory:" for nowhere. */
  dataDir: string;
  /** How long open connections get to close before the server stops anyway. */
  shutdownGraceMs: number;
  /** How often connections are pinged; one that has not answered by the next ping is cut off. */
  heartbeatMs: number;
  limits: Limits;
};

const here = path.dirname(fileURLToPath(import.meta.url));

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a whole number, not ${JSON.stringify(raw)}`);
  }
  return value;
}

/** Reads SYNCBOARD_* environment variables; anything invalid stops startup. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = integer(env, "SYNCBOARD_PORT", 8000);
  if (port > 65535) {
    throw new Error(`SYNCBOARD_PORT must be at most 65535, not ${String(port)}`);
  }
  return {
    host: env.SYNCBOARD_HOST ?? "0.0.0.0",
    port,
    clientDir: path.resolve(env.SYNCBOARD_CLIENT_DIR ?? path.join(here, "../../client/dist")),
    dataDir:
      env.SYNCBOARD_DATA_DIR === ":memory:"
        ? ":memory:"
        : path.resolve(env.SYNCBOARD_DATA_DIR ?? path.join(here, "../../data")),
    shutdownGraceMs: integer(env, "SYNCBOARD_SHUTDOWN_GRACE_MS", 5000),
    heartbeatMs: Math.max(100, integer(env, "SYNCBOARD_HEARTBEAT_MS", 30_000)),
    limits: {
      maxBoards: Math.max(1, integer(env, "SYNCBOARD_MAX_BOARDS", DEFAULT_LIMITS.maxBoards)),
      maxShapes: Math.max(1, integer(env, "SYNCBOARD_MAX_SHAPES", DEFAULT_LIMITS.maxShapes)),
    },
  };
}
