import type { FindingStatus } from "@/api/types";
import { FINDING_LABEL } from "@/inspection/labels";
import type { EvidenceItem } from "./evidence";
import type { Rect } from "./geometry";
import { placeLabels } from "./label-placement";

export interface PlacedEvidence {
  item: EvidenceItem;
  /** Viewport CSS pixels, from the same layout the canvas is sized to. */
  rect: Rect;
}

// Each outcome has its own outline style as well as its own colour, and its name is
// written beside the box, so colour is never the only cue. The outline starts at the box
// edge and is drawn outward (1.5 px), so it never covers the evidence text itself and the
// visible frame is at most 1.5 px (2.5 px when selected) larger than the box.
const BOX: Record<FindingStatus, string> = {
  fail: "outline-solid outline-fail bg-fail/10",
  needs_review: "outline-dashed outline-review bg-review/10",
  missing: "outline-double outline-missing bg-missing/10",
  pass: "outline-dotted outline-pass bg-pass/5",
};

const TAG: Record<FindingStatus, string> = {
  fail: "border-fail text-fail",
  needs_review: "border-review text-review",
  missing: "border-missing text-missing",
  pass: "border-pass text-pass",
};

/** Painted in this order, so the most important outcome is on top where boxes overlap. */
const PAINT_ORDER: readonly FindingStatus[] = ["pass", "missing", "needs_review", "fail"];

export const OUTLINE_DESCRIPTION: Record<FindingStatus, string> = {
  fail: "solid outline",
  needs_review: "dashed outline",
  missing: "double outline",
  pass: "dotted outline",
};

interface EvidenceOverlayProps {
  placed: readonly PlacedEvidence[];
  /** The page as laid out, in CSS pixels: labels stay on it. */
  page: { width: number; height: number };
  /** Emphasise one box (programmatic; the findings panel will drive it in F4). */
  selectedKey: string | null;
  /** Show each box's finding id and outcome beside it, where there is room. */
  showLabels: boolean;
}

/** Boxes over the page. It never takes pointer events, so scrolling and controls work through it. */
export function EvidenceOverlay({ placed, page, selectedKey, showLabels }: EvidenceOverlayProps) {
  const ordered = placed.toSorted(
    (a, b) => PAINT_ORDER.indexOf(a.item.status) - PAINT_ORDER.indexOf(b.item.status),
  );
  const hasSelection = selectedKey !== null && placed.some((p) => p.item.key === selectedKey);
  // The most important boxes choose their label position first.
  const labels = showLabels
    ? placeLabels(
        ordered.toReversed().map(({ item, rect }) => ({
          key: item.key,
          rect,
          text: `${item.findingId} ${FINDING_LABEL[item.status]}`,
        })),
        page,
      )
    : new Map();

  return (
    <div
      data-testid="evidence-layer"
      role="list"
      aria-label="Evidence on the drawing"
      className="pointer-events-none absolute inset-0"
    >
      {ordered.map(({ item, rect }) => {
        const selected = item.key === selectedKey;
        return (
          <div
            key={item.key}
            role="listitem"
            aria-label={item.description}
            aria-current={selected ? "true" : undefined}
            data-evidence-key={item.key}
            data-status={item.status}
            className={`absolute outline-offset-0 ${BOX[item.status]} ${
              selected ? "z-10 outline-[2.5px]" : `outline-[1.5px] ${hasSelection ? "opacity-40" : ""}`
            }`}
            style={{ left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }}
          />
        );
      })}
      {ordered.map(({ item }) => {
        const label = labels.get(item.key);
        if (label === undefined || label === null) return null;
        return (
          <span
            key={`label-${item.key}`}
            aria-hidden="true"
            data-label-for={item.key}
            data-label-side={label.side}
            className={`absolute overflow-hidden rounded-sm border bg-surface text-center text-[10px] leading-4 font-semibold whitespace-nowrap ${TAG[item.status]} ${
              hasSelection && item.key !== selectedKey ? "opacity-40" : ""
            }`}
            style={{
              left: `${label.rect.left}px`,
              top: `${label.rect.top}px`,
              width: `${label.rect.width}px`,
              height: `${label.rect.height}px`,
            }}
          >
            {item.findingId} {FINDING_LABEL[item.status]}
          </span>
        );
      })}
    </div>
  );
}
