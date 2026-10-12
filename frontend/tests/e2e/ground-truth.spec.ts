// Overlays drawn from independently specified ground truth, checked against the pixels
// PDF.js renders. No backend: the evidence is each fixture's hand-computed ink box (Adobe
// font metrics, page space), passed to the real viewer through the /viewer-check page.
// So this tests the viewer alone: page space -> PDF space -> PDF.js viewport -> CSS -> pixels.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  COMMITTED_NAMES,
  committedTruth,
  displayedAxis,
  GENERATED,
  GENERATED_NAMES,
  generatedTruth,
  labelProblems,
  limits,
  measure,
  problems,
  shifted,
  sideGaps,
  waitForDrawn,
  type Measurement,
  type Side,
  type Truth,
} from "./alignment";
import { upSides } from "./text-orientation";

const BASE = () => process.env.E2E_BASE_URL!;
const STATS = path.join(process.cwd(), "test-results", "alignment");
const STATUSES = ["fail", "needs_review", "pass", "missing"] as const;
const SEARCH_PT = 4; // look this far around each box for ink
const NEGATIVE_CONTROL_PT = 3; // a box this far off, in any direction, must be caught

function evidenceFor(truth: Truth) {
  const bytes = readFileSync(truth.file);
  return {
    documentSha256: createHash("sha256").update(bytes).digest("hex"),
    documentSizeBytes: bytes.length,
    pages: [{ page_number: 1, ...truth.page }],
    items: truth.lines.map((line, i) => {
      const [x0, y0, x1, y1] = line.ink_box;
      return {
        key: `L${i + 1}`,
        findingId: `L${i + 1}`,
        ruleId: "GROUND-TRUTH",
        status: STATUSES[i % STATUSES.length],
        severity: "error",
        measurementId: `M${i + 1}`,
        pageNumber: 1,
        bbox: { x0, y0, x1, y1 },
        description: line.text,
      };
    }),
    unplaced: [],
  };
}

async function load(page: Page, truth: Truth, selected = "") {
  await page.goto(`${BASE()}/viewer-check`);
  await page.setInputFiles("[data-testid=harness-file]", truth.file);
  await page.fill("[data-testid=harness-evidence]", JSON.stringify(evidenceFor(truth)));
  await page.fill("[data-testid=harness-selected]", selected);
  await page.click("[data-testid=harness-apply]");
  await waitForDrawn(page);
  await expect(page.locator("[data-evidence-key]")).toHaveCount(truth.lines.length);
}

type Ups = readonly (Side | null)[];

function lineLimits(truth: Truth, ups: Ups, key: string, scale: number) {
  const index = Number(key.slice(1)) - 1;
  const line = truth.lines[index]!;
  const axis = displayedAxis(line.advance_axis, truth.page.rotation);
  const up = ups[index] ?? null;
  return { line, axis, up, lim: limits("ground-truth", line.font_size, scale, axis, up) };
}

/** Check every box against its ground-truth line; record the measured gaps. */
function verify(truth: Truth, ups: Ups, m: Measurement, label: string, project: string) {
  const failures: string[] = [];
  for (const box of m.boxes) {
    const { line, axis, up, lim } = lineLimits(truth, ups, box.key, m.scale);
    failures.push(...problems(box, lim));
    const gaps = sideGaps(box);
    if (gaps !== null) {
      const row = { fixture: truth.name, key: box.key, step: label, scale: m.scale, font: line.font_size, axis, up, ...gaps };
      appendFileSync(path.join(STATS, `ground-truth-${project}.jsonl`), `${JSON.stringify(row)}\n`);
    }
  }
  expect(failures, `${truth.name} at ${label} (scale ${m.scale.toFixed(3)})`).toEqual([]);
}

/** The check must be able to fail: the same boxes moved in each of four directions are caught. */
function negativeControl(truth: Truth, ups: Ups, m: Measurement) {
  const shift = NEGATIVE_CONTROL_PT * m.scale;
  for (const box of m.boxes) {
    const { lim } = lineLimits(truth, ups, box.key, m.scale);
    for (const [dx, dy] of [[shift, 0], [-shift, 0], [0, shift], [0, -shift]] as const) {
      const found = problems(shifted(box, dx, dy), lim);
      expect(found, `${truth.name} ${box.key} moved by (${dx.toFixed(2)}, ${dy.toFixed(2)}) px`).not.toEqual([]);
    }
  }
}

test.beforeAll(() => mkdirSync(STATS, { recursive: true }));

test("the generated fixtures are the ones the tests expect", () => {
  const found = readdirSync(GENERATED)
    .filter((f) => f.endsWith(".pdf"))
    .map((f) => f.slice(0, -4))
    .sort();
  expect(found).toEqual([...GENERATED_NAMES].sort());
});

const ALL = [
  ...COMMITTED_NAMES.map((name) => ({ name, truth: () => committedTruth(name) })),
  ...GENERATED_NAMES.map((name) => ({ name, truth: () => generatedTruth(name) })),
];

for (const { name, truth: getTruth } of ALL) {
  test(`ground truth lines up with the rendered page: ${name}`, async ({ page }, info) => {
    const truth = getTruth();
    // Which side of each line is up on screen, from PDF.js's own text matrices.
    const ups = await upSides(truth.file, truth.lines.map((l) => l.text));
    expect(ups, "every ground-truth line is found in PDF.js's text").not.toContain(null);
    await load(page, truth);

    const step = async (label: string, button?: string, times = 1) => {
      for (let i = 0; i < times && button !== undefined; i += 1) {
        await page.getByRole("button", { name: button }).click();
      }
      await waitForDrawn(page);
      const m = await measure(page, SEARCH_PT);
      // Laid out in CSS pixels, backed by device pixels.
      const dpr = await page.evaluate(() => window.devicePixelRatio);
      expect(Math.abs(m.pixelWidth - m.cssWidth * dpr)).toBeLessThanOrEqual(1);
      verify(truth, ups, m, label, info.project.name);
      expect(await labelProblems(page), `${truth.name} labels at ${label}`).toEqual([]);
      return m;
    };

    negativeControl(truth, ups, await step("fit width"));
    await step("100%", "Reset zoom to 100%");
    await step("195%", "Zoom in", 3);
    await step("80%", "Zoom out", 4); // 195% / 1.25^4: 10 pt text is 8 px tall
    await page.getByRole("button", { name: "Fit to width" }).click();
    await page.setViewportSize({ width: 1100, height: 800 }); // the browser window is resized
    await step("fit width after resize");
  });
}

test("changing only the selected box or evidence visibility does not render the page again", async ({ page }) => {
  await load(page, committedTruth("valid_basic"));
  const stage = page.getByTestId("page-stage");
  const renders = await stage.getAttribute("data-render-count");
  await page.fill("[data-testid=harness-selected]", "L2");
  await page.click("[data-testid=harness-apply]");
  await expect(page.locator('[data-evidence-key="L2"]')).toHaveAttribute("aria-current", "true");
  await page.getByRole("checkbox", { name: "Show evidence" }).uncheck();
  await expect(page.locator("[data-evidence-key]")).toHaveCount(0);
  await page.waitForTimeout(400); // longer than the render debounce
  expect(await stage.getAttribute("data-render-count")).toBe(renders);
});

test("evidence for a different file is refused, not drawn", async ({ page }) => {
  const evidence = evidenceFor(committedTruth("valid_basic"));
  await page.goto(`${BASE()}/viewer-check`);
  await page.setInputFiles("[data-testid=harness-file]", committedTruth("violations").file);
  await page.fill("[data-testid=harness-evidence]", JSON.stringify(evidence));
  await page.click("[data-testid=harness-apply]");
  await waitForDrawn(page);
  await expect(page.getByTestId("evidence-status")).toContainText("not the document the inspection describes");
  await expect(page.locator("[data-evidence-key]")).toHaveCount(0);
});

test("evidence whose page geometry disagrees with the PDF is refused", async ({ page }) => {
  const truth = committedTruth("cropped_rotated_90");
  const evidence = evidenceFor(truth);
  evidence.pages = [{ ...evidence.pages[0]!, rotation: 0 }]; // the PDF says 90
  await page.goto(`${BASE()}/viewer-check`);
  await page.setInputFiles("[data-testid=harness-file]", truth.file);
  await page.fill("[data-testid=harness-evidence]", JSON.stringify(evidence));
  await page.click("[data-testid=harness-apply]");
  await waitForDrawn(page);
  await expect(page.getByTestId("evidence-status")).toContainText("rotated 0");
  await expect(page.locator("[data-evidence-key]")).toHaveCount(0);
});

test("malformed evidence is refused by the diagnostic page instead of crashing it", async ({ page }) => {
  await page.goto(`${BASE()}/viewer-check`);
  await page.setInputFiles("[data-testid=harness-file]", committedTruth("valid_basic").file);
  await page.fill("[data-testid=harness-evidence]", JSON.stringify({ items: [{ key: "L1", bbox: { x0: "a" } }] }));
  await page.click("[data-testid=harness-apply]");
  await expect(page.getByRole("alert").filter({ hasText: "does not have the expected shape" })).toBeVisible();
  await expect(page.locator("[data-evidence-key]")).toHaveCount(0);
});
