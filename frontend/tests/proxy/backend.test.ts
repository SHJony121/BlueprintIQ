// End to end: the production Next.js build in front of the real FastAPI backend, using
// the backend's committed synthetic fixtures. Every fixture is sent both directly and
// through the proxy; the proxy must not change what the backend says.
import { readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES } from "@/server/inspection-proxy";
import { drawing, DRAWINGS_DIR, startBackend, startNext, type ChildServer } from "./helpers";

let backend: ChildServer;
let next: ChildServer;

beforeAll(async () => {
  backend = await startBackend();
  next = await startNext(`http://127.0.0.1:${backend.port}`);
});

afterAll(async () => {
  await next?.stop();
  await backend?.stop();
});

const FIXTURES = readdirSync(DRAWINGS_DIR)
  .filter((name) => name.endsWith(".pdf"))
  .map((name) => name.slice(0, -4))
  .sort();

interface Outcome {
  status: number;
  requestId: string | null;
  body: Record<string, unknown>;
}

async function inspect(
  port: number,
  path: string,
  body: Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = {},
): Promise<Outcome> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf", ...headers },
    body,
  });
  return {
    status: response.status,
    requestId: response.headers.get("x-request-id"),
    body: (await response.json()) as Record<string, unknown>,
  };
}

const direct = (body: Uint8Array<ArrayBuffer>, headers?: Record<string, string>) =>
  inspect(backend.port, "/api/v1/inspections", body, headers);
const proxied = (body: Uint8Array<ArrayBuffer>, headers?: Record<string, string>) =>
  inspect(next.port, "/api/inspections", body, headers);

/** Fields that legitimately differ between two runs of the same inspection. */
function stable(body: Record<string, unknown>): Record<string, unknown> {
  if (isEnvelope(body)) {
    const error = { ...body.error };
    delete error.request_id;
    return { error };
  }
  const rest = { ...body };
  delete rest.processing_time_ms;
  return rest;
}

function isEnvelope(body: Record<string, unknown>): body is { error: Record<string, unknown> } {
  return typeof body.error === "object" && body.error !== null;
}

describe("proxy against the real backend", () => {
  it("covers every committed fixture", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(32);
  });

  it.each(FIXTURES)("returns the same outcome as the backend for %s.pdf", async (name) => {
    const pdf = new Uint8Array(drawing(name));
    const headers = { "X-Filename": encodeURIComponent(`${name}.pdf`) };
    const expected = await direct(pdf, headers);
    const actual = await proxied(pdf, headers);

    expect(actual.status).toBe(expected.status);
    expect(stable(actual.body)).toEqual(stable(expected.body));
    expect(actual.requestId).toMatch(/^[0-9a-f]{32}$/);
    if (isEnvelope(actual.body)) {
      // The backend's own id is kept, in the body and the header alike.
      expect(actual.body.error.request_id).toBe(actual.requestId);
    }
  });

  it("passes a percent-encoded UTF-8 file name through", async () => {
    const name = "図面 A-01 (rev 2).pdf";
    const result = await proxied(new Uint8Array(drawing("valid_basic")), {
      "X-Filename": encodeURIComponent(name),
    });
    expect(result.status).toBe(200);
    expect((result.body.document as { filename: string }).filename).toBe(name);
  });

  it("keeps the backend's own check of the decoded file name length", async () => {
    const headers = { "X-Filename": "a".repeat(256) };
    const pdf = new Uint8Array(drawing("valid_basic"));
    const expected = await direct(pdf, headers);
    const actual = await proxied(pdf, headers);
    expect(expected.status).toBe(422);
    expect(actual.status).toBe(422);
    expect(stable(actual.body)).toEqual(stable(expected.body));
  });

  it.each([
    ["an empty body", new Uint8Array(0), 422, "EMPTY_FILE"],
    ["bytes that are not a PDF", new TextEncoder().encode("hello, not a pdf"), 415, "UNSUPPORTED_FILE_TYPE"],
  ])("relays the backend's refusal of %s", async (_label, body, status, code) => {
    const result = await proxied(body);
    expect(result.status).toBe(status);
    expect((result.body.error as { code: string }).code).toBe(code);
  });

  it("refuses an oversized upload with the backend's own status, code and message", async () => {
    const tooBig = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    const expected = await direct(tooBig);
    const actual = await proxied(tooBig);
    expect(expected.status).toBe(413);
    expect(actual.status).toBe(413);
    expect(stable(actual.body)).toEqual(stable(expected.body));
  });

  it("accepts an upload of exactly the limit (the backend then judges the bytes)", async () => {
    const pdf = drawing("valid_basic");
    const padded = new Uint8Array(MAX_UPLOAD_BYTES);
    padded.set(pdf);
    const expected = await direct(padded);
    const actual = await proxied(padded);
    expect(actual.status).toBe(expected.status);
    expect(stable(actual.body)).toEqual(stable(expected.body));
  });
});
