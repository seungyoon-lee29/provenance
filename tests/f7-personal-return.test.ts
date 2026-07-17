import { describe, expect, it } from "vitest";

import { computePersonalReturn } from "../src/modules/actual-portfolio/calculation/personal-return";

/**
 * F7 B2 — Personal Return (unique-solution XIRR) literal oracles (spec §8 /
 * AT-05). Expected values are hand-worked algebra, never the production
 * solver:
 *
 *   unique fixture: −1,000 @2026-01-01, +1,100 @2027-01-01 (t=365/365=1)
 *     −1000 + 1100/(1+r) = 0  ⇒  r = 0.10 exactly.
 *
 *   multi-root fixture: −1,000 / +2,500 @t=1 / −1,560 @t=2. With x=1+r:
 *     1000x² − 2500x + 1560 = 0 ⇒ x = (2500 ± √(2500²−4·1000·1560))/2000
 *       = (2500 ± 100)/2000 ⇒ x = 1.3 or 1.2 ⇒ TWO roots (30% and 20%),
 *     so the spec's "유일한 해가 있는 XIRR" demands NO value.
 */

function krw(amount: number): { amount: number; currency: string } {
  return { amount, currency: "KRW" };
}

const Y2026 = "2026-01-01T00:00:00.000Z";
const Y2027 = "2027-01-01T00:00:00.000Z";
const Y2028 = "2028-01-01T00:00:00.000Z";

describe("Personal Return (XIRR) — AT-05 literal", () => {
  it("computes exactly 10% for −1,000 → +1,100 one year later", () => {
    const result = computePersonalReturn({
      flows: [
        { at: Y2026, amount: krw(-1_000) },
        { at: Y2027, amount: krw(1_100) },
      ],
    });
    if (result.status !== "covered") throw new Error(`expected covered, got ${result.status}`);
    expect(Math.abs(result.annualizedRate - 0.1)).toBeLessThan(1e-9);
  });

  it("reflects cash-flow timing: the same amounts two years apart give √1.1−1, not 10%", () => {
    // 1100/(1+r)² = 1000 ⇒ (1+r)² = 1.1 ⇒ r = √1.1 − 1 ≈ 4.8809%.
    const result = computePersonalReturn({
      flows: [
        { at: Y2026, amount: krw(-1_000) },
        { at: Y2028, amount: krw(1_100) },
      ],
    });
    if (result.status !== "covered") throw new Error(`expected covered, got ${result.status}`);
    expect(Math.abs(result.annualizedRate - (Math.sqrt(1.1) - 1))).toBeLessThan(1e-9);
    expect(result.annualizedRate).toBeLessThan(0.1);
  });

  it("handles a loss: −1,000 → +900 one year later is exactly −10%", () => {
    const result = computePersonalReturn({
      flows: [
        { at: Y2026, amount: krw(-1_000) },
        { at: Y2027, amount: krw(900) },
      ],
    });
    if (result.status !== "covered") throw new Error(`expected covered, got ${result.status}`);
    expect(Math.abs(result.annualizedRate - -0.1)).toBeLessThan(1e-9);
  });

  it("sums same-instant flows before solving: split −400/−600 deposit still yields 10%", () => {
    const result = computePersonalReturn({
      flows: [
        { at: Y2026, amount: krw(-400) },
        { at: Y2026, amount: krw(-600) },
        { at: Y2027, amount: krw(1_100) },
      ],
    });
    if (result.status !== "covered") throw new Error(`expected covered, got ${result.status}`);
    expect(Math.abs(result.annualizedRate - 0.1)).toBeLessThan(1e-9);
  });
});

describe("Personal Return — 유일해가 없으면 값 없음 (spec §8 fail closed)", () => {
  it("the two-root fixture (20% and 30%) yields unavailable, never one of the roots", () => {
    const result = computePersonalReturn({
      flows: [
        { at: Y2026, amount: krw(-1_000) },
        { at: Y2027, amount: krw(2_500) },
        { at: Y2028, amount: krw(-1_560) },
      ],
    });
    expect(result).toEqual({ status: "unavailable", reason: "no_unique_solution" });
  });

  it("a two-root fixture whose FIRST root sits inside the solver's bracket is still unavailable", () => {
    // −1,000 / +12,500 @t=1 / −16,500 @t=2. With x=1+r: 1000x² − 12500x + 16500 = 0
    //   ⇒ x = (12.5 ± √(156.25−66))/2 = (12.5 ± 9.5)/2 ⇒ x = 1.5 or 11
    //   ⇒ real roots at BOTH 50% and 1,000%. A solver that skips the
    // uniqueness check would happily bracket and return 50%.
    const result = computePersonalReturn({
      flows: [
        { at: Y2026, amount: krw(-1_000) },
        { at: Y2027, amount: krw(12_500) },
        { at: Y2028, amount: krw(-16_500) },
      ],
    });
    expect(result).toEqual({ status: "unavailable", reason: "no_unique_solution" });
  });

  it("same-sign flows have no root at all", () => {
    const result = computePersonalReturn({
      flows: [
        { at: Y2026, amount: krw(-1_000) },
        { at: Y2027, amount: krw(-500) },
      ],
    });
    expect(result).toEqual({ status: "unavailable", reason: "no_sign_change" });
  });

  it("fewer than two nonzero flows cannot define a rate", () => {
    expect(computePersonalReturn({ flows: [{ at: Y2026, amount: krw(-1_000) }] }))
      .toEqual({ status: "unavailable", reason: "insufficient_flows" });
    expect(
      computePersonalReturn({
        flows: [
          { at: Y2026, amount: krw(-1_000) },
          { at: Y2027, amount: krw(0) },
        ],
      }),
    ).toEqual({ status: "unavailable", reason: "insufficient_flows" });
  });

  it("mixed currencies are rejected: no implicit conversion in the solver", () => {
    const result = computePersonalReturn({
      flows: [
        { at: Y2026, amount: krw(-1_000) },
        { at: Y2027, amount: { amount: 1_100, currency: "USD" } },
      ],
    });
    expect(result).toEqual({ status: "unavailable", reason: "mixed_currency" });
  });
});
