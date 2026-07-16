import { describe, expect, it } from "vitest";

import { EMAIL_QUOTA, reserveEmailQuota, type EmailQuotaUsage } from "../src/modules/notification-center/email-quota";
import {
  emailCircuitProbe,
  evaluateEmailCircuit,
  isEmailAddressBlocked,
} from "../src/modules/notification-center/email-circuit";
import {
  FINANCIAL_EMAIL_COOLDOWN_MS,
  TokenBucket,
  financialCooldownActive,
  quietHoursHoldsFinancial,
} from "../src/modules/notification-center/email-throttle";

const ZERO_USAGE: EmailQuotaUsage = { totalDay: 0, totalMonth: 0, financialDay: 0, financialMonth: 0, userDay: 0, userMonth: 0 };

describe("reserveEmailQuota — security reserve (spec §12 line 335)", () => {
  it("grants both categories from a clean slate", () => {
    expect(reserveEmailQuota("security", ZERO_USAGE)).toEqual({ granted: true });
    expect(reserveEmailQuota("financial", ZERO_USAGE)).toEqual({ granted: true });
  });

  it("caps financial at 75/day and 2250/month so 25/day, 750/month stay reserved for security", () => {
    expect(reserveEmailQuota("financial", { ...ZERO_USAGE, financialDay: 75 })).toEqual({ granted: false, reason: "daily_quota" });
    expect(reserveEmailQuota("financial", { ...ZERO_USAGE, financialMonth: 2250 })).toEqual({ granted: false, reason: "monthly_quota" });
  });

  it("still lets security through when financial is maxed and the plan has room", () => {
    // financial used all 75 today; 24 security already sent → total 99. The 25th security still fits the reserve.
    expect(reserveEmailQuota("security", { ...ZERO_USAGE, financialDay: 75, totalDay: 99 })).toEqual({ granted: true });
    // total plan exhausted → even security is denied.
    expect(reserveEmailQuota("security", { ...ZERO_USAGE, totalDay: EMAIL_QUOTA.totalDay })).toEqual({ granted: false, reason: "daily_quota" });
    expect(reserveEmailQuota("security", { ...ZERO_USAGE, totalMonth: EMAIL_QUOTA.totalMonth })).toEqual({ granted: false, reason: "monthly_quota" });
  });

  it("applies per-user financial caps (5/day, 60/month)", () => {
    expect(reserveEmailQuota("financial", { ...ZERO_USAGE, userDay: 5 })).toEqual({ granted: false, reason: "user_daily" });
    expect(reserveEmailQuota("financial", { ...ZERO_USAGE, userMonth: 60 })).toEqual({ granted: false, reason: "user_monthly" });
  });
});

describe("evaluateEmailCircuit (spec §12 line 350)", () => {
  it("opens on a >=3% hard bounce rate once the sample reaches 200", () => {
    expect(evaluateEmailCircuit({ sampleSize: 200, hardBounces: 6, complaints: 0 })).toEqual({ state: "open", reason: "hard_bounce" });
    expect(evaluateEmailCircuit({ sampleSize: 200, hardBounces: 5, complaints: 0 })).toEqual({ state: "closed" });
  });

  it("opens on a >=0.05% complaint rate at a meaningful sample", () => {
    expect(evaluateEmailCircuit({ sampleSize: 2000, hardBounces: 0, complaints: 1 })).toEqual({ state: "open", reason: "complaint" });
    expect(evaluateEmailCircuit({ sampleSize: 4000, hardBounces: 0, complaints: 1 })).toEqual({ state: "closed" });
  });

  it("treats a single complaint under 200 as a warning, not an open circuit", () => {
    expect(evaluateEmailCircuit({ sampleSize: 50, hardBounces: 10, complaints: 1 })).toEqual({ state: "warning", reason: "complaint_manual_review" });
    expect(evaluateEmailCircuit({ sampleSize: 50, hardBounces: 10, complaints: 0 })).toEqual({ state: "closed" });
  });

  it("half-opens 24h after opening, or closes on manual approval", () => {
    const openedAt = 1_000_000;
    expect(emailCircuitProbe(openedAt, openedAt + 23 * 3_600_000, false)).toBe("open");
    expect(emailCircuitProbe(openedAt, openedAt + 24 * 3_600_000, false)).toBe("half_open");
    expect(emailCircuitProbe(openedAt, openedAt + 1_000, true)).toBe("closed");
  });

  it("blocks a hard-bounced address until re-verified and a complained address always", () => {
    expect(isEmailAddressBlocked({ hardBounced: true, reVerified: false, complained: false })).toBe(true);
    expect(isEmailAddressBlocked({ hardBounced: true, reVerified: true, complained: false })).toBe(false);
    expect(isEmailAddressBlocked({ hardBounced: false, reVerified: true, complained: true })).toBe(true);
    expect(isEmailAddressBlocked({ hardBounced: false, reVerified: false, complained: false })).toBe(false);
  });
});

describe("email throttles (spec §12 line 347)", () => {
  it("holds a repeat financial alert for 30 minutes", () => {
    const now = 10_000_000;
    expect(financialCooldownActive(now - (FINANCIAL_EMAIL_COOLDOWN_MS - 1), now)).toBe(true);
    expect(financialCooldownActive(now - FINANCIAL_EMAIL_COOLDOWN_MS, now)).toBe(false);
    expect(financialCooldownActive(undefined, now)).toBe(false);
  });

  it("Quiet Hours hold financial email only, never security", () => {
    expect(quietHoursHoldsFinancial("financial", true)).toBe(true);
    expect(quietHoursHoldsFinancial("financial", false)).toBe(false);
    expect(quietHoursHoldsFinancial("security", true)).toBe(false);
  });

  it("token bucket allows 5 immediate sends then refills at 5 rps", () => {
    const bucket = new TokenBucket(5, 5, 0);
    for (let i = 0; i < 5; i++) expect(bucket.tryTake(0)).toBe(true);
    expect(bucket.tryTake(0)).toBe(false); // burst exhausted
    expect(bucket.tryTake(200)).toBe(true); // 0.2s → 1 token refilled
    expect(bucket.tryTake(200)).toBe(false);
  });
});
