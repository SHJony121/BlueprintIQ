// Reserved for the drawing viewer. Nothing is rendered here yet: no PDF, no highlights.
// Hidden below the lg breakpoint, where the results get the full width.
export function ViewerSlot() {
  return (
    <section
      aria-labelledby="viewer-heading"
      data-testid="viewer-slot"
      className="hidden lg:sticky lg:top-4 lg:block lg:self-start"
    >
      <h2 id="viewer-heading" className="mb-3 text-base font-semibold">
        Drawing
      </h2>
      <div className="min-h-96 rounded-md border border-line bg-surface p-4">
        <p className="max-w-[48ch] text-sm text-muted">
          The drawing itself, with the source text of each finding marked on it, will appear
          here. For now, the page and text positions are listed under each measurement.
        </p>
      </div>
    </section>
  );
}
