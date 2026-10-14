import "server-only";
import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { errorResponse, newRequestId, responseHeaders, type ProxyErrorCode } from "./api-error";
import { MAX_UPLOAD_BYTES } from "@/lib/limits";
import type { BackendConfig } from "./backend-config";
import { clientKey, policyFromEnv, sameOrigin, type ProxyPolicy } from "./production-config";

// Server-side proxy for POST /api/inspections -> backend POST /api/v1/inspections.
//
// The request body is streamed to the backend and counted as it passes; nothing is
// buffered except the chunk in flight. The response is read into memory up to a fixed
// cap and validated before the browser is told anything, so a truncated, oversized or
// malformed backend reply is reported as an error instead of a success. See
// docs/frontend-f1.md for the limits, error codes and the cancellation caveat.

// Same value as the backend's default `max_upload_bytes`; shared with the browser's
// early file check.
export { MAX_UPLOAD_BYTES };

/** The only backend path the proxy ever requests. */
export const INSPECTIONS_PATH = "/api/v1/inspections";

export interface ProxyLimits {
  /** Largest backend response accepted (decoded bytes as received; no compression is requested). */
  maxResponseBytes: number;
  /** The whole upload must reach the backend within this time. */
  uploadTimeoutMs: number;
  /** Upper bound for the whole exchange, from the first byte to the last. */
  totalTimeoutMs: number;
}

export const DEFAULT_LIMITS: ProxyLimits = {
  // The largest report measured at the backend's text limits was 4.31 MiB (5,000
  // ambiguous annotations); this leaves a wide margin. See docs/frontend-f1.md.
  maxResponseBytes: 16 * 1024 * 1024,
  // Slightly above the backend's own 30 s upload deadline, so its 408 normally wins.
  uploadTimeoutMs: 35_000,
  // Backend worst case: 30 s upload + 30 s queue + 30 s job + process start-up.
  totalTimeoutMs: 120_000,
};

type Failure =
  | "too_large"
  | "upload_timeout"
  | "client_disconnected"
  | "timeout"
  | "unavailable"
  | "invalid";

const FAILURE_CODES: Record<Failure, ProxyErrorCode> = {
  too_large: "FILE_TOO_LARGE",
  upload_timeout: "UPLOAD_TIMEOUT",
  client_disconnected: "CLIENT_DISCONNECTED",
  timeout: "BACKEND_TIMEOUT",
  unavailable: "BACKEND_UNAVAILABLE",
  invalid: "BACKEND_INVALID_RESPONSE",
};

// Statuses the backend documents for this route, all with the error envelope.
const BACKEND_ERROR_STATUSES = new Set([400, 404, 405, 408, 413, 415, 422, 500, 503]);

// Percent-encoded UTF-8: at most 12 characters per code point, 255 code points. The
// backend checks the decoded length itself; this only bounds what is forwarded.
const MAX_FILENAME_HEADER = 255 * 12;

// The per-request requirements (percent-encoded JSON, a few hundred characters). Bounded
// here and forwarded untouched: the backend parses it with a strict, fixed schema.
const MAX_REQUIREMENTS_HEADER = 2048;

const REQUEST_ID = /^[0-9a-f]{32}$/;

export async function proxyInspection(
  request: Request,
  config: BackendConfig,
  limits: ProxyLimits = DEFAULT_LIMITS,
  policy: ProxyPolicy = policyFromEnv(),
): Promise<Response> {
  if (!config.ok) return errorResponse("PROXY_MISCONFIGURED");
  const refused = checkRequest(request.headers, policy);
  if (refused !== undefined) return errorResponse(refused);
  if (request.signal.aborted) return errorResponse("CLIENT_DISCONNECTED");

  // After the cheap checks and before a single body byte is read: one client cannot hold
  // the upload slots or the workers.
  const ticket = policy.limiter?.acquire(clientKey(request.headers, policy.clients));
  if (ticket !== undefined && !ticket.ok) {
    return errorResponse(ticket.reason === "rate" ? "RATE_LIMITED" : "TOO_MANY_UPLOADS", undefined, {
      "Retry-After": String(ticket.retryAfterSeconds),
    });
  }

  const requestId = newRequestId();
  const abort = new AbortController();
  let failure: Failure | undefined;
  const fail = (reason: Failure) => {
    failure ??= reason;
    abort.abort();
  };
  const onClientGone = () => fail("client_disconnected");
  request.signal.addEventListener("abort", onClientGone, { once: true });
  const totalTimer = setTimeout(() => fail("timeout"), limits.totalTimeoutMs);
  const uploadTimer = setTimeout(() => fail("upload_timeout"), limits.uploadTimeoutMs);
  let responded = false;

  try {
    const upstream = await send(request, config, abort.signal, fail, () =>
      clearTimeout(uploadTimer),
    );
    responded = true;
    // Once the backend has answered, a still-running upload no longer matters.
    clearTimeout(uploadTimer);
    const result = await readResponse(upstream, limits.maxResponseBytes);
    if (result === undefined) {
      fail("invalid");
      throw new Error("invalid backend response");
    }
    const headers = responseHeaders(result.requestId ?? requestId);
    const { buffer, byteOffset, byteLength } = result.body;
    const body = new Uint8Array(buffer as ArrayBuffer, byteOffset, byteLength); // a view, not a copy
    return new Response(body, { status: result.status, headers });
  } catch (error) {
    const reason = failure ?? (responded ? "invalid" : "unavailable");
    logFailure(reason, requestId, error);
    return errorResponse(FAILURE_CODES[reason], requestId);
  } finally {
    if (ticket !== undefined && ticket.ok) ticket.release();
    clearTimeout(totalTimer);
    clearTimeout(uploadTimer);
    request.signal.removeEventListener("abort", onClientGone);
    // Ends anything still open: an upload the backend stopped reading (it answered
    // early) or a connection left behind by a failure. A no-op after a clean exchange.
    abort.abort();
  }
}

/** Refuse requests the proxy must not forward, before any body byte is read. */
function checkRequest(headers: Headers, policy: ProxyPolicy): ProxyErrorCode | undefined {
  if (!sameOrigin(headers, policy.hosts)) return "FORBIDDEN";
  if (mediaType(headers.get("content-type")) !== "application/pdf") {
    return "UNSUPPORTED_CONTENT_TYPE";
  }
  // Early refusal only; the byte count during streaming is what is enforced.
  const declared = headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_UPLOAD_BYTES) {
    return "FILE_TOO_LARGE";
  }
  const filename = headers.get("x-filename");
  if (
    filename !== null &&
    (filename.length > MAX_FILENAME_HEADER || !/^[\x20-\x7e]*$/.test(filename))
  ) {
    return "REQUEST_VALIDATION_ERROR";
  }
  const requirements = headers.get("x-inspection-requirements");
  if (
    requirements !== null &&
    (requirements.length > MAX_REQUIREMENTS_HEADER || !/^[\x20-\x7e]*$/.test(requirements))
  ) {
    return "INVALID_REQUIREMENTS";
  }
  return undefined;
}

function mediaType(value: string | null | undefined): string {
  return (value ?? "").split(";")[0]!.trim().toLowerCase();
}

/** Start the backend request and stream the upload into it; resolves with the response head. */
function send(
  request: Request,
  config: Extract<BackendConfig, { ok: true }>,
  signal: AbortSignal,
  fail: (reason: Failure) => void,
  onUploaded: () => void,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    // Built from scratch: only what the backend needs. Cookies, Authorization,
    // forwarding and hop-by-hop headers from the browser never reach it.
    const headers: Record<string, string> = {
      "Content-Type": "application/pdf",
      Accept: "application/json",
      "Accept-Encoding": "identity",
    };
    const filename = request.headers.get("x-filename");
    if (filename !== null) headers["X-Filename"] = filename;
    const requirements = request.headers.get("x-inspection-requirements");
    if (requirements !== null) headers["X-Inspection-Requirements"] = requirements;

    const upstream = http.request({
      host: config.hostname,
      port: config.port,
      method: "POST",
      path: INSPECTIONS_PATH,
      headers,
      agent: false, // one connection per request, closed afterwards
      signal,
    });
    upstream.on("error", () => {}); // later errors (after an abort) must not go unhandled
    upstream.once("error", reject);
    upstream.once("response", (response) => {
      response.on("error", () => {});
      resolve(response);
    });

    const body = Readable.from(countedChunks(request.body, fail), { objectMode: false });
    pipeline(body, upstream).then(onUploaded, () => {
      // The cause is recorded through `fail` or surfaces as the request's own error.
    });
  });
}

/** Yield the upload's chunks, failing past MAX_UPLOAD_BYTES or if the browser goes away. */
async function* countedChunks(
  body: ReadableStream<Uint8Array> | null,
  fail: (reason: Failure) => void,
): AsyncGenerator<Uint8Array> {
  if (body === null) return;
  const reader = body.getReader();
  let received = 0;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        fail("client_disconnected");
        throw error;
      }
      if (chunk.done) return;
      received += chunk.value.byteLength;
      if (received > MAX_UPLOAD_BYTES) {
        fail("too_large");
        throw new Error("upload too large");
      }
      yield chunk.value;
    }
  } finally {
    // Stops the browser's upload being read when we stop early; harmless after the end.
    reader.cancel().catch(() => {});
  }
}

interface ValidResponse {
  status: number;
  body: Buffer;
  requestId: string | undefined;
}

/** Read and validate the backend reply; `undefined` means it must not be passed on. */
async function readResponse(
  response: http.IncomingMessage,
  maxBytes: number,
): Promise<ValidResponse | undefined> {
  const status = response.statusCode ?? 0;
  // Redirects are never followed: any 3xx, like any undocumented status, is invalid.
  if (status !== 200 && !BACKEND_ERROR_STATUSES.has(status)) return undefined;
  if (mediaType(response.headers["content-type"]) !== "application/json") return undefined;
  const declared = response.headers["content-length"];
  if (declared !== undefined && Number(declared) > maxBytes) return undefined;

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) return undefined;
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks, size);

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return undefined;
  }
  if (status === 200 ? !isObject(parsed) : !isErrorEnvelope(parsed)) return undefined;

  const id = response.headers["x-request-id"];
  const requestId = typeof id === "string" && REQUEST_ID.test(id) ? id : undefined;
  return { status, body, requestId };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorEnvelope(value: unknown): boolean {
  if (!isObject(value) || !isObject(value.error)) return false;
  const { code, message, request_id } = value.error;
  return (
    typeof code === "string" &&
    /^[A-Z][A-Z_]{0,63}$/.test(code) &&
    typeof message === "string" &&
    typeof request_id === "string"
  );
}

function logFailure(reason: Failure, requestId: string, error: unknown): void {
  // Error class and Node error code only: never addresses, messages or upload data.
  const code = (error as { code?: unknown } | null)?.code;
  console.warn(
    JSON.stringify({
      event: "proxy_error",
      reason,
      request_id: requestId,
      error: error instanceof Error ? error.name : typeof error,
      ...(typeof code === "string" ? { error_code: code } : {}),
    }),
  );
}
