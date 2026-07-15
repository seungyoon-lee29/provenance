import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:3100") await route.continue();
    else await route.abort("blockedbyclient");
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
});

const chart = "[data-chart-workspace]";
const summary = '[data-role="chart-summary"]';

test("renders the SSR chart frame with a golden 22-bar window and provenance", async ({ page }) => {
  const region = page.locator(chart);
  await expect(region).toBeVisible();
  await expect(page.locator(summary)).toHaveAttribute("data-chart-count", "22");
  await expect(page.locator(summary)).toContainText("22개 봉");
  await expect(page.locator(summary)).toContainText("AAPL");
  await expect(page.locator('[data-role="chart-value"]')).toHaveCount(1);
  await expect(region).toContainText("Evidence Reference");
  await expect(region).toContainText("Price Basis");
});

test("changes request window, count, and summary when the selection changes", async ({ page }) => {
  const line = page.locator(summary);
  await expect(line).toHaveAttribute("data-chart-count", "22");
  const rangeGroup = page.getByRole("group", { name: "기간 선택" });
  const yearButton = rangeGroup.getByRole("button", { name: "1Y", exact: true });
  await expect(yearButton).toBeEnabled();
  await yearButton.click();
  await page.getByRole("group", { name: "interval 선택" }).getByRole("button", { name: "1W", exact: true }).click();
  await expect(line).toHaveAttribute("data-chart-count", "52");
  await expect(line).toContainText("52개 봉");
  await expect(yearButton).toHaveAttribute("aria-pressed", "true");
});

test("never lets a stale slow response overwrite a newer selection", async ({ page }) => {
  const line = page.locator(summary);
  const symbols = page.getByRole("group", { name: "종목 선택" });
  await expect(symbols.getByRole("button", { name: "SLOW", exact: true })).toBeEnabled();
  await symbols.getByRole("button", { name: "SLOW", exact: true }).click(); // settles ~300ms later
  await symbols.getByRole("button", { name: "MSFT", exact: true }).click(); // cache hit, newer revision
  await expect(line).toHaveAttribute("data-chart-symbol", "MSFT");
  await page.waitForTimeout(600); // let the SLOW response resolve and be dropped
  await expect(line).toHaveAttribute("data-chart-symbol", "MSFT");
  await expect(line).toHaveAttribute("data-chart-count", "22");
});

test("keeps the chart free of serious WCAG or contrast violations", async ({ page }) => {
  const results = await new AxeBuilder({ page }).include(chart)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const violations = results.violations.filter((violation) =>
    violation.id === "color-contrast" || violation.impact === "critical" || violation.impact === "serious");
  expect(violations).toEqual([]);
});
