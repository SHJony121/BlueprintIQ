// Measuring overlay alignment in a real browser, from rendered pixels.
//
// For each evidence box the test reads two things, both from the live page:
//   overlay  the box element's position (getBoundingClientRect), relative to the canvas;
//   ink      where PDF.js actually painted dark pixels, read back from the canvas
//            (getImageData), in and around the box.
// Neither comes from the geometry code under test: the overlay is the browser's own layout
// of what the app drew, and the ink is what PDF.js rendered. If the mapping put a box in the
// wrong place, its ink would be missing, outside it, or far from its edges.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

export interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MeasuredBox {
  key: string;
  overlay: Edges;
  ink: Edges | null;
}

export interface Measurement {
  scale: number;
  cssWidth: number;
  cssHeight: number;
  pixelWidth: number;
  pixelHeight: number;
  boxes: MeasuredBox[];
}

/** Wait until the newest requested render has finished and been put on the canvas. */
export async function waitForDrawn(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const stage = document.querySelector<HTMLElement>("[data-testid=page-stage]");
      return (
        stage !== null &&
        stage.dataset.renderStatus === "ready" &&
        stage.dataset.renderKey === stage.dataset.drawnKey
      );
    },
    undefined,
    { timeout: 30_000 },
  );
}

/**
 * Overlay and ink for every evidence box. Ink is searched in the box expanded by
 * `searchPt` points on every side, so ink that the box misses is still found.
 */
export async function measure(page: Page, searchPt: number): Promise<Measurement> {
  return page.evaluate((searchPt) => {
    const stage = document.querySelector<HTMLElement>("[data-testid=page-stage]")!;
    const canvas = stage.querySelector("canvas")!;
    const scale = Number(stage.dataset.layoutScale);
    const frame = canvas.getBoundingClientRect();
    const kx = canvas.width / frame.width; // backing pixels per CSS pixel
    const ky = canvas.height / frame.height;
    const context = canvas.getContext("2d")!;
    const search = searchPt * scale;
    const boxes = [...stage.querySelectorAll<HTMLElement>("[data-evidence-key]")].map((element) => {
      const r = element.getBoundingClientRect();
      const overlay = {
        left: r.left - frame.left,
        top: r.top - frame.top,
        right: r.right - frame.left,
        bottom: r.bottom - frame.top,
      };
      const x0 = Math.max(0, Math.floor((overlay.left - search) * kx));
      const y0 = Math.max(0, Math.floor((overlay.top - search) * ky));
      const x1 = Math.min(canvas.width, Math.ceil((overlay.right + search) * kx));
      const y1 = Math.min(canvas.height, Math.ceil((overlay.bottom + search) * ky));
      const width = x1 - x0;
      const pixels = context.getImageData(x0, y0, width, y1 - y0).data;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let y = 0; y < y1 - y0; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const i = (y * width + x) * 4;
          const luminance = (pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3;
          if (pixels[i + 3]! > 0 && luminance < 160) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      const ink =
        minX === Infinity
          ? null
          : { left: (x0 + minX) / kx, top: (y0 + minY) / ky, right: (x0 + maxX + 1) / kx, bottom: (y0 + maxY + 1) / ky };
      return { key: element.dataset.evidenceKey!, overlay, ink };
    });
    return {
      scale,
      cssWidth: frame.width,
      cssHeight: frame.height,
      pixelWidth: canvas.width,
      pixelHeight: canvas.height,
      boxes,
    };
  }, searchPt);
}

export type Axis = "x" | "y";
export type Side = "left" | "top" | "right" | "bottom";
const SIDES: readonly Side[] = ["left", "top", "right", "bottom"];
const OPPOSITE: Record<Side, Side> = { left: "right", right: "left", top: "bottom", bottom: "top" };

/** The writing direction on screen: page-space x stays x at 0 and 180 degrees, becomes y at 90 and 270. */
export function displayedAxis(pageAxis: Axis, rotation: number): Axis {
  if (rotation % 180 === 0) return pageAxis;
  return pageAxis === "x" ? "y" : "x";
}

/**
 * How much empty box (positive) or ink outside the box (negative) there is on each side,
 * in CSS pixels. Null when no ink was found near the box at all.
 */
export function sideGaps(box: MeasuredBox): Record<Side, number> | null {
  if (box.ink === null) return null;
  const o = box.overlay;
  const i = box.ink;
  return { left: i.left - o.left, top: i.top - o.top, right: o.right - i.right, bottom: o.bottom - i.bottom };
}

/** Allowed values for those gaps, in CSS pixels. */
export interface Limits {
  /** Ink may extend this far past any edge (anti-aliasing, glyph overshoot). */
  contain: number;
  /** The box may extend this far beyond the ink on each side. */
  maxGap: Record<Side, number>;
}

/**
 * Limits from font metrics, plus PIXEL_SLACK everywhere for anti-aliasing and pixel
 * rounding (em is the font size at the current scale, in CSS pixels):
 *
 * ground truth (the AFM ink box: ascender 0.718 em above the baseline, descender 0.207 em
 * below; PDF.js draws Helvetica with Liberation Sans, which has the same advance widths):
 *   along the text   slack + 0.12 em   glyph side bearings are under 0.1 em
 *   up (ascender)    slack + 0.08 em   capitals reach the ascender
 *   down (descender) slack + 0.30 em   no descenders in the fixtures' text: 0.207 em of room
 *   ink outside      slack + 0.03 em
 *
 * backend boxes (PyMuPDF line boxes; the backend's contract in
 * backend/tests/integration/fixture_data.py: they contain the AFM box within 0.5 pt and
 * exceed it by at most 1.0 pt along the text and 0.5 em across it):
 *   along the text   slack + 0.12 em + 1.0 pt
 *   across (either)  slack + 0.80 em
 *   ink outside      slack + 0.03 em + 0.5 pt
 *
 * Pixel measurement is only meaningful while glyphs are legible: the tests measure at
 * scales where 10 pt text is at least 8 CSS px tall. Below that, anti-aliased strokes fall
 * under the ink threshold and the measured ink shrinks. (Scale itself is verified at
 * 0.25x and 0.5x by src/viewer/geometry.pdfjs.test.ts, without pixels.)
 */
export const PIXEL_SLACK = 1.5;

export function limits(
  kind: "ground-truth" | "backend",
  fontSizePt: number,
  scale: number,
  axis: Axis,
  up: Side | null,
): Limits {
  const em = fontSizePt * scale;
  const px = PIXEL_SLACK;
  const along = kind === "ground-truth" ? px + 0.12 * em : px + 0.12 * em + 1.0 * scale;
  const loose = kind === "ground-truth" ? px + 0.3 * em : px + 0.8 * em;
  const maxGap: Record<Side, number> =
    axis === "x"
      ? { left: along, right: along, top: loose, bottom: loose }
      : { top: along, bottom: along, left: loose, right: loose };
  if (kind === "ground-truth" && up !== null && maxGap[up] === loose) {
    maxGap[up] = px + 0.08 * em;
    maxGap[OPPOSITE[up]] = px + 0.3 * em;
  }
  const contain = kind === "ground-truth" ? px + 0.03 * em : px + 0.03 * em + 0.5 * scale;
  return { contain, maxGap };
}

/** Everything wrong with one box; empty when it marks its text within the limits. */
export function problems(box: MeasuredBox, lim: Limits): string[] {
  const gaps = sideGaps(box);
  if (gaps === null) return [`${box.key}: no ink in or near the box`];
  const out: string[] = [];
  for (const side of SIDES) {
    const gap = gaps[side];
    if (gap < -lim.contain) out.push(`${box.key}: ink extends ${(-gap).toFixed(2)} px past the ${side} edge`);
    if (gap > lim.maxGap[side]) {
      out.push(`${box.key}: ${gap.toFixed(2)} px of empty box at the ${side} edge (max ${lim.maxGap[side].toFixed(2)})`);
    }
  }
  return out;
}

/** The same box moved by (dx, dy) CSS pixels: a deliberately wrong placement. */
export function shifted(box: MeasuredBox, dx: number, dy: number): MeasuredBox {
  const o = box.overlay;
  return { ...box, overlay: { left: o.left + dx, right: o.right + dx, top: o.top + dy, bottom: o.bottom + dy } };
}

// ----------------------------------------------------------------- fixtures

export interface TruthLine {
  text: string;
  ink_box: [number, number, number, number];
  font_size: number;
  advance_axis: Axis;
}

export interface Truth {
  name: string;
  file: string;
  page: { width_pt: number; height_pt: number; rotation: 0 | 90 | 180 | 270; pdf_crop_box: [number, number, number, number] };
  lines: TruthLine[];
  backendAccepts: boolean;
}

const FRONTEND = process.cwd();
const COMMITTED = path.resolve(FRONTEND, "../backend/tests/fixtures");
export const GENERATED = path.join(FRONTEND, "test-results", "geometry-fixtures");

/** Names of the generated cases (tests/e2e/geometry_fixtures.py), checked against the files. */
export const GENERATED_NAMES = [
  "edges_r0",
  "edges_r90",
  "edges_r180",
  "edges_r270",
  "edges_tight_r0",
  "edges_tight_r90",
  "edges_tight_r180",
  "edges_tight_r270",
  "offset_crop_r180",
  "negative_origin_inherited_r270",
  "landscape_r90",
  "multi_box_r0",
];

/** The 22 committed fixtures the backend accepts, with their hand-written ground truth. */
export const COMMITTED_NAMES = [
  "ambiguous",
  "boundary_values",
  "clipped_text",
  "conflicting",
  "crop_beyond_media",
  "cropped",
  "cropped_rotated_90",
  "inherited_crop_rotated_270",
  "invisible_text",
  "merged_adjacent",
  "merged_title_block",
  "missing_material",
  "no_annotations",
  "rotated_180",
  "rotated_270",
  "rotated_90",
  "rotated_90_sideways",
  "split_spans",
  "unit_conversion",
  "valid_basic",
  "violations",
  "wide_gaps",
];

export function committedTruth(name: string): Truth {
  const data = JSON.parse(readFileSync(path.join(COMMITTED, "expected", `${name}.json`), "utf8"));
  return { ...data, name, file: path.join(COMMITTED, "drawings", `${name}.pdf`), backendAccepts: true };
}

export function generatedTruth(name: string): Truth {
  const data = JSON.parse(readFileSync(path.join(GENERATED, `${name}.json`), "utf8"));
  return { ...data, name, file: path.join(GENERATED, `${name}.pdf`), backendAccepts: data.backend_accepts };
}

/**
 * Labels as laid out by the browser: none may cover an evidence box or another label, and
 * all must stay on the page. Returns a description of every violation.
 */
export async function labelProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>("[data-testid=page-stage]")!;
    const frame = stage.getBoundingClientRect();
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left - frame.left, top: r.top - frame.top, right: r.right - frame.left, bottom: r.bottom - frame.top };
    };
    type R = ReturnType<typeof rect>;
    const overlap = (a: R, b: R) => a.left < b.right - 0.01 && b.left < a.right - 0.01 && a.top < b.bottom - 0.01 && b.top < a.bottom - 0.01;
    const boxes = [...stage.querySelectorAll("[data-evidence-key]")].map((el) => ({ key: el.getAttribute("data-evidence-key")!, r: rect(el) }));
    const labels = [...stage.querySelectorAll("[data-label-for]")].map((el) => ({ key: el.getAttribute("data-label-for")!, r: rect(el) }));
    const out: string[] = [];
    for (const label of labels) {
      for (const box of boxes) if (overlap(label.r, box.r)) out.push(`label ${label.key} covers box ${box.key}`);
      for (const other of labels) if (other !== label && overlap(label.r, other.r)) out.push(`label ${label.key} covers label ${other.key}`);
      if (label.r.left < -0.01 || label.r.top < -0.01 || label.r.right > frame.width + 0.01 || label.r.bottom > frame.height + 0.01) {
        out.push(`label ${label.key} is off the page`);
      }
    }
    return out;
  });
}
