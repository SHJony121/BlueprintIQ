import type { FindingStatus, FindingSummary } from "@/api/types";
import { FINDING_LABEL, FINDING_MEANING, FINDING_ORDER } from "@/inspection/labels";

const COUNT: Record<FindingStatus, (s: FindingSummary) => number> = {
  fail: (s) => s.failed,
  needs_review: (s) => s.needs_review,
  missing: (s) => s.missing,
  pass: (s) => s.passed,
};

// Tint only when there is something to look at; a zero stays quiet.
const ACTIVE: Record<FindingStatus, string> = {
  fail: "border-fail bg-fail-tint text-fail",
  needs_review: "border-review bg-review-tint text-review",
  missing: "border-missing bg-missing-tint text-missing",
  pass: "border-pass bg-pass-tint text-pass",
};

export function SummaryCards({ summary }: { summary: FindingSummary }) {
  return (
    <section aria-labelledby="summary-heading">
      <h3 id="summary-heading" className="sr-only">
        Findings by outcome
      </h3>
      <dl className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {FINDING_ORDER.map((status) => {
          const count = COUNT[status](summary);
          return (
            <div
              key={status}
              data-testid={`summary-${status}`}
              className={`rounded-md border p-3 ${
                count > 0 ? ACTIVE[status] : "border-line bg-surface text-muted"
              }`}
            >
              <dt className="text-sm font-semibold">{FINDING_LABEL[status]}</dt>
              <dd className="mt-1 font-mono text-3xl font-semibold tabular-nums">{count}</dd>
              <dd className="mt-1 text-xs">{FINDING_MEANING[status]}</dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
