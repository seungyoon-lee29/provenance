import { describe, expect, it } from "vitest";

import {
  applyChartFreshness,
  classifyChartFreshness,
  intervalToMs,
  resolveWithStaleIfError,
  validateChartBars,
} from "../src/modules/financial-information/chart/chart-freshness";
import type { AvailableInformation, FailedInformation } from "@/shared";
import type { ChartBar, ChartSeriesValue } from "../src/modules/financial-information/chart/contracts";

const NOW = Date.parse("2026-03-02T15:00:00.000Z");
const MINUTE = intervalToMs("1m");

function bar(periodStartMs: number, overrides: Partial<ChartBar> = {}): ChartBar {
  return {
    periodStart: new Date(periodStartMs).toISOString(),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1_000,
    priceBasis: "raw",
    complete: true,
    ...overrides,
  };
}

function available(bars: readonly ChartBar[]): AvailableInformation<ChartSeriesValue> {
  return {
    status: "available",
    value: {
      symbol: "AAPL", range: "1M", interval: "1m", priceBasis: "raw", bars,
      indicators: { policyVersion: "policy:test" as never, movingAverage: [], bollinger: { upper: [], middle: [], lower: [] }, rsi: [], macd: { macd: [], signal: [], histogram: [] } },
      summary: { count: bars.length, first: bars[0] ?? null, last: bars.at(-1) ?? null, high: 101, low: 99 },
      evidenceReference: "evidence:test" as never,
    },
    evidenceReference: "evidence:test" as never,
    provider: "synthetic", feed: "fixture-chart", asOf: "2026-03-02T14:59:00.000Z", receivedAt: "2026-03-02T15:00:00.000Z",
    freshness: "realtime",
    licenseScope: { audience: "internal_test_only", purposes: ["chart_display"], validUntil: "2027-01-01T00:00:00.000Z" },
    policyVersion: "policy:test" as never,
  };
}

const meta = { intervalMs: MINUTE, declaredLagMs: 0, nowMs: NOW };

describe("chart freshness and expiry (fixed clock)", () => {
  it("measures age from the period start per §5.1: realtime, then delayed", () => {
    // 1m interval, lag 0 → softLimit 75000, hardLimit 180000. Age = now − periodStart.
    expect(classifyChartFreshness({ latestPeriodStartMs: NOW, intervalMs: MINUTE, declaredLagMs: 0, nowMs: NOW }))
      .toEqual({ kind: "fresh", freshness: "realtime" });
    expect(classifyChartFreshness({ latestPeriodStartMs: NOW - MINUTE, intervalMs: MINUTE, declaredLagMs: 0, nowMs: NOW }))
      .toEqual({ kind: "fresh", freshness: "delayed" });
  });

  it("treats the soft and hard limits as exclusive boundaries", () => {
    // At exactly soft (75000) → stale; below → delayed. At exactly hard (180000) → dropped.
    expect(classifyChartFreshness({ latestPeriodStartMs: NOW - 74_999, intervalMs: MINUTE, declaredLagMs: 0, nowMs: NOW }).kind).toBe("fresh");
    expect(classifyChartFreshness({ latestPeriodStartMs: NOW - 75_000, intervalMs: MINUTE, declaredLagMs: 0, nowMs: NOW }))
      .toEqual({ kind: "soft_expired", freshness: "stale" });
    expect(classifyChartFreshness({ latestPeriodStartMs: NOW - 179_999, intervalMs: MINUTE, declaredLagMs: 0, nowMs: NOW }).kind).toBe("soft_expired");
    expect(classifyChartFreshness({ latestPeriodStartMs: NOW - 180_000, intervalMs: MINUTE, declaredLagMs: 0, nowMs: NOW }))
      .toEqual({ kind: "hard_expired" });
  });

  it("flags a future-dated bar as invalid", () => {
    expect(classifyChartFreshness({ latestPeriodStartMs: NOW + MINUTE, intervalMs: MINUTE, declaredLagMs: 0, nowMs: NOW }))
      .toEqual({ kind: "invalid", reason: "future_timestamp" });
  });

  it("rejects malformed, future, non-canonical, out-of-order, mixed-basis, and negative-volume bars", () => {
    expect(validateChartBars([], NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(validateChartBars([bar(NOW - MINUTE, { close: Number.NaN })], NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(validateChartBars([bar(NOW - MINUTE, { volume: -1 })], NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(validateChartBars([bar(NOW + MINUTE)], NOW)).toEqual({ ok: false, reason: "future_timestamp" });
    // Impossible date normalizes (Feb 30 → Mar 2) and fails the canonical round-trip.
    expect(validateChartBars([{ ...bar(NOW), periodStart: "2026-02-30T00:00:00.000Z" }], NOW)).toEqual({ ok: false, reason: "malformed" });
    // Duplicate / out-of-order period starts must not advance a watermark.
    expect(validateChartBars([bar(NOW - MINUTE), bar(NOW - MINUTE)], NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(validateChartBars([bar(NOW - MINUTE), bar(NOW - 2 * MINUTE)], NOW)).toEqual({ ok: false, reason: "malformed" });
    // Mixed price basis across bars.
    expect(validateChartBars([bar(NOW - 2 * MINUTE), bar(NOW - MINUTE, { priceBasis: "split_adjusted" })], NOW)).toEqual({ ok: false, reason: "malformed" });
    // A clean, strictly-increasing raw series validates.
    expect(validateChartBars([bar(NOW - 2 * MINUTE), bar(NOW - MINUTE)], NOW)).toMatchObject({ ok: true });
  });

  it("shapes soft-expired availability as stale with a retryable degradation", () => {
    const outcome = applyChartFreshness(available([bar(NOW - 120_000)]), meta);
    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("expected available");
    expect(outcome.freshness).toBe("stale");
    expect(outcome.degradation?.retryable).toBe(true);
  });

  it("drops hard-expired availability to no_data with no value", () => {
    const outcome = applyChartFreshness(available([bar(NOW - 400_000)]), meta);
    expect(outcome).toMatchObject({ status: "unavailable", reason: "no_data" });
    expect("value" in outcome && outcome.value).toBeFalsy();
  });

  it("quarantines a future timestamp as invalid_response", () => {
    const outcome = applyChartFreshness(available([bar(NOW + MINUTE)]), meta);
    expect(outcome).toMatchObject({ status: "failed", degradation: { code: "invalid_response", retryable: false } });
  });

  it("serves a retainable cache on a failed refresh, but never a hard-expired one", () => {
    const failed: FailedInformation = {
      status: "failed",
      degradation: { code: "timeout", provider: "synthetic", feed: "fixture-chart", occurredAt: "2026-03-02T15:00:00.000Z", retryable: true, diagnosticReference: "diagnostic:test" as never },
      policyVersion: "policy:test" as never,
    };
    expect(resolveWithStaleIfError(failed, available([bar(NOW - 120_000)]), meta)).toMatchObject({ status: "available", freshness: "stale" });
    expect(resolveWithStaleIfError(failed, available([bar(NOW - 400_000)]), meta)).toBe(failed);
  });
});
