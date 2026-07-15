// INTEGRATION PENDING: main agent must mount <WorkspaceLayout /> at a route.
// This spec expects the component reachable at the login/workspace surface with the
// data-* seams below. Until then it cannot run standalone (the workspace route is
// owned by the main agent). Do NOT add to a playwright lane until the route exists.
//
// Expected mount:
//   - Route: the logged-in terminal workspace (e.g. GET /workspace or the
//     authenticated "/" surface). Provide a warm/deterministic layout seed so the
//     grid renders two widgets: "chart" (x0 y0 w6 h8) and "watchlist" (x6 y0 w3 h8).
//   - Selectors this spec asserts on (from workspace-layout.tsx):
//       [data-role="workspace-layout"]        (section, data-revision)
//       [data-role="layout-summary"]          (aria-live, data-revision, data-widget-count)
//       [data-role="layout-widget"]           (li, data-widget-id/x/y/w/h/panes)
//       [data-role="layout-announcement"]     (aria-live=assertive)
//       button[aria-label="차트 오른쪽으로 이동"] etc. (keyboard/touch move+resize)
//   - baseURL: set BASE below to whatever lane serves the mounted route.

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const ROUTE = "/workspace"; // TODO(main agent): confirm actual mounted route.

const layout = '[data-role="workspace-layout"]';
const summary = '[data-role="layout-summary"]';
const chartWidget = '[data-role="layout-widget"][data-widget-id="chart"]';

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  // Reset the shared dev workspace to the seed so each case starts at revision 0.
  await page.request.post("/api/workspace/reset");
  await page.goto(ROUTE);
});

test("renders the seeded grid with two widgets and revision 0", async ({ page }) => {
  await expect(page.locator(layout)).toBeVisible();
  await expect(page.locator(summary)).toHaveAttribute("data-widget-count", "2");
  await expect(page.locator(layout)).toHaveAttribute("data-revision", "0");
  await expect(page.locator(chartWidget)).toHaveAttribute("data-x", "0");
  await expect(page.locator(chartWidget)).toHaveAttribute("data-y", "0");
});

test("keyboard move changes geometry and revision (WS-02/WS-03)", async ({ page }) => {
  const move = page.getByRole("button", { name: "차트 오른쪽으로 이동" });
  await move.focus();
  await move.press("Enter");
  await expect(page.locator(chartWidget)).toHaveAttribute("data-x", "1");
  await expect(page.locator(layout)).toHaveAttribute("data-revision", "1");
  // focus returns to the acted-on control (WS-06)
  await expect(move).toBeFocused();
});

test("resize changes width and announces via aria-live (WS-06)", async ({ page }) => {
  await page.getByRole("button", { name: "차트 너비 늘리기" }).click();
  await expect(page.locator(chartWidget)).toHaveAttribute("data-w", "7");
  await expect(page.locator('[data-role="layout-announcement"]')).toContainText("리비전 1");
});

test("split changes pane count", async ({ page }) => {
  await page.getByRole("button", { name: "차트 분할" }).click();
  await expect(page.locator(chartWidget)).toHaveAttribute("data-panes", "2");
});

test("divider resize changes panel width and revision", async ({ page }) => {
  await page.getByRole("button", { name: "좌측 패널 넓히기" }).click();
  await expect(page.locator(layout)).toHaveAttribute("data-revision", "1");
});

test("reload restores the persisted layout (UF-04, logged-in only)", async ({ page }) => {
  // The move persists server-side; wait for that POST to land before reloading.
  const [, ] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/workspace/layout") && r.request().method() === "POST"),
    page.getByRole("button", { name: "차트 오른쪽으로 이동" }).click(),
  ]);
  await expect(page.locator(chartWidget)).toHaveAttribute("data-x", "1");
  await page.reload();
  await expect(page.locator(chartWidget)).toHaveAttribute("data-x", "1");
  await expect(page.locator(layout)).toHaveAttribute("data-revision", "1");
});

test("no page-level horizontal overflow at 360x800 (WS-04)", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("passes axe with no serious/critical violations (WS-06)", async ({ page }) => {
  const results = await new AxeBuilder({ page }).include(layout).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious).toEqual([]);
});
