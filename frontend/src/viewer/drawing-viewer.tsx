"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FindingStatus } from "@/api/types";
import { FINDING_LABEL } from "@/inspection/labels";
import { UNPLACED_TEXT, type UnplacedReason, type ViewerEvidence } from "./evidence";
import { EvidenceOverlay, OUTLINE_DESCRIPTION, type PlacedEvidence } from "./evidence-overlay";
import { boxToViewport, checkPageGeometry } from "./geometry";
import { PageStage } from "./page-canvas";
import type { OpenedPdf, PdfSource } from "./pdf-source";
import { pdfjsSource } from "./pdfjs-source";
import { useDevicePixelRatio, useElementWidth } from "./use-layout-signals";
import { useOpenedPdf } from "./use-opened-pdf";
import { fitScale, maxScaleFor, MIN_SCALE, resolveScale, zoomIn, zoomOut, type Zoom } from "./zoom";

export type InspectionPhase = "none" | "running" | "failed" | "succeeded" | "stale";

interface DrawingViewerProps {
  /** The PDF the user selected; rendered locally, never uploaded again for viewing. */
  file: File | null;
  /** Evidence from a validated report for this same file, or null. */
  evidence: ViewerEvidence | null;
  inspection: InspectionPhase;
  /** Emphasise every evidence box of one finding ("F4"). */
  selectedFindingId?: string | null;
  /** Changes when the viewer should bring the selection into view (selection made elsewhere). */
  revealToken?: number | null;
  /** A box was chosen in the viewer. */
  onSelectFinding?: (findingId: string) => void;
  source?: PdfSource;
}

/**
 * The drawing, rendered by PDF.js, with the inspection's evidence boxes on top.
 * Knows nothing about rules or extraction: it draws what a validated report says, and
 * only on the exact file that report describes.
 */
export function DrawingViewer({
  file,
  evidence,
  inspection,
  selectedFindingId = null,
  revealToken = null,
  onSelectFinding = () => {},
  source = pdfjsSource,
}: DrawingViewerProps) {
  const document = useOpenedPdf(file, source);
  switch (document.status) {
    case "empty":
      return (
        <Notice>
          Choose a PDF to see the drawing here, with the source text of each finding marked on it.
        </Notice>
      );
    case "opening":
      return (
        <div data-testid="viewer-opening" className="min-h-96 rounded-md border border-line bg-surface p-4">
          <p className="text-sm text-muted">Opening the drawing</p>
          <div aria-hidden="true" className="mt-3 h-80 rounded-md bg-line motion-safe:animate-pulse" />
        </div>
      );
    case "unsupported":
      return (
        <Notice tone="problem" title="This drawing cannot be shown">
          {document.reason === "password"
            ? "The PDF is password-protected."
            : `The PDF has ${document.pageCount ?? "several"} pages; the viewer shows single-page drawings only.`}
        </Notice>
      );
    case "failed":
      return (
        <Notice tone="problem" title="This file could not be displayed">
          {document.reason === "invalid"
            ? "PDF.js could not read it as a PDF."
            : document.reason === "unreadable"
              ? "The browser could not read the file."
              : "Something went wrong while opening it."}
        </Notice>
      );
    case "open":
      // A new document gets new zoom state and a new canvas: nothing carries over.
      return (
        <OpenDrawing
          key={documentKey(document.pdf)}
          pdf={document.pdf}
          file={file!}
          evidence={evidence}
          inspection={inspection}
          selectedFindingId={selectedFindingId}
          revealToken={revealToken}
          onSelectFinding={onSelectFinding}
        />
      );
  }
}

const keys = new WeakMap<OpenedPdf, number>();
let nextKey = 1;
function documentKey(pdf: OpenedPdf): number {
  let key = keys.get(pdf);
  if (key === undefined) {
    key = nextKey++;
    keys.set(pdf, key);
  }
  return key;
}

type Trust = { show: true } | { show: false; message: string };

/** May this report's evidence be drawn on this document? Every condition must hold. */
function trustEvidence(pdf: OpenedPdf, file: File, evidence: ViewerEvidence | null, inspection: InspectionPhase): Trust {
  if (evidence === null) {
    const message =
      inspection === "running"
        ? "Evidence boxes appear when the inspection finishes."
        : inspection === "failed"
          ? "No evidence: the inspection did not produce a report for this file."
          : inspection === "stale"
            ? "Evidence hidden: the requirements changed since this inspection. Run it again."
            : "No inspection result for this file.";
    return { show: false, message };
  }
  if (pdf.sha256 === null) {
    return { show: false, message: "Evidence hidden: this browser could not verify that the file shown is the one inspected." };
  }
  if (pdf.sha256 !== evidence.documentSha256 || file.size !== evidence.documentSizeBytes) {
    return { show: false, message: "Evidence hidden: the file shown is not the document the inspection describes." };
  }
  const page = evidence.pages.find((p) => p.page_number === 1);
  if (page === undefined) {
    return { show: false, message: "Evidence hidden: the inspection does not describe page 1." };
  }
  const geometry = checkPageGeometry(page, pdf.page.geometry);
  if (!geometry.ok) {
    return { show: false, message: `Evidence hidden: ${geometry.problem}.` };
  }
  return { show: true };
}

function OpenDrawing({
  pdf,
  file,
  evidence,
  inspection,
  selectedFindingId,
  revealToken,
  onSelectFinding,
}: {
  pdf: OpenedPdf;
  file: File;
  evidence: ViewerEvidence | null;
  inspection: InspectionPhase;
  selectedFindingId: string | null;
  revealToken: number | null;
  onSelectFinding: (findingId: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<Zoom>({ mode: "fit" });
  const [showEvidence, setShowEvidence] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const availableWidth = useElementWidth(scroller);
  const devicePixelRatio = useDevicePixelRatio();

  const natural = useMemo(() => pdf.page.layout(1), [pdf]);
  const fit = fitScale(availableWidth, natural.width);
  const max = maxScaleFor(natural.width, natural.height);
  const scale = resolveScale(zoom, fit, max);
  const layout = useMemo(() => pdf.page.layout(scale), [pdf, scale]);

  const trust = useMemo(() => trustEvidence(pdf, file, evidence, inspection), [pdf, file, evidence, inspection]);
  const placed: PlacedEvidence[] = useMemo(() => {
    if (!trust.show || evidence === null) return [];
    const page = evidence.pages.find((p) => p.page_number === 1)!;
    return evidence.items
      .filter((item) => item.pageNumber === 1)
      .map((item) => ({ item, rect: boxToViewport(page, item.bbox, layout.transform) }));
  }, [trust, evidence, layout]);

  // Bring the selected finding's boxes into view when the selection was made elsewhere.
  // Scrolls the viewer's own area only when the boxes are not already fully visible, never
  // moves keyboard focus, and depends on the token alone: zooming or resizing never scrolls.
  const latest = useRef({ placed, selectedFindingId });
  useEffect(() => {
    latest.current = { placed, selectedFindingId };
  });
  useEffect(() => {
    if (revealToken === null) return;
    const area = scroller.current;
    const stage = area?.querySelector<HTMLElement>("[data-testid=page-stage]");
    const { placed: boxes, selectedFindingId: id } = latest.current;
    const mine = boxes.filter((p) => p.item.findingId === id).map((p) => p.rect);
    if (!area || !stage || mine.length === 0) return;
    const left = Math.min(...mine.map((r) => r.left));
    const top = Math.min(...mine.map((r) => r.top));
    const right = Math.max(...mine.map((r) => r.left + r.width));
    const bottom = Math.max(...mine.map((r) => r.top + r.height));
    const a = area.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const view = {
      left: s.left - a.left + left,
      top: s.top - a.top + top,
      right: s.left - a.left + right,
      bottom: s.top - a.top + bottom,
    };
    const fits = view.left >= 0 && view.top >= 0 && view.right <= area.clientWidth && view.bottom <= area.clientHeight;
    if (fits) return;
    area.scrollTo({
      left: area.scrollLeft + (view.left + view.right) / 2 - area.clientWidth / 2,
      top: area.scrollTop + (view.top + view.bottom) / 2 - area.clientHeight / 2,
    });
  }, [revealToken]);

  const percent = Math.round(scale * 100);
  return (
    <div className="flex flex-col gap-2">
      <div role="toolbar" aria-label="Drawing view" className="flex flex-wrap items-center gap-2 text-sm">
        <ToolButton label="Zoom out" onClick={() => setZoom({ mode: "fixed", scale: zoomOut(scale) })} disabled={scale <= MIN_SCALE}>
          {"−"}
        </ToolButton>
        <span className="w-12 text-center font-mono tabular-nums" data-testid="zoom-level">
          {percent}%
        </span>
        <ToolButton label="Zoom in" onClick={() => setZoom({ mode: "fixed", scale: zoomIn(scale, max) })} disabled={scale >= max}>
          +
        </ToolButton>
        <ToolButton label="Fit to width" pressed={zoom.mode === "fit"} onClick={() => setZoom({ mode: "fit" })}>
          Fit width
        </ToolButton>
        <ToolButton label="Reset zoom to 100%" onClick={() => setZoom({ mode: "fixed", scale: 1 })}>
          100%
        </ToolButton>
        <label className="ml-auto flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={showEvidence}
            onChange={(event) => setShowEvidence(event.currentTarget.checked)}
            className="accent-[var(--accent)]"
          />
          Show evidence
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={showLabels}
            disabled={!showEvidence}
            onChange={(event) => setShowLabels(event.currentTarget.checked)}
            className="accent-[var(--accent)]"
          />
          Labels
        </label>
      </div>
      {zoom.mode === "fixed" && zoom.scale > max ? (
        <p className="text-xs text-muted">This page is large; zoom is limited to {Math.round(max * 100)}% so the browser can draw it.</p>
      ) : null}
      <div
        ref={scroller}
        tabIndex={0}
        role="region"
        aria-label="Drawing, scrollable"
        data-testid="viewer-scroll"
        className="max-h-[calc(100dvh-14rem)] min-h-96 overflow-auto rounded-md border border-line bg-background p-3 [scrollbar-gutter:stable]"
      >
        {availableWidth > 0 ? (
          <PageStage page={pdf.page} layout={layout} scale={scale} devicePixelRatio={devicePixelRatio}>
            {showEvidence && placed.length > 0 ? <EvidenceOverlay placed={placed} page={layout} selectedFindingId={selectedFindingId} onSelect={onSelectFinding} showLabels={showLabels} /> : null}
          </PageStage>
        ) : null}
      </div>
      <EvidenceSummary trust={trust} evidence={evidence} placed={placed} selectedFindingId={selectedFindingId} />
    </div>
  );
}

function ToolButton({
  label,
  onClick,
  disabled = false,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
      className="min-w-8 rounded-md border border-line bg-surface px-2 py-1 font-medium hover:border-accent disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:border-accent aria-pressed:text-accent"
    >
      {children}
    </button>
  );
}


function EvidenceSummary({
  trust,
  evidence,
  placed,
  selectedFindingId,
}: {
  trust: Trust;
  evidence: ViewerEvidence | null;
  placed: readonly PlacedEvidence[];
  selectedFindingId: string | null;
}) {
  if (!trust.show) {
    return (
      <p data-testid="evidence-status" className="text-sm text-muted">
        {trust.message}
      </p>
    );
  }
  const statuses = [...new Set(placed.map((p) => p.item.status))] as FindingStatus[];
  const unplaced = evidence?.unplaced ?? [];
  const selection = describeSelection(selectedFindingId, placed, unplaced);
  return (
    <div data-testid="evidence-status" className="text-sm">
      {selection !== null ? (
        <p data-testid="selection-status" className="mb-1 font-medium">
          {selection}
        </p>
      ) : null}
      <p>
        {placed.length === 1 ? "1 evidence box" : `${placed.length} evidence boxes`} on the drawing.
        {statuses.length > 0 ? (
          <span className="text-muted">
            {" "}
            {statuses.map((s) => `${FINDING_LABEL[s]}: ${OUTLINE_DESCRIPTION[s]}`).join("; ")}.
          </span>
        ) : null}
      </p>
      {unplaced.length > 0 ? (
        <ul className="mt-1 text-muted">
          {unplaced.map((u) => (
            <li key={`${u.findingId}:${u.measurementId ?? ""}`}>
              {u.findingId} ({FINDING_LABEL[u.status]}
              {u.measurementId !== null ? `, ${u.measurementId}` : ""}) is not marked: {UNPLACED_TEXT[u.reason]}.
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Notice({
  children,
  title,
  tone = "neutral",
}: {
  children: React.ReactNode;
  title?: string;
  tone?: "neutral" | "problem";
}) {
  return (
    <div
      className={`min-h-96 rounded-md border bg-surface p-4 ${
        tone === "problem" ? "border-line border-l-4 border-l-fail" : "border-line"
      }`}
    >
      {title !== undefined ? <p className="text-sm font-semibold">{title}</p> : null}
      <p className={`max-w-[52ch] text-sm ${title !== undefined ? "mt-1" : "text-muted"}`}>{children}</p>
    </div>
  );
}

/** What the viewer can say about the selected finding: where it is, or why it is not marked. */
function describeSelection(
  findingId: string | null,
  placed: readonly PlacedEvidence[],
  unplaced: readonly { findingId: string; reason: UnplacedReason }[],
): string | null {
  if (findingId === null) return null;
  const mine = placed.filter((p) => p.item.findingId === findingId);
  if (mine.length === 0) {
    const reasons = [...new Set(unplaced.filter((u) => u.findingId === findingId).map((u) => UNPLACED_TEXT[u.reason]))];
    return `${findingId} is selected, but it is not marked on the drawing${reasons.length > 0 ? `: ${reasons.join("; ")}` : ""}.`;
  }
  const others = [
    ...new Set(
      placed
        .filter((p) => p.item.findingId !== findingId && mine.some((m) => overlaps(m.rect, p.rect)))
        .map((p) => p.item.findingId),
    ),
  ];
  return `${findingId} is selected: ${mine.length === 1 ? "1 box" : `${mine.length} boxes`} on the drawing.${
    others.length > 0 ? ` Overlaps ${others.join(", ")}; click the box again to switch.` : ""
  }`;
}

function overlaps(a: { left: number; top: number; width: number; height: number }, b: typeof a): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}
