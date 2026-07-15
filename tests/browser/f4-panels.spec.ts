import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:3100") await route.continue();
    else await route.abort("blockedbyclient");
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/f4-panels");
});

test("page structure: main landmark and synthetic marker are present", async ({ page }) => {
  const main = page.locator('main[aria-label="F4 정보 outcome 매트릭스"][data-surface="f4-panels"]');
  await expect(main).toBeVisible();
  await expect(page.locator('[role="note"][data-role="synthetic-marker"]')).toContainText("SYNTHETIC TEST DATA");
});

test("three section groups are present with correct labels", async ({ page }) => {
  await expect(page.locator('section[data-group="market"][aria-label="시장 관측 매트릭스"]')).toBeVisible();
  await expect(page.locator('section[data-group="evidence"][aria-label="Evidence 매트릭스"]')).toBeVisible();
  await expect(page.locator('section[data-group="research"][aria-label="Research 매트릭스"]')).toBeVisible();
});

test("AT-01 invariant: 25 panels, 7 available, 7 primary-value outputs, zero in failed/unavailable", async ({ page }) => {
  await expect(page.locator("[data-panel-key]")).toHaveCount(25);
  await expect(page.locator('[data-state="available"]')).toHaveCount(7);
  await expect(page.locator('[data-role="primary-value"]')).toHaveCount(7);
  // ponytail: same idiom as guest-shell.spec.ts line ~24
  await expect(
    page.locator('[data-state="failed"] [data-role="primary-value"], [data-state="unavailable"] [data-role="primary-value"]'),
  ).toHaveCount(0);
});

test("available_realtime panel shows value and key provenance rows", async ({ page }) => {
  const panel = page.locator('[data-panel-key="available_realtime"]');
  await expect(panel.locator('[data-role="primary-value"]')).toBeVisible();
  await expect(panel).toContainText("Provider");
  await expect(panel).toContainText("Data Freshness");
  await expect(panel).toContainText("License Scope");
  await expect(panel).toContainText("Policy Version");
});

test("available_stale panel shows value, 오래됨 status, and Degradation code provenance row", async ({ page }) => {
  const panel = page.locator('[data-panel-key="available_stale"]');
  await expect(panel.locator('[data-role="primary-value"]')).toBeVisible();
  await expect(panel).toContainText("오래됨");
  await expect(panel).toContainText("Degradation code");
});

test("unavailable panels show correct labels and no primary-value", async ({ page }) => {
  const apiRequired = page.locator('[data-panel-key="api_required"]');
  await expect(apiRequired).toContainText("API 필요");
  await expect(apiRequired.locator('[data-role="primary-value"]')).toHaveCount(0);

  const licenseRestricted = page.locator('[data-panel-key="license_restricted"]');
  await expect(licenseRestricted).toContainText("표시 권한 없음");
  await expect(licenseRestricted.locator('[data-role="primary-value"]')).toHaveCount(0);

  const noData = page.locator('[data-panel-key="no_data"]');
  await expect(noData).toContainText("데이터 없음");
  await expect(noData.locator('[data-role="primary-value"]')).toHaveCount(0);
});

test("deadline-demo panel is failed with no primary-value (proves withDeadline is wired)", async ({ page }) => {
  const panel = page.locator('[data-panel-key="deadline-demo"]');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-state="failed"]')).toBeVisible();
  await expect(panel.locator('[data-role="primary-value"]')).toHaveCount(0);
});

test("research-ok has a value; research-denied has none", async ({ page }) => {
  await expect(page.locator('[data-panel-key="research-ok"] [data-role="primary-value"]')).toBeVisible();
  await expect(page.locator('[data-panel-key="research-denied"] [data-role="primary-value"]')).toHaveCount(0);
});

test("screenshot: license_restricted unavailable panel", async ({ page }) => {
  const panel = page.locator('[data-panel-key="license_restricted"]');
  await expect(panel).toBeVisible();
  await panel.screenshot({ path: "tests/browser/screenshots/explicit-unavailable.png" });
});
