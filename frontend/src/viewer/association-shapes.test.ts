import { describe, expect, it } from "vitest";
import type { FeatureAssociation, PageInfo } from "@/api/types";
import { associationShapes, shapesBounds } from "./association-shapes";
import type { Matrix } from "./geometry";

const page = (overrides: Partial<PageInfo> = {}): PageInfo => ({
  page_number: 1,
  width_pt: 595,
  height_pt: 842,
  rotation: 0,
  pdf_crop_box: [0, 0, 595, 842],
  ...overrides,
});

const association = (
  feature: FeatureAssociation["feature"],
  evidence: FeatureAssociation["evidence"],
): FeatureAssociation => ({
  id: "A1",
  annotation_id: "C1",
  page_number: 1,
  relation: "diameter_of_circle",
  status: "verified",
  feature_id: "G1",
  feature,
  evidence,
  candidates: 1,
  explanation: "Verified: test.",
});

// PDF.js's transform at rotation 0 and scale s: flip y, move the crop box's top-left to 0.
const unrotated = (s: number, crop: readonly number[]): Matrix => [s, 0, 0, -s, -s * crop[0]!, s * crop[3]!];

describe("association geometry in viewport pixels", () => {
  it("scales a line from page space (origin top-left, y down) for an unrotated page", () => {
    const a = association([], [{ role: "leader", shape: "line", coords: [100, 200, 160, 200] }]);
    const [shape] = associationShapes({ ...a, feature: [], evidence: a.evidence }, page(), unrotated(2, [0, 0, 595, 842]));
    expect(shape!.points).toEqual([
      [200, 400],
      [320, 400],
    ]);
    expect(shape).toMatchObject({ role: "leader", feature: false, kind: "polyline" });
  });

  it("honours the crop box offset", () => {
    const p = page({ pdf_crop_box: [50, 40, 645, 882] });
    const a = association([{ role: "extension_line", shape: "line", coords: [10, 20, 10, 80] }], []);
    const [shape] = associationShapes(a, p, unrotated(1, p.pdf_crop_box));
    expect(shape!.points).toEqual([
      [10, 20],
      [10, 80],
    ]);
    expect(shape!.feature).toBe(true);
  });

  it("puts a circle's sampled points all on the transformed circle", () => {
    const a = association([{ role: "circle", shape: "circle", coords: [200, 300, 25] }], []);
    const [shape] = associationShapes(a, page(), unrotated(2, [0, 0, 595, 842]));
    expect(shape!.kind).toBe("polygon");
    for (const [x, y] of shape!.points) expect(Math.hypot(x - 400, y - 600)).toBeCloseTo(50, 6);
  });

  it("draws an arc between its start angle and sweep only", () => {
    // Quarter arc from 0 to 90 degrees (page space, y down): from (r,0) to (0,r) about the centre.
    const a = association([{ role: "arc", shape: "arc", coords: [100, 100, 40, 0, 90] }], []);
    const [shape] = associationShapes(a, page(), unrotated(1, [0, 0, 595, 842]));
    const pts = shape!.points;
    expect(pts[0]![0]).toBeCloseTo(140, 6);
    expect(pts[0]![1]).toBeCloseTo(100, 6);
    expect(pts.at(-1)![0]).toBeCloseTo(100, 6);
    expect(pts.at(-1)![1]).toBeCloseTo(140, 6);
    expect(shape!.kind).toBe("polyline");
  });

  it("is correct under a rotated page transform (90 degrees clockwise)", () => {
    // /Rotate 90: viewport x = (y_pdf - crop.y0) * s, viewport y = (x_pdf - crop.x0) * s.
    const s = 1.5;
    const rotated: Matrix = [0, s, s, 0, 0, 0];
    const a = association([], [{ role: "dot", shape: "point", coords: [100, 50] }]);
    const [shape] = associationShapes(a, page(), rotated);
    // page (100, 50) -> pdf (100, 792) -> viewport (792 * 1.5, 100 * 1.5)
    expect(shape!.points[0]).toEqual([1188, 150]);
    expect(shape!.kind).toBe("marker");
  });

  it("returns evidence before the feature, so the feature is painted on top", () => {
    const a = association(
      [{ role: "circle", shape: "circle", coords: [50, 50, 10] }],
      [{ role: "text", shape: "box", coords: [0, 0, 10, 10] }],
    );
    const shapes = associationShapes(a, page(), unrotated(1, [0, 0, 595, 842]));
    expect(shapes.map((s) => s.feature)).toEqual([false, true]);
  });

  it("has bounds around everything, and none for nothing", () => {
    const a = association([{ role: "extension_line", shape: "line", coords: [10, 20, 30, 80] }], []);
    const shapes = associationShapes(a, page(), unrotated(1, [0, 0, 595, 842]));
    expect(shapesBounds(shapes)).toEqual({ left: 10, top: 20, right: 30, bottom: 80 });
    expect(shapesBounds([])).toBeNull();
  });
});
