// Guards for project-level conditions the proxy's guarantees depend on.
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FRONTEND_DIR } from "./helpers";

describe("project structure", () => {
  // With a Next.js proxy (formerly middleware) file present, Next copies every request
  // body into memory and silently truncates it at `proxyClientMaxBodySize` (10 MB by
  // default), so the route would receive a cut-off upload that looks complete and the
  // proxy would forward it. Adding one requires revisiting docs/frontend-f1.md first.
  it.each([
    "proxy.ts",
    "proxy.js",
    "middleware.ts",
    "middleware.js",
    "src/proxy.ts",
    "src/proxy.js",
    "src/middleware.ts",
    "src/middleware.js",
  ])("has no %s", (file) => {
    expect(existsSync(path.join(FRONTEND_DIR, file))).toBe(false);
  });
});
