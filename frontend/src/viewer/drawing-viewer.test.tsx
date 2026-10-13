// @vitest-environment jsdom
//
// The viewer's state handling, with a fake PDF engine (tests/ui/fake-pdf.ts): which file is
// shown, when evidence may be drawn, cleanup, zoom and render bookkeeping. jsdom has no
// canvas and no layout, so the canvas context and the scroll area's width are stubbed.
// Real PDF.js geometry: geometry.pdfjs.test.ts. Real rendering and pixels: tests/e2e.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureAssociation, PageInfo } from "@/api/types";
import { box } from "../../tests/ui/builders";
import { controlledSource, fakePdf } from "../../tests/ui/fake-pdf";
import { DrawingViewer, type InspectionPhase } from "./drawing-viewer";
import type { EvidenceItem, ViewerEvidence } from "./evidence";
import type { PdfSource } from "./pdf-source";

const SCROLL_WIDTH = 620; // CSS px available inside the scroll area
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const drawImage = vi.fn();
beforeEach(() => {
  drawImage.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => ({ drawImage }) as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "viewer-scroll" ? SCROLL_WIDTH : 0;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
});

const pdfFile = (name: string, size = 1319) => {
  const file = new File(["%PDF-1.4"], name, { type: "application/pdf" });
  Object.defineProperty(file, "size", { value: size });
  return file;
};

const PAGE: PageInfo = { page_number: 1, width_pt: 595, height_pt: 842, rotation: 0, pdf_crop_box: [0, 0, 595, 842] };

const item = (overrides: Partial<EvidenceItem> = {}): EvidenceItem => ({
  key: "F1:M1",
  findingId: "F1",
  ruleId: "THK-MIN-001",
  status: "fail",
  severity: "error",
  measurementId: "M1",
  pageNumber: 1,
  bbox: box(), // x 72..159.8, y 549.3..563
  description: "Fail: THK-MIN-001, finding F1, measurement M1",
  ...overrides,
});

const evidenceFor = (sha: string, overrides: Partial<ViewerEvidence> = {}): ViewerEvidence => ({
  documentSha256: sha,
  documentSizeBytes: 1319,
  pages: [PAGE],
  items: [item()],
  unplaced: [],
  ...overrides,
});

function show(
  source: PdfSource,
  props: {
    file: File | null;
    evidence?: ViewerEvidence | null;
    inspection?: InspectionPhase;
    selectedFindingId?: string | null;
    association?: FeatureAssociation | null;
  },
) {
  const all = {
    evidence: null,
    inspection: "succeeded" as InspectionPhase,
    selectedFindingId: null,
    association: null,
    ...props,
  };
  const view = render(<DrawingViewer source={source} {...all} />);
  return {
    ...view,
    update: (next: Partial<typeof all> & { file?: File | null }) =>
      view.rerender(<DrawingViewer source={source} {...all} {...next} />),
  };
}

async function openWith(sha: string | null, options: Parameters<typeof fakePdf>[0] | object = {}) {
  const { source, opens } = controlledSource();
  const fake = fakePdf({ sha256: sha, ...options });
  const file = pdfFile("a.pdf");
  const view = show(source, { file, evidence: evidenceFor(SHA_A) });
  await act(async () => opens[0]!.resolve({ kind: "opened", pdf: fake.pdf }));
  await screen.findByTestId("pdf-canvas");
  await waitFor(() => expect(screen.getByTestId("page-stage").dataset.renderStatus).toBe("ready"));
  return { ...view, ...fake, source, opens, file };
}

const boxes = () => [...document.querySelectorAll<HTMLElement>("[data-evidence-key]")];

describe("before and while opening", () => {
  it("shows a prompt and no canvas without a file", () => {
    show(controlledSource().source, { file: null });
    expect(screen.getByText(/Choose a PDF to see the drawing here/)).toBeTruthy();
    expect(screen.queryByTestId("pdf-canvas")).toBeNull();
  });

  it("opens the selected file locally, once", () => {
    const { source, opens } = controlledSource();
    const file = pdfFile("a.pdf");
    show(source, { file });
    expect(source.open).toHaveBeenCalledTimes(1);
    expect(opens[0]!.file).toBe(file);
    expect(screen.getByTestId("viewer-opening")).toBeTruthy();
  });
});

describe("states that cannot show the drawing", () => {
  it.each([
    [{ kind: "unsupported", reason: "multi_page", pageCount: 3 } as const, /3 pages; the viewer shows single-page drawings only/],
    [{ kind: "unsupported", reason: "password" } as const, /password-protected/],
    [{ kind: "failed", reason: "invalid" } as const, /could not read it as a PDF/],
    [{ kind: "failed", reason: "unreadable" } as const, /browser could not read the file/],
    [{ kind: "failed", reason: "error" } as const, /went wrong while opening/],
  ])("explains %j", async (outcome, text) => {
    const { source, opens } = controlledSource();
    show(source, { file: pdfFile("a.pdf") });
    await act(async () => opens[0]!.resolve(outcome));
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByTestId("pdf-canvas")).toBeNull();
  });

  it("treats an engine that throws as a failure", async () => {
    const source: PdfSource = { open: () => Promise.reject(new Error("boom")) };
    show(source, { file: pdfFile("a.pdf") });
    expect(await screen.findByText(/went wrong while opening/)).toBeTruthy();
  });
});

describe("drawing evidence only on the inspected document", () => {
  it("places a box from the layout transform: page space, to PDF space, to CSS pixels", async () => {
    const { renders } = await openWith(SHA_A);
    const scale = SCROLL_WIDTH / 595; // fit width
    expect(renders.at(-1)!.scale).toBeCloseTo(scale, 12);
    const [element] = boxes();
    expect(element!.dataset.status).toBe("fail");
    expect(element!.getAttribute("aria-label")).toBe("Fail: THK-MIN-001, finding F1, measurement M1. Select this finding");
    // Unrotated, uncropped: the CSS box is the page-space box times the scale.
    expect(parseFloat(element!.style.left)).toBeCloseTo(72 * scale, 9);
    expect(parseFloat(element!.style.top)).toBeCloseTo(549.3 * scale, 9);
    expect(parseFloat(element!.style.width)).toBeCloseTo((159.8 - 72) * scale, 9);
    expect(parseFloat(element!.style.height)).toBeCloseTo((563 - 549.3) * scale, 9);
  });

  it("applies the crop-box offset through the transform, not by hand", async () => {
    const { source, opens } = controlledSource();
    const cropped: PageInfo = { ...PAGE, pdf_crop_box: [50, 40, 645, 882] };
    const fake = fakePdf({ sha256: SHA_A, view: [50, 40, 645, 882] });
    show(source, { file: pdfFile("a.pdf"), evidence: evidenceFor(SHA_A, { pages: [cropped] }) });
    await act(async () => opens[0]!.resolve({ kind: "opened", pdf: fake.pdf }));
    await waitFor(() => expect(boxes()).toHaveLength(1));
    const scale = SCROLL_WIDTH / 595;
    // Page space is relative to the crop box, so the box lands where it would uncropped.
    expect(parseFloat(boxes()[0]!.style.left)).toBeCloseTo(72 * scale, 9);
    expect(parseFloat(boxes()[0]!.style.top)).toBeCloseTo(549.3 * scale, 9);
  });

  it("draws no box while the inspection runs, and says why", async () => {
    const { source, opens } = controlledSource();
    const fake = fakePdf({ sha256: SHA_A });
    show(source, { file: pdfFile("a.pdf"), evidence: null, inspection: "running" });
    await act(async () => opens[0]!.resolve({ kind: "opened", pdf: fake.pdf }));
    await screen.findByTestId("pdf-canvas");
    expect(boxes()).toHaveLength(0);
    expect(screen.getByTestId("evidence-status").textContent).toMatch(/appear when the inspection finishes/);
  });

  it.each([
    ["a different SHA-256", SHA_B, 1319, /not the document the inspection describes/],
    ["a different size", SHA_A, 2000, /not the document the inspection describes/],
    ["no SHA-256 (no Web Crypto)", null, 1319, /could not verify/],
  ])("hides all evidence for %s", async (_label, sha, size, message) => {
    const { source, opens } = controlledSource();
    const fake = fakePdf({ sha256: sha });
    show(source, { file: pdfFile("a.pdf", size), evidence: evidenceFor(SHA_A) });
    await act(async () => opens[0]!.resolve({ kind: "opened", pdf: fake.pdf }));
    await screen.findByTestId("pdf-canvas");
    await waitFor(() => expect(screen.getByTestId("page-stage").dataset.renderStatus).toBe("ready"));
    expect(boxes()).toHaveLength(0);
    expect(screen.getByTestId("evidence-status").textContent).toMatch(message);
  });

  it.each([
    ["a rotation that disagrees", { rotate: 90 }, /rotated 0.*says 90/],
    ["a crop box that disagrees", { view: [10, 0, 605, 842] as [number, number, number, number] }, /left edge/],
    ["a UserUnit", { userUnit: 2 }, /UserUnit/],
  ])("hides all evidence for %s", async (_label, geometry, message) => {
    await openWith(SHA_A, geometry);
    expect(boxes()).toHaveLength(0);
    expect(screen.getByTestId("evidence-status").textContent).toMatch(message);
  });

  it("hides evidence for a report that does not describe page 1", async () => {
    const { source, opens } = controlledSource();
    const fake = fakePdf({ sha256: SHA_A });
    show(source, { file: pdfFile("a.pdf"), evidence: evidenceFor(SHA_A, { pages: [{ ...PAGE, page_number: 2 }] }) });
    await act(async () => opens[0]!.resolve({ kind: "opened", pdf: fake.pdf }));
    await screen.findByTestId("pdf-canvas");
    expect(boxes()).toHaveLength(0);
    expect(screen.getByTestId("evidence-status").textContent).toMatch(/does not describe page 1/);
  });

  it("lists findings that have no box, with the reason", async () => {
    const { source, opens } = controlledSource();
    const fake = fakePdf({ sha256: SHA_A });
    show(source, {
      file: pdfFile("a.pdf"),
      evidence: evidenceFor(SHA_A, {
        unplaced: [
          { findingId: "F2", measurementId: null, status: "missing", reason: "no_measurement" },
          { findingId: "F3", measurementId: "M2", status: "needs_review", reason: "no_location" },
        ],
      }),
    });
    await act(async () => opens[0]!.resolve({ kind: "opened", pdf: fake.pdf }));
    const status = await screen.findByTestId("evidence-status");
    await waitFor(() => expect(status.textContent).toMatch(/1 evidence box on the drawing/));
    expect(status.textContent).toMatch(/F2 \(Missing\) is not marked: nothing was found to mark/);
    expect(status.textContent).toMatch(/F3 \(Needs review, M2\) is not marked: its position is not known/);
  });

  it("does not draw boxes before the page itself has been drawn", async () => {
    const { source, opens } = controlledSource();
    const fake = fakePdf({ sha256: SHA_A, autoFinish: false });
    show(source, { file: pdfFile("a.pdf"), evidence: evidenceFor(SHA_A) });
    await act(async () => opens[0]!.resolve({ kind: "opened", pdf: fake.pdf }));
    await waitFor(() => expect(fake.renders).toHaveLength(1));
    expect(boxes()).toHaveLength(0);
    expect(screen.getByText("Drawing the page")).toBeTruthy();
    await act(async () => fake.renders[0]!.finish());
    await waitFor(() => expect(boxes()).toHaveLength(1));
  });
});

describe("changing files", () => {
  it("closes a document that finishes opening after another file was chosen", async () => {
    const { source, opens } = controlledSource();
    const view = show(source, { file: pdfFile("a.pdf") });
    view.update({ file: pdfFile("b.pdf") });
    expect(opens[0]!.signal.aborted).toBe(true);
    const late = fakePdf({ sha256: SHA_A });
    await act(async () => opens[0]!.resolve({ kind: "opened", pdf: late.pdf }));
    expect(late.close).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("viewer-opening")).toBeTruthy(); // still waiting for b.pdf
    expect(screen.queryByTestId("pdf-canvas")).toBeNull();
  });

  it("closes the shown document when another file is chosen, and shows no stale page or boxes", async () => {
    const { close, source, opens, update } = await openWith(SHA_A);
    expect(boxes()).toHaveLength(1);
    update({ file: pdfFile("b.pdf"), evidence: null, inspection: "running" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("pdf-canvas")).toBeNull();
    expect(boxes()).toHaveLength(0);
    expect(source.open).toHaveBeenCalledTimes(2);
    expect(opens[1]!.file.name).toBe("b.pdf");
  });

  it("never draws one document's evidence on another", async () => {
    const { opens, update } = await openWith(SHA_A);
    // b.pdf is selected but the old report (for a.pdf) is still passed in.
    update({ file: pdfFile("b.pdf"), evidence: evidenceFor(SHA_A) });
    const b = fakePdf({ sha256: SHA_B });
    await act(async () => opens[1]!.resolve({ kind: "opened", pdf: b.pdf }));
    await waitFor(() => expect(screen.getByTestId("page-stage").dataset.renderStatus).toBe("ready"));
    expect(boxes()).toHaveLength(0);
    expect(screen.getByTestId("evidence-status").textContent).toMatch(/not the document/);
  });

  it("opens a file again when it comes back after another selection, never reusing a closed document", async () => {
    const { close, source, opens, update, file } = await openWith(SHA_A);
    update({ file: null, evidence: null, inspection: "none" });
    expect(close).toHaveBeenCalledTimes(1);
    update({ file, evidence: evidenceFor(SHA_A), inspection: "succeeded" }); // the very same File object
    expect(source.open).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("viewer-opening")).toBeTruthy();
    expect(screen.queryByTestId("pdf-canvas")).toBeNull();
    const again = fakePdf({ sha256: SHA_A });
    await act(async () => opens[1]!.resolve({ kind: "opened", pdf: again.pdf }));
    await waitFor(() => expect(boxes()).toHaveLength(1));
  });

  it("closes the document when the viewer goes away", async () => {
    const { close, unmount } = await openWith(SHA_A);
    unmount();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("starts each document at fit width with a new canvas", async () => {
    const { opens, update } = await openWith(SHA_A);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const firstCanvas = screen.getByTestId("pdf-canvas");
    update({ file: pdfFile("b.pdf"), evidence: null });
    const b = fakePdf({ sha256: SHA_B });
    await act(async () => opens[1]!.resolve({ kind: "opened", pdf: b.pdf }));
    const secondCanvas = await screen.findByTestId("pdf-canvas");
    expect(secondCanvas).not.toBe(firstCanvas);
    expect(screen.getByRole("button", { name: "Fit to width" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("rendering", () => {
  it("sizes the canvas in CSS pixels and its backing store in device pixels", async () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    const { renders } = await openWith(SHA_A);
    const scale = SCROLL_WIDTH / 595;
    const call = renders.at(-1)!;
    expect(call.pixelWidth).toBe(Math.floor(595 * scale * 2));
    expect(call.outputScaleX).toBeCloseTo(call.pixelWidth / (595 * scale), 12);
    const canvas = screen.getByTestId("pdf-canvas");
    expect(parseFloat(canvas.style.width)).toBeCloseTo(595 * scale, 9); // CSS size: not doubled
    expect(drawImage).toHaveBeenCalled();
  });

  it("does not render again when only the selected box or evidence visibility changes", async () => {
    const { renders, update } = await openWith(SHA_A);
    const before = renders.length;
    update({ selectedFindingId: "F1" });
    expect(boxes()[0]!.getAttribute("aria-current")).toBe("true");
    fireEvent.click(screen.getByRole("checkbox", { name: "Show evidence" }));
    expect(boxes()).toHaveLength(0);
    fireEvent.click(screen.getByRole("checkbox", { name: "Show evidence" }));
    expect(boxes()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(renders.length).toBe(before);
  });

  it("dims the other boxes when one is selected", async () => {
    const { source, opens } = controlledSource();
    const fake = fakePdf({ sha256: SHA_A });
    show(source, {
      file: pdfFile("a.pdf"),
      evidence: evidenceFor(SHA_A, { items: [item(), item({ key: "F2:M2", findingId: "F2", measurementId: "M2", status: "pass" })] }),
      selectedFindingId: "F2",
    });
    await act(async () => opens[0]!.resolve({ kind: "opened", pdf: fake.pdf }));
    await waitFor(() => expect(boxes()).toHaveLength(2));
    const byKey = Object.fromEntries(boxes().map((b) => [b.dataset.evidenceKey, b]));
    expect(byKey["F2:M2"]!.getAttribute("aria-current")).toBe("true");
    expect(byKey["F1:M1"]!.className).toContain("opacity-40");
  });

  it("re-renders at the new scale after zooming, and moves the boxes with it", async () => {
    const { renders } = await openWith(SHA_A);
    const before = renders.length;
    fireEvent.click(screen.getByRole("button", { name: "Reset zoom to 100%" }));
    expect(screen.getByTestId("zoom-level").textContent).toBe("100%");
    // Boxes follow the new layout immediately...
    expect(parseFloat(boxes()[0]!.style.left)).toBeCloseTo(72, 9);
    // ...and the sharper bitmap follows once zooming settles.
    await waitFor(() => expect(renders.length).toBe(before + 1));
    expect(renders.at(-1)!.scale).toBe(1);
  });

  it("cancels a render that a newer zoom makes obsolete", async () => {
    const { source, opens } = controlledSource();
    const fake = fakePdf({ sha256: SHA_A, autoFinish: false });
    show(source, { file: pdfFile("a.pdf"), evidence: evidenceFor(SHA_A) });
    await act(async () => opens[0]!.resolve({ kind: "opened", pdf: fake.pdf }));
    await waitFor(() => expect(fake.renders).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Reset zoom to 100%" }));
    expect(fake.renders[0]!.cancelled).toBe(true);
  });

  it("ignores a late result from a superseded render, even one that completes after cancel", async () => {
    const { source, opens } = controlledSource();
    const fake = fakePdf({ sha256: SHA_A, autoFinish: false, cancelRejects: false });
    show(source, { file: pdfFile("a.pdf"), evidence: evidenceFor(SHA_A) });
    await act(async () => opens[0]!.resolve({ kind: "opened", pdf: fake.pdf }));
    await waitFor(() => expect(fake.renders).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Reset zoom to 100%" }));
    await waitFor(() => expect(fake.renders).toHaveLength(2));
    await act(async () => fake.renders[1]!.finish());
    await waitFor(() => expect(drawImage).toHaveBeenCalledTimes(1));
    expect(fake.renders[0]!.cancelled).toBe(true);
    await act(async () => fake.renders[0]!.finish()); // cancelled, but finished anyway: must not draw
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("page-stage").dataset.renderCount).toBe("1");
  });

  it("reports a failed render, hides the boxes, and can try again", async () => {
    const { source, opens } = controlledSource();
    const fake = fakePdf({ sha256: SHA_A, autoFinish: false });
    show(source, { file: pdfFile("a.pdf"), evidence: evidenceFor(SHA_A) });
    await act(async () => opens[0]!.resolve({ kind: "opened", pdf: fake.pdf }));
    await waitFor(() => expect(fake.renders).toHaveLength(1));
    await act(async () => fake.renders[0]!.fail());
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("The page could not be drawn.")).toBeTruthy();
    expect(boxes()).toHaveLength(0);
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fake.renders).toHaveLength(2));
    await act(async () => fake.renders[1]!.finish());
    await waitFor(() => expect(boxes()).toHaveLength(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("treats a render that throws at once as a failed render, not an uncaught error", async () => {
    const { source, opens } = controlledSource();
    const fake = fakePdf({ sha256: SHA_A, renderThrows: true });
    show(source, { file: pdfFile("a.pdf"), evidence: evidenceFor(SHA_A) });
    await act(async () => opens[0]!.resolve({ kind: "opened", pdf: fake.pdf }));
    expect(await screen.findByText("The page could not be drawn.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(boxes()).toHaveLength(0);
  });

  it("treats a canvas without a 2D context as a failed render", async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(() => null);
    const { source, opens } = controlledSource();
    const fake = fakePdf({ sha256: SHA_A });
    show(source, { file: pdfFile("a.pdf"), evidence: evidenceFor(SHA_A) });
    await act(async () => opens[0]!.resolve({ kind: "opened", pdf: fake.pdf }));
    expect(await screen.findByText("The page could not be drawn.")).toBeTruthy();
    expect(boxes()).toHaveLength(0);
  });
});

describe("labels", () => {
  const rectOf = (el: HTMLElement) => ({
    left: parseFloat(el.style.left),
    top: parseFloat(el.style.top),
    right: parseFloat(el.style.left) + parseFloat(el.style.width),
    bottom: parseFloat(el.style.top) + parseFloat(el.style.height),
  });
  const overlap = (a: ReturnType<typeof rectOf>, b: ReturnType<typeof rectOf>) =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  it("never covers a box or another label, even for text running vertically on screen", async () => {
    // Four tall, narrow boxes side by side, as on a /Rotate 90 page with upright page text.
    const tall = [0, 1, 2, 3].map((i) =>
      item({
        key: `F${i + 1}:M${i + 1}`,
        findingId: `F${i + 1}`,
        measurementId: `M${i + 1}`,
        bbox: { x0: 200 + i * 20, y0: 300, x1: 209 + i * 20, y1: 390 },
      }),
    );
    const { source, opens } = controlledSource();
    const fake = fakePdf({ sha256: SHA_A });
    show(source, { file: pdfFile("a.pdf"), evidence: evidenceFor(SHA_A, { items: tall }) });
    await act(async () => opens[0]!.resolve({ kind: "opened", pdf: fake.pdf }));
    await waitFor(() => expect(boxes()).toHaveLength(4));
    const labels = [...document.querySelectorAll<HTMLElement>("[data-label-for]")];
    expect(labels.length).toBeGreaterThan(0);
    // The inner boxes have neighbours on both sides, so their labels go above or below.
    for (const key of ["F2:M2", "F3:M3"]) {
      const label = document.querySelector<HTMLElement>(`[data-label-for="${key}"]`);
      expect(["above", "below"]).toContain(label?.dataset.labelSide);
    }
    for (const label of labels) {
      for (const b of boxes()) expect(overlap(rectOf(label), rectOf(b))).toBe(false);
      for (const other of labels) if (other !== label) expect(overlap(rectOf(label), rectOf(other))).toBe(false);
    }
  });

  it("can be hidden without hiding the boxes", async () => {
    await openWith(SHA_A);
    expect(document.querySelectorAll("[data-label-for]")).toHaveLength(1);
    fireEvent.click(screen.getByRole("checkbox", { name: "Labels" }));
    expect(document.querySelectorAll("[data-label-for]")).toHaveLength(0);
    expect(boxes()).toHaveLength(1);
  });
});

describe("zoom controls", () => {
  it("steps by 25%, resets to 100% and returns to fit width", async () => {
    await openWith(SHA_A);
    const fitPercent = `${Math.round((SCROLL_WIDTH / 595) * 100)}%`;
    expect(screen.getByTestId("zoom-level").textContent).toBe(fitPercent);
    fireEvent.click(screen.getByRole("button", { name: "Reset zoom to 100%" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByTestId("zoom-level").textContent).toBe("125%");
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByTestId("zoom-level").textContent).toBe("80%");
    expect(screen.getByRole("button", { name: "Fit to width" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Fit to width" }));
    expect(screen.getByTestId("zoom-level").textContent).toBe(fitPercent);
  });

  it("stops at 400% for an A4 page and at the canvas limit for a large sheet", async () => {
    await openWith(SHA_A);
    for (let i = 0; i < 20; i += 1) fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByTestId("zoom-level").textContent).toBe("400%");
    expect((screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("limits zoom on a sheet too large to draw at 400%", async () => {
    await openWith(SHA_A, { view: [0, 0, 2384, 3370] });
    for (let i = 0; i < 20; i += 1) fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const percent = parseInt(screen.getByTestId("zoom-level").textContent!, 10);
    expect(percent).toBeLessThan(150);
  });

  it("keeps the scroll area keyboard reachable", async () => {
    await openWith(SHA_A);
    const region = screen.getByRole("region", { name: "Drawing, scrollable" });
    expect(region.tabIndex).toBe(0);
  });
});

describe("a selected feature association", () => {
  const association = (overrides: Partial<FeatureAssociation> = {}): FeatureAssociation => ({
    id: "A1",
    annotation_id: "C1",
    page_number: 1,
    relation: "diameter_of_circle",
    status: "verified",
    feature_id: "G1",
    feature: [{ role: "circle", shape: "circle", coords: [200, 300, 25] }],
    evidence: [
      { role: "leader", shape: "line", coords: [265, 300, 225, 300] },
      { role: "arrow", shape: "point", coords: [225, 300] },
    ],
    candidates: 1,
    explanation: "Verified: test.",
    ...overrides,
  });
  const layer = () => document.querySelector<SVGElement>("[data-testid=association-layer]");

  async function openAssociation(sha: string, a: FeatureAssociation | null) {
    const { source, opens } = controlledSource();
    const fake = fakePdf({ sha256: sha });
    show(source, { file: pdfFile("a.pdf"), evidence: evidenceFor(SHA_A), association: a });
    await act(async () => opens[0]!.resolve({ kind: "opened", pdf: fake.pdf }));
    await screen.findByTestId("pdf-canvas");
    await waitFor(() => expect(screen.getByTestId("page-stage").dataset.renderStatus).toBe("ready"));
  }

  it("draws the feature and its evidence through the layout transform", async () => {
    await openAssociation(SHA_A, association());
    const scale = SCROLL_WIDTH / 595;
    expect(layer()).not.toBeNull();
    const ring = layer()!.querySelector<SVGPolygonElement>("polygon[data-role=circle]")!;
    expect(ring.dataset.feature).toBe("true");
    const points = ring.getAttribute("points")!.split(" ").map((p) => p.split(",").map(Number) as [number, number]);
    for (const [x, y] of points) expect(Math.hypot(x - 200 * scale, y - 300 * scale)).toBeCloseTo(25 * scale, 1);
    const leader = layer()!.querySelector("polyline[data-role=leader]")!;
    expect(leader.getAttribute("points")).toBe(`${(265 * scale).toFixed(2)},${(300 * scale).toFixed(2)} ${(225 * scale).toFixed(2)},${(300 * scale).toFixed(2)}`);
    expect(layer()!.querySelector("circle[data-role=arrow]")).not.toBeNull();
  });

  it("draws nothing for an unresolved association", async () => {
    await openAssociation(SHA_A, association({ status: "unresolved", feature_id: null, feature: [], evidence: [] }));
    expect(layer()).toBeNull();
  });

  it("draws nothing on a document that is not the one inspected", async () => {
    await openAssociation(SHA_B, association());
    expect(layer()).toBeNull();
    expect(screen.getByTestId("evidence-status").textContent).toMatch(/not the document/);
  });

  it("draws nothing without a selection", async () => {
    await openAssociation(SHA_A, null);
    expect(layer()).toBeNull();
  });
});
