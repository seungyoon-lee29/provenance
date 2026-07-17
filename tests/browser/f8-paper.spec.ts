import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:3100") await route.continue();
    else await route.abort("blockedbyclient");
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/f8-paper");
});

test("page structure: main landmark, synthetic marker and a NAMED yellow Paper badge (UF-07/WS-06)", async ({ page }) => {
  await expect(page.locator('main[aria-label="F8 Internal Paper Trading"][data-surface="f8-paper"]')).toBeVisible();
  await expect(page.locator('[role="note"][data-role="synthetic-marker"]')).toContainText("SYNTHETIC TEST DATA");
  const badge = page.locator('[data-role="paper-badge"]');
  // Named with text, not merely styled: the words identify Paper Trading.
  await expect(badge).toContainText("PAPER TRADING");
  await expect(badge).toContainText("모의 거래");
  await expect(badge).toHaveCSS("background-color", "rgb(245, 197, 24)");
  await expect(page.locator('[data-role="account-source"]')).toContainText("paper-account:internal:workspace:w-f8-demo");
});

test("cash books the hand-worked literals: fill, split and dividend applied exactly once", async ({ page }) => {
  const usd = page.locator('[data-cash-currency="USD"]');
  // 100,000 − 10 × 100.07 + 20 × 0.50 = 99,009.30; all reservations released.
  await expect(usd.locator('[data-role="cash-balance"]')).toContainText("99,009.30 USD");
  await expect(usd.locator('[data-role="cash-reserved"]')).toContainText("예약 0.00");
  await expect(usd.locator('[data-role="cash-available"]')).toContainText("가용 99,009.30");
  // 10 filled shares became 20 after the 2:1 split; raw basis is unchanged.
  const position = page.locator('[data-position-instrument="instr:AAPL"]');
  await expect(position.locator('[data-role="position-quantity"]')).toContainText("수량 20");
  await expect(position.locator('[data-role="position-basis"]')).toContainText("원가 1,000.70 USD");
});

test("orders expose the three independent axes as text", async ({ page }) => {
  const cancelled = page.locator('[data-cancellation="confirmed"]');
  await expect(cancelled.locator('[data-role="axis-submission"]')).toContainText("접수 acknowledged");
  await expect(cancelled.locator('[data-role="axis-execution"]')).toContainText("체결 partially_filled");
  await expect(cancelled.locator('[data-role="axis-cancellation"]')).toContainText("취소 confirmed");
  const expired = page.locator('[data-execution="expired"]');
  await expect(expired.locator('[data-role="axis-cancellation"]')).toContainText("취소 none");
});

test("the Blotter lists Paper records in journal order with both fill times, and nothing else (§9)", async ({ page }) => {
  const rows = page.locator('[data-role="blotter-row"]');
  await expect(rows).toHaveCount(7);
  const kinds = await rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-kind")));
  expect(kinds).toEqual(["submit", "submit", "fill", "cancel_confirmed", "expiry", "corporate_action", "dividend"]);
  const fill = page.locator('[data-role="blotter-row"][data-kind="fill"]');
  await expect(fill.locator('[data-role="blotter-detail"]')).toContainText("simulated fill 10 @ 100.07 USD (simulation-v1)");
  await expect(fill.locator('[data-role="blotter-times"]')).toContainText("2026-07-18T02:01:00.000Z / 2026-07-18T02:01:01.000Z");
  // No Actual or Live vocabulary anywhere in the Blotter (ADR A04).
  const blotterText = await page.locator('[data-role="blotter-section"]').innerText();
  expect(blotterText).not.toContain("actual");
  expect(blotterText).not.toContain("Live");
});
