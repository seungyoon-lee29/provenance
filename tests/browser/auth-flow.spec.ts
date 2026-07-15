import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// F3 auth smoke: email sign-in happy path end to end (browser lane, both viewports).
// The lane runs with CREDENTIAL_VAULT_PROVIDER=disabled, so connections surface the config state.
// A fresh address per run keeps the shared in-memory identity store deterministic across retries.

const SECRET_PROBE = "TOP-SECRET-CREDENTIAL-VALUE";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("email sign-in issues a session and lands authenticated with a masked connections view", async ({ page }) => {
  const email = `smoke-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

  await page.goto("/signin");

  // Request a verify_email challenge.
  await page.getByLabel("이메일").fill(email);
  await page.getByRole("button", { name: "인증 메일 보내기" }).click();

  // aria-live status advances to the code stage; focus lands on the code field (WS-06).
  const codeField = page.getByLabel("인증 코드");
  await expect(codeField).toBeVisible();
  await expect(codeField).toBeFocused();

  // Read the "email" from the dev-only Mailpit-equivalent peek seam.
  const peek = await page.request.get("/api/auth/email/peek");
  expect(peek.ok()).toBeTruthy();
  const drafts = (await peek.json()).drafts as Array<{ code: string; linkToken: string }>;
  expect(drafts.length).toBeGreaterThan(0);
  const code = drafts[0]!.code;

  await codeField.fill(code);
  await Promise.all([
    page.waitForURL("**/workspace"),
    page.getByRole("button", { name: "코드 확인" }).click(),
  ]);

  // Authenticated: the account reference + logout + connections section render.
  await expect(page.locator('[data-role="account-panel"]')).toBeVisible();
  await expect(page.locator('[data-role="account-reference"]')).toContainText("account:");
  await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();

  // Vault disabled → connections surface "설정 필요"; nothing secret-shaped is exposed.
  await expect(page.locator('[data-role="connections-config"]')).toHaveText("설정 필요");
  const body = await page.content();
  expect(body).not.toContain(SECRET_PROBE);
  expect(body).not.toContain("ft_session"); // session value never bleeds into HTML

  // The HttpOnly session cookie is not readable from JS.
  const cookieVisibleToJs = await page.evaluate(() => document.cookie.includes("ft_session"));
  expect(cookieVisibleToJs).toBe(false);

  // The workspace layout editor still renders alongside the auth overlay.
  await expect(page.locator('[data-role="workspace-layout"]')).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  expect(serious).toEqual([]);
});
