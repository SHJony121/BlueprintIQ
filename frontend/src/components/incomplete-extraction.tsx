/**
 * Shown above the results when some text on the drawing could not be read. The findings
 * then describe only the text that was read; they are not a check of the whole drawing.
 */
export function IncompleteExtraction({ skipped }: { skipped: number }) {
  if (skipped === 0) return null;
  return (
    <section
      role="note"
      aria-labelledby="incomplete-heading"
      data-testid="incomplete-extraction"
      className="rounded-md border border-line border-l-4 border-l-review bg-review-tint p-4"
    >
      <h3 id="incomplete-heading" className="text-base font-semibold text-review">
        Incomplete extraction
      </h3>
      <p className="mt-1 text-sm">
        {skipped === 1 ? "1 line of text on this drawing is" : `${skipped} lines of text on this drawing are`}{" "}
        written at an angle and {skipped === 1 ? "was" : "were"} not read. The results below cover
        only the horizontal and vertical text, so they are not a full inspection of the drawing and
        must not be taken as a compliance result. No skipped line contained a supported measurement
        label.
      </p>
    </section>
  );
}
