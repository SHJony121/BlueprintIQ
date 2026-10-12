import { describe, expect, it } from "vitest";
import { intersects, LABEL_HEIGHT_PX, labelWidth, placeLabels, type LabelRequest } from "./label-placement";

const PAGE = { width: 600, height: 800 };
const req = (key: string, left: number, top: number, width: number, height: number, text = `${key} Fail`): LabelRequest => ({
  key,
  rect: { left, top, width, height },
  text,
});

function allClear(requests: LabelRequest[], placed: ReturnType<typeof placeLabels>) {
  const labels = [...placed.values()].flatMap((p) => (p === null ? [] : [p.rect]));
  for (const label of labels) {
    for (const r of requests) expect(intersects(label, r.rect)).toBe(false);
    for (const other of labels) if (other !== label) expect(intersects(label, other)).toBe(false);
    expect(label.left).toBeGreaterThanOrEqual(0);
    expect(label.top).toBeGreaterThanOrEqual(0);
    expect(label.left + label.width).toBeLessThanOrEqual(PAGE.width);
    expect(label.top + label.height).toBeLessThanOrEqual(PAGE.height);
  }
}

describe("label placement", () => {
  it("puts a label to the left of a box with room there", () => {
    const placed = placeLabels([req("F1", 200, 100, 90, 10)], PAGE);
    expect(placed.get("F1")?.side).toBe("left");
    expect(placed.get("F1")?.rect.height).toBe(LABEL_HEIGHT_PX);
  });

  it("uses the right side near the left page edge", () => {
    const placed = placeLabels([req("F1", 3, 100, 90, 10)], PAGE);
    expect(placed.get("F1")?.side).toBe("right");
  });

  it("never covers a neighbouring box beside it (text running vertically on screen)", () => {
    // Four tall boxes side by side, 12 px apart: labels cannot go left or right.
    const requests = [0, 1, 2, 3].map((i) => req(`F${i + 1}`, 100 + i * 22, 300, 10, 90));
    const placed = placeLabels(requests, PAGE);
    allClear(requests, placed);
    // The inner boxes have neighbours on both sides, so their labels go above or below.
    for (const key of ["F2", "F3"]) expect(["above", "below"]).toContain(placed.get(key)?.side);
  });

  it("never covers a neighbouring box above or below (horizontal lines a line-height apart)", () => {
    const requests = [0, 1, 2, 3, 4].map((i) => req(`F${i + 1}`, 120, 100 + i * 21, 90, 10));
    const placed = placeLabels(requests, PAGE);
    allClear(requests, placed);
    expect([...placed.values()].every((p) => p !== null)).toBe(true);
  });

  it("leaves a box unlabelled rather than covering anything", () => {
    // A box boxed in on all sides by others, too close for any label.
    const requests = [
      req("C", 200, 200, 40, 10),
      req("L", 150, 195, 45, 20),
      req("R", 245, 195, 45, 20),
      req("U", 190, 180, 60, 15),
      req("D", 190, 215, 60, 15),
    ];
    const placed = placeLabels(requests, PAGE);
    expect(placed.get("C")).toBeNull();
    allClear(requests, placed);
  });

  it("does not stack two labels on each other", () => {
    // Two boxes on the same line: their left and right labels would collide in the gap.
    const requests = [req("F1", 100, 100, 60, 10), req("F2", 230, 100, 60, 10)];
    const placed = placeLabels(requests, PAGE);
    allClear(requests, placed);
  });

  it("sizes labels from their text", () => {
    expect(labelWidth("F1 Needs review")).toBeGreaterThan(labelWidth("F1 Pass"));
  });
});
