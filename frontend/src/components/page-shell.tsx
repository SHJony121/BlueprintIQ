import type { ReactNode } from "react";

/** A readable single-column page for the information pages (how it works, privacy, errors). */
export function PageShell({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <main id="main" className="flex flex-1 flex-col">
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
        <h1 className="text-3xl font-semibold tracking-tight text-balance">{title}</h1>
        {intro !== undefined && <p className="mt-3 text-base leading-relaxed text-muted">{intro}</p>}
        <div className="mt-8 flex flex-col gap-8">{children}</div>
      </div>
    </main>
  );
}

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="text-xl font-semibold tracking-tight">
        {title}
      </h2>
      <div className="mt-3 flex flex-col gap-3 text-sm leading-relaxed">{children}</div>
    </section>
  );
}
