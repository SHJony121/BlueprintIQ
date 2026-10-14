// @vitest-environment jsdom
// The Launch-2 site: landing page, information pages, sample drawings through the normal
// upload path, mobile notes and the results reading aids.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeatureAssociation } from "@/api/types";
import { SAMPLES, loadSample, sampleById } from "@/inspection/samples";
import { cadAnnotation, errorBody, finding, makeReport, pdf, REQUEST_ID } from "../../tests/ui/builders";
import { controlledRun } from "../../tests/ui/controlled-run";
import { idleSource } from "../../tests/ui/fake-pdf";
import AboutPage from "@/app/about/page";
import PrivacyPage from "@/app/privacy/page";
import NotFound from "@/app/not-found";
import ErrorPage from "@/app/error";
import { interpretResponse } from "@/api/read-response";
import { InspectionDashboard } from "./inspection-dashboard";
import { Landing } from "./landing/landing";
import { ReportView } from "./report-view";
import { SiteFooter } from "./site-footer";

let pathname = "/inspect";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
import { SiteNav } from "./site-nav";

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

const user = () => userEvent.setup({ applyAccept: false });
const samplePdf = (name: string) => new File([new Uint8Array(1319)], name, { type: "application/pdf" });

function openDashboard(fetchSample = vi.fn(async (s: { file: string }) => samplePdf(s.file))) {
  const control = controlledRun();
  render(<InspectionDashboard run={control.run} pdfSource={idleSource} fetchSample={fetchSample} />);
  return { ...control, fetchSample };
}

describe("the landing page", () => {
  it("introduces the product and offers both ways in", () => {
    render(<Landing />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/evidence beside every result/);
    expect(screen.getAllByRole("link", { name: "Upload Drawing" })[0]!.getAttribute("href")).toBe("/inspect");
    expect(screen.getByRole("link", { name: "Try Sample" }).getAttribute("href")).toBe("/inspect?sample=cad");
    for (const name of ["What it does", "Which drawings it supports", "What it does not do", "How it works", "Read this before relying on a result"]) {
      expect(screen.getByRole("heading", { name })).toBeTruthy();
    }
  });

  it("states its limits and does not claim AI or machine learning", () => {
    const { container } = render(<Landing />);
    const text = container.textContent ?? "";
    expect(text).toMatch(/not certified engineering-compliance software/);
    expect(text).toMatch(/not machine learning/);
    expect(text).not.toMatch(/AI-powered|powered by AI|artificial intelligence|guarantee/i);
    expect(text).toMatch(/Do not upload files you may not share/);
  });

  it("has an accessible illustration with a caption that says it is not a live result", () => {
    render(<Landing />);
    expect(screen.getByRole("img", { name: /dimensioned plate/i })).toBeTruthy();
    expect(screen.getByText(/Illustration of the CAD-style sample/)).toBeTruthy();
  });
});

describe("navigation and footer", () => {
  it("marks the current page", () => {
    pathname = "/about";
    render(<SiteNav />);
    expect(screen.getByRole("link", { name: "How it works" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Inspect" }).getAttribute("aria-current")).toBeNull();
    pathname = "/inspect";
  });

  it("links the information pages, the licence and the configured source from the footer", () => {
    render(<SiteFooter source={new URL("https://example.org/owner/blueprintiq")} />);
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByRole("link", { name: "Privacy" }).getAttribute("href")).toBe("/privacy");
    expect(within(footer).getByRole("link", { name: /How it works/ }).getAttribute("href")).toBe("/about");
    expect(within(footer).getByRole("link", { name: "Source code" }).getAttribute("href")).toBe(
      "https://example.org/owner/blueprintiq",
    );
    expect(footer.textContent).toMatch(/GNU Affero General Public License v3/);
  });
});

describe("the information pages", () => {
  const text = (node: ReactNode) => render(<>{node}</>).container.textContent ?? "";

  it("explains the method, the review cases and the limits", () => {
    const content = text(<AboutPage />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/where it stops/);
    expect(content).toMatch(/no machine\s+learning, no AI service and no OCR/);
    expect(content).toMatch(/unresolved/);
    expect(content).toMatch(/needs review/);
    expect(content).toMatch(/not certified engineering-compliance software/);
    expect(content).toMatch(/wide screen/);
  });

  it("describes what happens to an upload without promising confidentiality or deletion", () => {
    const content = text(<PrivacyPage />);
    expect(content).toMatch(/sends it to the server/);
    expect(content).toMatch(/Do not upload a drawing you are not allowed to share/);
    expect(content).toMatch(/Confidentiality/);
    expect(content).toMatch(/no claim of zero logging/);
    expect(content).not.toMatch(/we (guarantee|never store|delete all)/i);
  });

  it("has a not-found page and an error page that shows no error text", () => {
    text(<NotFound />);
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeTruthy();
    const reset = vi.fn();
    render(<ErrorPage error={Object.assign(new Error("secret internal detail"), {})} reset={reset} />);
    expect(screen.getByRole("alert").textContent).not.toMatch(/secret internal detail/);
    screen.getByRole("button", { name: "Try again" }).click();
    expect(reset).toHaveBeenCalled();
  });
});

describe("sample drawings", () => {
  it("defines two samples with unique files", () => {
    expect(SAMPLES.map((s) => s.id)).toEqual(["basic", "cad"]);
    expect(new Set(SAMPLES.map((s) => s.file)).size).toBe(2);
    expect(sampleById("cad")?.file).toBe("blueprintiq-sample-cad.pdf");
    expect(sampleById("nope")).toBeNull();
    expect(sampleById(null)).toBeNull();
  });

  it("loads a sample from this site as a PDF file, and reports a missing one", async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 }));
    const file = await loadSample(SAMPLES[0]!, fetcher as unknown as typeof fetch);
    expect(file.name).toBe("blueprintiq-sample-basic.pdf");
    expect(file.type).toBe("application/pdf");
    expect(fetcher).toHaveBeenCalledWith("/samples/blueprintiq-sample-basic.pdf");
    const missing = vi.fn(async () => new Response("", { status: 404 }));
    await expect(loadSample(SAMPLES[0]!, missing as unknown as typeof fetch)).rejects.toThrow(/unavailable/);
  });

  it("offers the samples, labelled as synthetic and as demonstration requirements", () => {
    openDashboard();
    const section = screen.getByRole("region", { name: /try a sample/i });
    expect(section.textContent).toMatch(/original, synthetic drawings/);
    expect(section.textContent).toMatch(/examples and not engineering standards/);
    expect(within(section).getAllByRole("button")).toHaveLength(2);
  });

  it("sends a chosen sample through the normal inspection, with the current requirements", async () => {
    const { calls, run, fetchSample } = openDashboard();
    await user().click(screen.getByRole("button", { name: /CAD-style plate/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(fetchSample).toHaveBeenCalledTimes(1);
    expect(calls[0]!.file.name).toBe("blueprintiq-sample-cad.pdf");
    expect(run.mock.calls[0]![1].requirements).toBeNull(); // demonstration values: no custom header
    expect(screen.queryByRole("region", { name: /try a sample/i })).toBeNull();
  });

  it("opens with a sample already running for /inspect?sample=cad, once", async () => {
    window.history.replaceState(null, "", "/inspect?sample=cad");
    const { calls } = openDashboard();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.file.name).toBe("blueprintiq-sample-cad.pdf");
  });

  it("ignores an unknown sample name", async () => {
    window.history.replaceState(null, "", "/inspect?sample=other");
    const { calls, fetchSample } = openDashboard();
    await Promise.resolve();
    expect(fetchSample).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("says so when the sample cannot be loaded, and starts no inspection", async () => {
    const { calls } = openDashboard(vi.fn(async () => Promise.reject(new Error("offline"))));
    await user().click(screen.getByRole("button", { name: /Labelled plate/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be loaded/);
    expect(calls).toHaveLength(0);
  });

  it("does not bypass validation: a sample that is not a PDF is refused like any file", async () => {
    const bad = vi.fn(async () => new File(["x"], "sample.txt", { type: "text/plain" }));
    const { calls } = openDashboard(bad);
    await user().click(screen.getByRole("button", { name: /Labelled plate/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/PDF/i);
    expect(calls).toHaveLength(0);
  });
});

describe("small screens", () => {
  it("explains that the drawing viewer needs a wider screen once a file is chosen", async () => {
    const { calls } = openDashboard();
    expect(screen.queryByTestId("desktop-note")).toBeNull();
    await user().upload(screen.getByLabelText(/drop a pdf/i), pdf());
    await waitFor(() => expect(calls).toHaveLength(1));
    const note = screen.getByTestId("desktop-note");
    expect(note.textContent).toMatch(/needs a wider screen/);
    expect(note.className).toMatch(/lg:hidden/);
    expect(within(note).getByRole("link", { name: /Jump to the results/ }).getAttribute("href")).toBe("#results-heading");
  });
});

describe("reading aids in the results", () => {
  const association = (id: string, annotation: string, status: FeatureAssociation["status"]) =>
    ({
      id,
      annotation_id: annotation,
      relation: status === "verified" ? "linear_between_references" : null,
      status,
      feature_id: status === "verified" ? "G1" : null,
      feature: [],
      evidence: [],
      candidates: 1,
      explanation: status === "verified" ? "Verified: lines." : "Association unresolved: no arrowheads.",
    }) as unknown as FeatureAssociation;

  it("counts verified and unresolved associations apart, and gives a reading guide", () => {
    render(
      <ReportView
        report={makeReport({
          findings: [finding("pass")],
          overrides: {
            cad_annotations: [cadAnnotation("C1", "120"), cadAnnotation("C2", "30")],
            feature_associations: [
              association("A1", "C1", "verified"),
              association("A2", "C2", "unresolved"),
            ],
          },
        })}
      />,
    );
    const summary = screen.getByTestId("association-summary");
    expect(summary.textContent).toMatch(/1 verified, 1 unresolved/);
    expect(summary.textContent).toMatch(/not guesses/);
    const guide = screen.getByTestId("results-guide");
    expect(guide.textContent).toMatch(/needs review.*never a pass/is);
    expect(guide.textContent).toMatch(/A person must review/);
  });

  it("an error response still reaches the user as before", async () => {
    const { calls } = openDashboard();
    await user().upload(screen.getByLabelText(/drop a pdf/i), pdf());
    calls[0]!.resolve(interpretResponse(422, JSON.stringify(errorBody("NO_TEXT_LAYER")), REQUEST_ID));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});

describe("the requirements panel and the results", () => {
  it("folds away while a current result is shown, and opens for changes", async () => {
    const { calls } = openDashboard();
    const details = () => document.querySelector("details")! as HTMLDetailsElement;
    expect(details().open).toBe(true);
    await user().upload(screen.getByLabelText(/drop a pdf/i), pdf());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(details().open).toBe(true); // still running: nothing to read yet
    calls[0]!.resolve({ kind: "report", report: makeReport({ findings: [finding("pass")] }), requestId: REQUEST_ID });
    await screen.findByTestId("results-guide");
    await waitFor(() => expect(details().open).toBe(false));
    expect(screen.getByText(/demonstration values; open to change them/)).toBeTruthy();
    await user().type(screen.getByLabelText(/minimum thickness/i), "1", { skipClick: false });
    await waitFor(() => expect(details().open).toBe(true)); // edited: results are stale, panel opens
  });
});
