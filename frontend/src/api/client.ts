import { interpretResponse, type ApiOutcome } from "./read-response";

/** The one endpoint the browser talks to: the Next.js proxy, never the backend directly. */
export const INSPECTIONS_URL = "/api/inspections";

// The proxy gives up on the backend after 120 s (docs/frontend-f1.md); this is a safety
// net for a proxy that never answers at all.
export const CLIENT_TIMEOUT_MS = 130_000;

export type InspectionResult =
  | ApiOutcome
  | { kind: "network" } // the request never produced a response
  | { kind: "timeout" } // no response within CLIENT_TIMEOUT_MS
  | { kind: "aborted" }; // superseded or cancelled by the caller; never shown

export interface RunOptions {
  signal: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type RunInspection = (file: File, options: RunOptions) => Promise<InspectionResult>;

/** Upload one PDF and classify the answer. Never throws for network or HTTP problems. */
export const runInspection: RunInspection = async (file, options) => {
  const { signal, timeoutMs = CLIENT_TIMEOUT_MS, fetchImpl = fetch } = options;
  if (signal.aborted) return { kind: "aborted" };

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(INSPECTIONS_URL, {
      method: "POST",
      // Percent-encoded UTF-8, as the backend expects; the file itself is the raw body.
      headers: {
        "Content-Type": "application/pdf",
        "X-Filename": encodeURIComponent(file.name),
      },
      body: file,
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    if (signal.aborted) return { kind: "aborted" };
    return interpretResponse(response.status, text, response.headers.get("x-request-id"));
  } catch {
    if (signal.aborted) return { kind: "aborted" };
    return timedOut ? { kind: "timeout" } : { kind: "network" };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
};
