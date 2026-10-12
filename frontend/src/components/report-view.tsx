import type { InspectionReport } from "@/api/types";
import { DocumentPanel } from "./document-panel";
import { FindingsList } from "./findings-list";
import { MeasurementList, UnrecognizedList } from "./measurement-list";
import { SummaryCards } from "./summary-cards";

/** A successful inspection. Only ever given a report that passed the response checks. */
export function ReportView({ report }: { report: InspectionReport }) {
  return (
    <div className="flex flex-col gap-6">
      <SummaryCards summary={report.summary} />
      <FindingsList findings={report.findings} measurements={report.measurements} />
      <MeasurementList measurements={report.measurements} />
      <UnrecognizedList annotations={report.unrecognized_annotations} />
      <DocumentPanel report={report} />
    </div>
  );
}
