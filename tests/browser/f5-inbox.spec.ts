import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:3100") await route.continue();
    else await route.abort("blockedbyclient");
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/f5-inbox");
});

test("page structure: main landmark, synthetic marker and aria-live announcement", async ({ page }) => {
  await expect(page.locator('main[aria-label="F5 알림 inbox"][data-surface="f5-inbox"]')).toBeVisible();
  await expect(page.locator('[role="note"][data-role="synthetic-marker"]')).toContainText("SYNTHETIC TEST DATA");
  await expect(page.locator('[role="status"][aria-live="polite"][data-role="inbox-announcement"]')).toBeVisible();
});

test("AT-10 DOM invariant: 100 concurrent same transitions yield exactly one occurrence/record", async ({ page }) => {
  const announcement = page.locator('[data-role="inbox-announcement"]');
  await expect(announcement).toHaveAttribute("data-transition-count", "1");
  await expect(announcement).toHaveAttribute("data-occurrence-count", "1");
  // 4 records total: one per rule — the hundred concurrent observers added none beyond the first.
  await expect(announcement).toHaveAttribute("data-record-count", "4");
  await expect(page.locator("[data-record-key]")).toHaveCount(4);
});

test("no promotion: provider acceptance renders 발송 접수, never 전달됨/확인됨", async ({ page }) => {
  const accepted = page.locator('[data-status="provider_accepted"]');
  await expect(accepted).toHaveCount(1);
  await expect(accepted.locator('[data-role="delivery-status"]')).toHaveText("발송 접수");
  await expect(page.locator('[data-status="delivered"], [data-status="seen"]')).toHaveCount(0);
});

test("delivery states are named, not color-only (WS-06)", async ({ page }) => {
  await expect(page.locator('[data-status="none"] [data-role="delivery-status"]')).toHaveText("인앱 표시");
  await expect(page.locator('[data-status="failed"] [data-role="delivery-status"]')).toHaveText("발송 실패");
  await expect(page.locator('[data-status="delayed"] [data-role="delivery-status"]')).toHaveText("재시도 예정");
  // Every card carries a textual read state alongside any tone styling.
  for (const readState of await page.locator('[data-role="read-state"]').allTextContents()) {
    expect(["읽음", "읽지 않음"]).toContain(readState);
  }
});

test("external delivery failure never removes the canonical in-app record (UF-08)", async ({ page }) => {
  // The push-failed and rate-limited causes still render as inbox cards.
  await expect(page.locator('[data-status="failed"]')).toHaveCount(1);
  await expect(page.locator('[data-status="delayed"]')).toHaveCount(1);
});
