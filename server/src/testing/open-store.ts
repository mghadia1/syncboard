import { Store } from "../store.js";

/**
 * Opens (creating or upgrading) the store in argv[2], once, and exits: 0
 * if it opened, 1 with the error if not. For the test that starts several
 * servers' worth of these at once on one new directory.
 */
try {
  new Store(process.argv[2] ?? "").close();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
