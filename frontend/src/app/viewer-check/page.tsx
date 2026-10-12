"use client";

import { useState } from "react";
import type { ViewerEvidence } from "@/viewer/evidence";
import { DrawingViewer } from "@/viewer/drawing-viewer";

/** Enough shape checking that malformed pasted evidence is refused instead of crashing the page. */
function looksLikeEvidence(value: unknown): value is ViewerEvidence {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n);
  const isBox = (b: unknown) =>
    typeof b === "object" && b !== null && ["x0", "y0", "x1", "y1"].every((k) => finite((b as Record<string, unknown>)[k]));
  return (
    typeof v.documentSha256 === "string" &&
    finite(v.documentSizeBytes) &&
    Array.isArray(v.pages) &&
    v.pages.every((p) => typeof p === "object" && p !== null && Array.isArray((p as Record<string, unknown>).pdf_crop_box)) &&
    Array.isArray(v.items) &&
    v.items.every((i) => typeof i === "object" && i !== null && typeof (i as Record<string, unknown>).key === "string" && isBox((i as Record<string, unknown>).bbox)) &&
    Array.isArray(v.unplaced)
  );
}

// Diagnostic route for F3 browser tests, like /pdfjs-check: shows a local PDF in the real
// viewer with evidence supplied as JSON (for example, hand-specified ground truth), with no
// backend involved. Not part of the product UI. The viewer's own checks still apply: the
// evidence is drawn only if its SHA-256, size and page geometry match the file.
export default function ViewerCheck() {
  const [file, setFile] = useState<File | null>(null);
  const [json, setJson] = useState("");
  const [selected, setSelected] = useState("");
  const [applied, setApplied] = useState<{ file: File | null; evidence: ViewerEvidence | null; selected: string | null }>({
    file: null,
    evidence: null,
    selected: null,
  });
  const [error, setError] = useState("");

  function apply() {
    try {
      const parsed: unknown = json.trim() === "" ? null : JSON.parse(json);
      if (parsed !== null && !looksLikeEvidence(parsed)) {
        setError("The evidence does not have the expected shape.");
        return;
      }
      setApplied({ file, evidence: parsed, selected: selected.trim() || null });
      setError("");
    } catch {
      setError("The evidence is not valid JSON.");
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-6 py-6">
      <h1 className="text-xl font-semibold">Viewer check</h1>
      <p className="text-sm text-muted">Diagnostic page for the viewer tests. Not part of the product.</p>
      <label className="text-sm">
        PDF <input data-testid="harness-file" type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Evidence (JSON)
        <textarea data-testid="harness-evidence" rows={3} className="rounded-md border border-line bg-surface p-2 font-mono text-xs" value={json} onChange={(e) => setJson(e.currentTarget.value)} />
      </label>
      <label className="text-sm">
        Selected key <input data-testid="harness-selected" className="rounded-md border border-line bg-surface px-2" value={selected} onChange={(e) => setSelected(e.currentTarget.value)} />
      </label>
      <button type="button" data-testid="harness-apply" onClick={apply} className="self-start rounded-md bg-accent px-3 py-1 text-sm font-semibold text-accent-ink">
        Apply
      </button>
      {error ? <p role="alert">{error}</p> : null}
      <div data-testid="harness-viewer" className="w-full">
        <DrawingViewer file={applied.file} evidence={applied.evidence} inspection="succeeded" selectedKey={applied.selected} />
      </div>
    </main>
  );
}
