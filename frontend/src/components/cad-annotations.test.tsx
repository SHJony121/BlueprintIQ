// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { cadAnnotation, finding, makeReport, material } from "../../tests/ui/builders";
import { interpretResponse, readReport } from "@/api/read-response";
import { ReportView } from "./report-view";

const NOTE = {
  page_number: 1,
  bbox: null,
  raw_text: "All dimensions are in millimeter",
  extraction_method: "pdf_text_layer" as const,
};

describe("the CAD annotations section", () => {
  const annotations = [
    cadAnnotation("C1", "2.7 ±0.1"),
    cadAnnotation("C2", "3.7 +0/-0.2", {
      nominal: "3.7",
      upper_deviation: "0",
      lower_deviation: "-0.2",
    }),
    cadAnnotation("C3", "Ø12", {
      dimension_kind: "diameter",
      nominal: "12",
      upper_deviation: null,
      lower_deviation: null,
    }),
    cadAnnotation("C4", "75° ±0.5°", {
      dimension_kind: "angle",
      nominal: "75",
      upper_deviation: "0.5",
      lower_deviation: "-0.5",
      unit: "deg",
      unit_source: "symbol",
    }),
    cadAnnotation("C5", "+0", {
      dimension_kind: null,
      nominal: null,
      upper_deviation: null,
      lower_deviation: null,
      unit: null,
      unit_source: "none",
      status: "ambiguous",
      issues: ["unsupported_syntax"],
    }),
  ];

  function show() {
    render(
      <ReportView
        report={makeReport({
          findings: [finding("pass")],
          overrides: { cad_annotations: annotations, cad_unit_note: NOTE },
        })}
      />,
    );
    return screen.getByTestId("cad-annotations");
  }

  it("shows the original text, the reading and the unit source of each annotation", () => {
    const section = within(show());
    expect(
      section.getByRole("heading", { name: /CAD annotations \(5\)/ }),
    ).toBeTruthy();
    expect(section.getByText("“2.7 ±0.1”")).toBeTruthy();
    const reading = (text: RegExp) =>
      section.getAllByText(
        (_, el) => el?.tagName === "P" && text.test(el.textContent ?? ""),
      );
    expect(reading(/^2\.7.mm ±0\.1/)).toHaveLength(1);
    expect(reading(/^3\.7.mm \+0 \/ -0\.2/)).toHaveLength(1);
    expect(
      section.getAllByText(/unit from the drawing note/).length,
    ).toBeGreaterThan(0);
    expect(section.getByText(/Unit note on the drawing/).textContent).toMatch(
      /All dimensions are in millimeter/,
    );
  });

  it("marks an uncertain annotation and shows no value for it", () => {
    const section = within(show());
    const item = section.getByText("“+0”").closest("li")!;
    expect(item.textContent).toMatch(/Not understood/);
    expect(item.textContent).toMatch(/No value read/);
    expect(item.textContent).toMatch(/not a supported format/);
  });

  it("says plainly that nothing here is checked, and adds no finding", () => {
    show();
    expect(screen.getByTestId("cad-annotations").textContent).toMatch(
      /never produce a pass or fail/,
    );
    expect(
      screen.getByRole("heading", { name: /^Findings \(1\)/ }),
    ).toBeTruthy();
    expect(screen.getByTestId("summary-pass").textContent).toMatch(/1/);
  });

  it("is absent when no CAD annotation was read", () => {
    render(<ReportView report={makeReport()} />);
    expect(screen.queryByTestId("cad-annotations")).toBeNull();
  });
});

type Mutable = { cad_annotations: Record<string, unknown>[] } & Record<string, unknown>;

describe("reading CAD annotations from a response", () => {
  const body = (mutate: (r: Mutable) => void) => {
    const report = JSON.parse(
      JSON.stringify(
        makeReport({
          overrides: { cad_annotations: [cadAnnotation("C1", "2.7 ±0.1")] },
        }),
      ),
    );
    mutate(report);
    return report;
  };

  it("accepts a well-formed annotation and keeps decimals as text", () => {
    const report = readReport(body(() => {}));
    expect(report.cad_annotations[0]!.lower_deviation).toBe("-0.1");
    expect(typeof report.cad_annotations[0]!.nominal).toBe("string");
  });

  it.each([
    ["a numeric nominal", (r: Mutable) => (r.cad_annotations[0]!.nominal = 2.7)],
    [
      "an exponent in a deviation",
      (r: Mutable) => (r.cad_annotations[0]!.upper_deviation = "1e-1"),
    ],
    [
      "an association with a feature",
      (r: Mutable) => (r.cad_annotations[0]!.association = "thickness"),
    ],
    [
      "an unknown kind",
      (r: Mutable) => (r.cad_annotations[0]!.dimension_kind = "thread"),
    ],
    ["a bad id", (r: Mutable) => (r.cad_annotations[0]!.id = "M1")],
    ["a missing list", (r: Mutable) => delete (r as Partial<Mutable>).cad_annotations],
  ])("rejects %s", (_label, mutate) => {
    expect(
      interpretResponse(200, JSON.stringify(body(mutate)), null).kind,
    ).toBe("malformed");
  });
});

describe("a material read from a separate label line", () => {
  const associated = () =>
    material({
      value: "POM C NOIR",
      source: {
        page_number: 1,
        bbox: { x0: 311.7, y0: 611.1, x1: 365.7, y1: 624.8 },
        raw_text: "POM C noir",
        extraction_method: "pdf_text_layer_row_association",
      },
      label_source: {
        page_number: 1,
        bbox: { x0: 276.6, y0: 614.9, x1: 301.8, y1: 623.1 },
        raw_text: "Matière :",
        extraction_method: "pdf_text_layer",
      },
    });

  it("shows the label and the value as the two separate lines they are", () => {
    render(<ReportView report={makeReport({ measurements: [associated()], findings: [] })} />);
    const item = document.getElementById("measurement-M4")!;
    expect(item.textContent).toMatch(/Label \(separate line\)/);
    expect(item.textContent).toMatch(/“Matière :”/);
    expect(item.textContent).toMatch(/Value \(same row, to the right\)/);
    expect(item.textContent).toMatch(/“POM C noir”/);
    expect(item.textContent).not.toMatch(/Matière : POM/); // no joined line is shown
  });

  it("is accepted by the response reader, which needs the label with the method", () => {
    const body = (mutate: (m: Record<string, unknown>) => void) => {
      const report = JSON.parse(JSON.stringify(makeReport({ measurements: [associated()], findings: [] })));
      mutate(report.measurements[0]);
      return JSON.stringify(report);
    };
    expect(interpretResponse(200, body(() => {}), null).kind).toBe("report");
    expect(interpretResponse(200, body((m) => delete m.label_source), null).kind).toBe("malformed");
    expect(
      interpretResponse(200, body((m) => ((m.source as Record<string, unknown>).extraction_method = "pdf_text_layer")), null).kind,
    ).toBe("malformed");
  });
});
