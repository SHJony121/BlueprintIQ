"use client";

import { useEffect, useId, useState, type DragEvent } from "react";
import type { InspectionState } from "@/inspection/state";
import { formatBytes } from "@/inspection/labels";

interface UploadPanelProps {
  state: InspectionState;
  onFiles: (files: File[]) => void;
  onCancel: () => void;
}

function hasFiles(event: DragEvent | globalThis.DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") ?? false;
}

export function UploadPanel({ state, onFiles, onCancel }: UploadPanelProps) {
  const helpId = useId();
  const [dragging, setDragging] = useState(false);
  // Once a file has been chosen the drop area shrinks to one line, keeping the results in view.
  const compact = state.status !== "idle";

  // A file dropped anywhere outside the drop area would make the browser open it and
  // leave the page. Swallow those drops (the drop area itself still works).
  useEffect(() => {
    const ignore = (event: globalThis.DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    window.addEventListener("dragover", ignore);
    window.addEventListener("drop", ignore);
    return () => {
      window.removeEventListener("dragover", ignore);
      window.removeEventListener("drop", ignore);
    };
  }, []);

  function accept(event: DragEvent<HTMLLabelElement>) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  }

  return (
    <section aria-labelledby="upload-heading">
      <h2 id="upload-heading" className="sr-only">
        Choose a drawing
      </h2>
      <label
        onDragEnter={accept}
        onDragOver={accept}
        onDragLeave={(event) => {
          // Leaving for a child element is not leaving the drop area.
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          onFiles(Array.from(event.dataTransfer.files));
        }}
        className={`flex cursor-pointer flex-col items-start justify-center gap-1 rounded-md border border-dashed px-5 transition-colors ${
          compact ? "py-3" : "min-h-32 py-6"
        } has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent ${
          dragging ? "border-accent bg-surface ring-1 ring-accent" : "border-muted bg-surface hover:border-accent"
        }`}
      >
        <input
          type="file"
          accept="application/pdf,.pdf"
          aria-describedby={helpId}
          className="sr-only"
          onChange={(event) => {
            const picked = Array.from(event.currentTarget.files ?? []);
            // Clear the field so choosing the same file again fires another change.
            event.currentTarget.value = "";
            onFiles(picked);
          }}
        />
        <span className={compact ? "text-sm font-medium" : "text-lg font-medium tracking-tight"}>
          {dragging
            ? "Drop the PDF to inspect it"
            : compact
              ? "Drop another PDF here"
              : "Drop a PDF drawing here"}
        </span>
        <span className="text-sm">
          or <span className="font-medium text-accent underline underline-offset-4">choose a file</span>
        </span>
      </label>
      <p id={helpId} className="mt-2 text-sm text-muted">
        One page, with selectable text, up to 10 MiB. Scanned drawings are not supported.
      </p>
      <CurrentFile state={state} onCancel={onCancel} />
    </section>
  );
}

function CurrentFile({ state, onCancel }: { state: InspectionState; onCancel: () => void }) {
  if (state.status === "idle" || state.status === "rejected") return null;
  const name = state.status === "running" || state.status === "failed" ? state.file.name : state.fileName;
  const detail =
    state.status === "running"
      ? `Inspecting, ${formatBytes(state.file.size)}`
      : state.status === "succeeded"
        ? "Inspected"
        : "Not inspected";
  return (
    <div className="mt-3 flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      <span className="min-w-0 break-all font-mono">{name}</span>
      <span className="text-muted">{detail}</span>
      {state.status === "running" && (
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-line bg-surface px-3 py-1 font-medium hover:border-accent"
        >
          Cancel
        </button>
      )}
    </div>
  );
}
