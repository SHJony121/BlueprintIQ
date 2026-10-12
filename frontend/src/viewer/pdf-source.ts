// What the viewer needs from a PDF engine. The real implementation is pdfjs-source.ts;
// tests substitute a controllable fake, so the viewer's state handling can be checked
// without a browser canvas. Nothing here knows about inspections or rules.
import type { Matrix, PdfPageGeometry } from "./geometry";

/** A page laid out at some scale: size in CSS pixels and PDF.js's own transform. */
export interface PageLayout {
  width: number;
  height: number;
  /** PDF user space to viewport CSS pixels, exactly as PDF.js uses it to draw. */
  transform: Matrix;
}

export interface RenderJob {
  promise: Promise<void>;
  cancel(): void;
}

export interface PdfPage {
  geometry: PdfPageGeometry;
  layout(scale: number): PageLayout;
  /**
   * Draw the page into `canvas`, which is already sized in device pixels. `scale` is the
   * layout scale (CSS px per point); the output scales are backing pixels per CSS pixel.
   */
  render(canvas: HTMLCanvasElement, scale: number, outputScaleX: number, outputScaleY: number): RenderJob;
}

export interface OpenedPdf {
  /** SHA-256 of the file's bytes, lower-case hex; null if the browser cannot compute it. */
  sha256: string | null;
  page: PdfPage;
  /** Release the document, its worker and its caches. */
  close(): Promise<void>;
}

export type OpenOutcome =
  | { kind: "opened"; pdf: OpenedPdf }
  | { kind: "unsupported"; reason: "password" | "multi_page"; pageCount?: number }
  | { kind: "failed"; reason: "invalid" | "unreadable" | "error" };

export interface PdfSource {
  /** Open a local file. After `signal` aborts, any opened document must be closed by the caller. */
  open(file: File, signal: AbortSignal): Promise<OpenOutcome>;
}

/** PDF.js rejects a cancelled render with this; it is not a failure. */
export function isRenderCancelled(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "RenderingCancelledException";
}
