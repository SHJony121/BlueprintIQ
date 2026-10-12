"use client";

import { useEffect, useState } from "react";
import type { OpenOutcome, OpenedPdf, PdfSource } from "./pdf-source";

export type DocumentState =
  | { status: "empty" }
  | { status: "opening" }
  | { status: "open"; pdf: OpenedPdf }
  | { status: "unsupported"; reason: "password" | "multi_page"; pageCount?: number }
  | { status: "failed"; reason: "invalid" | "unreadable" | "error" };

/**
 * The PDF.js document for `file`, opened locally.
 *
 * One document at a time. When `file` changes (or the viewer goes away) the previous
 * open is aborted, a document it already opened is closed (worker, caches and all), and
 * an outcome that arrives late for an old file is discarded. The state for a file is only
 * ever read while that same file is selected: anything else reads as "opening".
 */
export function useOpenedPdf(file: File | null, source: PdfSource): DocumentState {
  const [result, setResult] = useState<{ file: File; outcome: OpenOutcome } | null>(null);

  useEffect(() => {
    if (file === null) return;
    const controller = new AbortController();
    let active = true;
    let opened: OpenedPdf | null = null;
    source.open(file, controller.signal).then(
      (outcome) => {
        if (outcome.kind === "opened") {
          if (!active) {
            void outcome.pdf.close().catch(() => {});
            return;
          }
          opened = outcome.pdf;
        }
        if (active) setResult({ file, outcome });
      },
      () => {
        if (active) setResult({ file, outcome: { kind: "failed", reason: "error" } });
      },
    );
    return () => {
      active = false;
      controller.abort();
      if (opened !== null) void opened.close().catch(() => {});
      // Forget this file's result: the document is closed, and if the same File comes
      // back later it must be opened again, not shown from a closed document.
      setResult((current) => (current?.file === file ? null : current));
    };
  }, [file, source]);

  if (file === null) return { status: "empty" };
  if (result === null || result.file !== file) return { status: "opening" };
  const { outcome } = result;
  switch (outcome.kind) {
    case "opened":
      return { status: "open", pdf: outcome.pdf };
    case "unsupported":
      return { status: "unsupported", reason: outcome.reason, pageCount: outcome.pageCount };
    case "failed":
      return { status: "failed", reason: outcome.reason };
  }
}
