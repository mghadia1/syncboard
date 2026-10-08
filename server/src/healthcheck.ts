/**
 * Docker's health check: `node server/dist/healthcheck.js`. Exits 0 if the
 * local server answers /healthz with 200 within 2 s, else 1. The image has
 * no curl, and does not need one.
 */
const port = process.env.SYNCBOARD_PORT ?? "8000";

try {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(2000),
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
