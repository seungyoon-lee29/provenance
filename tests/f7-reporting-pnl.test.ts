import { describe, expect, it } from "vitest";

import { computeReportingPnl } from "../src/modules/actual-portfolio/calculation/reporting-pnl";
import type { ReportingPnlInput } from "../src/modules/actual-portfolio/calculation/reporting-pnl";

/**
 * F7 B3 — Reporting Currency P&L decomposition literal oracles (spec §8 /
 * AT-05). Expected values are hand-worked:
 *
 *   security row: 50 USD → 55 USD (local +10%), FX 10 → 12 KRW/USD (+20%)
 *     start 500 KRW, end 660 KRW, total P&L 160 KRW
 *     price       = (55−50)×10        =  50  (10% of 500)
 *     fx          = 50×(12−10)        = 100  (20% of 500)
 *     interaction = (55−50)×(12−10)   =  10  ( 2% of 500)
 *     50+100+10 = 160 ✓ and 10%+20%+2% = 32% ✓ — identity is exact algebra:
 *     (N₁−N₀)F₀ + N₀(F₁−F₀) + (N₁−N₀)(F₁−F₀) = N₁F₁ − N₀F₀.
 */

function usdSecurity(): ReportingPnlInput["rows"][number] {
  return {
    key: "sec:AAPL",
    kind: "security",
    nativeCurrency: "USD",
    startNativeValue: 50,
    endNativeValue: 55,
    fx: { start: 10, end: 12 },
  };
}

describe("FX decomposition — AT-05 10%+20%+2%=32% literal", () => {
  it("decomposes the security row into price 50 / fx 100 / interaction 10 = 160 KRW", () => {
    const result = computeReportingPnl({ reportingCurrency: "KRW", rows: [usdSecurity()], charges: [] });
    if (result.status !== "covered") throw new Error(`expected covered, got ${result.status}`);
    expect(result.gross.price).toBe(50);
    expect(result.gross.fx).toBe(100);
    expect(result.gross.interaction).toBe(10);
    expect(result.gross.total).toBe(160);
    expect(Math.abs(result.grossReturn.price - 0.1)).toBeLessThan(1e-12);
    expect(Math.abs(result.grossReturn.fx - 0.2)).toBeLessThan(1e-12);
    expect(Math.abs(result.grossReturn.interaction - 0.02)).toBeLessThan(1e-12);
    expect(Math.abs(result.grossReturn.total - 0.32)).toBeLessThan(1e-12);
  });

  it("cash carries FX exposure too: flat 25 USD cash is fx-only 50 KRW, zero interaction", () => {
    const result = computeReportingPnl({
      reportingCurrency: "KRW",
      rows: [{ key: "cash:USD", kind: "cash", nativeCurrency: "USD", startNativeValue: 25, endNativeValue: 25, fx: { start: 10, end: 12 } }],
      charges: [],
    });
    if (result.status !== "covered") throw new Error(`expected covered, got ${result.status}`);
    expect(result.gross.price).toBe(0);
    expect(result.gross.fx).toBe(50);
    expect(result.gross.interaction).toBe(0);
    expect(result.gross.total).toBe(50);
  });

  it("reconciles a mixed security+cash+domestic portfolio: component sum equals the raw conversion delta", () => {
    // Hand-worked totals, independent of the production decomposition:
    //   USD security: 660 − 500                    = 160
    //   USD cash:     25×12 − 25×10                =  50
    //   KRW security: 1,020 − 1,000 (no fx field)  =  20
    //   total 230
    const result = computeReportingPnl({
      reportingCurrency: "KRW",
      rows: [
        usdSecurity(),
        { key: "cash:USD", kind: "cash", nativeCurrency: "USD", startNativeValue: 25, endNativeValue: 25, fx: { start: 10, end: 12 } },
        { key: "sec:KODEX", kind: "security", nativeCurrency: "KRW", startNativeValue: 1_000, endNativeValue: 1_020 },
      ],
      charges: [],
    });
    if (result.status !== "covered") throw new Error(`expected covered, got ${result.status}`);
    expect(result.gross.total).toBe(230);
    expect(result.gross.price + result.gross.fx + result.gross.interaction).toBe(result.gross.total);
    // The domestic row contributes to price only — no fx leaks into it.
    expect(result.gross.price).toBe(50 + 0 + 20);
    expect(result.gross.fx).toBe(100 + 50 + 0);
  });
});

describe("gross/fee/tax — AT-05 20−2−1=17 literal", () => {
  it("nets gross 20 − fee 2 − tax 1 = 17, each charge subtracted exactly once", () => {
    const result = computeReportingPnl({
      reportingCurrency: "KRW",
      rows: [{ key: "sec:KODEX", kind: "security", nativeCurrency: "KRW", startNativeValue: 1_000, endNativeValue: 1_020 }],
      charges: [
        { kind: "fee", amount: { amount: 2, currency: "KRW" } },
        { kind: "tax", amount: { amount: 1, currency: "KRW" } },
      ],
    });
    if (result.status !== "covered") throw new Error(`expected covered, got ${result.status}`);
    expect(result.gross.total).toBe(20);
    expect(result.fees).toBe(2);
    expect(result.taxes).toBe(1);
    expect(result.net).toBe(17);
  });
});

describe("fail closed — no value without full evidence (spec §8)", () => {
  it("a foreign row without FX evidence is unavailable, never converted at an assumed rate", () => {
    const row = { ...usdSecurity() };
    delete (row as { fx?: unknown }).fx;
    expect(computeReportingPnl({ reportingCurrency: "KRW", rows: [row], charges: [] }))
      .toEqual({ status: "unavailable", reason: "missing_fx" });
  });

  it("an FX pair on a reporting-currency row is a double-conversion hazard: unavailable", () => {
    expect(
      computeReportingPnl({
        reportingCurrency: "KRW",
        rows: [{ key: "sec:KODEX", kind: "security", nativeCurrency: "KRW", startNativeValue: 1_000, endNativeValue: 1_020, fx: { start: 1, end: 1.1 } }],
        charges: [],
      }),
    ).toEqual({ status: "unavailable", reason: "invalid_fx" });
  });

  it("a zero or negative start base has no meaningful decomposition: unavailable", () => {
    expect(
      computeReportingPnl({
        reportingCurrency: "KRW",
        rows: [{ key: "sec:NEW", kind: "security", nativeCurrency: "KRW", startNativeValue: 0, endNativeValue: 100 }],
        charges: [],
      }),
    ).toEqual({ status: "unavailable", reason: "zero_base_row" });
  });

  it("charges must be non-negative and in the reporting currency", () => {
    const base = { key: "s", kind: "security" as const, nativeCurrency: "KRW", startNativeValue: 1_000, endNativeValue: 1_020 };
    expect(
      computeReportingPnl({
        reportingCurrency: "KRW",
        rows: [base],
        charges: [{ kind: "fee", amount: { amount: 2, currency: "USD" } }],
      }),
    ).toEqual({ status: "unavailable", reason: "mixed_currency" });
    expect(
      computeReportingPnl({
        reportingCurrency: "KRW",
        rows: [base],
        charges: [{ kind: "tax", amount: { amount: -1, currency: "KRW" } }],
      }),
    ).toEqual({ status: "unavailable", reason: "invalid_charge" });
  });
});
