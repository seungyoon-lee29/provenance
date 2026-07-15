import { describe, expect, it } from "vitest";

import type { MarketObservation, ObservationExpiryPolicy } from "../src/modules/financial-information/data/contracts";
import {
  applyObservationFreshness,
  classifyObservationFreshness,
  isMalformedObservation,
} from "../src/modules/financial-information/data/observation-freshness";
import { classifyProviderFailure, isQuarantineFailure } from "../src/modules/financial-information/data/outcome-classification";
import type { AvailableInformation } from "@/shared";

// Independent oracle: boundaries are hand-derived from spec §5.1, never by
// calling the classifier. NOW is a fixed clock; asOf = NOW - age.
const NOW = Date.parse("2026-01-02T14:30:00.000Z");
const SEC = 1_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const RESIDUAL: ObservationExpiryPolicy = { kind: "residual", declaredDelayMs: 0, softResidualMs: 15 * SEC, hardResidualMs: 60 * SEC };
// A delayed feed: declared 15min delay, soft +1min, hard +5min (spec §5.1 delayed SIP row).
const DELAYED_SIP: ObservationExpiryPolicy = { kind: "residual", declaredDelayMs: 15 * 60 * SEC, softResidualMs: 60 * SEC, hardResidualMs: 5 * 60 * SEC };
const CADENCE: ObservationExpiryPolicy = { kind: "cadence", cadenceMs: DAY, softGraceMs: 4 * HOUR, hardMissedPublications: 2 };

function classifyAtAge(ageMs: number, policy: ObservationExpiryPolicy) {
  return classifyObservationFreshness({ asOfMs: NOW - ageMs, nowMs: NOW, policy });
}

describe("classifyObservationFreshness — residual policy (§5.1)", () => {
  it("is realtime while age ≤ declared delay", () => {
    expect(classifyAtAge(0, RESIDUAL)).toEqual({ kind: "fresh", freshness: "realtime" });
  });
  it("is delayed between declared delay and soft limit (exclusive)", () => {
    expect(classifyAtAge(1, RESIDUAL)).toEqual({ kind: "fresh", freshness: "delayed" });
    expect(classifyAtAge(15 * SEC - 1, RESIDUAL)).toEqual({ kind: "fresh", freshness: "delayed" });
  });
  it("is stale from the soft limit up to (not including) the hard limit", () => {
    expect(classifyAtAge(15 * SEC, RESIDUAL)).toEqual({ kind: "soft_expired", freshness: "stale" });
    expect(classifyAtAge(60 * SEC - 1, RESIDUAL)).toEqual({ kind: "soft_expired", freshness: "stale" });
  });
  it("is hard-expired at and beyond the hard limit", () => {
    expect(classifyAtAge(60 * SEC, RESIDUAL)).toEqual({ kind: "hard_expired" });
    expect(classifyAtAge(120 * SEC, RESIDUAL)).toEqual({ kind: "hard_expired" });
  });
  it("honours a non-zero declared delay: still realtime at 15min, delayed just after", () => {
    expect(classifyAtAge(15 * 60 * SEC, DELAYED_SIP)).toEqual({ kind: "fresh", freshness: "realtime" });
    expect(classifyAtAge(15 * 60 * SEC + SEC, DELAYED_SIP)).toEqual({ kind: "fresh", freshness: "delayed" });
    expect(classifyAtAge(16 * 60 * SEC, DELAYED_SIP)).toEqual({ kind: "soft_expired", freshness: "stale" });
    expect(classifyAtAge(20 * 60 * SEC, DELAYED_SIP)).toEqual({ kind: "hard_expired" });
  });
  it("treats a future as-of as invalid regardless of policy", () => {
    expect(classifyObservationFreshness({ asOfMs: NOW + SEC, nowMs: NOW, policy: RESIDUAL })).toEqual({ kind: "invalid", reason: "future_timestamp" });
  });
});

describe("classifyObservationFreshness — cadence policy (§5.1 scheduled feeds)", () => {
  it("is realtime within one cadence, delayed within the grace, stale within N publications, then hard", () => {
    expect(classifyAtAge(DAY - SEC, CADENCE)).toEqual({ kind: "fresh", freshness: "realtime" });
    expect(classifyAtAge(DAY + HOUR, CADENCE)).toEqual({ kind: "fresh", freshness: "delayed" });
    expect(classifyAtAge(DAY + 5 * HOUR, CADENCE)).toEqual({ kind: "soft_expired", freshness: "stale" });
    expect(classifyAtAge(2 * DAY, CADENCE)).toEqual({ kind: "hard_expired" });
  });
});

function available(overrides: Partial<MarketObservation> & { asOf?: string } = {}): AvailableInformation<MarketObservation> {
  const value: MarketObservation = {
    symbol: "AAA", last: 100, currency: "USD", change: 1, changePercent: 1, priceBasis: "trade",
    evidenceReference: "evidence:test" as never, ...overrides,
  };
  return {
    status: "available", value, evidenceReference: value.evidenceReference,
    provider: "synthetic", feed: "fixture", venue: "SYNTHETIC",
    asOf: overrides.asOf ?? new Date(NOW).toISOString(), receivedAt: new Date(NOW).toISOString(),
    freshness: "realtime", licenseScope: { audience: "public", purposes: ["public_display"], validUntil: "2027-01-01T00:00:00.000Z" },
    policyVersion: "policy:test" as never,
  };
}

describe("applyObservationFreshness — value only on available (Prevent)", () => {
  it("keeps the value fresh and drops it hard-expired", () => {
    const fresh = applyObservationFreshness(available({ asOf: new Date(NOW).toISOString() }), { nowMs: NOW, policy: RESIDUAL });
    expect(fresh.status).toBe("available");
    const hard = applyObservationFreshness(available({ asOf: new Date(NOW - 120 * SEC).toISOString() }), { nowMs: NOW, policy: RESIDUAL });
    expect(hard.status).toBe("unavailable");
    expect("value" in hard && hard.value).toBeFalsy();
  });
  it("quarantines a malformed (non-finite) value as invalid_response", () => {
    const out = applyObservationFreshness(available({ last: Number.NaN }), { nowMs: NOW, policy: RESIDUAL });
    expect(out.status).toBe("failed");
    expect(isQuarantineFailure(out)).toBe(true);
  });
  it("soft-expired retains the value as stale with a retryable degradation", () => {
    const out = applyObservationFreshness(available({ asOf: new Date(NOW - 30 * SEC).toISOString() }), { nowMs: NOW, policy: RESIDUAL });
    expect(out.status).toBe("available");
    if (out.status === "available") {
      expect(out.freshness).toBe("stale");
      expect(out.degradation?.retryable).toBe(true);
    }
  });
});

describe("isMalformedObservation", () => {
  it("flags non-finite numeric fields", () => {
    expect(isMalformedObservation({ symbol: "A", last: Number.NaN, currency: "USD", change: 0, changePercent: 0, priceBasis: "trade", evidenceReference: "e" as never })).toBe(true);
    expect(isMalformedObservation({ symbol: "A", last: 1, currency: "USD", change: Infinity, changePercent: 0, priceBasis: "trade", evidenceReference: "e" as never })).toBe(true);
    expect(isMalformedObservation({ symbol: "A", last: 1, currency: "USD", change: 0, changePercent: 0, priceBasis: "trade", evidenceReference: "e" as never })).toBe(false);
  });
});

describe("classifyProviderFailure — §5.1 last paragraph", () => {
  const base = { provider: "synthetic", feed: "fixture-feed", occurredAt: new Date(NOW).toISOString() };
  it("401 → failed/reauthentication_required (not retryable)", () => {
    const out = classifyProviderFailure({ ...base, failure: { kind: "reauthentication_required" } });
    expect(out.status).toBe("failed");
    if (out.status === "failed") { expect(out.degradation.code).toBe("reauthentication_required"); expect(out.degradation.retryable).toBe(false); }
  });
  it("403 entitlement → license_restricted with no value", () => {
    const out = classifyProviderFailure({ ...base, failure: { kind: "denied", denial: "entitlement" }, source: "sip", purpose: "public_display" });
    expect(out.status).toBe("unavailable");
    expect(out).toMatchObject({ reason: "license_restricted", source: "sip", purpose: "public_display" });
  });
  it("403 credential → failed/reauthentication_required", () => {
    const out = classifyProviderFailure({ ...base, failure: { kind: "denied", denial: "credential" } });
    expect(out.status === "failed" && out.degradation.code).toBe("reauthentication_required");
  });
  it("403 other → failed/forbidden_upstream", () => {
    const out = classifyProviderFailure({ ...base, failure: { kind: "denied", denial: "other" } });
    expect(out.status === "failed" && out.degradation.code).toBe("forbidden_upstream");
  });
  it("quota → failed/quota with typed retryAfter, retryable", () => {
    const out = classifyProviderFailure({ ...base, failure: { kind: "quota", retryAfter: new Date(NOW + 60 * SEC).toISOString() } });
    expect(out.status).toBe("failed");
    if (out.status === "failed") { expect(out.degradation.code).toBe("quota"); expect(out.degradation.retryAfter).toBe(new Date(NOW + 60 * SEC).toISOString()); expect(out.degradation.retryable).toBe(true); }
  });
  it("timeout and 5xx are retryable normalized codes", () => {
    expect((classifyProviderFailure({ ...base, failure: { kind: "timeout" } }) as { degradation: { code: string; retryable: boolean } }).degradation).toMatchObject({ code: "timeout", retryable: true });
    expect((classifyProviderFailure({ ...base, failure: { kind: "upstream" } }) as { degradation: { code: string; retryable: boolean } }).degradation).toMatchObject({ code: "upstream", retryable: true });
  });
  it("invalid_response is terminal (not retryable) and quarantines", () => {
    const out = classifyProviderFailure({ ...base, failure: { kind: "invalid_response" } });
    expect(isQuarantineFailure(out)).toBe(true);
    expect(out.status === "failed" && out.degradation.retryable).toBe(false);
  });
});
