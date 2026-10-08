import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests use the shared package's source, so they never run against a stale build.
    alias: {
      "@syncboard/shared": fileURLToPath(new URL("./shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "shared", include: ["shared/src/**/*.test.ts"], environment: "node" },
      },
      {
        extends: true,
        test: { name: "server", include: ["server/src/**/*.test.ts"], environment: "node" },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: "client",
          include: ["client/src/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: ["client/src/test-setup.ts"],
        },
      },
    ],
  },
});
