// The proxy handler called in-process with Web Requests, against real HTTP servers on
// 127.0.0.1 that stand in for the backend. Behaviour that depends on Next.js's own HTTP
// layer (raw sockets, real disconnects) is covered in next-server.test.ts.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { BackendConfig } from "@/server/backend-config";
import {
  DEFAULT_LIMITS,
  MAX_UPLOAD_BYTES,
  proxyInspection,
  type ProxyLimits,
} from "@/server/inspection-proxy";
import {
  afterBody,
  drawing,
  envelope,
  eventually,
  json,
  MIB,
  startUpstream,
  unusedPort,
  type Upstream,
} from "./helpers";

const HOST = "127.0.0.1:3000";
const REPORT = '{"schema_version":"1.0","value":"1.10","nested":{"x":[1,2]}}';
const BACKEND_ID = "0123456789abcdef0123456789abcdef";

const running: Upstream[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

async function upstream(handler: Parameters<typeof startUpstream>[0]): Promise<Upstream> {
  const server = await startUpstream(handler);
  running.push(server);
  return server;
}

function configFor(port: number): BackendConfig {
  return { ok: true, hostname: "127.0.0.1", port };
}

function limits(overrides: Partial<ProxyLimits> = {}): ProxyLimits {
  return { ...DEFAULT_LIMITS, ...overrides };
}

type Body = Buffer | ReadableStream<Uint8Array> | null;

function inspectionRequest(
  body: Body,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Request {
  return new Request("http://127.0.0.1:3000/api/inspections", {
    method: "POST",
    headers: { host: HOST, "content-type": "application/pdf", ...headers },
    body: body instanceof Buffer ? new Uint8Array(body) : body,
    duplex: "half",
    signal,
  } as RequestInit);
}

/** A request body that yields `chunks` and then, unless `end` is false, finishes. */
function streamOf(chunks: Uint8Array[], end = true): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk !== undefined) controller.enqueue(chunk);
        else if (end) controller.close();
        // otherwise never resolve: a stalled client
        else return new Promise<void>(() => {});
      },
    },
    { highWaterMark: 0 },
  );
}

function zeros(totalBytes: number, chunkBytes = MIB): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let left = totalBytes; left > 0; left -= chunkBytes) {
    chunks.push(new Uint8Array(Math.min(chunkBytes, left)));
  }
  return chunks;
}

async function errorOf(response: Response) {
  const body = (await response.json()) as {
    error: { code: string; message: string; request_id: string };
  };
  return body.error;
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

describe("valid requests", () => {
  it("streams the PDF to the fixed backend path and returns the report byte for byte", async () => {
    const pdf = drawing("valid_basic");
    const server = await upstream(
      afterBody((_req, res) =>
        json(res, 200, REPORT, {
          "X-Request-ID": BACKEND_ID,
          "Set-Cookie": "session=1",
          Server: "uvicorn",
          "X-Internal-Path": "/srv/blueprintiq",
        }),
      ),
    );
    const response = await proxyInspection(inspectionRequest(pdf), configFor(server.port));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(REPORT);
    expect([...response.headers.keys()].sort()).toEqual([
      "cache-control",
      "content-type",
      "x-content-type-options",
      "x-request-id",
    ]);
    expect(response.headers.get("x-request-id")).toBe(BACKEND_ID);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const [received] = server.requests;
    expect(server.requests).toHaveLength(1);
    expect(received?.method).toBe("POST");
    expect(received?.url).toBe("/api/v1/inspections");
    expect(received?.completed).toBe(true);
    expect(sha256(received!.body)).toBe(sha256(pdf));
  });

  it("forwards an upload of exactly the limit", async () => {
    const server = await upstream(afterBody((_req, res) => json(res, 200, REPORT)));
    const response = await proxyInspection(
      inspectionRequest(streamOf(zeros(MAX_UPLOAD_BYTES))),
      configFor(server.port),
    );
    expect(response.status).toBe(200);
    expect(server.requests[0]?.body.length).toBe(MAX_UPLOAD_BYTES);
  });

  it("relays a report larger than the biggest one measured (4.31 MiB) intact", async () => {
    const items = Array.from({ length: 24_000 }, (_, i) => ({ id: `m${i}`, text: "x".repeat(220) }));
    const report = JSON.stringify({ schema_version: "1.0", measurements: items });
    expect(report.length).toBeGreaterThan(5 * MIB);
    const server = await upstream(afterBody((_req, res) => json(res, 200, report)));
    const response = await proxyInspection(
      inspectionRequest(drawing("valid_basic")),
      configFor(server.port),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(report);
  });

  it("forwards an empty body so the backend can answer EMPTY_FILE", async () => {
    const server = await upstream(afterBody((_req, res) => json(res, 422, envelope("EMPTY_FILE"))));
    const response = await proxyInspection(inspectionRequest(null), configFor(server.port));
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("EMPTY_FILE");
    expect(server.requests[0]?.body.length).toBe(0);
  });

  it.each([400, 408, 413, 415, 422, 500, 503])(
    "passes the backend's %i error envelope through unchanged",
    async (status) => {
      const body = JSON.stringify(envelope("SOME_CODE", BACKEND_ID));
      const server = await upstream(
        afterBody((_req, res) => json(res, status, body, { "X-Request-ID": BACKEND_ID })),
      );
      const response = await proxyInspection(
        inspectionRequest(drawing("valid_basic")),
        configFor(server.port),
      );
      expect(response.status).toBe(status);
      expect(await response.text()).toBe(body);
      expect(response.headers.get("x-request-id")).toBe(BACKEND_ID);
    },
  );
});

describe("header filtering", () => {
  it("sends only the allow-listed headers to the backend", async () => {
    const server = await upstream(afterBody((_req, res) => json(res, 200, REPORT)));
    await proxyInspection(
      inspectionRequest(drawing("valid_basic"), {
        "content-type": "Application/PDF; charset=binary",
        "x-filename": "drawing%20%E5%9B%B3.pdf",
        cookie: "session=secret",
        authorization: "Bearer secret",
        "proxy-authorization": "Basic secret",
        "x-forwarded-for": "203.0.113.9",
        "x-forwarded-host": "evil.example",
        "x-real-ip": "203.0.113.9",
        forwarded: "for=203.0.113.9",
        "x-request-id": "client-chosen",
        "keep-alive": "timeout=5",
        te: "trailers",
        upgrade: "websocket",
        "x-custom": "1",
        "user-agent": "browser",
        referer: "http://127.0.0.1:3000/",
      }),
      configFor(server.port),
    );
    const headers = server.requests[0]!.headers;
    expect(Object.keys(headers).sort()).toEqual([
      "accept",
      "accept-encoding",
      "connection",
      "content-type",
      "host",
      "transfer-encoding",
      "x-filename",
    ]);
    expect(headers["content-type"]).toBe("application/pdf");
    expect(headers["x-filename"]).toBe("drawing%20%E5%9B%B3.pdf");
    expect(headers["accept-encoding"]).toBe("identity");
    expect(headers.host).toBe(`127.0.0.1:${server.port}`);
  });

  it("does not forward X-Filename when the browser sends none", async () => {
    const server = await upstream(afterBody((_req, res) => json(res, 200, REPORT)));
    await proxyInspection(inspectionRequest(drawing("valid_basic")), configFor(server.port));
    expect(server.requests[0]!.headers["x-filename"]).toBeUndefined();
  });
});

describe("request validation (nothing is forwarded)", () => {
  async function refused(request: Request) {
    const server = await upstream(afterBody((_req, res) => json(res, 200, REPORT)));
    const response = await proxyInspection(request, configFor(server.port));
    expect(server.requests).toHaveLength(0);
    return { status: response.status, error: await errorOf(response), response };
  }

  it.each([
    ["missing", undefined],
    ["text/plain", "text/plain"],
    ["multipart/form-data", "multipart/form-data; boundary=x"],
    ["application/octet-stream", "application/octet-stream"],
    ["application/pdfx", "application/pdfx"],
    ["application/json", "application/json"],
  ])("refuses Content-Type %s with 415", async (_label, contentType) => {
    const headers: Record<string, string> = { host: HOST };
    if (contentType !== undefined) headers["content-type"] = contentType;
    const request = new Request("http://127.0.0.1:3000/api/inspections", {
      method: "POST",
      headers,
      body: new Uint8Array(drawing("valid_basic")),
    });
    const result = await refused(request);
    expect(result.status).toBe(415);
    expect(result.error.code).toBe("UNSUPPORTED_CONTENT_TYPE");
  });

  it.each([
    ["a tab character", "a\tb.pdf"],
    ["a DEL character", "a\x7fb.pdf"],
    ["unencoded non-ASCII", "zeichnung-é.pdf"],
    ["an over-long value", "a".repeat(255 * 12 + 1)],
  ])("refuses an X-Filename with %s with 422", async (_label, value) => {
    const result = await refused(inspectionRequest(drawing("valid_basic"), { "x-filename": value }));
    expect(result.status).toBe(422);
    expect(result.error.code).toBe("REQUEST_VALIDATION_ERROR");
  });

  it("refuses a declared Content-Length over the limit without reading the body", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1));
      },
    }, { highWaterMark: 0 });
    const result = await refused(
      inspectionRequest(body, { "content-length": String(MAX_UPLOAD_BYTES + 1) }),
    );
    expect(result.status).toBe(413);
    expect(result.error.code).toBe("FILE_TOO_LARGE");
    expect(pulls).toBe(0);
  });

  it.each([
    ["a foreign Host (DNS rebinding)", { host: "attacker.example:3000" }],
    ["a Host with user info", { host: "evil@127.0.0.1:3000" }],
    ["a Host that starts like a loopback address", { host: "127.0.0.1.nip.io:3000" }],
    ["a Host that starts like localhost", { host: "localhost.attacker.example:3000" }],
    ["a cross-site Origin", { origin: "http://attacker.example" }],
    ["an Origin on another local port", { origin: "http://127.0.0.1:5173" }],
    ["an opaque Origin", { origin: "null" }],
    ["Sec-Fetch-Site: cross-site", { "sec-fetch-site": "cross-site" }],
    ["Sec-Fetch-Site: same-site", { "sec-fetch-site": "same-site" }],
  ])("refuses %s with 403", async (_label, headers) => {
    const result = await refused(inspectionRequest(drawing("valid_basic"), headers));
    expect(result.status).toBe(403);
    expect(result.error.code).toBe("FORBIDDEN");
  });

  it.each([
    [{ host: "localhost:3000", origin: "http://localhost:3000" }],
    [{ host: "[::1]:3000", origin: "http://[::1]:3000", "sec-fetch-site": "same-origin" }],
    [{ origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin" }],
    [{ host: "localhost", origin: "http://localhost" }],
    [{ host: "LOCALHOST:3000", origin: "http://localhost:3000" }],
  ])("accepts a same-origin local request %j", async (headers) => {
    const server = await upstream(afterBody((_req, res) => json(res, 200, REPORT)));
    const response = await proxyInspection(
      inspectionRequest(drawing("valid_basic"), headers),
      configFor(server.port),
    );
    expect(response.status).toBe(200);
  });
});

describe("upload size enforced on actual bytes", () => {
  it.each([
    ["no Content-Length", {}],
    ["a Content-Length that understates the body", { "content-length": "1000" }],
  ])("stops an upload past the limit with %s", async (_label, headers) => {
    const server = await upstream(afterBody((_req, res) => json(res, 200, REPORT)));
    const response = await proxyInspection(
      inspectionRequest(streamOf(zeros(MAX_UPLOAD_BYTES + MIB)), headers),
      configFor(server.port),
    );
    expect(response.status).toBe(413);
    expect((await errorOf(response)).code).toBe("FILE_TOO_LARGE");
    // The backend saw the request cut off: never complete, never more than the limit.
    const [received] = server.requests;
    await received?.closed;
    expect(received?.completed).toBe(false);
    expect(received!.body.length).toBeLessThanOrEqual(MAX_UPLOAD_BYTES);
  });
});

describe("backend responses that are not passed on", () => {
  async function proxied(
    handler: Parameters<typeof startUpstream>[0],
    overrides: Partial<ProxyLimits> = {},
  ) {
    const server = await upstream(handler);
    const response = await proxyInspection(
      inspectionRequest(drawing("valid_basic")),
      configFor(server.port),
      limits(overrides),
    );
    const text = await response.text();
    return { server, response, text, error: (JSON.parse(text) as ReturnType<typeof envelope>).error };
  }

  it.each([301, 302, 303, 307, 308])("treats a %i redirect as invalid and never follows it", async (status) => {
    const elsewhere = await upstream(afterBody((_req, res) => json(res, 200, REPORT)));
    const { response, error } = await proxied(
      afterBody((_req, res) => {
        res.writeHead(status, { Location: `http://127.0.0.1:${elsewhere.port}/api/v1/inspections` });
        res.end();
      }),
    );
    expect(response.status).toBe(502);
    expect(error.code).toBe("BACKEND_INVALID_RESPONSE");
    expect(elsewhere.requests).toHaveLength(0);
  });

  it.each([201, 202, 204, 401, 403, 418, 429, 502, 504])(
    "treats an undocumented %i as invalid",
    async (status) => {
      const { response, error } = await proxied(
        afterBody((_req, res) => {
          if (status === 204) {
            res.writeHead(204);
            res.end();
          } else json(res, status, envelope("X"));
        }),
      );
      expect(response.status).toBe(502);
      expect(error.code).toBe("BACKEND_INVALID_RESPONSE");
    },
  );

  it.each([
    ["HTML with status 200", 200, "text/html", "<html>ok</html>"],
    ["no Content-Type", 200, undefined, REPORT],
    ["malformed JSON", 200, "application/json", '{"schema_version": '],
    ["a JSON array", 200, "application/json", "[1,2]"],
    ["a JSON string", 200, "application/json", '"ok"'],
    ["JSON null", 200, "application/json", "null"],
    ["an empty body", 200, "application/json", ""],
    ["an error status without the envelope", 422, "application/json", '{"detail":"x"}'],
    ["an envelope with a non-string message", 422, "application/json", '{"error":{"code":"X","message":1,"request_id":""}}'],
    ["an error status with plain text", 400, "text/plain", "Invalid HTTP request received."],
  ])("refuses %s", async (_label, status, contentType, body) => {
    const { response, error } = await proxied(
      afterBody((_req, res) => {
        res.writeHead(status, contentType === undefined ? {} : { "Content-Type": contentType });
        res.end(body);
      }),
    );
    expect(response.status).toBe(502);
    expect(error.code).toBe("BACKEND_INVALID_RESPONSE");
  });

  it("refuses a body that is not valid UTF-8", async () => {
    const { response } = await proxied(
      afterBody((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])); // {"\xff":1}
      }),
    );
    expect(response.status).toBe(502);
  });

  it("refuses a response cut off before its declared length", async () => {
    const { response, error } = await proxied(
      afterBody((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "1000" });
        res.write('{"schema_version":"1.0",');
        setTimeout(() => res.socket?.destroy(), 20);
      }),
    );
    expect(response.status).toBe(502);
    expect(error.code).toBe("BACKEND_INVALID_RESPONSE");
  });

  it("refuses a declared Content-Length over the response cap before reading it", async () => {
    const { response, error } = await proxied(
      afterBody((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "4096" });
        res.write("{");
        // Never finishes: the proxy must not wait for the rest.
      }),
      { maxResponseBytes: 1024 },
    );
    expect(response.status).toBe(502);
    expect(error.code).toBe("BACKEND_INVALID_RESPONSE");
  });

  it("stops reading a chunked response once it passes the cap", async () => {
    let written = 0;
    let finished = false;
    const { server, response, error } = await proxied(
      afterBody((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        const chunk = Buffer.alloc(64 * 1024, 0x20);
        const writeMore = () => {
          while (written < 64 * MIB) {
            written += chunk.length;
            if (!res.write(chunk)) return void res.once("drain", writeMore);
          }
          finished = true;
          res.end();
        };
        writeMore();
      }),
      { maxResponseBytes: 256 * 1024 },
    );
    expect(response.status).toBe(502);
    expect(error.code).toBe("BACKEND_INVALID_RESPONSE");
    await server.requests[0]?.closed;
    expect(finished).toBe(false);
  });
});

describe("unavailable backend and timeouts", () => {
  it("answers 502 when nothing is listening, without revealing the address", async () => {
    const port = await unusedPort();
    const response = await proxyInspection(
      inspectionRequest(drawing("valid_basic")),
      configFor(port),
    );
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(JSON.parse(text).error.code).toBe("BACKEND_UNAVAILABLE");
    expect(text).not.toContain(String(port));
    expect(text).not.toMatch(/127\.0\.0\.1|ECONN|errno|stack|\bat \S+:\d+/i);
  });

  it("answers 502 when the backend drops the connection without a response", async () => {
    const server = await upstream(afterBody((req) => req.socket.destroy()));
    const response = await proxyInspection(
      inspectionRequest(drawing("valid_basic")),
      configFor(server.port),
    );
    expect(response.status).toBe(502);
    expect((await errorOf(response)).code).toBe("BACKEND_UNAVAILABLE");
  });

  it("answers 504 and closes the connection when the backend never responds", async () => {
    const server = await upstream(() => {});
    const started = Date.now();
    const response = await proxyInspection(
      inspectionRequest(drawing("valid_basic")),
      configFor(server.port),
      limits({ totalTimeoutMs: 300 }),
    );
    expect(response.status).toBe(504);
    expect((await errorOf(response)).code).toBe("BACKEND_TIMEOUT");
    expect(Date.now() - started).toBeLessThan(3_000);
    await server.requests[0]?.closed;
  });

  it("answers 504 when the response body stalls after the headers", async () => {
    const server = await upstream(
      afterBody((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"schema_version":');
      }),
    );
    const response = await proxyInspection(
      inspectionRequest(drawing("valid_basic")),
      configFor(server.port),
      limits({ totalTimeoutMs: 300 }),
    );
    expect(response.status).toBe(504);
    await server.requests[0]?.closed;
  });

  it("answers 408 and abandons the backend request when the upload stalls", async () => {
    const server = await upstream(afterBody((_req, res) => json(res, 200, REPORT)));
    const response = await proxyInspection(
      inspectionRequest(streamOf([new Uint8Array(1000)], false)),
      configFor(server.port),
      limits({ uploadTimeoutMs: 300 }),
    );
    expect(response.status).toBe(408);
    expect((await errorOf(response)).code).toBe("UPLOAD_TIMEOUT");
    await server.requests[0]?.closed;
    expect(server.requests[0]?.completed).toBe(false);
  });

  it("does not apply the upload deadline once the upload has finished", async () => {
    const server = await upstream(
      afterBody((_req, res) => setTimeout(() => json(res, 200, REPORT), 500)),
    );
    const response = await proxyInspection(
      inspectionRequest(drawing("valid_basic")),
      configFor(server.port),
      limits({ uploadTimeoutMs: 200 }),
    );
    expect(response.status).toBe(200);
  });

  it("passes on a backend answer sent before it read the body", async () => {
    // The backend refuses early (SERVER_BUSY is decided before the body is read).
    const server = await upstream((_req, res) => json(res, 503, envelope("SERVER_BUSY")));
    const response = await proxyInspection(
      inspectionRequest(drawing("valid_basic")),
      configFor(server.port),
    );
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe("SERVER_BUSY");
  });

  it("never reports success when the backend answers early and closes mid-upload", async () => {
    // With megabytes still to send, the backend's close can reset the connection before
    // its answer is read (on Windows the reset discards it). HTTP/1.1 offers no way to
    // recover that answer, so the proxy may only relay it or report a 502 (unavailable,
    // or invalid if the reset cuts off the answer's body).
    const server = await upstream((_req, res) => json(res, 503, envelope("SERVER_BUSY")));
    const response = await proxyInspection(
      inspectionRequest(streamOf(zeros(4 * MIB, 64 * 1024))),
      configFor(server.port),
    );
    const error = await errorOf(response);
    expect([
      [503, "SERVER_BUSY"],
      [502, "BACKEND_UNAVAILABLE"],
      [502, "BACKEND_INVALID_RESPONSE"],
    ]).toContainEqual([response.status, error.code]);
  });
});

describe("client disconnects", () => {
  it("abandons the backend request when the browser goes away while waiting", async () => {
    const server = await upstream(() => {}); // never answers
    const client = new AbortController();
    const pending = proxyInspection(
      inspectionRequest(drawing("valid_basic"), {}, client.signal),
      configFor(server.port),
    );
    await eventually(() => server.requests[0]?.completed === true);
    client.abort();
    const response = await pending;
    expect((await errorOf(response)).code).toBe("CLIENT_DISCONNECTED");
    await server.requests[0]?.closed;
  });

  it("abandons the backend request when the upload breaks off", async () => {
    const server = await upstream(afterBody((_req, res) => json(res, 200, REPORT)));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 3) controller.enqueue(new Uint8Array(64 * 1024));
        else controller.error(new Error("connection reset by the browser"));
      },
    }, { highWaterMark: 0 });
    const response = await proxyInspection(inspectionRequest(body), configFor(server.port));
    expect((await errorOf(response)).code).toBe("CLIENT_DISCONNECTED");
    // Depending on timing the request head may not have been flushed yet; either way the
    // backend must never see a complete request.
    await eventually(() => server.openConnections() === 0);
    expect(server.requests.filter((r) => r.completed)).toHaveLength(0);
  });

  it("does not contact the backend for a request that is already aborted", async () => {
    const server = await upstream(afterBody((_req, res) => json(res, 200, REPORT)));
    const response = await proxyInspection(
      inspectionRequest(drawing("valid_basic"), {}, AbortSignal.abort()),
      configFor(server.port),
    );
    expect((await errorOf(response)).code).toBe("CLIENT_DISCONNECTED");
    expect(server.requests).toHaveLength(0);
  });
});

describe("configuration and disclosure", () => {
  it("fails closed when the backend address is invalid", async () => {
    const response = await proxyInspection(inspectionRequest(drawing("valid_basic")), {
      ok: false,
      reason: "must be a loopback IP address (127.0.0.0/8 or [::1])",
    });
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(JSON.parse(text).error.code).toBe("PROXY_MISCONFIGURED");
    expect(text).not.toContain("loopback");
  });

  it("gives every proxy-made error the envelope and a matching X-Request-ID", async () => {
    const response = await proxyInspection(
      inspectionRequest(drawing("valid_basic"), { "content-type": "text/plain" }),
      configFor(1),
    );
    const error = await errorOf(response);
    expect(error.request_id).toMatch(/^[0-9a-f]{32}$/);
    expect(response.headers.get("x-request-id")).toBe(error.request_id);
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("does not trust a malformed X-Request-ID from the backend", async () => {
    const server = await upstream(
      afterBody((_req, res) => json(res, 200, REPORT, { "X-Request-ID": "<script>" })),
    );
    const response = await proxyInspection(
      inspectionRequest(drawing("valid_basic")),
      configFor(server.port),
    );
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("resource cleanup", () => {
  it("leaves no open connections or timers after a mix of failures", async () => {
    const timersBefore = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const never = await upstream(() => {});
    const huge = await upstream(
      afterBody((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write(Buffer.alloc(2 * MIB, 0x20));
      }),
    );
    const ok = await upstream(afterBody((_req, res) => json(res, 200, REPORT)));
    // Each group uses a short deadline only for the timer it is meant to trip; the other
    // deadlines are 60 s, so any timer left running would show up in the count below.
    const fast = limits({ totalTimeoutMs: 60_000, uploadTimeoutMs: 60_000, maxResponseBytes: MIB });
    const deadline = limits({ totalTimeoutMs: 1_000, uploadTimeoutMs: 60_000 });
    const stalled = limits({ totalTimeoutMs: 60_000, uploadTimeoutMs: 1_000 });

    const results = await Promise.all([
      ...Array.from({ length: 5 }, () =>
        proxyInspection(inspectionRequest(drawing("valid_basic")), configFor(never.port), deadline),
      ),
      ...Array.from({ length: 5 }, () =>
        proxyInspection(inspectionRequest(drawing("valid_basic")), configFor(huge.port), fast),
      ),
      ...Array.from({ length: 5 }, () =>
        proxyInspection(
          inspectionRequest(streamOf(zeros(MAX_UPLOAD_BYTES + 1, MIB))),
          configFor(ok.port),
          fast,
        ),
      ),
      ...Array.from({ length: 5 }, () =>
        proxyInspection(inspectionRequest(streamOf([new Uint8Array(10)], false)), configFor(ok.port), stalled),
      ),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      ...Array(5).fill(408),
      ...Array(5).fill(413),
      ...Array(5).fill(502),
      ...Array(5).fill(504),
    ]);
    await eventually(
      () => never.openConnections() + huge.openConnections() + ok.openConnections() === 0,
    );
    const timersAfter = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    expect(timersAfter).toBeLessThanOrEqual(timersBefore);
  });
});
