import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { jsonLog as log } from "./log.js";
import { VERSION } from "./version.js";

/**
 * Runs the server until SIGTERM or SIGINT, then shuts down cleanly. In the
 * container this process is PID 1, which gets no default signal handling:
 * without these handlers, `docker stop` would wait and then SIGKILL it.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const app = createApp(config, log);
  const port = await app.listen();
  log("listening", { version: VERSION, host: config.host, port, clientDir: config.clientDir });

  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (stopping) {
        return;
      }
      stopping = true;
      log("shutting down", { signal });
      void app.close().then(() => {
        log("stopped");
        process.exit(0);
      });
    });
  }
}

main().catch((error: unknown) => {
  log("failed to start", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
