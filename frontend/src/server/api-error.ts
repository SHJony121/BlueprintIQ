import "server-only";
import { randomBytes } from "node:crypto";

// Responses the proxy creates itself use the backend's error envelope
// ({"error": {"code", "message", "request_id"}}) and X-Request-ID header, so the browser
// handles one format whichever side refused the request. Messages are fixed strings:
// no addresses, error text from Node, or stack traces.

export type ProxyErrorCode = keyof typeof ERRORS;

export const ERRORS = {
  NOT_FOUND: [404, "Request not handled."],
  METHOD_NOT_ALLOWED: [405, "Request not handled."],
  FORBIDDEN: [403, "Requests must come from this application on the local machine."],
  UNSUPPORTED_CONTENT_TYPE: [
    415,
    "Send the PDF as the request body with Content-Type: application/pdf.",
  ],
  REQUEST_VALIDATION_ERROR: [422, "The X-Filename header is invalid."],
  FILE_TOO_LARGE: [413, "The upload exceeds the limit of 10 MiB (10485760 bytes)."],
  UPLOAD_TIMEOUT: [408, "The upload was not received in time."],
  CLIENT_DISCONNECTED: [400, "The upload was interrupted."],
  BACKEND_UNAVAILABLE: [502, "The inspection service is not reachable or closed the connection."],
  BACKEND_INVALID_RESPONSE: [502, "The inspection service returned an invalid response."],
  BACKEND_TIMEOUT: [504, "The inspection service did not respond in time."],
  PROXY_MISCONFIGURED: [500, "The inspection service is not configured correctly."],
} as const satisfies Record<string, readonly [number, string]>;

/** A fresh 32-hex-character id, the same shape as the backend's request ids. */
export function newRequestId(): string {
  return randomBytes(16).toString("hex");
}

/** Headers every proxy response carries, whether passed through or created here. */
export function responseHeaders(requestId: string): Headers {
  return new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Request-ID": requestId,
  });
}

export function errorResponse(
  code: ProxyErrorCode,
  requestId: string = newRequestId(),
  extraHeaders: Record<string, string> = {},
): Response {
  const [status, message] = ERRORS[code];
  const headers = responseHeaders(requestId);
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  const body = JSON.stringify({ error: { code, message, request_id: requestId } });
  return new Response(body, { status, headers });
}
