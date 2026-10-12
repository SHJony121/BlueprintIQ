// The PDF engine: PDF.js 6.4.299 (pinned), with the worker set up in F0 (src/lib/pdfjs.ts).
// Browser only. The file is read locally; it is never uploaded again for viewing.
import { loadPdfJs } from "@/lib/pdfjs";
import { sha256Hex } from "@/lib/sha256";
import type { Matrix } from "./geometry";
import type { OpenOutcome, PdfPage, PdfSource } from "./pdf-source";

type PdfJs = Awaited<ReturnType<typeof loadPdfJs>>;
type PdfJsPage = Awaited<ReturnType<Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>["getPage"]>>;

// Fonts, CMaps and image decoders are PDF.js's own files, served by this app
// (src/app/pdfjs-assets) rather than a CDN. Standard fonts are always taken from them
// (useSystemFonts: false) so text renders the same on every machine.
//
// Glyphs are drawn as vector outlines (disableFontFace: true), not through the browser's
// font engine. Measured in the browser tests: with browser fonts, glyphs on text that is
// rotated on screen drifted up to 1.6 pt along the line at some zoom levels (font hinting),
// while the outlines stay within the glyphs' own side bearings at every zoom. Evidence
// boxes are checked against those glyph positions, so the exact outlines matter.
function assetOptions() {
  const base = `${window.location.origin}/pdfjs-assets`;
  return {
    standardFontDataUrl: `${base}/standard_fonts/`,
    useSystemFonts: false,
    cMapUrl: `${base}/cmaps/`,
    cMapPacked: true,
    wasmUrl: `${base}/wasm/`,
    iccUrl: `${base}/iccs/`,
  };
}

function wrapPage(page: PdfJsPage): PdfPage {
  return {
    geometry: {
      view: page.view as unknown as [number, number, number, number],
      rotate: page.rotate,
      userUnit: page.userUnit,
    },
    layout(scale) {
      const viewport = page.getViewport({ scale });
      return {
        width: viewport.width,
        height: viewport.height,
        transform: viewport.transform as unknown as Matrix,
      };
    },
    render(canvas, scale, outputScaleX, outputScaleY) {
      const task = page.render({
        canvas,
        viewport: page.getViewport({ scale }),
        transform: [outputScaleX, 0, 0, outputScaleY, 0, 0],
      });
      return { promise: task.promise, cancel: () => task.cancel() };
    },
  };
}

export const pdfjsSource: PdfSource = {
  async open(file, signal): Promise<OpenOutcome> {
    let bytes: ArrayBuffer;
    try {
      bytes = await file.arrayBuffer();
    } catch {
      return { kind: "failed", reason: "unreadable" };
    }
    // Hash before PDF.js takes the buffer (it is transferred to the worker).
    const sha256 = await sha256Hex(bytes);
    if (signal.aborted) return { kind: "failed", reason: "error" };

    const pdfjs = await loadPdfJs();
    if (signal.aborted) return { kind: "failed", reason: "error" };
    const task = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      ...assetOptions(),
      enableXfa: false,
      disableFontFace: true,
      verbosity: pdfjs.VerbosityLevel.ERRORS,
    });
    const stop = () => void task.destroy();
    signal.addEventListener("abort", stop, { once: true });
    try {
      const doc = await task.promise;
      if (doc.numPages !== 1) {
        await task.destroy();
        return { kind: "unsupported", reason: "multi_page", pageCount: doc.numPages };
      }
      const page = await doc.getPage(1);
      return { kind: "opened", pdf: { sha256, page: wrapPage(page), close: () => task.destroy() } };
    } catch (error) {
      await task.destroy().catch(() => {});
      const name = (error as { name?: unknown } | null)?.name;
      if (name === "PasswordException") return { kind: "unsupported", reason: "password" };
      if (name === "InvalidPDFException") return { kind: "failed", reason: "invalid" };
      return { kind: "failed", reason: "error" };
    } finally {
      signal.removeEventListener("abort", stop);
    }
  },
};
