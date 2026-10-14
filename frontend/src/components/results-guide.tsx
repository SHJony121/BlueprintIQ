/** A short reading guide under the summary: what each part of the results is, and is not. */
export function ResultsGuide() {
  return (
    <details data-testid="results-guide" className="rounded-md border border-line bg-surface px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium">How to read these results</summary>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-muted">
        <li>
          <strong className="text-foreground">Findings</strong> compare labelled measurements with the limits above.
          Only these can pass or fail. <em>Needs review</em> and <em>missing</em> are never a pass.
        </li>
        <li>
          <strong className="text-foreground">CAD annotations</strong> are dimensions and tolerances read as written.
          They are listed, not judged.
        </li>
        <li>
          <strong className="text-foreground">Verified</strong> means the drawing lines prove which feature a dimension
          refers to. <strong className="text-foreground">Unresolved</strong> means they do not, and the reason is given.
        </li>
        <li>The software read only what the PDF contains; it does not know the part. A person must review the result.</li>
      </ul>
    </details>
  );
}
