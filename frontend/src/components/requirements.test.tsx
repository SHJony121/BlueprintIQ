// @vitest-environment jsdom
//
// Requirements in the dashboard: what is sent, rerunning after a change, and never showing
// results beside requirements they were not produced with. The upload is a controllable
// double; the real backend is exercised by tests/e2e/requirements.spec.ts and
// tests/proxy/backend.test.ts.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { InspectionResult } from "@/api/client";
import type { InspectionReport } from "@/api/types";
import { allOutcomesReport, finding, makeReport, pdf, REQUEST_ID } from "../../tests/ui/builders";
import { controlledRun } from "../../tests/ui/controlled-run";
import { idleSource } from "../../tests/ui/fake-pdf";
import { InspectionDashboard } from "./inspection-dashboard";

const ok = (report: InspectionReport): InspectionResult => ({ kind: "report", report, requestId: REQUEST_ID });

const customReport = (min: string): InspectionReport =>
  makeReport({
    findings: [
      finding("fail", {
        rule_description: `Plate thickness must be at least ${min} mm (your requirement).`,
        expected: `>= ${min} mm`,
        message: `Thickness 4 mm is below the configured minimum of ${min} mm.`,
      }),
    ],
    overrides: { ruleset: { id: "custom-requirements", version: "1" } },
  });

function open() {
  const control = controlledRun();
  const user = userEvent.setup({ applyAccept: false });
  render(<InspectionDashboard run={control.run} pdfSource={idleSource} />);
  return { ...control, user };
}

const field = (name: RegExp) => screen.getByLabelText(name) as HTMLInputElement;
const runButton = () => screen.getByRole("button", { name: /^Run (inspection|again)$/ }) as HTMLButtonElement;
const choose = (user: ReturnType<typeof open>["user"], name = "a.pdf") =>
  user.upload(screen.getByLabelText(/drop (a|another) pdf/i), pdf(name));
const sent = (run: ReturnType<typeof open>["run"], call = 0) => {
  const header = run.mock.calls[call]![1].requirements;
  return header === null || header === undefined ? null : JSON.parse(decodeURIComponent(header));
};

async function type(user: ReturnType<typeof open>["user"], input: HTMLInputElement, text: string) {
  await user.clear(input);
  if (text !== "") await user.type(input, text);
}

describe("the form", () => {
  it("starts with the demonstration values, labelled as such", () => {
    open();
    expect(screen.getByTestId("requirements-label").textContent).toBe("Demonstration values. Not engineering standards.");
    expect(field(/minimum thickness/i).value).toBe("3");
    expect(field(/maximum diameter/i).value).toBe("50");
    expect(field(/minimum length/i).value).toBe("10");
    expect(field(/maximum length/i).value).toBe("500");
    expect((screen.getByRole("checkbox", { name: /require a material/i }) as HTMLInputElement).checked).toBe(true);
    expect(field(/required material code/i).value).toBe("");
  });

  it("says when the values are no longer the demonstration values, and can reset them", async () => {
    const { user } = open();
    await type(user, field(/minimum thickness/i), "5");
    expect(screen.getByTestId("requirements-label").textContent).toMatch(/^Custom requirements/);
    await user.click(screen.getByRole("button", { name: "Reset to demonstration values" }));
    expect(field(/minimum thickness/i).value).toBe("3");
    expect(screen.getByTestId("requirements-label").textContent).toMatch(/^Demonstration values/);
  });

  it("shows an error beside the field, marks it invalid and disables running", async () => {
    const { user } = open();
    await type(user, field(/maximum diameter/i), "-5");
    const input = field(/maximum diameter/i);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(input.getAttribute("aria-describedby")!)!.textContent).toMatch(/Enter a number/);
    expect(runButton().disabled).toBe(true);
  });

  it("needs at least one requirement", async () => {
    const { user } = open();
    for (const label of [/minimum thickness/i, /maximum diameter/i, /minimum length/i, /maximum length/i]) {
      await type(user, field(label), "");
    }
    await user.click(screen.getByRole("checkbox", { name: /require a material/i }));
    expect(screen.getByRole("alert").textContent).toMatch(/at least one requirement/i);
  });

  it("only allows a material code when a material is required", async () => {
    const { user } = open();
    await user.click(screen.getByRole("checkbox", { name: /require a material/i }));
    expect(field(/required material code/i).disabled).toBe(true);
  });
});

describe("what is sent", () => {
  it("sends nothing extra for the demonstration values: the server's own rules apply", async () => {
    const { user, run } = open();
    await choose(user);
    expect(run.mock.calls[0]![1].requirements).toBeNull();
  });

  it("sends the edited requirements when a file is chosen", async () => {
    const { user, run } = open();
    await type(user, field(/minimum thickness/i), "5.5");
    await user.clear(field(/maximum length/i));
    await user.click(screen.getByRole("checkbox", { name: /require a material/i }));
    await user.click(screen.getByRole("checkbox", { name: /require a material/i }));
    await type(user, field(/required material code/i), "ss400");
    await choose(user);
    expect(sent(run)).toEqual({
      version: 1,
      min_thickness_mm: "5.5",
      max_diameter_mm: "50",
      min_length_mm: "10",
      max_length_mm: null,
      material: { required: true, code: "SS400" },
    });
  });

  it("keeps a chosen file waiting while the requirements are invalid, and runs it once they are fixed", async () => {
    const { user, run } = open();
    await type(user, field(/minimum thickness/i), "oops");
    await choose(user, "waiting.pdf");
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByText("waiting.pdf")).toBeTruthy();
    expect(screen.getByTestId("empty-results").textContent).toMatch(/chosen but not inspected/);
    expect(runButton().disabled).toBe(true);
    await type(user, field(/minimum thickness/i), "4");
    expect(runButton().disabled).toBe(false);
    await user.click(runButton());
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0].name).toBe("waiting.pdf");
    expect(sent(run).min_thickness_mm).toBe("4");
  });

  it("cannot be run before a file is chosen", () => {
    open();
    expect(runButton().disabled).toBe(true);
    expect(screen.getByText("Choose a PDF first.")).toBeTruthy();
  });
});

describe("changing requirements after a result", () => {
  async function inspected() {
    const control = open();
    await choose(control.user);
    await act(async () => control.calls[0]!.resolve(ok(allOutcomesReport())));
    await screen.findByRole("heading", { name: /^Findings \(/ });
    return control;
  }

  it("hides the old results at once instead of showing them beside new values", async () => {
    const { user } = await inspected();
    expect(screen.getByTestId("applied-requirements").textContent).toMatch(/Demonstration values/);
    await type(user, field(/minimum thickness/i), "9");
    expect(screen.queryByRole("heading", { name: /^Findings \(/ })).toBeNull();
    expect(screen.queryByTestId("summary-fail")).toBeNull();
    expect(screen.getByTestId("stale-results").textContent).toMatch(/requirements changed/i);
    expect(screen.getByRole("status").textContent).toMatch(/requirements changed/i);
    expect(runButton().textContent).toBe("Run inspection");
  });

  it("shows the old results again if the values are put back (they are true again)", async () => {
    const { user } = await inspected();
    await type(user, field(/minimum thickness/i), "9");
    await type(user, field(/minimum thickness/i), "3.0"); // the same number, written differently
    expect(screen.queryByTestId("stale-results")).toBeNull();
    expect(screen.getByRole("heading", { name: /^Findings \(/ })).toBeTruthy();
    expect(runButton().textContent).toBe("Run again");
  });

  it("hides results while the values are invalid, and says to fix them", async () => {
    const { user } = await inspected();
    await type(user, field(/minimum thickness/i), "x");
    expect(screen.getByTestId("stale-results").textContent).toMatch(/Fix the requirements/);
    expect(screen.queryByRole("heading", { name: /^Findings \(/ })).toBeNull();
  });

  it("reinspects the same file with the new requirements and shows what was applied", async () => {
    const { user, run, calls } = await inspected();
    const file = calls[0]!.file;
    await type(user, field(/minimum thickness/i), "9");
    await user.click(runButton());
    expect(run).toHaveBeenCalledTimes(2);
    expect(calls[1]!.file).toBe(file); // no new upload is chosen
    expect(sent(run, 1).min_thickness_mm).toBe("9");
    expect(screen.getByTestId("results-skeleton")).toBeTruthy();
    expect(screen.queryByTestId("stale-results")).toBeNull();

    await act(async () => calls[1]!.resolve(ok(customReport("9"))));
    const applied = await screen.findByTestId("applied-requirements");
    expect(applied.textContent).toMatch(/Your requirements/);
    expect(within(applied).getByText(/at least 9 mm \(your requirement\)/)).toBeTruthy();
  });

  it("cannot be rerun while an inspection is running, and a late answer after cancelling is ignored", async () => {
    const { user, calls } = await inspected();
    await type(user, field(/minimum thickness/i), "9");
    await user.click(runButton());
    expect(runButton().disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    await act(async () => calls[1]!.resolve(ok(customReport("9")))); // late, abandoned
    expect(calls[1]!.signal.aborted).toBe(true);
    expect(screen.queryByTestId("applied-requirements")).toBeNull();
  });

  it("clears a finding selection when the results are rerun", async () => {
    const { user, calls } = await inspected();
    await user.click(screen.getByRole("button", { name: "Select finding F4" }));
    expect(document.querySelectorAll("li[data-selected=true]")).toHaveLength(1);
    await type(user, field(/maximum diameter/i), "70");
    await user.click(runButton());
    await act(async () => calls[1]!.resolve(ok(allOutcomesReport())));
    await screen.findByRole("heading", { name: /^Findings \(/ });
    expect(document.querySelectorAll("li[data-selected=true]")).toHaveLength(0);
  });

  it("runs again with unchanged requirements, and a retry after an error keeps the ones it used", async () => {
    const { user, run, calls } = await inspected();
    await user.click(runButton()); // "Run again"
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![1].requirements).toBeNull();
    await act(async () => calls[1]!.resolve({ kind: "network" }));
    await type(user, field(/minimum thickness/i), "6"); // edited after the failure
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(run.mock.calls[2]![1].requirements).toBeNull(); // the retry repeats the failed inspection
  });
});

describe("which requirements a result shows", () => {
  it("names the demonstration values for the demonstration ruleset", async () => {
    const { user, calls } = open();
    await choose(user);
    await act(async () => calls[0]!.resolve(ok(allOutcomesReport())));
    const applied = await screen.findByTestId("applied-requirements");
    expect(applied.textContent).toMatch(/Demonstration values. Not engineering standards./);
    expect(applied.textContent).toMatch(/THK-MIN-001/);
    expect(applied.textContent).toMatch(/MAT-REQ-001/);
  });
});

describe("incomplete extraction", () => {
  it("is announced above the results when angled text was skipped", async () => {
    const { user, calls } = open();
    await choose(user);
    await act(async () => calls[0]!.resolve(ok(makeReport({ overrides: { skipped_angled_lines: 2 } }))));
    const notice = await screen.findByTestId("incomplete-extraction");
    expect(notice.textContent).toMatch(/Incomplete extraction/);
    expect(notice.textContent).toMatch(/2 lines of text/);
    expect(notice.textContent).toMatch(/not a full inspection/);
  });

  it("is absent for a complete extraction", async () => {
    const { user, calls } = open();
    await choose(user);
    await act(async () => calls[0]!.resolve(ok(allOutcomesReport())));
    await screen.findByRole("heading", { name: /^Findings \(/ });
    expect(screen.queryByTestId("incomplete-extraction")).toBeNull();
  });
});
