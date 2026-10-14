import { SAMPLES, type Sample } from "@/inspection/samples";

/**
 * Sample drawings, offered next to the upload area. A sample goes through the same upload and
 * inspection as a visitor's own file; the requirements used are the demonstration values.
 */
export function SamplePicker({
  onChoose,
  loading,
  failed,
}: {
  onChoose: (sample: Sample) => void;
  loading: Sample["id"] | null;
  failed: boolean;
}) {
  return (
    <section aria-labelledby="samples-heading" className="mt-6">
      <h2 id="samples-heading" className="text-base font-semibold">
        No drawing at hand? Try a sample
      </h2>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Both samples are original, synthetic drawings made for this site; they are not real parts.
        They are inspected exactly like an uploaded file, against the demonstration requirements
        below, which are examples and not engineering standards.
      </p>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2">
        {SAMPLES.map((sample) => (
          <li key={sample.id} className="flex flex-col rounded-md border border-line bg-surface p-4">
            <h3 className="text-sm font-semibold">{sample.title}</h3>
            <p className="mt-1 text-sm text-muted">{sample.summary}</p>
            <ul className="mt-2 list-disc pl-5 text-sm">
              {sample.shows.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <div className="mt-auto flex flex-wrap items-center gap-3 pt-3">
              <button
                type="button"
                onClick={() => onChoose(sample)}
                disabled={loading !== null}
                className="min-h-10 rounded-md border border-line bg-surface px-4 py-2 text-sm font-medium hover:border-accent disabled:cursor-wait disabled:opacity-60"
              >
                {loading === sample.id ? "Loading…" : `Inspect “${sample.title}”`}
              </button>
              <a
                href={`/samples/${sample.file}`}
                download
                className="text-sm text-accent underline underline-offset-4"
              >
                Download PDF
              </a>
            </div>
          </li>
        ))}
      </ul>
      {failed && (
        <p role="alert" className="mt-3 rounded-md border border-line border-l-4 border-l-fail bg-fail-tint p-3 text-sm">
          The sample could not be loaded. Check your connection and try again, or upload a PDF of
          your own.
        </p>
      )}
    </section>
  );
}
