// The geometry module with PDF.js's REAL viewport transforms, on every committed fixture.
//
// Inputs that do not come from this app's code:
//   * the PDFs and their ground truth (backend/tests/fixtures: a hand-written PDF writer and
//     boxes computed from Adobe font metrics, never by running extraction);
//   * PDF.js 6.4.299 itself, which parses each file and builds each viewport (Node build).
// The expected rectangles are computed with `reference` below, which is derived from the
// definition of /Rotate (turn the page clockwise for display), not from PDF.js and not
// from geometry.ts. If either PDF.js's transform or geometry.ts's use of it were wrong for
// any rotation, crop offset or scale, the two would disagree.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BBox, PageInfo } from "@/api/types";
import { boxToViewport, checkPageGeometry, type Matrix, type Rect } from "./geometry";

const FIXTURES = path.resolve(import.meta.dirname, "../../../backend/tests/fixtures");
const PDFJS = path.resolve(import.meta.dirname, "../../node_modules/pdfjs-dist/legacy/build");

interface GroundTruth {
  name: string;
  error?: string;
  page?: Omit<PageInfo, "page_number">;
  lines?: { text: string; ink_box: [number, number, number, number] }[];
}

const truths: GroundTruth[] = readdirSync(path.join(FIXTURES, "expected"))
  .filter((file) => file.endsWith(".json"))
  .map((file) => JSON.parse(readFileSync(path.join(FIXTURES, "expected", file), "utf8")) as GroundTruth);

const valid = truths.filter((t) => t.error === undefined && t.page !== undefined && (t.lines?.length ?? 0) > 0);

/**
 * Where a page-space point appears on the displayed page, in points, derived from the
 * meaning of /Rotate: the viewer turns the unrotated page clockwise. For 90 degrees the
 * unrotated page's left edge becomes the top edge, so its top-left corner (0, 0) ends up
 * at the top-right (H, 0) and its bottom-left (0, H) at the top-left (0, 0): (H - y, x).
 * 180 and 270 follow the same way.
 */
function displayed(page: PageInfo, x: number, y: number): [number, number] {
  const w = page.width_pt;
  const h = page.height_pt;
  switch (page.rotation) {
    case 0:
      return [x, y];
    case 90:
      return [h - y, x];
    case 180:
      return [w - x, h - y];
    case 270:
      return [y, w - x];
  }
}

function reference(page: PageInfo, box: BBox, scale: number): Rect {
  const a = displayed(page, box.x0, box.y0);
  const b = displayed(page, box.x1, box.y1);
  return {
    left: Math.min(a[0], b[0]) * scale,
    top: Math.min(a[1], b[1]) * scale,
    width: Math.abs(a[0] - b[0]) * scale,
    height: Math.abs(a[1] - b[1]) * scale,
  };
}

type PdfJs = typeof import("pdfjs-dist");
let pdfjs: PdfJs;

interface LoadedPage {
  view: number[];
  rotate: number;
  userUnit: number;
  viewport: (scale: number) => { width: number; height: number; transform: Matrix };
}
const loaded = new Map<string, LoadedPage>();
const tasks: { destroy(): Promise<void> }[] = [];

async function load(name: string): Promise<LoadedPage> {
  const data = new Uint8Array(readFileSync(path.join(FIXTURES, "drawings", `${name}.pdf`)));
  const task = pdfjs.getDocument({ data, verbosity: 0 });
  tasks.push(task);
  const doc = await task.promise;
  const page = await doc.getPage(1);
  return {
    view: page.view,
    rotate: page.rotate,
    userUnit: page.userUnit,
    viewport: (scale) => {
      const v = page.getViewport({ scale });
      return { width: v.width, height: v.height, transform: v.transform as unknown as Matrix };
    },
  };
}

beforeAll(async () => {
  pdfjs = (await import(pathToFileURL(path.join(PDFJS, "pdf.mjs")).href)) as PdfJs;
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(PDFJS, "pdf.worker.mjs")).href;
  for (const name of [...valid.map((t) => t.name), "rotate_135", "user_unit"]) {
    loaded.set(name, await load(name));
  }
}, 60_000);

afterAll(async () => {
  await Promise.all(tasks.map((task) => task.destroy()));
});

const SCALES = [0.25, 0.5, 1, 4 / 3, 1.7321, 2, 3.5];
const EPSILON = 1e-6; // pixels; the two sides differ only by floating-point rounding

describe("every valid fixture, through PDF.js", () => {
  it("covers all four rotations, a crop offset and an inherited crop box", () => {
    expect(valid.length).toBe(22);
    const rotations = new Set(valid.map((t) => t.page!.rotation));
    expect([...rotations].sort((a, b) => a - b)).toEqual([0, 90, 180, 270]);
    expect(valid.some((t) => t.page!.pdf_crop_box[0] !== 0 && t.page!.rotation !== 0)).toBe(true);
    expect(valid.map((t) => t.name)).toContain("inherited_crop_rotated_270");
  });

  describe.each(valid.map((t) => [t.name, t] as const))("%s", (_name, truth) => {
    const page: PageInfo = { page_number: 1, ...truth.page! };

    it("describes the same page in the backend's terms and PDF.js's", () => {
      const pdf = loaded.get(truth.name)!;
      expect(pdf.view).toEqual([...page.pdf_crop_box]);
      expect(pdf.rotate).toBe(page.rotation);
      expect(checkPageGeometry(page, { view: pdf.view as [number, number, number, number], rotate: pdf.rotate, userUnit: pdf.userUnit })).toEqual({ ok: true });
    });

    it.each(SCALES)("places every ground-truth box exactly at scale %d", (scale) => {
      const viewport = loaded.get(truth.name)!.viewport(scale);
      const [w, h] = page.rotation % 180 === 0 ? [page.width_pt, page.height_pt] : [page.height_pt, page.width_pt];
      expect(viewport.width).toBeCloseTo(w * scale, 9);
      expect(viewport.height).toBeCloseTo(h * scale, 9);
      for (const line of truth.lines!) {
        const [x0, y0, x1, y1] = line.ink_box;
        const box = { x0, y0, x1, y1 };
        const actual = boxToViewport(page, box, viewport.transform);
        const expected = reference(page, box, scale);
        for (const key of ["left", "top", "width", "height"] as const) {
          expect(Math.abs(actual[key] - expected[key]), `${line.text} ${key}`).toBeLessThan(EPSILON);
        }
        // and every box is on the rendered page
        expect(actual.left).toBeGreaterThanOrEqual(-EPSILON);
        expect(actual.top).toBeGreaterThanOrEqual(-EPSILON);
        expect(actual.left + actual.width).toBeLessThanOrEqual(viewport.width + EPSILON);
        expect(actual.top + actual.height).toBeLessThanOrEqual(viewport.height + EPSILON);
      }
    });
  });

  it("would notice a crop offset applied to the wrong axis on a rotated page", () => {
    // Sensitivity check: the mistake section 15.1 records (PyMuPDF's matrix dropping the
    // crop offset on rotated pages) shifts every box by the offset; this comparison sees it.
    const truth = valid.find((t) => t.name === "cropped_rotated_90")!;
    const page: PageInfo = { page_number: 1, ...truth.page! };
    const wrong: PageInfo = { ...page, pdf_crop_box: [0, 0, page.width_pt, page.height_pt] };
    const viewport = loaded.get(truth.name)!.viewport(1);
    const [x0, y0, x1, y1] = truth.lines![0]!.ink_box;
    const box = { x0, y0, x1, y1 };
    const misplaced = boxToViewport(wrong, box, viewport.transform);
    const expected = reference(page, box, 1);
    expect(Math.abs(misplaced.left - expected.left) + Math.abs(misplaced.top - expected.top)).toBeGreaterThan(30);
  });
});

describe("pages the backend refuses", () => {
  it("PDF.js reports /Rotate 135 as 0, so the backend's refusal is what protects it", () => {
    // Recorded so a change in PDF.js's behaviour is noticed. The backend refuses this file
    // (UNSUPPORTED_GEOMETRY), so no report with evidence for it can exist.
    expect(loaded.get("rotate_135")!.rotate).toBe(0);
  });

  it("a /UserUnit page fails the geometry check, so no evidence would be drawn on it", () => {
    const pdf = loaded.get("user_unit")!;
    expect(pdf.userUnit).not.toBe(1);
    const page: PageInfo = {
      page_number: 1,
      width_pt: pdf.view[2]! - pdf.view[0]!,
      height_pt: pdf.view[3]! - pdf.view[1]!,
      rotation: 0,
      pdf_crop_box: pdf.view as [number, number, number, number],
    };
    expect(checkPageGeometry(page, { view: page.pdf_crop_box, rotate: pdf.rotate, userUnit: pdf.userUnit }).ok).toBe(false);
  });
});
