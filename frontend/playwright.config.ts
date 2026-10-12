import { defineConfig } from "@playwright/test";

// Browser tests for the drawing viewer (F3): real Chromium, the production build, the real
// backend. Run `npm run build` first; the backend environment must exist (`uv sync --locked`
// in ../backend). Each project repeats the suite at a different device pixel ratio.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 2,
  reporter: [["list"]],
  outputDir: "test-results/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    trace: "off",
  },
  projects: [
    { name: "dpr-1", use: { deviceScaleFactor: 1 } },
    { name: "dpr-2", use: { deviceScaleFactor: 2 } },
    { name: "dpr-1.5", use: { deviceScaleFactor: 1.5 } },
  ],
});
