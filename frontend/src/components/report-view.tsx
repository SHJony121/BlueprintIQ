import type { InspectionReport } from "@/api/types";
import { AppliedRequirements } from "./applied-requirements";
import { DocumentPanel } from "./document-panel";
import { IncompleteExtraction } from "./incomplete-extraction";
import { FindingsList, type FindingLocation } from "./findings-list";
import { CadAnnotationList } from "./cad-annotation-list";
import { MeasurementList, UnrecognizedList } from "./measurement-list";
import { ResultsGuide } from "./results-guide";
import { SummaryCards } from "./summary-cards";

/** A successful inspection. Only ever given a report that passed the response checks. */
export function ReportView({
  report,
  selectedId = null,
  onSelect = () => {},
  locations = new Map<string, FindingLocation>(),
  associationId = null,
  onSelectAssociation = () => {},
}: {
  report: InspectionReport;
  selectedId?: string | null;
  onSelect?: (findingId: string) => void;
  locations?: ReadonlyMap<string, FindingLocation>;
  associationId?: string | null;
  onSelectAssociation?: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <IncompleteExtraction skipped={report.skipped_angled_lines} />
      <AppliedRequirements report={report} />
      <SummaryCards summary={report.summary} />
      <ResultsGuide />
      <FindingsList
        findings={report.findings}
        measurements={report.measurements}
        selectedId={selectedId}
        onSelect={onSelect}
        locations={locations}
      />
      <MeasurementList measurements={report.measurements} />
      <CadAnnotationList
        annotations={report.cad_annotations}
        unitNote={report.cad_unit_note ?? null}
        associations={report.feature_associations}
        selectedAssociationId={associationId}
        onSelectAssociation={onSelectAssociation}
      />
      <UnrecognizedList annotations={report.unrecognized_annotations} />
      <DocumentPanel report={report} />
    </div>
  );
}
