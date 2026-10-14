"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunInspection } from "@/api/client";
import { describeFailure, describeFileProblem } from "@/inspection/failure-copy";
import { DEMO_FORM, parseRequirements, type RequirementsForm } from "@/inspection/requirements";
import type { InspectionState } from "@/inspection/state";
import { loadSample, sampleById, type Sample } from "@/inspection/samples";
import { useInspection } from "@/inspection/use-inspection";
import { ErrorPanel } from "./error-panel";
import type { InspectionReport } from "@/api/types";
import type { FindingLocation } from "./findings-list";
import { ReportView } from "./report-view";
import { RequirementsPanel } from "./requirements-panel";
import { EmptyResults, ResultsSkeleton, StaleResults } from "./results-placeholders";
import { SamplePicker } from "./sample-picker";
import { UploadPanel } from "./upload-panel";
import { UNPLACED_TEXT, buildViewerEvidence, type ViewerEvidence } from "@/viewer/evidence";
import type { InspectionPhase } from "@/viewer/drawing-viewer";
import type { PdfSource } from "@/viewer/pdf-source";
import { ViewerSlot } from "./viewer-slot";

interface InspectionDashboardProps {
  /** Replaceable so tests can drive the screen without a network. */
  run?: RunInspection;
  /** Replaceable so tests can supply a sample without fetching it. */
  fetchSample?: (sample: Sample) => Promise<File>;
  /** Replaceable so tests can drive the viewer without PDF.js or a canvas. */
  pdfSource?: PdfSource;
}

export function InspectionDashboard({ run, pdfSource, fetchSample = loadSample }: InspectionDashboardProps) {
  const { state, select, retry, rerun, cancel } = useInspection(run);
  const [form, setForm] = useState<RequirementsForm>(DEMO_FORM);
  const requirements = useMemo(() => parseRequirements(form), [form]);
  const valid = requirements.ok ? requirements : null;

  // A sample is fetched from this site and then chosen like any file the visitor picked.
  const [loadingSample, setLoadingSample] = useState<Sample["id"] | null>(null);
  const [sampleFailed, setSampleFailed] = useState(false);
  const chooseSample = useCallback(
    async (sample: Sample) => {
      setSampleFailed(false);
      setLoadingSample(sample.id);
      try {
        const file = await fetchSample(sample);
        select([file], valid);
      } catch {
        setSampleFailed(true);
      } finally {
        setLoadingSample(null);
      }
    },
    [fetchSample, select, valid],
  );
  // /inspect?sample=cad opens with that sample already running (the landing page links here).
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    const wanted = sampleById(new URLSearchParams(window.location.search).get("sample"));
    if (wanted !== null) queueMicrotask(() => void chooseSample(wanted));
  }, [chooseSample]);

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
  // A selected feature association, also tied to one report object.
  const [associationChoice, setAssociationChoice] = useState<{ report: InspectionReport; id: string } | null>(null);
  const association =
    report !== null && associationChoice !== null && associationChoice.report === report
      ? (report.feature_associations.find((a) => a.id === associationChoice.id) ?? null)
      : null;
  const chooseAssociation = useCallback(
    (id: string) => {
      if (report === null) return;
      setAssociationChoice((current) =>
        current !== null && current.report === report && current.id === id ? null : { report, id },
      );
    },
    [report],
  );
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
      <h1 className="text-xl font-semibold tracking-tight text-balance">Inspect a drawing</h1>
      <p className="mb-4 mt-1 max-w-3xl text-sm text-muted">
        Upload a one-page engineering drawing PDF to read its labelled measurements, material and CAD
        dimensions, and to check them against the limits below. The file is sent to the server for
        inspection (see Privacy in the menu above).
      </p>
      <UploadPanel state={state} onFiles={(files) => select(files, valid)} onCancel={cancel} />
      {state.status === "idle" && (
        <SamplePicker onChoose={(sample) => void chooseSample(sample)} loading={loadingSample} failed={sampleFailed} />
      )}
      <RequirementsPanel
        form={form}
        result={requirements}
        onChange={setForm}
        runLabel={state.status === "running" ? null : runLabel}
        onRun={() => valid !== null && rerun(valid)}
        collapsed={state.status === "succeeded" && !stale}
      />
      <Announcer state={state} stale={stale} />
      <Problem state={state} onRetry={retry} />
      {viewerFile !== null && (
        <p
          data-testid="desktop-note"
          className="mt-4 rounded-md border border-line border-l-4 border-l-accent bg-surface p-3 text-sm lg:hidden"
        >
          The drawing viewer, which highlights where each result sits on the page, needs a wider
          screen. Use a desktop or a tablet in landscape for that; the results below are complete
          without it.{" "}
          <a className="font-medium text-accent underline underline-offset-4" href="#results-heading">
            Jump to the results
          </a>
        </p>
      )}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <ViewerSlot
          file={viewerFile}
          evidence={evidence}
          inspection={phase}
          pdfSource={pdfSource}
          selectedFindingId={active?.findingId ?? null}
          revealToken={active?.source === "finding" ? active.seq : null}
          onSelectFinding={(id) => choose(id, "box")}
          association={association}
        />
        <section aria-labelledby="results-heading" aria-busy={state.status === "running"}>
          <h2 id="results-heading" className="mb-3 text-base font-semibold">
            Results
          </h2>
          <Results
            state={state}
            stale={stale}
            canRun={valid !== null}
            selectedId={active?.findingId ?? null}
            onSelect={(id) => choose(id, "finding")}
            locations={locations}
            associationId={association?.id ?? null}
            onSelectAssociation={chooseAssociation}
          />
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
  associationId,
  onSelectAssociation,
}: {
  state: InspectionState;
  stale: boolean;
  canRun: boolean;
  selectedId: string | null;
  onSelect: (findingId: string) => void;
  locations: ReadonlyMap<string, FindingLocation>;
  associationId: string | null;
  onSelectAssociation: (id: string) => void;
}) {
  switch (state.status) {
    case "running":
      return <ResultsSkeleton />;
    case "succeeded":
      if (stale) return <StaleResults canRun={canRun} />;
      return (
        <ReportView
          report={state.report}
          selectedId={selectedId}
          onSelect={onSelect}
          locations={locations}
          associationId={associationId}
          onSelectAssociation={onSelectAssociation}
        />
      );
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
