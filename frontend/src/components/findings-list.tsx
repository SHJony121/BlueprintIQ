import type { Finding, Measurement } from "@/api/types";
import { FINDING_ORDER, SEVERITY_LABEL, measurementTypeLabel } from "@/inspection/labels";
import { FindingBadge } from "./status-badge";

/** Where a finding's evidence can be seen on the drawing, from the report alone. */
export interface FindingLocation {
  boxes: number;
  /** Why some or all of its evidence is not marked, in words. */
  notMarked: readonly string[];
}

interface FindingsListProps {
  findings: readonly Finding[];
  measurements: readonly Measurement[];
  selectedId: string | null;
  onSelect: (findingId: string) => void;
  locations: ReadonlyMap<string, FindingLocation>;
}

/** Problems first; the backend's order is kept within each outcome. */
function byOutcome(findings: readonly Finding[]): Finding[] {
  return findings.toSorted(
    (a, b) => FINDING_ORDER.indexOf(a.status) - FINDING_ORDER.indexOf(b.status),
  );
}

export function FindingsList({ findings, measurements, selectedId, onSelect, locations }: FindingsListProps) {
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
            <FindingItem
              key={finding.id}
              finding={finding}
              measurements={byId}
              selected={finding.id === selectedId}
              location={locations.get(finding.id)}
              onSelect={onSelect}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function FindingItem({
  finding,
  measurements,
  selected,
  location,
  onSelect,
}: {
  finding: Finding;
  measurements: ReadonlyMap<string, Measurement>;
  selected: boolean;
  location: FindingLocation | undefined;
  onSelect: (findingId: string) => void;
}) {
  return (
    <li
      id={`finding-${finding.id}`}
      data-status={finding.status}
      data-selected={selected ? "true" : undefined}
      // Mouse convenience: the whole card selects. Links and buttons inside keep their own action.
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest("a, button")) onSelect(finding.id);
      }}
      className={`rounded-md border bg-surface p-4 ${
        selected ? "border-accent outline-2 outline-offset-0 outline-accent" : "border-line"
      }`}
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
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line pt-3 text-sm">
        <p data-testid={`location-${finding.id}`} className="text-muted">
          {locationText(location)}
        </p>
        <button
          type="button"
          aria-pressed={selected}
          aria-label={`Select finding ${finding.id}`}
          onClick={() => onSelect(finding.id)}
          className="rounded-md border border-line bg-surface px-3 py-1 font-medium hover:border-accent aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-accent-ink"
        >
          {selected ? "Selected" : "Select"}
        </button>
      </div>
    </li>
  );
}

function locationText(location: FindingLocation | undefined): string {
  if (location === undefined) return "";
  const boxes = location.boxes === 1 ? "1 evidence box" : `${location.boxes} evidence boxes`;
  const missing = location.notMarked.length > 0 ? `Not marked: ${location.notMarked.join("; ")}.` : "";
  if (location.boxes === 0) return missing || "Not marked on the drawing.";
  return `${boxes} on the drawing.${missing ? ` ${missing}` : ""}`;
}
