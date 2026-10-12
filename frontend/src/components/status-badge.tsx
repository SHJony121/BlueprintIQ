import type { ExtractionStatus, FindingStatus } from "@/api/types";
import { EXTRACTION_LABEL, FINDING_LABEL } from "@/inspection/labels";

// Full class names (not built from strings) so Tailwind can see them.
const FINDING_CLASS: Record<FindingStatus, string> = {
  fail: "bg-fail-tint text-fail",
  needs_review: "bg-review-tint text-review",
  missing: "bg-missing-tint text-missing",
  pass: "bg-pass-tint text-pass",
};

const BADGE = "inline-flex items-center rounded-sm px-2 py-0.5 text-xs font-semibold";

/** The outcome of a rule. Always readable as text; colour only reinforces it. */
export function FindingBadge({ status }: { status: FindingStatus }) {
  return <span className={`${BADGE} ${FINDING_CLASS[status]}`}>{FINDING_LABEL[status]}</span>;
}

/**
 * How trustworthy a read value is. Deliberately a different shape (outlined, neutral)
 * from the finding outcomes, which are a separate concept and must not be confused.
 */
export function ExtractionBadge({ status }: { status: ExtractionStatus }) {
  const style =
    status === "ambiguous"
      ? "border-review text-review"
      : "border-line text-muted";
  return (
    <span className={`${BADGE} border bg-surface ${style}`}>{EXTRACTION_LABEL[status]}</span>
  );
}
