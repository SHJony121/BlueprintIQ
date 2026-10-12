// PDF.js loader. Browser only: import this from client components, never from server code.
//
// The worker is bundled by the app (not fetched from a CDN) via a URL relative to this
// file, which Turbopack and webpack both resolve at build time. See docs/frontend-f0.md.
import type * as PdfJs from "pdfjs-dist";

let loaded: Promise<typeof PdfJs> | undefined;

export function loadPdfJs(): Promise<typeof PdfJs> {
  loaded ??= import("pdfjs-dist").then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
    return pdfjs;
  });
  return loaded;
}
