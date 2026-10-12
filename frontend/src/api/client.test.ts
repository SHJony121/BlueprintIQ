import { afterEach, describe, expect, it, vi } from "vitest";
import { errorBody, makeReport, pdf, REQUEST_ID } from "../../tests/ui/builders";
import { CLIENT_TIMEOUT_MS, INSPECTIONS_URL, runInspection } from "./client";

afterEach(() => vi.useRealTimers());

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const run = (
  fetchImpl: typeof fetch,
  overrides: { signal?: AbortSignal; timeoutMs?: number; file?: File; requirements?: string | null } = {},
) =>
  runInspection(overrides.file ?? pdf(), {
    signal: overrides.signal ?? new AbortController().signal,
    timeoutMs: overrides.timeoutMs,
    requirements: overrides.requirements,
    fetchImpl,
  });

describe("the request", () => {
  it("posts the raw file to the proxy only, with the headers the backend expects", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(reply(200, makeReport()));
    const file = pdf("bracket.pdf");
    await run(fetchImpl, { file });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(INSPECTIONS_URL);
    expect(url).toBe("/api/inspections"); // relative: never the backend's own address
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(file);
    expect(init?.headers).toEqual({
      "Content-Type": "application/pdf",
      "X-Filename": "bracket.pdf",
    });
    expect(init?.cache).toBe("no-store");
  });

  it("sends the requirements header only when requirements are given", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(reply(200, makeReport()));
    await run(fetchImpl, { file: pdf("a.pdf") });
    await run(fetchImpl, { file: pdf("a.pdf"), requirements: "%7B%7D" });
    const first = fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>;
    const second = fetchImpl.mock.calls[1]![1]!.headers as Record<string, string>;
    expect(first).not.toHaveProperty("X-Inspection-Requirements");
    expect(second["X-Inspection-Requirements"]).toBe("%7B%7D");
  });

  it("percent-encodes file names so any name is a valid header value", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(reply(200, makeReport()));
    await run(fetchImpl, { file: pdf("図面 A-01 (rev 2).pdf") });
    const headers = fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["X-Filename"]).toBe("%E5%9B%B3%E9%9D%A2%20A-01%20(rev%202).pdf");
    expect(headers["X-Filename"]).toMatch(/^[\x20-\x7e]*$/);
    expect(decodeURIComponent(headers["X-Filename"]!)).toBe("図面 A-01 (rev 2).pdf");
  });
});

describe("the answer", () => {
  it("returns a report for a 200 with a valid body", async () => {
    const report = makeReport();
    const result = await run(
      vi.fn<typeof fetch>().mockResolvedValue(reply(200, report, { "X-Request-ID": REQUEST_ID })),
    );
    expect(result).toEqual({ kind: "report", report, requestId: REQUEST_ID });
  });

  it("returns the backend's error for an error status", async () => {
    const result = await run(
      vi.fn<typeof fetch>().mockResolvedValue(reply(422, errorBody("NO_TEXT_LAYER"))),
    );
    expect(result).toMatchObject({ kind: "error", status: 422, code: "NO_TEXT_LAYER" });
  });

  it("returns malformed for a body that is not JSON", async () => {
    const result = await run(
      vi.fn<typeof fetch>().mockResolvedValue(reply(502, "<html>Bad gateway</html>")),
    );
    expect(result.kind).toBe("malformed");
  });

  it("returns network when the request fails outright", async () => {
    const result = await run(vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed")));
    expect(result).toEqual({ kind: "network" });
  });

  it("returns network when the body cannot be read", async () => {
    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("connection reset"));
        },
      }),
      { status: 200 },
    );
    expect(await run(vi.fn<typeof fetch>().mockResolvedValue(broken))).toEqual({ kind: "network" });
  });
});

describe("time limit and cancellation", () => {
  it("has a client deadline just above the proxy's 120 s", () => {
    expect(CLIENT_TIMEOUT_MS).toBe(130_000);
  });

  it("gives up with timeout when no answer arrives in time", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const pending = run(fetchImpl, { timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(4_999);
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ kind: "timeout" });
  });

  it("returns aborted, not network or timeout, when the caller cancels", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const pending = run(fetchImpl, { signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ kind: "aborted" });
  });

  it("returns aborted even if the answer arrives after the cancel", async () => {
    const controller = new AbortController();
    let respond!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise((resolve) => (respond = resolve)));
    const pending = run(fetchImpl, { signal: controller.signal });
    controller.abort();
    respond(reply(200, makeReport()));
    expect(await pending).toEqual({ kind: "aborted" });
  });

  it("does not send anything when already cancelled", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await run(fetchImpl, { signal: AbortSignal.abort() });
    expect(result).toEqual({ kind: "aborted" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops its timer once finished", async () => {
    vi.useFakeTimers();
    await run(vi.fn<typeof fetch>().mockResolvedValue(reply(200, makeReport())));
    expect(vi.getTimerCount()).toBe(0);
  });
});
