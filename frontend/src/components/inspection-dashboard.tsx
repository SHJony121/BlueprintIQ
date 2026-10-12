"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { RunInspection } from "@/api/client";
import { describeFailure, describeFileProblem } from "@/inspection/failure-copy";
import { DEMO_FORM, parseRequirements, type RequirementsForm } from "@/inspection/requirements";
import type { InspectionState } from "@/inspection/state";
import { useInspection } from "@/inspection/use-inspection";
import { ErrorPanel } from "./error-panel";
import type { InspectionReport } from "@/api/types";
import type { FindingLocation } from "./findings-list";
import { ReportView } from "./report-view";
import { RequirementsPanel } from "./requirements-panel";
import { EmptyResults, ResultsSkeleton, StaleResults } from "./results-placeholders";
import { UploadPanel } from "./upload-panel";
import { UNPLACED_TEXT, buildViewerEvidence, type ViewerEvidence } from "@/viewer/evidence";
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
  const { state, select, retry, rerun, cancel } = useInspection(run);
  const [form, setForm] = useState<RequirementsForm>(DEMO_FORM);
  const requirements = useMemo(() => parseRequirements(form), [form]);
  const valid = requirements.ok ? requirements : null;

  // Results belong to the requirements they were produced with. If the form no longer
  // describes them (changed or invalid), they are hidden, never shown beside new values.
  const stale = state.status === "succeeded" && (valid === null || valid.key !== state.requirementsKey);
  const hasFile = state.status === "succeeded" || state.status === "failed" || state.status === "waiting";
  const runLabel = !hasFile ? null : state.status === "succeeded" && !stale ? "Run again" : "Run inspection";

  // The viewer always shows the file of the current state, and evidence only from that
  // same state's report: a new selection replaces both at once.
  const viewerFile =
    state.status === "running" || state.status === "failed" || state.status === "succeeded" || state.status === "waiting"
      ? state.file
      : null;
  const report = state.status === "succeeded" && !stale ? state.report : null;
  const evidence = useMemo(() => (report === null ? null : buildViewerEvidence(report)), [report]);
  const locations = useMemo(() => (evidence === null ? new Map<string, FindingLocation>() : locationsOf(evidence)), [evidence]);

  // The selection belongs to one report object: a new document gives a new report (or none),
  // so a selection can never outlive the inspection it was made on.
  const [selection, setSelection] = useState<{
    report: InspectionReport;
    findingId: string;
    source: "finding" | "box";
    seq: number;
  } | null>(null);
  const active = selection !== null && selection.report === report ? selection : null;
  const choose = useCallback(
    (findingId: string, source: "finding" | "box") => {
      if (report === null) return;
      setSelection((current) =>
        current !== null && current.report === report && current.findingId === findingId
          ? null // choosing the selected finding again deselects it
          : { report, findingId, source, seq: (current?.seq ?? 0) + 1 },
      );
    },
    [report],
  );
  // A box was chosen: bring its finding into view in the findings panel, only if it is not
  // already visible, and without moving keyboard focus.
  const boxSeq = active?.source === "box" ? active.seq : null;
  const boxFinding = active?.findingId;
  useEffect(() => {
    if (boxSeq === null || boxFinding === undefined) return;
    const element = document.getElementById(`finding-${boxFinding}`);
    if (element === null) return;
    const r = element.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) element.scrollIntoView({ block: "nearest" });
  }, [boxSeq, boxFinding]);
  const phase: InspectionPhase =
    state.status === "running"
      ? "running"
      : state.status === "failed"
        ? "failed"
        : stale
          ? "stale"
          : state.status === "succeeded"
            ? "succeeded"
            : "none";
  return (
    <div className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6">
      <h1 className="mb-4 text-xl font-semibold tracking-tight text-balance">Inspect a drawing</h1>
      <UploadPanel state={state} onFiles={(files) => select(files, valid)} onCancel={cancel} />
      <RequirementsPanel
        form={form}
        result={requirements}
        onChange={setForm}
        runLabel={state.status === "running" ? null : runLabel}
        onRun={() => valid !== null && rerun(valid)}
      />
      <Announcer state={state} stale={stale} />
      <Problem state={state} onRetry={retry} />
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <ViewerSlot
          file={viewerFile}
          evidence={evidence}
          inspection={phase}
          pdfSource={pdfSource}
          selectedFindingId={active?.findingId ?? null}
          revealToken={active?.source === "finding" ? active.seq : null}
          onSelectFinding={(id) => choose(id, "box")}
        />
        <section aria-labelledby="results-heading" aria-busy={state.status === "running"}>
          <h2 id="results-heading" className="mb-3 text-base font-semibold">
            Results
          </h2>
          <Results state={state} stale={stale} canRun={valid !== null} selectedId={active?.findingId ?? null} onSelect={(id) => choose(id, "finding")} locations={locations} />
        </section>
      </div>
    </div>
  );
}

function Results({
  state,
  stale,
  canRun,
  selectedId,
  onSelect,
  locations,
}: {
  state: InspectionState;
  stale: boolean;
  canRun: boolean;
  selectedId: string | null;
  onSelect: (findingId: string) => void;
  locations: ReadonlyMap<string, FindingLocation>;
}) {
  switch (state.status) {
    case "running":
      return <ResultsSkeleton />;
    case "succeeded":
      if (stale) return <StaleResults canRun={canRun} />;
      return <ReportView report={state.report} selectedId={selectedId} onSelect={onSelect} locations={locations} />;
    case "idle":
      return <EmptyResults />;
    case "waiting":
      return <EmptyResults waiting />;
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
function Announcer({ state, stale }: { state: InspectionState; stale: boolean }) {
  return (
    <p role="status" className="sr-only">
      {stale ? "The requirements changed. Run the inspection again." : announcement(state)}
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

function locationsOf(evidence: ViewerEvidence): Map<string, FindingLocation> {
  const result = new Map<string, FindingLocation>();
  const get = (id: string) => {
    let entry = result.get(id);
    if (entry === undefined) {
      entry = { boxes: 0, notMarked: [] };
      result.set(id, entry);
    }
    return entry as { boxes: number; notMarked: string[] };
  };
  for (const item of evidence.items) get(item.findingId).boxes += 1;
  for (const u of evidence.unplaced) {
    const reason = UNPLACED_TEXT[u.reason];
    const entry = get(u.findingId);
    if (!entry.notMarked.includes(reason)) entry.notMarked.push(reason);
  }
  return result;
}
