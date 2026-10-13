// Custom requirements end to end: the real dashboard, the real proxy and the real backend.
// valid_basic reads thickness 4 mm, diameter 20 mm, length 120 mm and material SS400.
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const BASE = () => process.env.E2E_BASE_URL!;
const FIXTURES = path.resolve(process.cwd(), "../backend/tests/fixtures/drawings");
const file = (name: string) => path.join(FIXTURES, `${name}.pdf`);

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "dpr-1", "requirements do not depend on pixel density");
});

const field = (page: Page, label: RegExp) => page.getByLabel(label);
const fails = (page: Page) => page.getByTestId("summary-fail");

async function open(page: Page) {
  await page.goto(BASE());
  await page.setInputFiles("input[type=file]", file("valid_basic"));
  await expect(page.getByRole("status")).toHaveText(/^Inspection complete/);
}

test("changing a threshold and running again changes the outcome and the applied requirements", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("applied-requirements")).toContainText("Demonstration values");
  const before = await fails(page).innerText();

  await field(page, /minimum thickness/i).fill("5");
  await field(page, /maximum diameter/i).fill("10");
  // Old results are hidden at once, not shown beside the new values.
  await expect(page.getByTestId("stale-results")).toBeVisible();
  await expect(fails(page)).toHaveCount(0);

  await page.getByRole("button", { name: "Run again" }).or(page.getByRole("button", { name: "Run inspection" })).click();
  await expect(page.getByTestId("applied-requirements")).toContainText("Your requirements");
  await expect(page.getByTestId("applied-requirements")).toContainText(/at least 5/);
  expect(await fails(page).innerText()).not.toBe(before);

  // Evidence stays linked: selecting a finding still works on the new report.
  await page.getByRole("button", { name: /^Select finding F1$/ }).click();
  await expect(page.locator("li[data-selected=true]")).toHaveCount(1);
});

test("an exact material code that does not match fails, and reset restores the demonstration values", async ({ page }) => {
  await open(page);
  await field(page, /required material code/i).fill("SUS304");
  await page.getByRole("button", { name: "Run inspection" }).click();
  await expect(page.getByTestId("applied-requirements")).toContainText(/SUS304/);
  await expect(page.getByText(/The material is SS400; the requirement is SUS304/)).toBeVisible();

  await page.getByRole("button", { name: "Reset to demonstration values" }).click();
  await expect(page.getByTestId("requirements-label")).toHaveText("Demonstration values. Not engineering standards.");
  await expect(page.getByTestId("stale-results")).toBeVisible();
});

test("invalid values keep the run disabled and nothing is sent", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/inspections", async (route) => {
    requests += 1;
    await route.continue();
  });
  await page.goto(BASE());
  await field(page, /minimum thickness/i).fill("-1");
  await page.setInputFiles("input[type=file]", file("valid_basic"));
  await expect(page.getByTestId("empty-results")).toContainText("chosen but not inspected");
  await expect(page.getByRole("button", { name: "Run inspection" })).toBeDisabled();
  expect(requests).toBe(0);
});

test("CAD annotations are listed apart from the findings and never become pass or fail", async ({ page }) => {
  await page.goto(BASE());
  await page.setInputFiles("input[type=file]", path.resolve(process.cwd(), "tests/fixtures/cad_dimensions.pdf"));
  await expect(page.getByRole("status")).toHaveText(/^Inspection complete/);
  const section = page.getByTestId("cad-annotations");
  await expect(section).toContainText("2.7 ±0.1");
  await expect(section).toContainText("Not understood");
  await expect(section).toContainText("never produce a pass or fail");
  await expect(page.getByTestId("summary-pass")).toContainText("1"); // the labeled material only
});

test("a verified feature association is drawn on the page, and an unresolved one says so", async ({ page }) => {
  await page.goto(BASE());
  await page.setInputFiles("input[type=file]", path.resolve(process.cwd(), "tests/fixtures/feature_dimensions.pdf"));
  await expect(page.getByRole("status")).toHaveText(/^Inspection complete/);
  const diameter = page.getByTestId("cad-annotations").locator("li", { hasText: "Ø12" });
  await expect(diameter.getByTestId(/^association-A/)).toContainText("Feature identified: Diameter of a drawn circle");
  const unresolved = page.getByTestId("cad-annotations").locator("li", { hasText: "Ø10" });
  await expect(unresolved.getByTestId(/^association-A/)).toContainText("Association unresolved");
  await expect(unresolved.getByRole("button", { name: "Show on drawing" })).toHaveCount(0);
  await expect(page.getByTestId("association-layer")).toHaveCount(0);

  await diameter.getByRole("button", { name: "Show on drawing" }).click();
  const layer = page.getByTestId("association-layer");
  await expect(layer).toBeVisible();
  // The ring is the circle that was drawn (centre 300,400, r 25 in page points), at this zoom.
  const ring = layer.locator("polygon[data-role=circle]");
  const box = await ring.boundingBox();
  const stage = await page.getByTestId("page-stage").boundingBox();
  expect(box && stage).toBeTruthy();
  const scale = stage!.width / 595;
  expect(box!.x - stage!.x + box!.width / 2).toBeCloseTo(300 * scale, 0);
  expect(box!.y - stage!.y + box!.height / 2).toBeCloseTo(400 * scale, 0);
  // The outline's own width (3.5 px) adds to the box on each side.
  expect(Math.abs(box!.width - 50 * scale)).toBeLessThan(5);
  await diameter.getByRole("button", { name: "Hide on drawing" }).click();
  await expect(page.getByTestId("association-layer")).toHaveCount(0);
});
