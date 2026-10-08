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
  });

  test("reads SYNCBOARD_* variables", () => {
    expect(
      loadConfig({
        SYNCBOARD_HOST: "127.0.0.1",
        SYNCBOARD_PORT: "9000",
        SYNCBOARD_CLIENT_DIR: "/srv/client",
        SYNCBOARD_SHUTDOWN_GRACE_MS: "100",
      }),
    ).toEqual({ host: "127.0.0.1", port: 9000, clientDir: "/srv/client", shutdownGraceMs: 100 });
  });

  test.each([
    ["SYNCBOARD_PORT", "eighty"],
    ["SYNCBOARD_PORT", "80.5"],
    ["SYNCBOARD_PORT", "-1"],
    ["SYNCBOARD_PORT", "70000"],
    ["SYNCBOARD_SHUTDOWN_GRACE_MS", "soon"],
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
