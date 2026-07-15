import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";

const baseURL = "http://127.0.0.1:3102";
const WARM_UPS = 5;
const SAMPLES = 30;

type Lane = Readonly<{
  cpuSlowdown: number;
  downloadBytesPerSecond: number;
  latencyMs: number;
  viewport: Readonly<{ width: number; height: number }>;
  touch: boolean;
  selectionVisibleBudgetMs: number;
  cachedPaintBudgetMs: number;
}>;

function lane(projectName: string): Lane {
  return projectName === "desktop-1366" ? {
    cpuSlowdown: 2,
    downloadBytesPerSecond: 10 * 1_024 * 1_024 / 8,
    latencyMs: 40,
    viewport: { width: 1366, height: 768 },
    touch: false,
    selectionVisibleBudgetMs: 100,
    cachedPaintBudgetMs: 450,
  } : {
    cpuSlowdown: 4,
    downloadBytesPerSecond: 1.6 * 1_024 * 1_024 / 8,
    latencyMs: 150,
    viewport: { width: 360, height: 800 },
    touch: true,
    selectionVisibleBudgetMs: 100,
    cachedPaintBudgetMs: 800,
  };
}

function p95(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

async function measuredContext(browser: Browser, settings: Lane): Promise<Readonly<{ context: BrowserContext; page: Page }>> {
  const context = await browser.newContext({
    viewport: settings.viewport,
    hasTouch: settings.touch,
    isMobile: settings.touch,
    colorScheme: "dark",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === baseURL) await route.continue();
    else await route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await session.send("Network.enable");
  await session.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: settings.latencyMs,
    downloadThroughput: settings.downloadBytesPerSecond,
    uploadThroughput: settings.downloadBytesPerSecond,
    connectionType: settings.touch ? "cellular3g" : "wifi",
  });
  await session.send("Emulation.setCPUThrottlingRate", { rate: settings.cpuSlowdown });
  return { context, page };
}

// Toggle an interval within a fixed range so each selection regenerates a distinct window.
async function measureToggle(page: Page, intervalLabel: string, expectedCount: string): Promise<Readonly<{ selectionVisibleMs: number; cachedPaintMs: number }>> {
  return page.evaluate(async ({ intervalLabel, expectedCount }) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="interval 선택"] button')]
      .find((element) => element.textContent?.trim() === intervalLabel);
    const summary = document.querySelector('[data-role="chart-summary"]');
    if (!button || !summary) throw new Error("chart controls not found");
    const start = performance.now();
    let selectionVisibleMs = 0;
    button.click();
    await new Promise<void>((resolve) => {
      const checkPressed = () => {
        if (button.getAttribute("aria-pressed") === "true") { selectionVisibleMs = performance.now() - start; resolve(); }
        else requestAnimationFrame(checkPressed);
      };
      requestAnimationFrame(checkPressed);
    });
    await new Promise<void>((resolve) => {
      const checkPaint = () => {
        if (summary.getAttribute("data-chart-count") === expectedCount) resolve();
        else requestAnimationFrame(checkPaint);
      };
      requestAnimationFrame(checkPaint);
    });
    return { selectionVisibleMs, cachedPaintMs: performance.now() - start };
  }, { intervalLabel, expectedCount });
}

test("meets chart selection and cached-paint interaction budgets", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const settings = lane(testInfo.project.name);
  const { context, page } = await measuredContext(browser, settings);
  await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded" });

  // Fix the range to 3M so 1D (66 bars) and 1W (13 bars) are both valid, distinct windows.
  const rangeButton = page.getByRole("group", { name: "기간 선택" }).getByRole("button", { name: "3M", exact: true });
  await expect(rangeButton).toBeEnabled();
  await rangeButton.click();
  await expect(page.locator('[data-role="chart-summary"]')).toHaveAttribute("data-chart-count", "66");

  const toggles = [{ label: "1W", count: "13" }, { label: "1D", count: "66" }] as const;
  for (let index = 0; index < WARM_UPS; index += 1) {
    const toggle = toggles[index % 2]!;
    await measureToggle(page, toggle.label, toggle.count);
  }

  const selectionVisible: number[] = [];
  const cachedPaint: number[] = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const toggle = toggles[index % 2]!;
    const sample = await measureToggle(page, toggle.label, toggle.count);
    selectionVisible.push(sample.selectionVisibleMs);
    cachedPaint.push(sample.cachedPaintMs);
  }
  await context.close();

  const evidence = {
    measurementClass: "local release-build fixed-lane evidence",
    canonicalReleaseRunnerAsserted: false,
    nodeVersion: process.version,
    chromeVersion: browser.version(),
    cpuSlowdown: settings.cpuSlowdown,
    warmUps: WARM_UPS,
    samples: SAMPLES,
    outliersRemoved: false,
    selectionVisibleP95Ms: p95(selectionVisible),
    cachedPaintP95Ms: p95(cachedPaint),
    selectionVisibleBudgetMs: settings.selectionVisibleBudgetMs,
    cachedPaintBudgetMs: settings.cachedPaintBudgetMs,
  };
  await testInfo.attach("chart-performance.json", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
  console.log(`F2_PERFORMANCE ${JSON.stringify(evidence)}`);
  expect(evidence.selectionVisibleP95Ms).toBeLessThanOrEqual(settings.selectionVisibleBudgetMs);
  expect(evidence.cachedPaintP95Ms).toBeLessThanOrEqual(settings.cachedPaintBudgetMs);
});
