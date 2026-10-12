// The supported ways to start the app are `npm run dev` and `npm run start`, and both
// must bind to 127.0.0.1 only. Next.js's own default is every network interface.
// Host and Origin checks in the proxy are NOT a substitute for this binding (see
// docs/frontend-f1.md and docs/frontend-f2.md). This file checks the scripts as written;
// launch-binding.test.ts checks what actually listens.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FRONTEND_DIR } from "./helpers";

const pkg = JSON.parse(readFileSync(path.join(FRONTEND_DIR, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("launch scripts", () => {
  it.each(["dev", "start"])("%s binds to 127.0.0.1", (name) => {
    expect(pkg.scripts[name]).toMatch(/^next (dev|start) --hostname 127\.0\.0\.1$/);
  });

  it("no script exposes all interfaces", () => {
    for (const [name, command] of Object.entries(pkg.scripts)) {
      expect(command, `script ${name}`).not.toMatch(/0\.0\.0\.0|--hostname\s+(?!127\.0\.0\.1)\S+|\s-H\s|\[::\]/);
    }
  });

  it("there is no custom server that could listen elsewhere", () => {
    for (const file of ["server", "custom-server"]) {
      for (const extension of ["js", "mjs", "cjs", "ts"]) {
        expect(existsSync(path.join(FRONTEND_DIR, `${file}.${extension}`))).toBe(false);
      }
    }
    expect(pkg.scripts.dev).not.toMatch(/\bnode\b/);
    expect(pkg.scripts.start).not.toMatch(/\bnode\b/);
  });

  it("the app configuration does not set a listening address", () => {
    const config = readFileSync(path.join(FRONTEND_DIR, "next.config.ts"), "utf8");
    expect(config).not.toMatch(/hostname|0\.0\.0\.0/);
  });
});
