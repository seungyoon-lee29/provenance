import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:3100") await route.continue();
    else await route.abort("blockedbyclient");
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/f6-portfolio");
});

test("page structure: main landmark and synthetic marker", async ({ page }) => {
  await expect(page.locator('main[aria-label="F6 Actual Portfolio baseline"][data-surface="f6-portfolio"]')).toBeVisible();
  await expect(page.locator('[role="note"][data-role="synthetic-marker"]')).toContainText("SYNTHETIC TEST DATA");
  await expect(page.locator("[data-completeness]")).toHaveCount(3);
});

test("complete scenario shows a total with weights and the superseded quantity", async ({ page }) => {
  const section = page.locator('[data-completeness="complete"]');
  await expect(section.locator('[data-role="total"]')).toContainText("3,940,000 KRW");
  await expect(section.locator('[data-role="weight"]')).toHaveCount(3);
  // The SSNLF aggregate lot was superseded from 10 to 12 — the projection shows 12.
  await expect(section.locator('[data-row-instrument="instr:SSNLF"]')).toContainText("수량 12");
});

test("partial scenario: known subtotal + missing list, and NO total element (no promotion)", async ({ page }) => {
  const section = page.locator('[data-completeness="partial"]');
  await expect(section.locator('[data-role="known-subtotal"]')).toContainText("3,640,000 KRW");
  await expect(section.locator('[data-role="total"]')).toHaveCount(0);
  await expect(section.locator('[data-role="weight"]')).toHaveCount(0);
  await expect(section.locator('[data-missing-reason="price"]')).toContainText("instr:KODEX");
});

test("unavailable scenario: no total, no subtotal, gaps named, original currency kept", async ({ page }) => {
  const section = page.locator('[data-completeness="unavailable"]');
  await expect(section.locator('[data-role="total"], [data-role="known-subtotal"]')).toHaveCount(0);
  await expect(section.locator("[data-missing-reason]")).toHaveCount(3);
  // AAPL is priced in USD but unconvertible — its original-currency value stays visible.
  await expect(section.locator('[data-row-instrument="instr:AAPL"] [data-role="original-value"]')).toContainText("2,000 USD");
});

test("aggregate lots are NAMED with their baseline date, not merely styled (WS-06/UF-06)", async ({ page }) => {
  const labels = page.locator('[data-completeness="complete"] [data-role="aggregate-lot-label"]');
  await expect(labels).toHaveCount(3);
  await expect(labels.first()).toContainText("합산 lot(2026-07-01 기준)");
  // Completeness states are text labels too.
  await expect(page.locator('[data-role="completeness-label"]').nth(1)).toHaveText("부분(알려진 소계만)");
});
