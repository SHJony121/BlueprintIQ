// The proxy handler under a production policy: allow-listed public hosts, trusted-proxy client
// identity, per-client rate and concurrency limits. Real HTTP servers stand in for the backend.
import { afterEach, describe, expect, it } from "vitest";
import type { BackendConfig } from "@/server/backend-config";
import { proxyInspection, DEFAULT_LIMITS } from "@/server/inspection-proxy";
import { parseAllowedHosts, type ProxyPolicy } from "@/server/production-config";
import { RateLimiter } from "@/server/rate-limit";
import { afterBody, drawing, json, startUpstream, type Upstream } from "./helpers";

const PUBLIC = "demo.example.test";
const REPORT = '{"schema_version":"1.0"}';

const running: Upstream[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

async function upstream(handler: Parameters<typeof startUpstream>[0]): Promise<Upstream> {
  const server = await startUpstream(handler);
  running.push(server);
  return server;
}

const configFor = (port: number): BackendConfig => ({ ok: true, hostname: "127.0.0.1", port });

function policy(overrides: Partial<ProxyPolicy> = {}, hops = 1): ProxyPolicy {
  return {
    hosts: parseAllowedHosts(PUBLIC),
    clients: { hops, header: null },
    limiter: null,
    ...overrides,
  };
}

function limiter(burst: number, maxConcurrent = 2): RateLimiter {
  return new RateLimiter({ perMinute: 60, burst, maxConcurrent, maxClients: 100 });
}

function upload(headers: Record<string, string> = {}): Request {
  return new Request(`https://${PUBLIC}/api/inspections`, {
    method: "POST",
    headers: { host: PUBLIC, "content-type": "application/pdf", ...headers },
    body: new Uint8Array(drawing("valid_basic")),
    duplex: "half",
  } as RequestInit);
}

function send(server: Upstream, p: ProxyPolicy, headers: Record<string, string> = {}) {
  return proxyInspection(upload(headers), configFor(server.port), DEFAULT_LIMITS, p);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("production hosts and origins", () => {
  it("serves the listed public host, and answers with no-store", async () => {
    const server = await upstream(afterBody((_req, res) => json(res, 200, REPORT)));
    const response = await send(server, policy());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses an unlisted host before contacting the backend", async () => {
    const server = await upstream(afterBody((_req, res) => json(res, 200, REPORT)));
    const response = await send(server, policy(), { host: "evil.example.test" });
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(server.requests).toHaveLength(0);
  });

  it.each([
    ["a foreign origin", { origin: "https://evil.example.test" }],
    ["a cross-site fetch", { "sec-fetch-site": "cross-site" }],
    ["the null origin", { origin: "null" }],
  ])("refuses %s", async (_label, headers) => {
    const server = await upstream(afterBody((_req, res) => json(res, 200, REPORT)));
    const response = await send(server, policy(), headers);
    expect(response.status).toBe(403);
    expect(server.requests).toHaveLength(0);
  });

  it("accepts the own https origin of the site", async () => {
    const server = await upstream(afterBody((_req, res) => json(res, 200, REPORT)));
    const response = await send(server, policy(), {
      origin: `https://${PUBLIC}`,
      "sec-fetch-site": "same-origin",
    });
    expect(response.status).toBe(200);
  });

  it("does not forward client identity headers or cookies to the backend", async () => {
    const server = await upstream(afterBody((_req, res) => json(res, 200, REPORT)));
    await send(server, policy(), {
      "x-forwarded-for": "203.0.113.7",
      "x-real-ip": "203.0.113.7",
      cookie: "a=b",
    });
    const headers = server.requests[0]!.headers;
    expect(headers["x-forwarded-for"]).toBeUndefined();
    expect(headers["x-real-ip"]).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
  });
});

describe("per-client limits", () => {
  it("answers 429 with Retry-After once the burst of a client is spent", async () => {
    const server = await upstream(afterBody((_req, res) => json(res, 200, REPORT)));
    const p = policy({ limiter: limiter(2) });
    const from = (ip: string) => send(server, p, { "x-forwarded-for": ip });

    expect((await from("203.0.113.7")).status).toBe(200);
    expect((await from("203.0.113.7")).status).toBe(200);
    const refused = await from("203.0.113.7");
    expect(refused.status).toBe(429);
    expect((await refused.json()).error.code).toBe("RATE_LIMITED");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(server.requests).toHaveLength(2);

    expect((await from("203.0.113.8")).status).toBe(200); // another client is unaffected
  });

  it("cannot be dodged by a spoofed X-Forwarded-For prefix", async () => {
    const server = await upstream(afterBody((_req, res) => json(res, 200, REPORT)));
    const p = policy({ limiter: limiter(1) });
    const from = (xff: string) => send(server, p, { "x-forwarded-for": xff });

    expect((await from("1.1.1.1, 203.0.113.7")).status).toBe(200);
    expect((await from("2.2.2.2, 203.0.113.7")).status).toBe(429);
    expect((await from("3.3.3.3, 4.4.4.4, 203.0.113.7")).status).toBe(429);
  });

  it("uses one shared bucket when no proxy is trusted, rather than believing the header", async () => {
    const server = await upstream(afterBody((_req, res) => json(res, 200, REPORT)));
    const p = policy({ limiter: limiter(1) }, 0);
    const from = (xff: string) => send(server, p, { "x-forwarded-for": xff });

    expect((await from("1.1.1.1")).status).toBe(200);
    expect((await from("2.2.2.2")).status).toBe(429);
  });

  it("limits uploads in flight per client and frees the slot when each finishes", async () => {
    const gates: Array<() => void> = [];
    const server = await upstream((req, res) => {
      req.on("end", () => gates.push(() => json(res, 200, REPORT)));
    });
    const p = policy({ limiter: limiter(10, 2) });
    const from = () => send(server, p, { "x-forwarded-for": "203.0.113.7" });

    const first = from();
    const second = from();
    while (gates.length < 2) await pause(10);

    const third = await from();
    expect(third.status).toBe(429);
    expect((await third.json()).error.code).toBe("TOO_MANY_UPLOADS");

    gates.forEach((release) => release());
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    await Promise.all([a.text(), b.text()]);

    const fourth = from();
    while (gates.length < 3) await pause(10);
    gates[2]!();
    expect((await fourth).status).toBe(200);
  });

  it("does not spend a rate token on a request refused for its host", async () => {
    const server = await upstream(afterBody((_req, res) => json(res, 200, REPORT)));
    const p = policy({ limiter: limiter(1) });
    const bad = await send(server, p, { host: "evil.example.test", "x-forwarded-for": "203.0.113.7" });
    expect(bad.status).toBe(403);
    const good = await send(server, p, { "x-forwarded-for": "203.0.113.7" });
    expect(good.status).toBe(200);
  });
});
