import { describe, expect, it } from "vitest";

import type { BacktestConfig, BacktestSeries, StrategyAction } from "../src/modules/paper-trading/backtest/backtest-runner";
import { runBacktest } from "../src/modules/paper-trading/backtest/backtest-runner";
import { buildPerformance, fillConfidence, maxDrawdown } from "../src/modules/paper-trading/backtest/performance-report";

/**
 * T8 S4a acceptance (progress/t8-backtest-engine.md): the performance block is a
 * READ-ONLY aggregation — TWR/XIRR reuse the F7 calculators, MDD and fill
 * confidence are new pure functions, and every return stays coverage-typed
 * (uncomputable ⇒ unavailable, never a fabricated 0%). Win rate is S4b.
 */

const T = (day: number) => `2026-01-0${day}T06:30:00.000Z`;

function series(...closes: readonly number[]): BacktestSeries {
  return {
    instrument: "instr:BT",
    venue: "KRX",
    currency: "KRW",
    bars: closes.map((close, index) => ({ periodStart: T(5 + index), close, volume: 100_000, complete: true })),
  };
}

const buyOnce: BacktestConfig["strategy"] = (view) =>
  view.cursor === 0 ? [{ kind: "submit", order: { side: "buy", orderType: "market", quantity: 10, timeInForce: "GTC" } } as StrategyAction] : [];

function config(s: BacktestSeries, strategy: BacktestConfig["strategy"]): BacktestConfig {
  return { runId: "perf", seedCash: [{ amount: 1_000_000, currency: "KRW" }], series: s, strategy };
}

describe("T8 S4 performance report — pure functions", () => {
  it("maxDrawdown: peak-to-trough ratio, 0 for monotonic/degenerate", () => {
    expect(maxDrawdown([100, 120, 90, 110])).toBe(0.25); // (120−90)/120
    expect(maxDrawdown([100, 110, 130])).toBe(0); // monotonic up
    expect(maxDrawdown([])).toBe(0);
    expect(maxDrawdown([100])).toBe(0);
    // Deepest trough wins even after a partial recovery.
    expect(maxDrawdown([100, 50, 80, 40, 90])).toBe(0.6); // (100−40)/100
  });

  it("fillConfidence: max/mean participation over fills, zero when none", () => {
    const c = fillConfidence([0.05, 0.1, 0.03]);
    expect(c).toEqual({ fills: 3, maxParticipation: 0.1, meanParticipation: (0.05 + 0.1 + 0.03) / 3 });
    expect(fillConfidence([])).toEqual({ fills: 0, maxParticipation: 0, meanParticipation: 0 });
  });

  it("TWR/XIRR reuse: a clean +21% over a non-leap 365-day window is exact", () => {
    const perf = buildPerformance({
      currency: "KRW",
      from: "2023-01-01T00:00:00.000Z",
      to: "2024-01-01T00:00:00.000Z",
      seedValue: 1_000_000,
      finalValue: 1_210_000,
      equity: [1_000_000, 800_000, 1_210_000],
      participations: [0.1],
    });
    expect(perf.timeWeightedReturn).toMatchObject({ status: "covered", ratio: expect.closeTo(0.21, 10) });
    expect(perf.moneyWeightedReturn).toMatchObject({ status: "covered", ratio: expect.closeTo(0.21, 10) });
    expect(perf.maxDrawdown).toBeCloseTo(0.2, 10); // 1.0M → 0.8M
  });

  it("stays honest on a zero-width window: TWR and XIRR are unavailable, not a fabricated 0%", () => {
    const perf = buildPerformance({
      currency: "KRW",
      from: "2024-01-01T00:00:00.000Z",
      to: "2024-01-01T00:00:00.000Z",
      seedValue: 1_000_000,
      finalValue: 1_000_000,
      equity: [1_000_000],
      participations: [],
    });
    expect(perf.timeWeightedReturn.status).toBe("unavailable");
    expect(perf.moneyWeightedReturn.status).toBe("unavailable");
    expect(perf.maxDrawdown).toBe(0);
  });
});

describe("T8 S4 performance report — end to end", () => {
  it("aggregates a buy-and-hold run: TWR from mark-to-market, MDD, participation", async () => {
    // bar0 submit buy 10; bar1 fill 10 @ 10,006 (cash 899,940); bar2 close 12,000.
    // equity = [1,000,000, 899,940+100,000, 899,940+120,000] = [1,000,000, 999,940, 1,019,940].
    const outcome = await runBacktest(config(series(10_000, 10_000, 12_000), buyOnce));
    if (outcome.status !== "complete") throw new Error(outcome.status);
    const perf = outcome.performance;

    expect(perf).toMatchObject({ currency: "KRW", seedValue: 1_000_000, finalValue: 1_019_940 });
    expect(perf.timeWeightedReturn).toMatchObject({ status: "covered", ratio: expect.closeTo(0.01994, 6) });
    expect(perf.moneyWeightedReturn.status).toBe("covered"); // day-count-sensitive; sign/coverage is the invariant
    if (perf.moneyWeightedReturn.status === "covered") expect(perf.moneyWeightedReturn.ratio).toBeGreaterThan(0);
    // Peak 1,000,000 → trough 999,940 → recovery. MDD = 60/1,000,000.
    expect(perf.maxDrawdown).toBeCloseTo(0.00006, 10);
    // One fill of 10 shares against a 100,000-volume bar.
    expect(perf.fillConfidence).toEqual({ fills: 1, maxParticipation: 0.0001, meanParticipation: 0.0001 });
  });

  it("is included deterministically in the byte-identical report", async () => {
    const run = () => runBacktest(config(series(10_000, 10_000, 12_000), buyOnce));
    expect(JSON.stringify(await run())).toBe(JSON.stringify(await run()));
  });
});

describe("T8 S4 performance report — codex adversarial gate regressions", () => {
  const year = { from: "2023-01-01T00:00:00.000Z", to: "2024-01-01T00:00:00.000Z" };

  it("a NaN valuation is unavailable, never a covered null", () => {
    const p = buildPerformance({ currency: "KRW", ...year, seedValue: Number.NaN, finalValue: 100, equity: [100], participations: [] });
    expect(p.timeWeightedReturn.status).toBe("unavailable");
    expect(p.moneyWeightedReturn.status).toBe("unavailable");
  });

  it("an over-extrapolated sub-day window is XIRR-unrepresentable, not Infinity/−1", () => {
    const tiny = { from: "2024-01-01T00:00:00.000Z", to: "2024-01-01T00:01:00.000Z" };
    const gain = buildPerformance({ currency: "KRW", ...tiny, seedValue: 100, finalValue: 101, equity: [100, 101], participations: [] });
    const loss = buildPerformance({ currency: "KRW", ...tiny, seedValue: 100, finalValue: 99, equity: [100, 99], participations: [] });
    expect(gain.moneyWeightedReturn).toEqual({ status: "unavailable", reason: "unrepresentable" });
    expect(loss.moneyWeightedReturn).toEqual({ status: "unavailable", reason: "unrepresentable" });
  });

  it("a total loss is a covered −100% TWR but leaves XIRR without a root", () => {
    const p = buildPerformance({ currency: "KRW", ...year, seedValue: 100, finalValue: 0, equity: [100, 0], participations: [] });
    expect(p.timeWeightedReturn).toEqual({ status: "covered", ratio: -1 });
    expect(p.moneyWeightedReturn.status).toBe("unavailable");
  });

  it("fillConfidence skips a non-finite sample instead of poisoning the mean", () => {
    expect(fillConfidence([Number.NaN, 0.1])).toEqual({ fills: 1, maxParticipation: 0.1, meanParticipation: 0.1 });
  });

  // Runner boundary refusals — the report never values a bad price / seed / date.
  const seriesWith = (rows: readonly { close: number; periodStart: string }[]): BacktestSeries => ({
    instrument: "instr:BT", venue: "KRX", currency: "KRW",
    bars: rows.map((row) => ({ ...row, volume: 100_000, complete: true })),
  });

  it("refuses a non-finite or non-positive close before valuing it", async () => {
    for (const bad of [-100, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const bars = seriesWith([{ close: 10_000, periodStart: T(5) }, { close: bad, periodStart: T(6) }]);
      expect(await runBacktest(config(bars, () => []))).toEqual({ status: "refused", reason: "invalid_bar_price" });
    }
  });

  it("refuses seed cash in a currency the single-currency series never values", async () => {
    const bars = seriesWith([{ close: 10_000, periodStart: T(5) }, { close: 10_000, periodStart: T(6) }]);
    const outcome = await runBacktest({
      runId: "mix", seedCash: [{ amount: 1_000_000, currency: "KRW" }, { amount: 100, currency: "USD" }], series: bars, strategy: () => [],
    });
    expect(outcome).toEqual({ status: "refused", reason: "seed_currency_mismatch" });
  });

  it("refuses an impossible calendar date (JS would normalize 02-30 → 03-01)", async () => {
    const feb30 = seriesWith([
      { close: 10_000, periodStart: "2024-02-28T06:30:00.000Z" },
      { close: 10_000, periodStart: "2024-02-30T06:30:00.000Z" },
    ]);
    expect(await runBacktest(config(feb30, () => []))).toEqual({ status: "refused", reason: "invalid_bar_time" });
  });
});
