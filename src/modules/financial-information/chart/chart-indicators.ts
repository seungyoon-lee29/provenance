import { brandReference } from "../../../shared/contracts/brands";
import type { PolicyVersion } from "@/shared";

import type { ChartBar, ChartIndicatorBand, ChartIndicators, ChartMacdSeries } from "./contracts";

/**
 * Versioned indicator policy. The version travels with every computed series so
 * a stored chart can be re-derived under the exact calculation rules that made
 * it. Conventions fixed by this version:
 *   - moving average / Bollinger middle: simple mean over `period` closes.
 *   - Bollinger band width: population standard deviation × `bollingerK`.
 *   - RSI: Wilder smoothing; flat series → 50, only-gains → 100, only-losses → 0.
 *   - MACD: EMA(fast) − EMA(slow), signal = EMA(macd, signalPeriod), each EMA
 *     seeded with the simple mean of its first `period` inputs.
 */
export const CHART_INDICATOR_POLICY = Object.freeze({
  version: "policy:f2-indicators-v1",
  smaPeriod: 5,
  bollingerPeriod: 20,
  bollingerK: 2,
  rsiPeriod: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
});

export const CHART_INDICATOR_POLICY_VERSION: PolicyVersion =
  brandReference<string, "PolicyVersion">(CHART_INDICATOR_POLICY.version);

export function simpleMovingAverage(values: readonly number[], period: number): (number | null)[] {
  if (!Number.isInteger(period) || period < 1) throw new Error("period must be a positive integer");
  return values.map((_, index) => {
    if (index < period - 1) return null;
    let sum = 0;
    for (let offset = 0; offset < period; offset += 1) sum += values[index - offset]!;
    return sum / period;
  });
}

function populationStdDev(window: readonly number[], mean: number): number {
  const variance = window.reduce((total, value) => total + (value - mean) ** 2, 0) / window.length;
  return Math.sqrt(variance);
}

export function bollingerBands(values: readonly number[], period: number, k: number): ChartIndicatorBand {
  const middle = simpleMovingAverage(values, period);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  values.forEach((_, index) => {
    const mean = middle[index];
    if (mean === null || mean === undefined) {
      upper.push(null);
      lower.push(null);
      return;
    }
    const window = values.slice(index - period + 1, index + 1);
    const deviation = populationStdDev(window, mean);
    upper.push(mean + k * deviation);
    lower.push(mean - k * deviation);
  });
  return { upper, middle, lower };
}

function rsiFrom(averageGain: number, averageLoss: number): number {
  if (averageLoss === 0 && averageGain === 0) return 50;
  if (averageLoss === 0) return 100;
  if (averageGain === 0) return 0;
  const relativeStrength = averageGain / averageLoss;
  return 100 - 100 / (1 + relativeStrength);
}

export function relativeStrengthIndex(values: readonly number[], period: number): (number | null)[] {
  if (!Number.isInteger(period) || period < 1) throw new Error("period must be a positive integer");
  const result: (number | null)[] = values.map(() => null);
  if (values.length <= period) return result;
  let gainSum = 0;
  let lossSum = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index]! - values[index - 1]!;
    if (change >= 0) gainSum += change;
    else lossSum -= change;
  }
  let averageGain = gainSum / period;
  let averageLoss = lossSum / period;
  result[period] = rsiFrom(averageGain, averageLoss);
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index]! - values[index - 1]!;
    const gain = change >= 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
    result[index] = rsiFrom(averageGain, averageLoss);
  }
  return result;
}

/** EMA over a nullable series; seeds at the `period`-th non-null value with a simple mean. */
export function exponentialMovingAverage(values: readonly (number | null)[], period: number): (number | null)[] {
  if (!Number.isInteger(period) || period < 1) throw new Error("period must be a positive integer");
  const result: (number | null)[] = values.map(() => null);
  const multiplier = 2 / (period + 1);
  const present: Array<Readonly<{ index: number; value: number }>> = [];
  values.forEach((value, index) => {
    if (value !== null) present.push({ index, value });
  });
  if (present.length < period) return result;
  let seed = 0;
  for (let offset = 0; offset < period; offset += 1) seed += present[offset]!.value;
  let previous = seed / period;
  result[present[period - 1]!.index] = previous;
  for (let position = period; position < present.length; position += 1) {
    const entry = present[position]!;
    previous = entry.value * multiplier + previous * (1 - multiplier);
    result[entry.index] = previous;
  }
  return result;
}

export function macd(
  values: readonly number[],
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number,
): ChartMacdSeries {
  const fast = exponentialMovingAverage(values, fastPeriod);
  const slow = exponentialMovingAverage(values, slowPeriod);
  const macdLine = values.map((_, index) => {
    const fastValue = fast[index];
    const slowValue = slow[index];
    return fastValue !== null && fastValue !== undefined && slowValue !== null && slowValue !== undefined
      ? fastValue - slowValue
      : null;
  });
  const signal = exponentialMovingAverage(macdLine, signalPeriod);
  const histogram = macdLine.map((macdValue, index) => {
    const signalValue = signal[index];
    return macdValue !== null && signalValue !== null && signalValue !== undefined
      ? macdValue - signalValue
      : null;
  });
  return { macd: macdLine, signal, histogram };
}

export function computeChartIndicators(bars: readonly ChartBar[]): ChartIndicators {
  const closes = bars.map((bar) => bar.close);
  return {
    policyVersion: CHART_INDICATOR_POLICY_VERSION,
    movingAverage: simpleMovingAverage(closes, CHART_INDICATOR_POLICY.smaPeriod),
    bollinger: bollingerBands(closes, CHART_INDICATOR_POLICY.bollingerPeriod, CHART_INDICATOR_POLICY.bollingerK),
    rsi: relativeStrengthIndex(closes, CHART_INDICATOR_POLICY.rsiPeriod),
    macd: macd(closes, CHART_INDICATOR_POLICY.macdFast, CHART_INDICATOR_POLICY.macdSlow, CHART_INDICATOR_POLICY.macdSignal),
  };
}
