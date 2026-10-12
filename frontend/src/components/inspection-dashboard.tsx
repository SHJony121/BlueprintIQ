"use client";

import { useMemo } from "react";
import type { RunInspection } from "@/api/client";
import { describeFailure, describeFileProblem } from "@/inspection/failure-copy";
import type { InspectionState } from "@/inspection/state";
import { useInspection } from "@/inspection/use-inspection";
import { ErrorPanel } from "./error-panel";
import { ReportView } from "./report-view";
import { EmptyResults, ResultsSkeleton } from "./results-placeholders";
import { UploadPanel } from "./upload-panel";
import { buildViewerEvidence } from "@/viewer/evidence";
import type { InspectionPhase } from "@/viewer/drawing-viewer";
import type { PdfSource } from "@/viewer/pdf-source";
import { ViewerSlot } from "./viewer-slot";

interface InspectionDashboardProps {
  /** Replaceable so tests can drive the screen without a network. */
  run?: RunInspection;
  /** Replaceable so tests can drive the viewer without PDF.js or a canvas. */
  pdfSource?: PdfSource;
}

export function InspectionDashboard({ run, pdfSource }: InspectionDashboardProps) {
  const { state, select, retry, cancel } = useInspection(run);
  // The viewer always shows the file of the current state, and evidence only from that
  // same state's report: a new selection replaces both at once.
  const viewerFile = state.status === "running" || state.status === "failed" || state.status === "succeeded" ? state.file : null;
  const report = state.status === "succeeded" ? state.report : null;
  const evidence = useMemo(() => (report === null ? null : buildViewerEvidence(report)), [report]);
  const phase: InspectionPhase =
    state.status === "running" ? "running" : state.status === "failed" ? "failed" : state.status === "succeeded" ? "succeeded" : "none";
  return (
    <div className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6">
      <h1 className="mb-4 text-xl font-semibold tracking-tight text-balance">Inspect a drawing</h1>
      <UploadPanel state={state} onFiles={select} onCancel={cancel} />
      <Announcer state={state} />
      <Problem state={state} onRetry={retry} />
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <ViewerSlot file={viewerFile} evidence={evidence} inspection={phase} pdfSource={pdfSource} />
        <section aria-labelledby="results-heading" aria-busy={state.status === "running"}>
          <h2 id="results-heading" className="mb-3 text-base font-semibold">
            Results
          </h2>
          <Results state={state} />
        </section>
      </div>
    </div>
  );
}

function Results({ state }: { state: InspectionState }) {
  switch (state.status) {
    case "running":
      return <ResultsSkeleton />;
    case "succeeded":
      return <ReportView report={state.report} />;
    case "idle":
      return <EmptyResults />;
    case "rejected":
    case "failed":
      return <EmptyResults afterProblem />;
  }
}

/** A file refused in the browser, or an inspection that did not produce a report. */
function Problem({ state, onRetry }: { state: InspectionState; onRetry: () => void }) {
  if (state.status === "rejected") {
    return <ErrorPanel copy={describeFileProblem(state.problem, state.fileName, state.sizeBytes)} />;
  }
  if (state.status === "failed") {
    return <ErrorPanel copy={describeFailure(state.failure)} onRetry={onRetry} />;
  }
  return null;
}

// Spoken updates for screen readers. Always in the DOM so changes are announced; errors
// are announced by their own role="alert".
function Announcer({ state }: { state: InspectionState }) {
  return (
    <p role="status" className="sr-only">
      {announcement(state)}
    </p>
  );
}

function announcement(state: InspectionState): string {
  switch (state.status) {
    case "running":
      return `Inspecting ${state.file.name}.`;
    case "succeeded": {
      const { summary } = state.report;
      return `Inspection complete: ${summary.failed} fail, ${summary.needs_review} need review, ${summary.missing} missing, ${summary.passed} pass.`;
    }
    default:
      return "";
  }
}
