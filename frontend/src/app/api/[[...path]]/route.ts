import { errorResponse } from "@/server/api-error";

// Any other /api path: a JSON 404 in the backend's envelope. Nothing here is forwarded.
export const runtime = "nodejs";

function notFound(): Response {
  return errorResponse("NOT_FOUND");
}

export const GET = notFound;
export const HEAD = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const OPTIONS = notFound;
