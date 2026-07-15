import { describe, expect, it } from "vitest";

import {
  bollingerBands,
  exponentialMovingAverage,
  macd,
  relativeStrengthIndex,
  simpleMovingAverage,
} from "../src/modules/financial-information/chart/chart-indicators";

const constant = (value: number, length: number): number[] => Array.from({ length }, () => value);
const ramp = (length: number): number[] => Array.from({ length }, (_, index) => index + 1);

describe("chart indicators (independent oracle)", () => {
  it("computes a simple moving average with a leading warm-up gap", () => {
    // Hand-worked: window of 3 over 1..5 → means of (1,2,3),(2,3,4),(3,4,5).
    expect(simpleMovingAverage([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it("collapses Bollinger bands onto the mean when variance is zero", () => {
    const bands = bollingerBands(constant(7, 6), 5, 2);
    expect(bands.middle[5]).toBe(7);
    expect(bands.upper[5]).toBe(7);
    expect(bands.lower[5]).toBe(7);
  });

  it("widens Bollinger bands by k population standard deviations", () => {
    // closes 2,4,6 with period 3: mean 4, popStdDev sqrt(8/3) ≈ 1.632993, k=2.
    const bands = bollingerBands([2, 4, 6], 3, 2);
    expect(bands.middle[2]).toBe(4);
    expect(bands.upper[2]).toBeCloseTo(4 + 2 * Math.sqrt(8 / 3), 10);
    expect(bands.lower[2]).toBeCloseTo(4 - 2 * Math.sqrt(8 / 3), 10);
  });

  it("returns 100 for only-gains, 0 for only-losses, 50 for a flat series", () => {
    expect(relativeStrengthIndex(ramp(15), 14)[14]).toBe(100);
    expect(relativeStrengthIndex([...ramp(15)].reverse(), 14)[14]).toBe(0);
    const flat = relativeStrengthIndex(constant(5, 20), 14);
    expect(flat[14]).toBe(50);
    expect(flat[19]).toBe(50);
    expect(flat[13]).toBeNull();
  });

  it("applies Wilder smoothing correctly on a mixed series", () => {
    // Period 3 over 10,11,10,11,12 (changes +1,-1,+1,+1). Hand-worked:
    //  idx3: avgGain=2/3, avgLoss=1/3, RS=2 → RSI=100−100/3=66.6667.
    //  idx4: avgGain=(2/3·2+1)/3=7/9, avgLoss=(1/3·2)/3=2/9, RS=3.5 → RSI=100−100/4.5=77.7778.
    const rsi = relativeStrengthIndex([10, 11, 10, 11, 12], 3);
    expect(rsi[3]).toBeCloseTo(66.6667, 3);
    expect(rsi[4]).toBeCloseTo(77.7778, 3);
  });

  it("seeds the MACD signal only after both EMAs and the signal window warm up", () => {
    // slow EMA(26) seeds at index 25 → macd line non-null from 25; signal EMA(9) seeds
    // at the 9th non-null macd = index 33. Assert the exact warm-up null boundary.
    const series = macd(ramp(40), 12, 26, 9);
    expect(series.signal[32]).toBeNull();
    expect(series.signal[33]).not.toBeNull();
    expect(series.histogram[32]).toBeNull();
    expect(series.histogram[33]).not.toBeNull();
  });

  it("rejects non-integer and non-positive periods", () => {
    expect(() => simpleMovingAverage([1, 2, 3], 1.5)).toThrow();
    expect(() => relativeStrengthIndex([1, 2, 3], 0)).toThrow();
    expect(() => macd([1, 2, 3], 12, 26, Number.NaN)).toThrow();
  });

  it("seeds an EMA at the period-th value with a simple mean", () => {
    // period 3 over 1..5: seed at index 2 = mean(1,2,3)=2, then 4*0.5+2*0.5=3, 5*0.5+3*0.5=4.
    expect(exponentialMovingAverage([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it("drives MACD, signal, and histogram to zero on a flat series", () => {
    const flat = macd(constant(3, 40), 12, 26, 9);
    expect(flat.macd[39]).toBe(0);
    expect(flat.signal[39]).toBe(0);
    expect(flat.histogram[39]).toBe(0);
    // MACD line only exists once the slow EMA is seeded (index 25 onward).
    expect(flat.macd[24]).toBeNull();
    expect(flat.macd[25]).toBe(0);
  });

  it("keeps every indicator series aligned to the input length", () => {
    const closes = ramp(30);
    expect(simpleMovingAverage(closes, 5)).toHaveLength(30);
    expect(relativeStrengthIndex(closes, 14)).toHaveLength(30);
    expect(macd(closes, 12, 26, 9).histogram).toHaveLength(30);
  });
});
