import type { FeatureAssociation } from "@/api/types";
import { DrawingViewer, type InspectionPhase } from "@/viewer/drawing-viewer";
import type { ViewerEvidence } from "@/viewer/evidence";
import type { PdfSource } from "@/viewer/pdf-source";

interface ViewerSlotProps {
  file: File | null;
  evidence: ViewerEvidence | null;
  inspection: InspectionPhase;
  pdfSource?: PdfSource;
  selectedFindingId?: string | null;
  revealToken?: number | null;
  onSelectFinding?: (findingId: string) => void;
  association?: FeatureAssociation | null;
}

// The drawing and its evidence. Hidden below the lg breakpoint, where the results get the
// full width (the viewer needs room to be useful; see docs/frontend-f3.md).
export function ViewerSlot({
  file,
  evidence,
  inspection,
  pdfSource,
  selectedFindingId,
  revealToken,
  onSelectFinding,
  association,
}: ViewerSlotProps) {
  return (
    <section
      aria-labelledby="viewer-heading"
      data-testid="viewer-slot"
      className="hidden lg:sticky lg:top-4 lg:block lg:self-start"
    >
      <h2 id="viewer-heading" className="mb-3 text-base font-semibold">
        Drawing
      </h2>
      <DrawingViewer
        file={file}
        evidence={evidence}
        inspection={inspection}
        source={pdfSource}
        selectedFindingId={selectedFindingId}
        revealToken={revealToken}
        onSelectFinding={onSelectFinding}
        association={association}
      />
    </section>
  );
}
