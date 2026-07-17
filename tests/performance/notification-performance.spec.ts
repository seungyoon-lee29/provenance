import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";

const baseURL = "http://127.0.0.1:3102";
const WARM_UPS = 3;
const SAMPLES = 15;

// Lab browser gate for the F5 inbox paint budget (spec §12 line 396: server
// commit→inbox paint p95 desktop 750 ms / mobile 1,200 ms). The synthetic
// /f5-inbox surface runs the real occurrence engine + dispatcher server-side on
// every request, so navigation→announcement-visible covers commit AND paint.
type Lane = Readonly<{
  cpuSlowdown: number;
  downloadBytesPerSecond: number;
  latencyMs: number;
  viewport: Readonly<{ width: number; height: number }>;
  touch: boolean;
  inboxPaintBudgetMs: number;
}>;

function lane(projectName: string): Lane {
  return projectName === "desktop-1366" ? {
    cpuSlowdown: 2,
    downloadBytesPerSecond: 10 * 1_024 * 1_024 / 8,
    latencyMs: 40,
    viewport: { width: 1366, height: 768 },
    touch: false,
    inboxPaintBudgetMs: 750,
  } : {
    cpuSlowdown: 4,
    downloadBytesPerSecond: 1.6 * 1_024 * 1_024 / 8,
    latencyMs: 150,
    viewport: { width: 360, height: 800 },
    touch: true,
    inboxPaintBudgetMs: 1_200,
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

async function measureInboxOpen(page: Page): Promise<number> {
  const startedAt = Date.now();
  await page.goto(`${baseURL}/f5-inbox`, { waitUntil: "commit" });
  await page.locator('[data-role="inbox-announcement"]').waitFor({ state: "visible" });
  await page.locator("[data-record-key]").first().waitFor({ state: "visible" });
  return Date.now() - startedAt;
}

test("meets the inbox open→paint budget on the fixed lab lane", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const settings = lane(testInfo.project.name);
  const { context, page } = await measuredContext(browser, settings);

  for (let index = 0; index < WARM_UPS; index += 1) await measureInboxOpen(page);
  const samples: number[] = [];
  for (let index = 0; index < SAMPLES; index += 1) samples.push(await measureInboxOpen(page));
  await context.close();

  const measured = p95(samples);
  testInfo.annotations.push({
    type: "evidence",
    description: JSON.stringify({
      measurementClass: "local release-build fixed-lane evidence",
      canonicalReleaseRunnerAsserted: false,
      lane: testInfo.project.name,
      samples: samples.length,
      p95Ms: Math.round(measured),
      budgetMs: settings.inboxPaintBudgetMs,
    }),
  });
  expect(measured).toBeLessThanOrEqual(settings.inboxPaintBudgetMs);
});
