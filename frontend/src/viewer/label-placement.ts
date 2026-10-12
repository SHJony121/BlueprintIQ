// Where each evidence label goes. Pure functions.
//
// A label must never cover evidence: not its own box, not another box, not another label.
// Lines of evidence may be neighbours above and below (horizontal text) or left and right
// (text that runs vertically on screen), so each label tries every side of its box and takes
// the first that is clear and on the page. If no side is clear, the box gets no label; it
// still has its outline style and spoken description, and the summary lists the finding.
import type { Rect } from "./geometry";

export type LabelSide = "left" | "right" | "above" | "below";

export interface LabelRequest {
  key: string;
  rect: Rect;
  text: string;
}

export interface PlacedLabel {
  side: LabelSide;
  rect: Rect;
}

/** Labels are drawn at exactly this size, so the overlap checks match what is shown. */
export const LABEL_HEIGHT_PX = 18;
const CHAR_WIDTH_PX = 6.5; // 10 px semibold text, generous so the text always fits
const LABEL_PADDING_PX = 10;
/** Distance between a box and its label, clear of the box's outline. */
export const LABEL_GAP_PX = 5;
/** Boxes are treated as this much larger than their rectangle: their outline. */
const OUTLINE_PX = 2;

export function labelWidth(text: string): number {
  return Math.ceil(text.length * CHAR_WIDTH_PX + LABEL_PADDING_PX);
}

const SIDES: readonly LabelSide[] = ["left", "right", "above", "below"];

function candidate(box: Rect, side: LabelSide, width: number): Rect {
  const height = LABEL_HEIGHT_PX;
  const middle = box.top + box.height / 2 - height / 2;
  switch (side) {
    case "left":
      return { left: box.left - LABEL_GAP_PX - width, top: middle, width, height };
    case "right":
      return { left: box.left + box.width + LABEL_GAP_PX, top: middle, width, height };
    case "above":
      return { left: box.left, top: box.top - LABEL_GAP_PX - height, width, height };
    case "below":
      return { left: box.left, top: box.top + box.height + LABEL_GAP_PX, width, height };
  }
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

function grow(r: Rect, by: number): Rect {
  return { left: r.left - by, top: r.top - by, width: r.width + 2 * by, height: r.height + 2 * by };
}

/**
 * A position for each label, or null where none is clear. Requests are placed in the order
 * given, so callers list the most important boxes first.
 */
export function placeLabels(
  requests: readonly LabelRequest[],
  page: { width: number; height: number },
): Map<string, PlacedLabel | null> {
  const boxes = requests.map((r) => grow(r.rect, OUTLINE_PX));
  const taken: Rect[] = [];
  const result = new Map<string, PlacedLabel | null>();
  for (const request of requests) {
    const width = labelWidth(request.text);
    let chosen: PlacedLabel | null = null;
    for (const side of SIDES) {
      const rect = candidate(request.rect, side, width);
      const onPage =
        rect.left >= 0 && rect.top >= 0 && rect.left + rect.width <= page.width && rect.top + rect.height <= page.height;
      if (!onPage) continue;
      if (boxes.some((b) => intersects(rect, b)) || taken.some((t) => intersects(rect, t))) continue;
      chosen = { side, rect };
      break;
    }
    if (chosen !== null) taken.push(chosen.rect);
    result.set(request.key, chosen);
  }
  return result;
}
