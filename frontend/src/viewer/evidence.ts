// Which evidence boxes may be drawn, taken from a report that already passed the response
// checks (src/api/read-response.ts). Nothing is guessed: a finding whose evidence has no
// location, disagrees with its measurement, or lies off its page is listed as unplaced
// with the reason, and no box is drawn for it.
import type { BBox, FindingStatus, InspectionReport, PageInfo, Severity } from "@/api/types";
import { FINDING_LABEL } from "@/inspection/labels";
import { boxProblem } from "./geometry";

export interface EvidenceItem {
  /** Unique per finding and measurement: "F4:M3". */
  key: string;
  findingId: string;
  ruleId: string;
  status: FindingStatus;
  severity: Severity;
  measurementId: string;
  pageNumber: number;
  /** Page space (backend coordinates). */
  bbox: BBox;
  /** Spoken description, for assistive technology. */
  description: string;
}

export type UnplacedReason =
  | "no_measurement" // the finding has no evidence at all (a missing finding)
  | "no_location" // the evidence exists, but its position is unknown
  | "inconsistent" // the evidence disagrees with the measurement it names
  | "page_missing" // the evidence is on a page the document does not have
  | "empty_box"
  | "outside_page";

export interface UnplacedEvidence {
  findingId: string;
  measurementId: string | null;
  status: FindingStatus;
  reason: UnplacedReason;
}

/** Everything the viewer needs from an inspection, and nothing else. */
export interface ViewerEvidence {
  documentSha256: string;
  documentSizeBytes: number;
  pages: readonly PageInfo[];
  items: readonly EvidenceItem[];
  unplaced: readonly UnplacedEvidence[];
}

const sameBox = (a: BBox, b: BBox) => a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;

export function buildViewerEvidence(report: InspectionReport): ViewerEvidence {
  const measurements = new Map(report.measurements.map((m) => [m.id, m]));
  const pages = new Map(report.document.pages.map((p) => [p.page_number, p]));
  const items: EvidenceItem[] = [];
  const unplaced: UnplacedEvidence[] = [];

  for (const finding of report.findings) {
    if (finding.evidence.length === 0) {
      unplaced.push({ findingId: finding.id, measurementId: null, status: finding.status, reason: "no_measurement" });
      continue;
    }
    for (const ref of finding.evidence) {
      const note = (reason: UnplacedReason) =>
        unplaced.push({ findingId: finding.id, measurementId: ref.measurement_id, status: finding.status, reason });
      const source = measurements.get(ref.measurement_id)?.source;
      if (ref.bbox === null) {
        note("no_location");
        continue;
      }
      // The evidence is a copy of the measurement's source; if they differ, trust neither.
      if (
        source === undefined ||
        source.page_number !== ref.page_number ||
        source.bbox === null ||
        source.bbox === undefined ||
        !sameBox(source.bbox, ref.bbox)
      ) {
        note("inconsistent");
        continue;
      }
      const page = pages.get(ref.page_number);
      if (page === undefined) {
        note("page_missing");
        continue;
      }
      const problem = boxProblem(page, ref.bbox);
      if (problem !== null) {
        note(problem);
        continue;
      }
      items.push({
        key: `${finding.id}:${ref.measurement_id}`,
        findingId: finding.id,
        ruleId: finding.rule_id,
        status: finding.status,
        severity: finding.severity,
        measurementId: ref.measurement_id,
        pageNumber: ref.page_number,
        bbox: ref.bbox,
        description: `${FINDING_LABEL[finding.status]}: ${finding.rule_id}, finding ${finding.id}, measurement ${ref.measurement_id}`,
      });
    }
  }

  return {
    documentSha256: report.document.sha256,
    documentSizeBytes: report.document.size_bytes,
    pages: report.document.pages,
    items,
    unplaced,
  };
}

/** Why a box is not drawn, in words (shared by the viewer and the findings list). */
export const UNPLACED_TEXT: Record<UnplacedReason, string> = {
  no_measurement: "nothing was found to mark",
  no_location: "its position is not known",
  inconsistent: "its evidence disagrees with the measurement",
  page_missing: "it refers to a page that does not exist",
  empty_box: "its box is empty",
  outside_page: "its box lies outside the page",
};
