// Starts the app exactly as `npm run start` and `npm run dev` do (same arguments) and
// checks what is actually listening: reachable on 127.0.0.1, and NOT reachable on any
// other address of this machine. Requires `npm run build` for the start script.
import { readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FRONTEND_DIR, startLaunchScript, type ChildServer } from "./helpers";

// `next dev` rewrites tsconfig.json (reformatting it and adding a generated path). That is
// its normal behaviour, not something to commit, so put the file back afterwards.
const TSCONFIG = path.join(FRONTEND_DIR, "tsconfig.json");

/** This machine's non-loopback IPv4 addresses (empty on a machine with no network). */
const others = Object.values(os.networkInterfaces())
  .flat()
  .filter((a): a is os.NetworkInterfaceInfo => a !== undefined && a.family === "IPv4" && !a.internal)
  .map((a) => a.address);

/** True if a TCP connection is accepted. Refused, unreachable and timed out all count as no. */
function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 2_000 });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("timeout", () => (socket.destroy(), resolve(false)));
    socket.once("error", () => resolve(false));
  });
}

describe.each(["start", "dev"] as const)("npm run %s", (script) => {
  let server: ChildServer;
  const tsconfigBefore = readFileSync(TSCONFIG, "utf8");
  beforeAll(async () => {
    server = await startLaunchScript(script);
  }, 120_000);
  afterAll(async () => {
    await server?.stop();
    if (readFileSync(TSCONFIG, "utf8") !== tsconfigBefore) writeFileSync(TSCONFIG, tsconfigBefore);
  });

  it("listens on 127.0.0.1", async () => {
    expect(await accepts("127.0.0.1", server.port)).toBe(true);
  });

  it("does not listen on IPv6 loopback or any-address", async () => {
    expect(await accepts("::1", server.port)).toBe(false);
  });

  it.skipIf(others.length === 0)(
    `is not reachable on this machine's other addresses (${others.length} found)`,
    async () => {
      const reachable = [];
      for (const address of others) {
        if (await accepts(address, server.port)) reachable.push(address);
      }
      expect(reachable).toEqual([]);
    },
  );
});
