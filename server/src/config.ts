import path from "node:path";
import { fileURLToPath } from "node:url";

export type Config = {
  host: string;
  port: number;
  /** The built client (client/dist): index.html and assets/. */
  clientDir: string;
  /** How long open connections get to close before the server stops anyway. */
  shutdownGraceMs: number;
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
    shutdownGraceMs: integer(env, "SYNCBOARD_SHUTDOWN_GRACE_MS", 5000),
  };
}
