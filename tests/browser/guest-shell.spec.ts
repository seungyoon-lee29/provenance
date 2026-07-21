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

test("renders honest guest outcomes, provenance, and access gates", async ({ page }) => {
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("complementary", { name: "개인 기능과 데이터 품질" })).toBeVisible();
  await expect(page.getByText("SYNTHETIC TEST DATA", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "시장 요약" })).toContainText("101.25");
  await expect(page.getByRole("region", { name: "시장 요약" })).toContainText("fixture-realtime");
  await expect(page.getByRole("region", { name: "시장 요약" })).toContainText("Data Freshness");
  await expect(page.getByRole("region", { name: "시장 요약" })).toContainText("License Scope");
  await expect(page.locator('[data-access="login_required"]')).toHaveCount(3);
  await expect(page.locator('[data-state="unavailable"] [data-role="primary-value"], [data-state="failed"] [data-role="primary-value"]')).toHaveCount(0);
});

test("workspace keeps its height when the synthetic banner is absent (production row map)", async ({ page }) => {
  // Production mode renders no synthetic banner. The shell layout must not
  // depend on that child's presence: with positional grid rows the workspace
  // collapsed to the 52px strip slot and every panel was clipped (regression
  // found on a production build, 2026-07-17).
  await page.evaluate(() => {
    document.querySelector('[class*="syntheticBanner"]')?.remove();
  });
  const workspace = await page.evaluate(() => {
    const main = document.querySelector("main#workspace");
    if (!(main instanceof HTMLElement)) return undefined;
    // Mobile scrolls the workspace internally, so panels below the fold are
    // fine — the regression signals are a collapsed container (52px) and
    // zero-height panels.
    const panels = [...main.querySelectorAll("[data-panel-key]")];
    return {
      height: Math.round(main.getBoundingClientRect().height),
      panelCount: panels.length,
      flatPanels: panels.filter((panel) => panel.getBoundingClientRect().height === 0).length,
    };
  });
  expect(workspace).toBeDefined();
  expect(workspace?.height ?? 0).toBeGreaterThan(300);
  expect(workspace?.panelCount ?? 0).toBeGreaterThan(0);
  expect(workspace?.flatPanels).toBe(0);
});

test("keeps the desktop grid and mobile column inside the exact viewport", async ({ page }, testInfo) => {
  const measurements = await page.evaluate(() => {
    const root = document.documentElement;
    const workspace = document.querySelector<HTMLElement>('[data-workspace="guest"]');
    const columns = [
      document.querySelector<HTMLElement>('[aria-label="시장 모니터"]'),
      document.querySelector<HTMLElement>('[aria-label="공개 정보 Workspace"]'),
      document.querySelector<HTMLElement>('[aria-label="개인 기능과 데이터 품질"]'),
    ].filter((element): element is HTMLElement => Boolean(element));
    const panels = [...document.querySelectorAll<HTMLElement>("main section")];
    return {
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
      clientHeight: root.clientHeight,
      scrollHeight: root.scrollHeight,
      workspace: workspace ? { clientHeight: workspace.clientHeight, scrollHeight: workspace.scrollHeight } : null,
      columns: columns.map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, width: rect.width, bottom: rect.bottom };
      }),
      panels: panels.map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, width: rect.width };
      }),
      internalScrollCount: [...document.querySelectorAll<HTMLElement>('[data-scroll-region="panel"]')]
        .filter((element) => element.scrollHeight > element.clientHeight && getComputedStyle(element).overflowY !== "visible").length,
    };
  });

  expect(measurements.scrollWidth).toBe(measurements.clientWidth);
  expect(measurements.scrollHeight).toBe(measurements.clientHeight);
  if (testInfo.project.name === "desktop-1366") {
    expect(measurements.clientWidth).toBe(1366);
    expect(measurements.clientHeight).toBe(768);
    expect(measurements.columns).toHaveLength(3);
    expect(measurements.columns[0]!.x).toBeLessThan(measurements.columns[1]!.x);
    expect(measurements.columns[1]!.x).toBeLessThan(measurements.columns[2]!.x);
    await expect(page.getByRole("region", { name: "Paper Blotter" })).toBeInViewport();
  } else {
    expect(measurements.clientWidth).toBe(360);
    expect(measurements.clientHeight).toBe(800);
    expect(measurements.workspace?.scrollHeight).toBeGreaterThan(measurements.workspace?.clientHeight ?? 0);
    expect(measurements.panels.every((panel) => Math.abs(panel.x - 8) <= 1 && Math.abs(panel.width - 344) <= 2)).toBe(true);
    expect(measurements.internalScrollCount).toBeGreaterThan(0);
  }
});

test("supports keyboard commands, mobile menu focus return, and touch targets", async ({ page }, testInfo) => {
  const input = page.getByRole("textbox", { name: "명령 또는 티커 입력" });
  await input.fill("AAPL");
  const submit = page.getByRole("button", { name: "명령 실행" });
  await submit.click();
  // ticket 37: 명령창이 실제로 조회를 시작한다. 게스트에게는 개인 시세가 라이선스상 닫혀 있으므로
  // 값이 아니라 "로그인 필요"가 정직한 결과다 — 어느 쪽이든 값을 지어내지 않는다.
  await expect(page.getByText("AAPL 조회를 시작했습니다.", { exact: true })).toBeAttached();
  await expect(page.locator('[data-role="lookup-row"][data-symbol="AAPL"]')).toBeVisible();
  await expect(page.locator('[data-role="lookup-row"][data-symbol="AAPL"] [data-role="lookup-value"]')).toHaveCount(0);
  await expect(submit).toBeFocused();

  if (testInfo.project.name === "mobile-360") {
    const menu = page.getByRole("button", { name: "주 메뉴" });
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeFocused();
    const heights = await page.locator("header button, header input, header a, main button, main a").evaluateAll((elements) => elements
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
      })
      .map((element) => element.getBoundingClientRect().height));
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
  }
});

test("has no serious WCAG or color-contrast violations", async ({ page }) => {
  const results = await new AxeBuilder({ page })
    .exclude("nextjs-portal")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const violations = results.violations.filter((violation) =>
    violation.id === "color-contrast" || violation.impact === "critical" || violation.impact === "serious");
  expect(violations).toEqual([]);
});

test("ends a cache miss at the visible ten-second deadline", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-1366", "one exact-timing browser lane is sufficient");
  const cell = page.locator('[data-panel-key="index-usdkrw"]');
  await expect(cell).toContainText("데이터 확인 중");
  await expect(cell).toContainText("공급자 응답 대기", { timeout: 2_500 });
  await expect(cell).toContainText("재시도 가능", { timeout: 8_500 });
  await expect(cell.locator('[data-role="primary-value"]')).toHaveCount(0);
});

test("paints an independent refresh result before the deadline", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-1366", "one integration lane is sufficient");
  const panel = page.getByRole("region", { name: "관심종목" });
  await expect(panel).toContainText("데이터 확인 중");
  await expect(panel).toContainText("공급자 응답 대기", { timeout: 2_500 });
  await expect(panel).toContainText("API 필요", { timeout: 1_500 });
  await expect(panel.locator('[data-role="primary-value"]')).toHaveCount(0);
});
