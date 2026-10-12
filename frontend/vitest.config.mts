import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));
const serverOnlyStub = fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": src,
      // Next.js resolves "server-only" itself; outside Next it is an empty module.
      "server-only": serverOnlyStub,
    },
  },
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "tests/proxy/handler.test.ts", "tests/proxy/guards.test.ts"],
        },
      },
      {
        // Runs the production build (`next start`): run `npm run build` first.
        extends: true,
        test: {
          name: "server",
          include: ["tests/proxy/next-server.test.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        // Also needs the backend environment: `uv sync --locked` in ../backend.
        extends: true,
        test: {
          name: "backend",
          include: ["tests/proxy/backend.test.ts"],
          testTimeout: 180_000,
          hookTimeout: 90_000,
        },
      },
    ],
  },
});
