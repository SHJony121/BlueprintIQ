// @vitest-environment jsdom
//
// F4: selecting a finding highlights its boxes, selecting a box selects its finding.
// The dashboard runs with a controllable upload and a fake PDF engine, so these tests are
// about state, focus and scrolling; geometry and pixels are F3's tests and the browser
// scenarios in tests/e2e/linking.spec.ts.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allOutcomesReport,
  box,
  dimension,
  finding,
  makeReport,
  pdf,
  REQUEST_ID,
  source,
} from "../../tests/ui/builders";
import { controlledRun } from "../../tests/ui/controlled-run";
import { controlledSource, fakePdf, idleSource } from "../../tests/ui/fake-pdf";
import { InspectionDashboard } from "./inspection-dashboard";

const SHA = "a".repeat(64); // builders' report sha; the fake PDF reports the same
let stageTop = 0;
const scrollTo = vi.fn();
const scrollIntoView = vi.fn();

beforeEach(() => {
  stageTop = 0;
  scrollTo.mockReset();
  scrollIntoView.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => ({ drawImage() {} }) as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "viewer-scroll" ? 620 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "viewer-scroll" ? 600 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const top = this.dataset.testid === "page-stage" ? stageTop : 0;
    return { left: 0, top, right: 620, bottom: top + 880, width: 620, height: 880, x: 0, y: top, toJSON() {} };
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
});
afterEach(() => vi.restoreAllMocks());

const boxes = () => [...document.querySelectorAll<HTMLButtonElement>("[data-evidence-key]")];
const boxFor = (key: string) => document.querySelector<HTMLButtonElement>(`[data-evidence-key="${key}"]`)!;
const card = (id: string) => document.getElementById(`finding-${id}`)!;
const selectButton = (id: string) => within(card(id)).getByRole("button", { name: `Select finding ${id}` });
const selectedCards = () => [...document.querySelectorAll("li[data-selected=true]")].map((li) => li.id);

/** Dashboard with a report whose evidence is drawable: the fake PDF matches its hash and page. */
async function shown(report = allOutcomesReport()) {
  const run = controlledRun();
  const pdfSource = controlledSource();
  const fake = fakePdf({ sha256: SHA });
  const user = userEvent.setup({ applyAccept: false });
  render(<InspectionDashboard run={run.run} pdfSource={pdfSource.source} />);
  await user.upload(screen.getByLabelText(/drop a pdf drawing/i), pdf("a.pdf"));
  await act(async () => run.calls[0]!.resolve({ kind: "report", report, requestId: REQUEST_ID }));
  await act(async () => pdfSource.opens[0]!.resolve({ kind: "opened", pdf: fake.pdf }));
  await waitFor(() => expect(boxes().length).toBeGreaterThan(0));
  return { user, run, pdfSource, fake };
}

describe("finding to evidence", () => {
  it("selecting a finding makes its boxes prominent and dims the others, and says so in words", async () => {
    const { user } = await shown();
    await user.click(selectButton("F4"));
    expect(selectedCards()).toEqual(["finding-F4"]);
    expect(selectButton("F4").getAttribute("aria-pressed")).toBe("true");
    expect(selectButton("F4").textContent).toBe("Selected"); // not colour alone
    expect(boxFor("F4:M3").getAttribute("aria-pressed")).toBe("true");
    expect(boxFor("F1:M1").getAttribute("aria-pressed")).toBe("false");
    expect(boxFor("F1:M1").className).toContain("opacity-40");
    expect(screen.getByTestId("selection-status").textContent).toMatch(/F4 is selected: 1 box on the drawing/);
    expect(document.querySelector('[data-label-for="F4:M3"]')?.textContent).toContain("(selected)");
  });

  it("highlights every box of a finding with several", async () => {
    const report = makeReport({
      measurements: [
        dimension({ id: "M1" }),
        dimension({ id: "M2", source: source("THICKNESS: 5 mm", { bbox: box({ y0: 569.3, y1: 583 }) }) }),
      ],
      findings: [
        finding("needs_review", {
          measurement_ids: ["M1", "M2"],
          evidence: [
            { measurement_id: "M1", page_number: 1, bbox: box() },
            { measurement_id: "M2", page_number: 1, bbox: box({ y0: 569.3, y1: 583 }) },
          ],
        }),
      ],
    });
    const { user } = await shown(report);
    await user.click(selectButton("F1"));
    expect(boxes().map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "true"]);
    expect(screen.getByTestId("selection-status").textContent).toMatch(/2 boxes on the drawing/);
  });

  it("selecting the same finding again clears the selection", async () => {
    const { user } = await shown();
    await user.click(selectButton("F4"));
    await user.click(selectButton("F4"));
    expect(selectedCards()).toEqual([]);
    expect(boxes().every((b) => b.getAttribute("aria-pressed") === "false")).toBe(true);
    expect(screen.queryByTestId("selection-status")).toBeNull();
  });

  it("clicking anywhere on a finding's card selects it, without stealing its links", async () => {
    const { user } = await shown();
    await user.click(within(card("F4")).getByText("Hole diameter must not exceed 50 mm."));
    expect(selectedCards()).toEqual(["finding-F4"]);
  });

  it("explains a finding that has no location, and invents no highlight", async () => {
    const { user } = await shown();
    await user.click(selectButton("F2")); // missing: nothing was found
    expect(selectedCards()).toEqual(["finding-F2"]);
    expect(boxes().every((b) => b.getAttribute("aria-pressed") === "false")).toBe(true);
    expect(screen.getByTestId("selection-status").textContent).toMatch(/F2 is selected, but it is not marked on the drawing: nothing was found to mark/);
    expect(screen.getByTestId("location-F2").textContent).toMatch(/Not marked: nothing was found to mark/);
    await user.click(selectButton("F3")); // needs review: a measurement with no position
    expect(screen.getByTestId("selection-status").textContent).toMatch(/its position is not known/);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("shows where each finding is marked, before anything is selected", async () => {
    await shown();
    expect(screen.getByTestId("location-F4").textContent).toBe("1 evidence box on the drawing.");
    expect(screen.getByTestId("location-F3").textContent).toMatch(/Not marked: its position is not known/);
  });
});

describe("evidence to finding", () => {
  it("clicking a box selects its finding", async () => {
    await shown();
    fireEvent.click(boxFor("F4:M3"), { detail: 0 });
    expect(selectedCards()).toEqual(["finding-F4"]);
    expect(boxFor("F4:M3").getAttribute("aria-pressed")).toBe("true");
  });

  it("works from the keyboard and keeps focus on the box", async () => {
    const { user } = await shown();
    boxFor("F4:M3").focus();
    await user.keyboard("{Enter}");
    expect(selectedCards()).toEqual(["finding-F4"]);
    expect(document.activeElement).toBe(boxFor("F4:M3"));
    await user.keyboard(" ");
    expect(selectedCards()).toEqual([]); // Space on the selected box's finding again
  });

  it("has an accessible name that says which finding and what it does", async () => {
    await shown();
    expect(boxFor("F4:M3").getAttribute("aria-label")).toBe("Fail: DIA-MAX-001, finding F4, measurement M3. Select this finding");
  });

  it("scrolls the findings panel to the finding only if it is not already visible, and leaves focus alone", async () => {
    await shown();
    const element = card("F4");
    const rect = vi.spyOn(element, "getBoundingClientRect");
    boxFor("F4:M3").focus();
    rect.mockReturnValue({ top: 100, bottom: 300 } as DOMRect); // already on screen
    fireEvent.click(boxFor("F4:M3"), { detail: 0 });
    expect(scrollIntoView).not.toHaveBeenCalled();
    fireEvent.click(boxFor("F4:M3"), { detail: 0 }); // deselect
    rect.mockReturnValue({ top: -400, bottom: -200 } as DOMRect); // scrolled out of view
    fireEvent.click(boxFor("F4:M3"), { detail: 0 });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(document.activeElement).toBe(boxFor("F4:M3"));
  });

  it("with exactly overlapping boxes, a click picks the most important finding, and clicking again cycles", async () => {
    // F1 (pass) and F4 (fail) mark the same measurement text: the same rectangle.
    await shown();
    const at = { detail: 1, clientX: 100, clientY: 580 }; // inside the shared rectangle (y 572 to 587)
    fireEvent.click(boxFor("F1:M1"), at); // the click lands on whichever button is on top; the pick is by importance
    expect(selectedCards()).toEqual(["finding-F4"]);
    fireEvent.click(boxFor("F4:M3"), at);
    expect(selectedCards()).toEqual(["finding-F1"]);
    fireEvent.click(boxFor("F4:M3"), at);
    expect(selectedCards()).toEqual(["finding-F4"]);
    expect(screen.getByTestId("selection-status").textContent).toMatch(/Overlaps F1; click the box again to switch/);
  });

  it("keeps both overlapping boxes reachable by Tab", async () => {
    await shown();
    expect(boxes().map((b) => b.dataset.evidenceKey).sort()).toEqual(["F1:M1", "F4:M3"]);
    expect(boxes().every((b) => b.tabIndex === 0)).toBe(true);
  });
});

describe("the viewer follows a selection made in the findings panel", () => {
  it("scrolls the viewer's own area when the boxes are out of view, and not when they are visible", async () => {
    const { user } = await shown();
    stageTop = 0; // the boxes (about y 572 to 585 at this scale) are inside the 600 px area
    await user.click(selectButton("F4"));
    expect(scrollTo).not.toHaveBeenCalled();
    await user.click(selectButton("F4")); // deselect
    stageTop = -900; // the page is scrolled so the boxes are above the visible area
    await user.click(selectButton("F4"));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    const { top } = scrollTo.mock.calls[0]![0] as { top: number };
    expect(top).toBeLessThan(0); // scrolls back up toward the boxes
  });

  it("does not scroll when the selection came from a box, or when zoom changes", async () => {
    const { user } = await shown();
    stageTop = -900;
    fireEvent.click(boxFor("F4:M3"), { detail: 0 });
    expect(scrollTo).not.toHaveBeenCalled();
    await user.click(selectButton("F1")); // reveals once
    expect(scrollTo).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("never renders the page again just because the selection changes", async () => {
    const { user, fake } = await shown();
    await waitFor(() => expect(fake.renders.length).toBeGreaterThan(0));
    const before = fake.renders.length;
    await user.click(selectButton("F4"));
    fireEvent.click(boxFor("F1:M1"), { detail: 0 });
    await user.click(selectButton("F2"));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(fake.renders.length).toBe(before);
  });
});

describe("selection never outlives its inspection", () => {
  it("is cleared when another file is chosen, and does not come back with the next report", async () => {
    const { user, run, pdfSource } = await shown();
    await user.click(selectButton("F4"));
    expect(selectedCards()).toEqual(["finding-F4"]);

    await user.upload(screen.getByLabelText(/drop another pdf/i), pdf("b.pdf"));
    expect(selectedCards()).toEqual([]);
    expect(boxes()).toHaveLength(0);
    expect(screen.queryByTestId("selection-status")).toBeNull();

    // The new inspection has a finding with the same id; it must not be pre-selected.
    await act(async () => run.calls[1]!.resolve({ kind: "report", report: allOutcomesReport(), requestId: REQUEST_ID }));
    const second = fakePdf({ sha256: SHA });
    await act(async () => pdfSource.opens[1]!.resolve({ kind: "opened", pdf: second.pdf }));
    await waitFor(() => expect(boxes().length).toBeGreaterThan(0));
    expect(selectedCards()).toEqual([]);
    expect(boxes().every((b) => b.getAttribute("aria-pressed") === "false")).toBe(true);
  });

  it("is cleared when the new file is refused", async () => {
    const { user } = await shown();
    await user.click(selectButton("F4"));
    await user.upload(screen.getByLabelText(/drop another pdf/i), new File(["x"], "notes.txt", { type: "text/plain" }));
    expect(selectedCards()).toEqual([]);
    expect(screen.queryByRole("heading", { name: /^Findings \(/ })).toBeNull();
  });
});

describe("where the drawing is not available", () => {
  it("still selects findings from the keyboard, so the panel works on its own", async () => {
    const run = controlledRun();
    const user = userEvent.setup({ applyAccept: false });
    render(<InspectionDashboard run={run.run} pdfSource={idleSource} />);
    await user.upload(screen.getByLabelText(/drop a pdf drawing/i), pdf("a.pdf"));
    await act(async () => run.calls[0]!.resolve({ kind: "report", report: allOutcomesReport(), requestId: REQUEST_ID }));
    const button = await screen.findByRole("button", { name: "Select finding F4" });
    button.focus();
    await user.keyboard("{Enter}");
    expect(selectedCards()).toEqual(["finding-F4"]);
    expect(document.activeElement).toBe(button);
    expect(boxes()).toHaveLength(0);
  });
});
