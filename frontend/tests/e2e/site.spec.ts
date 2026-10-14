// Launch-2 in real Chromium with the real backend and the production build (so the production
// CSP and headers apply): the landing page and navigation, the sample drawings through the
// normal pipeline, the viewer with its evidence, small screens and basic accessibility.
import { expect, test, type Page } from "@playwright/test";
import { waitForDrawn } from "./alignment";

const BASE = () => process.env.E2E_BASE_URL!;
const PAGES = ["/", "/inspect", "/about", "/privacy", "/does-not-exist"];

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "dpr-1", "layout and flow do not depend on pixel density");
});

/** Console messages that mean the page broke: CSP violations and uncaught errors. */
function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  return problems;
}

test("the landing page leads to the tool and the sample", async ({ page }) => {
  const problems = watchProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(BASE());
  await expect(page.getByRole("heading", { level: 1 })).toContainText("evidence beside every result");
  await expect(page.getByRole("link", { name: "Upload Drawing" }).first()).toHaveAttribute("href", "/inspect");
  await page.getByRole("link", { name: "Try Sample" }).click();
  await expect(page).toHaveURL(/\/inspect\?sample=cad$/);
  await expect(page.getByRole("status")).toHaveText(/^Inspection complete/);
  expect(problems).toEqual([]);
});

test("the CAD sample is inspected for real: results, evidence and associations", async ({ page }) => {
  const problems = watchProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE()}/inspect?sample=cad`);
  await expect(page.getByRole("status")).toHaveText("Inspection complete: 0 fail, 0 need review, 0 missing, 4 pass.");
  await waitForDrawn(page);
  await expect(page.getByTestId("association-summary")).toContainText("4 verified, 1 unresolved");
  const cad = page.getByTestId("cad-annotations");
  await expect(cad).toContainText("Association unresolved");
  await expect(cad).toContainText("separate lines");
  await expect(page.getByTestId("results-guide")).toBeVisible();
  // A verified association can be shown on the drawing.
  await cad.getByRole("button", { name: "Show on drawing" }).first().click();
  await expect(cad.getByRole("button", { name: "Hide on drawing" })).toHaveCount(1);
  expect(problems).toEqual([]);
});

test("the basic sample gives one fail and three passes, and can be re-run with other limits", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE()}/inspect`);
  await page.getByRole("button", { name: /Labelled plate/ }).click();
  await expect(page.getByRole("status")).toHaveText("Inspection complete: 1 fail, 0 need review, 0 missing, 3 pass.");
  await expect(page.getByTestId("results-guide")).toBeVisible();
  // The requirements fold away once results are shown; open them to change a limit.
  await page.locator("details", { hasText: "Inspection requirements" }).first().locator("summary").click();
  await page.getByLabel("Minimum thickness (mm)").fill("2");
  await page.getByRole("button", { name: "Run inspection" }).click();
  await expect(page.getByRole("status")).toHaveText("Inspection complete: 0 fail, 0 need review, 0 missing, 4 pass.");
});

test("a sample that is not found is explained and nothing is inspected", async ({ page }) => {
  await page.route("**/samples/*.pdf", (route) => route.fulfill({ status: 404, body: "" }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE()}/inspect`);
  await page.getByRole("button", { name: /Labelled plate/ }).click();
  await expect(page.getByText("The sample could not be loaded")).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("");
});

test("samples are served as static files from this site", async ({ request }) => {
  for (const file of ["blueprintiq-sample-basic.pdf", "blueprintiq-sample-cad.pdf"]) {
    const response = await request.get(`${BASE()}/samples/${file}`);
    expect(response.status()).toBe(200);
    expect((await response.body()).subarray(0, 5).toString()).toBe("%PDF-");
  }
});

for (const route of PAGES) {
  test(`on a phone, ${route} has no horizontal scrolling`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${BASE()}${route}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("on a phone, results are complete and the viewer's absence is explained", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${BASE()}/inspect?sample=cad`);
  await expect(page.getByRole("status")).toHaveText(/^Inspection complete/);
  await expect(page.getByTestId("desktop-note")).toBeVisible();
  await expect(page.getByTestId("viewer-slot")).toBeHidden();
  await expect(page.getByTestId("cad-annotations")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

for (const route of PAGES) {
  test(`${route} meets the basic accessibility checks`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const response = await page.goto(`${BASE()}${route}`);
    expect(response?.status()).toBe(route === "/does-not-exist" ? 404 : 200);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("main#main")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await expect(page.getByRole("contentinfo")).toBeVisible();
    expect(await page.title()).not.toBe("");
    const unnamed = await page.evaluate(() => {
      const bad: string[] = [];
      for (const el of document.querySelectorAll("a, button, input, select, textarea")) {
        const name =
          el.getAttribute("aria-label") ||
          (el as HTMLElement).innerText?.trim() ||
          (el as HTMLInputElement).labels?.[0]?.textContent?.trim() ||
          el.getAttribute("aria-labelledby");
        if (!name) bad.push(el.outerHTML.slice(0, 80));
      }
      for (const img of document.querySelectorAll("img")) if (!img.hasAttribute("alt")) bad.push("img without alt");
      return bad;
    });
    expect(unnamed).toEqual([]);
    // The first Tab stop is the skip link, and it works.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  });
}

test("the pages carry their metadata, an icon and no social image without a site address", async ({ page }) => {
  await page.goto(`${BASE()}/about`);
  await expect(page).toHaveTitle("How it works and its limits | BlueprintIQ");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /engineering drawing PDF/);
  await expect(page.locator('meta[property="og:title"]')).toHaveCount(1);
  await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute("href", /icon\.svg/);
  await expect(page.locator('meta[property="og:image"]')).toHaveCount(0);
  expect(JSON.stringify(await page.locator("head").innerHTML())).not.toContain("localhost:3000");
});
