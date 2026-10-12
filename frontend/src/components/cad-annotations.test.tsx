// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { cadAnnotation, finding, makeReport } from "../../tests/ui/builders";
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
