import { describe, expect, it } from "vitest";
import type { PageInfo } from "@/api/types";
import {
  applyMatrix,
  boxProblem,
  boxToViewport,
  checkPageGeometry,
  pageToPdf,
  type Matrix,
} from "./geometry";

const page = (overrides: Partial<PageInfo> = {}): PageInfo => ({
  page_number: 1,
  width_pt: 595,
  height_pt: 842,
  rotation: 0,
  pdf_crop_box: [0, 0, 595, 842],
  ...overrides,
});

describe("page space to PDF user space", () => {
  it("flips y about the top of the crop box and shifts by its left edge", () => {
    const p = page({ pdf_crop_box: [50, 40, 645, 882] });
    expect(pageToPdf(p, 0, 0)).toEqual([50, 882]); // top-left of the visible area
    expect(pageToPdf(p, 595, 842)).toEqual([645, 40]); // bottom-right
    expect(pageToPdf(p, 72, 100)).toEqual([122, 782]);
  });

  it("works with a crop box whose origin is negative", () => {
    const p = page({ pdf_crop_box: [-300, -200, 295, 642] });
    expect(pageToPdf(p, 0, 0)).toEqual([-300, 642]);
    expect(pageToPdf(p, 595, 842)).toEqual([295, -200]);
  });
});

describe("applying a transform", () => {
  it("uses the PDF/PDF.js convention x' = a x + c y + e, y' = b x + d y + f", () => {
    const m: Matrix = [2, 3, 5, 7, 11, 13];
    expect(applyMatrix(m, 1, 0)).toEqual([2 + 11, 3 + 13]);
    expect(applyMatrix(m, 0, 1)).toEqual([5 + 11, 7 + 13]);
  });
});

describe("box to viewport", () => {
  // At rotation 0 and scale s, PDF.js's transform is [s, 0, 0, -s, -s * cropX0, s * cropY1]:
  // flip y and move the crop box's top-left to the origin. Written out here by hand.
  const unrotated = (s: number, crop: readonly number[]): Matrix => [s, 0, 0, -s, -s * crop[0]!, s * crop[3]!];

  it("is the page-space box scaled, for an unrotated page", () => {
    const p = page({ pdf_crop_box: [50, 40, 645, 882] });
    const box = { x0: 72, y0: 100, x1: 160, y1: 110 };
    expect(boxToViewport(p, box, unrotated(2, p.pdf_crop_box))).toEqual({
      left: 144,
      top: 200,
      width: 176,
      height: 20,
    });
  });

  it("returns a normalised rectangle whatever the transform's orientation", () => {
    // A 90 degree turn swaps axes; the result must still have positive width and height.
    const turn: Matrix = [0, 1, 1, 0, 0, 0];
    const rect = boxToViewport(page(), { x0: 10, y0: 20, x1: 30, y1: 25 }, turn);
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
    expect(rect).toEqual({ left: 817, top: 10, width: 5, height: 20 });
  });

  it("covers all four corners under a non-axis-aligned transform", () => {
    const shear: Matrix = [1, 0, 0.5, 1, 0, 0];
    const rect = boxToViewport(page({ pdf_crop_box: [0, 0, 595, 842] }), { x0: 0, y0: 832, x1: 10, y1: 842 }, shear);
    // PDF corners (0,0)-(10,10); shear moves the top edge right by 5.
    expect(rect).toEqual({ left: 0, top: 0, width: 15, height: 10 });
  });
});

describe("checking the backend's page against PDF.js's", () => {
  const pdf = (overrides = {}) => ({ view: [0, 0, 595, 842] as const, rotate: 0, userUnit: 1, ...overrides });

  it("accepts the same page", () => {
    expect(checkPageGeometry(page(), pdf())).toEqual({ ok: true });
    expect(
      checkPageGeometry(
        page({ rotation: 270, pdf_crop_box: [50, 40, 645, 882] }),
        pdf({ view: [50, 40, 645, 882], rotate: 270 }),
      ),
    ).toEqual({ ok: true });
  });

  it("treats a rotation of -90 or 450 as 270 or 90, as PDF does", () => {
    expect(checkPageGeometry(page({ rotation: 270 }), pdf({ rotate: -90 })).ok).toBe(true);
    expect(checkPageGeometry(page({ rotation: 90 }), pdf({ rotate: 450 })).ok).toBe(true);
  });

  it("accepts differences within 0.01 pt", () => {
    expect(checkPageGeometry(page(), pdf({ view: [0.005, 0, 595.004, 842] })).ok).toBe(true);
  });

  it.each([
    ["a different rotation", pdf({ rotate: 90 }), /rotated 0.*says 90/],
    ["a UserUnit", pdf({ userUnit: 2 }), /UserUnit/],
    ["a crop offset the backend does not have", pdf({ view: [50, 40, 645, 882] }), /left edge/],
    ["a page 0.02 pt wider", pdf({ view: [0, 0, 595.02, 842] }), /right edge/],
    ["a NaN in the view box", pdf({ view: [0, Number.NaN, 595, 842] }), /bottom edge/],
  ])("refuses %s", (_label, geometry, problem) => {
    const result = checkPageGeometry(page(), geometry);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.problem).toMatch(problem);
  });

  it("refuses a backend page whose size disagrees with its own crop box", () => {
    expect(checkPageGeometry(page({ width_pt: 600 }), pdf()).ok).toBe(false);
  });
});

describe("boxes that cannot be drawn", () => {
  it.each([
    [{ x0: 10, y0: 10, x1: 10, y1: 20 }, "empty_box"],
    [{ x0: 10, y0: 10, x1: 20, y1: 10 }, "empty_box"],
    [{ x0: 20, y0: 10, x1: 10, y1: 20 }, "empty_box"],
    [{ x0: Number.NaN, y0: 10, x1: 20, y1: 20 }, "empty_box"],
    [{ x0: -1.5, y0: 10, x1: 20, y1: 20 }, "outside_page"],
    [{ x0: 10, y0: 10, x1: 596.5, y1: 20 }, "outside_page"],
    [{ x0: 10, y0: 835, x1: 20, y1: 843.5 }, "outside_page"],
    [{ x0: 10, y0: -2, x1: 20, y1: 5 }, "outside_page"],
  ])("%j is %s", (box, problem) => {
    expect(boxProblem(page(), box)).toBe(problem);
  });

  it.each([
    [{ x0: 0, y0: 0, x1: 595, y1: 842 }],
    [{ x0: -1, y0: -1, x1: 596, y1: 843 }], // the backend's 1 pt overhang allowance
    [{ x0: 590, y0: 830, x1: 595, y1: 842 }],
  ])("%j is drawable", (box) => {
    expect(boxProblem(page(), box)).toBeNull();
  });
});
