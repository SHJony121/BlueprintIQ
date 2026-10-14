"use client";

import Link from "next/link";

// Shown when a page fails while rendering. It says nothing about the cause: error text can
// carry internals, so it is never displayed.
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main" className="flex flex-1 flex-col">
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
        <h1 className="text-3xl font-semibold tracking-tight">Something went wrong</h1>
        <p role="alert" className="mt-3 text-base text-muted">
          The page could not be shown. Nothing you uploaded is kept. Try again, and if it keeps
          happening, come back later.
        </p>
        <div className="mt-6 flex flex-wrap gap-3 text-sm">
          <button
            type="button"
            onClick={reset}
            className="min-h-10 rounded-md border border-line bg-surface px-4 py-2 font-medium hover:border-accent"
          >
            Try again
          </button>
          <Link className="inline-flex min-h-10 items-center text-accent underline underline-offset-4" href="/">
            Back to the start
          </Link>
        </div>
      </div>
    </main>
  );
}
