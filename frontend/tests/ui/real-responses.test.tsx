// @vitest-environment jsdom
//
// Real responses: the production Next.js server in front of the real FastAPI backend.
// Every committed fixture is uploaded, and what comes back is checked against the
// backend's hand-written ground truth (tests/fixtures/expected_findings.py and
// expected/*.json), which was written without running the code under test.
//
// What this proves: the reader accepts every real report and error, and the screen shows
// the right outcomes for them. What it does not: it runs in jsdom, not a real browser, so
// layout, focus rendering and actual drag-and-drop are checked by hand (see docs).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runInspection, type RunInspection } from "@/api/client";
import { interpretResponse, type ApiOutcome } from "@/api/read-response";
import { InspectionDashboard } from "@/components/inspection-dashboard";
import { ReportView } from "@/components/report-view";
import { describeFailure } from "@/inspection/failure-copy";
import {
  BACKEND_DIR,
  backendPython,
  DRAWINGS_DIR,
  drawing,
  startBackend,
  startNext,
  unusedPort,
  type ChildServer,
} from "../proxy/helpers";

afterEach(() => cleanup());

const names = readdirSync(DRAWINGS_DIR)
  .filter((file) => file.endsWith(".pdf"))
  .map((file) => file.slice(0, -4))
  .sort();

type Expected = [rule: string, outcome: string, measurements: string[]][];

/** The backend's hand-written expected rule outcomes, read straight from its source. */
function expectedFindings(): Record<string, Expected> {
  const code =
    "import json,sys;sys.path.insert(0,'.');from tests.fixtures.expected_findings import EXPECTED_FINDINGS as E;print(json.dumps({k:[list(x) for x in v] for k,v in E.items()}))";
  return JSON.parse(execFileSync(backendPython(), ["-c", code], { cwd: BACKEND_DIR, encoding: "utf8" }));
}

function expectedRefusal(name: string): string | null {
  const file = path.join(DRAWINGS_DIR, "..", "expected", `${name}.json`);
  const data = JSON.parse(readFileSync(file, "utf8")) as { error?: string };
  return data.error ?? null;
}

let backend: ChildServer;
let next: ChildServer;
const outcomes = new Map<string, ApiOutcome>();
const GROUND_TRUTH = expectedFindings();

async function upload(port: number, name: string): Promise<ApiOutcome> {
  const response = await fetch(`http://127.0.0.1:${port}/api/inspections`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf", "X-Filename": encodeURIComponent(`${name}.pdf`) },
    body: new Uint8Array(drawing(name)),
  });
  return interpretResponse(response.status, await response.text(), response.headers.get("x-request-id"));
}

beforeAll(async () => {
  backend = await startBackend();
  next = await startNext(`http://127.0.0.1:${backend.port}`);
  for (const name of names) outcomes.set(name, await upload(next.port, name)); // one at a time: kind to the backend
}, 240_000);

afterAll(async () => {
  await next?.stop();
  await backend?.stop();
});

describe("every committed fixture, through the real proxy and backend", () => {
  it("covers all the fixtures, split between reports and refusals", () => {
    expect(names.length).toBeGreaterThanOrEqual(32);
    expect(Object.keys(GROUND_TRUTH).length).toBe(22);
    const refused = names.filter((n) => !(n in GROUND_TRUTH));
    expect(refused.length).toBe(10);
  });

  it.each(names)("%s is read without being called malformed", (name) => {
    const outcome = outcomes.get(name)!;
    expect(outcome.kind === "report" || outcome.kind === "error").toBe(true);
  });

  it.each(names.filter((n) => !(n in GROUND_TRUTH)))("%s is refused with the code the backend expects", (name) => {
    const outcome = outcomes.get(name)!;
    const code = expectedRefusal(name);
    expect(code).not.toBeNull();
    expect(outcome).toMatchObject({ kind: "error", code });
    if (outcome.kind !== "error") return;
    const copy = describeFailure({
      kind: "api",
      status: outcome.status,
      code: outcome.code,
      message: outcome.message,
      requestId: outcome.requestId,
    });
    // A real code, explained in its own words rather than the unknown-code fallback.
    expect(copy.title).not.toBe("The inspection service reported an error");
  });

  describe.each(Object.keys(GROUND_TRUTH))("%s", (name) => {
    const report = () => {
      const outcome = outcomes.get(name)!;
      if (outcome.kind !== "report") throw new Error(`expected a report, got ${outcome.kind}`);
      return outcome.report;
    };

    it("produces the findings the ground truth lists, in order", () => {
      const actual = report().findings.map((f) => [f.rule_id, f.status, f.measurement_ids]);
      expect(actual).toEqual(GROUND_TRUTH[name]);
    });

    it("shows exactly those outcomes on screen, with matching counts", () => {
      render(<ReportView report={report()} />);
      const shown = [...document.querySelectorAll("li[id^=finding-]")].map((li) => [
        within(li as HTMLElement).getByText(/^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+$/).textContent,
        li.getAttribute("data-status"),
      ]);
      const expected = GROUND_TRUTH[name]!.map(([rule, outcome]) => [rule, outcome]);
      expect(shown.toSorted()).toEqual(expected.toSorted());
      for (const [status, key] of [
        ["pass", "passed"],
        ["fail", "failed"],
        ["missing", "missing"],
        ["needs_review", "needs_review"],
      ] as const) {
        const count = GROUND_TRUTH[name]!.filter(([, outcome]) => outcome === status).length;
        expect(within(screen.getByTestId(`summary-${status}`)).getByText(String(count))).toBeTruthy();
        expect(report().summary[key]).toBe(count);
      }
    });

    it("shows every measurement's text, decimals exactly as the backend wrote them", () => {
      render(<ReportView report={report()} />);
      for (const m of report().measurements) {
        const item = document.getElementById(`measurement-${m.id}`)!;
        expect(item.textContent).toContain(m.source.raw_text);
        if (m.kind === "dimension" && m.value !== null) expect(item.textContent).toContain(m.value);
        if (m.status === "ambiguous") expect(within(item).getByText("Ambiguous")).toBeTruthy();
      }
    });

    it("links each reference to a measurement on the page", () => {
      render(<ReportView report={report()} />);
      for (const link of document.querySelectorAll<HTMLAnchorElement>("a[href^='#measurement-']")) {
        expect(document.getElementById(link.getAttribute("href")!.slice(1))).not.toBeNull();
      }
    });
  });

  it("includes all four outcomes, an ambiguous measurement and a missing finding", () => {
    const reports = [...outcomes.values()].flatMap((o) => (o.kind === "report" ? [o.report] : []));
    const statuses = new Set(reports.flatMap((r) => r.findings.map((f) => f.status)));
    expect([...statuses].sort()).toEqual(["fail", "missing", "needs_review", "pass"]);
    expect(reports.some((r) => r.measurements.some((m) => m.status === "ambiguous"))).toBe(true);
    expect(reports.some((r) => r.document.pages.some((p) => p.rotation !== 0))).toBe(true);
  });
});

/** Read a File's bytes the way a page would (jsdom has no Blob.arrayBuffer). */
function readBytes(file: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

// The whole screen, driven by the real network. jsdom's File is not a Node Blob, so the
// bytes are read out of it and sent; everything else is the app's own code.
function realRun(port: number): RunInspection {
  return (file, options) =>
    runInspection(file, {
      ...options,
      fetchImpl: async (url, init) =>
        fetch(`http://127.0.0.1:${port}${String(url)}`, {
          ...init,
          body: (await readBytes(init!.body as Blob)) as BodyInit,
        }),
    });
}

function pdfFile(name: string, bytes: Uint8Array = new Uint8Array(drawing(name))): File {
  return new File([bytes as BlobPart], `${name}.pdf`, { type: "application/pdf" });
}

async function useDashboard(port: number, file: File) {
  const user = userEvent.setup({ applyAccept: false });
  render(<InspectionDashboard run={realRun(port)} />);
  await user.upload(screen.getByLabelText(/drop a pdf drawing/i), file);
}

describe("the whole screen against the real service", () => {
  it("shows four passes for a valid drawing", async () => {
    await useDashboard(next.port, pdfFile("valid_basic"));
    await screen.findByRole("heading", { name: /^Findings \(4\)/ }, { timeout: 30_000 });
    expect(within(screen.getByTestId("summary-pass")).getByText("4")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "Inspection complete: 0 fail, 0 need review, 0 missing, 4 pass.",
    );
    // The report names the file we sent, as the backend recorded it.
    const section = screen.getByRole("heading", { name: "Source document" }).closest("section")!;
    expect(within(section).getByText("valid_basic.pdf")).toBeTruthy();
  }, 60_000);

  it("shows failures for a drawing that violates the thresholds", async () => {
    await useDashboard(next.port, pdfFile("violations"));
    await screen.findByRole("heading", { name: /^Findings \(\d+\)/ }, { timeout: 30_000 });
    expect(within(screen.getByTestId("summary-fail")).getByText("3")).toBeTruthy();
    expect(within(screen.getByTestId("summary-pass")).getByText("1")).toBeTruthy();
    const first = document.querySelector("li[id^=finding-]")!;
    expect(first.getAttribute("data-status")).toBe("fail");
  }, 60_000);

  it("shows a missing finding without inventing a value", async () => {
    await useDashboard(next.port, pdfFile("missing_material"));
    await screen.findByRole("heading", { name: /^Findings \(\d+\)/ }, { timeout: 30_000 });
    expect(within(screen.getByTestId("summary-missing")).getByText("1")).toBeTruthy();
    const item = document.querySelector("li[data-status=missing]")!;
    expect(within(item as HTMLElement).getByText("Not found in the drawing")).toBeTruthy();
  }, 60_000);

  it("shows needs review for an ambiguous drawing, and the ambiguous measurement", async () => {
    await useDashboard(next.port, pdfFile("ambiguous"));
    await screen.findByRole("heading", { name: /^Findings \(\d+\)/ }, { timeout: 30_000 });
    expect(document.querySelector("li[data-status=needs_review]")).not.toBeNull();
    expect(screen.getAllByText("Ambiguous").length).toBeGreaterThan(0);
  }, 60_000);

  it.each([
    ["no_text", /No readable text found/, "NO_TEXT_LAYER"],
    ["multi_page", /single-page/, "TOO_MANY_PAGES"],
    ["rotate_135", /layout is not supported/, "UNSUPPORTED_GEOMETRY"],
  ])("explains a refused drawing (%s) and shows no results", async (name, title, code) => {
    await useDashboard(next.port, pdfFile(name));
    const alert = await screen.findByRole("alert", {}, { timeout: 30_000 });
    expect(within(alert).getByRole("heading").textContent).toMatch(title);
    expect(within(alert).getByText(code)).toBeTruthy();
    expect(within(alert).getByText(/^[0-9a-f]{32}$/)).toBeTruthy(); // the backend's real request id
    expect(screen.queryByRole("heading", { name: /^Findings \(/ })).toBeNull();
  }, 60_000);

  it("explains a file that is named like a PDF but is not one", async () => {
    await useDashboard(next.port, pdfFile("not_really", new TextEncoder().encode("hello, not a pdf")));
    const alert = await screen.findByRole("alert", {}, { timeout: 30_000 });
    expect(within(alert).getByRole("heading").textContent).toBe("This is not a PDF file");
  }, 60_000);

  it("explains a backend that is not running", async () => {
    const dead = await startNext(`http://127.0.0.1:${await unusedPort()}`);
    try {
      await useDashboard(dead.port, pdfFile("valid_basic"));
      const alert = await screen.findByRole("alert", {}, { timeout: 30_000 });
      expect(within(alert).getByRole("heading").textContent).toBe("The inspection service is not reachable");
      expect(within(alert).getByText("BACKEND_UNAVAILABLE")).toBeTruthy();
      expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
      expect(alert.textContent).not.toMatch(/127\.0\.0\.1|ECONN/);
    } finally {
      await dead.stop();
    }
  }, 90_000);
});
