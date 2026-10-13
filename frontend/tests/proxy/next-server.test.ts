// The production build (`next start`, bound to 127.0.0.1) in front of a real HTTP server
// standing in for the backend. Raw sockets exercise what only a real server sees:
// false Content-Length headers, foreign Host headers and disconnects mid-request.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES } from "@/server/inspection-proxy";
import {
  afterBody,
  drawing,
  eventually,
  json,
  MIB,
  rawSocket,
  startNext,
  startUpstream,
  type ChildServer,
  type Upstream,
} from "./helpers";

const REPORT = '{"schema_version":"1.0","value":"1.10"}';
const BACKEND_ID = "0123456789abcdef0123456789abcdef";

let upstream: Upstream;
let next: ChildServer;
let base: string;

beforeAll(async () => {
  // X-Filename is forwarded, so tests use it to choose how the stand-in backend behaves.
  upstream = await startUpstream((req, res, rec) => {
    if (req.headers["x-filename"] === "never-answer") return;
    afterBody(() => json(res, 200, REPORT, { "X-Request-ID": BACKEND_ID }))(req, res, rec);
  });
  next = await startNext(`http://127.0.0.1:${upstream.port}`);
  base = `http://127.0.0.1:${next.port}`;
});

afterAll(async () => {
  await next?.stop();
  await upstream?.close();
});

function requestsSince(count: number) {
  return upstream.requests.slice(count);
}

/** A raw HTTP/1.1 request head for the inspection route. */
function head(lines: string[], host = `127.0.0.1:${next.port}`): string {
  return ["POST /api/inspections HTTP/1.1", `Host: ${host}`, ...lines, "", ""].join("\r\n");
}

describe("through the real Next.js server", () => {
  it("proxies a valid drawing and returns the backend's report unchanged", async () => {
    const before = upstream.requests.length;
    const pdf = drawing("valid_basic");
    const response = await fetch(`${base}/api/inspections`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf", "X-Filename": "valid_basic.pdf" },
      body: new Uint8Array(pdf),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(REPORT);
    expect(response.headers.get("x-request-id")).toBe(BACKEND_ID);
    expect(response.headers.get("x-powered-by")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    const [received] = requestsSince(before);
    expect(received?.url).toBe("/api/v1/inspections");
    expect(received?.body.equals(pdf)).toBe(true);
  });

  it.each(["GET", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "answers %s on the inspection route with a 405 envelope and no CORS headers",
    async (method) => {
      const before = upstream.requests.length;
      const response = await fetch(`${base}/api/inspections`, {
        method,
        headers: { Origin: "http://attacker.example", "Access-Control-Request-Method": "POST" },
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect((await response.json()).error.code).toBe("METHOD_NOT_ALLOWED");
      expect([...response.headers.keys()].some((k) => k.startsWith("access-control-"))).toBe(false);
      expect(requestsSince(before)).toHaveLength(0);
    },
  );

  it.each(["/api", "/api/v1/inspections", "/api/inspections/extra", "/api/healthz"])(
    "answers %s with a JSON 404 and forwards nothing",
    async (path) => {
      const before = upstream.requests.length;
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: new Uint8Array(drawing("valid_basic")),
      });
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("NOT_FOUND");
      expect(requestsSince(before)).toHaveLength(0);
    },
  );

  it("refuses a request whose Host is a foreign name (DNS rebinding)", async () => {
    const before = upstream.requests.length;
    const client = rawSocket(next.port);
    const pdf = drawing("valid_basic");
    await client.write(
      head(
        ["Content-Type: application/pdf", `Content-Length: ${pdf.length}`, "Connection: close"],
        `attacker.example:${next.port}`,
      ),
    );
    await client.write(pdf);
    const response = await client.response();
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe("FORBIDDEN");
    expect(requestsSince(before)).toHaveLength(0);
  });

  it("refuses a cross-site browser request", async () => {
    const response = await fetch(`${base}/api/inspections`, {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        Origin: "http://attacker.example",
        "Sec-Fetch-Site": "cross-site",
      },
      body: new Uint8Array(drawing("valid_basic")),
    });
    expect(response.status).toBe(403);
  });
});

describe("upload size against the real server", () => {
  it("refuses a declared Content-Length over the limit without waiting for the body", async () => {
    const before = upstream.requests.length;
    const client = rawSocket(next.port);
    await client.write(
      head(["Content-Type: application/pdf", `Content-Length: ${50 * MIB}`, "Connection: close"]),
    );
    // No body is sent at all; the answer must still come.
    const timer = setTimeout(() => client.socket.end(), 5_000);
    await eventually(() => client.received().includes("\r\n\r\n"), 5_000);
    clearTimeout(timer);
    client.socket.destroy();
    const response = await client.response();
    expect(response.status).toBe(413);
    expect(requestsSince(before)).toHaveLength(0);
  });

  it("stops a chunked upload (no Content-Length) once it passes the limit", async () => {
    const before = upstream.requests.length;
    const client = rawSocket(next.port);
    await client.write(
      head(["Content-Type: application/pdf", "Transfer-Encoding: chunked", "Connection: close"]),
    );
    const chunk = Buffer.alloc(MIB);
    for (let sent = 0; sent < 12 * MIB && !client.socket.destroyed; sent += MIB) {
      if (client.received().length > 0) break; // already answered
      await client.write(`${chunk.length.toString(16)}\r\n`);
      await client.write(chunk);
      await client.write("\r\n");
    }
    const response = await client.response();
    if (response.status === 413) {
      expect(JSON.parse(response.body).error.code).toBe("FILE_TOO_LARGE");
    } else {
      // The server answers 413 and closes while the browser is still sending. Closing a
      // socket that still has unread input makes the operating system reset the
      // connection, and a reset can discard the answer before the client reads it. That
      // is transport behaviour, not a proxy defect, so a missing answer is accepted only
      // when the client saw nothing at all (no 2xx and no other status) and the broken
      // connection is the reset itself. Enforcement is still proved below, from what
      // reached the backend.
      expect(client.received()).toBe("");
      expect(["ECONNRESET", "EPIPE"]).toContain(client.failure());
      console.info(`chunked upload: answer lost to ${client.failure()} (reset while sending)`);
    }
    const forwarded = requestsSince(before);
    await eventually(() => upstream.openConnections() === 0);
    expect(forwarded.every((r) => !r.completed && r.body.length <= MAX_UPLOAD_BYTES)).toBe(true);
    // The proxy itself survived and still answers.
    const alive = await fetch(`http://127.0.0.1:${next.port}/api/inspections`);
    expect(alive.status).toBe(405);
  });

  it("forwards only the declared bytes when more follow (pipelined request smuggling)", async () => {
    const before = upstream.requests.length;
    const client = rawSocket(next.port);
    // The bytes after the declared 100 form a second request, which must be handled on
    // its own (here: a 404 from Next) and never reach the backend inside the first body.
    const smuggled = [
      "POST /api/inspections/x HTTP/1.1",
      `Host: 127.0.0.1:${next.port}`,
      "Content-Length: 0",
      "Connection: close",
      "",
      "",
    ].join("\r\n");
    await client.write(head(["Content-Type: application/pdf", "Content-Length: 100"]));
    await client.write(Buffer.concat([Buffer.alloc(100, 0x41), Buffer.from(smuggled)]));
    const first = await client.response();
    const forwarded = requestsSince(before);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.completed).toBe(true);
    expect(forwarded[0]?.body.equals(Buffer.alloc(100, 0x41))).toBe(true);
    expect(first.status).toBe(200);
    expect(client.received()).toMatch(/HTTP\/1\.1 404 /);
  });
});

describe("client disconnects against the real server", () => {
  it("abandons the backend request when the client disconnects mid-upload", async () => {
    const before = upstream.requests.length;
    const client = rawSocket(next.port);
    await client.write(head(["Content-Type: application/pdf", `Content-Length: ${4 * MIB}`]));
    await client.write(Buffer.alloc(MIB));
    await eventually(() => (requestsSince(before)[0]?.body.length ?? 0) > 0);
    client.socket.destroy();
    const [received] = requestsSince(before);
    await Promise.race([
      received!.closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("still open")), 5_000)),
    ]);
    expect(received?.completed).toBe(false);
  });

  it("abandons the backend request when the client disconnects while waiting", async () => {
    const before = upstream.requests.length;
    const pdf = drawing("valid_basic");
    const client = rawSocket(next.port);
    await client.write(
      head([
        "Content-Type: application/pdf",
        `Content-Length: ${pdf.length}`,
        "X-Filename: never-answer",
      ]),
    );
    await client.write(pdf);
    await eventually(() => requestsSince(before)[0]?.completed === true);
    client.socket.destroy();
    const [received] = requestsSince(before);
    // The stand-in never answers, so only the proxy's cancellation can close this.
    await Promise.race([
      received!.closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("still open")), 5_000)),
    ]);
  });
});

describe("invalid configuration", () => {
  it("fails closed and does not reveal the configured address", async () => {
    const misconfigured = await startNext("http://10.1.2.3:8000");
    try {
      const response = await fetch(`http://127.0.0.1:${misconfigured.port}/api/inspections`, {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: new Uint8Array(drawing("valid_basic")),
      });
      const text = await response.text();
      expect(response.status).toBe(500);
      expect(JSON.parse(text).error.code).toBe("PROXY_MISCONFIGURED");
      expect(text).not.toContain("10.1.2.3");
      await eventually(() => misconfigured.output().includes("inspections are disabled"));
      expect(misconfigured.output()).not.toContain("10.1.2.3");
    } finally {
      await misconfigured.stop();
    }
  });
});
