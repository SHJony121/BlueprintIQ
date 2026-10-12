import { errorResponse } from "@/server/api-error";
import { backendConfig } from "@/server/backend-config";
import { proxyInspection } from "@/server/inspection-proxy";

// The only proxied route. Node.js runtime: the proxy uses node:http for full control of
// the upstream connection (headers sent, timeouts, no redirects, no decompression).
export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return proxyInspection(request, backendConfig());
}

// Every other method gets the same JSON envelope as the backend instead of an empty 405.
function methodNotAllowed(): Response {
  return errorResponse("METHOD_NOT_ALLOWED", undefined, { Allow: "POST" });
}

export const GET = methodNotAllowed;
export const HEAD = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
