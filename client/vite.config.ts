import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The shared package from source, so the client never waits for a build of it.
    alias: {
      "@syncboard/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  server: {
    // `npm run dev:client` on :5173, with the API and the WebSocket on :8000.
    proxy: {
      "/healthz": "http://localhost:8000",
      "/ws": { target: "ws://localhost:8000", ws: true },
    },
  },
});
