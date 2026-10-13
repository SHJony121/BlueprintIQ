import type { CadAnnotation, SourceEvidence } from "@/api/types";
import { ISSUE_LABEL, NBSP, formatBox } from "@/inspection/labels";
import { ExtractionBadge } from "./status-badge";

const KIND: Record<NonNullable<CadAnnotation["dimension_kind"]>, string> = {
  linear: "Linear dimension",
  diameter: "Diameter",
  radius: "Radius",
  angle: "Angle",
};
const UNIT_FROM: Record<CadAnnotation["unit_source"], string> = {
  annotation: "unit written in the annotation",
  drawing_note: "unit from the drawing note",
  symbol: "unit from the degree sign",
  none: "no unit stated",
};
const UNIT_TEXT = { mm: "mm", deg: "°" } as const;

/**
 * CAD dimensions and tolerances as written. Deliberately apart from the findings: none of
 * these is matched to a part feature or checked against a rule.
 */
export function CadAnnotationList({
  annotations,
  unitNote,
}: {
  annotations: readonly CadAnnotation[];
  unitNote: SourceEvidence | null;
}) {
  if (annotations.length === 0) return null;
  return (
    <section aria-labelledby="cad-heading" data-testid="cad-annotations">
      <h3 id="cad-heading" className="text-base font-semibold">
        CAD annotations{" "}
        <span className="font-normal text-muted">({annotations.length})</span>
      </h3>
      <p className="mt-1 text-sm text-muted">
        Dimensions and tolerances read as written. They are not matched to any
        feature of the part and no rule checks them, so they never produce a
        pass or fail. A tolerance is shown only if it is on the same line as its
        value.
      </p>
      {unitNote !== null && (
        <p className="mt-1 text-sm text-muted">
          Unit note on the drawing:{" "}
          <span className="font-mono">&ldquo;{unitNote.raw_text}&rdquo;</span>
        </p>
      )}
      <ul className="mt-3 divide-y divide-line rounded-md border border-line bg-surface">
        {annotations.map((a) => (
          <li key={a.id} id={`cad-${a.id}`} className="defer-render px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-sm font-medium">{a.id}</span>
              <span className="text-sm">
                {a.dimension_kind === null
                  ? "Not understood"
                  : KIND[a.dimension_kind]}
              </span>
              <ExtractionBadge status={a.status} />
            </div>
            <p className="mt-1 font-mono text-base break-words">
              <Reading annotation={a} />
            </p>
            {a.issues.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-sm text-review">
                {a.issues.map((issue) => (
                  <li key={issue}>{ISSUE_LABEL[issue]}</li>
                ))}
              </ul>
            )}
            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
              <dt className="text-muted">Source text</dt>
              <dd className="font-mono break-words">
                &ldquo;{a.source.raw_text}&rdquo;
              </dd>
              {a.tolerance_parts.length === 2 && (
                <>
                  <dt className="text-muted">Tolerance (separate lines)</dt>
                  <dd className="font-mono break-words">
                    &ldquo;{a.tolerance_parts[0]!.raw_text}&rdquo; above, &ldquo;
                    {a.tolerance_parts[1]!.raw_text}&rdquo; below
                    <span className="font-sans text-muted">
                      {" "}
                      (reconstructed from their position; each line is shown as printed)
                    </span>
                  </dd>
                </>
              )}
              <dt className="text-muted">Page</dt>
              <dd className="font-mono">{a.source.page_number}</dd>
              <dt className="text-muted">Location</dt>
              <dd className="font-mono">
                {a.source.bbox ? (
                  formatBox(a.source.bbox)
                ) : (
                  <span className="font-sans">Not available</span>
                )}
              </dd>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Reading({ annotation: a }: { annotation: CadAnnotation }) {
  if (a.nominal === null)
    return <span className="font-sans text-sm text-muted">No value read</span>;
  const unit = a.unit === null || a.unit === undefined ? "" : UNIT_TEXT[a.unit];
  const space = a.unit === "mm" ? NBSP : "";
  return (
    <>
      {a.dimension_kind === "diameter" && "Ø"}
      {a.dimension_kind === "radius" && "R"}
      {a.nominal}
      {unit !== "" && `${space}${unit}`}
      {a.upper_deviation != null && a.lower_deviation != null && (
        <span>
          {" "}
          {a.upper_deviation === a.lower_deviation.replace("-", "")
            ? `±${a.upper_deviation}`
            : `+${a.upper_deviation} / ${a.lower_deviation}`}
        </span>
      )}
      <span className="font-sans text-sm text-muted">
        {" "}
        ({a.unit_source === "none" ? UNIT_FROM.none : UNIT_FROM[a.unit_source]})
      </span>
    </>
  );
}
