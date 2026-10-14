import Link from "next/link";
import { SiteNav } from "./site-nav";

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
        <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-2 sm:px-6">
          <Link href="/" className="inline-flex min-h-10 items-center gap-2 text-base font-semibold tracking-tight">
            <svg aria-hidden="true" viewBox="0 0 24 24" className="size-6 text-accent" fill="none" stroke="currentColor" strokeWidth="1.6">
              <rect x="3.5" y="3.5" width="17" height="17" rx="1.5" />
              <path d="M3.5 9h17M9 3.5v17" strokeDasharray="2 2" />
              <circle cx="15" cy="15" r="2.6" />
            </svg>
            BlueprintIQ
          </Link>
          <SiteNav />
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
