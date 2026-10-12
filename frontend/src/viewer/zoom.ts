// Zoom levels and canvas sizing. Pure functions.
//
// Scale is PDF.js's: CSS pixels per PDF point, so 1 is "100%". Two separate quantities:
//   layout scale  CSS pixels per point; the canvas element and the overlay use it.
//   output scale  canvas backing-store pixels per CSS pixel (the device pixel ratio,
//                 reduced if needed to keep the canvas within browser limits).
// Overlays never see the output scale: they are positioned in CSS pixels.

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;
export const ZOOM_STEP = 1.25;

/**
 * Canvas limits. Browsers refuse or silently blank canvases above a size that varies by
 * browser (iOS Safari: 16,777,216 pixels in area; most: 32,767 or 16,384 per side). These
 * are the conservative values.
 */
export const MAX_CANVAS_PIXELS = 16_777_216;
export const MAX_CANVAS_SIDE = 16_384;

export type Zoom = { mode: "fit" } | { mode: "fixed"; scale: number };

/** Scale that makes a page of `pageWidth` points (as displayed) fill `containerWidth` CSS px. */
export function fitScale(containerWidth: number, pageWidth: number): number {
  if (!(containerWidth > 0) || !(pageWidth > 0)) return 1;
  return containerWidth / pageWidth;
}

/**
 * The largest layout scale whose canvas can still be drawn at one backing pixel per CSS
 * pixel. Large sheets (A0 is 2384 x 3370 pt) reach it well before MAX_SCALE.
 */
export function maxScaleFor(pageWidth: number, pageHeight: number): number {
  const byArea = Math.sqrt(MAX_CANVAS_PIXELS / (pageWidth * pageHeight));
  return Math.min(MAX_SCALE, byArea, MAX_CANVAS_SIDE / pageWidth, MAX_CANVAS_SIDE / pageHeight);
}

/** The layout scale to use, never above what the canvas can hold. */
export function resolveScale(zoom: Zoom, fit: number, max: number): number {
  const wanted = zoom.mode === "fit" ? fit : zoom.scale;
  return Math.min(Math.max(wanted, Math.min(MIN_SCALE, fit)), max);
}

export function zoomIn(scale: number, max: number): number {
  return Math.min(scale * ZOOM_STEP, max);
}

export function zoomOut(scale: number): number {
  return Math.max(scale / ZOOM_STEP, MIN_SCALE);
}

export interface CanvasPlan {
  /** Backing store size in device pixels. */
  pixelWidth: number;
  pixelHeight: number;
  /** Backing pixels per CSS pixel, per axis (exactly pixelWidth / cssWidth). */
  outputScaleX: number;
  outputScaleY: number;
}

/**
 * How big to make the canvas for a page drawn at `cssWidth` x `cssHeight` CSS pixels on a
 * screen with `devicePixelRatio`. The backing store is rounded to whole pixels, and the
 * render transform uses the exact ratio per axis, so the drawn page fills the canvas and
 * stays aligned with the overlay (which is laid out in CSS pixels).
 */
export function planCanvas(cssWidth: number, cssHeight: number, devicePixelRatio: number): CanvasPlan {
  const dpr = devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
  const ratio = Math.min(
    dpr,
    Math.sqrt(MAX_CANVAS_PIXELS / (cssWidth * cssHeight)),
    MAX_CANVAS_SIDE / cssWidth,
    MAX_CANVAS_SIDE / cssHeight,
  );
  const pixelWidth = Math.max(1, Math.floor(cssWidth * ratio));
  const pixelHeight = Math.max(1, Math.floor(cssHeight * ratio));
  return {
    pixelWidth,
    pixelHeight,
    outputScaleX: pixelWidth / cssWidth,
    outputScaleY: pixelHeight / cssHeight,
  };
}
