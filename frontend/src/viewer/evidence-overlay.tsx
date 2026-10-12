import type { FindingStatus } from "@/api/types";
import { FINDING_LABEL } from "@/inspection/labels";
import type { EvidenceItem } from "./evidence";
import type { Rect } from "./geometry";
import type React from "react";
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
  /** Emphasise every box of one finding, and dim the rest. */
  selectedFindingId: string | null;
  /** A box was activated (click or Enter/Space). */
  onSelect: (findingId: string) => void;
  /** Show each box's finding id and outcome beside it, where there is room. */
  showLabels: boolean;
}

const contains = (r: Rect, x: number, y: number) =>
  x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;

/**
 * Boxes over the page. The layer itself takes no pointer events, so scrolling and controls
 * work through it; only the boxes are clickable. Where boxes overlap, a click picks the
 * most important finding under the pointer, and clicking again cycles to the next one;
 * every box is also reachable with Tab, so no finding depends on the pointer.
 */
export function EvidenceOverlay({ placed, page, selectedFindingId, onSelect, showLabels }: EvidenceOverlayProps) {
  const ordered = placed.toSorted(
    (a, b) => PAINT_ORDER.indexOf(a.item.status) - PAINT_ORDER.indexOf(b.item.status),
  );
  const hasSelection = selectedFindingId !== null && placed.some((p) => p.item.findingId === selectedFindingId);

  function choose(item: EvidenceItem, event: React.MouseEvent<HTMLButtonElement>) {
    if (event.detail === 0) return onSelect(item.findingId); // keyboard: exactly this box
    const layer = event.currentTarget.parentElement!.getBoundingClientRect();
    const x = event.clientX - layer.left;
    const y = event.clientY - layer.top;
    const under = ordered
      .filter((p) => contains(p.rect, x, y))
      .toReversed()
      .map((p) => p.item.findingId)
      .filter((id, i, all) => all.indexOf(id) === i);
    const at = selectedFindingId === null ? -1 : under.indexOf(selectedFindingId);
    onSelect(at === -1 ? (under[0] ?? item.findingId) : under[(at + 1) % under.length]!);
  }
  // The most important boxes choose their label position first.
  const labels = showLabels
    ? placeLabels(
        ordered.toReversed().map(({ item, rect }) => ({
          key: item.key,
          rect,
          text: `${item.findingId} ${FINDING_LABEL[item.status]}${item.findingId === selectedFindingId ? " (selected)" : ""}`,
        })),
        page,
      )
    : new Map();

  return (
    <div
      data-testid="evidence-layer"
      role="group"
      aria-label="Evidence on the drawing"
      className="pointer-events-none absolute inset-0"
    >
      {ordered.map(({ item, rect }) => {
        const selected = item.findingId === selectedFindingId;
        return (
          <button
            key={item.key}
            type="button"
            aria-label={`${item.description}. Select this finding`}
            aria-pressed={selected}
            aria-current={selected ? "true" : undefined}
            onClick={(event) => choose(item, event)}
            data-evidence-key={item.key}
            data-status={item.status}
            className={`pointer-events-auto absolute cursor-pointer p-0 outline-offset-0 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${BOX[item.status]} ${
              selected ? "z-10 outline-[3px] bg-accent/10" : `outline-[1.5px] ${hasSelection ? "opacity-40" : ""}`
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
              hasSelection && item.findingId !== selectedFindingId ? "opacity-40" : ""
            }`}
            style={{
              left: `${label.rect.left}px`,
              top: `${label.rect.top}px`,
              width: `${label.rect.width}px`,
              height: `${label.rect.height}px`,
            }}
          >
            {item.findingId} {FINDING_LABEL[item.status]}
            {item.findingId === selectedFindingId ? " (selected)" : ""}
          </span>
        );
      })}
    </div>
  );
}
