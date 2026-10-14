import type { Metadata } from "next";
import { PageShell, Section } from "@/components/page-shell";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "What happens to a drawing you upload to BlueprintIQ, what is logged, and what is not promised.",
};

export default function PrivacyPage() {
  return (
    <PageShell
      title="Privacy"
      intro="A short, honest description of what happens to an uploaded drawing. It describes how the software is built, not a guarantee about any hosting service."
    >
      <Section id="processed" title="Your drawing is sent to a server and processed">
        <p>
          When you choose a PDF, the browser sends it to the server, which reads it to produce the
          report you see. The inspection itself runs in a short-lived worker process on the server.
          This is not done in your browser. The PDF viewer on the page does render the file locally.
        </p>
        <p>
          <strong>Do not upload a drawing you are not allowed to share</strong>, or one that is
          confidential or proprietary to someone else.
        </p>
      </Section>

      <Section id="stored" title="What the software keeps">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            The application is built to handle an upload in memory and not to write it to disk, and
            it keeps no copy after the report is returned. It has no accounts, no database of
            drawings and no analytics or advertising scripts, and it sets no cookies.
          </li>
          <li>
            Its logs record technical facts about a request: a random request id, time, status, how
            long it took, the upload size, a short prefix of a file hash and counts of outcomes.
            They are written not to include the drawing text, file names or file contents.
          </li>
        </ul>
      </Section>

      <Section id="not-promised" title="What is not promised">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Confidentiality. Whoever runs the server, and the network and hosting services in
            front of it, can in principle see traffic and may keep their own logs (for example IP
            addresses and request times). BlueprintIQ cannot control or inspect those.
          </li>
          <li>
            Deletion on a schedule. The software does not intend to keep files, but this site makes
            no claim of zero logging or of permanent deletion that you could rely on.
          </li>
          <li>
            Availability. Uploads are limited in size and rate to keep the service usable, and may be
            refused when it is busy.
          </li>
        </ul>
      </Section>

      <Section id="samples" title="Samples">
        <p>
          The sample drawings are original, synthetic files made for this site. Using one sends it
          through exactly the same path as an upload.
        </p>
      </Section>
    </PageShell>
  );
}
