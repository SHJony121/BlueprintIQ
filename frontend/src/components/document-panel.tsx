import type { InspectionReport } from "@/api/types";
import { formatBytes, formatMs, formatPage } from "@/inspection/labels";

export function DocumentPanel({ report }: { report: InspectionReport }) {
  const { document, ruleset } = report;
  return (
    <section aria-labelledby="document-heading">
      <h3 id="document-heading" className="text-base font-semibold">
        Source document
      </h3>
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-md border border-line bg-surface p-4 text-sm">
        <dt className="text-muted">File name</dt>
        <dd className="font-mono break-all">
          {document.filename ?? <span className="font-sans text-muted">Not provided</span>}
        </dd>
        <dt className="text-muted">Size</dt>
        <dd className="font-mono">{formatBytes(document.size_bytes)}</dd>
        <dt className="text-muted">{document.page_count === 1 ? "Page" : "Pages"}</dt>
        <dd className="font-mono">
          {document.pages.map((page) => (
            <span key={page.page_number} className="block">
              {document.page_count > 1 && `${page.page_number}: `}
              {formatPage(page)}
            </span>
          ))}
        </dd>
        <dt className="text-muted">SHA-256</dt>
        <dd className="font-mono text-xs break-all">{document.sha256}</dd>
        <dt className="text-muted">Ruleset</dt>
        <dd className="font-mono">
          {ruleset.id} {ruleset.version}
        </dd>
        <dt className="text-muted">Processing time</dt>
        <dd className="font-mono">{formatMs(report.processing_time_ms)}</dd>
      </dl>
    </section>
  );
}
