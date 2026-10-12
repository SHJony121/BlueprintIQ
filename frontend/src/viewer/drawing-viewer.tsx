"use client";

import { useMemo, useRef, useState } from "react";
import type { FindingStatus } from "@/api/types";
import { FINDING_LABEL } from "@/inspection/labels";
import type { UnplacedReason, ViewerEvidence } from "./evidence";
import { EvidenceOverlay, OUTLINE_DESCRIPTION, type PlacedEvidence } from "./evidence-overlay";
import { boxToViewport, checkPageGeometry } from "./geometry";
import { PageStage } from "./page-canvas";
import type { OpenedPdf, PdfSource } from "./pdf-source";
import { pdfjsSource } from "./pdfjs-source";
import { useDevicePixelRatio, useElementWidth } from "./use-layout-signals";
import { useOpenedPdf } from "./use-opened-pdf";
import { fitScale, maxScaleFor, MIN_SCALE, resolveScale, zoomIn, zoomOut, type Zoom } from "./zoom";

export type InspectionPhase = "none" | "running" | "failed" | "succeeded";

interface DrawingViewerProps {
  /** The PDF the user selected; rendered locally, never uploaded again for viewing. */
  file: File | null;
  /** Evidence from a validated report for this same file, or null. */
  evidence: ViewerEvidence | null;
  inspection: InspectionPhase;
  /** Emphasise one evidence box by its key ("F4:M3"). */
  selectedKey?: string | null;
  source?: PdfSource;
}

/**
 * The drawing, rendered by PDF.js, with the inspection's evidence boxes on top.
 * Knows nothing about rules or extraction: it draws what a validated report says, and
 * only on the exact file that report describes.
 */
export function DrawingViewer({ file, evidence, inspection, selectedKey = null, source = pdfjsSource }: DrawingViewerProps) {
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
          selectedKey={selectedKey}
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
  selectedKey,
}: {
  pdf: OpenedPdf;
  file: File;
  evidence: ViewerEvidence | null;
  inspection: InspectionPhase;
  selectedKey: string | null;
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
            {showEvidence && placed.length > 0 ? <EvidenceOverlay placed={placed} page={layout} selectedKey={selectedKey} showLabels={showLabels} /> : null}
          </PageStage>
        ) : null}
      </div>
      <EvidenceSummary trust={trust} evidence={evidence} placed={placed} />
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

const UNPLACED_TEXT: Record<UnplacedReason, string> = {
  no_measurement: "nothing was found to mark",
  no_location: "its position is not known",
  inconsistent: "its evidence disagrees with the measurement",
  page_missing: "it refers to a page that does not exist",
  empty_box: "its box is empty",
  outside_page: "its box lies outside the page",
};

function EvidenceSummary({
  trust,
  evidence,
  placed,
}: {
  trust: Trust;
  evidence: ViewerEvidence | null;
  placed: readonly PlacedEvidence[];
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
  return (
    <div data-testid="evidence-status" className="text-sm">
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
