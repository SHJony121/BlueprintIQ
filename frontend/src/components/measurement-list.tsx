import type { Measurement, SourceEvidence, UnrecognizedAnnotation } from "@/api/types";
import { ISSUE_LABEL, NBSP, formatBox, measurementTypeLabel } from "@/inspection/labels";
import { ExtractionBadge } from "./status-badge";

export function MeasurementList({ measurements }: { measurements: readonly Measurement[] }) {
  return (
    <section aria-labelledby="measurements-heading">
      <h3 id="measurements-heading" className="text-base font-semibold">
        Extracted measurements <span className="font-normal text-muted">({measurements.length})</span>
      </h3>
      {measurements.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No supported annotation was read from the drawing.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line rounded-md border border-line bg-surface">
          {measurements.map((m) => (
            <MeasurementItem key={m.id} measurement={m} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MeasurementItem({ measurement: m }: { measurement: Measurement }) {
  return (
    <li id={`measurement-${m.id}`} className="defer-render px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-sm font-medium">{m.id}</span>
        <span className="text-sm">{measurementTypeLabel(m)}</span>
        <ExtractionBadge status={m.status} />
      </div>
      <p className="mt-1 font-mono text-base break-words">
        <Reading measurement={m} />
      </p>
      {m.issues.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-sm text-review">
          {m.issues.map((issue) => (
            <li key={issue}>{ISSUE_LABEL[issue]}</li>
          ))}
        </ul>
      )}
      <Source source={m.source} label={m.kind === "material" ? m.label_source : null} />
    </li>
  );
}

/** The value as read, with nothing inferred: an unread value says so. */
function Reading({ measurement: m }: { measurement: Measurement }) {
  if (m.value === null) return <span className="font-sans text-sm text-muted">No value read</span>;
  if (m.kind === "material") return <>{m.value}</>;
  return (
    <>
      {m.value}
      {m.unit !== null && `${NBSP}${m.unit}`}
      {m.normalized_value_mm !== null && m.unit !== "mm" && (
        <span className="text-sm text-muted"> = {m.normalized_value_mm}{NBSP}mm</span>
      )}
    </>
  );
}

function Source({
  source,
  label = null,
}: {
  source: SourceEvidence;
  label?: SourceEvidence | null;
}) {
  return (
    <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
      {label !== null && (
        <>
          <dt className="text-muted">Label (separate line)</dt>
          <dd className="font-mono break-words">
            &ldquo;{label.raw_text}&rdquo;
            {label.bbox && <span className="text-muted"> at {formatBox(label.bbox)}</span>}
          </dd>
        </>
      )}
      <dt className="text-muted">{label !== null ? "Value (same row, to the right)" : "Source text"}</dt>
      <dd className="font-mono break-words">&ldquo;{source.raw_text}&rdquo;</dd>
      <dt className="text-muted">Page</dt>
      <dd className="font-mono">{source.page_number}</dd>
      <dt className="text-muted">Location</dt>
      <dd className="font-mono">
        {source.bbox ? formatBox(source.bbox) : <span className="font-sans">Not available</span>}
      </dd>
    </dl>
  );
}

export function UnrecognizedList({
  annotations,
}: {
  annotations: readonly UnrecognizedAnnotation[];
}) {
  if (annotations.length === 0) return null;
  return (
    <section aria-labelledby="unrecognized-heading">
      <h3 id="unrecognized-heading" className="text-base font-semibold">
        Annotations not evaluated <span className="font-normal text-muted">({annotations.length})</span>
      </h3>
      <p className="mt-1 text-sm text-muted">
        These lines look like labelled annotations, but the ruleset has no rule for them.
      </p>
      <ul className="mt-3 divide-y divide-line rounded-md border border-line bg-surface">
        {annotations.map((annotation, index) => (
          <li key={`${annotation.label}-${index}`} className="defer-render px-4 py-3">
            <p className="text-sm font-medium">{annotation.label}</p>
            <Source source={annotation.source} />
          </li>
        ))}
      </ul>
    </section>
  );
}
