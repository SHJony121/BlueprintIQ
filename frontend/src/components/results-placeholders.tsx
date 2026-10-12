import { FINDING_LABEL, FINDING_MEANING, FINDING_ORDER } from "@/inspection/labels";

/**
 * Shown before any result, where it explains the four outcomes, and after a file was
 * refused or failed, where it only says there is nothing to show.
 */
export function EmptyResults({
  afterProblem = false,
  waiting = false,
}: {
  afterProblem?: boolean;
  waiting?: boolean;
}) {
  if (waiting) {
    return (
      <div data-testid="empty-results" className="rounded-md border border-line bg-surface p-4">
        <p className="text-sm text-muted">
          The file is chosen but not inspected. Fix the requirements above, then run the inspection.
        </p>
      </div>
    );
  }
  if (afterProblem) {
    return (
      <div data-testid="empty-results" className="rounded-md border border-line bg-surface p-4">
        <p className="text-sm text-muted">No results for this file. The reason is shown above.</p>
      </div>
    );
  }
  return (
    <div data-testid="empty-results" className="rounded-md border border-line bg-surface p-4">
      <p className="text-sm">
        Choose a PDF to run an inspection. Each rule in the ruleset is reported as one of four
        outcomes, with the text read from the drawing as evidence.
      </p>
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        {FINDING_ORDER.map((status) => (
          <div key={status} className="contents">
            <dt className="font-semibold">{FINDING_LABEL[status]}</dt>
            <dd className="text-muted">{FINDING_MEANING[status]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const BLOCK = "rounded-md bg-line motion-safe:animate-pulse";

/** Same shape as the finished results, so the page does not jump when they arrive. */
export function ResultsSkeleton() {
  return (
    <div aria-hidden="true" data-testid="results-skeleton" className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[0, 1, 2, 3].map((n) => (
          <div key={n} className={`${BLOCK} h-24`} />
        ))}
      </div>
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map((n) => (
          <div key={n} className={`${BLOCK} h-36`} />
        ))}
      </div>
    </div>
  );
}

/** Results that no longer match the requirements on screen are not shown at all. */
export function StaleResults({ canRun }: { canRun: boolean }) {
  return (
    <div data-testid="stale-results" className="rounded-md border border-line border-l-4 border-l-review bg-review-tint p-4">
      <p className="text-sm font-semibold text-review">The requirements changed</p>
      <p className="mt-1 text-sm">
        The previous results were produced with different requirements, so they are hidden.{" "}
        {canRun ? "Run the inspection again to see results for the requirements shown." : "Fix the requirements, then run the inspection again."}
      </p>
    </div>
  );
}
