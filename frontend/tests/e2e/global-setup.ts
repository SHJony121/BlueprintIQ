// Starts the real backend and the production Next.js server for the browser tests, and
// writes the extra geometry fixtures (geometry_fixtures.py) where the tests expect them.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { BACKEND_DIR, backendPython, FRONTEND_DIR, startBackend, startNext } from "../proxy/helpers";

export const GENERATED_DIR = path.join(FRONTEND_DIR, "test-results", "geometry-fixtures");

export default async function globalSetup(): Promise<() => Promise<void>> {
  rmSync(GENERATED_DIR, { recursive: true, force: true });
  mkdirSync(GENERATED_DIR, { recursive: true });
  execFileSync(backendPython(), [path.join(FRONTEND_DIR, "tests", "e2e", "geometry_fixtures.py"), GENERATED_DIR], {
    cwd: BACKEND_DIR,
    stdio: "pipe",
  });
  const backend = await startBackend();
  const next = await startNext(`http://127.0.0.1:${backend.port}`);
  process.env.E2E_BASE_URL = `http://127.0.0.1:${next.port}`;
  return async () => {
    await next.stop();
    await backend.stop();
  };
}
