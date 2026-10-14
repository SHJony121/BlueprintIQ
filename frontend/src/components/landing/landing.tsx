import Link from "next/link";
import { DrawingPreview } from "./drawing-preview";

const PRIMARY =
  "inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink hover:opacity-90 active:translate-y-px";
const SECONDARY =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-line bg-surface px-5 py-2.5 text-sm font-semibold hover:border-accent active:translate-y-px";

const FEATURES = [
  {
    title: "Labelled measurements and rules",
    body: "Reads lines such as THICKNESS: 4 mm and MATERIAL: S235JR from the drawing text and checks them against limits you set. Every outcome is pass, fail, needs review or missing, with the text it came from.",
  },
  {
    title: "CAD dimensions and tolerances",
    body: "Lists linear, diameter and radius dimensions as written, including ± tolerances and tolerances stacked on two lines. They are shown apart from the findings and never counted as a pass or fail.",
  },
  {
    title: "Evidence tied to the drawing lines",
    body: "When the vector lines prove it, a dimension is tied to what it refers to: the two extension lines it spans, or the circle a leader points at. Where the evidence is missing or ambiguous it says unresolved, and why.",
  },
  {
    title: "Evidence you can see",
    body: "On a wide screen the drawing is shown beside the results, with boxes where the text was read and the supporting lines for an association. Select a result to find it on the page.",
  },
] as const;

const STEPS = [
  { title: "Upload a PDF", body: "One page, selectable text, up to 10 MiB. Or start from a sample." },
  {
    title: "Set the limits",
    body: "Use the demonstration values or enter your own minimums, maximums and material.",
  },
  {
    title: "Read the evidence",
    body: "Each result links to its source text and, on a wide screen, to its place on the drawing.",
  },
  {
    title: "Review what is uncertain",
    body: "Anything the software could not settle is marked for a person, never silently passed.",
  },
] as const;

export function Landing() {
  return (
    <>
      <section className="border-b border-line">
        <div className="mx-auto grid w-full max-w-[1400px] items-center gap-10 px-4 py-12 sm:px-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:py-20">
          <div>
            <p className="font-mono text-xs uppercase tracking-widest text-muted">
              Engineering drawing inspection
            </p>
            <h1 className="mt-3 max-w-2xl text-4xl font-semibold leading-[1.08] tracking-tight text-balance md:text-5xl">
              Check a drawing against your limits, with the evidence beside every result.
            </h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-muted">
              BlueprintIQ reads the text and the vector lines of a one-page engineering drawing PDF,
              lists its measurements, dimensions, tolerances and material, and shows where each came
              from. It uses fixed, inspectable rules, not machine learning, and it tells you when it
              is unsure.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link href="/inspect" className={PRIMARY}>
                Upload Drawing
              </Link>
              <Link href="/inspect?sample=cad" className={SECONDARY}>
                Try Sample
              </Link>
            </div>
            <p className="mt-4 max-w-xl text-sm text-muted">
              An assistive prototype. It is not certified engineering-compliance software, and its
              rule thresholds are demonstration values.
            </p>
          </div>
          <DrawingPreview />
        </div>
      </section>

      <section aria-labelledby="features-heading" className="mx-auto w-full max-w-[1400px] px-4 py-12 sm:px-6">
        <h2 id="features-heading" className="text-2xl font-semibold tracking-tight">
          What it does
        </h2>
        <ul className="mt-6 grid gap-x-10 gap-y-6 md:grid-cols-2">
          {FEATURES.map((feature) => (
            <li key={feature.title} className="border-t border-line pt-4">
              <h3 className="text-base font-semibold">{feature.title}</h3>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">{feature.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="supported-heading" className="border-y border-line bg-surface">
        <div className="mx-auto grid w-full max-w-[1400px] gap-10 px-4 py-12 sm:px-6 md:grid-cols-2">
          <div>
            <h2 id="supported-heading" className="text-2xl font-semibold tracking-tight">
              Which drawings it supports
            </h2>
            <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-relaxed">
              <li>One-page PDFs whose text is selectable (exported from CAD, not scanned).</li>
              <li>Dimensions in millimetres, stated in the annotation or in a drawing note.</li>
              <li>Horizontal and vertical text.</li>
              <li>
                Labelled THICKNESS, DIAMETER, LENGTH and MATERIAL notes, and common CAD dimension
                forms.
              </li>
            </ul>
          </div>
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">What it does not do</h2>
            <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-relaxed">
              <li>Read scans or photographs. There is no OCR.</li>
              <li>Read angled text, multi-page files, GD&amp;T frames, threads or ordinate dimensions.</li>
              <li>Judge whether a part is acceptable. The limits are yours, or demonstration values.</li>
              <li>
                Replace a qualified person. It has been tried on generated drawings and one real CAD
                export only.
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section aria-labelledby="how-heading" className="mx-auto w-full max-w-[1400px] px-4 py-12 sm:px-6">
        <h2 id="how-heading" className="text-2xl font-semibold tracking-tight">
          How it works
        </h2>
        <ol className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, index) => (
            <li key={step.title} className="border-t-2 border-accent pt-3">
              <span className="font-mono text-xs text-muted">Step {index + 1}</span>
              <h3 className="mt-1 text-base font-semibold">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-6 text-sm">
          <Link className="text-accent underline underline-offset-4" href="/about">
            The full method and its limits
          </Link>
        </p>
      </section>

      <section aria-labelledby="honest-heading" className="border-t border-line bg-surface">
        <div className="mx-auto w-full max-w-[1400px] px-4 py-12 sm:px-6">
          <h2 id="honest-heading" className="text-2xl font-semibold tracking-tight">
            Read this before relying on a result
          </h2>
          <ul className="mt-4 max-w-3xl list-disc space-y-2 pl-5 text-sm leading-relaxed">
            <li>
              Results describe the text and lines the software could read. They are not a check of
              the whole drawing, and a result that needs review is not a pass.
            </li>
            <li>
              A dimension tied to a drawn circle or pair of lines is a statement about the
              drawing graphics, not about the part. The drawing scale is not used.
            </li>
            <li>The demonstration limits are examples. They are not taken from any standard.</li>
            <li>
              Uploaded drawings are sent to the server and processed there. Do not upload files you
              may not share; see{" "}
              <Link className="underline underline-offset-2" href="/privacy">
                privacy
              </Link>
              .
            </li>
          </ul>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/inspect" className={PRIMARY}>
              Upload Drawing
            </Link>
            <Link href="/inspect?sample=basic" className={SECONDARY}>
              Try the basic sample
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
