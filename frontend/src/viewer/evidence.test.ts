import { describe, expect, it } from "vitest";
import {
  allOutcomesReport,
  box,
  dimension,
  finding,
  makeReport,
  source,
} from "../../tests/ui/builders";
import { buildViewerEvidence } from "./evidence";

describe("evidence the viewer may draw", () => {
  it("takes identity and pages from the report", () => {
    const report = makeReport();
    const evidence = buildViewerEvidence(report);
    expect(evidence.documentSha256).toBe(report.document.sha256);
    expect(evidence.documentSizeBytes).toBe(report.document.size_bytes);
    expect(evidence.pages).toBe(report.document.pages);
  });

  it("draws located evidence and lists a missing finding as unplaced", () => {
    const evidence = buildViewerEvidence(allOutcomesReport());
    // M1 and M3 have boxes; M2 (ambiguous) has none; F2 (missing) has no evidence.
    expect(evidence.items.map((i) => i.key)).toEqual(["F1:M1", "F4:M3"]);
    expect(evidence.items.map((i) => i.status)).toEqual(["pass", "fail"]);
    expect(evidence.unplaced).toEqual([
      { findingId: "F2", measurementId: null, status: "missing", reason: "no_measurement" },
      { findingId: "F3", measurementId: "M2", status: "needs_review", reason: "no_location" },
    ]);
  });

  it("gives each box of a multi-measurement finding its own item", () => {
    const report = makeReport({
      measurements: [
        dimension({ id: "M1" }),
        dimension({ id: "M2", source: source("THICKNESS: 5 mm", { bbox: box({ y0: 569.3, y1: 583 }) }) }),
      ],
      findings: [
        finding("needs_review", {
          measurement_ids: ["M1", "M2"],
          evidence: [
            { measurement_id: "M1", page_number: 1, bbox: box() },
            { measurement_id: "M2", page_number: 1, bbox: box({ y0: 569.3, y1: 583 }) },
          ],
        }),
      ],
    });
    const items = buildViewerEvidence(report).items;
    expect(items.map((i) => i.key)).toEqual(["F1:M1", "F1:M2"]);
    expect(items[1]!.bbox).toEqual(box({ y0: 569.3, y1: 583 }));
  });

  it("describes each box in words, not only colour", () => {
    const [item] = buildViewerEvidence(allOutcomesReport()).items.filter((i) => i.status === "fail");
    expect(item!.description).toBe("Fail: DIA-MAX-001, finding F4, measurement M3");
  });

  it("refuses evidence that disagrees with its measurement", () => {
    const report = makeReport();
    report.findings[0]!.evidence[0]!.bbox = box({ x0: 10 }); // the measurement still says 72
    const evidence = buildViewerEvidence(report);
    expect(evidence.items).toEqual([]);
    expect(evidence.unplaced).toEqual([
      { findingId: "F1", measurementId: "M1", status: "pass", reason: "inconsistent" },
    ]);
  });

  it("refuses evidence on a different page from its measurement", () => {
    const report = makeReport();
    report.findings[0]!.evidence[0]!.page_number = 2;
    expect(buildViewerEvidence(report).unplaced[0]!.reason).toBe("inconsistent");
  });

  it("refuses evidence on a page the document does not have", () => {
    const report = makeReport({
      measurements: [dimension({ source: source("THICKNESS: 4 mm", { page_number: 2 }) })],
      findings: [finding("pass", { evidence: [{ measurement_id: "M1", page_number: 2, bbox: box() }] })],
    });
    expect(buildViewerEvidence(report).unplaced[0]!.reason).toBe("page_missing");
  });

  it.each([
    ["an empty box", { x0: 72, y0: 549.3, x1: 72, y1: 563 }, "empty_box"],
    ["a box off the page", { x0: 600, y0: 549.3, x1: 650, y1: 563 }, "outside_page"],
  ])("refuses %s", (_label, bad, reason) => {
    const report = makeReport({
      measurements: [dimension({ source: source("THICKNESS: 4 mm", { bbox: bad }) })],
      findings: [finding("pass", { evidence: [{ measurement_id: "M1", page_number: 1, bbox: bad }] })],
    });
    const evidence = buildViewerEvidence(report);
    expect(evidence.items).toEqual([]);
    expect(evidence.unplaced[0]!.reason).toBe(reason);
  });

  it("accepts a box that overhangs the page edge by up to 1 pt, as the backend does", () => {
    const edge = { x0: -0.8, y0: 0, x1: 80, y1: 9 };
    const report = makeReport({
      measurements: [dimension({ source: source("THICKNESS: 4 mm", { bbox: edge }) })],
      findings: [finding("pass", { evidence: [{ measurement_id: "M1", page_number: 1, bbox: edge }] })],
    });
    expect(buildViewerEvidence(report).items).toHaveLength(1);
  });

  it("does not change the report it reads", () => {
    const report = allOutcomesReport();
    const before = JSON.stringify(report);
    buildViewerEvidence(report);
    expect(JSON.stringify(report)).toBe(before);
  });
});
