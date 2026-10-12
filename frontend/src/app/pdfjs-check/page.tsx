"use client";

import { useEffect, useState } from "react";
import { loadPdfJs } from "@/lib/pdfjs";

// Diagnostic route for F0: proves the bundled PDF.js worker loads and parses a PDF in the
// browser under this Next.js version. Not part of the product UI.
type Check =
  | { state: "running" }
  | { state: "ok"; version: string; pages: number; text: string; width: number; height: number }
  | { state: "failed"; message: string };

export default function PdfJsCheck() {
  const [check, setCheck] = useState<Check>({ state: "running" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await loadPdfJs();
        const response = await fetch("/pdfjs-check.pdf");
        const data = new Uint8Array(await response.arrayBuffer());
        const task = pdfjs.getDocument({ data });
        const doc = await task.promise;
        const page = await doc.getPage(1);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
        const pages = doc.numPages;
        await task.destroy();
        if (!cancelled) {
          setCheck({
            state: "ok",
            version: pdfjs.version,
            pages,
            text,
            width: viewport.width,
            height: viewport.height,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setCheck({ state: "failed", message: error instanceof Error ? error.message : "error" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-xl font-semibold">PDF.js worker check</h1>
      <p role="status" data-testid="pdfjs-status" className="mt-4 font-mono text-sm">
        {check.state === "running" && "running"}
        {check.state === "failed" && `failed: ${check.message}`}
        {check.state === "ok" &&
          `ok pdfjs=${check.version} pages=${check.pages} size=${check.width}x${check.height} text=${check.text}`}
      </p>
    </main>
  );
}
