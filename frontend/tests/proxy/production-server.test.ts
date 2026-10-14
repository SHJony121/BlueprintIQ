// The production build (`next start`) configured the way the container configures it: a public
// host allow-list, one trusted proxy hop and a rate limit. Raw sockets send the Host header a
// real reverse proxy would; fetch cannot.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  afterBody,
  drawing,
  json,
  rawSocket,
  startNext,
  startUpstream,
  type ChildServer,
  type Upstream,
} from "./helpers";

const PUBLIC = "demo.example.test";
const REPORT = '{"schema_version":"1.0"}';

let upstream: Upstream;
let next: ChildServer;
let base: string;

beforeAll(async () => {
  upstream = await startUpstream((req, res, rec) =>
    afterBody(() => json(res, 200, req.url === "/healthz" ? { status: "ok" } : REPORT))(req, res, rec),
  );
  next = await startNext(`http://127.0.0.1:${upstream.port}`, {
    BLUEPRINTIQ_ALLOWED_HOSTS: PUBLIC,
    BLUEPRINTIQ_TRUSTED_PROXY_HOPS: "1",
    BLUEPRINTIQ_RATE_LIMIT_PER_MINUTE: "60",
    BLUEPRINTIQ_RATE_LIMIT_BURST: "2",
    BLUEPRINTIQ_MAX_UPLOADS_PER_CLIENT: "2",
    BLUEPRINTIQ_ENABLE_DIAGNOSTICS: "0",
  });
  base = `http://127.0.0.1:${next.port}`;
});

afterAll(async () => {
  await next?.stop();
  await upstream?.close();
});

async function post(host: string, extra: string[] = []) {
  const pdf = drawing("valid_basic");
  const client = rawSocket(next.port);
  await client.write(
    [
      "POST /api/inspections HTTP/1.1",
      `Host: ${host}`,
      "Content-Type: application/pdf",
      `Content-Length: ${pdf.length}`,
      "Connection: close",
      ...extra,
      "",
      "",
    ].join("\r\n"),
  );
  await client.write(pdf);
  return client.response();
}

describe("the production server", () => {
  it("serves inspections for the listed public host", async () => {
    const response = await post(PUBLIC, ["X-Forwarded-For: 198.51.100.1"]);
    expect(response.status).toBe(200);
    expect(response.head.toLowerCase()).toContain("cache-control: no-store");
  });

  it("refuses an unlisted host and never reaches the backend", async () => {
    const before = upstream.requests.length;
    const response = await post("attacker.example");
    expect(response.status).toBe(403);
    expect(upstream.requests.length).toBe(before);
  });

  it("refuses a foreign origin even on the listed host", async () => {
    const before = upstream.requests.length;
    const response = await post(PUBLIC, ["Origin: https://attacker.example"]);
    expect(response.status).toBe(403);
    expect(upstream.requests.length).toBe(before);
  });

  it("rate limits one client behind the trusted proxy, not the next one", async () => {
    const from = (ip: string) => post(PUBLIC, [`X-Forwarded-For: ${ip}`]);
    expect((await from("203.0.113.50")).status).toBe(200);
    expect((await from("203.0.113.50")).status).toBe(200);
    const refused = await from("203.0.113.50");
    expect(refused.status).toBe(429);
    expect(refused.head.toLowerCase()).toContain("retry-after:");
    expect(JSON.parse(refused.body).error.code).toBe("RATE_LIMITED");
    expect((await from("203.0.113.51")).status).toBe(200);
  });

  it("sends the security headers, including a CSP that allows PDF.js workers", async () => {
    const response = await fetch(`${base}/`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBeTruthy();
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it.each(["/pdfjs-check", "/viewer-check"])("does not serve the diagnostic page %s", async (route) => {
    expect((await fetch(`${base}${route}`)).status).toBe(404);
  });

  it("reports health from the backend", async () => {
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("reports unhealthy when the backend is gone", async () => {
    const lonely = await startNext(`http://127.0.0.1:1`, { BLUEPRINTIQ_ENABLE_DIAGNOSTICS: "0" });
    try {
      expect((await fetch(`http://127.0.0.1:${lonely.port}/api/health`)).status).toBe(503);
    } finally {
      await lonely.stop();
    }
  });
});
