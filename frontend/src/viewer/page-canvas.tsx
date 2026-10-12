"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { isRenderCancelled, type PageLayout, type PdfPage, type RenderJob } from "./pdf-source";
import { planCanvas } from "./zoom";

/** Re-render this long after the last zoom or resize, not on every intermediate size. */
export const RENDER_DEBOUNCE_MS = 120;

interface PageStageProps {
  page: PdfPage;
  /** The layout the canvas element is sized to. The overlay must use this same layout. */
  layout: PageLayout;
  scale: number;
  devicePixelRatio: number;
  /** The evidence overlay; shown only over a finished bitmap, never over a blank or failed canvas. */
  children?: ReactNode;
}

/**
 * The rendered page with its overlay on top.
 *
 * The canvas element is sized to `layout` in CSS pixels at once, so the overlay and the
 * canvas move together while a sharper bitmap is prepared at the new size. Each render
 * draws into its own off-screen canvas; only when it finishes, and only if it is still the
 * newest render, is the result copied onto the visible canvas. A superseded or cancelled
 * render never touches what is shown, so no stale bitmap can replace a newer one.
 */
export function PageStage({ page, layout, scale, devicePixelRatio, children }: PageStageProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const hasRendered = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [drawn, setDrawn] = useState({ key: "", count: 0, failed: false });
  const key = `${scale}|${devicePixelRatio}|${attempt}`;
  const { width, height } = layout;

  useEffect(() => {
    let current = true;
    let job: RenderJob | null = null;
    let buffer: HTMLCanvasElement | null = null;
    const start = () => {
      const plan = planCanvas(width, height, devicePixelRatio);
      const target = document.createElement("canvas");
      target.width = plan.pixelWidth;
      target.height = plan.pixelHeight;
      buffer = target;
      try {
        job = page.render(target, scale, plan.outputScaleX, plan.outputScaleY);
      } catch {
        setDrawn((d) => ({ key, count: d.count, failed: true }));
        return;
      }
      job.promise.then(
        () => {
          if (!current) return;
          const visible = canvas.current;
          const context = visible?.getContext("2d") ?? null;
          if (visible === null || context === null) {
            setDrawn((d) => ({ key, count: d.count, failed: true }));
            return;
          }
          visible.width = target.width;
          visible.height = target.height;
          context.drawImage(target, 0, 0);
          release(target); // copied: free the off-screen bitmap at once
          hasRendered.current = true;
          setDrawn((d) => ({ key, count: d.count + 1, failed: false }));
        },
        (error: unknown) => {
          if (!current || isRenderCancelled(error)) return;
          setDrawn((d) => ({ key, count: d.count, failed: true }));
        },
      );
    };
    // The first render starts at once; later ones wait for zooming or resizing to settle.
    const timer = setTimeout(start, hasRendered.current ? RENDER_DEBOUNCE_MS : 0);
    return () => {
      current = false;
      clearTimeout(timer);
      job?.cancel();
      if (buffer !== null) release(buffer);
    };
  }, [page, width, height, scale, devicePixelRatio, key]);

  const status = drawn.key !== key ? "rendering" : drawn.failed ? "failed" : "ready";
  const hasBitmap = drawn.count > 0;

  return (
    <div
      data-testid="page-stage"
      data-render-status={status}
      data-render-count={drawn.count}
      data-render-key={key}
      data-drawn-key={drawn.key}
      data-layout-scale={scale}
      className="relative bg-white shadow-[0_0_0_1px_var(--line)]"
      style={{ width: `${width}px`, height: `${height}px` }}
    >
      <canvas
        ref={canvas}
        data-testid="pdf-canvas"
        aria-hidden="true"
        className="block"
        style={{ width: `${width}px`, height: `${height}px` }}
      />
      {hasBitmap && status !== "failed" ? children : null}
      {!hasBitmap && status === "rendering" ? (
        <p className="absolute inset-x-0 top-6 text-center text-sm text-muted">Drawing the page</p>
      ) : null}
      {status === "failed" ? (
        <div
          role="alert"
          className="absolute inset-x-4 top-4 rounded-md border border-line border-l-4 border-l-fail bg-fail-tint p-3 text-sm"
        >
          <p className="font-semibold text-fail">The page could not be drawn.</p>
          <p className="mt-1">The browser could not render the drawing at this size.</p>
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="mt-2 rounded-md bg-accent px-3 py-1 font-semibold text-accent-ink hover:opacity-90"
          >
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}

function release(target: HTMLCanvasElement) {
  target.width = 0;
  target.height = 0;
}
