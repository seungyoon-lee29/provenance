import { describe, expect, it } from "vitest";

import type { GuestClock } from "../src/modules/terminal-view/presentation/guest/contracts";
import {
  createGuestSessionProof,
  createGuestTerminalRequest,
} from "../src/modules/terminal-view/presentation/guest/guest-terminal-view";
import { createGuestTerminalFeature } from "../src/modules/terminal-view/presentation/guest/public-feature";

const nonSettlingClock: GuestClock = {
  now: () => 0,
  sleep: () => new Promise<void>(() => undefined),
};

function p95(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

async function sampleOpen(panelKey: "market-overview" | "index-usdkrw", count: number): Promise<number[]> {
  const feature = createGuestTerminalFeature({ environment: "test", mode: "synthetic", clock: nonSettlingClock });
  const samples: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const startedAt = performance.now();
    const load = feature.terminalView.open(
      createGuestTerminalRequest([panelKey], `perf-${index}`),
      createGuestSessionProof(`perf-${index}`),
    );
    await load.initial;
    samples.push(performance.now() - startedAt);
    load.cancel();
  }
  return samples;
}

describe("guest TerminalView.open performance", () => {
  it("meets the warm and local cache-miss p95 budgets without removing outliers", async () => {
    await sampleOpen("market-overview", 5);
    const warm = await sampleOpen("market-overview", 100);
    const cacheMiss = await sampleOpen("index-usdkrw", 40);
    expect(p95(warm)).toBeLessThanOrEqual(250);
    expect(p95(cacheMiss)).toBeLessThanOrEqual(550);
  });
});
