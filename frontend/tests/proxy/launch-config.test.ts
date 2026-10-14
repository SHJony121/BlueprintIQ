// The container launch configuration (deploy/launch-config.mjs): what it accepts, what it
// refuses to start with, and how it splits settings between the backend and the frontend.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllowedHosts } from "@/server/production-config";
import { FRONTEND_DIR } from "./helpers";

interface Launch {
  ok: boolean;
  errors?: string[];
  config?: {
    bind: string;
    port: number;
    backendPort: number;
    backendEnv: Record<string, string>;
    frontendEnv: Record<string, string>;
  };
}
type ReadLaunchConfig = (env: Record<string, string | undefined>) => Launch;

async function load(): Promise<ReadLaunchConfig> {
  const file = path.resolve(FRONTEND_DIR, "../deploy/launch-config.mjs");
  const loaded = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
    readLaunchConfig: ReadLaunchConfig;
  };
  return loaded.readLaunchConfig;
}

const PUBLIC = { BLUEPRINTIQ_ALLOWED_HOSTS: "demo.example.test" };

describe("the container launch configuration", () => {
  it("starts with safe defaults once the public host is named", async () => {
    const read = await load();
    const result = read(PUBLIC);
    expect(result.ok).toBe(true);
    const config = result.config!;
    expect(config.bind).toBe("0.0.0.0");
    expect(config.port).toBe(8080);
    expect(config.backendPort).toBe(8001);
    expect(config.backendEnv.BLUEPRINTIQ_ENVIRONMENT).toBe("production");
    expect(config.backendEnv.BLUEPRINTIQ_MAX_CONCURRENT_JOBS).toBe("1");
    expect(config.backendEnv.BLUEPRINTIQ_JOB_MEMORY_LIMIT_MB).toBe("1024");
    expect(config.frontendEnv.BLUEPRINTIQ_BACKEND_URL).toBe("http://127.0.0.1:8001");
    expect(Number(config.frontendEnv.BLUEPRINTIQ_RATE_LIMIT_PER_MINUTE)).toBeGreaterThan(0);
  });

  it("starts workers from a fork server by default, and accepts only the two known methods", async () => {
    const read = await load();
    expect(read(PUBLIC).config!.backendEnv.BLUEPRINTIQ_WORKER_START_METHOD).toBe("forkserver");
    expect(read({ ...PUBLIC, BLUEPRINTIQ_WORKER_START_METHOD: "spawn" }).config!.backendEnv.BLUEPRINTIQ_WORKER_START_METHOD).toBe("spawn");
    expect(read({ ...PUBLIC, BLUEPRINTIQ_WORKER_START_METHOD: "fork" }).ok).toBe(false);
  });

  it("follows the PORT of the platform", async () => {
    const read = await load();
    expect(read({ ...PUBLIC, PORT: "10000" }).config!.port).toBe(10000);
  });

  it("refuses a public interface without an allow-list", async () => {
    const read = await load();
    const result = read({});
    expect(result.ok).toBe(false);
    expect(result.errors!.join(" ")).toContain("BLUEPRINTIQ_ALLOWED_HOSTS");
  });

  it("allows a loopback bind with no allow-list, for local runs", async () => {
    const read = await load();
    expect(read({ BLUEPRINTIQ_BIND: "127.0.0.1" }).ok).toBe(true);
  });

  it.each([
    ["a scheme", { BLUEPRINTIQ_ALLOWED_HOSTS: "https://demo.example.test" }],
    ["a wildcard", { BLUEPRINTIQ_ALLOWED_HOSTS: "*.example.test" }],
    ["an empty entry", { BLUEPRINTIQ_ALLOWED_HOSTS: "a.example.test,,b.example.test" }],
    ["a bad bind address", { ...PUBLIC, BLUEPRINTIQ_BIND: "everywhere" }],
    ["a bad port", { ...PUBLIC, PORT: "99999" }],
    ["equal ports", { ...PUBLIC, PORT: "8001" }],
    ["too many proxy hops", { ...PUBLIC, BLUEPRINTIQ_TRUSTED_PROXY_HOPS: "9" }],
    ["a zero worker count", { ...PUBLIC, BLUEPRINTIQ_MAX_CONCURRENT_JOBS: "0" }],
    ["a negative timeout", { ...PUBLIC, BLUEPRINTIQ_JOB_TIMEOUT_S: "-5" }],
    ["a non-numeric memory limit", { ...PUBLIC, BLUEPRINTIQ_JOB_MEMORY_LIMIT_MB: "lots" }],
  ])("refuses to start with %s", async (_label, env) => {
    const read = await load();
    expect(read(env).ok).toBe(false);
  });

  it("accepts exactly the host lists the frontend accepts", async () => {
    const read = await load();
    const samples = [
      "demo.example.test",
      "demo.example.test, www.example.test",
      "example.test:8443",
      "https://demo.example.test",
      "demo.example.test/path",
      "*.example.test",
      "demo example.test",
      "-bad.example.test",
      `${"a".repeat(64)}.test`,
      "[::1]:3000",
    ];
    for (const sample of samples) {
      const launch = read({ BLUEPRINTIQ_ALLOWED_HOSTS: sample }).ok;
      const frontend = parseAllowedHosts(sample).invalid === null;
      expect(launch, sample).toBe(frontend);
    }
  });

  it("puts the backend on loopback and keeps public settings out of its environment", async () => {
    const read = await load();
    const config = read({ ...PUBLIC, BLUEPRINTIQ_TRUSTED_PROXY_HOPS: "1" }).config!;
    expect(Object.keys(config.backendEnv).some((name) => /HOSTS|PROXY|RATE|BACKEND_URL/.test(name))).toBe(false);
    expect(config.frontendEnv.BLUEPRINTIQ_BACKEND_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
