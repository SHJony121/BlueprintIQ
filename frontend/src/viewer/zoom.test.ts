import { describe, expect, it } from "vitest";
import {
  fitScale,
  MAX_CANVAS_PIXELS,
  MAX_CANVAS_SIDE,
  MAX_SCALE,
  maxScaleFor,
  MIN_SCALE,
  planCanvas,
  resolveScale,
  zoomIn,
  zoomOut,
} from "./zoom";

describe("zoom levels", () => {
  it("fits the page width to the container", () => {
    expect(fitScale(595, 595)).toBe(1);
    expect(fitScale(1190, 595)).toBe(2);
    expect(fitScale(0, 595)).toBe(1); // not laid out yet
  });

  it("steps by 25% and stops at the limits", () => {
    expect(zoomIn(1, MAX_SCALE)).toBe(1.25);
    expect(zoomOut(1.25)).toBe(1);
    expect(zoomIn(3.9, MAX_SCALE)).toBe(MAX_SCALE);
    expect(zoomOut(0.26)).toBe(MIN_SCALE);
  });

  it("never exceeds what the canvas can hold", () => {
    expect(resolveScale({ mode: "fixed", scale: 3 }, 1, 2)).toBe(2);
    expect(resolveScale({ mode: "fit" }, 5, 4)).toBe(4);
  });

  it("follows the container in fit mode, even below the manual minimum", () => {
    expect(resolveScale({ mode: "fit" }, 0.8, 4)).toBe(0.8);
    expect(resolveScale({ mode: "fit" }, 0.1, 4)).toBe(0.1);
    expect(resolveScale({ mode: "fixed", scale: 0.1 }, 1, 4)).toBe(MIN_SCALE);
  });

  it("allows full zoom on an A4 page but limits a large sheet", () => {
    expect(maxScaleFor(595, 842)).toBe(MAX_SCALE);
    const a0 = maxScaleFor(2384, 3370);
    expect(a0).toBeLessThan(1.5);
    expect(2384 * a0 * 3370 * a0).toBeLessThanOrEqual(MAX_CANVAS_PIXELS + 1);
  });
});

describe("canvas size", () => {
  it("uses the device pixel ratio for the backing store", () => {
    expect(planCanvas(595, 842, 2)).toEqual({ pixelWidth: 1190, pixelHeight: 1684, outputScaleX: 2, outputScaleY: 2 });
    expect(planCanvas(595, 842, 1)).toEqual({ pixelWidth: 595, pixelHeight: 842, outputScaleX: 1, outputScaleY: 1 });
  });

  it("rounds to whole pixels and records the exact ratio per axis", () => {
    const plan = planCanvas(595.5, 842.25, 1.5);
    expect(plan.pixelWidth).toBe(893);
    expect(plan.pixelHeight).toBe(1263);
    expect(plan.outputScaleX).toBeCloseTo(893 / 595.5, 12);
    expect(plan.outputScaleY).toBeCloseTo(1263 / 842.25, 12);
    // Drawing at these ratios fills the canvas exactly, so CSS pixels and canvas pixels agree.
    expect(595.5 * plan.outputScaleX).toBeCloseTo(plan.pixelWidth, 9);
    expect(842.25 * plan.outputScaleY).toBeCloseTo(plan.pixelHeight, 9);
  });

  it("lowers the ratio rather than exceed the area limit", () => {
    const plan = planCanvas(3000, 4000, 3);
    expect(plan.pixelWidth * plan.pixelHeight).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
    expect(plan.outputScaleX).toBeLessThan(3);
  });

  it("lowers the ratio rather than exceed the side limit", () => {
    const plan = planCanvas(10_000, 500, 2);
    expect(plan.pixelWidth).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
  });

  it("treats a missing or nonsense device pixel ratio as 1", () => {
    expect(planCanvas(100, 100, 0).outputScaleX).toBe(1);
    expect(planCanvas(100, 100, Number.NaN).outputScaleX).toBe(1);
  });
});
