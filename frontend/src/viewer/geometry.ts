// Evidence coordinates, from the backend's page space to the pixels of a rendered page.
//
// Pure functions only: no PDF.js import, no DOM. The viewport transform is passed in, and
// in the app it is always PDF.js's own `viewport.transform` for the scale being drawn, so
// rotation, scale and the crop-box offset are applied by the same code that paints the
// canvas. Tests check this module against formulas derived independently from the PDF
// specification, and the browser tests check the result against the rendered pixels.
//
// Three spaces (docs/design/phase1-mvp-spec.md section 15.1):
//
//   page space     the backend's: the visible area (CropBox clipped to MediaBox) of the
//                  UNROTATED page, origin top-left, y down, PDF points. Every BBox.
//   PDF user space the file's own: origin bottom-left, y up, points. pdf_crop_box is the
//                  same visible area in this space.
//   viewport space PDF.js's: the page as displayed (rotated clockwise by /Rotate),
//                  origin top-left, y down, CSS pixels at the chosen scale.
import type { BBox, PageInfo } from "@/api/types";

/** An affine transform [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
export type Matrix = readonly [number, number, number, number, number, number];

/** A rectangle in viewport space (CSS pixels, origin top-left of the displayed page). */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** What PDF.js reports for a page: its view box (PDF user space), /Rotate and /UserUnit. */
export interface PdfPageGeometry {
  view: readonly [number, number, number, number];
  rotate: number;
  userUnit: number;
}

/**
 * How far the backend's page description may differ from PDF.js's, in points. Both read
 * the same numbers from the same file; anything beyond rounding means they disagree about
 * the page and no overlay can be trusted.
 */
export const GEOMETRY_TOLERANCE_PT = 0.01;

/** Same as the backend's PAGE_BOUNDS_TOLERANCE_PT: text may overhang the page this much. */
export const PAGE_BOUNDS_TOLERANCE_PT = 1.0;

/** Page space to PDF user space: x_pdf = crop.x0 + x, y_pdf = crop.y1 - y. */
export function pageToPdf(page: PageInfo, x: number, y: number): [number, number] {
  const [cropX0, , , cropY1] = page.pdf_crop_box;
  return [cropX0 + x, cropY1 - y];
}

export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * The rectangle a page-space box occupies on the rendered page. All four corners are
 * transformed and the result is their bounding rectangle, so the function is correct for
 * any transform, not only the axis-aligned ones PDF.js produces for /Rotate 0/90/180/270.
 */
export function boxToViewport(page: PageInfo, box: BBox, transform: Matrix): Rect {
  const corners = [
    [box.x0, box.y0],
    [box.x1, box.y0],
    [box.x0, box.y1],
    [box.x1, box.y1],
  ].map(([x, y]) => {
    const [px, py] = pageToPdf(page, x!, y!);
    return applyMatrix(transform, px, py);
  });
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

export type GeometryCheck = { ok: true } | { ok: false; problem: string };

/**
 * Do the backend and PDF.js describe the same page? Overlays are drawn only if they do:
 * same rotation, no /UserUnit scaling, and the same visible area (view box, and therefore
 * size) to within GEOMETRY_TOLERANCE_PT.
 */
export function checkPageGeometry(page: PageInfo, pdf: PdfPageGeometry): GeometryCheck {
  const rotate = ((pdf.rotate % 360) + 360) % 360;
  if (rotate !== page.rotation) {
    return {
      ok: false,
      problem: `the inspection says the page is rotated ${page.rotation}°, the PDF viewer says ${rotate}°`,
    };
  }
  if (pdf.userUnit !== 1) {
    return { ok: false, problem: "the page is scaled with /UserUnit, which is not supported" };
  }
  const names = ["left", "bottom", "right", "top"];
  for (let i = 0; i < 4; i += 1) {
    const difference = Math.abs(pdf.view[i]! - page.pdf_crop_box[i]!);
    if (!(difference <= GEOMETRY_TOLERANCE_PT)) {
      return {
        ok: false,
        problem: `the visible page area differs at its ${names[i]} edge by ${difference.toFixed(2)} pt`,
      };
    }
  }
  const width = pdf.view[2] - pdf.view[0];
  const height = pdf.view[3] - pdf.view[1];
  if (
    !(Math.abs(width - page.width_pt) <= GEOMETRY_TOLERANCE_PT) ||
    !(Math.abs(height - page.height_pt) <= GEOMETRY_TOLERANCE_PT)
  ) {
    return { ok: false, problem: "the page size differs" };
  }
  return { ok: true };
}

/** Is a page-space box a usable, non-empty rectangle lying on its page? */
export function boxProblem(page: PageInfo, box: BBox): "empty_box" | "outside_page" | null {
  const values = [box.x0, box.y0, box.x1, box.y1];
  if (!values.every(Number.isFinite) || !(box.x1 > box.x0) || !(box.y1 > box.y0)) {
    return "empty_box";
  }
  const t = PAGE_BOUNDS_TOLERANCE_PT;
  if (box.x0 < -t || box.y0 < -t || box.x1 > page.width_pt + t || box.y1 > page.height_pt + t) {
    return "outside_page";
  }
  return null;
}
