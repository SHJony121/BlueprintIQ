import type { Finding, Measurement } from "@/api/types";
import { FINDING_ORDER, SEVERITY_LABEL, measurementTypeLabel } from "@/inspection/labels";
import { FindingBadge } from "./status-badge";

interface FindingsListProps {
  findings: readonly Finding[];
  measurements: readonly Measurement[];
}

/** Problems first; the backend's order is kept within each outcome. */
function byOutcome(findings: readonly Finding[]): Finding[] {
  return findings.toSorted(
    (a, b) => FINDING_ORDER.indexOf(a.status) - FINDING_ORDER.indexOf(b.status),
  );
}

export function FindingsList({ findings, measurements }: FindingsListProps) {
  const byId = new Map(measurements.map((m) => [m.id, m]));
  return (
    <section aria-labelledby="findings-heading">
      <h3 id="findings-heading" className="text-base font-semibold">
        Findings <span className="font-normal text-muted">({findings.length})</span>
      </h3>
      {findings.length === 0 ? (
        <p className="mt-2 text-sm text-muted">The ruleset produced no findings for this drawing.</p>
      ) : (
        <ol className="mt-3 flex flex-col gap-3">
          {byOutcome(findings).map((finding) => (
            <FindingItem key={finding.id} finding={finding} measurements={byId} />
          ))}
        </ol>
      )}
    </section>
  );
}

function FindingItem({
  finding,
  measurements,
}: {
  finding: Finding;
  measurements: ReadonlyMap<string, Measurement>;
}) {
  return (
    <li
      id={`finding-${finding.id}`}
      data-status={finding.status}
      className="defer-render rounded-md border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <FindingBadge status={finding.status} />
        <span className="font-mono text-sm font-medium">{finding.rule_id}</span>
        <span className="text-sm text-muted">Severity: {SEVERITY_LABEL[finding.severity]}</span>
        <span className="ml-auto font-mono text-xs text-muted">{finding.id}</span>
      </div>
      <h4 className="mt-2 text-base font-medium text-balance">{finding.rule_description}</h4>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted">Expected</dt>
          <dd className="font-mono text-sm break-words">{finding.expected}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Actual</dt>
          <dd className="font-mono text-sm break-words">
            {finding.actual ?? <span className="font-sans text-muted">Not found in the drawing</span>}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-sm">{finding.message}</p>
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="text-muted">Measurements:</span>
        {finding.measurement_ids.length === 0 ? (
          <span className="text-muted">none, nothing matched</span>
        ) : (
          finding.measurement_ids.map((id) => {
            const measurement = measurements.get(id);
            return (
              <a
                key={id}
                href={`#measurement-${id}`}
                className="rounded-sm border border-line px-1.5 py-0.5 hover:border-accent"
              >
                <span className="font-mono font-medium">{id}</span>
                {measurement !== undefined && (
                  <span className="text-muted"> {measurementTypeLabel(measurement)}</span>
                )}
              </a>
            );
          })
        )}
      </div>
    </li>
  );
}
