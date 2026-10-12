// F4 in real Chromium with the real backend: selecting a finding shows its evidence,
// selecting evidence shows its finding, by mouse and by keyboard, and a new file clears it.
// Geometry and pixel alignment are F3's tests (app.spec.ts, ground-truth.spec.ts).
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { waitForDrawn } from "./alignment";

const BASE = () => process.env.E2E_BASE_URL!;
const drawing = (name: string) => path.resolve(process.cwd(), "../backend/tests/fixtures/drawings", `${name}.pdf`);

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "dpr-1", "interaction does not depend on pixel density");
});

async function open(page: Page, name: string, height = 900) {
  await page.setViewportSize({ width: 1440, height });
  await page.goto(BASE());
  await page.setInputFiles("input[type=file]", drawing(name));
  await expect(page.getByRole("status")).toHaveText(/^Inspection complete/);
  await waitForDrawn(page);
}

const card = (page: Page, id: string) => page.locator(`#finding-${id}`);
const selectButton = (page: Page, id: string) => page.getByRole("button", { name: `Select finding ${id}` });
const selected = (page: Page) => page.locator("li[data-selected=true]");
const renderCount = (page: Page) => page.getByTestId("page-stage").getAttribute("data-render-count");

/** Is the whole element inside the viewer's scrolling area? */
async function visibleInViewer(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const area = document.querySelector("[data-testid=viewer-scroll]")!.getBoundingClientRect();
    const r = document.querySelector(sel)!.getBoundingClientRect();
    return r.top >= area.top - 1 && r.bottom <= area.bottom + 1 && r.left >= area.left - 1 && r.right <= area.right + 1;
  }, selector);
}

test("selecting a finding shows its box, scrolls the viewer to it, and does not render the page again", async ({ page }) => {
  await open(page, "violations", 700); // a short window: the viewer's scroll area is short too
  const box = '[data-evidence-key="F4:M4"]'; // MATERIAL, drawn at the bottom of the page
  expect(await visibleInViewer(page, box)).toBe(false); // below the fold at fit width
  const renders = await renderCount(page);

  await selectButton(page, "F4").click();

  await expect(card(page, "F4")).toHaveAttribute("data-selected", "true");
  await expect(page.locator(box)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("selection-status")).toContainText("F4 is selected: 1 box on the drawing");
  await expect.poll(() => visibleInViewer(page, box)).toBe(true); // brought into view
  // Focus stays on the button that was pressed; nothing stole it.
  await expect(selectButton(page, "F4")).toBeFocused();
  await page.waitForTimeout(400); // longer than the render debounce
  expect(await renderCount(page)).toBe(renders);
  // The other boxes are dimmed, not hidden.
  await expect(page.locator('[data-evidence-key="F1:M1"]')).toHaveCSS("opacity", "0.4");
});

test("selecting a box selects its finding, by mouse and by keyboard", async ({ page }) => {
  await open(page, "violations");
  await page.locator('[data-evidence-key="F2:M2"]').click();
  await expect(selected(page)).toHaveCount(1);
  await expect(card(page, "F2")).toHaveAttribute("data-selected", "true");
  await expect(selectButton(page, "F2")).toHaveText("Selected");
  await expect(page.locator('[data-evidence-key="F2:M2"]')).toHaveAttribute("aria-pressed", "true");

  // Keyboard: focus another box with Tab-reachable focus, press Enter.
  await page.locator('[data-evidence-key="F3:M3"]').focus();
  await expect(page.locator('[data-evidence-key="F3:M3"]')).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card(page, "F3")).toHaveAttribute("data-selected", "true");
  await expect(selected(page)).toHaveCount(1);
  await expect(page.locator('[data-evidence-key="F3:M3"]')).toBeFocused();

  // Space on the selected box's finding clears it.
  await page.keyboard.press("Space");
  await expect(selected(page)).toHaveCount(0);
});

test("a finding with no location is explained, and no box is highlighted", async ({ page }) => {
  await open(page, "missing_material");
  await selectButton(page, "F4").click(); // MAT-REQ-001: no material annotation exists
  await expect(card(page, "F4")).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("selection-status")).toContainText("not marked on the drawing: nothing was found to mark");
  await expect(page.locator('[data-evidence-key][aria-pressed="true"]')).toHaveCount(0);
  await expect(page.getByTestId("location-F4")).toContainText("Not marked");
});

test("choosing another file clears the selection and the boxes at once", async ({ page }) => {
  await open(page, "violations");
  await selectButton(page, "F2").click();
  await expect(selected(page)).toHaveCount(1);

  await page.setInputFiles("input[type=file]", drawing("valid_basic"));
  await expect(selected(page)).toHaveCount(0);
  await expect(page.locator("[data-evidence-key]")).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText(/^Inspection complete: 0 fail/);
  await waitForDrawn(page);
  // Same finding ids in the new report: none is selected.
  await expect(selected(page)).toHaveCount(0);
  await expect(page.locator('[data-evidence-key][aria-pressed="true"]')).toHaveCount(0);
});
