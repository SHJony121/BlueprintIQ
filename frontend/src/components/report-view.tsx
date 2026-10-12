import type { InspectionReport } from "@/api/types";
import { DocumentPanel } from "./document-panel";
import { FindingsList, type FindingLocation } from "./findings-list";
import { MeasurementList, UnrecognizedList } from "./measurement-list";
import { SummaryCards } from "./summary-cards";

/** A successful inspection. Only ever given a report that passed the response checks. */
export function ReportView({
  report,
  selectedId = null,
  onSelect = () => {},
  locations = new Map<string, FindingLocation>(),
}: {
  report: InspectionReport;
  selectedId?: string | null;
  onSelect?: (findingId: string) => void;
  locations?: ReadonlyMap<string, FindingLocation>;
}) {
  return (
    <div className="flex flex-col gap-6">
      <SummaryCards summary={report.summary} />
      <FindingsList
        findings={report.findings}
        measurements={report.measurements}
        selectedId={selectedId}
        onSelect={onSelect}
        locations={locations}
      />
      <MeasurementList measurements={report.measurements} />
      <UnrecognizedList annotations={report.unrecognized_annotations} />
      <DocumentPanel report={report} />
    </div>
  );
}
