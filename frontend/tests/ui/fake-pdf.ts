// A stand-in for the PDF engine, for jsdom tests of the viewer's state handling. It opens
// nothing and draws nothing; tests decide when each open and each render finishes. Real
// rendering and real geometry are tested with PDF.js itself (src/viewer/geometry.pdfjs.test.ts)
// and in a real browser (tests/e2e).
import { vi } from "vitest";
import type { PdfPageGeometry, Matrix } from "@/viewer/geometry";
import type { OpenOutcome, OpenedPdf, PageLayout, PdfPage, PdfSource, RenderJob } from "@/viewer/pdf-source";

export interface PendingOpen {
  file: File;
  signal: AbortSignal;
  resolve: (outcome: OpenOutcome) => void;
}

export interface RenderCall {
  scale: number;
  outputScaleX: number;
  outputScaleY: number;
  pixelWidth: number;
  pixelHeight: number;
  cancelled: boolean;
  finish: () => void;
  fail: (error?: unknown) => void;
}

/** A source whose opens stay pending until the test settles them. */
export function controlledSource() {
  const opens: PendingOpen[] = [];
  const source: PdfSource = {
    open: vi.fn<PdfSource["open"]>(
      (file, signal) =>
        new Promise<OpenOutcome>((resolve) => {
          opens.push({ file, signal, resolve });
        }),
    ),
  };
  return { source, opens };
}

/** A source that never finishes opening: for tests that are not about the viewer. */
export const idleSource: PdfSource = { open: () => new Promise<OpenOutcome>(() => {}) };

/**
 * A PDF whose page behaves like an unrotated PDF.js page with the given view box: the
 * layout transform is PDF.js's for rotation 0, [s, 0, 0, -s, -s x0, s y1], written out.
 */
export function fakePdf(options: {
  sha256: string | null;
  view?: [number, number, number, number];
  rotate?: number;
  userUnit?: number;
  autoFinish?: boolean;
  /**
   * PDF.js documents that a render already painting is only cancelled at its next pause,
   * so it may still complete after cancel(). false models that: cancel() is recorded but
   * the render can still finish.
   */
  cancelRejects?: boolean;
  /** Make render() throw synchronously, as PDF.js does on a destroyed page. */
  renderThrows?: boolean;
}) {
  const view = options.view ?? [0, 0, 595, 842];
  const geometry: PdfPageGeometry = { view, rotate: options.rotate ?? 0, userUnit: options.userUnit ?? 1 };
  const renders: RenderCall[] = [];
  const page: PdfPage = {
    geometry,
    layout(scale): PageLayout {
      const transform: Matrix = [scale, 0, 0, -scale, -scale * view[0], scale * view[3]];
      return { width: (view[2] - view[0]) * scale, height: (view[3] - view[1]) * scale, transform };
    },
    render(canvas, scale, outputScaleX, outputScaleY): RenderJob {
      if (options.renderThrows) throw new TypeError("Cannot read properties of null (reading 'sendWithPromise')");
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const call: RenderCall = {
        scale,
        outputScaleX,
        outputScaleY,
        pixelWidth: canvas.width,
        pixelHeight: canvas.height,
        cancelled: false,
        finish: () => resolve(),
        fail: (error = new Error("render failed")) => reject(error),
      };
      renders.push(call);
      if (options.autoFinish ?? true) queueMicrotask(() => resolve());
      return {
        promise,
        cancel: () => {
          call.cancelled = true;
          if (options.cancelRejects ?? true) {
            reject(Object.assign(new Error("cancelled"), { name: "RenderingCancelledException" }));
          }
        },
      };
    },
  };
  const close = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const pdf: OpenedPdf = { sha256: options.sha256, page, close };
  return { pdf, renders, close };
}
