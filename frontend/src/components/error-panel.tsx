import type { FailureCopy } from "@/inspection/failure-copy";

interface ErrorPanelProps {
  copy: FailureCopy;
  /** Offered only when trying the same file again can help. */
  onRetry?: () => void;
}

// Used for every kind of failure: a file refused in the browser, an error the service
// reported, an unusable reply, or no reply at all. It is a different thing from a result
// and never shares a layout with one.
export function ErrorPanel({ copy, onRetry }: ErrorPanelProps) {
  return (
    <div
      role="alert"
      className="mt-4 rounded-md border border-line border-l-4 border-l-fail bg-fail-tint p-4"
    >
      <h2 className="text-base font-semibold text-fail text-balance">{copy.title}</h2>
      <p className="mt-1 text-sm">{copy.explanation}</p>
      {copy.hint !== undefined && <p className="mt-1 text-sm">{copy.hint}</p>}
      {onRetry !== undefined && copy.retryable && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-accent-ink hover:opacity-90"
        >
          Try again
        </button>
      )}
      {copy.details.length > 0 && (
        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 font-mono text-xs">
          {copy.details.map((detail) => (
            <div key={detail.label} className="contents">
              <dt>{detail.label}</dt>
              <dd className="break-all">{detail.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
