import { describe, expect, it } from "vitest";

import { runBacktest } from "../src/modules/paper-trading/backtest/backtest-runner";
import { buildPerformance } from "../src/modules/paper-trading/backtest/performance-report";

/**
 * BLIND acceptance gate for T9 — gross vs net TWR + tax drag.
 *
 * Every expected number below is derived independently from the finance
 * definitions handed to the test author (NOT from reading performance-report.ts
 * or backtest-runner.ts). A mismatch between a derived value and the code's
 * actual output is a FINDING, not a bug in this file — assertions are never
 * loosened to make them pass.
 *
 * Published contract restated:
 *   Every headline figure is NET (ledger charges sell tax). Gross is the
 *   untaxed counterfactual: taxPaid is added back to the TERMINAL value only
 *   (first-order, no reinvestment of the saved tax).
 *     grossFinal   = finalValue + taxPaidValue
 *     netTWR       = finalValue / seedValue - 1
 *     grossTWR     = grossFinal / seedValue - 1
 *     taxDrag      = grossTWR - netTWR  (closed form: taxPaidValue / seedValue), >= 0
 *   taxPaid is a ledger fact and is reported even when gross/drag are
 *   unavailable (zero-width window, invalid valuation). A negative or
 *   non-finite taxPaidValue input is refused: gross/drag -> unavailable
 *   (never a fabricated counterfactual).
 *   Untaxed runs: taxPaid 0, drag covered 0, gross === net exactly.
 *
 * Simulation-v1 fill policy (restated from the T8 blind contract, reused here
 * to hand-derive E2E fills):
 *   slippageBps = min(25, 5 + 20 * cumulativeParticipation)
 *   cumulativeParticipation = running sum of (filled qty / bar volume) over
 *     every fill in the run so far, INCLUDING the fill being priced.
 *   buy fill price  = ceil(close * (1 + bps/10000))   [adverse: buy up]
 *   sell fill price = floor(close * (1 - bps/10000))  [adverse: sell down]
 *   (an order accepted at bar N's close can only fill at bar N+1)
 *   Tax: equity + KRW only, 20bp of gross sell proceeds, floored to the won.
 *     ETF/ETN ("etf_etn") exempt regardless of currency.
 */

// ---- independent helpers (finance definitions given in the task, not code) ----

function slippageBps(cumulativeParticipation: number): number {
  return Math.min(25, 5 + 20 * cumulativeParticipation);
}

function fillPriceBuy(close: number, cumulativeParticipation: number): number {
  return Math.ceil(close * (1 + slippageBps(cumulativeParticipation) / 10000));
}

function fillPriceSell(close: number, cumulativeParticipation: number): number {
  return Math.floor(close * (1 - slippageBps(cumulativeParticipation) / 10000));
}

function sellTax(gross: number, taxed: boolean): number {
  return taxed ? Math.floor((gross * 20) / 10000) : 0;
}

// Sanity-check the fill-price helpers against the T8-documented example
// (buy 10 @ close 10,000, volume 100,000, first fill in the run -> cumulative
// participation = 10/100,000 = 0.0001 -> 10,006). Transcription check only.
it("[self-check] fillPriceBuy helper reproduces the documented example", () => {
  expect(fillPriceBuy(10000, 10 / 100000)).toBe(10006);
});

describe("buildPerformance — tax boundaries (T9, pure)", () => {
  const currency = "KRW";
  const from = "2026-01-01T00:00:00.000Z";
  const to = "2026-01-02T00:00:00.000Z";

  it("taxed run: gross/drag arithmetic derived by hand", () => {
    const seedValue = 1_000_000;
    const finalValue = 1_050_000;
    const taxPaidValue = 5_000;

    const result = buildPerformance({
      currency,
      from,
      to,
      seedValue,
      finalValue,
      // Interface adaptation only (assertions untouched): equity is a plain
      // number[] per-bar curve, not {periodStart, equityValue} objects.
      equity: [seedValue, finalValue],
      participations: [],
      realizedSellsMinor: [],
      taxPaidValue,
    });

    // --- independent derivation ---
    // net = 1,050,000/1,000,000 - 1 = 0.05
    // grossFinal = 1,050,000 + 5,000 = 1,055,000 -> gross = 1,055,000/1,000,000 - 1 = 0.055
    // drag = gross - net = 0.005 (== taxPaidValue/seedValue = 5,000/1,000,000)
    const netRatio = finalValue / seedValue - 1;
    const grossRatio = (finalValue + taxPaidValue) / seedValue - 1;
    const dragRatio = grossRatio - netRatio;

    expect(netRatio).toBeCloseTo(0.05, 12);
    expect(grossRatio).toBeCloseTo(0.055, 12);
    expect(dragRatio).toBeCloseTo(0.005, 12);
    expect(dragRatio).toBeCloseTo(taxPaidValue / seedValue, 12);

    // Interface adaptation (contract evolved during this gate — codex MED fix):
    // the tax block is now a coverage union; narrow to covered before reading.
    expect(result.tax.status).toBe("covered");
    if (result.tax.status !== "covered") return;
    expect(result.tax.taxPaid).toBe(taxPaidValue);
    expect(result.tax.grossTimeWeightedReturn.status).toBe("covered");
    if (result.tax.grossTimeWeightedReturn.status === "covered") {
      expect(result.tax.grossTimeWeightedReturn.ratio).toBeCloseTo(grossRatio, 12);
    }
    expect(result.tax.taxDrag.status).toBe("covered");
    if (result.tax.taxDrag.status === "covered") {
      expect(result.tax.taxDrag.ratio).toBeCloseTo(dragRatio, 12);
      expect(result.tax.taxDrag.ratio).toBeGreaterThanOrEqual(0);
    }
  });

  it("taxPaid 0 -> drag covered 0, gross === net exactly", () => {
    const seedValue = 1_000_000;
    const finalValue = 1_100_000;

    const result = buildPerformance({
      currency,
      from,
      to,
      seedValue,
      finalValue,
      // Interface adaptation only (assertions untouched): equity is a plain
      // number[] per-bar curve, not {periodStart, equityValue} objects.
      equity: [seedValue, finalValue],
      participations: [],
      realizedSellsMinor: [],
      taxPaidValue: 0,
    });

    const netRatio = finalValue / seedValue - 1; // 0.1

    // Interface adaptation (contract evolved during this gate — codex MED fix):
    // the tax block is now a coverage union; narrow to covered before reading.
    expect(result.tax.status).toBe("covered");
    if (result.tax.status !== "covered") return;
    expect(result.tax.taxPaid).toBe(0);
    expect(result.tax.grossTimeWeightedReturn.status).toBe("covered");
    expect(result.tax.taxDrag.status).toBe("covered");
    if (result.tax.grossTimeWeightedReturn.status === "covered" && result.tax.taxDrag.status === "covered") {
      expect(result.tax.grossTimeWeightedReturn.ratio).toBeCloseTo(netRatio, 12);
      expect(result.tax.taxDrag.ratio).toBe(0);
    }
  });

  it.each([
    ["negative", -100],
    ["NaN", Number.NaN],
    ["+Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("taxPaidValue=%s -> gross+drag unavailable (never a fabricated counterfactual)", (_label, taxPaidValue) => {
    const seedValue = 1_000_000;
    const finalValue = 1_050_000;

    const result = buildPerformance({
      currency,
      from,
      to,
      seedValue,
      finalValue,
      // Interface adaptation only (assertions untouched): equity is a plain
      // number[] per-bar curve, not {periodStart, equityValue} objects.
      equity: [seedValue, finalValue],
      participations: [],
      realizedSellsMinor: [],
      taxPaidValue,
    });

    // Contract evolved during this gate (codex MED): an invalid total refuses
    // the WHOLE block — strictly stronger than the original per-field claims.
    expect(result.tax.status).toBe("unavailable");
  });

  it("zero-width window -> gross/drag unavailable but taxPaid still reported (ledger fact)", () => {
    const point = "2026-01-01T00:00:00.000Z";
    const seedValue = 1_000_000;
    const finalValue = 1_000_000;
    const taxPaidValue = 500;

    const result = buildPerformance({
      currency,
      from: point,
      to: point,
      seedValue,
      finalValue,
      equity: [seedValue], // interface adaptation: plain number[]
      participations: [],
      realizedSellsMinor: [],
      taxPaidValue,
    });

    // Interface adaptation (contract evolved during this gate — codex MED fix):
    // the tax block is now a coverage union; narrow to covered before reading.
    expect(result.tax.status).toBe("covered");
    if (result.tax.status !== "covered") return;
    expect(result.tax.taxPaid).toBe(taxPaidValue);
    expect(result.tax.grossTimeWeightedReturn.status).toBe("unavailable");
    expect(result.tax.taxDrag.status).toBe("unavailable");
  });
});

describe("T9 end-to-end via runBacktest — performance.tax", () => {
  // Shared series/strategy: buy 10 @ bar0 (accepted), fills @ bar1 (close
  // 10,000, vol 100,000); sell 10 @ bar1 (accepted), fills @ bar2 (close
  // 12,000, vol 100,000). Identical to T8 blind test (A), reused here so the
  // taxed-run gross TWR can be checked against the untaxed-run net TWR.
  const bars = [
    { periodStart: "2026-01-01T00:00:00.000Z", close: 10000, volume: 100000, complete: true as const },
    { periodStart: "2026-01-02T00:00:00.000Z", close: 10000, volume: 100000, complete: true as const },
    { periodStart: "2026-01-03T00:00:00.000Z", close: 12000, volume: 100000, complete: true as const },
  ];

  const strategy = (view: { cursor: number }) => {
    if (view.cursor === 0) return [{ kind: "submit" as const, order: { side: "buy" as const, orderType: "market" as const, quantity: 10, timeInForce: "GTC" as const } }];
    if (view.cursor === 1) return [{ kind: "submit" as const, order: { side: "sell" as const, orderType: "market" as const, quantity: 10, timeInForce: "GTC" as const } }];
    return [];
  };

  // --- independent derivation (shared by all three runs below) ---
  // buy: qty 10 fills @ bar1 (close 10,000, vol 100,000). First fill in the
  // run -> cumulative participation = 10/100,000 = 0.0001.
  const buyPrice = fillPriceBuy(10000, 10 / 100000); // ceil(10000*1.0005002) = 10,006
  const costBasis = 10 * buyPrice; // 100,060

  // sell: qty 10 fills @ bar2 (close 12,000, vol 100,000). Second fill in the
  // run -> cumulative participation = 0.0001 + 0.0001 = 0.0002.
  const sellCum = 10 / 100000 + 10 / 100000;
  const sellPrice = fillPriceSell(12000, sellCum); // floor(12000*(1-5.004/10000)) = 11,993
  const grossSellProceeds = 10 * sellPrice; // 119,930
  const tax = sellTax(grossSellProceeds, true); // floor(119,930 * 20/10000) = floor(239.86) = 239

  const seedCash = 1_000_000;
  const cashAfterBuy = seedCash - costBasis; // 1,000,000 - 100,060 = 899,940
  const finalValueTaxed = cashAfterBuy + grossSellProceeds - tax; // 899,940 + 119,930 - 239 = 1,019,631
  const finalValueUntaxed = cashAfterBuy + grossSellProceeds - 0; // 899,940 + 119,930 = 1,019,870

  const netTwrTaxed = finalValueTaxed / seedCash - 1; // 0.019631
  const grossFinalTaxed = finalValueTaxed + tax; // 1,019,631 + 239 = 1,019,870 (== finalValueUntaxed)
  const grossTwrTaxed = grossFinalTaxed / seedCash - 1; // 0.019870
  const taxDragTaxed = grossTwrTaxed - netTwrTaxed; // 0.000239 (== tax/seedCash)

  const netTwrUntaxed = finalValueUntaxed / seedCash - 1; // 0.019870

  it("[self-check] buy/sell fill prices match the T8-documented derivation", () => {
    expect(buyPrice).toBe(10006);
    expect(sellPrice).toBe(11993);
  });

  it("(A) taxClass equity: exact taxPaid, grossTWR, taxDrag", async () => {
    const result = await runBacktest({
      runId: "t9-tax-blind-a-equity",
      seedCash: [{ amount: seedCash, currency: "KRW" }],
      series: { instrument: "instr:T9-A", venue: "KRX", currency: "KRW", taxClass: "equity", bars },
      strategy,
    } as never);

    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;

    expect(grossSellProceeds).toBe(119930);
    expect(tax).toBe(239);
    expect(finalValueTaxed).toBe(1019631);
    expect(netTwrTaxed).toBeCloseTo(0.019631, 12);
    expect(grossTwrTaxed).toBeCloseTo(0.01987, 12);
    expect(taxDragTaxed).toBeCloseTo(0.000239, 12);
    expect(taxDragTaxed).toBeCloseTo(tax / seedCash, 12);

    // Interface adaptation (contract evolved during this gate — codex MED fix):
    // the tax block is now a coverage union; narrow to covered before reading.
    expect(result.performance.tax.status).toBe("covered");
    if (result.performance.tax.status !== "covered") return;
    expect(result.performance.tax.taxPaid).toBe(tax);

    expect(result.performance.tax.grossTimeWeightedReturn.status).toBe("covered");
    if (result.performance.tax.grossTimeWeightedReturn.status === "covered") {
      expect(result.performance.tax.grossTimeWeightedReturn.ratio).toBeCloseTo(grossTwrTaxed, 9);
    }

    expect(result.performance.tax.taxDrag.status).toBe("covered");
    if (result.performance.tax.taxDrag.status === "covered") {
      expect(result.performance.tax.taxDrag.ratio).toBeCloseTo(taxDragTaxed, 9);
      expect(result.performance.tax.taxDrag.ratio).toBeGreaterThanOrEqual(0);
    }
  });

  it("(B) same series/strategy, no taxClass: taxPaid 0, gross==net, drag 0 — and equals the taxed run's gross TWR (identical fills, no post-sale trades)", async () => {
    const result = await runBacktest({
      runId: "t9-tax-blind-b-untaxed",
      seedCash: [{ amount: seedCash, currency: "KRW" }],
      series: { instrument: "instr:T9-B", venue: "KRX", currency: "KRW", bars },
      strategy,
    } as never);

    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;

    expect(finalValueUntaxed).toBe(1019870);
    expect(netTwrUntaxed).toBeCloseTo(0.01987, 12);
    // The untaxed net TWR must equal the taxed run's gross TWR exactly: same
    // fills happen either way (tax is charged after the sell fills, so it
    // cannot change fill prices), and there is no post-sale trade to be
    // affected by the extra cash — the first-order counterfactual is exact.
    expect(netTwrUntaxed).toBeCloseTo(grossTwrTaxed, 12);

    // Interface adaptation (contract evolved during this gate — codex MED fix):
    // the tax block is now a coverage union; narrow to covered before reading.
    expect(result.performance.tax.status).toBe("covered");
    if (result.performance.tax.status !== "covered") return;
    expect(result.performance.tax.taxPaid).toBe(0);

    expect(result.performance.tax.grossTimeWeightedReturn.status).toBe("covered");
    expect(result.performance.tax.taxDrag.status).toBe("covered");
    if (result.performance.tax.grossTimeWeightedReturn.status === "covered" && result.performance.tax.taxDrag.status === "covered") {
      expect(result.performance.tax.grossTimeWeightedReturn.ratio).toBeCloseTo(netTwrUntaxed, 9);
      expect(result.performance.tax.taxDrag.ratio).toBe(0);
    }
  });

  it("(C) taxClass etf_etn (KRW): exempt -> taxPaid 0 even though currency is KRW", async () => {
    const result = await runBacktest({
      runId: "t9-tax-blind-c-etf",
      seedCash: [{ amount: seedCash, currency: "KRW" }],
      series: { instrument: "instr:T9-C", venue: "KRX", currency: "KRW", taxClass: "etf_etn", bars },
      strategy,
    } as never);

    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;

    // ETF/ETN is exempt regardless of the equity 20bp rule -> untaxed fills,
    // same arithmetic as run (B).
    // Interface adaptation (contract evolved during this gate — codex MED fix):
    // the tax block is now a coverage union; narrow to covered before reading.
    expect(result.performance.tax.status).toBe("covered");
    if (result.performance.tax.status !== "covered") return;
    expect(result.performance.tax.taxPaid).toBe(0);
    expect(result.performance.tax.grossTimeWeightedReturn.status).toBe("covered");
    expect(result.performance.tax.taxDrag.status).toBe("covered");
    if (result.performance.tax.grossTimeWeightedReturn.status === "covered" && result.performance.tax.taxDrag.status === "covered") {
      expect(result.performance.tax.grossTimeWeightedReturn.ratio).toBeCloseTo(netTwrUntaxed, 9);
      expect(result.performance.tax.taxDrag.ratio).toBe(0);
    }
  });
});
