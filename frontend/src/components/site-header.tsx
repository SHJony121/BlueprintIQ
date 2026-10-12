// Always rendered by the root layout, on every page and in every state.
export function SiteHeader() {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-10 focus:rounded-md focus:bg-accent focus:px-3 focus:py-1.5 focus:text-sm focus:font-semibold focus:text-accent-ink"
      >
        Skip to main content
      </a>
      <header className="border-b border-line bg-surface">
      <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <span className="text-base font-semibold tracking-tight">BlueprintIQ</span>
      </div>
      <div className="border-t border-line">
        <p role="note" className="mx-auto w-full max-w-[1400px] px-4 py-2 text-sm sm:px-6">
          <strong className="font-semibold">
            Assistive prototype, not certified engineering-compliance software.
          </strong>{" "}
          Findings must be reviewed by a qualified person. Rule thresholds are demonstration
          values.
        </p>
      </div>
      </header>
    </>
  );
}
