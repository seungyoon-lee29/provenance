import { describe, expect, it } from "vitest";

import { computePortfolioReturn } from "../src/modules/actual-portfolio/calculation/performance";
import type { PerformanceInput } from "../src/modules/actual-portfolio/calculation/contracts";

/**
 * F7 B1 — Portfolio Return (TWR) literal oracles (spec §8 / AT-05).
 *
 * Expected values are hand-worked from the spec's fixture, NEVER derived by
 * importing the production calculator (ticket 16 interface contract):
 *
 *   window t0..t2, reporting currency KRW
 *   t0 valuation 1,000
 *   t1 pre-flow valuation 1,100  → sub-period 1 ratio 1,100/1,000 = 1.10
 *   t1 external flow +900        → new base 1,100+900 = 2,000
 *   t2 valuation 2,200           → sub-period 2 ratio 2,200/2,000 = 1.10
 *   TWR = 1.10 × 1.10 − 1 = 0.21  (21%)
 */

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-04-01T00:00:00.000Z";
const T2 = "2026-07-01T00:00:00.000Z";

function krw(amount: number): { amount: number; currency: string } {
  return { amount, currency: "KRW" };
}

function baseInput(): PerformanceInput {
  return {
    window: { from: T0, to: T2 },
    valuations: [
      { at: T0, value: krw(1_000) },
      { at: T1, value: krw(1_100) },
      { at: T2, value: krw(2_200) },
    ],
    externalFlows: [{ at: T1, amount: krw(900) }],
  };
}

describe("Portfolio Return (TWR) — AT-05 literal", () => {
  it("computes 21% for the spec fixture and reports both sub-periods", () => {
    const result = computePortfolioReturn(baseInput());
    if (result.status !== "covered") throw new Error(`expected covered, got ${result.status}`);
    expect(Math.abs(result.timeWeightedReturn - 0.21)).toBeLessThan(1e-12);
    expect(result.subPeriods).toHaveLength(2);
    expect(Math.abs((result.subPeriods[0]?.ratio ?? 0) - 1.1)).toBeLessThan(1e-12);
    expect(Math.abs((result.subPeriods[1]?.ratio ?? 0) - 1.1)).toBeLessThan(1e-12);
  });

  it("strips the external-flow effect: a withdrawal fixture with the same sub-period growth is also 21%", () => {
    // 1,000 → 1,100 (×1.10), flow −600 → base 500, 500 → 550 (×1.10) ⇒ 21%.
    const result = computePortfolioReturn({
      window: { from: T0, to: T2 },
      valuations: [
        { at: T0, value: krw(1_000) },
        { at: T1, value: krw(1_100) },
        { at: T2, value: krw(550) },
      ],
      externalFlows: [{ at: T1, amount: krw(-600) }],
    });
    if (result.status !== "covered") throw new Error(`expected covered, got ${result.status}`);
    expect(Math.abs(result.timeWeightedReturn - 0.21)).toBeLessThan(1e-12);
  });

  it("a flow-free window is a single sub-period: 1,000 → 1,210 ⇒ 21%", () => {
    const result = computePortfolioReturn({
      window: { from: T0, to: T2 },
      valuations: [
        { at: T0, value: krw(1_000) },
        { at: T2, value: krw(1_210) },
      ],
      externalFlows: [],
    });
    if (result.status !== "covered") throw new Error(`expected covered, got ${result.status}`);
    expect(Math.abs(result.timeWeightedReturn - 0.21)).toBeLessThan(1e-12);
    expect(result.subPeriods).toHaveLength(1);
  });

  it("two same-instant flows are applied together against one pre-flow valuation", () => {
    // 1,000 → 1,100 (×1.10), flows +400 and +500 → base 2,000, → 2,200 (×1.10) ⇒ 21%.
    const input = baseInput();
    const result = computePortfolioReturn({
      ...input,
      externalFlows: [
        { at: T1, amount: krw(400) },
        { at: T1, amount: krw(500) },
      ],
    });
    if (result.status !== "covered") throw new Error(`expected covered, got ${result.status}`);
    expect(Math.abs(result.timeWeightedReturn - 0.21)).toBeLessThan(1e-12);
  });
});

describe("Performance Coverage — no value outside coverage (spec §8: 추정 금지)", () => {
  it("a flow instant with no valuation point yields unavailable, never an interpolated value", () => {
    const input = baseInput();
    const result = computePortfolioReturn({
      ...input,
      valuations: input.valuations.filter((point) => point.at !== T1),
    });
    expect(result).toEqual({ status: "unavailable", reason: "missing_valuation_at_flow" });
  });

  it("a missing window-boundary valuation yields unavailable", () => {
    const input = baseInput();
    expect(
      computePortfolioReturn({ ...input, valuations: input.valuations.filter((point) => point.at !== T0) }),
    ).toEqual({ status: "unavailable", reason: "missing_boundary_valuation" });
    expect(
      computePortfolioReturn({ ...input, valuations: input.valuations.filter((point) => point.at !== T2) }),
    ).toEqual({ status: "unavailable", reason: "missing_boundary_valuation" });
  });

  it("a zero or negative sub-period base makes the ratio meaningless: unavailable", () => {
    // 1,000 → 1,100, flow −1,100 → base 0.
    const result = computePortfolioReturn({
      window: { from: T0, to: T2 },
      valuations: [
        { at: T0, value: krw(1_000) },
        { at: T1, value: krw(1_100) },
        { at: T2, value: krw(50) },
      ],
      externalFlows: [{ at: T1, amount: krw(-1_100) }],
    });
    expect(result).toEqual({ status: "unavailable", reason: "zero_or_negative_base" });
  });

  it("a flow outside the window is a scope error, not silently dropped", () => {
    const input = baseInput();
    const result = computePortfolioReturn({
      ...input,
      externalFlows: [{ at: "2025-12-31T00:00:00.000Z", amount: krw(900) }],
    });
    expect(result).toEqual({ status: "unavailable", reason: "flow_outside_window" });
  });

  it("mixed-currency inputs are rejected: no implicit conversion in the return engine", () => {
    const input = baseInput();
    const result = computePortfolioReturn({
      ...input,
      externalFlows: [{ at: T1, amount: { amount: 900, currency: "USD" } }],
    });
    expect(result).toEqual({ status: "unavailable", reason: "mixed_currency" });
  });
});
