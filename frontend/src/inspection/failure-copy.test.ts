import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeFailure, describeFileProblem } from "./failure-copy";
import type { Failure } from "./state";

const BACKEND_SRC = path.resolve(import.meta.dirname, "../../../backend/src/blueprintiq");

/**
 * Every error code the backend can put in its envelope, read from its source so that a
 * new code cannot be added without this app learning to explain it.
 */
function backendCodes(): string[] {
  const files = ["api/app.py", "api/errors.py", "ingestion/errors.py"];
  const source = files.map((f) => readFileSync(path.join(BACKEND_SRC, f), "utf8")).join("\n");
  const found = new Set<string>();
  const patterns = [
    /ApiError\(\s*\d+,\s*"([A-Z_]+)"/g, // raised by the API itself
    /error_response\(\s*request,\s*\d+,\s*"([A-Z_]+)"/g, // handlers
    /code = "([A-Z_]+)"/g, // ingestion rejections
    /\d{3}: "([A-Z_]+)"/g, // {404: "NOT_FOUND", ...}
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[1]!);
  }
  // Not codes a client can receive: the rejection base class, and the catch-all for HTTP
  // statuses the API does not otherwise use.
  found.delete("DOCUMENT_REJECTED");
  found.delete("HTTP_ERROR");
  return [...found].sort();
}

const PROXY_CODES = [
  "FORBIDDEN",
  "BACKEND_UNAVAILABLE",
  "BACKEND_INVALID_RESPONSE",
  "BACKEND_TIMEOUT",
  "PROXY_MISCONFIGURED",
];

const api = (code: string, status = 422, extra: Partial<Extract<Failure, { kind: "api" }>> = {}): Failure => ({
  kind: "api",
  status,
  code,
  message: "Backend message.",
  requestId: "0123456789abcdef0123456789abcdef",
  ...extra,
});

describe("explanations for error codes", () => {
  it("finds the backend's codes in its source (guards the scan itself)", () => {
    const codes = backendCodes();
    expect(codes.length).toBeGreaterThanOrEqual(20);
    for (const expected of ["NO_TEXT_LAYER", "SERVER_BUSY", "UPLOAD_TIMEOUT", "NOT_FOUND"]) {
      expect(codes).toContain(expected);
    }
  });

  it.each([...backendCodes(), ...PROXY_CODES])("%s has its own explanation", (code) => {
    const copy = describeFailure(api(code));
    expect(copy.title).not.toBe("The inspection service reported an error"); // the unknown-code fallback
    expect(copy.title.length).toBeGreaterThan(5);
    expect(copy.explanation.length).toBeGreaterThan(10);
    expect(copy.details).toContainEqual({ label: "Code", value: code });
  });

  it("shows the code, status and request id for support", () => {
    expect(describeFailure(api("SERVER_BUSY", 503)).details).toEqual([
      { label: "Code", value: "SERVER_BUSY" },
      { label: "HTTP status", value: "503" },
      { label: "Request ID", value: "0123456789abcdef0123456789abcdef" },
    ]);
  });

  it("omits an empty request id", () => {
    const copy = describeFailure(api("SERVER_BUSY", 503, { requestId: "" }));
    expect(copy.details.map((d) => d.label)).toEqual(["Code", "HTTP status"]);
  });

  it("says plainly when a code is unknown, and shows what the service said", () => {
    const copy = describeFailure(api("BRAND_NEW_CODE", 422, { message: "Something new." }));
    expect(copy.title).toBe("The inspection service reported an error");
    expect(copy.explanation).toContain("Something new.");
    expect(copy.details).toContainEqual({ label: "Code", value: "BRAND_NEW_CODE" });
    expect(copy.retryable).toBe(false);
  });

  it("treats an unknown code on a 5xx status as worth retrying", () => {
    expect(describeFailure(api("BRAND_NEW_CODE", 500)).retryable).toBe(true);
  });

  it.each([
    ["SERVER_BUSY", true],
    ["UPLOAD_TIMEOUT", true],
    ["CLIENT_DISCONNECTED", true],
    ["INTERNAL_ERROR", true],
    ["BACKEND_UNAVAILABLE", true],
    ["BACKEND_TIMEOUT", true],
    ["BACKEND_INVALID_RESPONSE", true],
    ["NO_TEXT_LAYER", false],
    ["INVALID_PDF", false],
    ["ENCRYPTED_PDF", false],
    ["TOO_MANY_PAGES", false],
    ["FILE_TOO_LARGE", false],
    ["UNSUPPORTED_GEOMETRY", false],
    ["PROXY_MISCONFIGURED", false],
    ["FORBIDDEN", false],
  ])("%s is retryable: %s", (code, retryable) => {
    expect(describeFailure(api(code)).retryable).toBe(retryable);
  });
});

describe("failures with no error code", () => {
  it("explains an unusable reply and says it is not a result", () => {
    const copy = describeFailure({
      kind: "malformed",
      status: 200,
      problem: "findings[0].status: unexpected value",
      requestId: null,
    });
    expect(copy.title).toBe("The reply could not be understood");
    expect(copy.explanation).toContain("not a result for your drawing");
    expect(copy.details).toContainEqual({
      label: "Problem",
      value: "findings[0].status: unexpected value",
    });
    expect(copy.retryable).toBe(true);
  });

  it("explains an unreachable app and a timeout", () => {
    expect(describeFailure({ kind: "network" })).toMatchObject({
      title: "The app could not be reached",
      retryable: true,
    });
    expect(describeFailure({ kind: "timeout" })).toMatchObject({
      title: "No answer was received",
      retryable: true,
    });
  });
});

describe("explanations for files refused in the browser", () => {
  it("states the exact byte counts for an oversized file", () => {
    const copy = describeFileProblem("too_large", "big.pdf", 10_485_761);
    expect(copy.explanation).toContain("10,485,760 bytes");
    expect(copy.details).toContainEqual({ label: "Size", value: "10,485,761 bytes" });
  });

  it.each(["not_pdf", "empty", "too_large", "multiple"] as const)("%s is never retryable", (problem) => {
    const copy = describeFileProblem(problem, "x.pdf", 1);
    expect(copy.retryable).toBe(false);
    expect(copy.hint).toBeDefined();
  });

  it("never uses an em dash or an en dash in any copy", () => {
    const failures: Failure[] = [
      ...[...backendCodes(), ...PROXY_CODES].map((code) => api(code)),
      { kind: "network" },
      { kind: "timeout" },
      { kind: "malformed", status: 200, problem: "x", requestId: null },
    ];
    const texts = [
      ...failures.flatMap((f) => {
        const c = describeFailure(f);
        return [c.title, c.explanation, c.hint ?? ""];
      }),
      ...(["not_pdf", "empty", "too_large", "multiple"] as const).flatMap((p) => {
        const c = describeFileProblem(p, "x.pdf", 1);
        return [c.title, c.explanation, c.hint ?? ""];
      }),
    ];
    for (const text of texts) expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});
