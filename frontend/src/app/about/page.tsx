import type { Metadata } from "next";
import Link from "next/link";
import { PageShell, Section } from "@/components/page-shell";

export const metadata: Metadata = {
  title: "How it works and its limits",
  description:
    "How BlueprintIQ reads an engineering drawing PDF, what it can and cannot tie to the drawing, and why some results need a person to review them.",
};

export default function AboutPage() {
  return (
    <PageShell
      title="How it works, and where it stops"
      intro="BlueprintIQ is an assistive prototype. It reads what a PDF contains, reports what it found with the evidence, and says plainly when it could not decide."
    >
      <Section id="method" title="What it reads">
        <p>
          It works on the contents of the PDF, not on a picture of it. A drawing exported from CAD
          carries its text and its lines as data, and BlueprintIQ reads both. There is no machine
          learning, no AI service and no OCR: every rule is fixed and can be read in the source
          code, so the same file always gives the same result.
        </p>
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            <strong>Text.</strong> Each line of text is read with its position on the page. Text
            that is hidden, clipped or at an angle is not treated as readable.
          </li>
          <li>
            <strong>Labelled measurements.</strong> Notes such as <code>THICKNESS: 4 mm</code>,{" "}
            <code>DIAMETER: 20 mm</code>, <code>LENGTH: 120 mm</code> and <code>MATERIAL: S235JR</code>{" "}
            become measurements, with their units converted to millimetres where the drawing says
            how.
          </li>
          <li>
            <strong>Rules.</strong> The measurements are compared with the limits you enter (or the
            demonstration limits). Each rule ends as pass, fail, needs review or missing.
          </li>
          <li>
            <strong>CAD dimensions.</strong> Dimensions such as <code>88 ±0.1</code>,{" "}
            <code>Ø20</code> or <code>R5</code>, and tolerances printed on two lines, are listed as
            written. They are not rules and never become a pass or a fail.
          </li>
          <li>
            <strong>Drawing lines.</strong> The page&rsquo;s vector lines are scanned for straight
            runs, circles, arcs and arrowheads. A dimension is tied to a feature only when those
            lines prove it.
          </li>
        </ol>
      </Section>

      <Section id="evidence" title="How a dimension is tied to the drawing">
        <p>
          A linear dimension is tied to the two extension lines its arrowheads sit on. A diameter or
          radius is tied to a circle or arc when its leader ends in an arrowhead on that shape,
          pointing along a radius. This is a statement about the drawing&rsquo;s graphics: the
          software does not know what the part is, does not call a circle a hole, and does not use
          the drawing scale.
        </p>
        <p>
          When the lines do not prove it, the dimension stays <strong>unresolved</strong> with the
          reason (for example, no arrowheads, or two equally good candidates). Verified and
          unresolved items are shown apart and never mixed.
        </p>
      </Section>

      <Section id="review" title="Why some results need a person">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            A value that is ambiguous, such as two different material descriptions or a number
            without a unit, is marked <em>needs review</em>, not passed.
          </li>
          <li>
            Text written at an angle is not read. When a drawing has some, a warning says the
            results cover only the readable text.
          </li>
          <li>
            A material rule checks that a material is written, not that it is the right one.
          </li>
          <li>
            An unresolved association may be a drawing style the software does not handle yet, not
            a mistake in the drawing.
          </li>
        </ul>
      </Section>

      <Section id="limits" title="Limits">
        <ul className="list-disc space-y-2 pl-5">
          <li>One page, selectable text, up to 10 MiB. Scans and photographs are not supported.</li>
          <li>
            Not read: angled text, GD&amp;T frames, threads, chamfers, ordinate and angular
            dimension associations, curved leaders and comma decimals.
          </li>
          <li>
            Tested on generated drawings and on one real CAD export. That is not evidence of
            accuracy on your drawings.
          </li>
          <li>
            The limits in the form are yours. The demonstration limits (3 mm minimum thickness, and
            so on) are examples, not engineering standards.
          </li>
          <li>
            It is not certified engineering-compliance software and must not be the only check on a
            part.
          </li>
        </ul>
      </Section>

      <Section id="viewer" title="Screens">
        <p>
          The drawing viewer, which shows the PDF with boxes and supporting lines for each result, needs a
          wide screen. On a phone you get the full results without it; use a desktop or a tablet in
          landscape for the viewer.
        </p>
      </Section>

      <Section id="licence" title="Licence and source">
        <p>
          BlueprintIQ is free software under the GNU Affero General Public License v3 or later. The
          PDF engine it uses, PyMuPDF/MuPDF, is AGPL-3.0 too. The page footer links the source code
          of the version running here. There is no warranty.
        </p>
      </Section>

      <p className="text-sm">
        <Link className="text-accent underline underline-offset-4" href="/inspect">
          Inspect a drawing
        </Link>
      </p>
    </PageShell>
  );
}
