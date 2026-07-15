import type { ChartInterval, ChartRange } from "./contracts";

/**
 * Canonical trading calendar used to size every chart window deterministically.
 * A regular US session is 390 minutes; trading days/weeks/months per range are
 * fixed so the same (range, interval) always resolves to the same bar count,
 * independent of wall-clock. The two spec-anchored windows are 1M/1D → 22 bars
 * and 1Y/1W → 52 bars (AT-02).
 */
const SESSION_MINUTES = 390;

const tradingDaysByRange: Readonly<Record<ChartRange, number>> = {
  "1D": 1,
  "5D": 5,
  "1M": 22,
  "3M": 66,
  "6M": 126,
  "1Y": 252,
  "2Y": 504,
  "5Y": 1260,
};

const weeksByRange: Partial<Readonly<Record<ChartRange, number>>> = {
  "3M": 13,
  "6M": 26,
  "1Y": 52,
  "2Y": 104,
  "5Y": 260,
};

const monthsByRange: Partial<Readonly<Record<ChartRange, number>>> = {
  "2Y": 24,
  "5Y": 60,
};

const intradayMinutes: Partial<Readonly<Record<ChartInterval, number>>> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "1h": 60,
};

/** Valid interval set per range — the flattened list is the 21-entry manifest. */
const validIntervalsByRange: Readonly<Record<ChartRange, readonly ChartInterval[]>> = {
  "1D": ["1m", "5m", "15m", "1h"],
  "5D": ["5m", "15m", "1h"],
  "1M": ["15m", "1h", "1D"],
  "3M": ["1h", "1D", "1W"],
  "6M": ["1D", "1W"],
  "1Y": ["1D", "1W"],
  "2Y": ["1W", "1Mo"],
  "5Y": ["1W", "1Mo"],
};

export type ChartWindow = Readonly<{
  range: ChartRange;
  interval: ChartInterval;
  key: string;
  label: string;
  expectedBars: number;
}>;

export function chartWindowKey(range: ChartRange, interval: ChartInterval): string {
  return `${range}:${interval}`;
}

export function isValidChartWindow(range: ChartRange, interval: ChartInterval): boolean {
  return validIntervalsByRange[range].includes(interval);
}

function barsPerSession(interval: ChartInterval): number {
  const minutes = intradayMinutes[interval];
  if (minutes === undefined) throw new Error(`interval ${interval} is not intraday`);
  return Math.ceil(SESSION_MINUTES / minutes);
}

/** Deterministic bar count for a (range, interval) window from the canonical calendar. */
export function resolveChartWindow(range: ChartRange, interval: ChartInterval): ChartWindow {
  if (!isValidChartWindow(range, interval)) {
    throw new Error(`unsupported chart window ${chartWindowKey(range, interval)}`);
  }
  let expectedBars: number;
  if (interval === "1D") {
    expectedBars = tradingDaysByRange[range];
  } else if (interval === "1W") {
    const weeks = weeksByRange[range];
    if (weeks === undefined) throw new Error(`weekly window undefined for ${range}`);
    expectedBars = weeks;
  } else if (interval === "1Mo") {
    const months = monthsByRange[range];
    if (months === undefined) throw new Error(`monthly window undefined for ${range}`);
    expectedBars = months;
  } else {
    expectedBars = tradingDaysByRange[range] * barsPerSession(interval);
  }
  return { range, interval, key: chartWindowKey(range, interval), label: `${range} · ${interval}`, expectedBars };
}

export const chartWindowManifest: readonly ChartWindow[] = Object.entries(validIntervalsByRange)
  .flatMap(([range, intervals]) => intervals.map((interval) => resolveChartWindow(range as ChartRange, interval)));

export function chartIntervalsForRange(range: ChartRange): readonly ChartInterval[] {
  return validIntervalsByRange[range];
}

export const defaultChartSelection = Object.freeze({
  symbol: "AAPL",
  range: "1M" as ChartRange,
  interval: "1D" as ChartInterval,
});
