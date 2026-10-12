import { describe, expect, it } from "vitest";
import {
  allOutcomesReport,
  ambiguousDimension,
  dimension,
  errorBody,
  finding,
  makeReport,
  material,
  REQUEST_ID,
} from "../../tests/ui/builders";
import { interpretResponse, readReport } from "./read-response";

const json = (value: unknown) => JSON.stringify(value);

describe("a successful report", () => {
  it("is returned as a report, unchanged", () => {
    const report = allOutcomesReport();
    const outcome = interpretResponse(200, json(report), REQUEST_ID);
    expect(outcome).toEqual({ kind: "report", report, requestId: REQUEST_ID });
  });

  it("keeps Decimal quantities exactly as the backend wrote them, as text", () => {
    const report = makeReport({
      measurements: [
        dimension({ id: "M1", value: "4.10", normalized_value_mm: "4.10" }),
        dimension({
          id: "M2",
          dimension_type: "length",
          value: "0.0000001",
          unit: "in",
          normalized_value_mm: "0.00000254",
        }),
        dimension({ id: "M3", value: "123456789012345678.123456789012", normalized_value_mm: "1" }),
      ],
      findings: [],
    });
    const outcome = interpretResponse(200, json(report), null);
    if (outcome.kind !== "report") throw new Error("expected a report");
    const values = outcome.report.measurements.map((m) => (m.kind === "dimension" ? m.value : null));
    expect(values).toEqual(["4.10", "0.0000001", "123456789012345678.123456789012"]);
    expect(values.every((v) => typeof v === "string")).toBe(true);
  });

  it("accepts ambiguous, valueless and location-less measurements without inventing data", () => {
    const report = makeReport({
      measurements: [
        ambiguousDimension({ id: "M1", value: null }),
        material({ id: "M2", value: null, status: "ambiguous", issues: ["missing_value"] }),
      ],
      findings: [],
    });
    const outcome = interpretResponse(200, json(report), null);
    if (outcome.kind !== "report") throw new Error("expected a report");
    expect(outcome.report.measurements[0]).toMatchObject({ value: null, unit: null });
    expect(outcome.report.measurements[0]?.source.bbox).toBeNull();
  });

  it("treats an omitted source bbox as unknown, never as a box", () => {
    const report = JSON.parse(json(makeReport()));
    delete report.measurements[0].source.bbox;
    const outcome = interpretResponse(200, json(report), null);
    if (outcome.kind !== "report") throw new Error("expected a report");
    expect(outcome.report.measurements[0]?.source.bbox).toBeNull();
  });

  it("ignores fields it does not know, so additive backend changes do not break it", () => {
    const report = { ...makeReport(), future_field: { anything: 1 } };
    expect(interpretResponse(200, json(report), null).kind).toBe("report");
  });

  it("only trusts a well-formed X-Request-ID header", () => {
    const body = json(makeReport());
    expect(interpretResponse(200, body, REQUEST_ID)).toMatchObject({ requestId: REQUEST_ID });
    expect(interpretResponse(200, body, "<script>")).toMatchObject({ requestId: null });
    expect(interpretResponse(200, body, null)).toMatchObject({ requestId: null });
  });
});

describe("an error response is never a result", () => {
  it("is returned as an error with the backend's code and request id", () => {
    const outcome = interpretResponse(422, json(errorBody("NO_TEXT_LAYER")), REQUEST_ID);
    expect(outcome).toEqual({
      kind: "error",
      status: 422,
      code: "NO_TEXT_LAYER",
      message: "Backend message.",
      requestId: REQUEST_ID,
    });
  });

  it.each([400, 404, 405, 408, 413, 415, 422, 500, 502, 503, 504])(
    "recognises the envelope on status %i",
    (status) => {
      expect(interpretResponse(status, json(errorBody("SOME_CODE")), null).kind).toBe("error");
    },
  );

  it("is malformed when an error body arrives with status 200", () => {
    const outcome = interpretResponse(200, json(errorBody("INVALID_PDF")), null);
    expect(outcome).toMatchObject({ kind: "malformed", problem: "an error body arrived with status 200" });
  });

  it("is malformed when a valid report arrives with an error status", () => {
    for (const status of [400, 422, 500, 502]) {
      expect(interpretResponse(status, json(makeReport()), null).kind).toBe("malformed");
    }
  });

  it.each([201, 202, 204, 301, 302, 304])("is malformed for the unexpected status %i", (status) => {
    expect(interpretResponse(status, json(makeReport()), null).kind).toBe("malformed");
    expect(interpretResponse(status, json(errorBody("X")), null).kind).toBe("malformed");
  });

  it("falls back to the header's request id when the envelope's is not usable", () => {
    const body = errorBody("SERVER_BUSY", "Busy.", "not-a-request-id");
    expect(interpretResponse(503, json(body), REQUEST_ID)).toMatchObject({ requestId: REQUEST_ID });
    expect(interpretResponse(503, json(body), null)).toMatchObject({ requestId: "" });
  });

  it("shortens a very long message", () => {
    const outcome = interpretResponse(500, json(errorBody("X", "m".repeat(5000))), null);
    expect(outcome).toMatchObject({ kind: "error" });
    expect(outcome.kind === "error" && outcome.message.length).toBe(300);
  });

  it.each([
    ["a lower-case code", { error: { code: "no_text", message: "m", request_id: "" } }],
    ["a missing message", { error: { code: "X", request_id: "" } }],
    ["a numeric code", { error: { code: 422, message: "m", request_id: "" } }],
    ["no error key", { detail: "Unprocessable" }],
    ["an array", [1, 2]],
    ["null", null],
  ])("is malformed for an error status with %s", (_label, body) => {
    expect(interpretResponse(422, json(body), null).kind).toBe("malformed");
  });
});

describe("malformed bodies", () => {
  it.each([
    ["an empty body", ""],
    ["HTML", "<html><body>Bad gateway</body></html>"],
    ["truncated JSON", '{"schema_version":"1.0","document":'],
    ["plain text", "Internal Server Error"],
  ])("rejects %s", (_label, text) => {
    for (const status of [200, 422, 502]) {
      expect(interpretResponse(status, text, null).kind).toBe("malformed");
    }
  });

  it.each([
    ["an array", "[]"],
    ["null", "null"],
    ["a string", '"ok"'],
    ["a number", "1"],
    ["an empty object", "{}"],
  ])("rejects a 200 whose body is %s", (_label, text) => {
    expect(interpretResponse(200, text, null).kind).toBe("malformed");
  });

  it("explains what was wrong without echoing the data", () => {
    const report = JSON.parse(json(makeReport()));
    report.findings = [{ ...finding("pass"), status: "totally-secret-value" }];
    const outcome = interpretResponse(200, json(report), null);
    expect(outcome.kind).toBe("malformed");
    const problem = outcome.kind === "malformed" ? outcome.problem : "";
    expect(problem).toContain("findings[0].status");
    expect(problem).not.toContain("totally-secret-value");
  });
});

type Mutate = (report: Record<string, any>) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("a report that breaks the contract is rejected", () => {
  const cases: [string, Mutate][] = [
    ["a different schema version", (r) => (r.schema_version = "2.0")],
    ["a missing document", (r) => delete r.document],
    ["a missing findings list", (r) => delete r.findings],
    ["findings that are not a list", (r) => (r.findings = {})],
    ["an unknown finding status", (r) => (r.findings[0].status = "passed")],
    ["an unknown severity", (r) => (r.findings[0].severity = "critical")],
    ["a finding id of the wrong form", (r) => (r.findings[0].id = "finding-1")],
    ["a measurement reference of the wrong form", (r) => (r.findings[0].measurement_ids = ["X1"])],
    ["a reference to a measurement that does not exist", (r) => {
      r.findings[0].measurement_ids = ["M9"];
      r.findings[0].evidence[0].measurement_id = "M9";
    }],
    ["evidence that does not match the references", (r) => (r.findings[0].evidence = [])],
    ["a quantity sent as a JSON number", (r) => (r.measurements[0].value = 4)],
    ["a quantity in exponent notation", (r) => (r.measurements[0].value = "1E-7")],
    ["a negative quantity", (r) => (r.measurements[0].value = "-4")],
    ["a decimal comma", (r) => (r.measurements[0].value = "4,5")],
    ["an unknown unit", (r) => (r.measurements[0].unit = "ft")],
    ["an unknown measurement kind", (r) => (r.measurements[0].kind = "angle")],
    ["an unknown extraction status", (r) => (r.measurements[0].status = "guessed")],
    ["an unknown extraction issue", (r) => (r.measurements[0].issues = ["mystery"])],
    ["duplicate measurement ids", (r) => r.measurements.push({ ...r.measurements[0] })],
    ["duplicate finding ids", (r) => r.findings.push({ ...r.findings[0] })],
    ["a summary that disagrees with the findings", (r) => (r.summary.passed = 5)],
    ["a negative summary count", (r) => (r.summary.failed = -1)],
    ["a fractional summary count", (r) => (r.summary.failed = 0.5)],
    ["a bounding box with swapped corners", (r) => (r.measurements[0].source.bbox.x0 = 9999)],
    ["a bounding box coordinate that is text", (r) => (r.measurements[0].source.bbox.y1 = "5")],
    ["a source page that is not in the document", (r) => (r.measurements[0].source.page_number = 2)],
    ["a page rotation of 45", (r) => (r.document.pages[0].rotation = 45)],
    ["a page_count that disagrees with the pages", (r) => (r.document.page_count = 3)],
    ["a malformed sha256", (r) => (r.document.sha256 = "xyz")],
    ["a crop box of the wrong length", (r) => (r.document.pages[0].pdf_crop_box = [0, 0, 595])],
    ["a negative skipped angled line count", (r) => (r.skipped_angled_lines = -1)],
    ["a missing skipped angled line count", (r) => delete r.skipped_angled_lines],
    ["a negative processing time", (r) => (r.processing_time_ms = -1)],
    ["an unknown extraction method", (r) => (r.measurements[0].source.extraction_method = "ocr")],
  ];

  it.each(cases)("%s", (_label, mutate) => {
    const report = JSON.parse(json(makeReport()));
    mutate(report);
    const outcome = interpretResponse(200, json(report), null);
    expect(outcome.kind).toBe("malformed");
    expect(() => readReport(report)).toThrow();
  });
});
