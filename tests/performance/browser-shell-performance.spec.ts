import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";

const baseURL = "http://127.0.0.1:3102";
const COLD_SAMPLES = 40;
const WARM_SAMPLES = 100;
const WARM_UPS = 5;

type Lane = Readonly<{
  cpuSlowdown: number;
  downloadBytesPerSecond: number;
  latencyMs: number;
  viewport: Readonly<{ width: number; height: number }>;
  touch: boolean;
  coldBudgetMs: number;
  warmBudgetMs: number;
}>;

function lane(projectName: string): Lane {
  return projectName === "desktop-1366" ? {
    cpuSlowdown: 2,
    downloadBytesPerSecond: 10 * 1_024 * 1_024 / 8,
    latencyMs: 40,
    viewport: { width: 1366, height: 768 },
    touch: false,
    coldBudgetMs: 2_000,
    warmBudgetMs: 1_000,
  } : {
    cpuSlowdown: 4,
    downloadBytesPerSecond: 1.6 * 1_024 * 1_024 / 8,
    latencyMs: 150,
    viewport: { width: 360, height: 800 },
    touch: true,
    coldBudgetMs: 3_000,
    warmBudgetMs: 1_800,
  };
}

function p95(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

async function blockExternalEgress(context: BrowserContext): Promise<void> {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === baseURL) await route.continue();
    else await route.abort("blockedbyclient");
  });
}

async function throttle(context: BrowserContext, page: Page, settings: Lane): Promise<void> {
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
}

async function newMeasuredContext(browser: Browser, settings: Lane): Promise<Readonly<{
  context: BrowserContext;
  page: Page;
}>> {
  const context = await browser.newContext({
    viewport: settings.viewport,
    hasTouch: settings.touch,
    isMobile: settings.touch,
    colorScheme: "dark",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  await blockExternalEgress(context);
  const page = await context.newPage();
  await throttle(context, page, settings);
  return { context, page };
}

async function navigate(page: Page, url: string): Promise<number> {
  const startedAt = performance.now();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByRole("main").waitFor({ state: "visible" });
  return performance.now() - startedAt;
}

test("meets fixed-lane cold and warm shell p95 budgets", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const settings = lane(testInfo.project.name);
  const coldSamples: number[] = [];
  for (let index = 0; index < COLD_SAMPLES; index += 1) {
    const measured = await newMeasuredContext(browser, settings);
    coldSamples.push(await navigate(measured.page, `${baseURL}/?cold=${index}`));
    await measured.context.close();
  }

  const warmLane = await newMeasuredContext(browser, settings);
  await navigate(warmLane.page, `${baseURL}/?warm=initial`);
  for (let index = 0; index < WARM_UPS; index += 1) await warmLane.page.reload({ waitUntil: "domcontentloaded" });
  const warmSamples: number[] = [];
  for (let index = 0; index < WARM_SAMPLES; index += 1) {
    warmSamples.push(await navigate(warmLane.page, `${baseURL}/?warm=${index}`));
  }
  await warmLane.context.close();

  const evidence = {
    measurementClass: "local release-build fixed-lane evidence",
    canonicalReleaseRunnerAsserted: false,
    nodeVersion: process.version,
    chromeVersion: browser.version(),
    fixedProviderDelayMs: 20,
    warmUps: WARM_UPS,
    coldSamples: COLD_SAMPLES,
    warmSamples: WARM_SAMPLES,
    outliersRemoved: false,
    cpuSlowdown: settings.cpuSlowdown,
    network: {
      latencyMs: settings.latencyMs,
      downloadBytesPerSecond: settings.downloadBytesPerSecond,
    },
    coldP95Ms: p95(coldSamples),
    warmP95Ms: p95(warmSamples),
    coldBudgetMs: settings.coldBudgetMs,
    warmBudgetMs: settings.warmBudgetMs,
  };
  await testInfo.attach("guest-shell-performance.json", {
    body: JSON.stringify(evidence, null, 2),
    contentType: "application/json",
  });
  console.log(`F1_PERFORMANCE ${JSON.stringify(evidence)}`);
  expect(evidence.coldP95Ms).toBeLessThanOrEqual(settings.coldBudgetMs);
  expect(evidence.warmP95Ms).toBeLessThanOrEqual(settings.warmBudgetMs);
});
