import { expect, test } from "@playwright/test";

/**
 * F11 release screenshot: the synthetic Paper Trading workspace
 * (`paper-workspace.png`). Network-off, scripted data — the SYNTHETIC marker and
 * yellow Paper badge are captured so the provenance is unambiguous. No secrets
 * or personal account detail appear (the account id is a synthetic demo id).
 */
test("screenshot: paper trading workspace", async ({ page }, testInfo) => {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:3100") await route.continue();
    else await route.abort("blockedbyclient");
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/f8-paper");

  const surface = page.locator('main[data-surface="f8-paper"]');
  await expect(surface).toBeVisible();
  await expect(page.locator('[data-role="synthetic-marker"]')).toContainText("SYNTHETIC TEST DATA");
  // Capture the canonical desktop workspace once; both projects still assert structure.
  if (testInfo.project.name === "desktop-1366") {
    await surface.screenshot({ path: "tests/browser/screenshots/paper-workspace.png" });
  }
});
