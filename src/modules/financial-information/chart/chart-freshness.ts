import { brandReference } from "../../../shared/contracts/brands";
import type {
  AvailableInformation,
  FailedInformation,
  InformationOutcome,
  NoDataInformation,
  PolicyVersion,
} from "@/shared";

import type { ChartBar, ChartInterval, ChartSeriesValue } from "./contracts";

export const CHART_EXPIRY_POLICY_VERSION: PolicyVersion =
  brandReference<string, "PolicyVersion">("policy:f2-freshness-v1");

const intervalMsByInterval: Readonly<Record<ChartInterval, number>> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "1D": 86_400_000,
  "1W": 604_800_000,
  "1Mo": 2_592_000_000,
};

export function intervalToMs(interval: ChartInterval): number {
  return intervalMsByInterval[interval];
}

export type ChartFreshnessClass =
  | Readonly<{ kind: "fresh"; freshness: "realtime" | "delayed" }>
  | Readonly<{ kind: "soft_expired"; freshness: "stale" }>
  | Readonly<{ kind: "hard_expired" }>
  | Readonly<{ kind: "invalid"; reason: "future_timestamp" }>;

/**
 * Classify the newest bar of a window against a fixed clock. Age is measured
 * from the bar's period start, so the §5.1 "incomplete intraday bar" row holds
 * exactly: soft expiry at interval + declared lag + 15s, hard expiry at
 * 3× interval + declared lag. Both limits are exclusive — a value AT the hard
 * limit is already dropped. A bar that starts after `nowMs` is a future
 * timestamp and is never a value.
 */
export function classifyChartFreshness(input: Readonly<{
  latestPeriodStartMs: number;
  intervalMs: number;
  declaredLagMs: number;
  nowMs: number;
}>): ChartFreshnessClass {
  const { latestPeriodStartMs, intervalMs, declaredLagMs, nowMs } = input;
  if (latestPeriodStartMs > nowMs) return { kind: "invalid", reason: "future_timestamp" };
  const age = nowMs - latestPeriodStartMs;
  const softLimit = intervalMs + declaredLagMs + 15_000;
  const hardLimit = 3 * intervalMs + declaredLagMs;
  if (age <= declaredLagMs) return { kind: "fresh", freshness: "realtime" };
  if (age < softLimit) return { kind: "fresh", freshness: "delayed" };
  if (age < hardLimit) return { kind: "soft_expired", freshness: "stale" };
  return { kind: "hard_expired" };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export type ChartBarValidation =
  | Readonly<{ ok: true; latestPeriodStartMs: number }>
  | Readonly<{ ok: false; reason: "malformed" | "future_timestamp" }>;

/** Reject empty, malformed, or future-dated bar sets before they can advance a watermark. */
export function validateChartBars(bars: readonly ChartBar[], nowMs: number): ChartBarValidation {
  if (bars.length === 0) return { ok: false, reason: "malformed" };
  const basis = bars[0]!.priceBasis;
  let previousStartMs = Number.NEGATIVE_INFINITY;
  let latestPeriodStartMs = Number.NEGATIVE_INFINITY;
  for (const bar of bars) {
    const startMs = Date.parse(bar.periodStart);
    // Reject non-canonical or impossible dates (e.g. Feb 30 normalizes to Mar 2 and fails the round-trip).
    if (Number.isNaN(startMs) || new Date(startMs).toISOString() !== bar.periodStart) {
      return { ok: false, reason: "malformed" };
    }
    if (bar.priceBasis !== basis) return { ok: false, reason: "malformed" };
    if (![bar.open, bar.high, bar.low, bar.close, bar.volume].every(isFiniteNumber) || bar.volume < 0) {
      return { ok: false, reason: "malformed" };
    }
    if (bar.high < bar.low || bar.high < bar.open || bar.high < bar.close || bar.low > bar.open || bar.low > bar.close) {
      return { ok: false, reason: "malformed" };
    }
    // Bars must be strictly increasing and unique so a duplicate or reordered period cannot advance a watermark.
    if (startMs <= previousStartMs) return { ok: false, reason: "malformed" };
    if (startMs > nowMs) return { ok: false, reason: "future_timestamp" };
    previousStartMs = startMs;
    latestPeriodStartMs = startMs;
  }
  return { ok: true, latestPeriodStartMs };
}

export function chartInvalidResponseOutcome(
  provider: string,
  feed: string,
  occurredAt: string,
): FailedInformation {
  return {
    status: "failed",
    degradation: {
      code: "invalid_response",
      provider,
      feed,
      occurredAt,
      retryable: false,
      diagnosticReference: brandReference<string, "DiagnosticReference">(`diagnostic:f2-invalid:${feed}`),
    },
    policyVersion: CHART_EXPIRY_POLICY_VERSION,
  };
}

export function chartTimeoutOutcome(provider: string, feed: string, occurredAt: string): FailedInformation {
  return {
    status: "failed",
    degradation: {
      code: "timeout",
      provider,
      feed,
      occurredAt,
      retryable: true,
      diagnosticReference: brandReference<string, "DiagnosticReference">(`diagnostic:f2-deadline:${feed}`),
    },
    policyVersion: CHART_EXPIRY_POLICY_VERSION,
  };
}

export function chartHardExpiredOutcome(queryRange: string, asOf: string): NoDataInformation {
  return { status: "unavailable", reason: "no_data", queryRange, asOf, policyVersion: CHART_EXPIRY_POLICY_VERSION };
}

/**
 * Apply the freshness/expiry/invalid policy to an available chart series against
 * a fixed clock. Fresh → passthrough; soft-expired → available + stale + a
 * retryable degradation (retain last observation); hard-expired → no value;
 * future/malformed → invalid_response (caller must not advance any watermark).
 */
export function applyChartFreshness(
  available: AvailableInformation<ChartSeriesValue>,
  input: Readonly<{ intervalMs: number; declaredLagMs: number; nowMs: number }>,
): InformationOutcome<ChartSeriesValue> {
  const occurredAt = new Date(input.nowMs).toISOString();
  const validation = validateChartBars(available.value.bars, input.nowMs);
  if (!validation.ok) {
    // Malformed or future-dated bars both quarantine as invalid_response; the caller must not advance any watermark.
    return chartInvalidResponseOutcome(available.provider, available.feed, occurredAt);
  }
  const classification = classifyChartFreshness({
    latestPeriodStartMs: validation.latestPeriodStartMs,
    intervalMs: input.intervalMs,
    declaredLagMs: input.declaredLagMs,
    nowMs: input.nowMs,
  });
  if (classification.kind === "invalid") {
    return chartInvalidResponseOutcome(available.provider, available.feed, occurredAt);
  }
  if (classification.kind === "hard_expired") {
    return chartHardExpiredOutcome(`${available.value.range}:${available.value.interval}`, available.asOf);
  }
  if (classification.kind === "soft_expired") {
    const stale: AvailableInformation<ChartSeriesValue> = {
      ...available,
      freshness: "stale",
      degradation: {
        code: "timeout",
        provider: available.provider,
        feed: available.feed,
        occurredAt,
        retryable: true,
        diagnosticReference: brandReference<string, "DiagnosticReference">(`diagnostic:f2-soft-expiry:${available.feed}`),
      },
    };
    return stale;
  }
  return { ...available, freshness: classification.freshness };
}

/** stale-if-error: a failed refresh may serve a retainable (not hard-expired) cache as stale. */
export function resolveWithStaleIfError(
  fresh: InformationOutcome<ChartSeriesValue>,
  cached: InformationOutcome<ChartSeriesValue> | undefined,
  input: Readonly<{ intervalMs: number; declaredLagMs: number; nowMs: number }>,
): InformationOutcome<ChartSeriesValue> {
  if (fresh.status !== "failed" || !cached || cached.status !== "available") return fresh;
  const retained = applyChartFreshness(cached, input);
  if (retained.status === "available") return retained;
  return fresh;
}
