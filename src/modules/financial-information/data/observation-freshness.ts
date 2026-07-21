import { brandReference } from "../../../shared/contracts/brands";
import type {
  AvailableInformation,
  InformationOutcome,
  NoDataInformation,
} from "@/shared";

import type { MarketObservation, ObservationExpiryPolicy } from "./contracts";
import { invalidResponseOutcome, OBSERVATION_POLICY_VERSION } from "./outcome-classification";

// Re-exported from its leaf home so existing importers keep a single name.
export { OBSERVATION_POLICY_VERSION };

export type ObservationFreshnessClass =
  | Readonly<{ kind: "fresh"; freshness: "realtime" | "delayed" }>
  | Readonly<{ kind: "soft_expired"; freshness: "stale" }>
  | Readonly<{ kind: "hard_expired" }>
  | Readonly<{ kind: "invalid"; reason: "future_timestamp" }>;

/**
 * Classify an observation's as-of time against a fixed clock (§5.1 expiry
 * table). `residual` policies measure lag from `asOfMs`: fresh while age ≤
 * declared delay, delayed until soft (declared + softResidual), stale until
 * hard (declared + hardResidual). `cadence` policies measure from `asOfMs` as
 * the last publication: stale after one cadence + grace, hard after N missed
 * publications. All limits are exclusive and a future `asOfMs` is never a value.
 */
export function classifyObservationFreshness(input: Readonly<{
  asOfMs: number;
  nowMs: number;
  policy: ObservationExpiryPolicy;
}>): ObservationFreshnessClass {
  const { asOfMs, nowMs, policy } = input;
  if (asOfMs > nowMs) return { kind: "invalid", reason: "future_timestamp" };
  const age = nowMs - asOfMs;

  if (policy.kind === "residual") {
    const softLimit = policy.declaredDelayMs + policy.softResidualMs;
    const hardLimit = policy.declaredDelayMs + policy.hardResidualMs;
    if (age <= policy.declaredDelayMs) return { kind: "fresh", freshness: "realtime" };
    if (age < softLimit) return { kind: "fresh", freshness: "delayed" };
    if (age < hardLimit) return { kind: "soft_expired", freshness: "stale" };
    return { kind: "hard_expired" };
  }

  // cadence: the value stays realtime within its publication cadence, delayed is
  // not meaningful for a scheduled feed, so a fresh cadence value is realtime.
  const softLimit = policy.cadenceMs + policy.softGraceMs;
  const hardLimit = policy.cadenceMs * policy.hardMissedPublications;
  if (age < policy.cadenceMs) return { kind: "fresh", freshness: "realtime" };
  if (age < softLimit) return { kind: "fresh", freshness: "delayed" };
  if (age < hardLimit) return { kind: "soft_expired", freshness: "stale" };
  return { kind: "hard_expired" };
}

const DAY_MS = 86_400_000;

/**
 * Spec §5.1 "Treasury·ECB daily" freshness for scheduled business-day feeds: realtime until the
 * next expected weekday publication + grace, stale after one missed expected publication, no value
 * after two. Public holidays are unmodeled, which only ages a value FASTER (fail-closed direction).
 * `publicationMinutesUtc` is each feed's DST-agnostic late-bound publication instant.
 */
export function classifyBusinessDayPublicationFreshness(input: Readonly<{
  asOfMs: number;
  nowMs: number;
  publicationMinutesUtc: number;
  softGraceMs: number;
}>): ObservationFreshnessClass {
  const { asOfMs, nowMs } = input;
  if (asOfMs > nowMs) return { kind: "invalid", reason: "future_timestamp" };
  let missed = 0;
  let firstExpectedMs: number | undefined;
  for (let dayMs = asOfMs + DAY_MS; dayMs <= nowMs + DAY_MS && missed < 2; dayMs += DAY_MS) {
    const day = new Date(dayMs);
    const dow = day.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const publicationMs =
      Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) + input.publicationMinutesUtc * 60_000;
    firstExpectedMs ??= publicationMs;
    if (publicationMs < nowMs) missed += 1;
  }
  if (missed === 0) return { kind: "fresh", freshness: "realtime" };
  if (missed === 1 && firstExpectedMs !== undefined && nowMs <= firstExpectedMs + input.softGraceMs) {
    return { kind: "fresh", freshness: "realtime" };
  }
  if (missed === 1) return { kind: "soft_expired", freshness: "stale" };
  return { kind: "hard_expired" };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Reject a market observation whose numbers are non-finite before it can become a value. */
export function isMalformedObservation(value: MarketObservation): boolean {
  return !([value.last, value.change, value.changePercent].every(isFiniteNumber));
}

export function observationHardExpired(queryRange: string, asOf: string): NoDataInformation {
  return { status: "unavailable", reason: "no_data", queryRange, asOf, policyVersion: OBSERVATION_POLICY_VERSION };
}

/**
 * Apply freshness/expiry to an available observation against a fixed clock.
 * Malformed or future values quarantine as invalid_response (the caller must
 * not advance any watermark); soft-expired retains the value as stale with a
 * retryable degradation; hard-expired drops the value.
 */
export function applyObservationFreshness(
  available: AvailableInformation<MarketObservation>,
  input: Readonly<{ nowMs: number; policy: ObservationExpiryPolicy }>,
): InformationOutcome<MarketObservation> {
  return applyClassifiedObservationFreshness(available, {
    nowMs: input.nowMs,
    classify: (asOfMs, nowMs) => classifyObservationFreshness({ asOfMs, nowMs, policy: input.policy }),
  });
}

/**
 * Same malformed/roundtrip/outcome machinery, but with an injected classifier —
 * for feeds whose expiry schedule a static `ObservationExpiryPolicy` cannot
 * express (e.g. Treasury's expected business-day publications, spec §5.1).
 */
export function applyClassifiedObservationFreshness(
  available: AvailableInformation<MarketObservation>,
  input: Readonly<{ nowMs: number; classify(asOfMs: number, nowMs: number): ObservationFreshnessClass }>,
): InformationOutcome<MarketObservation> {
  const occurredAt = new Date(input.nowMs).toISOString();
  if (isMalformedObservation(available.value)) {
    return invalidResponseOutcome(available.provider, available.feed, occurredAt);
  }
  const asOfMs = Date.parse(available.asOf);
  if (Number.isNaN(asOfMs) || new Date(asOfMs).toISOString() !== available.asOf) {
    return invalidResponseOutcome(available.provider, available.feed, occurredAt);
  }
  const classification = input.classify(asOfMs, input.nowMs);
  if (classification.kind === "invalid") {
    return invalidResponseOutcome(available.provider, available.feed, occurredAt);
  }
  if (classification.kind === "hard_expired") {
    return observationHardExpired(available.value.symbol, available.asOf);
  }
  if (classification.kind === "soft_expired") {
    const stale: AvailableInformation<MarketObservation> = {
      ...available,
      freshness: "stale",
      degradation: {
        code: "timeout",
        provider: available.provider,
        feed: available.feed,
        occurredAt,
        retryable: true,
        diagnosticReference: brandReference<string, "DiagnosticReference">(`diagnostic:f4-soft-expiry:${available.feed}`),
      },
    };
    return stale;
  }
  const fresh: AvailableInformation<MarketObservation> = { ...available, freshness: classification.freshness };
  return fresh;
}
