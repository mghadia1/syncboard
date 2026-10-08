import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { loadConfig } from "./config.js";
import { VERSION } from "./version.js";

describe("loadConfig", () => {
  test("defaults", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({ host: "0.0.0.0", port: 8000, shutdownGraceMs: 5000 });
    expect(config.clientDir.endsWith(path.join("client", "dist"))).toBe(true);
    expect(config.dataDir.endsWith(`${path.sep}data`)).toBe(true);
    expect(loadConfig({ SYNCBOARD_DATA_DIR: ":memory:" }).dataDir).toBe(":memory:");
    // Alone, unless told where Redis is.
    expect(config.redisUrl).toBeNull();
    expect(config.timing).toEqual({ pollMs: 500, rosterMs: 2000 });
  });

  test("reads SYNCBOARD_* variables", () => {
    expect(
      loadConfig({
        SYNCBOARD_HOST: "127.0.0.1",
        SYNCBOARD_PORT: "9000",
        SYNCBOARD_CLIENT_DIR: "/srv/client",
        SYNCBOARD_DATA_DIR: "/srv/data",
        SYNCBOARD_SHUTDOWN_GRACE_MS: "100",
        SYNCBOARD_HEARTBEAT_MS: "5000",
        SYNCBOARD_MAX_BOARDS: "3",
        SYNCBOARD_MAX_SHAPES: "50",
        SYNCBOARD_REDIS_URL: "redis://redis:6379",
        SYNCBOARD_POLL_MS: "250",
        SYNCBOARD_ROSTER_MS: "1000",
      }),
    ).toEqual({
      host: "127.0.0.1",
      port: 9000,
      clientDir: "/srv/client",
      dataDir: "/srv/data",
      shutdownGraceMs: 100,
      heartbeatMs: 5000,
      limits: { maxBoards: 3, maxShapes: 50 },
      redisUrl: "redis://redis:6379",
      timing: { pollMs: 250, rosterMs: 1000 },
    });
  });

  test.each([
    ["SYNCBOARD_PORT", "eighty"],
    ["SYNCBOARD_PORT", "80.5"],
    ["SYNCBOARD_PORT", "-1"],
    ["SYNCBOARD_PORT", "70000"],
    ["SYNCBOARD_SHUTDOWN_GRACE_MS", "soon"],
    ["SYNCBOARD_MAX_BOARDS", "-3"],
    ["SYNCBOARD_REDIS_URL", "localhost:6379"],
    ["SYNCBOARD_REDIS_URL", "http://redis:6379"],
    ["SYNCBOARD_POLL_MS", "often"],
  ])("refuses %s=%s", (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(name);
  });
});

test("the version matches package.json", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  expect(VERSION).toBe(pkg.version);
});
