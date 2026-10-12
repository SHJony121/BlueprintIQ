// @vitest-environment jsdom
//
// UI-state tests. The upload function is replaced by a controllable double, so these
// prove how the screen reacts to each kind of outcome, not that the real network and
// backend produce them; that is covered by tests/ui/real-responses.test.tsx.
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InspectionResult } from "@/api/client";
import { interpretResponse } from "@/api/read-response";
import {
  AT_LIMIT,
  allOutcomesReport,
  ambiguousDimension,
  dimension,
  errorBody,
  fileOfSize,
  finding,
  makeReport,
  material,
  OVER_LIMIT,
  pdf,
  REQUEST_ID,
  source,
} from "../../tests/ui/builders";
import { controlledRun } from "../../tests/ui/controlled-run";
import { InspectionDashboard } from "./inspection-dashboard";
import { SiteHeader } from "./site-header";

afterEach(() => vi.restoreAllMocks());

// applyAccept: false behaves like choosing "All files" in the dialog, so a wrong file type
// reaches the app's own check instead of being filtered by the input's accept attribute.
const setupUser = () => userEvent.setup({ applyAccept: false });

// "Findings (n)", not the screen-reader-only "Findings by outcome" above the summary.
const FINDINGS_HEADING = /^Findings \(\d+\)/;

function open() {
  const control = controlledRun();
  render(<InspectionDashboard run={control.run} />);
  return control;
}

const fileInput = () => screen.getByLabelText(/drop (a|another) pdf/i) as HTMLInputElement;

const ok = (report = makeReport()): InspectionResult => ({
  kind: "report",
  report,
  requestId: REQUEST_ID,
});

const serviceError = (code: string, status = 422): InspectionResult =>
  interpretResponse(status, JSON.stringify(errorBody(code)), REQUEST_ID);

describe("the page frame", () => {
  it("offers a skip link as the first focusable element", async () => {
    const user = setupUser();
    render(<SiteHeader />);
    await user.tab();
    const link = screen.getByRole("link", { name: "Skip to main content" });
    expect(document.activeElement).toBe(link);
    expect(link.getAttribute("href")).toBe("#main");
  });
});

describe("the persistent disclaimer", () => {
  it("states that this is not certified compliance software", () => {
    render(<SiteHeader />);
    const note = screen.getByRole("note");
    expect(note.textContent).toMatch(/not certified engineering-compliance software/i);
    expect(note.textContent).toMatch(/reviewed by a qualified person/i);
  });
});

describe("before any file is chosen", () => {
  it("shows the empty state and explains the four outcomes", () => {
    open();
    expect(screen.getByRole("heading", { level: 1, name: "Inspect a drawing" })).toBeTruthy();
    const empty = screen.getByTestId("empty-results");
    for (const label of ["Fail", "Needs review", "Missing", "Pass"]) {
      expect(within(empty).getByText(label)).toBeTruthy();
    }
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("results-skeleton")).toBeNull();
  });

  it("states the input limits next to the control", () => {
    open();
    expect(screen.getByText(/up to 10 MiB/i)).toBeTruthy();
    expect(screen.getByText(/scanned drawings are not supported/i)).toBeTruthy();
  });

  it("reserves an area for the future viewer without rendering anything in it", () => {
    open();
    const slot = screen.getByTestId("viewer-slot");
    expect(within(slot).getByRole("heading", { name: "Drawing" })).toBeTruthy();
    expect(slot.querySelector("canvas, iframe, object, embed, img")).toBeNull();
  });
});

describe("choosing a file", () => {
  it("sends a valid PDF, shows loading, then the results", async () => {
    const user = setupUser();
    const { calls, run } = open();
    const file = pdf("bracket.pdf");

    await user.upload(fileInput(), file);
    expect(run).toHaveBeenCalledTimes(1);
    expect(calls[0]!.file).toBe(file);
    expect(screen.getByTestId("results-skeleton")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Inspecting bracket.pdf.");
    expect(screen.getByText("bracket.pdf")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();

    calls[0]!.resolve(ok());
    expect(await screen.findByRole("heading", { name: FINDINGS_HEADING })).toBeTruthy();
    expect(screen.queryByTestId("results-skeleton")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/^Inspection complete: 0 fail/);
  });

  it("marks the results region busy while loading", async () => {
    const user = setupUser();
    const { calls } = open();
    await user.upload(fileInput(), pdf());
    expect(screen.getByRole("region", { name: "Results", hidden: true }).getAttribute("aria-busy")).toBe("true");
    calls[0]!.resolve(ok());
    await screen.findByRole("heading", { name: FINDINGS_HEADING });
    expect(screen.getByRole("region", { name: "Results" }).getAttribute("aria-busy")).toBe("false");
  });

  it.each([
    ["a text file", fileOfSize("notes.txt", "text/plain", 12), /Choose a PDF file/],
    ["an image named .pdf", fileOfSize("scan.pdf", "image/png", 12), /Choose a PDF file/],
    ["an empty PDF", fileOfSize("empty.pdf", "application/pdf", 0), /The file is empty/],
    ["a PDF one byte over 10 MiB", fileOfSize("big.pdf", "application/pdf", OVER_LIMIT), /The file is too large/],
  ])("refuses %s in the browser, without sending it", async (_label, file, title) => {
    const user = setupUser();
    const { run } = open();
    await user.upload(fileInput(), file);
    expect(run).not.toHaveBeenCalled();
    const alert = screen.getByRole("alert");
    expect(within(alert).getByRole("heading").textContent).toMatch(title);
    expect(within(alert).getByText(file.name)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("states the exact size when a file is one byte over the limit", async () => {
    const user = setupUser();
    open();
    await user.upload(fileInput(), fileOfSize("big.pdf", "application/pdf", OVER_LIMIT));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("10,485,760 bytes");
    expect(alert.textContent).toContain("10,485,761 bytes");
  });

  it("accepts a PDF of exactly 10 MiB", async () => {
    const user = setupUser();
    const { run } = open();
    await user.upload(fileInput(), fileOfSize("limit.pdf", "application/pdf", AT_LIMIT));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("accepts a PDF whose type is blank when the name ends in .pdf", async () => {
    const user = setupUser();
    const { run } = open();
    await user.upload(fileInput(), fileOfSize("export.PDF", "", 100));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("only offers PDFs in the file dialog", () => {
    open();
    expect(fileInput().accept).toBe("application/pdf,.pdf");
    expect(fileInput().multiple).toBe(false);
  });

  it("can pick the same file twice in a row", async () => {
    const user = setupUser();
    const { run, calls } = open();
    const file = pdf();
    await user.upload(fileInput(), file);
    calls[0]!.resolve(ok());
    await screen.findByRole("heading", { name: FINDINGS_HEADING });
    await user.upload(fileInput(), file);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("the four finding outcomes", () => {
  async function showAll() {
    const user = setupUser();
    const control = open();
    await user.upload(fileInput(), pdf());
    control.calls[0]!.resolve(ok(allOutcomesReport()));
    await screen.findByRole("heading", { name: FINDINGS_HEADING });
    return control;
  }

  it("counts each outcome separately in the summary", async () => {
    await showAll();
    for (const status of ["fail", "needs_review", "missing", "pass"]) {
      expect(within(screen.getByTestId(`summary-${status}`)).getByText("1")).toBeTruthy();
    }
  });

  it("lists problems first: fail, needs review, missing, pass", async () => {
    await showAll();
    const ids = [...document.querySelectorAll("li[id^=finding-]")].map((li) => li.id);
    expect(ids).toEqual(["finding-F4", "finding-F3", "finding-F2", "finding-F1"]);
  });

  it("writes every outcome as text, not just colour", async () => {
    await showAll();
    const list = document.querySelector("ol")!;
    const badges = within(list as HTMLElement).getAllByText(/^(Fail|Needs review|Missing|Pass)$/);
    expect(badges.map((b) => b.textContent)).toEqual(["Fail", "Needs review", "Missing", "Pass"]);
  });

  it("shows rule id, severity, expected, actual, explanation and measurement references", async () => {
    await showAll();
    const item = document.getElementById("finding-F4")!;
    expect(within(item).getByText("DIA-MAX-001")).toBeTruthy();
    expect(within(item).getByText("Severity: Error")).toBeTruthy();
    expect(within(item).getByText("Hole diameter must not exceed 50 mm.")).toBeTruthy();
    expect(within(item).getByText("<= 50 mm")).toBeTruthy();
    expect(within(item).getByText("60 mm")).toBeTruthy();
    expect(within(item).getByText("Diameter 60 mm exceeds the limit (<= 50 mm).")).toBeTruthy();
    const link = within(item).getByRole("link", { name: /M3/ });
    expect(link.getAttribute("href")).toBe("#measurement-M3");
  });

  it("shows a warning severity as such", async () => {
    await showAll();
    expect(within(document.getElementById("finding-F3")!).getByText("Severity: Warning")).toBeTruthy();
  });

  it("says a missing finding found nothing, without inventing an actual value", async () => {
    await showAll();
    const item = document.getElementById("finding-F2")!;
    expect(within(item).getByText("Not found in the drawing")).toBeTruthy();
    expect(within(item).getByText(/none, nothing matched/)).toBeTruthy();
    expect(within(item).queryByRole("link")).toBeNull();
  });

  it("links every measurement reference to a measurement that exists", async () => {
    await showAll();
    const links = [...document.querySelectorAll<HTMLAnchorElement>("a[href^='#measurement-']")];
    expect(links.length).toBe(3);
    for (const link of links) {
      expect(document.getElementById(link.getAttribute("href")!.slice(1))).not.toBeNull();
    }
  });
});

describe("measurements and source metadata", () => {
  async function show(report = makeReport()) {
    const user = setupUser();
    const control = open();
    await user.upload(fileInput(), pdf());
    control.calls[0]!.resolve(ok(report));
    await screen.findByRole("heading", { name: /^Extracted measurements/ });
  }

  it("shows value, unit, source text, page and location for a parsed measurement", async () => {
    await show();
    const item = document.getElementById("measurement-M1")!;
    expect(within(item).getByText("Thickness")).toBeTruthy();
    expect(within(item).getByText("Read")).toBeTruthy();
    expect(item.textContent).toContain("4\u00a0mm");
    expect(within(item).getByText("“THICKNESS: 4 mm”")).toBeTruthy();
    expect(within(item).getByText("x 72.0 to 159.8, y 549.3 to 563.0 pt")).toBeTruthy();
  });

  it("shows decimals exactly as sent, including trailing zeros", async () => {
    await show(
      makeReport({
        measurements: [dimension({ value: "4.10", normalized_value_mm: "4.10" })],
        findings: [],
      }),
    );
    expect(document.getElementById("measurement-M1")!.textContent).toContain("4.10\u00a0mm");
  });

  it("shows the converted value only when the unit is not millimetres", async () => {
    await show(
      makeReport({
        measurements: [
          dimension({ id: "M1", value: "1", unit: "in", normalized_value_mm: "25.4" }),
          dimension({ id: "M2", value: "5", unit: "mm", normalized_value_mm: "5" }),
        ],
        findings: [],
      }),
    );
    expect(document.getElementById("measurement-M1")!.textContent).toContain("1\u00a0in = 25.4\u00a0mm");
    expect(document.getElementById("measurement-M2")!.textContent).not.toContain("=");
  });

  it("marks an ambiguous measurement and says why, without guessing a unit", async () => {
    await show(makeReport({ measurements: [ambiguousDimension({ id: "M1" })], findings: [] }));
    const item = document.getElementById("measurement-M1")!;
    expect(within(item).getByText("Ambiguous")).toBeTruthy();
    expect(within(item).getByText(/capitalisation is ambiguous/)).toBeTruthy();
    expect(item.textContent).not.toMatch(/\smm\b/); // \s also matches a non-breaking space
    expect(within(item).getByText("Not available")).toBeTruthy(); // no bounding box was provided
  });

  it("says when no value was read at all", async () => {
    await show(
      makeReport({
        measurements: [
          ambiguousDimension({ id: "M1", value: null, issues: ["missing_value"] }),
          material({ id: "M2", value: null, status: "ambiguous", issues: ["missing_value"] }),
        ],
        findings: [],
      }),
    );
    expect(within(document.getElementById("measurement-M1")!).getByText("No value read")).toBeTruthy();
    expect(within(document.getElementById("measurement-M2")!).getByText("No value read")).toBeTruthy();
  });

  it("shows a material as text", async () => {
    await show(makeReport({ measurements: [material({ id: "M1" })], findings: [] }));
    const item = document.getElementById("measurement-M1")!;
    expect(within(item).getByText("Material")).toBeTruthy();
    expect(item.textContent).toContain("SS400");
  });

  it("says plainly when nothing was extracted or evaluated", async () => {
    await show(makeReport({ measurements: [], findings: [] }));
    expect(screen.getByText(/ruleset produced no findings/i)).toBeTruthy();
    expect(screen.getByText(/No supported annotation was read/i)).toBeTruthy();
  });

  it("lists annotations that were found but not evaluated", async () => {
    await show(
      makeReport({
        overrides: {
          unrecognized_annotations: [{ label: "FINISH", source: source("FINISH: ZINC") }],
        },
      }),
    );
    const section = screen.getByRole("heading", { name: /Annotations not evaluated/ }).closest("section")!;
    expect(within(section).getByText("FINISH")).toBeTruthy();
    expect(within(section).getByText("“FINISH: ZINC”")).toBeTruthy();
  });

  it("shows document metadata from the report", async () => {
    await show();
    const section = screen.getByRole("heading", { name: "Source document" }).closest("section")!;
    expect(within(section).getByText("bracket.pdf")).toBeTruthy();
    expect(within(section).getByText("1.3 KiB")).toBeTruthy();
    expect(within(section).getByText("a".repeat(64))).toBeTruthy();
    expect(within(section).getByText("demo-plate-part 0.1.0")).toBeTruthy();
    expect(within(section).getByText("595.0 × 842.0 pt, rotation 0°")).toBeTruthy();
    expect(within(section).getByText("1.20 s")).toBeTruthy();
  });

  it("says when the file name was not provided", async () => {
    const base = makeReport();
    await show(makeReport({ overrides: { document: { ...base.document, filename: null } } }));
    expect(screen.getByText("Not provided")).toBeTruthy();
  });

  it("renders markup in the drawing's text as text, never as HTML", async () => {
    await show(
      makeReport({
        measurements: [
          dimension({ source: source('<img src=x onerror="window.__pwned=1">THICKNESS: 4 mm') }),
        ],
        findings: [finding("pass", { message: "<b>bold</b> message" })],
      }),
    );
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getByText("<b>bold</b> message")).toBeTruthy();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe("failures are not results", () => {
  async function fail(result: InspectionResult) {
    const user = setupUser();
    const control = open();
    await user.upload(fileInput(), pdf());
    control.calls[0]!.resolve(result);
    await screen.findByRole("alert");
    return { user, ...control };
  }

  function expectNoResults() {
    expect(screen.queryByTestId("summary-fail")).toBeNull();
    expect(screen.queryByRole("heading", { name: FINDINGS_HEADING })).toBeNull();
    expect(screen.queryByRole("heading", { name: /^Extracted measurements/ })).toBeNull();
    // Not the "choose a PDF" invitation, which would contradict the message above it.
    expect(screen.getByTestId("empty-results").textContent).toMatch(/No results for this file/);
  }

  it.each([
    ["NO_TEXT_LAYER", 422, /No readable text found/],
    ["INVALID_PDF", 422, /could not be read/],
    ["ENCRYPTED_PDF", 422, /encrypted/],
    ["TOO_MANY_PAGES", 422, /single-page/],
    ["UNSUPPORTED_GEOMETRY", 422, /layout is not supported/],
    ["PARTIALLY_VISIBLE_TEXT", 422, /Some text is cut off/],
    ["FILE_TOO_LARGE", 413, /too large/],
    ["SERVER_BUSY", 503, /busy/],
  ])("explains %s in plain language and shows no results", async (code, status, title) => {
    await fail(serviceError(code, status));
    const alert = screen.getByRole("alert");
    expect(within(alert).getByRole("heading").textContent).toMatch(title);
    expect(within(alert).getByText(code)).toBeTruthy();
    expect(within(alert).getByText(REQUEST_ID)).toBeTruthy();
    expectNoResults();
  });

  it("explains an unavailable backend and offers to try again", async () => {
    const { user, run } = await fail(serviceError("BACKEND_UNAVAILABLE", 502));
    expect(within(screen.getByRole("alert")).getByRole("heading").textContent).toMatch(/not reachable/);
    expectNoResults();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(run).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("results-skeleton")).toBeTruthy();
  });

  it("explains a timeout reported by the proxy", async () => {
    await fail(serviceError("BACKEND_TIMEOUT", 504));
    expect(screen.getByRole("heading", { name: /did not answer in time/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expectNoResults();
  });

  it("explains a client-side timeout and a lost connection", async () => {
    await fail({ kind: "timeout" });
    expect(screen.getByRole("heading", { name: "No answer was received" })).toBeTruthy();
  });

  it("explains an unreachable app", async () => {
    await fail({ kind: "network" });
    expect(screen.getByRole("heading", { name: "The app could not be reached" })).toBeTruthy();
    expectNoResults();
  });

  it.each([
    ["HTML instead of JSON", interpretResponse(200, "<html>oops</html>", null)],
    ["a report with an unknown status", interpretResponse(200, JSON.stringify({ ...makeReport(), findings: [{ ...finding("pass"), status: "passed" }] }), null)],
    ["an error body with status 200", interpretResponse(200, JSON.stringify(errorBody("INVALID_PDF")), null)],
    ["a report with an error status", interpretResponse(422, JSON.stringify(makeReport()), null)],
    ["a truncated body", interpretResponse(200, '{"schema_version":"1.0","docu', null)],
  ])("does not crash on %s, and says the reply was unusable", async (_label, result) => {
    await fail(result);
    expect(screen.getByRole("heading", { name: "The reply could not be understood" })).toBeTruthy();
    expect(screen.getByText(/not a result for your drawing/)).toBeTruthy();
    expectNoResults();
  });

  it("does not offer a retry when the file itself is the problem", async () => {
    await fail(serviceError("NO_TEXT_LAYER"));
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("replaces a result with the error when the next file fails", async () => {
    const user = setupUser();
    const { calls } = open();
    await user.upload(fileInput(), pdf("good.pdf"));
    calls[0]!.resolve(ok());
    await screen.findByRole("heading", { name: FINDINGS_HEADING });

    await user.upload(fileInput(), pdf("bad.pdf"));
    calls[1]!.resolve(serviceError("INVALID_PDF"));
    await screen.findByRole("alert");
    expect(screen.queryByRole("heading", { name: FINDINGS_HEADING })).toBeNull();
    expect(screen.getByText("bad.pdf")).toBeTruthy();
    expect(screen.queryByText("good.pdf")).toBeNull();
  });

  it("clears the previous result when the next file is refused in the browser", async () => {
    const user = setupUser();
    const { calls } = open();
    await user.upload(fileInput(), pdf());
    calls[0]!.resolve(ok());
    await screen.findByRole("heading", { name: FINDINGS_HEADING });

    await user.upload(fileInput(), fileOfSize("notes.txt", "text/plain", 5));
    expect(screen.queryByRole("heading", { name: FINDINGS_HEADING })).toBeNull();
    expect(within(screen.getByRole("alert")).getByText("notes.txt")).toBeTruthy();
  });
});

describe("repeated selection and stale requests", () => {
  it("shows the second file's result even if the first answers last", async () => {
    const user = setupUser();
    const { calls } = open();
    const named = (name: string) =>
      makeReport({
        overrides: { document: { ...makeReport().document, filename: name } },
        findings: name === "first.pdf" ? [finding("fail")] : [finding("pass")],
      });

    await user.upload(fileInput(), pdf("first.pdf"));
    await user.upload(fileInput(), pdf("second.pdf"));
    expect(calls[0]!.signal.aborted).toBe(true);

    calls[1]!.resolve(ok(named("second.pdf")));
    await screen.findByRole("heading", { name: FINDINGS_HEADING });
    calls[0]!.resolve(ok(named("first.pdf"))); // late, abandoned
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.getByText("second.pdf", { selector: "span.font-mono" })).toBeTruthy();
    expect(within(screen.getByTestId("summary-pass")).getByText("1")).toBeTruthy();
    expect(within(screen.getByTestId("summary-fail")).getByText("0")).toBeTruthy();
  });

  it("keeps loading for the new file when the old file's answer arrives", async () => {
    const user = setupUser();
    const { calls } = open();
    await user.upload(fileInput(), pdf("first.pdf"));
    await user.upload(fileInput(), pdf("second.pdf"));
    calls[0]!.resolve(ok());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId("results-skeleton")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Inspecting second.pdf.");
  });

  it("cancel stops the request and returns to the start", async () => {
    const user = setupUser();
    const { calls } = open();
    await user.upload(fileInput(), pdf());
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(screen.getByTestId("empty-results")).toBeTruthy();
    calls[0]!.resolve(ok());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("heading", { name: FINDINGS_HEADING })).toBeNull();
  });
});

describe("drag and drop", () => {
  const dropData = (...files: File[]) => ({ dataTransfer: { types: ["Files"], files } });
  const zone = () => fileInput().closest("label")!;

  it("accepts a dropped PDF", () => {
    const { run } = open();
    const file = pdf("dropped.pdf");
    fireEvent.drop(zone(), dropData(file));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toBe(file);
  });

  it("refuses several dropped files and says so", () => {
    const { run } = open();
    fireEvent.drop(zone(), dropData(pdf("a.pdf"), pdf("b.pdf")));
    expect(run).not.toHaveBeenCalled();
    expect(within(screen.getByRole("alert")).getByRole("heading").textContent).toBe(
      "Choose one file at a time",
    );
  });

  it("refuses a dropped file of the wrong type", () => {
    const { run } = open();
    fireEvent.drop(zone(), dropData(fileOfSize("a.png", "image/png", 5)));
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("invites the drop while a file is over the area, and stops when it leaves", () => {
    open();
    const area = zone(); // its label changes while dragging, so look it up once
    expect(fireEvent.dragEnter(area, dropData())).toBe(false); // default prevented: a valid target
    expect(screen.getByText("Drop the PDF to inspect it")).toBeTruthy();
    fireEvent.dragLeave(area, { relatedTarget: document.body });
    expect(screen.getByText("Drop a PDF drawing here")).toBeTruthy();
  });

  it("does not treat dragged text as a file drop", () => {
    open();
    expect(fireEvent.dragEnter(zone(), { dataTransfer: { types: ["text/plain"], files: [] } })).toBe(true);
    expect(screen.queryByText("Drop the PDF to inspect it")).toBeNull();
  });

  it("stops the browser opening a file that is dropped outside the drop area", () => {
    const { run } = open();
    const prevented = !fireEvent.drop(document.body, dropData(pdf()));
    expect(prevented).toBe(true);
    expect(!fireEvent.dragOver(document.body, dropData())).toBe(true);
    expect(run).not.toHaveBeenCalled();
    // Dragged text is left alone.
    expect(fireEvent.drop(document.body, { dataTransfer: { types: ["text/plain"], files: [] } })).toBe(true);
  });

  it("removes its page-level listeners when the screen goes away", () => {
    const { unmount } = render(<InspectionDashboard run={controlledRun().run} />);
    unmount();
    expect(fireEvent.drop(document.body, dropData(pdf()))).toBe(true);
  });
});

describe("keyboard use", () => {
  it("reaches the file input first, with a name and the limits as its description", async () => {
    const user = setupUser();
    open();
    await user.tab();
    const input = fileInput();
    expect(document.activeElement).toBe(input);
    expect(input.labels?.[0]?.textContent).toMatch(/Drop a PDF drawing here/);
    expect(input.labels?.[0]?.textContent).toMatch(/choose a file/);
    const description = document.getElementById(input.getAttribute("aria-describedby")!);
    expect(description?.textContent).toMatch(/up to 10 MiB/);
  });

  it("is a native file input, not a custom widget", () => {
    open();
    expect(fileInput().tagName).toBe("INPUT");
    expect(fileInput().type).toBe("file");
  });

  it("cancels with Enter and with Space", async () => {
    for (const key of ["{Enter}", " "]) {
      const user = setupUser();
      const { calls } = open();
      await user.upload(fileInput(), pdf());
      await user.tab(); // input, then the Cancel button
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
      await user.keyboard(key);
      expect(calls[0]!.signal.aborted).toBe(true);
      expect(screen.getByTestId("empty-results")).toBeTruthy();
      document.body.innerHTML = "";
    }
  });

  it("retries from the keyboard", async () => {
    const user = setupUser();
    const { calls, run } = open();
    await user.upload(fileInput(), pdf());
    calls[0]!.resolve(serviceError("SERVER_BUSY", 503));
    await screen.findByRole("alert");
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Try again" }));
    await user.keyboard("{Enter}");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("makes every measurement reference reachable by Tab", async () => {
    const user = setupUser();
    const { calls } = open();
    await user.upload(fileInput(), pdf());
    calls[0]!.resolve(ok(allOutcomesReport()));
    await screen.findByRole("heading", { name: FINDINGS_HEADING });
    const links = screen.getAllByRole("link");
    expect(links.length).toBe(3);
    const reached = new Set<Element>();
    for (let i = 0; i < links.length + 3; i += 1) {
      await user.tab();
      if (links.includes(document.activeElement as HTMLAnchorElement)) {
        reached.add(document.activeElement!);
      }
    }
    expect(reached.size).toBe(links.length);
  });

  it("announces progress and completion to screen readers", async () => {
    const user = setupUser();
    const { calls } = open();
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");
    await user.upload(fileInput(), pdf("bracket.pdf"));
    expect(status.textContent).toBe("Inspecting bracket.pdf.");
    calls[0]!.resolve(ok(allOutcomesReport()));
    await screen.findByRole("heading", { name: FINDINGS_HEADING });
    expect(status.textContent).toBe("Inspection complete: 1 fail, 1 need review, 1 missing, 1 pass.");
  });

  it("announces a failure through an alert", async () => {
    const user = setupUser();
    const { calls } = open();
    await user.upload(fileInput(), pdf());
    calls[0]!.resolve(serviceError("INVALID_PDF"));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});

describe("nothing is kept", () => {
  it("never writes the file or the report to browser storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const user = setupUser();
    const { calls } = open();
    await user.upload(fileInput(), pdf());
    calls[0]!.resolve(ok(allOutcomesReport()));
    await screen.findByRole("heading", { name: FINDINGS_HEADING });
    await user.upload(fileInput(), fileOfSize("notes.txt", "text/plain", 5));

    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
  });
});
