// The whole path: a PDF uploaded through the dashboard, inspected by the real backend,
// rendered by PDF.js, evidence boxes from the backend's own extraction (PyMuPDF). Each box
// is checked against the pixels PDF.js painted, within the backend's documented box
// contract (see limits() in alignment.ts), and matched to the fixture's ground-truth line.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  COMMITTED_NAMES,
  committedTruth,
  displayedAxis,
  GENERATED_NAMES,
  generatedTruth,
  labelProblems,
  limits,
  measure,
  problems,
  sideGaps,
  waitForDrawn,
  type Truth,
} from "./alignment";
import { upSides } from "./text-orientation";

const BASE = () => process.env.E2E_BASE_URL!;
const STATS = path.join(process.cwd(), "test-results", "alignment");
const SEARCH_PT = 4;

interface Report {
  measurements: { id: string; source: { raw_text: string } }[];
  findings: { id: string; status: string; evidence: { measurement_id: string; bbox: unknown }[] }[];
}

/**
 * Record each report the page receives. The request is passed through unchanged; reading
 * the body here avoids Chromium's inspector cache, which may drop response bodies.
 */
async function captureReports(page: Page): Promise<Map<string, Report>> {
  const reports = new Map<string, Report>();
  await page.route("**/api/inspections", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const name = decodeURIComponent(route.request().headers()["x-filename"] ?? "");
    if (response.status() === 200) reports.set(name, JSON.parse(body) as Report);
    await route.fulfill({ response, body });
  });
  return reports;
}

/** Upload through the real file input and wait for the report and the drawn page. */
async function inspect(page: Page, file: string): Promise<Report> {
  const reports = await captureReports(page);
  await page.goto(`${BASE()}/inspect`);
  await page.setInputFiles("input[type=file]", file);
  await expect(page.getByRole("status")).toHaveText(/^Inspection complete/);
  await waitForDrawn(page);
  const report = reports.get(path.basename(file));
  expect(report, "the report the page received").toBeDefined();
  return report!;
}

const located = (report: Report) =>
  report.findings.flatMap((f) => f.evidence.filter((e) => e.bbox !== null).map((e) => `${f.id}:${e.measurement_id}`));

async function verifyAgainstPixels(page: Page, truth: Truth, report: Report, label: string, project: string) {
  const ups = await upSides(truth.file, truth.lines.map((l) => l.text));
  const m = await measure(page, SEARCH_PT);
  const failures: string[] = [];
  for (const box of m.boxes) {
    const measurementId = box.key.split(":")[1]!;
    const text = report.measurements.find((x) => x.id === measurementId)?.source.raw_text;
    const index = truth.lines.findIndex((l) => l.text === text);
    if (index < 0) {
      failures.push(`${box.key}: "${text}" is not a ground-truth line`);
      continue;
    }
    const line = truth.lines[index]!;
    const axis = displayedAxis(line.advance_axis, truth.page.rotation);
    failures.push(...problems(box, limits("backend", line.font_size, m.scale, axis, ups[index] ?? null)));
    const gaps = sideGaps(box);
    if (gaps !== null) {
      const row = { fixture: truth.name, key: box.key, step: label, scale: m.scale, font: line.font_size, axis, up: ups[index], ...gaps };
      appendFileSync(path.join(STATS, `backend-${project}.jsonl`), `${JSON.stringify(row)}\n`);
    }
  }
  expect(failures, `${truth.name} at ${label} (scale ${m.scale.toFixed(3)})`).toEqual([]);
  expect(await labelProblems(page), `${truth.name} labels at ${label}`).toEqual([]);
}

test.beforeAll(() => mkdirSync(STATS, { recursive: true }));

const APP_FIXTURES = [
  ...COMMITTED_NAMES.map((name) => ({ name, truth: () => committedTruth(name) })),
  ...GENERATED_NAMES.filter((n) => !n.startsWith("edges_tight")).map((name) => ({ name, truth: () => generatedTruth(name) })),
];

for (const { name, truth: getTruth } of APP_FIXTURES) {
  test(`backend evidence lines up with the rendered page: ${name}`, async ({ page }, info) => {
    const truth = getTruth();
    expect(truth.backendAccepts).toBe(true);
    const report = await inspect(page, truth.file);
    const expected = located(report);
    await expect(page.locator("[data-evidence-key]")).toHaveCount(expected.length);
    expect((await page.locator("[data-evidence-key]").evaluateAll((els) => els.map((e) => e.getAttribute("data-evidence-key")))).sort()).toEqual(
      [...expected].sort(),
    );
    await verifyAgainstPixels(page, truth, report, "fit width", info.project.name);
    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.getByRole("button", { name: "Zoom in" }).click();
    await waitForDrawn(page);
    await verifyAgainstPixels(page, truth, report, "fit +2 steps", info.project.name);
    await page.getByRole("button", { name: "Fit to width" }).click();
    await page.setViewportSize({ width: 1100, height: 800 });
    await waitForDrawn(page);
    await verifyAgainstPixels(page, truth, report, "fit width after resize", info.project.name);
  });
}

test("a second file replaces the first everywhere: its boxes go at once, and only its own come back", async ({ page }) => {
  const first = committedTruth("valid_basic");
  const second = committedTruth("violations");
  const reports = await captureReports(page);
  // The first file is inspected completely, so its boxes are on screen.
  await page.goto(`${BASE()}/inspect`);
  await page.setInputFiles("input[type=file]", first.file);
  await expect(page.getByRole("status")).toHaveText(/^Inspection complete: 0 fail/);
  await waitForDrawn(page);
  await expect(page.locator("[data-evidence-key]")).toHaveCount(located(reports.get("valid_basic.pdf")!).length);
  // Hold the second inspection back, so there is a window in which it is still running.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/inspections", async (route) => {
    await held;
    await route.fallback();
  });
  await page.setInputFiles("input[type=file]", second.file);
  await expect(page.locator("[data-evidence-key]")).toHaveCount(0); // the first file's boxes are gone
  await page.waitForTimeout(500);
  await expect(page.locator("[data-evidence-key]")).toHaveCount(0); // and stay gone while it runs
  release();
  await expect(page.getByRole("status")).toHaveText(/^Inspection complete: 3 fail/);
  await waitForDrawn(page);
  const report = reports.get("violations.pdf")!;
  expect(report).toBeDefined();
  await expect(page.locator("[data-evidence-key]")).toHaveCount(located(report).length);
  await verifyAgainstPixels(page, second, report, "after switching", "switch");
});

test("a multi-page PDF is not shown, and no evidence is drawn", async ({ page }) => {
  await page.goto(`${BASE()}/inspect`);
  await page.setInputFiles("input[type=file]", path.resolve(process.cwd(), "../backend/tests/fixtures/drawings/multi_page.pdf"));
  // Next.js adds its own role="alert" route announcer, so match the error panel by its text.
  await expect(page.getByRole("alert").filter({ hasText: "Only single-page drawings are supported" })).toBeVisible();
  await expect(page.getByTestId("viewer-slot")).toContainText("the viewer shows single-page drawings only");
  await expect(page.getByTestId("pdf-canvas")).toHaveCount(0);
});

test("a file that is not a PDF cannot be displayed", async ({ page }, info) => {
  const fake = path.join(process.cwd(), "test-results", `not-a-pdf-${info.project.name}.pdf`);
  writeFileSync(fake, "hello, this is not a PDF");
  await page.goto(`${BASE()}/inspect`);
  await page.setInputFiles("input[type=file]", fake);
  // Next.js adds its own role="alert" route announcer, so match the error panel by its text.
  await expect(page.getByRole("alert").filter({ hasText: "This is not a PDF file" })).toBeVisible();
  await expect(page.getByTestId("viewer-slot")).toContainText("This file could not be displayed");
  await expect(page.getByTestId("pdf-canvas")).toHaveCount(0);
});

test("a drawing the backend refuses is shown without evidence", async ({ page }) => {
  await page.goto(`${BASE()}/inspect`);
  await page.setInputFiles("input[type=file]", path.resolve(process.cwd(), "../backend/tests/fixtures/drawings/no_text.pdf"));
  // Next.js adds its own role="alert" route announcer, so match the error panel by its text.
  await expect(page.getByRole("alert").filter({ hasText: "No readable text found" })).toBeVisible();
  await waitForDrawn(page);
  await expect(page.getByTestId("evidence-status")).toContainText("the inspection did not produce a report");
  await expect(page.locator("[data-evidence-key]")).toHaveCount(0);
});

test("every outcome that has a location gets its own outline style", async ({ page }) => {
  const report = await inspect(page, generatedTruth("multi_box_r0").file);
  const statuses = new Set(report.findings.filter((f) => f.evidence.some((e) => e.bbox !== null)).map((f) => f.status));
  expect([...statuses].sort()).toEqual(["fail", "needs_review", "pass"]);
  for (const status of statuses) {
    const style = await page.locator(`[data-evidence-key][data-status="${status}"]`).first().evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(style).toBe({ fail: "solid", needs_review: "dashed", pass: "dotted" }[status]);
  }
});
