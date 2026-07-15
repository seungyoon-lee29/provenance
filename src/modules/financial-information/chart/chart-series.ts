import { brandReference } from "../../../shared/contracts/brands";
import type { EvidenceReference } from "@/shared";

import { computeChartIndicators } from "./chart-indicators";
import type { ChartBar, ChartPriceBasis, ChartSelection, ChartSeriesValue, ChartSummary } from "./contracts";

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Deterministic synthetic bar generator. No wall-clock and no randomness: a
 * given (base, count, interval, end) always yields the same OHLCV walk, so the
 * generated series doubles as a stable golden. `endPeriodStartMs` is the period
 * start of the newest bar; earlier bars step back by `intervalMs`.
 */
export function synthesizeChartBars(input: Readonly<{
  count: number;
  intervalMs: number;
  endPeriodStartMs: number;
  base: number;
  priceBasis?: ChartPriceBasis;
}>): ChartBar[] {
  const { count, intervalMs, endPeriodStartMs, base } = input;
  const priceBasis = input.priceBasis ?? "raw";
  const bars: ChartBar[] = [];
  let previousClose = base;
  for (let index = 0; index < count; index += 1) {
    const periodStartMs = endPeriodStartMs - (count - 1 - index) * intervalMs;
    const close = round2(base + base * 0.05 * Math.sin(index / 3) + index * 0.1);
    const open = round2(index === 0 ? close : previousClose);
    const high = round2(Math.max(open, close) + base * 0.01 + (index % 3) * 0.05);
    const low = round2(Math.min(open, close) - base * 0.01 - (index % 2) * 0.05);
    bars.push({
      periodStart: new Date(periodStartMs).toISOString(),
      open,
      high,
      low,
      close,
      volume: 1_000_000 + (index % 7) * 10_000,
      priceBasis,
      complete: true,
    });
    previousClose = close;
  }
  return bars;
}

export function summarizeChartBars(bars: readonly ChartBar[]): ChartSummary {
  return {
    count: bars.length,
    first: bars[0] ?? null,
    last: bars.at(-1) ?? null,
    high: bars.length > 0 ? Math.max(...bars.map((bar) => bar.high)) : null,
    low: bars.length > 0 ? Math.min(...bars.map((bar) => bar.low)) : null,
  };
}

export function buildChartSeries(
  selection: ChartSelection,
  bars: readonly ChartBar[],
  evidenceReference: EvidenceReference,
): ChartSeriesValue {
  const priceBasis = bars[0]?.priceBasis ?? "raw";
  return {
    symbol: selection.symbol,
    range: selection.range,
    interval: selection.interval,
    priceBasis,
    bars,
    indicators: computeChartIndicators(bars),
    summary: summarizeChartBars(bars),
    evidenceReference,
  };
}

export function chartEvidenceReference(selection: ChartSelection): EvidenceReference {
  return brandReference<string, "EvidenceReference">(
    `evidence:f2:${selection.symbol}:${selection.range}:${selection.interval}`,
  );
}
